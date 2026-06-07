-- =============================================================================
-- 20260607100000_variants_price_lists  (H10 — Variantes de producto + listas de precios)
-- Spec: docs/superpowers/specs/2026-06-06-h10-variants-price-lists-design.md
--
-- A) products: has_variants + variant_axes (hasta 2 ejes).
-- B) product_variants: matriz de combinaciones (option1/option2) con stock/SKU/
--    barcode/price_override propios y baja lógica.
-- C) price_lists + price_list_items: precios por canal (mostrador/catalogo/
--    mayorista/custom), ajuste % global y precio puntual por producto/variante.
-- D) sale_items / stock_movements: columna variant_id.
-- E) create_sale: valida y descuenta stock contra la variante (respeta
--    track_stock/allow_negative del padre).
-- F) return_sale: repone stock a la variante.
--
-- RLS y policies en estilo initplan (`(select fn())`) con write split en
-- insert/update/delete (owner/manager), igual que 20260604121000_perf_rls_initplan.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) products: flags de variantes.
-- -----------------------------------------------------------------------------
alter table products add column if not exists has_variants boolean not null default false;
alter table products add column if not exists variant_axes jsonb;

-- -----------------------------------------------------------------------------
-- B) product_variants.
-- -----------------------------------------------------------------------------
create table if not exists product_variants (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  product_id     uuid not null references products(id) on delete cascade,
  option1        text not null,
  option2        text,
  sku            text,
  barcode        text,
  price_override numeric(12,2),
  stock          numeric(12,3) not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index if not exists idx_product_variants_tenant on product_variants(tenant_id);
create index if not exists idx_product_variants_product on product_variants(product_id);
-- Única combinación activa de ejes por producto (option2 null = '').
create unique index if not exists uq_product_variants_combo
  on product_variants(product_id, option1, coalesce(option2, ''))
  where deleted_at is null;
-- Barcode escaneable directo en POS.
create index if not exists idx_product_variants_barcode
  on product_variants(tenant_id, barcode)
  where barcode is not null and deleted_at is null;

create trigger set_updated_at_product_variants
  before update on product_variants
  for each row execute function set_updated_at();

alter table product_variants enable row level security;

create policy product_variants_select on product_variants
  for select using (
    tenant_id = (select current_tenant_id()) or (select is_internal())
  );
create policy product_variants_insert on product_variants
  for insert with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );
create policy product_variants_update on product_variants
  for update using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  )
  with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );
create policy product_variants_delete on product_variants
  for delete using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );

-- -----------------------------------------------------------------------------
-- C) price_lists + price_list_items.
-- -----------------------------------------------------------------------------
create table if not exists price_lists (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  name           text not null,
  channel        text not null default 'custom'
                   check (channel in ('mostrador','catalogo','mayorista','custom')),
  adjustment_pct numeric(6,2),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index if not exists idx_price_lists_tenant on price_lists(tenant_id);
-- Una sola lista por canal no-custom por tenant.
create unique index if not exists uq_price_lists_channel
  on price_lists(tenant_id, channel)
  where channel <> 'custom' and deleted_at is null;

create trigger set_updated_at_price_lists
  before update on price_lists
  for each row execute function set_updated_at();

alter table price_lists enable row level security;

create policy price_lists_select on price_lists
  for select using (
    tenant_id = (select current_tenant_id()) or (select is_internal())
  );
create policy price_lists_insert on price_lists
  for insert with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );
create policy price_lists_update on price_lists
  for update using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  )
  with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );
create policy price_lists_delete on price_lists
  for delete using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );

create table if not exists price_list_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  price_list_id uuid not null references price_lists(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  variant_id    uuid references product_variants(id),
  price         numeric(12,2) not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_price_list_items_tenant on price_list_items(tenant_id);
create index if not exists idx_price_list_items_list on price_list_items(price_list_id);
create index if not exists idx_price_list_items_product on price_list_items(product_id);
-- Un precio por (lista, producto, variante); variante null = UUID cero.
create unique index if not exists uq_price_list_items_combo
  on price_list_items(
    price_list_id,
    product_id,
    coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create trigger set_updated_at_price_list_items
  before update on price_list_items
  for each row execute function set_updated_at();

alter table price_list_items enable row level security;

create policy price_list_items_select on price_list_items
  for select using (
    tenant_id = (select current_tenant_id()) or (select is_internal())
  );
create policy price_list_items_insert on price_list_items
  for insert with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );
create policy price_list_items_update on price_list_items
  for update using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  )
  with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );
create policy price_list_items_delete on price_list_items
  for delete using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );

-- -----------------------------------------------------------------------------
-- D) sale_items / stock_movements: columna variant_id.
-- -----------------------------------------------------------------------------
alter table sale_items add column if not exists variant_id uuid references product_variants(id);
alter table stock_movements add column if not exists variant_id uuid references product_variants(id);
create index if not exists idx_sale_items_variant on sale_items(variant_id) where variant_id is not null;
create index if not exists idx_stock_movements_variant on stock_movements(variant_id) where variant_id is not null;

