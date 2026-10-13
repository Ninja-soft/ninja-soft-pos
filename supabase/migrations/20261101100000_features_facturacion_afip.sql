-- =============================================================================
-- 20261101100000_features_facturacion_afip  (F3 · ADR-072)
--
-- `facturacion_afip` deja de ser MARKETING-FUTURO: ahora tiene función
-- (facturación electrónica con ARCA por WSFEv1) y gating real server-side.
--
-- Clasificación (CLAUDE.md §6): OPTIONAL (is_basic = false), grupo
-- `integraciones`, desde Pro (Pro, Business y Enterprise; Start no). Es lo que
-- ya marcaba la matriz desde 20260608150000_plans_overhaul: se reafirma sólo
-- donde falta la clave, sin pisar lo que el interno haya cambiado.
--
-- Gating real (migración siguiente, 20261101100100_arca_facturacion):
--   · el encolado (triggers de ventas, devoluciones y anulaciones) no crea
--     comprobantes sin la feature;
--   · arca_settings_save, arca_set_environment, arca_document_retry y
--     arca_enqueue_sale exigen tenant_has_feature_for(tenant,
--     'facturacion_afip');
--   · la Edge `arca_wsfe` llama a arca_edge_guard (dueño o encargado + feature)
--     antes de cualquier acción de usuario, y el worker sólo toma negocios con
--     la feature (arca_due_tenants).
-- =============================================================================

update features
   set label = 'Facturación electrónica ARCA',
       description = 'Factura A, B y C y notas de crédito con CAE de ARCA (ex AFIP) por WSFEv1: certificados por negocio, homologación y producción, cola con reintentos, QR fiscal en el ticket y monitor',
       grupo = 'integraciones',
       is_basic = false
 where key = 'facturacion_afip';

insert into features (key, label, description, grupo, is_basic, sort) values
  ('facturacion_afip', 'Facturación electrónica ARCA',
   'Factura A, B y C y notas de crédito con CAE de ARCA (ex AFIP) por WSFEv1: certificados por negocio, homologación y producción, cola con reintentos, QR fiscal en el ticket y monitor',
   'integraciones', false, 220)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('facturacion_afip', p.key in ('pro', 'business', 'enterprise')),
  true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'facturacion_afip');

-- Planes a medida: no se tocan (sin la clave, la feature queda apagada porque
-- no es básica; el interno la prende desde el editor de planes).
