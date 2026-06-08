-- =============================================================================
-- 20260608560000_service_packs  (F12 · H41 — paquetes / packs de sesiones)
-- -----------------------------------------------------------------------------
-- Packs de sesiones para peluquería/estética/servicios: el cliente compra un
-- pack ("4 cortes", "10 sesiones de estética") y se le acredita un SALDO DE
-- SESIONES. Al cobrar el servicio que el pack cubre, en vez de pagarlo, se
-- "usa una sesión" del pack: la línea queda CUBIERTA (precio 0) y se incrementa
-- el contador de sesiones usadas.
--
-- Es el análogo del vale/saldo a favor (H29), pero la unidad es la SESIÓN en
-- lugar de la plata: comprar el pack acredita sesiones; consumir descuenta una.
--
-- MODELO (reusa create_sale; NO cambia su firma — usa p_extras como H28/H39):
--
--  1) service_packs (definición del pack, por tenant):
--       name           → "4 cortes", "10 sesiones de estética".
--       product_id     → el servicio/producto que el pack cubre (FK, NULLABLE:
--                        null = pack genérico, cualquier línea puede consumirlo).
--       sessions       → cantidad de sesiones que otorga (int > 0).
--       price          → precio del pack (entra como ítem de venta al venderlo).
--       validity_days  → vigencia desde la compra (int NULL = sin vencimiento).
--       is_active / sort / baja lógica (deleted_at).
--
--  2) customer_pack_credits (saldo de sesiones de un cliente, una fila por compra):
--       customer_id    → dueño del saldo (NOT NULL: un pack siempre es de alguien).
--       pack_id        → el pack comprado (snapshot de sesiones/vigencia al comprar).
--       sessions_total → sesiones otorgadas (= service_packs.sessions al comprar).
--       sessions_used  → sesiones ya consumidas (default 0; <= sessions_total).
--       expires_at     → vencimiento (now()+validity_days al comprar; NULL = nunca).
--       sale_id        → venta donde se compró (trazabilidad).
--     Saldo disponible = sessions_total - sessions_used, válido si expires_at es
--     NULL o futuro. La unicidad es por fila/compra (un cliente puede tener varias
--     compras del mismo pack; se consumen FIFO por vencimiento más próximo).
--
-- create_sale (extiende la versión VIVA de H39 `commissions_tips`, firma de 6
--   args con p_extras, intacta) suma dos kinds en p_extras:
--     { "kind": "pack",         "id": "<service_packs.id>" }
--        → al confirmar la venta, ACREDITA un customer_pack_credits al cliente
--          (requiere cliente). El pack ENTRA como ítem de venta por su precio
--          (lo agrega el front en p_items, como hace H28 con la garantía); este
--          extra es sólo la señal para acreditar el saldo de sesiones.
--     { "kind": "pack_session", "id": "<customer_pack_credits.id>" }
--        → CONSUME una sesión de ese crédito: valida que sea del cliente de la
--          venta, del tenant, con saldo (> used) y NO vencido; incrementa
--          sessions_used y audita el consumo. La línea cubierta la agrega el
--          front en p_items con unit_price 0 (no se cobra), igual que un ítem
--          libre gratuito. El consumo es explícito por extra (una sesión c/u).
--
-- RLS: aislamiento por tenant en ambas tablas (igual que el resto del dominio).
-- Auditoría: trigger genérico write_audit_log en ambas + insert explícito de
-- 'pack_session_used' en audit_logs al consumir (la fila no cambia de tenant, así
-- que el trigger UPDATE ya la audita; el insert explícito deja el "consumo" con
-- acción semántica y antes/después del contador).
--
-- GATING: se agrega la feature 'packs' al catálogo como BÁSICA (visible por
-- defecto; un plan puede apagarla con modules.packs=false). No se bloquea
-- server-side en create_sale (es venta normal + crédito); la sección la gatea
-- por la feature, igual que 'agenda' (H38).
--
-- FUERA DE ALCANCE (follow-up, NO en este PR): membresía recurrente (cruza con
-- suscripciones) y gift cards (cruza con vales). Sólo se mencionan.
-- =============================================================================

