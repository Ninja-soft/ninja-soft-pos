-- =============================================================================
-- 20261017100000_personal_estados  (F17 · H113 · ADR-051)
--
-- Ciclo de vida del personal: suspensión, licencia, baja y reingreso, para
-- usuarios con login y perfiles de cajero sin cuenta.
--
--   A) staff_status_events: historial con vigencias (como staff_branch_
--      assignments). Evaluación PEREZOSA por fecha (branch_today()), sin cron.
--      Baja lógica (deleted_at) para cancelar algo programado.
--        · suspension : sanción. Motivo obligatorio; con o sin fecha de vuelta.
--        · leave      : licencia (vacaciones, enfermedad, maternidad, ...).
--        · termination: baja (despido, renuncia, fin de contrato, otro). Sin
--                       fin: la corta un reingreso.
--        · rehire     : reingreso (evento puntual para el historial).
--      Prioridad del estado efectivo: baja > suspensión > licencia > activo.
--   B) staff_effective_status() / staff_status_detail() / assert_staff_
--      operational(). user_allowed_store_ids() devuelve vacío y
--      is_tenant_manager() da false para quien no está activo: sin sucursales no
--      ve ni opera caja ni ventas (policies RESTRICTIVE de ADR-045).
--   C) tenant_users.status suma 'inactive' (baja efectiva). La baja además
--      borra las sesiones del usuario y saca el negocio de
--      app_metadata.current_tenant_id si era el activo: la RLS lo deja afuera
--      en el próximo refresh. El reingreso lo restaura.
--   D) RPC: staff_set_status, staff_end_status, staff_rehire, staff_people,
--      staff_sync_due, ensure_current_tenant. Owner/manager; un encargado no
--      toca al dueño ni a otro encargado; nadie se cambia a sí mismo. Todo
--      auditado. Gating: feature BASE `personal_estados`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Feature BASE
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('personal_estados', 'Estados del personal',
   'Suspensión, licencia, baja y reingreso del personal con historial', 'clientes', true, 142)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('personal_estados', true), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'personal_estados');

-- -----------------------------------------------------------------------------
-- A) Membresía: estado 'inactive' (baja)
-- -----------------------------------------------------------------------------
alter table tenant_users drop constraint if exists tenant_users_status_check;
alter table tenant_users add constraint tenant_users_status_check
  check (status in ('active', 'suspended', 'invited', 'inactive'));

-- -----------------------------------------------------------------------------
-- A) Historial de estados
-- -----------------------------------------------------------------------------
create table if not exists staff_status_events (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  user_id            uuid references public.users(id) on delete cascade,
  cashier_profile_id uuid references cashier_profiles(id) on delete cascade,
  kind               text not null check (kind in ('suspension', 'leave', 'termination', 'rehire')),
  subtype            text,
  starts_on          date not null,
  ends_on            date,
  reason             text,
  notes              text,
  created_by         uuid default auth.uid() references public.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  ended_by           uuid references public.users(id),
  ended_at           timestamptz,
  deleted_at         timestamptz,
  cancelled_by       uuid references public.users(id),
  cancel_reason      text,
  constraint staff_status_person_chk check ((user_id is null) <> (cashier_profile_id is null)),
  constraint staff_status_dates_chk check (ends_on is null or ends_on >= starts_on),
  constraint staff_status_subtype_chk check (
    (kind = 'leave' and subtype in ('vacaciones', 'enfermedad', 'maternidad', 'paternidad', 'estudio', 'otra'))
    or (kind = 'termination' and subtype in ('despido', 'renuncia', 'fin_contrato', 'otro'))
    or (kind in ('suspension', 'rehire'))
  )
);

create index if not exists staff_status_user_idx
  on staff_status_events (tenant_id, user_id) where deleted_at is null;
create index if not exists staff_status_profile_idx
  on staff_status_events (tenant_id, cashier_profile_id) where deleted_at is null;

drop trigger if exists set_updated_at_staff_status on staff_status_events;
create trigger set_updated_at_staff_status
  before update on staff_status_events
  for each row execute function set_updated_at();

