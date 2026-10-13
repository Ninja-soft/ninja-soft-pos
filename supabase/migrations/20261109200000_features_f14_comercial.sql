-- =============================================================================
-- 20261109200000_features_f14_comercial  (ADR-092 · F14 · H63, H64, H67)
--
-- Cuatro keys nuevas (convención CLAUDE.md §6):
--
--  * aprobaciones_comerciales  OPTIONAL · Business y Enterprise.
--      Maker-checker: el cambio de un encargado sobre una promoción de alto
--      impacto o un recargo (plan de cuotas) queda pendiente hasta que el
--      dueño lo aprueba. Es un control de cadena con encargados: un local
--      atendido por su dueño no lo necesita.
--  * alertas_margen            BASE · todos los planes.
--      Productos con margen bajo, negativo o por debajo del precio mínimo y
--      aviso cuando un costo nuevo deja un producto debajo del margen. Los
--      tres costos por producto ya son BASE (ADR-050): el aviso es parte de
--      tenerlos.
--  * conteo_ciclico            OPTIONAL · Pro, Business y Enterprise.
--      Conteo rotativo por clase ABC (lo que más vende se cuenta más seguido)
--      con exactitud de inventario por conteo.
--  * garantias_serie           OPTIONAL · Pro, Business y Enterprise.
--      Consulta de garantía por número de serie (de fábrica y extendida) y
--      reclamos de posventa por serie.
--
-- Gating real en el servidor (no sólo la UI): commercial_* (20261109200100),
-- margin_* (0200), cycle_count_* (0300) y serial_* (0400) exigen
-- tenant_has_feature_for(tenant, key).
--
-- La notificación del circuito comercial usa un tipo nuevo `comercial`.
-- Idempotente: sólo escribe las keys en los planes globales que no las tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('aprobaciones_comerciales', 'Aprobación de cambios comerciales',
   'Los cambios de un encargado sobre promociones de alto impacto y recargos de cuotas quedan pendientes hasta que el dueño los aprueba, con vencimiento y todo el circuito auditado',
   'ventas', false, 39),
  ('alertas_margen', 'Alertas de margen',
   'Productos con margen bajo, negativo o por debajo del precio mínimo, precio sugerido y aviso cuando un costo nuevo baja el margen',
   'catalogo', true, 74),
  ('conteo_ciclico', 'Conteo cíclico',
   'Conteo rotativo de stock por clase ABC (lo que más vende se cuenta más seguido) con exactitud de inventario por conteo',
   'catalogo', false, 75),
  ('garantias_serie', 'Garantías por número de serie',
   'Consulta de garantía por número de serie (de fábrica y extendida) y reclamos de posventa por serie',
   'catalogo', false, 76)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  -- Lo ya declarado gana: sólo se completan las keys que faltan.
  jsonb_build_object(
    'aprobaciones_comerciales', (p.key in ('business', 'enterprise')),
    'alertas_margen', true,
    'conteo_ciclico', (p.key in ('pro', 'business', 'enterprise')),
    'garantias_serie', (p.key in ('pro', 'business', 'enterprise'))
  ) || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'aprobaciones_comerciales'
           and coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'alertas_margen'
           and coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'conteo_ciclico'
           and coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'garantias_serie');
-- Planes a medida: no se declaran (alertas_margen cae al fallback is_basic).

-- Tipo de notificación del circuito comercial (aprobaciones y márgenes).
-- Copia de la lista más nueva (20261027100000_payment_disputes) + 'comercial'.
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications
  add constraint notifications_type_check
  check (type in ('news','plan','billing','usage','security','afip','maintenance','support',
                  'cobros','disputas','comercial'));
