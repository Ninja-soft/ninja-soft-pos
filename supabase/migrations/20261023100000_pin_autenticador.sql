-- =============================================================================
-- 20261023100000_pin_autenticador  (ADR-060)
--
-- PIN de supervisor tipo autenticador. Además del PIN fijo (ADR-051), cada
-- supervisor puede autorizar con:
--
--   * PIN rotativo: 6 dígitos HMAC-SHA256(secreto, contador) con pasos de N
--     horas (12, 24 o a medida) alineados a la hora argentina (UTC-3). Cambia
--     solo; el supervisor lo ve en "Mis PINes" y se lo pasa al empleado.
--   * PIN de un uso: 6 dígitos al azar generados a pedido, vencen en 1 a 30
--     minutos (tope del dueño), opcionalmente atados a una acción y a un monto
--     máximo, se guardan sólo hasheados y se invalidan al usarse.
--   * App autenticadora (TOTP estándar RFC 6238, HMAC-SHA1, 6 dígitos, paso de
--     30 o 60 s): se enrola con un QR otpauth:// y se confirma con un código.
--
-- Seguridad:
--   * Los secretos viven en supervisor_pin_methods y los hashes en
--     supervisor_one_time_pins, con RLS activa, SIN policies y sin grants: ni el
--     dueño ni el propio supervisor los leen por PostgREST. Todo pasa por RPC
--     SECURITY DEFINER con search_path fijo que sólo le devuelven a cada
--     supervisor SU código actual (el rotativo se calcula en el servidor). El
--     secreto TOTP sale una única vez, al enrolar, hacia el dispositivo del
--     propio supervisor (es inevitable para cargarlo en la app).
--   * supervisor_authorize() (misma firma, el cliente no cambia) acepta los
--     modos permitidos para la acción: PIN de un uso, app (±1 paso, sin
--     repetir un paso ya usado), rotativo (actual y el anterior durante 5
--     minutos) y fijo. Bloqueo tras N fallos por supervisor Y por quien pide
--     (supervisor_pin_guard), tope de 30 intentos por minuto por usuario y
--     auditoría de cada éxito y fallo con el modo.
--   * Política del dueño: modos permitidos del negocio, modo por defecto,
--     período del rotativo, duración máxima del PIN de un uso y modos por acción
--     (p. ej. anulaciones sólo con PIN de un uso), dentro de pin_policy.
--
-- Feature OPTIONAL `pin_autenticador` (Pro, Business, Enterprise). Sin ella
-- sólo vale el PIN fijo (gating en pin_action_modes() y en cada RPC).
-- Requiere pgcrypto (hmac, digest, gen_random_bytes, crypt), ya usada por
-- 20261011200300 y 20261017110000; en Supabase vive en el schema extensions.
-- =============================================================================

create extension if not exists pgcrypto;

insert into features (key, label, description, grupo, is_basic, sort) values
  ('pin_autenticador', 'PIN autenticador',
   'PIN de supervisor rotativo, de un uso o con app autenticadora (Google o Microsoft Authenticator)', 'ventas', false, 76)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('pin_autenticador', p.key <> 'start'), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'pin_autenticador');

-- -----------------------------------------------------------------------------
-- A) Política: modos del negocio
-- -----------------------------------------------------------------------------
alter table security_settings
  add column if not exists pin_modes text[] not null default array['fixed', 'rotating', 'one_time', 'totp'],
  add column if not exists pin_default_mode text not null default 'fixed',
  add column if not exists pin_rotation_hours int not null default 24,
  add column if not exists pin_one_time_max_minutes int not null default 5;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'security_pin_modes_chk') then
    alter table security_settings add constraint security_pin_modes_chk check (
      cardinality(pin_modes) >= 1
      and pin_modes <@ array['fixed', 'rotating', 'one_time', 'totp']
      and pin_default_mode = any (pin_modes)
      and pin_rotation_hours between 1 and 168
      and pin_one_time_max_minutes between 1 and 30);
  end if;
end $$;

-- Copia de 20261017110000 con los campos nuevos de ADR-060.
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
    v.pin_modes := array['fixed', 'rotating', 'one_time', 'totp'];
    v.pin_default_mode := 'fixed';
    v.pin_rotation_hours := 24;
    v.pin_one_time_max_minutes := 5;
  else
    -- Acciones nuevas que la fila guardada todavía no tiene.
    v.pin_policy := security_default_policy() || coalesce(v.pin_policy, '{}'::jsonb);
  end if;
  return v;
end;
$$;
revoke all on function security_effective(uuid) from public, anon, authenticated;

-- Modos que acepta una acción: los del negocio recortados por los de la acción
-- (pin_policy -> acción -> modes). Sin la feature, sólo el PIN fijo.
create or replace function pin_action_modes(p_tenant uuid, p_action text)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v     security_settings%rowtype;
  v_act text[];
  v_out text[];
begin
  if not tenant_has_feature_for(p_tenant, 'pin_autenticador') then
    return array['fixed'];
  end if;
  v := security_effective(p_tenant);
  v_act := array(select jsonb_array_elements_text(
                   case when jsonb_typeof(v.pin_policy -> p_action -> 'modes') = 'array'
                        then v.pin_policy -> p_action -> 'modes' else '[]'::jsonb end));
  if coalesce(cardinality(v_act), 0) = 0 then return v.pin_modes; end if;
  v_out := array(select m from unnest(v.pin_modes) m where m = any (v_act));
  return case when coalesce(cardinality(v_out), 0) = 0 then v.pin_modes else v_out end;
end;
$$;
revoke all on function pin_action_modes(uuid, text) from public, anon;
grant execute on function pin_action_modes(uuid, text) to authenticated;

-- Copia de 20261017110000 con los campos de ADR-060 y la feature.
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
    'pin_modes', to_jsonb(v.pin_modes),
    'pin_default_mode', v.pin_default_mode,
    'pin_rotation_hours', v.pin_rotation_hours,
    'pin_one_time_max_minutes', v.pin_one_time_max_minutes,
    'pin_autenticador', tenant_has_feature_for(v_tenant, 'pin_autenticador'),
    'updated_at', v.updated_at);
end;
$$;
revoke all on function security_settings_get() from public, anon;
grant execute on function security_settings_get() to authenticated;

