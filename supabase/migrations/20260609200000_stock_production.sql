-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · Gastronomía — H50: Producción / preparación previa (batch)          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Heladería/panadería/cocina preparan stock por adelantado: un batch de helado,
-- una tanda de masa, prep de barra. Registrar la PRODUCCIÓN suma ese stock al
-- producto preparado y deja el movimiento trazado (reason='production'), distinto
-- de una compra. Espeja register_stock_waste (H50 merma) pero como INGRESO:
-- p_qty es la cantidad PRODUCIDA (positiva) y se SUMA al stock. SECURITY INVOKER
-- + RLS (como adjust_product_stock): no necesita bypass.
--
-- ALCANCE v1: sólo suma el stock del producto preparado. El DESCUENTO de los
-- insumos de la receta (cuando el insumo esté vinculado a un producto de stock)
-- queda como follow-up (hoy las recetas usan ingrediente como texto libre).

create or replace function register_production(
  p_product_id uuid,
  p_qty        numeric,
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
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'invalid_qty';
  end if;

  -- RLS limita el UPDATE al tenant actual; si no matchea, no actualiza nada.
  update products
     set stock = stock + p_qty,
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
  values (current_tenant_id(), p_product_id, p_qty, 'production', p_notes, auth.uid());

  return v_new_stock;
end;
$$;
