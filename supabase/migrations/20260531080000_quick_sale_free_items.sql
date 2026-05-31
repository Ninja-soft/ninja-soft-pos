-- =============================================================================
-- 20260531080000_quick_sale_free_items
-- Venta rápida / monto libre: permite líneas de venta sin producto del catálogo.
--   * sale_items.product_id pasa a NULLABLE.
--   * create_sale acepta items con product_id null + "name" libre; no toca stock
--     en esos casos. Compatible hacia atrás: con product_id presente, igual que antes
--     (valida producto, descuenta stock, registra movimiento).
-- Ver vertical kiosco (docs/01-mvp.md), feature quickSale en lib/verticals.
-- =============================================================================

alter table sale_items alter column product_id drop not null;

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
  v_pname    text;
  v_psku     text;
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

  -- Items: con producto descuenta stock; sin producto (monto libre) no toca stock.
  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, name text, quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku into v_pname, v_psku
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;
    else
      v_pname := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku  := null;
    end if;

    insert into sale_items (sale_id, product_id, product_name, sku,
                            quantity, unit_price, discount, subtotal)
    values (v_sale_id, v_item.product_id, v_pname, v_psku,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0));

    if v_item.product_id is not null then
      update products
         set stock = stock - v_item.quantity, updated_at = now()
       where id = v_item.product_id and tenant_id = v_tenant;

      insert into stock_movements (product_id, store_id, delta, reason, reference_id)
      values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
    end if;
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