-- Copia de 20261019100000 (tope de 100 % para cambio_precio) con los modos por
-- acción y los campos de ADR-060.
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
  v_modes   text[];
  v_def     text;
  v_hours   int;
  v_otmax   int;
  v_amodes  text[];
  v_rule    jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not tenant_has_feature_for(v_tenant, 'pin_supervisor') then
    raise exception 'feature_not_in_plan: pin_supervisor' using errcode = 'check_violation';
  end if;
  v_before := security_effective(v_tenant);

  v_modes := v_before.pin_modes;
  if p ? 'pin_modes' then
    if jsonb_typeof(p -> 'pin_modes') <> 'array' then raise exception 'invalid_modes'; end if;
    v_modes := array(select distinct m from jsonb_array_elements_text(p -> 'pin_modes') m order by 1);
  end if;
  if coalesce(cardinality(v_modes), 0) = 0
     or not (v_modes <@ array['fixed', 'rotating', 'one_time', 'totp']) then
    raise exception 'invalid_modes';
  end if;
  v_def := coalesce(nullif(p ->> 'pin_default_mode', ''), v_before.pin_default_mode);
  if not (v_def = any (v_modes)) then raise exception 'invalid_default_mode'; end if;
  v_hours := coalesce((p ->> 'pin_rotation_hours')::int, v_before.pin_rotation_hours);
  if v_hours not between 1 and 168 then raise exception 'invalid_rotation_hours'; end if;
  v_otmax := coalesce((p ->> 'pin_one_time_max_minutes')::int, v_before.pin_one_time_max_minutes);
  if v_otmax not between 1 and 30 then raise exception 'invalid_one_time_minutes'; end if;

  for v_key, v_val in select * from jsonb_each(coalesce(p -> 'pin_policy', v_before.pin_policy)) loop
    if not (security_default_policy() ? v_key) then raise exception 'invalid_action: %', v_key; end if;
    v_thr := coalesce((v_val ->> 'threshold')::numeric, 0);
    if v_thr < 0 or (v_key in ('discount_over', 'cambio_precio') and v_thr > 100) then raise exception 'invalid_threshold'; end if;
    v_rule := jsonb_build_object(
      'enabled', case when v_key = 'shift_force_close' then true
                      else coalesce((v_val ->> 'enabled')::boolean, false) end,
      'threshold', v_thr);
    if jsonb_typeof(v_val -> 'modes') = 'array' then
      v_amodes := array(select distinct m from jsonb_array_elements_text(v_val -> 'modes') m order by 1);
      if not (v_amodes <@ array['fixed', 'rotating', 'one_time', 'totp']) then
        raise exception 'invalid_modes: %', v_key;
      end if;
      if coalesce(cardinality(v_amodes), 0) > 0 then
        if not (v_amodes && v_modes) then raise exception 'invalid_modes: %', v_key; end if;
        v_rule := v_rule || jsonb_build_object('modes', to_jsonb(v_amodes));
      end if;
    end if;
    v_policy := v_policy || jsonb_build_object(v_key, v_rule);
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
     pin_rotation_days, shared_shift, pin_modes, pin_default_mode, pin_rotation_hours, pin_one_time_max_minutes,
     updated_at, updated_by)
  values
    (v_tenant, v_policy, v_roles, v_users,
     coalesce((p ->> 'pin_max_attempts')::int, v_before.pin_max_attempts),
     coalesce((p ->> 'pin_lock_minutes')::int, v_before.pin_lock_minutes),
     v_rot,
     coalesce((p ->> 'shared_shift')::boolean, v_before.shared_shift),
     v_modes, v_def, v_hours, v_otmax,
     now(), auth.uid())
  on conflict (tenant_id) do update
    set pin_policy = excluded.pin_policy,
        supervisor_roles = excluded.supervisor_roles,
        supervisor_user_ids = excluded.supervisor_user_ids,
        pin_max_attempts = excluded.pin_max_attempts,
        pin_lock_minutes = excluded.pin_lock_minutes,
        pin_rotation_days = excluded.pin_rotation_days,
        shared_shift = excluded.shared_shift,
        pin_modes = excluded.pin_modes,
        pin_default_mode = excluded.pin_default_mode,
        pin_rotation_hours = excluded.pin_rotation_hours,
        pin_one_time_max_minutes = excluded.pin_one_time_max_minutes,
        updated_at = now(),
        updated_by = auth.uid();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'security_settings', v_tenant, 'security_settings_changed',
          jsonb_build_object('pin_policy', v_before.pin_policy, 'supervisor_roles', v_before.supervisor_roles,
                             'supervisor_user_ids', v_before.supervisor_user_ids,
                             'pin_max_attempts', v_before.pin_max_attempts, 'pin_lock_minutes', v_before.pin_lock_minutes,
                             'pin_rotation_days', v_before.pin_rotation_days, 'shared_shift', v_before.shared_shift,
                             'pin_modes', v_before.pin_modes, 'pin_default_mode', v_before.pin_default_mode,
                             'pin_rotation_hours', v_before.pin_rotation_hours,
                             'pin_one_time_max_minutes', v_before.pin_one_time_max_minutes),
          jsonb_build_object('pin_policy', v_policy, 'supervisor_roles', v_roles, 'supervisor_user_ids', v_users,
                             'pin_max_attempts', coalesce((p ->> 'pin_max_attempts')::int, v_before.pin_max_attempts),
                             'pin_lock_minutes', coalesce((p ->> 'pin_lock_minutes')::int, v_before.pin_lock_minutes),
                             'pin_rotation_days', v_rot,
                             'shared_shift', coalesce((p ->> 'shared_shift')::boolean, v_before.shared_shift),
                             'pin_modes', v_modes, 'pin_default_mode', v_def,
                             'pin_rotation_hours', v_hours, 'pin_one_time_max_minutes', v_otmax));
  return security_settings_get();
end;
$$;
revoke all on function security_settings_save(jsonb) from public, anon;
grant execute on function security_settings_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Tablas (sin lectura ni escritura desde el cliente)
-- -----------------------------------------------------------------------------
create table if not exists supervisor_pin_methods (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  user_id             uuid not null references public.users(id) on delete cascade,
  rotating_secret     bytea,
  rotating_set_at     timestamptz,
  totp_secret         bytea,
  totp_step           int check (totp_step in (30, 60)),
  totp_confirmed_at   timestamptz,
  totp_last_counter   bigint,
  totp_pending_secret bytea,
  totp_pending_step   int check (totp_pending_step in (30, 60)),
  totp_pending_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, user_id)
);
alter table supervisor_pin_methods enable row level security;
revoke all on supervisor_pin_methods from anon, authenticated;

