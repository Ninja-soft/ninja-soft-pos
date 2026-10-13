-- =============================================================================
-- 20261109800000_features_comisiones_estimadas  (F8 · ADR-099)
--
-- Feature de plan nueva (convención CLAUDE.md §6):
--   • comisiones_estimadas (OPTIONAL, grupo pagos): reporte de medios de pago
--     con la comisión estimada de cada medio (y de cada plan de cuotas o
--     procesador), el neto estimado y las propinas por medio. El dueño carga
--     las comisiones que le cobra cada procesador; no hace falta conectar nada.
--     Pro, Business y Enterprise (mismo nivel que conciliacion_tarjetas: es
--     control administrativo de quien ya cobra con varios medios). Los planes a
--     medida heredan el valor de conciliacion_tarjetas.
--
-- El gating real vive en 20261109800100 (trigger de payment_fee_rules y RPC
-- payment_fees_report, ambos con tenant_has_feature_for). La UI es cortesía.
-- Idempotente: sólo escribe la key en los planes que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('comisiones_estimadas', 'Comisiones estimadas por medio de pago',
   'Reporte de medios de pago con la comisión estimada por medio, procesador y cuotas, el neto estimado y las propinas por medio',
   'pagos', false, 23)
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
    || jsonb_build_object('comisiones_estimadas', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'comisiones_estimadas');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'comisiones_estimadas',
         coalesce((p.limits -> 'modules' ->> 'conciliacion_tarjetas')::boolean, false)
       ),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'comisiones_estimadas');
