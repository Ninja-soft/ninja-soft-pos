-- =============================================================================
-- 20261108300300_activacion_cuentas_trabadas  (ADR-089 · F15 · H71)
--
-- Score de activación y cuentas trabadas en el panel interno, con la acción
-- "disparar recorrido o sugerencia correctiva".
--
--  A) onboarding_tenant_signals(tenant): UNA sola definición de las señales de
--     puesta en marcha por negocio (las de onboarding_status y las de
--     onboarding_activation_status de ADR-086, más primera venta, cantidad de
--     productos y turnos de caja de 7 días). Sin grant a clientes.
--     onboarding_status() y onboarding_activation_status() se recrean para
--     delegar en ella: misma respuesta que antes (mismas claves), sin copiar
--     la lógica en un tercer lugar.
--  B) internal_activation_overview(): señales de todos los negocios + uso de
--     recorridos y sugerencias + asignaciones abiertas. Login, ventas de 7
--     días y usuarios activos NO se repiten: el panel los toma de
--     internal_tenant_health (ADR-084). El puntaje y la regla de "trabada"
--     viven en lib/onboarding/activationScore.ts (puro, testeado).
--  C) internal_onboarding_assign / internal_onboarding_assignment_cancel:
--     el staff (soporte incluido: es su trabajo) dispara un recorrido o una
--     sugerencia publicada a un negocio, con motivo, rol opcional y vigencia.
--     Auditado con el tenant_id del negocio.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Señales por negocio
-- -----------------------------------------------------------------------------
create or replace function onboarding_tenant_signals(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- onboarding_status (pasos base)
    'fiscal', p_tenant is not null and exists (
      select 1 from tenant_branding where tenant_id = p_tenant and coalesce(cuit, '') <> ''),
    'mp', p_tenant is not null and (
      exists (
        select 1 from payment_secrets
         where tenant_id = p_tenant and provider_key = 'mercadopago'
           and coalesce(secrets ->> 'access_token', '') <> '')
      or exists (
        select 1 from tenant_payment_methods
         where tenant_id = p_tenant and provider_key = 'mercadopago' and enabled)),
    'producto', p_tenant is not null and exists (
      select 1 from products where tenant_id = p_tenant and deleted_at is null),
    'ticket', p_tenant is not null and exists (
      select 1 from ticket_templates where tenant_id = p_tenant and print_active and deleted_at is null),
    'venta', p_tenant is not null and exists (
      select 1 from sales where tenant_id = p_tenant),
    -- onboarding_activation_status (ADR-086)
    'caja', p_tenant is not null and exists (
      select 1 from cash_shifts where tenant_id = p_tenant),
    'equipo', p_tenant is not null and (
      select count(*) from tenant_users where tenant_id = p_tenant and status = 'active') > 1,
    'mesas', p_tenant is not null and exists (
      select 1 from dining_tables where tenant_id = p_tenant),
    'agenda', p_tenant is not null and exists (
      select 1 from appointments where tenant_id = p_tenant),
    'arca', p_tenant is not null and exists (
      select 1 from arca_settings where tenant_id = p_tenant and enabled and environment = 'produccion'),
    'escuela', p_tenant is not null and exists (
      select 1 from school_progress
       where tenant_id = p_tenant and course_key = 'pos-basico' and passed_at is not null),
    -- Sólo para el panel interno (H71)
    'medios', p_tenant is not null and exists (
      select 1 from tenant_payment_methods where tenant_id = p_tenant and enabled),
    'first_sale_at', (
      select min(created_at) from sales where tenant_id = p_tenant and status = 'completed'),
    'products_count', (
      select count(*) from products where tenant_id = p_tenant and deleted_at is null),
    'shifts_7d', (
      select count(*) from cash_shifts where tenant_id = p_tenant and opened_at >= now() - interval '7 days')
  );
$$;

revoke all on function onboarding_tenant_signals(uuid) from public, anon, authenticated;

create or replace function onboarding_status()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'fiscal', coalesce((s ->> 'fiscal')::boolean, false),
    'mp', coalesce((s ->> 'mp')::boolean, false),
    'producto', coalesce((s ->> 'producto')::boolean, false),
    'ticket', coalesce((s ->> 'ticket')::boolean, false),
    'venta', coalesce((s ->> 'venta')::boolean, false)
  )
  from (select onboarding_tenant_signals(current_tenant_id()) as s) x;
$$;

revoke all on function onboarding_status() from public, anon;
grant execute on function onboarding_status() to authenticated;

create or replace function onboarding_activation_status()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'caja', coalesce((s ->> 'caja')::boolean, false),
    'equipo', coalesce((s ->> 'equipo')::boolean, false),
    'mesas', coalesce((s ->> 'mesas')::boolean, false),
    'agenda', coalesce((s ->> 'agenda')::boolean, false),
    'arca', coalesce((s ->> 'arca')::boolean, false),
    'escuela', coalesce((s ->> 'escuela')::boolean, false)
  )
  from (select onboarding_tenant_signals(current_tenant_id()) as s) x;