create table if not exists supervisor_one_time_pins (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  supervisor_id uuid not null references public.users(id) on delete cascade,
  code_salt     bytea not null,
  code_hash     bytea not null,
  action        text,
  max_amount    numeric(14,2) check (max_amount is null or max_amount >= 0),
  note          text check (note is null or length(note) <= 120),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  used_by       uuid references public.users(id),
  used_action   text,
  used_amount   numeric(14,2),
  used_token    uuid,
  revoked_at    timestamptz,
  revoked_by    uuid references public.users(id)
);
create index if not exists sotp_active_idx on supervisor_one_time_pins (tenant_id, supervisor_id, expires_at)
  where used_at is null and revoked_at is null;
create index if not exists sotp_recent_idx on supervisor_one_time_pins (tenant_id, supervisor_id, created_at desc);
alter table supervisor_one_time_pins enable row level security;
revoke all on supervisor_one_time_pins from anon, authenticated;

-- Fallos, bloqueo y ritmo, por supervisor y por quien pide la autorización.
create table if not exists supervisor_pin_guard (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  subject_kind       text not null check (subject_kind in ('supervisor', 'requester')),
  subject_id         uuid not null,
  fail_count         int not null default 0,
  fail_window_start  timestamptz,
  locked_until       timestamptz,
  calls              int not null default 0,
  calls_window_start timestamptz,
  updated_at         timestamptz not null default now(),
  unique (tenant_id, subject_kind, subject_id)
);
alter table supervisor_pin_guard enable row level security;
revoke all on supervisor_pin_guard from anon, authenticated;

alter table supervisor_auth_tokens add column if not exists auth_mode text;

-- -----------------------------------------------------------------------------
-- C) OTP: HOTP (RFC 4226), base32 (RFC 4648) y contadores
-- -----------------------------------------------------------------------------
create or replace function otp_hotp(p_secret bytea, p_counter bigint, p_algo text default 'sha1', p_digits int default 6)
returns text
language plpgsql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
declare
  h   bytea;
  o   int;
  bin bigint;
begin
  if p_algo not in ('sha1', 'sha256') or p_digits not between 6 and 8 or p_counter < 0 then
    raise exception 'otp_invalid_args';
  end if;
  h := hmac(int8send(p_counter), p_secret, p_algo);
  o := get_byte(h, length(h) - 1) & 15;
  bin := ((get_byte(h, o) & 127)::bigint << 24)
       | (get_byte(h, o + 1)::bigint << 16)
       | (get_byte(h, o + 2)::bigint << 8)
       |  get_byte(h, o + 3)::bigint;
  return lpad((bin % (10::bigint ^ p_digits)::bigint)::text, p_digits, '0');
end;
$$;
revoke all on function otp_hotp(bytea, bigint, text, int) from public, anon, authenticated;

create or replace function otp_base32(p bytea)
returns text
language plpgsql
immutable
strict
set search_path = public, pg_temp
as $$
declare
  a    constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  buf  bigint := 0;
  bits int := 0;
  out  text := '';
  i    int;
begin
  for i in 0 .. length(p) - 1 loop
    buf := (buf << 8) | get_byte(p, i);
    bits := bits + 8;
    while bits >= 5 loop
      out := out || substr(a, ((buf >> (bits - 5)) & 31)::int + 1, 1);
      bits := bits - 5;
    end loop;
    buf := buf & ((1::bigint << bits) - 1);
  end loop;
  if bits > 0 then
    out := out || substr(a, ((buf << (5 - bits)) & 31)::int + 1, 1);
  end if;
  return out;
end;
$$;
revoke all on function otp_base32(bytea) from public, anon, authenticated;

-- Contador del PIN rotativo: pasos de p_hours alineados a la hora argentina.
create or replace function otp_rotating_counter(p_at timestamptz, p_hours int)
returns bigint
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select floor((extract(epoch from p_at) - 10800) / (p_hours * 3600))::bigint;
$$;
revoke all on function otp_rotating_counter(timestamptz, int) from public, anon, authenticated;

create or replace function otp_rotating_start(p_counter bigint, p_hours int)
returns timestamptz
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select to_timestamp(p_counter * p_hours * 3600 + 10800);
$$;
revoke all on function otp_rotating_start(bigint, int) from public, anon, authenticated;

-- Código al azar de p_digits dígitos (gen_random_bytes; sesgo < 1e-3).
create or replace function otp_random_digits(p_digits int default 6)
returns text
language plpgsql
volatile
set search_path = public, extensions, pg_temp
as $$
declare
  b bytea := gen_random_bytes(6);
  n bigint := 0;
  i int;
begin
  for i in 0 .. 5 loop
    n := (n << 8) | get_byte(b, i);
  end loop;
  return lpad((n % (10::bigint ^ p_digits)::bigint)::text, p_digits, '0');
end;
$$;
revoke all on function otp_random_digits(int) from public, anon, authenticated;

create or replace function otp_one_time_hash(p_salt bytea, p_code text)
returns bytea
language plpgsql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
begin
  return hmac(convert_to(p_code, 'UTF8'), p_salt, 'sha256');
