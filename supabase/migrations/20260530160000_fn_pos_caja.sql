-- =============================================================================
-- 20260530160000_fn_pos_caja
-- Hito 2/3 — funciones atómicas de caja y venta. SECURITY INVOKER: RLS aplica.
--   open_cash_shift  — abre turno (bloquea si ya hay uno abierto en la caja).
--   close_cash_shift — cierra turno con arqueo (calcula esperado).
--   create_sale      — venta atómica: sale + items + stock + caja + correlativo.
-- Ver docs/03-architecture.md §5, docs/01-mvp.md §4.1.3-4.1.4.
-- =============================================================================

-- ---------- open_cash_shift ----------
create or replace function open_cash_shift(
  p_register_id    uuid,
  p_opening_amount numeric
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_shift_id uuid;
begin
  if exists (
    select 1 from cash_shifts
    where cash_register_id = p_register_id
      and tenant_id = current_tenant_id()
      and status = 'open'
  ) then
    raise exception 'shift_already_open';
  end if;

  insert into cash_shifts (cash_register_id, opening_amount, status)
  values (p_register_id, p_opening_amount, 'open')
  returning id into v_shift_id;

  return v_shift_id;
end;
$$;

-- ---------- close_cash_shift ----------
create or replace function close_cash_shift(
  p_shift_id       uuid,
  p_closing_amount numeric,
  p_notes          text default null
)
returns numeric  -- diferencia (closing - expected)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_opening  numeric;
  v_expected numeric;
  v_diff     numeric;
begin
  select opening_amount into v_opening
  from cash_shifts
  where id = p_shift_id and tenant_id = current_tenant_id() and status = 'open';
  if v_opening is null then
    raise exception 'shift_not_open';
  end if;

  -- Efectivo esperado = apertura + ingresos − egresos + ventas cash − anulaciones cash.
  select v_opening
       + coalesce(sum(case when type = 'income' then amount
                           when type = 'expense' then -amount
                           when type = 'sale' and payment_method = 'cash' then amount
                           when type = 'sale_void' and payment_method = 'cash' then -amount
                           else 0 end), 0)
    into v_expected
  from cash_movements
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  v_diff := p_closing_amount - v_expected;

  update cash_shifts
     set status = 'closed',
         closed_at = now(),
         closed_by = auth.uid(),
         expected_amount = v_expected,
         closing_amount = p_closing_amount,
         notes = p_notes
   where id = p_shift_id and tenant_id = current_tenant_id();

  return v_diff;
end;
$$;

-- ---------- create_sale ----------
-- p_items:    [{ "product_id": uuid, "quantity": num, "unit_price": num, "discount": num }]
-- p_payments: [{ "method": text, "amount": num, "reference": text }]
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
  v_paid     numeric := 0;
  v_sale_id  uuid;
  v_item     record;
  v_pay      record;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  -- Sucursal por defecto del tenant.
  select id into v_store
  from stores
  where tenant_id = v_tenant and deleted_at is null
  order by is_default desc, created_at
  limit 1;
  if v_store is null then
    raise exception 'no_store';
  end if;

  -- Turno de caja abierto (bloqueo de venta sin caja, docs/01 §4.1.4).
  select cs.id into v_shift
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
  order by cs.opened_at desc
  limit 1;
  if v_shift is null then
    raise exception 'no_open_shift';
  end if;

  -- Subtotal de items.
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

  v_total := v_subtotal - coalesce(p_discount_total, 0);

  -- Pagos cubren el total.
  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
  end loop;
  if v_paid < v_total then
    raise exception 'insufficient_payment';
  end if;

  -- Número correlativo por tenant.
  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  -- Venta.
  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, coalesce(p_discount_total, 0), 0, v_total, p_notes)
  returning id into v_sale_id;

  -- Items + descuento de stock + movimiento de stock.
  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    insert into sale_items (sale_id, product_id, product_name, sku,
                            quantity, unit_price, discount, subtotal)
    select v_sale_id, p.id, p.name, p.sku,
           v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
           (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0)
    from products p
    where p.id = v_item.product_id and p.tenant_id = v_tenant;

    update products
       set stock = stock - v_item.quantity, updated_at = now()
     where id = v_item.product_id and tenant_id = v_tenant;

    insert into stock_movements (product_id, store_id, delta, reason, reference_id)
    values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
  end loop;

  -- Pagos + movimientos de caja.
  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text)
  loop
    insert into payments (sale_id, method, amount, reference)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference);

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total);
end;
$$;
