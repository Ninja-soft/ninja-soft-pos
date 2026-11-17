-- =============================================================================
-- SEC-59 · El PIN de supervisor de 'sale_return' no se exigía con umbral > 0
-- =============================================================================
-- trg_sale_returns_supervisor (20261017120000_propiedad_caja) corría sólo
-- BEFORE INSERT en sale_returns y evaluaba la política con new.total. Pero
-- return_sale_v2 (y el legado return_sale, y exchange_sale que reusa
-- return_sale_v2) insertan la cabecera con total = 0 y fijan el total real con
-- un UPDATE después de recorrer los ítems. Con umbral > 0, 0 >= umbral es falso:
-- el servidor nunca pedía el PIN y un cajero devolvía cualquier monto sin
-- supervisor (el POS pide el PIN sólo cuando el servidor lo exige). Con
-- umbral 0 sí se pedía, pero el token se validaba contra un monto 0 (cualquier
-- token de 'sale_return' alcanzaba).
--
-- Arreglo (opción A, el más chico): el mismo trigger corre también BEFORE
-- UPDATE OF total y la política se evalúa cuando el total SUBE (0 → total real,
-- o un aumento posterior), con el monto real. Un INSERT con total 0 (cabecera
-- provisoria, sin efectos de dinero) ya no evalúa: así el token se pide y se
-- consume UNA sola vez, atado al monto final. Un INSERT que ya trae el total
-- (> 0) sigue evaluando como antes.
--
-- Por qué no recrear return_sale_v2 (opción B): el legado return_sale sigue con
-- EXECUTE para authenticated (modules/sales/api.ts lo llama) y tiene el mismo
-- patrón cabecera-en-0 → UPDATE; arreglarlo sólo en return_sale_v2 dejaba un
-- bypass por RPC. El trigger cubre los tres caminos sin copiar ~250 líneas.
--
-- Orden: el UPDATE del total ocurre después de reponer stock y antes de mover
-- caja, acreditar cuenta corriente, emitir el vale o pedir el reintegro por
-- Mercado Pago. Si falta el PIN, la excepción revierte la transacción entera
-- (stock, returned_qty, auditoría incluidos). Contrato para el front sin
-- cambios: 'supervisor_required:sale_return' (42501) o
-- 'supervisor_token_invalid'; withSupervisor pide el PIN con el total de la
-- venta (>= total devuelto) y reintenta.
--
-- Definiciones de producción comparadas (pg_get_functiondef): return_sale_v2,
-- trg_sale_returns_supervisor, require_supervisor y pin_action_required son
-- iguales a su última migración (sin drift).
-- =============================================================================

create or replace function public.trg_sale_returns_supervisor()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Cabecera provisoria en 0: el total real llega con el UPDATE.
  if coalesce(new.total, 0) <= 0 then
    return new;
  end if;
  -- En un UPDATE sólo cuando el total sube (0 → total real): una sola vez.
  if tg_op = 'UPDATE' and new.total <= coalesce(old.total, 0) then
    return new;
  end if;
  perform require_supervisor('sale_return', new.total, new.sale_id);
  return new;
end;
$$;

-- SEC-12: las funciones de trigger no se ejecutan por el Data API.
revoke execute on function public.trg_sale_returns_supervisor() from public, anon, authenticated;

drop trigger if exists sale_returns_supervisor on public.sale_returns;
create trigger sale_returns_supervisor
  before insert or update of total on public.sale_returns
  for each row execute function public.trg_sale_returns_supervisor();