$$;

revoke all on function onboarding_activation_status() from public, anon;
grant execute on function onboarding_activation_status() to authenticated;

-- -----------------------------------------------------------------------------
-- B) Vista de activación para el panel interno
-- -----------------------------------------------------------------------------
create or replace function internal_activation_overview()
returns table (
  tenant_id        uuid,
  name             text,
  industry         text,
  status           text,
  plan_family      text,
  created_at       timestamptz,
  trial_ends_at    timestamptz,
  signals          jsonb,
  tours_started    integer,
  tours_completed  integer,
  nudges_clicked   integer,
  open_assignments integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select t.id,
         t.name::text,
         coalesce(t.industry, 'otro')::text,
         coalesce(s.status, t.status)::text,
         coalesce(p.base_plan_key, p.key)::text,
         t.created_at,
         t.trial_ends_at,
         onboarding_tenant_signals(t.id),
         (select count(distinct e.run_id)::int from onboarding_tour_events e
           where e.tenant_id = t.id and e.event = 'start'),
         (select count(*)::int from onboarding_tour_events e
           where e.tenant_id = t.id and e.event = 'complete'),
         (select count(*)::int from onboarding_nudge_events e
           where e.tenant_id = t.id and e.event = 'clicked'),
         (select count(*)::int from onboarding_assignments a
           where a.tenant_id = t.id and a.consumed_at is null and a.cancelled_at is null
             and a.expires_at > now())
    from tenants t
    left join subscriptions s on s.tenant_id = t.id
    left join plans p on p.id = s.plan_id
   where t.deleted_at is null
   order by t.created_at desc;
end;
$$;

revoke all on function internal_activation_overview() from public, anon;
grant execute on function internal_activation_overview() to authenticated;

-- -----------------------------------------------------------------------------
-- C) Correctivos
-- -----------------------------------------------------------------------------
create or replace function internal_onboarding_assign(
  p_tenant uuid,
  p_kind   text,
  p_ref    uuid,
  p_reason text,
  p_role   text default null,
  p_days   integer default 14
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id    uuid;
  v_key   text;
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 5 and 500 then
    raise exception 'invalid_reason';
  end if;
  if p_kind not in ('tour', 'nudge') then raise exception 'invalid_kind'; end if;
  if p_role is not null and p_role not in ('owner', 'manager', 'cashier', 'viewer') then
    raise exception 'invalid_role';
  end if;
  if coalesce(p_days, 0) not between 1 and 60 then raise exception 'invalid_days'; end if;
  if not exists (select 1 from tenants where id = p_tenant and deleted_at is null) then
    raise exception 'tenant_not_found';
  end if;

  if p_kind = 'tour' then
    select key into v_key from onboarding_tours where id = p_ref and status = 'published';
  else
    select key into v_key from onboarding_nudges where id = p_ref and status = 'published';
  end if;
  if v_key is null then raise exception 'not_published'; end if;

  insert into onboarding_assignments (tenant_id, kind, tour_id, nudge_id, target_role, reason,
                                      created_by, expires_at)
  values (p_tenant, p_kind,
          case when p_kind = 'tour' then p_ref end,
          case when p_kind = 'nudge' then p_ref end,
          p_role, btrim(p_reason), auth.uid(), now() + make_interval(days => p_days))
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (p_tenant, auth.uid(), 'onboarding_assignments', v_id, 'onboarding_corrective_assigned',
          jsonb_build_object('kind', p_kind, 'key', v_key, 'role', p_role, 'days', p_days),
          btrim(p_reason));
  return v_id;
end;
$$;

create or replace function internal_onboarding_assignment_cancel(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a onboarding_assignments%rowtype;
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 5 and 500 then
    raise exception 'invalid_reason';
  end if;
  select * into a from onboarding_assignments where id = p_id for update;
  if not found or a.consumed_at is not null or a.cancelled_at is not null then
    raise exception 'assignment_not_open';
  end if;
  update onboarding_assignments set cancelled_at = now() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, reason)
  values (a.tenant_id, auth.uid(), 'onboarding_assignments', p_id, 'onboarding_corrective_cancelled',
          jsonb_build_object('kind', a.kind, 'tour_id', a.tour_id, 'nudge_id', a.nudge_id),
          btrim(p_reason));
end;
$$;

revoke all on function internal_onboarding_assign(uuid, text, uuid, text, text, integer) from public, anon;
revoke all on function internal_onboarding_assignment_cancel(uuid, text) from public, anon;
grant execute on function internal_onboarding_assign(uuid, text, uuid, text, text, integer) to authenticated;
grant execute on function internal_onboarding_assignment_cancel(uuid, text) to authenticated;
