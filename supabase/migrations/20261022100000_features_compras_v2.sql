-- =============================================================================
-- 20261022100000_features_compras_v2  (F18 · H101 + H102 + H111, ADR-059)
--
-- Compras v2: devoluciones a proveedor, anulación de recepciones, órdenes de
-- pago con imputación, tesorería básica, consumo por lote y listas de precios
-- del proveedor.
--
-- Features de plan (convención CLAUDE.md §6):
--   • compras (existe, OPTIONAL Pro+): se extiende con devoluciones, anulación
--     de recepciones, órdenes de pago con imputación y pago en efectivo desde
--     la caja propia, trazabilidad por lote e importación de listas del
--     proveedor. Sin key nueva: el gating real sigue siendo purchase_assert.
--   • tesoreria (nueva, OPTIONAL Business+, requiere compras): cuentas de
--     caja general y bancos, movimientos, saldo, conciliación manual, cheques
--     propios y de terceros y flujo de fondos proyectado. Gating real en
--     treasury_assert (todas las RPC de tesorería) y en las líneas de orden de
--     pago que mueven una cuenta o un cheque.
--
-- Motivos de stock nuevos (NOT VALID: no revalida filas históricas):
--   • purchase_return: salida por devolución al proveedor.
--   • purchase_void: reversa de una recepción anulada.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('tesoreria', 'Tesorería',
   'Caja general y bancos, movimientos y saldos, conciliación manual, cheques en cartera y flujo de fondos proyectado',
   'catalogo', false, 79)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('tesoreria', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'tesoreria');

alter table stock_movements drop constraint if exists stock_movements_reason_check;
alter table stock_movements
  add constraint stock_movements_reason_check
  check (reason in ('purchase','sale','sale_void','adjustment','transfer','loss','return',
                    'production','count','transfer_out','transfer_in','transfer_return',
                    'purchase_return','purchase_void'))
  not valid;
