-- =============================================================================
-- 20261106100000_features_agenda_f12  (ADR-082 · F12 · H38)
--
-- Dos features de plan nuevas (convención CLAUDE.md §6):
--
--  1) `agenda_recursos` · OPTIONAL, grupo ventas, desde Pro.
--     Qué habilita: cargar sillas, cabinas, boxes o equipos como recursos de la
--     agenda, asignar cada turno a un recurso, ver la agenda del día por
--     recurso y bloquear la doble reserva del mismo recurso.
--     Gating real: policies de insert/update de `agenda_resources` y el trigger
--     `appointments_resource_guard` (asignar un recurso a un turno) exigen
--     tenant_has_feature_for(tenant, 'agenda_recursos') (migración siguiente).
--     Análisis comercial: un negocio de una silla no lo necesita; ordenar varias
--     sillas o cabinas es de un salón con equipo, que ya está en Pro. Los planes
--     a medida heredan el valor de `descuentos` (primer módulo de nivel Pro).
--
--  2) `lista_espera` · BASE (is_basic), grupo ventas.
--     Qué habilita: anotar clientes que esperan un hueco (servicio, profesional
--     preferido, fecha y franja) y pasarlos a turno con un toque.
--     Gating real: policies de `agenda_waitlist` y la RPC
--     `agenda_waitlist_schedule` exigen tenant_has_feature_for(tenant,
--     'lista_espera') (migración 20261106100200).
--     Análisis comercial: es parte de la agenda básica (walk-ins y espera van
--     juntos); se marca true en los cuatro planes globales y un plan a medida
--     puede apagarla con modules.lista_espera = false.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('agenda_recursos', 'Recursos de agenda',
   'Sillas, cabinas, boxes o equipos como recursos de la agenda: turnos por recurso, vista por recurso y bloqueo de doble reserva',
   'ventas', false, 36),
  ('lista_espera', 'Lista de espera',
   'Anotar clientes que esperan un hueco en la agenda y pasarlos a turno con un toque',
   'ventas', true, 37)
on conflict (key) do nothing;

-- Planes globales.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('agenda_recursos', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'agenda_recursos');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('lista_espera', true),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'lista_espera');

-- Planes a medida (por tenant): recursos hereda el nivel Pro; la lista de
-- espera no se declara (cae al fallback is_basic = true).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('agenda_recursos', coalesce((p.limits -> 'modules' ->> 'descuentos')::boolean, false)),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'agenda_recursos');
