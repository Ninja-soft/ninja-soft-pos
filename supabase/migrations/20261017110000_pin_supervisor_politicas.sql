-- =============================================================================
-- 20261017110000_pin_supervisor_politicas  (F17 · H116 · ADR-051)
--
-- PIN de supervisor general (antes sólo existía para cuenta corriente y
-- gateado por esa feature) y políticas por acción:
--
--   A) security_settings (una fila por negocio): qué acciones piden PIN y desde
--      qué umbral, qué roles y usuarios pueden autorizar, intentos y minutos de
--      bloqueo, rotación del PIN y caja compartida (flag operativo).
--   B) PIN: misma tabla account_supervisor_pins (los PIN cargados siguen
--      valiendo; las RPC account_* no cambian) + pin_set_at para la rotación.
--      RPC supervisor_pin_status / supervisor_set_pin / supervisor_clear_pin /
--      supervisor_list / supervisor_authorize.
--   C) Autorización de un solo uso: supervisor_authorize devuelve un token
--      atado a acción, cajero y monto, que vence a los 5 minutos. El cliente lo
--      manda en el header `x-ninja-supervisor-token`; require_supervisor() lo
--      consume desde los triggers (migraciones 120000 y 130000) sin cambiar la
--      firma de ninguna RPC. Quien ya es supervisor actúa con su sesión.
--
-- Por defecto TODAS las acciones están apagadas salvo el cierre forzado de un
-- turno ajeno (nuevo): ningún flujo existente cambia hasta que el dueño las
-- active. Feature BASE `pin_supervisor`.
-- =============================================================================

create extension if not exists pgcrypto;

insert into features (key, label, description, grupo, is_basic, sort) values
  ('pin_supervisor', 'PIN de supervisor',
   'Autorización con PIN para anulaciones, devoluciones, retiros, descuentos y cierres forzados', 'ventas', true, 75)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('pin_supervisor', true), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'pin_supervisor');

-- -----------------------------------------------------------------------------
-- A) Política de seguridad por negocio
-- -----------------------------------------------------------------------------
create or replace function security_default_policy()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'discount_over',     jsonb_build_object('enabled', false, 'threshold', 20),
    'sale_void',         jsonb_build_object('enabled', false, 'threshold', 0),
    'sale_return',       jsonb_build_object('enabled', false, 'threshold', 0),
    'cash_out',          jsonb_build_object('enabled', false, 'threshold', 0),
    'cash_in',           jsonb_build_object('enabled', false, 'threshold', 0),
    'shift_force_close', jsonb_build_object('enabled', true,  'threshold', 0));
$$;

create table if not exists security_settings (
  tenant_id           uuid primary key default current_tenant_id() references tenants(id) on delete cascade,
  pin_policy          jsonb not null default security_default_policy(),
  supervisor_roles    text[] not null default array['owner', 'manager'],
  supervisor_user_ids uuid[] not null default '{}',
  pin_max_attempts    int not null default 5 check (pin_max_attempts between 3 and 10),
  pin_lock_minutes    int not null default 15 check (pin_lock_minutes between 1 and 1440),
  pin_rotation_days   int check (pin_rotation_days is null or pin_rotation_days between 30 and 365),
  shared_shift        boolean not null default false,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.users(id),
  constraint security_roles_chk check (supervisor_roles <@ array['owner', 'manager', 'cashier'])
);

alter table security_settings enable row level security;
drop policy if exists security_settings_select on security_settings;
-- La política la lee todo el negocio (el POS necesita saber cuándo pedir PIN).
create policy security_settings_select on security_settings
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
-- Sin policies de escritura: security_settings_save().

