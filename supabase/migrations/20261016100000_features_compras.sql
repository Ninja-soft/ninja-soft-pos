-- =============================================================================
-- 20261016100000_features_compras  (F18 · H101 + H102, ADR-050)
--
-- Features de plan nuevas (convención CLAUDE.md §6, categoría OPTIONAL):
--   • compras: proveedores, productos por proveedor, órdenes de compra,
--     recepción de mercadería, facturas de proveedor, pagos y cuenta corriente
--     de proveedores. Pro, Business y Enterprise.
--   • compras_importacion: modo profesional de importación (hoja de costeo
--     FOB / CIF / tributos / gastos con prorrateo y n° de despacho por lote).
--     Business y Enterprise. Requiere compras.
--
-- Los tres costos por producto (último, promedio ponderado y reposición) y la
-- base de costo elegida para el margen son BASE (sin key): existen para todos.
--
-- Idempotente: sólo se escribe la key en los planes que todavía no la tienen
-- (no pisa lo editado a mano en el editor de planes).
-- El gating real vive en las RPC y policies (20261016100100 a 20261016100300).
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('compras', 'Compras y proveedores',
   'Proveedores, órdenes de compra, recepción de mercadería, facturas y cuenta corriente de proveedores',
   'catalogo', false, 76),
  ('compras_importacion', 'Costeo de importación',
   'Hoja de costeo de importación (FOB, flete, seguro, CIF, tributos y gastos) con prorrateo y n° de despacho',
   'catalogo', false, 78)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('compras', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'compras');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('compras_importacion', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'compras_importacion');