-- ── 1) Definición de packs ────────────────────────────────────────────────────
create table if not exists service_packs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name          text not null,
  -- Servicio/producto cubierto. on delete set null: si se borra el producto, el
  -- pack queda como genérico (cubre cualquier línea). NULL desde el alta = genérico.
  product_id    uuid references products(id) on delete set null,
  sessions      int not null check (sessions > 0),
  price         numeric(12,2) not null default 0 check (price >= 0),
  -- Vigencia desde la compra (días). NULL = sin vencimiento.
  validity_days int check (validity_days is null or validity_days > 0),
  is_active     boolean not null default true,
  sort          int not null default 0,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists service_packs_tenant_idx
  on service_packs(tenant_id) where deleted_at is null;
create index if not exists service_packs_product_idx
  on service_packs(product_id) where product_id is not null;

create trigger set_updated_at_service_packs
  before update on service_packs
  for each row execute function set_updated_at();

alter table service_packs enable row level security;
create policy service_packs_tenant_isolation on service_packs
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create trigger audit_service_packs
  after insert or update or delete on service_packs
  for each row execute function write_audit_log();

-- ── 2) Saldo de sesiones por cliente ──────────────────────────────────────────
create table if not exists customer_pack_credits (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  customer_id    uuid not null references customers(id) on delete cascade,
  -- Pack comprado. on delete set null: si se borra la definición, el saldo del
  -- cliente sobrevive (snapshot sessions_total/expires_at son estables).
  pack_id        uuid references service_packs(id) on delete set null,
  -- Snapshot al comprar (estable aunque el pack cambie/borre).
  pack_name      text not null,
  product_id     uuid references products(id) on delete set null,
  sessions_total int not null check (sessions_total > 0),
  sessions_used  int not null default 0 check (sessions_used >= 0),
  expires_at     timestamptz,
  sale_id        uuid references sales(id) on delete set null,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.users(id) default auth.uid(),
  -- No se pueden usar más sesiones de las otorgadas.
  constraint pack_credit_used_lte_total check (sessions_used <= sessions_total)
);
create index if not exists customer_pack_credits_customer_idx
  on customer_pack_credits(tenant_id, customer_id);
create index if not exists customer_pack_credits_product_idx
  on customer_pack_credits(product_id) where product_id is not null;
create index if not exists customer_pack_credits_sale_idx
  on customer_pack_credits(sale_id);

alter table customer_pack_credits enable row level security;
create policy customer_pack_credits_tenant_isolation on customer_pack_credits
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create trigger audit_customer_pack_credits
  after insert or update or delete on customer_pack_credits
  for each row execute function write_audit_log();

-- ── 3) Gating: feature 'packs' (básica → visible por defecto) ─────────────────
insert into features (key, label, description, grupo, is_basic, sort) values
  ('packs', 'Paquetes y sesiones', 'Packs de sesiones (bonos) por cliente', 'ventas', true, 36)
on conflict (key) do nothing;