-- Configuración efectiva (con defaults si el negocio no guardó nada).
create or replace function security_effective(p_tenant uuid)
returns security_settings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v security_settings%rowtype;
begin
  select * into v from security_settings where tenant_id = p_tenant;
  if not found then
    v.tenant_id := p_tenant;
    v.pin_policy := security_default_policy();
    v.supervisor_roles := array['owner', 'manager'];
    v.supervisor_user_ids := '{}';
    v.pin_max_attempts := 5;
    v.pin_lock_minutes := 15;
    v.pin_rotation_days := null;
    v.shared_shift := false;
  else
    -- Acciones nuevas que la fila guardada todavía no tiene.
    v.pin_policy := security_default_policy() || coalesce(v.pin_policy, '{}'::jsonb);
  end if;
  return v;
end;
$$;
revoke all on function security_effective(uuid) from public, anon, authenticated;

create or replace function security_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v security_settings%rowtype;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  v := security_effective(v_tenant);
  return jsonb_build_object(
    'pin_policy', v.pin_policy,
    'supervisor_roles', to_jsonb(v.supervisor_roles),
    'supervisor_user_ids', to_jsonb(v.supervisor_user_ids),
    'pin_max_attempts', v.pin_max_attempts,
    'pin_lock_minutes', v.pin_lock_minutes,
    'pin_rotation_days', v.pin_rotation_days,
    'shared_shift', v.shared_shift,
    'updated_at', v.updated_at);
end;
$$;
revoke all on function security_settings_get() from public, anon;
grant execute on function security_settings_get() to authenticated;

-- Sólo el dueño cambia la política. Validación estricta de cada acción.
create or replace function security_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_before  security_settings%rowtype;
  v_policy  jsonb := '{}'::jsonb;
  v_key     text;
  v_val     jsonb;
  v_thr     numeric;
  v_roles   text[];
  v_users   uuid[];
  v_rot     int;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not tenant_has_feature_for(v_tenant, 'pin_supervisor') then
    raise exception 'feature_not_in_plan: pin_supervisor' using errcode = 'check_violation';
  end if;
  v_before := security_effective(v_tenant);

  for v_key, v_val in select * from jsonb_each(coalesce(p -> 'pin_policy', v_before.pin_policy)) loop
    if not (security_default_policy() ? v_key) then raise exception 'invalid_action: %', v_key; end if;
    v_thr := coalesce((v_val ->> 'threshold')::numeric, 0);
    if v_thr < 0 or (v_key = 'discount_over' and v_thr > 100) then raise exception 'invalid_threshold'; end if;
    v_policy := v_policy || jsonb_build_object(v_key, jsonb_build_object(
      'enabled', case when v_key = 'shift_force_close' then true
                      else coalesce((v_val ->> 'enabled')::boolean, false) end,
      'threshold', v_thr));
  end loop;

  v_roles := v_before.supervisor_roles;
  if p ? 'supervisor_roles' then
    v_roles := array(select jsonb_array_elements_text(p -> 'supervisor_roles'));
  end if;
  if not ('owner' = any (v_roles)) then v_roles := v_roles || array['owner']; end if;
  if not (v_roles <@ array['owner', 'manager', 'cashier']) then raise exception 'invalid_roles'; end if;

  v_users := v_before.supervisor_user_ids;
  if p ? 'supervisor_user_ids' then
    v_users := array(select (jsonb_array_elements_text(p -> 'supervisor_user_ids'))::uuid);
    if exists (select 1 from unnest(v_users) u(id)
                where not exists (select 1 from tenant_users tu where tu.tenant_id = v_tenant and tu.user_id = u.id)) then
      raise exception 'member_not_found';
    end if;
  end if;

  v_rot := case when p ? 'pin_rotation_days' then nullif(p ->> 'pin_rotation_days', '')::int else v_before.pin_rotation_days end;

  insert into security_settings as s
    (tenant_id, pin_policy, supervisor_roles, supervisor_user_ids, pin_max_attempts, pin_lock_minutes,
     pin_rotation_days, shared_shift, updated_at, updated_by)
  values
    (v_tenant, v_policy, v_roles, v_users,
     coalesce((p ->> 'pin_max_attempts')::int, v_before.pin_max_attempts),
     coalesce((p ->> 'pin_lock_minutes')::int, v_before.pin_lock_minutes),
     v_rot,
     coalesce((p ->> 'shared_shift')::boolean, v_before.shared_shift),
     now(), auth.uid())
  on conflict (tenant_id) do update
    set pin_policy = excluded.pin_policy,
        supervisor_roles = excluded.supervisor_roles,
        supervisor_user_ids = excluded.supervisor_user_ids,
        pin_max_attempts = excluded.pin_max_attempts,
        pin_lock_minutes = excluded.pin_lock_minutes,
        pin_rotation_days = excluded.pin_rotation_days,
        shared_shift = excluded.shared_shift,
        updated_at = now(),
        updated_by = auth.uid();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'security_settings', v_tenant, 'security_settings_changed',
          jsonb_build_object('pin_policy', v_before.pin_policy, 'supervisor_roles', v_before.supervisor_roles,
                             'supervisor_user_ids', v_before.supervisor_user_ids,
                             'pin_max_attempts', v_before.pin_max_attempts, 'pin_lock_minutes', v_before.pin_lock_minutes,
                             'pin_rotation_days', v_before.pin_rotation_days, 'shared_shift', v_before.shared_shift),
          jsonb_build_object('pin_policy', v_policy, 'supervisor_roles', v_roles, 'supervisor_user_ids', v_users,
                             'pin_max_attempts', coalesce((p ->> 'pin_max_attempts')::int, v_before.pin_max_attempts),
                             'pin_lock_minutes', coalesce((p ->> 'pin_lock_minutes')::int, v_before.pin_lock_minutes),
                             'pin_rotation_days', v_rot,
                             'shared_shift', coalesce((p ->> 'shared_shift')::boolean, v_before.shared_shift)));
  return security_settings_get();
