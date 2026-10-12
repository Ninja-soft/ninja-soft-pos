-- =============================================================================
-- 20261024100000_features_conciliacion_procesadores  (ADR-061)
--
-- Feature de plan `conciliacion_procesadores` (convención CLAUDE.md §6):
--   • OPTIONAL, grupo reportes, desde Business (Business y Enterprise).
--   • Qué habilita: importar la liquidación de los procesadores (Mercado Pago
--     por API, automático todos los días; Payway y cualquier adquirente por
--     archivo), cruzarla sola con las ventas, marcar conciliados los cobros
--     que cierran y revisar las diferencias (cobro sin venta, venta sin cobro,
--     diferencia de monto, pendiente de acreditación) con comisiones,
--     impuestos y neto por cobro.
--   • Gating real: settlement_import_lines, settlement_line_resolve y
--     _settlement_apply_matches (migración siguiente) y la Edge `settlements`
--     (sincronización con la API, a mano y por cron) exigen
--     tenant_has_feature_for(tenant, 'conciliacion_procesadores').
--   • Análisis comercial: es la conciliación automática que hoy se paga aparte
--     (NubCeo y similares); va con el resto del control administrativo
--     avanzado de Business (auditoría, tesorería). Pro sigue con la
--     conciliación de tarjetas manual (conciliacion_tarjetas).
--   • Planes a medida: heredan el valor de `tesoreria` si lo tienen; si no,
--     quedan apagados.
--
-- Los "Datos del procesador" del detalle de la venta NO son de esta feature:
-- son BASE (ver el cobro que hizo el negocio con su propia credencial).
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('conciliacion_procesadores', 'Conciliación de procesadores',
   'Liquidaciones de Mercado Pago (automática por API), Payway y otros adquirentes cruzadas con las ventas: comisiones, impuestos, neto, acreditaciones y diferencias',
   'reportes', false, 176)
on conflict (key) do nothing;

-- Planes globales: Business y Enterprise.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('conciliacion_procesadores', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'conciliacion_procesadores');

-- Planes a medida (por tenant): heredan tesoreria (mismo nivel comercial).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'conciliacion_procesadores',
         coalesce((p.limits -> 'modules' ->> 'tesoreria')::boolean, false)
       ),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'conciliacion_procesadores');
