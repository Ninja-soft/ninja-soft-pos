-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · Gastronomía — H50: Merma tipada (pérdidas de stock)                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- El ajuste de stock ya soporta el motivo `loss` ("Merma") como egreso genérico,
-- pero la merma gastronómica necesita SABER POR QUÉ se perdió: vencido, roto,
-- preparación fallida o descarte por devolución. Agregamos un SUB-motivo a la
-- línea de movimiento (`stock_movements.loss_reason`) y una RPC dedicada que
-- registra la merma SIEMPRE como egreso (cantidad > 0 que descuenta stock),
-- typed y atómica. Espeja `adjust_product_stock` (SECURITY INVOKER + RLS), así
-- que no necesita bypass: la RLS limita el UPDATE al tenant actual.

-- Sub-motivo de la merma (sólo se setea cuando reason = 'loss').
alter table stock_movements add column if not exists loss_reason text;
comment on column stock_movements.loss_reason is
  'Sub-motivo de merma cuando reason=loss: vencido/roto/preparacion_fallida/devolucion/otro. NULL para otros movimientos.';

-- register_stock_waste: registra una merma (egreso) con su sub-motivo.
-- p_qty es la cantidad PERDIDA (positiva); descuenta stock por esa cantidad e
-- inserta el movimiento con reason='loss' + loss_reason. Devuelve el nuevo stock.
create or replace function register_stock_waste(
  p_product_id uuid,
  p_qty        numeric,
  p_loss_reason text,
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
  if p_loss_reason not in ('vencido','roto','preparacion_fallida','devolucion','otro') then
    raise exception 'invalid_loss_reason: %', p_loss_reason;
  end if;

  -- RLS limita el UPDATE al tenant actual; si no matchea, no actualiza nada.
  update products
     set stock = stock - p_qty,
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_product_id
     and tenant_id = current_tenant_id()
     and deleted_at is null
  returning stock into v_new_stock;

  if v_new_stock is null then
    raise exception 'product_not_found_or_forbidden';
  end if;

  insert into stock_movements (tenant_id, product_id, delta, reason, loss_reason, notes, created_by)
  values (current_tenant_id(), p_product_id, -p_qty, 'loss', p_loss_reason, p_notes, auth.uid());

  return v_new_stock;
end;
$$;