end;
$$;
revoke all on function security_settings_save(jsonb) from public, anon;
grant execute on function security_settings_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Supervisores y PIN
-- -----------------------------------------------------------------------------
alter table account_supervisor_pins add column if not exists pin_set_at timestamptz;
update account_supervisor_pins set pin_set_at = coalesce(pin_set_at, updated_at, created_at) where pin_set_at is null;
alter table account_supervisor_pins alter column pin_set_at set default now();

-- ¿p_user puede autorizar en p_tenant? Activo, operativo y con rol o elegido.
create or replace function is_supervisor(p_tenant uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v      security_settings%rowtype;
begin
  select role into v_role from tenant_users
   where tenant_id = p_tenant and user_id = p_user and status = 'active';
  if v_role is null then return false; end if;
  if v_role = 'owner' then return true; end if;
  if staff_effective_status(p_tenant, p_user, null, null) <> 'active' then return false; end if;
  v := security_effective(p_tenant);
  return v_role = any (v.supervisor_roles) or p_user = any (v.supervisor_user_ids);
end;
$$;
revoke all on function is_supervisor(uuid, uuid) from public, anon, authenticated;

create or replace function supervisor_pin_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_row    account_supervisor_pins%rowtype;
  v        security_settings%rowtype;
  v_exp    timestamptz;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  v := security_effective(v_tenant);
  select * into v_row from account_supervisor_pins where tenant_id = v_tenant and user_id = auth.uid();
  if found and v.pin_rotation_days is not null then
    v_exp := coalesce(v_row.pin_set_at, v_row.updated_at) + make_interval(days => v.pin_rotation_days);
  end if;
  return jsonb_build_object(
    'can_have_pin', is_supervisor(v_tenant, auth.uid()),
    'has_pin', v_row.id is not null,
    'set_at', coalesce(v_row.pin_set_at, v_row.updated_at),
    'expires_at', v_exp,
    'expired', v_exp is not null and v_exp < now(),
    'locked_until', case when v_row.locked_until > now() then v_row.locked_until end);
end;
$$;
revoke all on function supervisor_pin_status() from public, anon;
grant execute on function supervisor_pin_status() to authenticated;

create or replace function supervisor_set_pin(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_had    boolean;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not tenant_has_feature_for(v_tenant, 'pin_supervisor') then
    raise exception 'feature_not_in_plan: pin_supervisor' using errcode = 'check_violation';
  end if;
  if not is_supervisor(v_tenant, auth.uid()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then raise exception 'invalid_pin'; end if;
  if account_pin_is_weak(p_pin) then raise exception 'weak_pin'; end if;
  v_had := exists (select 1 from account_supervisor_pins where tenant_id = v_tenant and user_id = auth.uid());
  insert into account_supervisor_pins (tenant_id, user_id, pin_hash, pin_set_at)
  values (v_tenant, auth.uid(), crypt(p_pin, gen_salt('bf', 8)), now())
  on conflict (tenant_id, user_id) do update
    set pin_hash = excluded.pin_hash, fail_count = 0, fail_window_start = null,
        locked_until = null, updated_at = now(), pin_set_at = now();
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', auth.uid(),
          case when v_had then 'supervisor_pin_changed' else 'supervisor_pin_set' end,
          jsonb_build_object('supervisor_id', auth.uid()));
  return supervisor_pin_status();
end;
$$;
revoke all on function supervisor_set_pin(text) from public, anon;
grant execute on function supervisor_set_pin(text) to authenticated;

-- Borra el PIN propio, o el de otro (sólo el dueño; p. ej. alguien que se fue).
-- También desbloquea: borrar y volver a cargar.
create or replace function supervisor_clear_pin(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_target uuid := coalesce(p_user_id, auth.uid());
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if v_target <> auth.uid() and not is_tenant_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from account_supervisor_pins where tenant_id = v_tenant and user_id = v_target;
  if found then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'users', v_target, 'supervisor_pin_cleared',
            jsonb_build_object('supervisor_id', v_target));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function supervisor_clear_pin(uuid) from public, anon;
grant execute on function supervisor_clear_pin(uuid) to authenticated;

-- Quiénes pueden autorizar hoy (con PIN vigente). Lo usa el diálogo de PIN.
-- Al dueño le devuelve también los que no cargaron PIN (para el panel).
create or replace function supervisor_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v        security_settings%rowtype;
  v_owner  boolean := is_tenant_owner();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  v := security_effective(v_tenant);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', tu.user_id,
             'name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email, 'Sin nombre'),
             'avatar', tu.avatar,
             'role', tu.role,
             'has_pin', p.id is not null,
             'pin_set_at', coalesce(p.pin_set_at, p.updated_at),
             'expired', v.pin_rotation_days is not null and p.id is not null
                        and coalesce(p.pin_set_at, p.updated_at) + make_interval(days => v.pin_rotation_days) < now(),
             'locked', coalesce(p.locked_until > now(), false))
             order by case tu.role when 'owner' then 0 when 'manager' then 1 else 2 end,
                      coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email))
      from tenant_users tu
      join public.users u on u.id = tu.user_id
      left join account_supervisor_pins p on p.tenant_id = tu.tenant_id and p.user_id = tu.user_id
     where tu.tenant_id = v_tenant
       and tu.status = 'active'
       and is_supervisor(v_tenant, tu.user_id)
       and (v_owner or p.id is not null)), '[]'::jsonb);
