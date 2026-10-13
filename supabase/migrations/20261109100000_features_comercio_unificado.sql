-- =============================================================================
-- 20261109100000_features_comercio_unificado  (F16 · H76, H77, H82, ADR-091)
--
-- Features de plan nuevas (convención CLAUDE.md §6, las tres OPTIONAL):
--   • cockpit_comercio: tablero central del comercio unificado. Ventas por
--     canal y sucursal, pedidos por surtir, pagos fallidos o sin conciliar,
--     facturas bloqueadas, stock comprometido y alertas con SLA.
--     Business y Enterprise (es para quien opera varias sucursales o canales).
--   • reservas_stock: reservas de stock para un cliente en una sucursal con
--     retiro en tienda (Click & Collect) validado por código. Pro, Business y
--     Enterprise: un local solo también aparta mercadería para un cliente.
--   • prevencion_fraude: señales de riesgo operativo por persona (anulaciones,
--     descuentos, devoluciones, cobros rechazados y diferencias de caja),
--     reglas con umbrales del negocio y marcas de revisión automáticas sobre
--     devoluciones y anulaciones. Business y Enterprise.
--
-- El gating real vive en las RPC y triggers de 20261109100100 a
-- 20261109100300 (tenant_has_feature_for). La UI es sólo cortesía.
-- Idempotente: sólo escribe la key en los planes globales que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('cockpit_comercio', 'Cockpit de comercio unificado',
   'Tablero central con ventas por canal y sucursal, pedidos por surtir, pagos fallidos o sin conciliar, facturas bloqueadas, stock comprometido y alertas con SLA',
   'reportes', false, 185),
  ('reservas_stock', 'Reservas de stock y retiro en tienda',
   'Reservas de stock para un cliente en una sucursal, con vencimiento, preparación y retiro validado por código (Click & Collect)',
   'catalogo', false, 74),
  ('prevencion_fraude', 'Prevención de fraude',
   'Señales de riesgo por persona (anulaciones, descuentos, devoluciones, cobros rechazados, diferencias de caja), reglas con umbrales y marcas de revisión automáticas',
   'reportes', false, 186)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = false;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('cockpit_comercio', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'cockpit_comercio');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('reservas_stock', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'reservas_stock');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('prevencion_fraude', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'prevencion_fraude');
