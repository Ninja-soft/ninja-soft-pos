-- =============================================================================
-- 20261105100000_rls_sucursal_cobros_traslados  (F17 · H91 · ADR-080)
--
-- Cierra el pendiente de H91 "RLS restrictiva de lectura": ADR-045 dejó
-- `sales`, `cash_shifts`, `cash_movements` y `cash_z_closures` acotadas a las
-- sucursales del usuario (user_allowed_store_ids), pero los cobros y los
-- traslados se seguían leyendo por negocio. Un cajero de Norte que consultaba
-- `payments` por REST veía los cobros de Centro (montos, cupones, n° de
-- comercio) aunque no viera las ventas.
--
--   * payments: RESTRICTIVE de lectura por la sucursal de su venta.
--   * stock_transfers: visible si el origen o el destino es una sucursal del
--     usuario (los dos extremos necesitan ver el traslado: despacha uno,
--     recibe el otro). Ítems y eventos siguen al traslado.
--   * product_stock NO se restringe (decisión, ADR-080): el criterio de H94 es
--     que "el cajero ve que en Norte quedan 3" (Ver en otras sucursales). El
--     saldo de stock no es dato sensible y se necesita para vender y para
--     sugerir traslados.
--
-- RESTRICTIVE: se suman con AND a las policies de negocio existentes (que ya
-- usan internal_scope(), ADR-052), sin tocarlas. Para el dueño, el encargado
-- sin asignaciones y los negocios con una sola sucursal no cambia nada
-- (user_allowed_store_ids devuelve todas). `(select ...)` evalúa la lista una
-- vez por consulta (initplan). El staff interno sólo pasa en el panel interno
-- (internal_scope(), nunca is_internal() suelto).
--
-- Escritura: no cambia. Los cobros los escribe create_sale (SECURITY DEFINER)
-- y los triggers; los traslados, sólo las RPC transfer_* (SECURITY DEFINER).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) payments: la sucursal sale de la venta.
-- -----------------------------------------------------------------------------
drop policy if exists payments_branch_scope on payments;
create policy payments_branch_scope on payments
  as restrictive for select
  using (
    (select internal_scope())
    or exists (
      select 1 from sales s
       where s.id = payments.sale_id
         and s.store_id = any ((select user_allowed_store_ids())::uuid[])
    )
  );

-- -----------------------------------------------------------------------------
-- B) Traslados: origen o destino del usuario.
-- -----------------------------------------------------------------------------
drop policy if exists stock_transfers_branch_scope on stock_transfers;
create policy stock_transfers_branch_scope on stock_transfers
  as restrictive for select
  using (
    (select internal_scope())
    or origin_store_id = any ((select user_allowed_store_ids())::uuid[])
    or dest_store_id = any ((select user_allowed_store_ids())::uuid[])
  );

drop policy if exists stock_transfer_items_branch_scope on stock_transfer_items;
create policy stock_transfer_items_branch_scope on stock_transfer_items
  as restrictive for select
  using (
    (select internal_scope())
    or exists (
      select 1 from stock_transfers t
       where t.id = stock_transfer_items.transfer_id
         and (t.origin_store_id = any ((select user_allowed_store_ids())::uuid[])
              or t.dest_store_id = any ((select user_allowed_store_ids())::uuid[]))
    )
  );

drop policy if exists stock_transfer_events_branch_scope on stock_transfer_events;
create policy stock_transfer_events_branch_scope on stock_transfer_events
  as restrictive for select
  using (
    (select internal_scope())
    or exists (
      select 1 from stock_transfers t
       where t.id = stock_transfer_events.transfer_id
         and (t.origin_store_id = any ((select user_allowed_store_ids())::uuid[])
              or t.dest_store_id = any ((select user_allowed_store_ids())::uuid[]))
    )
  );

-- payments.sale_id ya tiene índice (FK); sales(id) es PK. Los traslados tienen
-- índice por origen y destino (20261013200200).