end;
$$;
revoke all on function otp_one_time_hash(bytea, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Guarda de intentos (internas)
-- -----------------------------------------------------------------------------
create or replace function _pin_guard_locked(p_tenant uuid, p_kind text, p_subject uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select g.locked_until from supervisor_pin_guard g
   where g.tenant_id = p_tenant and g.subject_kind = p_kind and g.subject_id = p_subject
     and g.locked_until > now();
$$;
revoke all on function _pin_guard_locked(uuid, text, uuid) from public, anon, authenticated;

-- Suma un fallo; devuelve el bloqueo si llegó al tope (null si no) y los
-- intentos que quedan en after_data.
create or replace function _pin_guard_fail(p_tenant uuid, p_kind text, p_subject uuid, p_max int, p_lock_minutes int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g supervisor_pin_guard%rowtype;
begin
  insert into supervisor_pin_guard (tenant_id, subject_kind, subject_id)
  values (p_tenant, p_kind, p_subject)
  on conflict (tenant_id, subject_kind, subject_id) do nothing;
  select * into g from supervisor_pin_guard
   where tenant_id = p_tenant and subject_kind = p_kind and subject_id = p_subject
   for update;
  if g.fail_window_start is null or g.fail_window_start < now() - make_interval(mins => p_lock_minutes) then
    g.fail_window_start := now();
    g.fail_count := 1;
  else
    g.fail_count := g.fail_count + 1;
  end if;
  if g.fail_count >= p_max then
    update supervisor_pin_guard
       set fail_count = 0, fail_window_start = null,
           locked_until = now() + make_interval(mins => p_lock_minutes), updated_at = now()
     where id = g.id
    returning locked_until into g.locked_until;
    return jsonb_build_object('locked_until', g.locked_until, 'left', 0, 'attempt', p_max);
  end if;
  update supervisor_pin_guard
     set fail_count = g.fail_count, fail_window_start = g.fail_window_start, updated_at = now()
   where id = g.id;
  return jsonb_build_object('locked_until', null, 'left', p_max - g.fail_count, 'attempt', g.fail_count);
end;
$$;
revoke all on function _pin_guard_fail(uuid, text, uuid, int, int) from public, anon, authenticated;

create or replace function _pin_guard_ok(p_tenant uuid, p_kind text, p_subject uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update supervisor_pin_guard
     set fail_count = 0, fail_window_start = null, locked_until = null, updated_at = now()
   where tenant_id = p_tenant and subject_kind = p_kind and subject_id = p_subject
     and (fail_count > 0 or locked_until is not null);
$$;
revoke all on function _pin_guard_ok(uuid, text, uuid) from public, anon, authenticated;

-- Ritmo: false si p_subject hizo más de p_max llamadas en el último minuto.
create or replace function _pin_guard_rate(p_tenant uuid, p_subject uuid, p_max int default 30)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g supervisor_pin_guard%rowtype;
begin
  insert into supervisor_pin_guard (tenant_id, subject_kind, subject_id)
  values (p_tenant, 'requester', p_subject)
  on conflict (tenant_id, subject_kind, subject_id) do nothing;
  select * into g from supervisor_pin_guard
   where tenant_id = p_tenant and subject_kind = 'requester' and subject_id = p_subject
   for update;
  if g.calls_window_start is null or g.calls_window_start < now() - interval '1 minute' then
    update supervisor_pin_guard set calls = 1, calls_window_start = now(), updated_at = now() where id = g.id;
    return true;
  end if;
  update supervisor_pin_guard set calls = g.calls + 1, updated_at = now() where id = g.id;
  return g.calls + 1 <= p_max;
end;
$$;
revoke all on function _pin_guard_rate(uuid, uuid, int) from public, anon, authenticated;

-- ¿El supervisor está bloqueado? (guarda nueva o bloqueo heredado del PIN fijo)
create or replace function supervisor_locked_until(p_tenant uuid, p_user uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(
    _pin_guard_locked(p_tenant, 'supervisor', p_user),
    (select p.locked_until from account_supervisor_pins p
      where p.tenant_id = p_tenant and p.user_id = p_user and p.locked_until > now()));
$$;
revoke all on function supervisor_locked_until(uuid, uuid) from public, anon, authenticated;

-- Modos que el supervisor tiene listos (sin mirar la política de la acción).
create or replace function supervisor_ready_modes(p_tenant uuid, p_user uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select array_remove(array[
    case when exists (select 1 from account_supervisor_pins p where p.tenant_id = p_tenant and p.user_id = p_user)
         then 'fixed' end,
    case when exists (select 1 from supervisor_pin_methods m
                       where m.tenant_id = p_tenant and m.user_id = p_user and m.rotating_secret is not null)
         then 'rotating' end,
    case when exists (select 1 from supervisor_pin_methods m
                       where m.tenant_id = p_tenant and m.user_id = p_user
                         and m.totp_secret is not null and m.totp_confirmed_at is not null)
         then 'totp' end,
    -- El de un uso lo genera cualquier supervisor en el momento.
    'one_time'], null);
$$;
revoke all on function supervisor_ready_modes(uuid, uuid) from public, anon, authenticated;

-- Guardas comunes de las RPC de "Mis PINes".
create or replace function _my_pins_guard(p_mode text)
returns security_settings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v security_settings%rowtype;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if not tenant_has_feature_for(v_tenant, 'pin_supervisor') then
    raise exception 'feature_not_in_plan: pin_supervisor' using errcode = 'check_violation';
  end if;
  if not is_supervisor(v_tenant, auth.uid()) then raise exception 'forbidden' using errcode = '42501'; end if;
  v := security_effective(v_tenant);
  if p_mode is not null then
    if not tenant_has_feature_for(v_tenant, 'pin_autenticador') then
      raise exception 'feature_not_in_plan: pin_autenticador' using errcode = 'check_violation';
    end if;
    if not (p_mode = any (v.pin_modes)) then raise exception 'mode_not_allowed: %', p_mode; end if;
  end if;
  return v;
end;
$$;
revoke all on function _my_pins_guard(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Mis PINes (sólo el propio supervisor)
-- -----------------------------------------------------------------------------
create or replace function supervisor_my_pins()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v        security_settings%rowtype;
  v_m      supervisor_pin_methods%rowtype;
  v_pin    account_supervisor_pins%rowtype;
  v_exp    timestamptz;
  v_feat   boolean;
  v_sup    boolean;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  v := security_effective(v_tenant);
  v_feat := tenant_has_feature_for(v_tenant, 'pin_autenticador');
  v_sup := is_supervisor(v_tenant, auth.uid());
  select * into v_m from supervisor_pin_methods where tenant_id = v_tenant and user_id = auth.uid();
  select * into v_pin from account_supervisor_pins where tenant_id = v_tenant and user_id = auth.uid();
  if v_pin.id is not null and v.pin_rotation_days is not null then
    v_exp := coalesce(v_pin.pin_set_at, v_pin.updated_at) + make_interval(days => v.pin_rotation_days);
  end if;
  return jsonb_build_object(
    'can_have_pin', v_sup,
    'feature', v_feat,
    'modes', to_jsonb(case when v_feat then v.pin_modes else array['fixed'] end),
    'default_mode', case when v_feat then v.pin_default_mode else 'fixed' end,
    'rotation_hours', v.pin_rotation_hours,
    'one_time_max_minutes', v.pin_one_time_max_minutes,
    'locked_until', supervisor_locked_until(v_tenant, auth.uid()),
    'fixed', jsonb_build_object(
      'has_pin', v_pin.id is not null,
      'set_at', coalesce(v_pin.pin_set_at, v_pin.updated_at),
      'expires_at', v_exp,
      'expired', v_exp is not null and v_exp < now()),
    'rotating', jsonb_build_object(
      'enabled', v_m.rotating_secret is not null,
      'set_at', v_m.rotating_set_at),
    'totp', jsonb_build_object(
      'enabled', v_m.totp_secret is not null and v_m.totp_confirmed_at is not null,
      'step', v_m.totp_step,
      'confirmed_at', v_m.totp_confirmed_at,
      'pending', v_m.totp_pending_secret is not null and v_m.totp_pending_at > now() - interval '15 minutes'),
    'one_time_active', (select count(*) from supervisor_one_time_pins o
                         where o.tenant_id = v_tenant and o.supervisor_id = auth.uid()
                           and o.used_at is null and o.revoked_at is null and o.expires_at > now()));
end;
$$;
revoke all on function supervisor_my_pins() from public, anon;
grant execute on function supervisor_my_pins() to authenticated;

create or replace function supervisor_rotating_enable(p_regenerate boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_had    boolean;
begin
  perform _my_pins_guard('rotating');
  select rotating_secret is not null into v_had
    from supervisor_pin_methods where tenant_id = v_tenant and user_id = auth.uid();
  if coalesce(v_had, false) and not coalesce(p_regenerate, false) then return supervisor_my_pins(); end if;
  insert into supervisor_pin_methods (tenant_id, user_id, rotating_secret, rotating_set_at)
  values (v_tenant, auth.uid(), gen_random_bytes(32), now())
  on conflict (tenant_id, user_id) do update
    set rotating_secret = excluded.rotating_secret, rotating_set_at = now(), updated_at = now();
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', auth.uid(),
          case when coalesce(v_had, false) then 'supervisor_rotating_regenerated' else 'supervisor_rotating_enabled' end,
          jsonb_build_object('supervisor_id', auth.uid()));
  return supervisor_my_pins();
end;
$$;
revoke all on function supervisor_rotating_enable(boolean) from public, anon;
grant execute on function supervisor_rotating_enable(boolean) to authenticated;

create or replace function supervisor_rotating_disable()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  perform _my_pins_guard(null);
  update supervisor_pin_methods
     set rotating_secret = null, rotating_set_at = null, updated_at = now()
   where tenant_id = v_tenant and user_id = auth.uid() and rotating_secret is not null;
  if found then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'users', auth.uid(), 'supervisor_rotating_disabled',
            jsonb_build_object('supervisor_id', auth.uid()));
  end if;
  return supervisor_my_pins();
end;
$$;
revoke all on function supervisor_rotating_disable() from public, anon;
grant execute on function supervisor_rotating_disable() to authenticated;

-- El código rotativo vigente, calculado en el servidor, sólo para su dueño.
create or replace function supervisor_rotating_code()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v        security_settings%rowtype;
  v_secret bytea;
  v_ctr    bigint;
begin
  v := _my_pins_guard('rotating');
  select rotating_secret into v_secret
    from supervisor_pin_methods where tenant_id = v_tenant and user_id = auth.uid();
  if v_secret is null then raise exception 'rotating_not_enabled'; end if;
  v_ctr := otp_rotating_counter(now(), v.pin_rotation_hours);
  return jsonb_build_object(
    'code', otp_hotp(v_secret, v_ctr, 'sha256', 6),
    'period_hours', v.pin_rotation_hours,
    'valid_from', otp_rotating_start(v_ctr, v.pin_rotation_hours),
    'valid_until', otp_rotating_start(v_ctr + 1, v.pin_rotation_hours),
    'server_time', now());
end;
$$;
revoke all on function supervisor_rotating_code() from public, anon;
grant execute on function supervisor_rotating_code() to authenticated;

-- Enrolar la app: secreto pendiente hasta confirmar un código. El secreto en
-- base32 se devuelve SÓLO acá (para el QR) y sólo al propio supervisor.
create or replace function supervisor_totp_begin(p_step int default 30)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_secret  bytea := gen_random_bytes(20);
  v_account text;
begin
  perform _my_pins_guard('totp');
  if p_step not in (30, 60) then raise exception 'invalid_step'; end if;
  insert into supervisor_pin_methods (tenant_id, user_id, totp_pending_secret, totp_pending_step, totp_pending_at)
  values (v_tenant, auth.uid(), v_secret, p_step, now())
  on conflict (tenant_id, user_id) do update
    set totp_pending_secret = excluded.totp_pending_secret, totp_pending_step = excluded.totp_pending_step,
        totp_pending_at = now(), updated_at = now();
  select coalesce(nullif(t.name, ''), 'Negocio') || ' (' ||
         coalesce(nullif(u.email, ''), nullif(u.full_name, ''), 'supervisor') || ')'
    into v_account
    from tenants t, public.users u
   where t.id = v_tenant and u.id = auth.uid();
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', auth.uid(), 'supervisor_totp_enroll_started',
          jsonb_build_object('supervisor_id', auth.uid(), 'step', p_step));
  return jsonb_build_object('secret_base32', otp_base32(v_secret), 'step', p_step,
                            'account', coalesce(v_account, 'NinjaSoft'), 'digits', 6, 'algorithm', 'SHA1');
end;
$$;
revoke all on function supervisor_totp_begin(int) from public, anon;
grant execute on function supervisor_totp_begin(int) to authenticated;

create or replace function supervisor_totp_confirm(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_m      supervisor_pin_methods%rowtype;
  v_ctr    bigint;
  v_hit    bigint;
  d        int;
begin
  perform _my_pins_guard('totp');
  if not _pin_guard_rate(v_tenant, auth.uid(), 30) then raise exception 'rate_limited'; end if;
  select * into v_m from supervisor_pin_methods
   where tenant_id = v_tenant and user_id = auth.uid() for update;
  if v_m.totp_pending_secret is null or v_m.totp_pending_at < now() - interval '15 minutes' then
    raise exception 'totp_not_pending';
  end if;
  if p_code is null or p_code !~ '^[0-9]{6}$' then raise exception 'totp_invalid'; end if;
  v_ctr := floor(extract(epoch from now()) / v_m.totp_pending_step)::bigint;
  for d in -1 .. 1 loop
    if otp_hotp(v_m.totp_pending_secret, v_ctr + d, 'sha1', 6) = p_code then
      v_hit := v_ctr + d;
      exit;
    end if;
  end loop;
  if v_hit is null then raise exception 'totp_invalid'; end if;
  update supervisor_pin_methods
     set totp_secret = totp_pending_secret, totp_step = totp_pending_step, totp_confirmed_at = now(),
         totp_last_counter = v_hit, totp_pending_secret = null, totp_pending_step = null,
         totp_pending_at = null, updated_at = now()
   where id = v_m.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', auth.uid(), 'supervisor_totp_enabled',
          jsonb_build_object('supervisor_id', auth.uid(), 'step', v_m.totp_pending_step));
  return supervisor_my_pins();
end;
$$;
revoke all on function supervisor_totp_confirm(text) from public, anon;
grant execute on function supervisor_totp_confirm(text) to authenticated;

create or replace function supervisor_totp_disable()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  perform _my_pins_guard(null);
  update supervisor_pin_methods
     set totp_secret = null, totp_step = null, totp_confirmed_at = null, totp_last_counter = null,
         totp_pending_secret = null, totp_pending_step = null, totp_pending_at = null, updated_at = now()
   where tenant_id = v_tenant and user_id = auth.uid()
     and (totp_secret is not null or totp_pending_secret is not null);
  if found then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'users', auth.uid(), 'supervisor_totp_disabled',
            jsonb_build_object('supervisor_id', auth.uid()));
  end if;
  return supervisor_my_pins();
end;
$$;
revoke all on function supervisor_totp_disable() from public, anon;
grant execute on function supervisor_totp_disable() to authenticated;

-- PIN de un uso: el código sale UNA vez en la respuesta; se guarda el HMAC.
create or replace function supervisor_one_time_create(
  p_minutes    int,
  p_action     text default null,
  p_max_amount numeric default null,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v        security_settings%rowtype;
  v_code   text := otp_random_digits(6);
  v_salt   bytea := gen_random_bytes(16);
  v_id     uuid;
  v_exp    timestamptz;
  v_action text := nullif(btrim(coalesce(p_action, '')), '');
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v := _my_pins_guard('one_time');
  if p_minutes is null or p_minutes < 1 or p_minutes > v.pin_one_time_max_minutes then
    raise exception 'invalid_minutes';
  end if;
  if v_action is not null and not (security_default_policy() ? v_action) then raise exception 'invalid_action'; end if;
  if p_max_amount is not null and p_max_amount < 0 then raise exception 'invalid_amount'; end if;
  if v_note is not null and length(v_note) > 120 then raise exception 'invalid_note'; end if;
  if (select count(*) from supervisor_one_time_pins o
       where o.tenant_id = v_tenant and o.supervisor_id = auth.uid()
         and o.used_at is null and o.revoked_at is null and o.expires_at > now()) >= 20 then
    raise exception 'too_many_active';
  end if;
  v_exp := now() + make_interval(mins => p_minutes);
  insert into supervisor_one_time_pins
    (tenant_id, supervisor_id, code_salt, code_hash, action, max_amount, note, expires_at)
  values
    (v_tenant, auth.uid(), v_salt, otp_one_time_hash(v_salt, v_code), v_action,
     round(p_max_amount, 2), v_note, v_exp)
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', auth.uid(), 'supervisor_one_time_created',
          jsonb_build_object('supervisor_id', auth.uid(), 'one_time_id', v_id, 'pin_action', v_action,
                             'max_amount', p_max_amount, 'minutes', p_minutes, 'expires_at', v_exp));
  return jsonb_build_object('id', v_id, 'code', v_code, 'expires_at', v_exp, 'action', v_action,
                            'max_amount', round(p_max_amount, 2), 'note', v_note);
end;
$$;
revoke all on function supervisor_one_time_create(int, text, numeric, text) from public, anon;
grant execute on function supervisor_one_time_create(int, text, numeric, text) to authenticated;

-- Revocar: el propio supervisor o el dueño.
create or replace function supervisor_one_time_revoke(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_sup    uuid;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  update supervisor_one_time_pins o
     set revoked_at = now(), revoked_by = auth.uid()
   where o.id = p_id and o.tenant_id = v_tenant
     and o.used_at is null and o.revoked_at is null
     and (o.supervisor_id = auth.uid() or is_tenant_owner())
  returning o.supervisor_id into v_sup;
  if not found then raise exception 'not_found'; end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', v_sup, 'supervisor_one_time_revoked',
          jsonb_build_object('supervisor_id', v_sup, 'one_time_id', p_id));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function supervisor_one_time_revoke(uuid) from public, anon;
grant execute on function supervisor_one_time_revoke(uuid) to authenticated;

-- Los PIN de un uso propios (activos y recientes), sin el hash.
create or replace function supervisor_one_time_list(p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', o.id, 'action', o.action, 'max_amount', o.max_amount, 'note', o.note,
             'created_at', o.created_at, 'expires_at', o.expires_at,
             'used_at', o.used_at, 'used_action', o.used_action, 'used_amount', o.used_amount,
             'used_by_name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email),
             'revoked_at', o.revoked_at) order by o.created_at desc)
      from (select * from supervisor_one_time_pins x
             where x.tenant_id = v_tenant and x.supervisor_id = auth.uid()
             order by x.created_at desc
             limit least(greatest(coalesce(p_limit, 30), 1), 100)) o
      left join public.users u on u.id = o.used_by
      left join tenant_users tu on tu.tenant_id = v_tenant and tu.user_id = o.used_by), '[]'::jsonb);
end;
$$;
revoke all on function supervisor_one_time_list(int) from public, anon;
grant execute on function supervisor_one_time_list(int) to authenticated;

-- Historial de mis autorizaciones (quién pidió, qué acción, cuándo, con qué modo).
create or replace function supervisor_my_history(p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'created_at', a.created_at, 'event', a.action,
             'pin_action', a.after_data ->> 'pin_action',
             'amount', a.after_data -> 'amount',
             'auth_mode', a.after_data ->> 'auth_mode',
             'reason', a.reason,
             'requested_by_name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email))
             order by a.created_at desc)
      from (select * from audit_logs l
             where l.tenant_id = v_tenant and l.entity_type = 'users' and l.entity_id = auth.uid()
               and l.action in ('supervisor_authorized', 'supervisor_pin_failed', 'supervisor_pin_locked')
             order by l.created_at desc
             limit least(greatest(coalesce(p_limit, 30), 1), 100)) a
      left join public.users u on u.id = (a.after_data ->> 'requested_by')::uuid
      left join tenant_users tu on tu.tenant_id = v_tenant and tu.user_id = u.id), '[]'::jsonb);
