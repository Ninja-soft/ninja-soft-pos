-- =============================================================================
-- 20260531260000_returns_h29  (H29 — devoluciones, cambios y vales)
-- Devolución parcial de ventas: repone stock (o lo manda a revisión/descarte),
-- y reintegra por efectivo o emite un vale (saldo a favor del cliente).
-- =============================================================================

-- Cuánto de cada línea ya fue devuelto (integridad anti doble-devolución).
alter table sale_items add column if not exists returned_qty numeric not null default 0;

-- Cabecera de devolución.
create table if not exists sale_returns (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  sale_id       uuid not null references sales(id),
  customer_id   uuid references customers(id),
  number        bigint not null,
  reason        text,
  refund_method text not null check (refund_method in ('cash','store_credit')),
  total         numeric(12,2) not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references public.users(id)
);
create index if not exists sale_returns_tenant_idx on sale_returns(tenant_id, created_at desc);
create index if not exists sale_returns_sale_idx on sale_returns(sale_id);
alter table sale_returns enable row level security;
create policy sale_returns_select on sale_returns
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy sale_returns_insert on sale_returns
  for insert with check (tenant_id = current_tenant_id());

-- Renglones devueltos.
create table if not exists sale_return_items (
  id           uuid primary key default gen_random_uuid(),
  return_id    uuid not null references sale_returns(id) on delete cascade,
  sale_item_id uuid not null references sale_items(id),
  product_id   uuid,
  quantity     numeric(12,3) not null,
  unit_price   numeric(12,2) not null,
  subtotal     numeric(12,2) not null,
  restock      text not null default 'stock' check (restock in ('stock','review','discard'))
);
create index if not exists sale_return_items_return_idx on sale_return_items(return_id);
alter table sale_return_items enable row level security;
create policy sale_return_items_select on sale_return_items
  for select using (exists (
    select 1 from sale_returns r where r.id = return_id
      and (r.tenant_id = current_tenant_id() or is_internal())));
create policy sale_return_items_insert on sale_return_items
  for insert with check (exists (
    select 1 from sale_returns r where r.id = return_id and r.tenant_id = current_tenant_id()));

-- Movimientos de saldo a favor (vale) por cliente. Balance = sum(delta).
create table if not exists store_credit_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  customer_id    uuid not null references customers(id) on delete cascade,
  delta          numeric(12,2) not null,
  reason         text,
  sale_return_id uuid references sale_returns(id),
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references public.users(id)
);
create index if not exists store_credit_customer_idx on store_credit_movements(tenant_id, customer_id);
alter table store_credit_movements enable row level security;
create policy store_credit_select on store_credit_movements
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy store_credit_insert on store_credit_movements
  for insert with check (tenant_id = current_tenant_id());

-- -----------------------------------------------------------------------------
-- return_sale — devolución parcial. p_items: [{sale_item_id, quantity, restock}]
-- p_refund: 'cash' (sale de caja) | 'store_credit' (vale al cliente de la venta)
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
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_refund not in ('cash','store_credit') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;
  if p_refund = 'store_credit' and v_sale.customer_id is null then
    raise exception 'store_credit_needs_customer';
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

    select * into v_si from sale_items where id = v_it.sale_item_id and sale_id = p_sale_id;
    if not found then raise exception 'item_not_found'; end if;
    if v_qty > (v_si.quantity - coalesce(v_si.returned_qty, 0)) then
      raise exception 'qty_exceeds';
    end if;

    v_unit := case when v_si.quantity > 0 then v_si.subtotal / v_si.quantity else v_si.unit_price end;
    v_line := round(v_unit * v_qty, 2);
    v_total := v_total + v_line;
    v_restock := coalesce(v_it.restock, 'stock');
    if v_restock not in ('stock','review','discard') then v_restock := 'stock'; end if;

    insert into sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, subtotal, restock)
    values (v_ret, v_si.id, v_si.product_id, v_qty, v_unit, v_line, v_restock);

    update sale_items set returned_qty = coalesce(returned_qty, 0) + v_qty where id = v_si.id;

    -- Solo 'stock' repone al inventario; 'review'/'discard' quedan registrados.
    if v_restock = 'stock' and v_si.product_id is not null then
      update products set stock = stock + v_qty, updated_at = now()
        where id = v_si.product_id and tenant_id = v_tenant and track_stock;
      insert into stock_movements (product_id, store_id, delta, reason, reference_id)
      select v_si.product_id, v_store, v_qty, 'return', v_ret
      where exists (select 1 from products where id = v_si.product_id and tenant_id = v_tenant and track_stock);
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
