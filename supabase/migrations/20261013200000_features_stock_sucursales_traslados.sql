-- =============================================================================
-- 20261013200000_features_stock_sucursales_traslados  (F17 · H94 + H95, ADR-046)
--
-- Features de plan nuevas (convención CLAUDE.md §6, categoría OPTIONAL):
--   • stock_sucursales: stock separado por sucursal (desglose, ajustes, mínimos,
--     máximos y ubicación por sucursal). Requiere multi_sucursal.
--   • traslados: traslados de stock entre sucursales (programados, en tránsito,
--     recepción con diferencias, aprobación y remito). Requiere stock_sucursales
--     (y por lo tanto multi_sucursal).
--
-- Tiering: Business y Enterprise (mismo nivel que multi_sucursal: sin varias
-- sucursales no tienen sentido). Idempotente: sólo se escribe la key en los
-- planes que todavía no la tienen (no pisa lo que se haya editado a mano en el
-- editor de planes).
--
-- El gating real vive en las RPC (20261013200100 y 20261013200200): la UI nunca
-- es la única barrera.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('stock_sucursales', 'Stock por sucursal',
   'Stock separado por sucursal con mínimos, máximos y ubicación', 'catalogo', false, 72),
  ('traslados', 'Traslados entre sucursales',
   'Traslados de stock programados, en tránsito y con recepción por diferencias', 'catalogo', false, 74)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('stock_sucursales', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'stock_sucursales');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('traslados', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'traslados');