end;
$$;
revoke all on function supervisor_my_history(int) from public, anon;
grant execute on function supervisor_my_history(int) to authenticated;

-- Desbloquear (dueño): supervisor y, como quien pide, la misma persona.
create or replace function supervisor_unlock(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  update supervisor_pin_guard
     set fail_count = 0, fail_window_start = null, locked_until = null, updated_at = now()
   where tenant_id = v_tenant and subject_id = p_user_id;
  update account_supervisor_pins
     set fail_count = 0, fail_window_start = null, locked_until = null
   where tenant_id = v_tenant and user_id = p_user_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', p_user_id, 'supervisor_pin_unlocked',
          jsonb_build_object('supervisor_id', p_user_id));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function supervisor_unlock(uuid) from public, anon;
grant execute on function supervisor_unlock(uuid) to authenticated;

-- Borrar todos los métodos de alguien (dueño, o uno mismo): rotativo, app y
-- PIN de un uso activos. El PIN fijo sigue con supervisor_clear_pin().
create or replace function supervisor_methods_reset(p_user_id uuid default null)
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
  delete from supervisor_pin_methods where tenant_id = v_tenant and user_id = v_target;
  update supervisor_one_time_pins
     set revoked_at = now(), revoked_by = auth.uid()
   where tenant_id = v_tenant and supervisor_id = v_target and used_at is null and revoked_at is null;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', v_target, 'supervisor_methods_reset',
          jsonb_build_object('supervisor_id', v_target));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function supervisor_methods_reset(uuid) from public, anon;