end;
$$;
revoke all on function supervisor_list() from public, anon;
grant execute on function supervisor_list() to authenticated;

-- -----------------------------------------------------------------------------
-- C) Tokens de autorización
-- -----------------------------------------------------------------------------
create table if not exists supervisor_auth_tokens (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  action        text not null,
  supervisor_id uuid not null references public.users(id),
  requested_by  uuid references public.users(id),
  amount        numeric(14,2),
  ref_id        uuid,
  reason        text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  consumed_ref  uuid
);
create index if not exists sat_tenant_idx on supervisor_auth_tokens (tenant_id, created_at desc);
alter table supervisor_auth_tokens enable row level security;
revoke all on supervisor_auth_tokens from anon, authenticated;

-- ¿La acción pide PIN para ese monto? (discount_over: porcentaje > umbral;
-- montos: >= umbral; shift_force_close: siempre.)
create or replace function pin_action_required(p_tenant uuid, p_action text, p_amount numeric)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v   security_settings%rowtype;
  v_a jsonb;
  v_t numeric;
begin
  if p_action = 'shift_force_close' then return true; end if;
  v := security_effective(p_tenant);
  v_a := v.pin_policy -> p_action;
  if v_a is null or not coalesce((v_a ->> 'enabled')::boolean, false) then return false; end if;
  v_t := coalesce((v_a ->> 'threshold')::numeric, 0);
  if p_action = 'discount_over' then
    return coalesce(p_amount, 0) > v_t + 0.001;
  end if;
  return coalesce(p_amount, 0) >= v_t;
