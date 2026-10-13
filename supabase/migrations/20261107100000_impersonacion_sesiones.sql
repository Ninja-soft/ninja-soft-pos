-- =============================================================================
-- 20261107100000_impersonacion_sesiones  (F7 · H11c · ADR-084)
--
-- Acceso como el negocio con duración limitada, banner visible y cierre real.
--
--   A) impersonation_sessions: una fila por link generado desde el panel
--      interno (Edge internal_impersonate, service_role). Guarda staff, negocio,
--      cuenta destino, motivo, duración elegida (5 a 240 minutos), hash del
--      nonce de un uso y, al canjearse, la sesión de Auth (session_id del JWT)
--      que abrió el staff. Sin deleted_at: es un log técnico de accesos que
--      nunca se borra.
--   B) impersonation_claim(nonce): la página /auth/impersonate la llama recién
--      logueada con el link. Ata la sesión de Auth actual a la fila. Sólo la
--      cuenta destino, una vez y antes del vencimiento.
--   C) my_impersonation(): el shell del negocio la consulta para mostrar el
--      banner. Sólo devuelve algo si la sesión ACTUAL es la del staff: el dueño
--      real, con su propia sesión, nunca ve el banner.
--   D) impersonation_end(): cierra desde el banner (o al vencer en pantalla).
--      internal_impersonation_end(id): cierra desde el panel interno.
--      impersonation_expire_due(): cron cada 5 minutos que cierra las vencidas.
--      Cerrar borra la sesión de Auth (corta el refresh token) y audita.
--   E) RLS: lectura sólo internal_scope() (ADR-052). Nadie escribe desde el
--      cliente; todo pasa por RPC SECURITY DEFINER o service_role.
-- =============================================================================

create extension if not exists pgcrypto;

create table if not exists impersonation_sessions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  staff_user_id      uuid not null references public.users(id) on delete cascade,
  target_user_id     uuid not null references public.users(id) on delete cascade,
  reason             text not null check (char_length(btrim(reason)) between 5 and 500),
  duration_minutes   integer not null check (duration_minutes between 5 and 240),
  nonce_hash         text not null unique check (nonce_hash ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  claimed_at         timestamptz,
  claimed_session_id uuid,
  ended_at           timestamptz,
  end_reason         text check (end_reason is null or end_reason in ('ended', 'expired', 'revoked')),
  ended_by           uuid references public.users(id) on delete set null,
  check (expires_at > created_at)
);

create index if not exists impersonation_sessions_tenant_idx
  on impersonation_sessions (tenant_id, created_at desc);
create index if not exists impersonation_sessions_target_idx
  on impersonation_sessions (target_user_id) where ended_at is null;
create index if not exists impersonation_sessions_open_idx
  on impersonation_sessions (expires_at) where ended_at is null;

comment on table impersonation_sessions is
  'Accesos del staff como un negocio (ADR-084): duración, motivo, sesión de Auth canjeada y cierre. Log técnico sin borrado.';

alter table impersonation_sessions enable row level security;

drop policy if exists impersonation_sessions_select on impersonation_sessions;
create policy impersonation_sessions_select on impersonation_sessions
  for select using ((select internal_scope()));

