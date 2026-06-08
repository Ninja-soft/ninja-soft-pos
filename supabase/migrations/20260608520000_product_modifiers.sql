-- =============================================================================
-- 20260608520000_product_modifiers  (F12 · H37 — modificadores simples)
-- -----------------------------------------------------------------------------
-- Heladería / cafetería: vender "1/2 kg, 3 sabores" o "café grande + 2 toppings"
-- sin crear 200 productos. Un producto puede tener GRUPOS de modificadores
-- (Tamaño, Sabores, Toppings) y cada grupo sus OPCIONES con un ajuste de precio.
--
--   product_modifier_groups   = "Tamaño" (radio min1/max1), "Sabores" (multi,
--                                max configurable), "Toppings" (multi).
--   product_modifier_options  = "1/2 kg (+0)", "Frutilla (+0)", "Crema (+200)".
--
-- RLS por tenant igual que el resto del dominio de producto (kits/serials/
-- variants): una sola policy `tenant_id = current_tenant_id()` para todo. El
-- gating de escritura a owner/manager del dominio de producto vive en la capa de
-- permisos/UI (mismo criterio que products / product_kit_components).
--
-- PERSISTENCIA EN LA VENTA: sale_items gana `modifiers jsonb` (default '[]'). El
-- POS arma la línea con el precio YA AJUSTADO (base + suma de deltas) en
-- unit_price y manda los modificadores elegidos como snapshot en p_items[].modifiers.
-- create_sale persiste ese jsonb 1:1 en la línea. NO se recalcula el precio en el
-- server con los modificadores (mismo criterio que variantes/extras: el importe
-- ya viaja en unit_price); el jsonb es el detalle para ticket/registro.
--
-- create_sale se RECREA desde su definición VIVA (firma de 6 args con p_extras +
-- card_voucher, migración card_plans_validity_voucher) agregando SÓLO la lectura
-- de `modifiers` por ítem y su INSERT en sale_items.modifiers. Todo lo demás
-- (gating descuentos/garantías/cuenta corriente, advisory lock del correlativo,
-- gating de medios QR, stock/variantes/kits/serial, voucher de tarjeta, vale)
-- queda idéntico. Se conserva language plpgsql, security invoker (sin SECURITY
-- DEFINER) y `set search_path = public, pg_temp`. Se mantienen los grants.
--
-- FUERA DE ALCANCE (follow-up): combos simples (café + medialuna) → F9; comanda
-- de cocina/preparación → F13.
-- =============================================================================

-- ── 1) Grupos de modificadores por producto ──────────────────────────────────
create table if not exists product_modifier_groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  name        text not null,
  -- Mínimo/máximo de opciones elegibles. max_select null = sin tope (multi libre).
  min_select  int  not null default 0 check (min_select >= 0),
  max_select  int  check (max_select is null or max_select >= 1),
  required    boolean not null default false,
  sort        int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (max_select is null or max_select >= min_select)
);
create index if not exists pmg_product_idx on product_modifier_groups(product_id, sort);
create index if not exists pmg_tenant_idx  on product_modifier_groups(tenant_id);

create trigger set_updated_at_product_modifier_groups
  before update on product_modifier_groups
  for each row execute function set_updated_at();

-- ── 2) Opciones de cada grupo ─────────────────────────────────────────────────
create table if not exists product_modifier_options (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  group_id    uuid not null references product_modifier_groups(id) on delete cascade,
  name        text not null,
  -- Ajuste de precio que suma (o resta) la opción al precio base del producto.
  price_delta numeric(12,2) not null default 0,
  sort        int     not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pmo_group_idx  on product_modifier_options(group_id, sort);
create index if not exists pmo_tenant_idx on product_modifier_options(tenant_id);

create trigger set_updated_at_product_modifier_options
  before update on product_modifier_options
  for each row execute function set_updated_at();

-- ── 3) RLS: aislamiento por tenant (igual que kits/serials/variants) ──────────
alter table product_modifier_groups enable row level security;
create policy pmg_tenant_isolation on product_modifier_groups
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

alter table product_modifier_options enable row level security;
create policy pmo_tenant_isolation on product_modifier_options
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- ── 4) Snapshot de modificadores en la línea de venta ─────────────────────────
-- Cada elemento: { "group": "Sabores", "options": [{"name":"Frutilla","price_delta":0}, …] }
-- El precio ya está reflejado en sale_items.unit_price (base + deltas).
alter table sale_items add column if not exists modifiers jsonb not null default '[]'::jsonb;