-- -----------------------------------------------------------------------------
-- E) create_sale — versión viva (20260531340000) + soporte de variantes.
-- -----------------------------------------------------------------------------
create or replace function create_sale(
  p_items          jsonb,
  p_payments       jsonb,
  p_discount_total numeric default 0,
  p_customer_id    uuid default null,
  p_notes          text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
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
  end loop;

  if v_subtotal <= 0 then
    raise exception 'empty_sale';
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

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes)
  returning id into v_sale_id;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      -- H10: validación de variante. Productos con variantes exigen variant_id
      -- válido; productos sin variantes rechazan variant_id.
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
                            quantity, unit_price, discount, subtotal)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0));

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
            -- H10: stock contra la variante; allow_negative del padre.
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
      as x(method text, amount numeric, reference text)
  loop
    insert into payments (sale_id, method, amount, reference)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference);

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (customer_id, delta, reason)
      values (p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total);
end;
$$;

-- -----------------------------------------------------------------------------
-- F) return_sale — versión viva (20260531330000) + reposición a la variante.
-- -----------------------------------------------------------------------------
create or replace function return_sale(
  p_sale_id uuid,
  p_items   jsonb,
  p_reason  text default null,
  p_refund  text default 'cash'
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_sale   record;
  v_store  uuid;
  v_shift  uuid;
  v_number bigint;
  v_total  numeric := 0;
  v_ret    uuid;
  v_it     record;
  v_si     record;
  v_unit   numeric;
  v_qty    numeric;
  v_line   numeric;
  v_restock text;
  v_ratio  numeric := 1;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_refund not in ('cash','store_credit') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;
  if p_refund = 'store_credit' and v_sale.customer_id is null then
    raise exception 'store_credit_needs_customer';
  end if;

  -- Proporción real pagada (refleja descuento global + redondeo absorbido).
  if v_sale.subtotal is not null and v_sale.subtotal > 0 then
    v_ratio := v_sale.total / v_sale.subtotal;
  end if;

  select id into v_store from stores
   where tenant_id = v_tenant and deleted_at is null
   order by is_default desc, created_at limit 1;

  if p_refund = 'cash' then
    select cs.id into v_shift from cash_shifts cs
      join cash_registers cr on cr.id = cs.cash_register_id
     where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
     order by cs.opened_at desc limit 1;
    if v_shift is null then raise exception 'no_open_shift'; end if;
  end if;

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  insert into sale_returns (sale_id, customer_id, number, reason, refund_method, total)
  values (p_sale_id, v_sale.customer_id, v_number, p_reason, p_refund, 0)
  returning id into v_ret;

  for v_it in
    select * from jsonb_to_recordset(p_items)
      as x(sale_item_id uuid, quantity numeric, restock text)
  loop
    v_qty := coalesce(v_it.quantity, 0);
    if v_qty <= 0 then continue; end if;

    -- Lock de la línea para serializar devoluciones concurrentes.
    select * into v_si from sale_items
      where id = v_it.sale_item_id and sale_id = p_sale_id
      for update;
    if not found then raise exception 'item_not_found'; end if;
    if v_qty > (v_si.quantity - coalesce(v_si.returned_qty, 0)) then
      raise exception 'qty_exceeds';
    end if;

    v_unit := case when v_si.quantity > 0 then v_si.subtotal / v_si.quantity else v_si.unit_price end;
    v_line := round(v_unit * v_qty * v_ratio, 2);
    v_total := v_total + v_line;
    v_restock := coalesce(v_it.restock, 'stock');
    if v_restock not in ('stock','review','discard') then v_restock := 'stock'; end if;

    insert into sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, subtotal, restock)
    values (v_ret, v_si.id, v_si.product_id, v_qty, v_unit, v_line, v_restock);

    update sale_items set returned_qty = coalesce(returned_qty, 0) + v_qty where id = v_si.id;

    if v_restock = 'stock' and v_si.product_id is not null then
      if v_si.variant_id is not null then
        -- H10: repone a la variante (respeta track_stock del padre).
        update product_variants pv set stock = pv.stock + v_qty, updated_at = now()
          where pv.id = v_si.variant_id and pv.tenant_id = v_tenant
            and exists (select 1 from products p where p.id = v_si.product_id and p.tenant_id = v_tenant and p.track_stock);
        insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id)
        select v_tenant, v_si.product_id, v_si.variant_id, v_store, v_qty, 'return', v_ret
        where exists (select 1 from products p where p.id = v_si.product_id and p.tenant_id = v_tenant and p.track_stock);
      else
        update products set stock = stock + v_qty, updated_at = now()
          where id = v_si.product_id and tenant_id = v_tenant and track_stock;
        insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
        select v_tenant, v_si.product_id, v_store, v_qty, 'return', v_ret
        where exists (select 1 from products where id = v_si.product_id and tenant_id = v_tenant and track_stock);
      end if;
    end if;
  end loop;

  if v_total <= 0 then raise exception 'empty_return'; end if;
  update sale_returns set total = v_total where id = v_ret;

  if p_refund = 'cash' then
    insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
    values (v_shift, 'expense', v_total, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
  else
    insert into store_credit_movements (customer_id, delta, reason, sale_return_id)
    values (v_sale.customer_id, v_total, 'Devolución venta #' || v_sale.number, v_ret);
  end if;

  return jsonb_build_object('return_id', v_ret, 'number', v_number, 'total', v_total);
end;
$$;