grant execute on function supervisor_methods_reset(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Copias de 20261017110000 con los modos nuevos
-- -----------------------------------------------------------------------------
-- Copia de 20261017110000: el bloqueo también mira la guarda nueva.
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
    'locked_until', supervisor_locked_until(v_tenant, auth.uid()));
end;
$$;
revoke all on function supervisor_pin_status() from public, anon;
grant execute on function supervisor_pin_status() to authenticated;

-- Copia de 20261017110000: borrar el PIN también limpia la guarda nueva.
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
  if is_tenant_owner() then
    update supervisor_pin_guard
       set fail_count = 0, fail_window_start = null, locked_until = null, updated_at = now()
     where tenant_id = v_tenant and subject_kind = 'supervisor' and subject_id = v_target;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function supervisor_clear_pin(uuid) from public, anon;
grant execute on function supervisor_clear_pin(uuid) to authenticated;

-- Copia de 20261017110000: "has_pin" pasa a ser "tiene algún modo listo" y
-- devuelve los modos (el diálogo muestra cómo autoriza cada uno).
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
  v_modes  text[];
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  v := security_effective(v_tenant);
  v_modes := case when tenant_has_feature_for(v_tenant, 'pin_autenticador') then v.pin_modes else array['fixed'] end;
  return coalesce((
    select jsonb_agg(x.j order by x.ord, x.nm)
      from (
        select case tu.role when 'owner' then 0 when 'manager' then 1 else 2 end as ord,
               coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email) as nm,
               jsonb_build_object(
                 'user_id', tu.user_id,
                 'name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email, 'Sin nombre'),
                 'avatar', tu.avatar,
                 'role', tu.role,
                 'has_pin', cardinality(rm.m) > 0,
                 'has_fixed', p.id is not null,
                 'methods', to_jsonb(rm.m),
                 'pin_set_at', coalesce(p.pin_set_at, p.updated_at),
                 'expired', v.pin_rotation_days is not null and p.id is not null
                            and coalesce(p.pin_set_at, p.updated_at) + make_interval(days => v.pin_rotation_days) < now()
                            and cardinality(array_remove(rm.m, 'fixed')) = 0,
                 'locked', supervisor_locked_until(v_tenant, tu.user_id) is not null) as j,
               cardinality(rm.m) > 0 as ready
          from tenant_users tu
          join public.users u on u.id = tu.user_id
          left join account_supervisor_pins p on p.tenant_id = tu.tenant_id and p.user_id = tu.user_id
          cross join lateral (
            select coalesce(array(select m from unnest(supervisor_ready_modes(v_tenant, tu.user_id)) m
                                   where m = any (v_modes)), '{}') as m) rm
         where tu.tenant_id = v_tenant
           and tu.status = 'active'
           and is_supervisor(v_tenant, tu.user_id)) x
     where v_owner or x.ready), '[]'::jsonb);
