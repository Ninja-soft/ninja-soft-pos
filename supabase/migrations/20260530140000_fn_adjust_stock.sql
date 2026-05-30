-- =============================================================================
-- 20260530140000_fn_adjust_stock
-- Hito 1 — ajuste atómico de stock. Actualiza products.stock e inserta el
-- stock_movement en una sola transacción (la función es una unidad atómica).
-- SECURITY INVOKER: corre como el usuario, la RLS aplica (no necesita bypass).
-- El frontend la invoca con supabase.rpc('adjust_product_stock', ...).
-- Decisión: RPC en vez de Edge Function porque una función SQL ya es atómica
-- y RLS-safe; una Edge Function solo la envolvería. Ver docs/04 §9.
-- =============================================================================
create or replace function adjust_product_stock(
  p_product_id uuid,
  p_delta      numeric,
  p_reason     text,
  p_notes      text default null
)
returns numeric
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_new_stock numeric;
begin
  if p_reason not in ('purchase','sale','sale_void','adjustment','transfer','loss','return') then
    raise exception 'invalid_reason: %', p_reason;
  end if;

  -- RLS limita el UPDATE al tenant actual; si no matchea, no actualiza nada.
  update products
     set stock = stock + p_delta,
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_product_id
     and tenant_id = current_tenant_id()
     and deleted_at is null
  returning stock into v_new_stock;

  if v_new_stock is null then
    raise exception 'product_not_found_or_forbidden';
  end if;

  insert into stock_movements (tenant_id, product_id, delta, reason, notes, created_by)
  values (current_tenant_id(), p_product_id, p_delta, p_reason, p_notes, auth.uid());

  return v_new_stock;
end;
$$;