alter table staff_status_events enable row level security;
drop policy if exists staff_status_select on staff_status_events;
-- Lo ve el dueño o encargado del negocio, o la propia persona (su historial).
create policy staff_status_select on staff_status_events
  for select using (
    (tenant_id = (select current_tenant_id())
      and ((select is_tenant_manager()) or user_id = (select auth.uid())))
    or (select internal_scope())
  );
-- Sin policies de escritura: todo pasa por las RPC de abajo.

-- -----------------------------------------------------------------------------
-- B) Estado efectivo (perezoso)
-- -----------------------------------------------------------------------------
create or replace function staff_status_detail(
  p_tenant  uuid,
  p_user    uuid,
  p_profile uuid,
  p_on      date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_on date := coalesce(p_on, branch_today());
  v_ev staff_status_events%rowtype;
begin
  select * into v_ev
    from staff_status_events e
   where e.tenant_id = p_tenant
     and e.deleted_at is null
     and e.kind in ('termination', 'suspension', 'leave')
     and ((p_user is not null and e.user_id = p_user)
          or (p_profile is not null and e.cashier_profile_id = p_profile))
     and e.starts_on <= v_on
     and (e.ends_on is null or e.ends_on >= v_on)
   order by case e.kind when 'termination' then 0 when 'suspension' then 1 else 2 end,
            e.starts_on desc
   limit 1;
  if not found then
    return jsonb_build_object('status', 'active');
  end if;
  return jsonb_build_object(
    'status', case v_ev.kind when 'termination' then 'terminated'
                             when 'suspension' then 'suspended'
                             else 'on_leave' end,
    'event_id', v_ev.id,
    'subtype', v_ev.subtype,
    'since', v_ev.starts_on,
    'until', v_ev.ends_on,
    'reason', v_ev.reason);
end;
$$;
revoke all on function staff_status_detail(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function staff_status_detail(uuid, uuid, uuid, date) to service_role;

create or replace function staff_effective_status(
  p_tenant  uuid,
  p_user    uuid,
  p_profile uuid default null,
  p_on      date default null
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select staff_status_detail(p_tenant, p_user, p_profile, p_on) ->> 'status';
$$;
revoke all on function staff_effective_status(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function staff_effective_status(uuid, uuid, uuid, date) to service_role;

-- Estado del usuario del JWT en el negocio activo (para la UI: pantalla de
-- "tu acceso está suspendido").
create or replace function my_staff_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then
    return jsonb_build_object('status', 'active');
  end if;
  return staff_status_detail(v_tenant, auth.uid(), null, null);
end;
$$;
revoke all on function my_staff_status() from public, anon;
grant execute on function my_staff_status() to authenticated;

-- Corta la operación de quien no está activo. El dueño nunca tiene eventos
-- (las RPC no lo permiten) y el staff interno no se evalúa.
create or replace function assert_staff_operational()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_status text;
begin
  if v_tenant is null or auth.uid() is null or is_internal() then return; end if;
  v_status := staff_effective_status(v_tenant, auth.uid(), null, null);
  if v_status = 'terminated' then raise exception 'staff_terminated' using errcode = '42501'; end if;
  if v_status = 'suspended' then raise exception 'staff_suspended' using errcode = '42501'; end if;
  if v_status = 'on_leave' then raise exception 'staff_on_leave' using errcode = '42501'; end if;
end;
$$;
revoke all on function assert_staff_operational() from public, anon;
grant execute on function assert_staff_operational() to authenticated;

-- is_tenant_manager(): copia de 20260608740000 + personal operativo.
create or replace function public.is_tenant_manager()
  returns boolean
  language sql
  stable security definer
  set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from tenant_users tu
     where tu.tenant_id = current_tenant_id()
       and tu.user_id = auth.uid()
       and tu.status = 'active'
       and tu.role in ('owner', 'manager')
       and (tu.role = 'owner'
            or staff_effective_status(tu.tenant_id, tu.user_id, null, null) = 'active')
  );
$function$;

-- user_allowed_store_ids(): copia de 20261013110000 + personal operativo.
create or replace function user_allowed_store_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
begin
  if v_tenant is null then return '{}'; end if;
  if is_internal() then
    return coalesce((select array_agg(id) from stores where tenant_id = v_tenant), '{}');
  end if;
  select role into v_role from tenant_users
   where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
   limit 1;
  if v_role is null then return '{}'; end if;
  -- H113: suspendido, de licencia o dado de baja no ve ni opera sucursales.
  if v_role <> 'owner' and staff_effective_status(v_tenant, auth.uid(), null, null) <> 'active' then
    return '{}';
  end if;
  return staff_allowed_store_ids(v_tenant, auth.uid(), null, v_role, null);
end;
$$;
revoke all on function user_allowed_store_ids() from public, anon;
grant execute on function user_allowed_store_ids() to authenticated;

-- -----------------------------------------------------------------------------
-- C) Efectos de la baja sobre la cuenta (sesiones y negocio activo)
-- -----------------------------------------------------------------------------
-- Saca el negocio del app_metadata si era el activo (lo pasa a otra membresía
-- activa si tiene) y borra sus sesiones. Nunca hace fallar la RPC: si el rol no
-- tiene permiso sobre auth (proyecto con auth gestionado), queda un warning y
-- la operación igual está cortada por user_allowed_store_ids().
create or replace function staff_revoke_access(p_tenant uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_other uuid;
begin
  select tu.tenant_id into v_other
    from tenant_users tu
   where tu.user_id = p_user and tu.status = 'active' and tu.tenant_id <> p_tenant
   order by tu.joined_at nulls last
   limit 1;
  begin
    update auth.users
       set raw_app_meta_data = case
             when v_other is null then coalesce(raw_app_meta_data, '{}'::jsonb) - 'current_tenant_id'
             else coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('current_tenant_id', v_other)
           end
     where id = p_user
       and raw_app_meta_data ->> 'current_tenant_id' = p_tenant::text;
    delete from auth.sessions where user_id = p_user;
  exception when others then
    raise warning 'staff_revoke_access: %', sqlerrm;
  end;
end;
$$;
revoke all on function staff_revoke_access(uuid, uuid) from public, anon, authenticated;

-- Le da al usuario el negocio activo si no tiene ninguno.
create or replace function staff_grant_access(p_tenant uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                               || jsonb_build_object('current_tenant_id', p_tenant)
     where id = p_user
       and coalesce(raw_app_meta_data ->> 'current_tenant_id', '') = '';
  exception when others then
    raise warning 'staff_grant_access: %', sqlerrm;
  end;
end;
$$;
revoke all on function staff_grant_access(uuid, uuid) from public, anon, authenticated;

-- Autocuración: un usuario con membresía activa y sin negocio activo (p. ej.
-- invitado antes de este fix) recibe el de su primera membresía activa. El
-- cliente refresca la sesión si devuelve true.
create or replace function ensure_current_tenant()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  if auth.uid() is null or current_tenant_id() is not null then return false; end if;
  select tu.tenant_id into v_tenant
    from tenant_users tu
   where tu.user_id = auth.uid() and tu.status = 'active'
   order by tu.joined_at nulls last
   limit 1;
  if v_tenant is null then return false; end if;
  perform staff_grant_access(v_tenant, auth.uid());
  return true;
end;
$$;
revoke all on function ensure_current_tenant() from public, anon;
grant execute on function ensure_current_tenant() to authenticated;

-- Aplica las bajas que ya entraron en vigencia (programadas a futuro): la
-- membresía pasa a 'inactive' y se revoca el acceso. Idempotente; la llaman las
-- RPC de personal y el tablero (sin cron).
create or replace function staff_sync_due()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_r      record;
  v_n      int := 0;
begin
  if v_tenant is null then return 0; end if;
  for v_r in
    select distinct tu.user_id
      from tenant_users tu
      join staff_status_events e
        on e.tenant_id = tu.tenant_id and e.user_id = tu.user_id
     where tu.tenant_id = v_tenant
       and tu.status = 'active'
       and tu.role <> 'owner'
       and e.deleted_at is null
       and e.kind = 'termination'
       and e.starts_on <= branch_today()
       and (e.ends_on is null or e.ends_on >= branch_today())
  loop
    update tenant_users set status = 'inactive'
     where tenant_id = v_tenant and user_id = v_r.user_id;
    perform staff_revoke_access(v_tenant, v_r.user_id);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'tenant_users', v_r.user_id, 'staff_termination_applied',
            jsonb_build_object('user_id', v_r.user_id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function staff_sync_due() from public, anon;
grant execute on function staff_sync_due() to authenticated;

-- -----------------------------------------------------------------------------
-- D) RPC
-- -----------------------------------------------------------------------------
-- Valida que el llamador pueda gestionar a la persona y devuelve su rol
-- (null = perfil sin cuenta).
create or replace function staff_assert_can_manage(p_user uuid, p_profile uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_me     text;
  v_target text;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  if (p_user is null) = (p_profile is null) then raise exception 'invalid_person'; end if;
  select role into v_me from tenant_users
   where tenant_id = v_tenant and user_id = auth.uid() and status = 'active';
  if p_user is not null then
    if p_user = auth.uid() then raise exception 'cannot_change_self'; end if;
    select role into v_target from tenant_users where tenant_id = v_tenant and user_id = p_user;
    if v_target is null then raise exception 'member_not_found'; end if;
    if v_target = 'owner' then raise exception 'cannot_change_owner' using errcode = '42501'; end if;
    if v_me <> 'owner' and v_target = 'manager' then
      raise exception 'forbidden_manager' using errcode = '42501';
    end if;
    return v_target;
  end if;
  if not exists (select 1 from cashier_profiles where id = p_profile and tenant_id = v_tenant and deleted_at is null) then
    raise exception 'profile_not_found';
  end if;
  return null;
end;
$$;
revoke all on function staff_assert_can_manage(uuid, uuid) from public, anon, authenticated;

create or replace function staff_set_status(
  p_user    uuid,
  p_profile uuid,
  p_kind    text,
  p_subtype text default null,
  p_from    date default null,
  p_until   date default null,
  p_reason  text default null,
  p_notes   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_today   date := branch_today();
  v_kind    text := lower(btrim(coalesce(p_kind, '')));
  v_sub     text := nullif(lower(btrim(coalesce(p_subtype, ''))), '');
  v_from    date := coalesce(p_from, branch_today());
  v_until   date := p_until;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_notes   text := nullif(btrim(coalesce(p_notes, '')), '');
  v_id      uuid;
  v_cur     text;
begin
  if not tenant_has_feature_for(v_tenant, 'personal_estados') then
    raise exception 'feature_not_in_plan: personal_estados' using errcode = 'check_violation';
  end if;
  perform staff_assert_can_manage(p_user, p_profile);
  if v_kind not in ('suspension', 'leave', 'termination') then raise exception 'invalid_kind'; end if;
  if v_from < v_today then raise exception 'date_in_past'; end if;
  if v_until is not null and v_until < v_from then raise exception 'invalid_dates'; end if;
  if v_kind = 'termination' then v_until := null; end if;
  if v_kind in ('suspension', 'termination') and (v_reason is null or length(v_reason) < 3) then
    raise exception 'reason_required';
  end if;
  if v_kind = 'leave' and v_sub is null then v_sub := 'otra'; end if;
  if v_kind = 'termination' and v_sub is null then raise exception 'subtype_required'; end if;
  if v_kind = 'suspension' then v_sub := null; end if;

  perform staff_sync_due();

  v_cur := staff_effective_status(v_tenant, p_user, p_profile, v_from);
  if v_cur = 'terminated' then raise exception 'staff_terminated'; end if;
  -- No se apilan dos eventos del mismo tipo que se pisen.
  if exists (
    select 1 from staff_status_events e
     where e.tenant_id = v_tenant and e.deleted_at is null and e.kind = v_kind
       and ((p_user is not null and e.user_id = p_user)
            or (p_profile is not null and e.cashier_profile_id = p_profile))
       and e.starts_on <= coalesce(v_until, 'infinity'::date)
       and coalesce(e.ends_on, 'infinity'::date) >= v_from
  ) then
    raise exception 'status_overlap';
  end if;

  insert into staff_status_events
    (tenant_id, user_id, cashier_profile_id, kind, subtype, starts_on, ends_on, reason, notes, created_by)
  values
    (v_tenant, p_user, p_profile, v_kind, v_sub, v_from, v_until, v_reason, v_notes, auth.uid())
  returning id into v_id;

  if v_kind = 'termination' and v_from <= v_today then
    if p_user is not null then
      update tenant_users set status = 'inactive' where tenant_id = v_tenant and user_id = p_user;
      perform staff_revoke_access(v_tenant, p_user);
    end if;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'staff_status_events', v_id,
          case v_kind when 'suspension' then 'staff_suspended'
                      when 'leave' then 'staff_leave_scheduled'
                      else 'staff_terminated' end,
          v_reason,
          jsonb_build_object('user_id', p_user, 'cashier_profile_id', p_profile, 'kind', v_kind,
                             'subtype', v_sub, 'from', v_from, 'until', v_until, 'notes', v_notes));
  return v_id;
end;
$$;
revoke all on function staff_set_status(uuid, uuid, text, text, date, date, text, text) from public, anon;
grant execute on function staff_set_status(uuid, uuid, text, text, date, date, text, text) to authenticated;

-- Levanta (vigente: termina ayer) o cancela (programado) una suspensión o
-- licencia. La baja se revierte con staff_rehire.
create or replace function staff_end_status(p_event_id uuid, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_today  date := branch_today();
  v_ev     staff_status_events%rowtype;
  v_res    text;
begin
  select * into v_ev from staff_status_events
   where id = p_event_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then raise exception 'event_not_found'; end if;
  perform staff_assert_can_manage(v_ev.user_id, v_ev.cashier_profile_id);
  if v_ev.kind = 'termination' then raise exception 'use_rehire'; end if;
  if v_ev.kind = 'rehire' then raise exception 'invalid_kind'; end if;
  if v_ev.ends_on is not null and v_ev.ends_on < v_today then raise exception 'already_ended'; end if;

  if v_ev.starts_on >= v_today then
    update staff_status_events
       set deleted_at = now(), cancelled_by = auth.uid(), cancel_reason = nullif(btrim(coalesce(p_reason, '')), '')
     where id = v_ev.id;
    v_res := 'cancelled';
  else
    update staff_status_events
       set ends_on = v_today - 1, ended_by = auth.uid(), ended_at = now(),
           cancel_reason = nullif(btrim(coalesce(p_reason, '')), '')
     where id = v_ev.id;
    v_res := 'ended';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'staff_status_events', v_ev.id,
          case when v_res = 'cancelled' then 'staff_status_cancelled' else 'staff_status_lifted' end,
          nullif(btrim(coalesce(p_reason, '')), ''),
          jsonb_build_object('user_id', v_ev.user_id, 'cashier_profile_id', v_ev.cashier_profile_id,
                             'kind', v_ev.kind, 'result', v_res));
  return v_res;
end;
$$;
revoke all on function staff_end_status(uuid, text) from public, anon;
grant execute on function staff_end_status(uuid, text) to authenticated;

-- Reingreso de alguien dado de baja: corta la baja, vuelve a 'active' (con
-- rol opcional), restaura el negocio activo y, si se indica, le asigna una
-- sucursal base desde hoy. Respeta el cupo de usuarios del plan.
create or replace function staff_rehire(
  p_user     uuid,
  p_profile  uuid,
  p_role     text default null,
  p_store_id uuid default null,
  p_reason   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_today  date := branch_today();
  v_ev     staff_status_events%rowtype;
  v_role   text := nullif(lower(btrim(coalesce(p_role, ''))), '');
  v_max    numeric;
  v_active int;
  v_id     uuid;
  v_live   int;
begin
  perform staff_assert_can_manage(p_user, p_profile);
  if v_role is not null and v_role not in ('manager', 'cashier', 'viewer') then raise exception 'invalid_role'; end if;
  if v_role = 'manager' and not is_tenant_owner() then raise exception 'forbidden_role' using errcode = '42501'; end if;

  select * into v_ev from staff_status_events e
   where e.tenant_id = v_tenant and e.deleted_at is null and e.kind = 'termination'
     and ((p_user is not null and e.user_id = p_user) or (p_profile is not null and e.cashier_profile_id = p_profile))
     and (e.ends_on is null or e.ends_on >= v_today)
   order by e.starts_on desc
   limit 1
   for update;
  if not found then raise exception 'not_terminated'; end if;

  if p_user is not null then
    v_max := tenant_limit_for(v_tenant, 'max_users');
    select count(*) into v_active from tenant_users where tenant_id = v_tenant and status = 'active';
    if v_max is not null and v_active >= v_max then
      raise exception 'limit_reached: max_users' using errcode = 'check_violation';
    end if;
  end if;

  if v_ev.starts_on >= v_today then
    update staff_status_events set deleted_at = now(), cancelled_by = auth.uid(),
           cancel_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Reingreso')
     where id = v_ev.id;
  else
    update staff_status_events set ends_on = v_today - 1, ended_by = auth.uid(), ended_at = now()
     where id = v_ev.id;
  end if;

  insert into staff_status_events (tenant_id, user_id, cashier_profile_id, kind, starts_on, reason, created_by)
  values (v_tenant, p_user, p_profile, 'rehire', v_today, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  returning id into v_id;

  if p_user is not null then
    update tenant_users
       set status = 'active', role = coalesce(v_role, role), joined_at = now()
     where tenant_id = v_tenant and user_id = p_user;
    perform staff_grant_access(v_tenant, p_user);
  end if;

  if p_store_id is not null then
    select count(*) into v_live from stores where tenant_id = v_tenant and deleted_at is null;
    if v_live > 1 then
      perform staff_branch_schedule(p_store_id, 'home', p_user, p_profile, v_today, null, v_role, 'Reingreso');
    end if;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'staff_status_events', v_id, 'staff_rehired',
          nullif(btrim(coalesce(p_reason, '')), ''),
          jsonb_build_object('user_id', p_user, 'cashier_profile_id', p_profile, 'role', v_role,
                             'store_id', p_store_id, 'termination_id', v_ev.id));
  return v_id;
end;
$$;
revoke all on function staff_rehire(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function staff_rehire(uuid, uuid, text, uuid, text) to authenticated;

-- Tablero: personas del negocio (usuarios y perfiles sin cuenta) con su estado
-- efectivo de hoy. Usuarios: dueño o encargado ven a todos; el resto, sólo a
-- sí mismo (y la lista de nombres sin detalle de estado).
create or replace function staff_people()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_mgr    boolean := is_tenant_manager();
begin
  if v_tenant is null then return '[]'::jsonb; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid() and status = 'active')
     and not is_internal() then
    return '[]'::jsonb;
  end if;
  if v_mgr then perform staff_sync_due(); end if;
  return coalesce((
    select jsonb_agg(x order by x ->> 'sort_key')
      from (
        select jsonb_build_object(
                 'kind', 'user',
                 'user_id', tu.user_id,
                 'profile_id', null,
                 'name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email, 'Miembro'),
                 'email', u.email,
                 'avatar', tu.avatar,
                 'role', tu.role,
                 'membership_status', tu.status,
                 'joined_at', tu.joined_at,
                 'state', case when v_mgr or tu.user_id = auth.uid()
                               then staff_status_detail(v_tenant, tu.user_id, null, null)
                               else jsonb_build_object('status', 'active') end,
                 'sort_key', (case tu.role when 'owner' then '0' when 'manager' then '1' else '2' end)
                             || lower(coalesce(nullif(tu.display_name, ''), u.full_name, u.email, ''))) as x
          from tenant_users tu
          join public.users u on u.id = tu.user_id
         where tu.tenant_id = v_tenant
        union all
        select jsonb_build_object(
                 'kind', 'profile',
                 'user_id', null,
                 'profile_id', cp.id,
                 'name', cp.display_name,
                 'email', null,
                 'avatar', cp.avatar,
                 'role', null,
                 'membership_status', cp.status,
                 'joined_at', cp.created_at,
                 'state', case when v_mgr then staff_status_detail(v_tenant, null, cp.id, null)
                               else jsonb_build_object('status', 'active') end,
                 'sort_key', '3' || lower(cp.display_name))
          from cashier_profiles cp
         where cp.tenant_id = v_tenant and cp.deleted_at is null
      ) s), '[]'::jsonb);
end;
$$;
revoke all on function staff_people() from public, anon;
grant execute on function staff_people() to authenticated;