end;
$$;
revoke all on function pin_action_required(uuid, text, numeric) from public, anon;
grant execute on function pin_action_required(uuid, text, numeric) to authenticated;

create or replace function supervisor_authorize(
  p_action        text,
  p_supervisor_id uuid,
  p_pin           text,
  p_amount        numeric default null,
  p_reason        text default null,
  p_ref           uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v         security_settings%rowtype;
  v_pin     account_supervisor_pins%rowtype;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_token   uuid;
  v_expires timestamptz := now() + interval '5 minutes';
  v_left    int;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not tenant_has_feature_for(v_tenant, 'pin_supervisor') then
    raise exception 'feature_not_in_plan: pin_supervisor' using errcode = 'check_violation';
  end if;
  if not (security_default_policy() ? p_action) then raise exception 'invalid_action'; end if;
  if p_action in ('sale_void', 'sale_return', 'cash_out', 'shift_force_close')
     and (v_reason is null or length(v_reason) < 3) then
    raise exception 'override_reason_required';
  end if;
  if not is_supervisor(v_tenant, p_supervisor_id) then raise exception 'supervisor_not_found'; end if;
  v := security_effective(v_tenant);

  select * into v_pin from account_supervisor_pins
   where tenant_id = v_tenant and user_id = p_supervisor_id
   for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'pin_not_set'); end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'pin_locked', 'locked_until', v_pin.locked_until);
  end if;
  if v.pin_rotation_days is not null
     and coalesce(v_pin.pin_set_at, v_pin.updated_at) + make_interval(days => v.pin_rotation_days) < now() then
    return jsonb_build_object('ok', false, 'error', 'pin_expired');
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' or crypt(p_pin, v_pin.pin_hash) <> v_pin.pin_hash then
    if v_pin.fail_window_start is null or v_pin.fail_window_start < now() - make_interval(mins => v.pin_lock_minutes) then
      v_pin.fail_window_start := now();
      v_pin.fail_count := 1;
    else
      v_pin.fail_count := v_pin.fail_count + 1;
    end if;
    v_left := greatest(v.pin_max_attempts - v_pin.fail_count, 0);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'users', p_supervisor_id, 'supervisor_pin_failed',
            jsonb_build_object('supervisor_id', p_supervisor_id, 'requested_by', auth.uid(),
                               'pin_action', p_action, 'amount', p_amount, 'attempt', v_pin.fail_count));
    if v_left = 0 then
      update account_supervisor_pins
         set fail_count = 0, fail_window_start = null,
             locked_until = now() + make_interval(mins => v.pin_lock_minutes), updated_at = now()
       where id = v_pin.id
      returning locked_until into v_pin.locked_until;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, auth.uid(), 'users', p_supervisor_id, 'supervisor_pin_locked',
              jsonb_build_object('supervisor_id', p_supervisor_id, 'requested_by', auth.uid(),
                                 'locked_until', v_pin.locked_until));
      return jsonb_build_object('ok', false, 'error', 'pin_locked', 'locked_until', v_pin.locked_until);
    end if;
    update account_supervisor_pins
       set fail_count = v_pin.fail_count, fail_window_start = v_pin.fail_window_start
     where id = v_pin.id;
    return jsonb_build_object('ok', false, 'error', 'pin_invalid', 'attempts_left', v_left);
  end if;

  update account_supervisor_pins set fail_count = 0, fail_window_start = null, locked_until = null
   where id = v_pin.id;

  insert into supervisor_auth_tokens
    (tenant_id, action, supervisor_id, requested_by, amount, ref_id, reason, expires_at)
  values
    (v_tenant, p_action, p_supervisor_id, auth.uid(), round(coalesce(p_amount, 0), 2), p_ref, v_reason, v_expires)
  returning id into v_token;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'users', p_supervisor_id, 'supervisor_authorized', v_reason,
          jsonb_build_object('supervisor_id', p_supervisor_id, 'requested_by', auth.uid(),
                             'pin_action', p_action, 'amount', p_amount, 'ref_id', p_ref,
                             'token_id', v_token, 'expires_at', v_expires));
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires);
end;
$$;
revoke all on function supervisor_authorize(text, uuid, text, numeric, text, uuid) from public, anon;
grant execute on function supervisor_authorize(text, uuid, text, numeric, text, uuid) to authenticated;

