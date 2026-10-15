-- =============================================================================
-- 20261204100000_features_roles_permisos  (ADR-138)
--
-- roles_permisos deja de ser MARKETING-FUTURO (ADR-024): la función existe.
-- OPTIONAL (is_basic = false, grupo clientes), Business y Enterprise como hasta
-- ahora en la matriz comercial (ver docs/17-decision-log.md, ADR-138).
--
--   · Sin la feature: los roles de sistema (Dueño, Encargado, Cajero, Solo
--     lectura, Vendedor, Auditor) funcionan igual en todo plan.
--   · Con la feature: roles personalizados por negocio y permisos puntuales
--     por persona (conceder o quitar una capacidad).
--
-- Gating real: capabilities_for() ignora roles personalizados y permisos
-- puntuales si el plan no tiene la feature (cae al rol de sistema del nivel
-- base) y las RPC de 20261204100200 la exigen para crearlos.
-- Idempotente: sólo escribe la key en los planes globales que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('roles_permisos', 'Roles y permisos a medida',
   'Roles propios del negocio (crear, duplicar desde Cajero o Encargado, color e ícono), rol por sucursal y permisos puntuales por persona, con editor simple por módulos y matriz avanzada. Los roles de sistema funcionan en todos los planes.',
   'clientes', false, 140)
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
    || jsonb_build_object('roles_permisos', p.key in ('business', 'enterprise')),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'roles_permisos');