-- ── 4) create_sale: acreditar pack + consumir sesión desde p_extras ───────────
--    Reescribe la versión VIVA (H39 `commissions_tips`, firma de 6 args)
--    conservando TODA su lógica (stock/variantes/kits/serial, gating de
--    descuentos/garantías/cuenta corriente/medios QR, advisory lock del
--    correlativo, vale, propina, profesional) y agregando:
--      * lectura de los extras 'pack' (acreditar) y 'pack_session' (consumir),
--      * tras insertar la venta: acreditar customer_pack_credits por cada 'pack',
--      * consumir una sesión por cada 'pack_session' (valida cliente/saldo/
--        vencimiento, incrementa sessions_used, audita 'pack_session_used').
create or replace function public.create_sale(
  p_items jsonb,
  p_payments jsonb,
  p_discount_total numeric default 0,
  p_customer_id uuid default null,
  p_notes text default null,
  p_extras jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
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
  -- H39: propina + profesional atribuido.
  v_tip_amount numeric := 0;
  v_tip_method text;
  v_professional uuid;
  -- H41: packs (acreditar) + consumo de sesión.
  v_pack     record;
  v_pcredit  record;
  v_pk       service_packs%rowtype;
  -- ¿La venta consume al menos una sesión de pack? Una venta así puede tener
  -- subtotal 0 (la línea cubierta entra en precio 0): el "valor" es la sesión,
  -- no la plata. Se permite el subtotal en cero SÓLO en ese caso (sigue
  -- rechazándose el subtotal negativo y la venta vacía sin pack).
  v_has_pack_session boolean := false;
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

  -- H41: ¿hay consumo de sesión de pack? (permite subtotal 0 — línea cubierta).
  select exists (
    select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text)
    where lower(coalesce(e.kind,'')) = 'pack_session'
  ) into v_has_pack_session;

  -- Venta vacía: subtotal negativo nunca; subtotal 0 sólo si consume una sesión
  -- de pack (la línea cubierta vale 0 pero la venta SÍ tiene contenido: la sesión).
  if v_subtotal < 0 or (v_subtotal = 0 and not v_has_pack_session) then
    raise exception 'empty_sale';
  end if;

  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;

  -- H39: propina (kind='tip').
  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'tip'
                           then coalesce(e.amount, 0) else 0 end), 0),
         max(case when lower(coalesce(e.kind,'')) = 'tip' then e.method end)
    into v_tip_amount, v_tip_method
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric, method text);
  if v_tip_amount < 0 then
    raise exception 'invalid_tip';
  end if;
  if v_tip_amount > 0 and v_tip_method is null then
    v_tip_method := 'cash';
  end if;

  -- H39: profesional atribuido (kind='professional', id).
  select (e.id)::uuid into v_professional
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, id text)
  where lower(coalesce(e.kind,'')) = 'professional'
    and e.id is not null
  limit 1;
  if v_professional is not null then
    if not exists (
      select 1 from professionals
      where id = v_professional and tenant_id = v_tenant
        and deleted_at is null and is_active
    ) then
      v_professional := null;
    end if;
  end if;

  -- H41: si la venta vende o consume un pack, requiere cliente (el saldo de
  -- sesiones SIEMPRE es de alguien). Se valida acá para fallar temprano.
  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
         as e(kind text)
       where lower(coalesce(e.kind,'')) in ('pack','pack_session')
     )
     and p_customer_id is null then
    raise exception 'pack_needs_customer';
  end if;

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
  if v_paid < v_total + v_tip_amount then
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

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end)
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

  -- ── H41 · A) Acreditar packs vendidos (kind='pack') ─────────────────────────
  -- Por cada extra 'pack', crea un saldo de sesiones para el cliente con el
  -- snapshot del pack (sesiones + vigencia). El pack ya entró como ítem de venta
  -- en p_items (lo agrega el front por su precio); acá sólo se acredita el saldo.
  for v_pack in
    select (e.id)::uuid as pack_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack' and e.id is not null
  loop
    select * into v_pk from service_packs
     where id = v_pack.pack_id and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'pack_not_found';
    end if;
    insert into customer_pack_credits (
      customer_id, pack_id, pack_name, product_id,
      sessions_total, sessions_used, expires_at, sale_id
    )
    values (
      p_customer_id, v_pk.id, v_pk.name, v_pk.product_id,
      v_pk.sessions, 0,
      case when v_pk.validity_days is not null
           then now() + make_interval(days => v_pk.validity_days) else null end,
      v_sale_id
    );
  end loop;

  -- ── H41 · B) Consumir sesiones (kind='pack_session') ────────────────────────
  -- Por cada extra 'pack_session', descuenta una sesión del crédito indicado.
  -- Valida: crédito del cliente y tenant, con saldo disponible y NO vencido. La
  -- línea cubierta ya entró en 0 en p_items. Incrementa sessions_used y audita.
  for v_pack in
    select (e.id)::uuid as credit_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack_session' and e.id is not null
  loop
    select * into v_pcredit from customer_pack_credits
     where id = v_pack.credit_id and tenant_id = v_tenant
       and customer_id = p_customer_id
     for update;
    if not found then
      raise exception 'pack_credit_not_found';
    end if;
    if v_pcredit.sessions_used >= v_pcredit.sessions_total then
      raise exception 'pack_no_sessions_left';
    end if;
    if v_pcredit.expires_at is not null and v_pcredit.expires_at < now() then
      raise exception 'pack_expired';
    end if;

    update customer_pack_credits
       set sessions_used = sessions_used + 1
     where id = v_pcredit.id and tenant_id = v_tenant;

    -- Auditoría semántica del consumo (la fila no cambia de tenant → el trigger
    -- UPDATE ya la audita; este registro deja el "uso de sesión" explícito con
    -- el antes/después del contador y la venta donde se consumió).
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_tenant, auth.uid(), 'customer_pack_credits', v_pcredit.id, 'pack_session_used',
            jsonb_build_object('sessions_used', v_pcredit.sessions_used,
                               'sessions_total', v_pcredit.sessions_total),
            jsonb_build_object('sessions_used', v_pcredit.sessions_used + 1,
                               'sessions_total', v_pcredit.sessions_total,
                               'sale_id', v_sale_id, 'sale_number', v_number));
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount);
end;
$function$;