-- Header con el token (null si no vino o no es uuid).
create or replace function request_supervisor_token()
returns uuid
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_txt text;
begin
  v_txt := nullif(current_setting('request.headers', true), '')::json ->> 'x-ninja-supervisor-token';
  if v_txt is null or v_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_txt::uuid;
exception when others then
  return null;
end;
$$;
grant execute on function request_supervisor_token() to authenticated;

-- Exige autorización si la política lo pide. Devuelve el supervisor (el propio
-- usuario si ya es supervisor, el del token si usó PIN) o null si no hacía
-- falta. Errores: 'supervisor_required:<acción>' (el cliente abre el diálogo
-- de PIN y reintenta) y 'supervisor_token_invalid'.
create or replace function require_supervisor(p_action text, p_amount numeric, p_ref uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_token  uuid;
  v_tok    supervisor_auth_tokens%rowtype;
begin
  if v_tenant is null or auth.uid() is null then return null; end if;
  if not pin_action_required(v_tenant, p_action, p_amount) then return null; end if;
  if is_supervisor(v_tenant, auth.uid()) then return auth.uid(); end if;

  v_token := request_supervisor_token();
  if v_token is null then
    raise exception 'supervisor_required:%', p_action using errcode = '42501';
  end if;
  update supervisor_auth_tokens t
     set consumed_at = now(), consumed_ref = p_ref
   where t.id = v_token
     and t.tenant_id = v_tenant
     and t.action = p_action
     and t.requested_by = auth.uid()
     and t.consumed_at is null
     and t.expires_at > now()
     and (p_amount is null or coalesce(t.amount, 0) + 0.001 >= p_amount)
  returning t.* into v_tok;
  if not found then
    raise exception 'supervisor_token_invalid' using errcode = '42501';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'users', v_tok.supervisor_id, 'supervisor_override_used', v_tok.reason,
          jsonb_build_object('pin_action', p_action, 'amount', p_amount, 'supervisor_id', v_tok.supervisor_id,
                             'requested_by', auth.uid(), 'ref_id', p_ref, 'token_id', v_tok.id));
  return v_tok.supervisor_id;
end;
$$;
revoke all on function require_supervisor(text, numeric, uuid) from public, anon;
-- Lo llaman triggers SECURITY INVOKER (necesitan current_user para distinguir
-- el cliente de una RPC). Llamarlo directo no da nada: consume un token propio.
grant execute on function require_supervisor(text, numeric, uuid) to authenticated;
