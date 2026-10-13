-- =============================================================================
-- 20261108300000_features_tours_sugerencias  (ADR-089 · F15 · H70, H74)
--
-- Dos keys nuevas, las dos BASE (CLAUDE.md §6):
--
--  * tours        · Recorridos guiados dentro del sistema (pasos sobre la UI,
--                   "hacer ahora"). Los define el staff desde internal.
--  * sugerencias  · Sugerencias de uso por evento (sin productos, sin caja
--                   abierta, trial por vencer, venta fallida...) con cooldown
--                   y límite por sesión y por día.
--
-- Análisis comercial: enseñar a usar el sistema baja tickets de soporte y
-- acelera la primera venta; no es un diferencial de plan. Van en los cuatro
-- planes globales (modules.<key> = true) y un plan a medida las puede apagar
-- con modules.<key> = false.
--
-- Gating real (no sólo la UI): tours_for_me, nudge_next y los triggers de
-- onboarding_tour_events y onboarding_nudge_events exigen
-- tenant_has_feature_for(tenant, key) (migraciones 20261108300100 y 0200).
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('tours', 'Recorridos guiados',
   'Recorridos paso a paso sobre la pantalla (primer cobro, recorrido por rubro) que configura NinjaSoft sin actualizar el sistema',
   'extras', true, 91),
  ('sugerencias', 'Sugerencias de uso',
   'Avisos cortos y oportunos según lo que pasa en el negocio (sin productos, caja sin abrir, prueba por vencer), con límite por día',
   'extras', true, 92)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  -- Lo ya declarado gana: sólo se completan las keys que faltan.
  jsonb_build_object('tours', true, 'sugerencias', true)
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'tours'
           and coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'sugerencias');
-- Planes a medida: no se declaran (caen al fallback is_basic = true).