revoke all on function public.create_sale(jsonb,jsonb,numeric,uuid,text,jsonb) from public, anon;
grant execute on function public.create_sale(jsonb,jsonb,numeric,uuid,text,jsonb) to authenticated;

-- ── 5) customer_pack_credits(): saldos activos de un cliente ──────────────────
--    SECURITY DEFINER, tenant-scoped + guard de miembro activo. Devuelve los
--    packs del cliente con sesiones restantes y vencimiento, ordenados por
--    vencimiento más próximo (FIFO de consumo recomendado). `p_only_available`
--    filtra a los que tienen saldo y no vencieron (para ofrecer "usar sesión" en
--    el POS); en falso devuelve todos (para el historial del cliente).
create or replace function public.customer_pack_credits(
  p_customer_id uuid,
  p_only_available boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'forbidden';
  end if;

  return (
    select coalesce(jsonb_agg(j order by ord_exp, ord_created), '[]'::jsonb) from (
      select jsonb_build_object(
               'id', c.id,
               'pack_id', c.pack_id,
               'pack_name', c.pack_name,
               'product_id', c.product_id,
               'sessions_total', c.sessions_total,
               'sessions_used', c.sessions_used,
               'sessions_left', c.sessions_total - c.sessions_used,
               'expires_at', c.expires_at,
               'expired', (c.expires_at is not null and c.expires_at < now()),
               'sale_id', c.sale_id,
               'created_at', c.created_at
             ) as j,
             -- Orden: vencimiento más próximo primero (NULL = sin vto, al final).
             coalesce(c.expires_at, 'infinity'::timestamptz) as ord_exp,
             c.created_at as ord_created
      from customer_pack_credits c
      where c.tenant_id = v_tenant
        and c.customer_id = p_customer_id
        and (
          not p_only_available
          or (c.sessions_used < c.sessions_total
              and (c.expires_at is null or c.expires_at >= now()))
        )
    ) t
  );
end;
$function$;

revoke all on function public.customer_pack_credits(uuid, boolean) from public, anon;
grant execute on function public.customer_pack_credits(uuid, boolean) to authenticated;