-- ── 5) create_sale (recreada viva + persistencia de modifiers por línea) ──────
create or replace function public.create_sale(
  p_items          jsonb,
  p_payments       jsonb,
  p_discount_total numeric default 0,
  p_customer_id    uuid    default null,
  p_notes          text    default null,
  p_extras         jsonb   default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_subtotal numeric := 0;
  v_total    numeric;
  v_total_pre numeric;
  v_paid     numeric := 0;
  v_sale_id  uuid;
  v_item     record;
  v_pay      record;
  v_comp     record;
  v_pname    text;
  v_psku     text;
  v_is_kit   boolean;
  v_track    boolean;
  v_has_variants boolean;
  v_variant  record;
  v_serial   text;
  v_role     text;
  v_max_disc numeric := 100;
  v_round    numeric := 0;
  v_allow_neg boolean := true;
  v_disc_pct numeric;
  v_pallow   boolean;
  v_stock    numeric;
  v_sc_total numeric := 0;
  v_sc_bal   numeric;
  v_pay_feat text;
  v_line_disc numeric := 0;
  v_warranty_prima numeric := 0;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
  end if;

  select id into v_store
  from stores
  where tenant_id = v_tenant and deleted_at is null
  order by is_default desc, created_at
  limit 1;
  if v_store is null then
    raise exception 'no_store';
  end if;

  select cs.id into v_shift
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
  order by cs.opened_at desc
  limit 1;
  if v_shift is null then
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;

  select coalesce((ps.max_discount ->> coalesce(v_role, 'cashier'))::numeric, 100),
         coalesce(ps.rounding_multiple, 0),
         coalesce(ps.allow_negative_stock, true)
    into v_max_disc, v_round, v_allow_neg
  from pos_settings ps
  where ps.tenant_id = v_tenant;
  if not found then
    v_max_disc := 100; v_round := 0; v_allow_neg := true;
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    v_subtotal := v_subtotal
      + (coalesce(v_item.unit_price, 0) * coalesce(v_item.quantity, 0))
      - coalesce(v_item.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_item.discount, 0);
  end loop;

  if v_subtotal <= 0 then
    raise exception 'empty_sale';
  end if;

  -- Gating server-side: DESCUENTOS.
  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;

  -- Gating server-side: GARANTÍAS (prima de garantía en p_extras).
  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;

  -- Gating server-side: CUENTA CORRIENTE (medio 'account').
  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
         as p(method text, amount numeric)
       where p.method = 'account' and coalesce(p.amount, 0) > 0
     )
     and not tenant_has_feature('cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;

  if coalesce(p_discount_total, 0) > 0 and v_subtotal > 0 then
    v_disc_pct := coalesce(p_discount_total, 0) / v_subtotal * 100;
    if v_disc_pct > v_max_disc + 0.001 then
      raise exception 'discount_exceeds_limit';
    end if;
  end if;

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0);

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
    if v_pay.method = 'store_credit' then
      v_sc_total := v_sc_total + coalesce(v_pay.amount, 0);
    end if;
  end loop;
  if v_paid < v_total then
    raise exception 'insufficient_payment';
  end if;
  if v_sc_total > v_total + 0.001 then
    raise exception 'store_credit_exceeds_total';
  end if;

  if v_sc_total > 0 then
    if p_customer_id is null then
      raise exception 'store_credit_needs_customer';
    end if;
    select coalesce(sum(delta), 0) into v_sc_bal
    from store_credit_movements
    where tenant_id = v_tenant and customer_id = p_customer_id;
    if v_sc_bal < v_sc_total - 0.001 then
      raise exception 'insufficient_store_credit';
    end if;
  end if;

  -- Correlativo con advisory lock por tenant (anti-carrera del UNIQUE number).
  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes)
  returning id into v_sale_id;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, modifiers jsonb,
           quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      if coalesce(v_has_variants, false) then
        if v_item.variant_id is null then
          raise exception 'variant_required';
        end if;
        select * into v_variant from product_variants
         where id = v_item.variant_id and product_id = v_item.product_id
           and tenant_id = v_tenant and deleted_at is null;
        if not found then
          raise exception 'variant_not_found';
        end if;
        v_pname := v_pname || ' — ' || v_variant.option1
                   || coalesce(' / ' || v_variant.option2, '');
      elsif v_item.variant_id is not null then
        raise exception 'variant_not_allowed';
      end if;
    else
      v_pname  := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku   := null;
      v_is_kit := false;
      v_track  := false;
      v_has_variants := false;
    end if;

    v_serial := nullif(btrim(coalesce(v_item.serial, '')), '');

    -- Modificadores (H37): snapshot de los grupos/opciones elegidos. El precio ya
    -- está en unit_price (base + deltas). Default '[]' cuando la línea no trae.
    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb));

    if v_item.product_id is not null then
      if v_is_kit then
        for v_comp in
          select pkc.component_product_id, pkc.quantity,
                 pr.stock as comp_stock, pr.allow_negative as comp_allow, pr.track_stock as comp_track
          from product_kit_components pkc
          join products pr on pr.id = pkc.component_product_id and pr.tenant_id = v_tenant
          where pkc.kit_product_id = v_item.product_id and pkc.tenant_id = v_tenant
        loop
          if v_comp.comp_track then
            if not coalesce(v_comp.comp_allow, v_allow_neg)
               and v_comp.comp_stock < (v_item.quantity * v_comp.quantity) then
              raise exception 'insufficient_stock';
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            insert into stock_movements (product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            insert into product_serials (product_id, serial, status, sale_id)
            values (v_item.product_id, v_serial, 'sold', v_sale_id)
            on conflict (product_id, serial) do update
              set status = 'sold', sale_id = v_sale_id;
          end if;
        end if;
      end if;
    end if;
  end loop;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    -- Gating server-side de medios de pago (QR: proveedor del intent referenciado).
    if v_pay.method = 'qr' then
      v_pay_feat := null;
      if v_pay.reference is not null
         and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
        select case pi.provider_key
                 when 'mercadopago' then 'mercado_pago'
                 when 'mobbex'      then 'mobbex'
                 when 'modo'        then 'modo'
                 else null
               end
          into v_pay_feat
        from mp_payment_intents pi
        where pi.id = v_pay.reference::uuid
          and pi.tenant_id = v_tenant
        limit 1;
      end if;
      if v_pay_feat is not null and not tenant_has_feature(v_pay_feat) then
        raise exception 'method_not_in_plan';
      end if;
    end if;

    -- Voucher de tarjeta (lote/cupón/autorización): dato operativo del cobro.
    insert into payments (sale_id, method, amount, reference, card_voucher)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
            coalesce(v_pay.card_voucher, '{}'::jsonb));

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (customer_id, delta, reason)
      values (p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total);
end;
$function$;

-- Mantiene los grants del RPC (mismo objeto recreado; reafirmados por claridad).
revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb) to authenticated;
