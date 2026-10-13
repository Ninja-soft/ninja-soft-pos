-- =============================================================================
-- 20261029100000_features_contabilidad  (ADR-066 · F18/H109)
--
-- Feature de plan `contabilidad` (convención CLAUDE.md §6):
--   • OPTIONAL, grupo reportes, desde Business (Business y Enterprise).
--   • Qué habilita: plan de cuentas por negocio con plantilla argentina,
--     centros de costo por sucursal, asientos automáticos desde ventas,
--     cobranzas, devoluciones, cierres de caja, compras, órdenes de pago,
--     tesorería, liquidaciones de procesadores y contracargos; mapeos
--     configurables, asientos manuales, cierre mensual, libros (Diario, Mayor,
--     sumas y saldos, estado de resultados, IVA ventas y compras) y export a
--     estudios contables (Tango, Holistor, Xubio, Colppy, CSV a medida).
--   • Gating real (migraciones siguientes): acc_assert() en todas las RPC de
--     escritura y de libros, y acc_tenant_active() en los triggers que
--     generan asientos (sin la feature no se genera nada).
--   • Análisis comercial: es el circuito con el estudio contable, mismo nivel
--     que tesorería y la conciliación de procesadores (Business). La
--     auditoría fiscal (docs/auditoria-fiscal-contable-precios.md, tabla de
--     features) la propone en Business.
--   • Planes a medida: heredan el valor de `tesoreria` si lo tienen; si no,
--     quedan apagados.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('contabilidad', 'Contabilidad',
   'Plan de cuentas, asientos automáticos desde ventas, cobros, compras, pagos, caja, tesorería y procesadores, cierre mensual, libros y export a estudios contables',
   'reportes', false, 178)
on conflict (key) do nothing;

-- Planes globales: Business y Enterprise.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('contabilidad', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'contabilidad');

-- Planes a medida (por tenant): heredan tesoreria (mismo nivel comercial).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'contabilidad',
         coalesce((p.limits -> 'modules' ->> 'tesoreria')::boolean, false)
       ),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'contabilidad');
