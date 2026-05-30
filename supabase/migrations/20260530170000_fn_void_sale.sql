-- =============================================================================
-- 20260530170000_fn_void_sale
-- Hito 2 — anulación atómica de venta. Revierte stock y registra el contramov.
-- de caja. SECURITY INVOKER (RLS aplica). Solo ventas 'completed' del tenant.
-- Ver docs/01-mvp.md §4.1.3, docs/05-security.md §8.1.
-- =============================================================================
create or replace function void_sale(
  p_sale_id uuid,
  p_reason  text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid;
  v_shift  uuid;
  v_item   record;
  v_pay    record;
begin
  select store_id, cash_shift_id into v_store, v_shift
  from sales
  where id = p_sale_id and tenant_id = v_tenant and status = 'completed';
  if v_store is null then
    raise exception 'sale_not_found_or_not_voidable';
  end if;

  update sales
     set status = 'voided',
         voided_at = now(),
         voided_by = auth.uid(),
         void_reason = p_reason,
         updated_at = now()
   where id = p_sale_id and tenant_id = v_tenant;

  -- Revertir stock.
  for v_item in
    select product_id, quantity from sale_items
    where sale_id = p_sale_id and tenant_id = v_tenant
  loop
    update products
       set stock = stock + v_item.quantity, updated_at = now()
     where id = v_item.product_id and tenant_id = v_tenant;

    insert into stock_movements (product_id, store_id, delta, reason, reference_id)
    values (v_item.product_id, v_store, v_item.quantity, 'sale_void', p_sale_id);
  end loop;

  -- Contramovimiento de caja por cada pago (si hay turno).
  if v_shift is not null then
    for v_pay in
      select method, amount from payments
      where sale_id = p_sale_id and tenant_id = v_tenant
    loop
      insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
      values (v_shift, 'sale_void', v_pay.amount, v_pay.method, p_sale_id);
    end loop;
  end if;
end;
$$;