-- -----------------------------------------------------------------------------
-- Helper: borra la sesión de Auth (corta el refresh token). Nunca hace fallar
-- al llamador: si el rol no tiene permiso sobre auth queda un warning y el
-- banner igual cierra la sesión del lado del navegador.
-- -----------------------------------------------------------------------------
create or replace function impersonation_kill_session(p_session uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_session is null then
    return;
  end if;
  begin
    delete from auth.sessions where id = p_session;
  exception when others then
    raise warning 'impersonation_kill_session: %', sqlerrm;
  end;
end;
$$;
revoke all on function impersonation_kill_session(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Canje del link
-- -----------------------------------------------------------------------------
create or replace function impersonation_claim(p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_session uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_hash    text;
  v_row     impersonation_sessions%rowtype;
begin
  if v_uid is null or v_session is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_nonce is null or char_length(p_nonce) < 32 or char_length(p_nonce) > 128 then
    raise exception 'invalid_link';
  end if;
  v_hash := encode(digest(convert_to(p_nonce, 'UTF8'), 'sha256'), 'hex');

  select * into v_row
    from impersonation_sessions
   where nonce_hash = v_hash
   for update;
  if not found or v_row.target_user_id <> v_uid then
    raise exception 'invalid_link';
  end if;
  if v_row.claimed_at is not null or v_row.ended_at is not null then
    raise exception 'link_used';
  end if;
  if v_row.expires_at <= now() then
    raise exception 'link_expired';
  end if;

  update impersonation_sessions
     set claimed_at = now(), claimed_session_id = v_session
   where id = v_row.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                          action, after_data, reason)
  values (v_row.tenant_id, v_row.staff_user_id, 'impersonation', v_row.id,
          'impersonation_started',
          jsonb_build_object('expires_at', v_row.expires_at,
                             'duration_minutes', v_row.duration_minutes),
          v_row.reason);

  return jsonb_build_object('id', v_row.id, 'expires_at', v_row.expires_at);
end;
$$;
revoke all on function impersonation_claim(text) from public, anon;
grant execute on function impersonation_claim(text) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Banner: sólo la sesión canjeada por el staff
-- -----------------------------------------------------------------------------
create or replace function my_impersonation()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id', i.id,
           'tenant_id', i.tenant_id,
           'tenant_name', t.name,
           'staff_email', su.email,
           'reason', i.reason,
           'expires_at', i.expires_at,
           'expired', i.expires_at <= now())
    from impersonation_sessions i
    join tenants t on t.id = i.tenant_id
    left join public.users su on su.id = i.staff_user_id
   where i.target_user_id = auth.uid()
     and i.claimed_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
     and i.ended_at is null
   order by i.claimed_at desc
   limit 1;
$$;
revoke all on function my_impersonation() from public, anon;
grant execute on function my_impersonation() to authenticated;

-- -----------------------------------------------------------------------------
-- D) Cierre
-- -----------------------------------------------------------------------------
create or replace function impersonation_close(
  p_id     uuid,
  p_reason text,
  p_actor  uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row impersonation_sessions%rowtype;
begin
  update impersonation_sessions
     set ended_at = now(), end_reason = p_reason, ended_by = p_actor
   where id = p_id and ended_at is null
  returning * into v_row;
  if not found then
    return;
  end if;
  perform impersonation_kill_session(v_row.claimed_session_id);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                          action, after_data)
  values (v_row.tenant_id, coalesce(p_actor, v_row.staff_user_id), 'impersonation',
          v_row.id, 'impersonation_ended',
          jsonb_build_object('end_reason', p_reason,
                             'claimed', v_row.claimed_at is not null,
                             'expires_at', v_row.expires_at));
end;
$$;
revoke all on function impersonation_close(uuid, text, uuid) from public, anon, authenticated;

-- Desde el banner (la propia sesión del staff dentro del negocio).
create or replace function impersonation_end()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row impersonation_sessions%rowtype;
begin
  select * into v_row
    from impersonation_sessions
   where target_user_id = auth.uid()
     and claimed_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
     and ended_at is null
   limit 1;
  if not found then
    return false;
  end if;
  perform impersonation_close(
    v_row.id,
    case when v_row.expires_at <= now() then 'expired' else 'ended' end,
    v_row.staff_user_id);
  return true;
end;
$$;
revoke all on function impersonation_end() from public, anon;
grant execute on function impersonation_end() to authenticated;

-- Desde el panel interno (admin o super_admin).
create or replace function internal_impersonation_end(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not internal_scope() or coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from impersonation_sessions where id = p_id) then
    raise exception 'not_found';
  end if;
  perform impersonation_close(p_id, 'revoked', auth.uid());
end;
$$;
revoke all on function internal_impersonation_end(uuid) from public, anon;
grant execute on function internal_impersonation_end(uuid) to authenticated;

-- Cron: cierra las vencidas (canjeadas o no). Devuelve cuántas cerró.
create or replace function impersonation_expire_due()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select id from impersonation_sessions
     where ended_at is null and expires_at <= now()
     for update skip locked
  loop
    perform impersonation_close(r.id, 'expired', null);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function impersonation_expire_due() from public, anon, authenticated;
grant execute on function impersonation_expire_due() to service_role;

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el vencimiento automático de impersonation_sessions.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'impersonation-expire') then
    perform cron.unschedule('impersonation-expire');
  end if;
  perform cron.schedule(
    'impersonation-expire',
    '*/5 * * * *',
    $$select public.impersonation_expire_due()$$
  );
end;
$cron$;