end;
$$;
revoke all on function supervisor_list() from public, anon;
grant execute on function supervisor_list() to authenticated;

-- -----------------------------------------------------------------------------
-- G) Verificación: supervisor_authorize (misma firma que 20261017110000)
-- -----------------------------------------------------------------------------
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
  v_modes   text[];
  v_feat    boolean;
  v_pin     account_supervisor_pins%rowtype;
  v_m       supervisor_pin_methods%rowtype;
  v_ot      supervisor_one_time_pins%rowtype;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_token   uuid;
  v_expires timestamptz := now() + interval '5 minutes';
  v_lock    timestamptz;
  v_mode    text;
  v_scope   boolean := false;
  v_expired boolean := false;
  v_ready   boolean := false;
  v_ctr     bigint;
  v_start   timestamptz;
  v_g1      jsonb;
  v_g2      jsonb;
  d         int;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
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
  v_feat := tenant_has_feature_for(v_tenant, 'pin_autenticador');
  v_modes := pin_action_modes(v_tenant, p_action);

  -- Ritmo y bloqueos (quien pide y supervisor).
  if not _pin_guard_rate(v_tenant, auth.uid(), 30) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'modes', to_jsonb(v_modes));
  end if;
  v_lock := _pin_guard_locked(v_tenant, 'requester', auth.uid());
  if v_lock is not null then
    return jsonb_build_object('ok', false, 'error', 'requester_locked', 'locked_until', v_lock, 'modes', to_jsonb(v_modes));
  end if;
  v_lock := supervisor_locked_until(v_tenant, p_supervisor_id);
  if v_lock is not null then
    return jsonb_build_object('ok', false, 'error', 'pin_locked', 'locked_until', v_lock, 'modes', to_jsonb(v_modes));
  end if;

  select * into v_pin from account_supervisor_pins
   where tenant_id = v_tenant and user_id = p_supervisor_id;
  select * into v_m from supervisor_pin_methods
   where tenant_id = v_tenant and user_id = p_supervisor_id
   for update;

  v_ready := ('fixed' = any (v_modes) and v_pin.id is not null)
          or (v_feat and 'rotating' = any (v_modes) and v_m.rotating_secret is not null)
          or (v_feat and 'totp' = any (v_modes) and v_m.totp_secret is not null and v_m.totp_confirmed_at is not null)
          or (v_feat and 'one_time' = any (v_modes) and exists (
                select 1 from supervisor_one_time_pins o
                 where o.tenant_id = v_tenant and o.supervisor_id = p_supervisor_id
                   and o.used_at is null and o.revoked_at is null and o.expires_at > now()));
  if not v_ready then
    return jsonb_build_object('ok', false, 'error', 'pin_not_set', 'modes', to_jsonb(v_modes));
  end if;

  if p_pin is not null and p_pin ~ '^[0-9]{4,6}$' then
    -- 1) PIN de un uso.
    if v_feat and 'one_time' = any (v_modes) and length(p_pin) = 6 then
      select * into v_ot from supervisor_one_time_pins o
       where o.tenant_id = v_tenant and o.supervisor_id = p_supervisor_id
         and o.used_at is null and o.revoked_at is null and o.expires_at > now()
         and o.code_hash = otp_one_time_hash(o.code_salt, p_pin)
       order by o.created_at
       limit 1
       for update;
      if v_ot.id is not null then
        if (v_ot.action is null or v_ot.action = p_action)
           and (v_ot.max_amount is null or coalesce(p_amount, 0) <= v_ot.max_amount + 0.001) then
          v_mode := 'one_time';
        else
          v_scope := true;
        end if;
      end if;
    end if;
    -- 2) App autenticadora: ±1 paso y nunca un paso ya usado.
    if v_mode is null and not v_scope and v_feat and 'totp' = any (v_modes) and length(p_pin) = 6
       and v_m.totp_secret is not null and v_m.totp_confirmed_at is not null then
      v_ctr := floor(extract(epoch from now()) / v_m.totp_step)::bigint;
      for d in -1 .. 1 loop
        if (v_m.totp_last_counter is null or v_ctr + d > v_m.totp_last_counter)
           and otp_hotp(v_m.totp_secret, v_ctr + d, 'sha1', 6) = p_pin then
          v_mode := 'totp';
          update supervisor_pin_methods set totp_last_counter = v_ctr + d, updated_at = now() where id = v_m.id;
          exit;
        end if;
      end loop;
    end if;
    -- 3) Rotativo: el actual y, los primeros 5 minutos, el anterior.
    if v_mode is null and not v_scope and v_feat and 'rotating' = any (v_modes) and length(p_pin) = 6
       and v_m.rotating_secret is not null then
      v_ctr := otp_rotating_counter(now(), v.pin_rotation_hours);
      v_start := otp_rotating_start(v_ctr, v.pin_rotation_hours);
      if otp_hotp(v_m.rotating_secret, v_ctr, 'sha256', 6) = p_pin
         or (now() - v_start < interval '5 minutes' and v_ctr > 0
             and otp_hotp(v_m.rotating_secret, v_ctr - 1, 'sha256', 6) = p_pin) then
        v_mode := 'rotating';
      end if;
    end if;
    -- 4) Fijo (con su vencimiento por rotación en días).
    if v_mode is null and not v_scope and 'fixed' = any (v_modes) and v_pin.id is not null
       and crypt(p_pin, v_pin.pin_hash) = v_pin.pin_hash then
      if v.pin_rotation_days is not null
         and coalesce(v_pin.pin_set_at, v_pin.updated_at) + make_interval(days => v.pin_rotation_days) < now() then
        v_expired := true;
      else
        v_mode := 'fixed';
      end if;
    end if;
  end if;

  if v_expired then
    return jsonb_build_object('ok', false, 'error', 'pin_expired', 'modes', to_jsonb(v_modes));
  end if;

  if v_mode is null then
    v_g1 := _pin_guard_fail(v_tenant, 'supervisor', p_supervisor_id, v.pin_max_attempts, v.pin_lock_minutes);
    v_g2 := _pin_guard_fail(v_tenant, 'requester', auth.uid(), v.pin_max_attempts, v.pin_lock_minutes);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'users', p_supervisor_id, 'supervisor_pin_failed',
            jsonb_build_object('supervisor_id', p_supervisor_id, 'requested_by', auth.uid(),
                               'pin_action', p_action, 'amount', p_amount, 'attempt', (v_g1 ->> 'attempt')::int,
                               'modes', v_modes, 'one_time_scope', v_scope));
    if v_g1 ->> 'locked_until' is not null then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, auth.uid(), 'users', p_supervisor_id, 'supervisor_pin_locked',
              jsonb_build_object('supervisor_id', p_supervisor_id, 'requested_by', auth.uid(),
                                 'locked_until', v_g1 ->> 'locked_until'));
    end if;
    if v_g2 ->> 'locked_until' is not null then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, auth.uid(), 'users', auth.uid(), 'supervisor_requester_locked',
              jsonb_build_object('requested_by', auth.uid(), 'supervisor_id', p_supervisor_id,
                                 'locked_until', v_g2 ->> 'locked_until'));
    end if;
    if v_g1 ->> 'locked_until' is not null then
      return jsonb_build_object('ok', false, 'error', 'pin_locked', 'locked_until', v_g1 ->> 'locked_until',
                                'modes', to_jsonb(v_modes));
    end if;
    if v_g2 ->> 'locked_until' is not null then
      return jsonb_build_object('ok', false, 'error', 'requester_locked', 'locked_until', v_g2 ->> 'locked_until',
                                'modes', to_jsonb(v_modes));
    end if;
    return jsonb_build_object('ok', false, 'error', case when v_scope then 'one_time_scope' else 'pin_invalid' end,
                              'attempts_left', least((v_g1 ->> 'left')::int, (v_g2 ->> 'left')::int),
                              'modes', to_jsonb(v_modes));
  end if;

  perform _pin_guard_ok(v_tenant, 'supervisor', p_supervisor_id);
  perform _pin_guard_ok(v_tenant, 'requester', auth.uid());
  if v_pin.id is not null and (v_pin.fail_count > 0 or v_pin.locked_until is not null) then
    update account_supervisor_pins set fail_count = 0, fail_window_start = null, locked_until = null
     where id = v_pin.id;
  end if;

  insert into supervisor_auth_tokens
    (tenant_id, action, supervisor_id, requested_by, amount, ref_id, reason, expires_at, auth_mode)
  values
    (v_tenant, p_action, p_supervisor_id, auth.uid(), round(coalesce(p_amount, 0), 2), p_ref, v_reason, v_expires, v_mode)
  returning id into v_token;

  if v_mode = 'one_time' then
    update supervisor_one_time_pins
       set used_at = now(), used_by = auth.uid(), used_action = p_action,
           used_amount = round(coalesce(p_amount, 0), 2), used_token = v_token
     where id = v_ot.id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'users', p_supervisor_id, 'supervisor_authorized', v_reason,
          jsonb_build_object('supervisor_id', p_supervisor_id, 'requested_by', auth.uid(),
                             'pin_action', p_action, 'amount', p_amount, 'ref_id', p_ref,
                             'token_id', v_token, 'expires_at', v_expires, 'auth_mode', v_mode,
                             'one_time_id', case when v_mode = 'one_time' then v_ot.id end));
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires, 'mode', v_mode);
end;
$$;
revoke all on function supervisor_authorize(text, uuid, text, numeric, text, uuid) from public, anon;
grant execute on function supervisor_authorize(text, uuid, text, numeric, text, uuid) to authenticated;
