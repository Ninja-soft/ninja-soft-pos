-- =============================================================================
-- 20261109400100_api_publica_credenciales  (ADR-094 · F5 · API pública v1)
--
-- Credenciales OAuth2 client_credentials por negocio.
--
--   A) api_clients: una integración del negocio. client_id público
--      (nsc_ + 24 hex), secreto (nss_ + 64 hex) que se muestra UNA vez y se
--      guarda sólo como sha256 (el secreto es aleatorio de 256 bits: un hash
--      rápido alcanza, no es una contraseña elegida por una persona), alcances
--      (scopes), límite por minuto, rotación, revocación (baja lógica) y
--      último uso.
--   B) api_access_tokens: tokens Bearer opacos de 1 hora (sólo el hash).
--   C) api_rate_windows: contadores por cliente y minuto para la ventana
--      deslizante (20261109400200).
--   D) api_idempotency_keys: respuesta guardada por Idempotency-Key (24 h).
--   E) RPC del dueño (Configuración > Integraciones > API): listar, crear,
--      editar, rotar y revocar. Sólo el dueño (ADR-071); crear, editar y rotar
--      piden la feature `api_publica`; revocar y listar no (cortar el acceso
--      siempre se puede). Todo en audit_logs, nunca el secreto ni su hash.
--
-- Lectura: api_clients tiene una policy de lectura para el dueño (con
-- (select ...)) y grants por columna SIN secret_hash; las otras tres tablas no
-- tienen policies (sólo las RPC SECURITY DEFINER las tocan). Sin escritura por
-- REST en ninguna.
-- =============================================================================

create extension if not exists pgcrypto;

-- Alcances válidos (espejo de lib/api-publica/scopes.ts).
create or replace function api_scopes_all()
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array['products:read', 'products:write', 'stock:read', 'stock:write',
               'prices:write', 'sales:read', 'customers:read', 'customers:write']::text[];
$$;
revoke all on function api_scopes_all() from public, anon;
grant execute on function api_scopes_all() to authenticated;

-- -----------------------------------------------------------------------------
-- A) Clientes.
-- -----------------------------------------------------------------------------
create table if not exists api_clients (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  name               text not null check (char_length(btrim(name)) between 1 and 80),
  client_id          text not null unique check (client_id ~ '^nsc_[0-9a-f]{24}$'),
  secret_hash        text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  secret_hint        text not null check (char_length(secret_hint) = 4),
  scopes             text[] not null check (cardinality(scopes) between 1 and 8
                                            and scopes <@ api_scopes_all()),
  rate_limit_per_min integer not null default 600 check (rate_limit_per_min between 10 and 10000),
  created_by         uuid references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  rotated_at         timestamptz,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  revoked_by         uuid references users(id) on delete set null,
  revoke_reason      text check (revoke_reason is null or char_length(revoke_reason) <= 300)
);
create index if not exists api_clients_tenant_idx on api_clients (tenant_id, created_at desc);
create index if not exists api_clients_created_by_idx on api_clients (created_by) where created_by is not null;
create index if not exists api_clients_revoked_by_idx on api_clients (revoked_by) where revoked_by is not null;

comment on table api_clients is
  'Credenciales de la API pública por negocio (ADR-094). secret_hash = sha256 hex del secreto; el secreto no se guarda.';

-- -----------------------------------------------------------------------------
-- B) Tokens de acceso.
-- -----------------------------------------------------------------------------
create table if not exists api_access_tokens (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  client_id  uuid not null references api_clients(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes     text[] not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists api_access_tokens_client_idx on api_access_tokens (client_id, expires_at);
create index if not exists api_access_tokens_tenant_idx on api_access_tokens (tenant_id, created_at);

-- -----------------------------------------------------------------------------
-- C) Ventana del límite por minuto.
-- -----------------------------------------------------------------------------
create table if not exists api_rate_windows (
  client_id    uuid not null references api_clients(id) on delete cascade,
  window_start timestamptz not null,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  hits         integer not null default 0 check (hits >= 0),
  primary key (client_id, window_start)
);
create index if not exists api_rate_windows_tenant_idx on api_rate_windows (tenant_id);

-- -----------------------------------------------------------------------------
-- D) Idempotencia.
-- -----------------------------------------------------------------------------
create table if not exists api_idempotency_keys (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  client_id    uuid not null references api_clients(id) on delete cascade,
  key          text not null check (char_length(key) between 8 and 128),
  endpoint     text not null,
  request_hash text not null,
  status       integer,
  response     jsonb,
  created_at   timestamptz not null default now(),
  constraint api_idempotency_keys_client_key unique (client_id, key)
);
create index if not exists api_idempotency_keys_tenant_idx on api_idempotency_keys (tenant_id, created_at);

-- -----------------------------------------------------------------------------
-- RLS.
-- -----------------------------------------------------------------------------
alter table api_clients enable row level security;
alter table api_access_tokens enable row level security;
alter table api_rate_windows enable row level security;
alter table api_idempotency_keys enable row level security;

-- Sólo el dueño del negocio activo ve sus clientes (sin el hash: grants por columna).
drop policy if exists api_clients_owner_select on api_clients;
create policy api_clients_owner_select on api_clients
  for select using (
    tenant_id = (select current_tenant_id())
    and (select member_role_in((select current_tenant_id()))) = 'owner'
  );

revoke all on api_clients, api_access_tokens, api_rate_windows, api_idempotency_keys from anon, authenticated;
grant select (id, tenant_id, name, client_id, secret_hint, scopes, rate_limit_per_min, created_by,
              created_at, updated_at, rotated_at, last_used_at, revoked_at, revoked_by, revoke_reason)
  on api_clients to authenticated;

-- Permisos por rol (ADR-071): nadie escribe por REST; igual se instala el guard.
do $$
declare
  t text;
begin
  foreach t in array array['api_clients'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'manage');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Helpers.
-- -----------------------------------------------------------------------------
create or replace function _api_sha256(p text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select encode(digest(convert_to(p, 'UTF8'), 'sha256'), 'hex');
$$;
revoke all on function _api_sha256(text) from public, anon, authenticated;

-- Normaliza y valida alcances: subconjunto de api_scopes_all(), sin repetidos.
create or replace function _api_scopes_clean(p_scopes text[])
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text[];
begin
  select array_agg(distinct btrim(s) order by btrim(s)) into v
    from unnest(coalesce(p_scopes, array[]::text[])) s
   where btrim(s) <> '';
  if v is null or cardinality(v) = 0 then
    raise exception 'scopes_required' using errcode = 'check_violation';
  end if;
  if not (v <@ api_scopes_all()) then
    raise exception 'invalid_scope' using errcode = 'check_violation';
  end if;
  return v;
end;
$$;
revoke all on function _api_scopes_clean(text[]) from public, anon, authenticated;

-- Dueño del negocio activo; con p_need_feature exige además la feature.
create or replace function _api_owner_assert(p_need_feature boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or coalesce(member_role_in(v_tenant), '') <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_need_feature and not tenant_has_feature_for(v_tenant, 'api_publica') then
    raise exception 'feature_not_in_plan: api_publica';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _api_owner_assert(boolean) from public, anon, authenticated;

-- Vista pública de un cliente (nunca el hash).
create or replace function _api_client_json(c api_clients)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'client_id', c.client_id, 'secret_hint', c.secret_hint,
    'scopes', to_jsonb(c.scopes), 'rate_limit_per_min', c.rate_limit_per_min,
    'created_at', c.created_at, 'updated_at', c.updated_at, 'rotated_at', c.rotated_at,
    'last_used_at', c.last_used_at, 'revoked_at', c.revoked_at, 'revoke_reason', c.revoke_reason,
    'status', case when c.revoked_at is not null then 'revoked' else 'active' end);
$$;
revoke all on function _api_client_json(api_clients) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) RPC del dueño.
-- -----------------------------------------------------------------------------
create or replace function api_clients_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(false);
begin
  return jsonb_build_object(
    'feature', tenant_has_feature_for(v_tenant, 'api_publica'),
    'scopes', to_jsonb(api_scopes_all()),
    'clients', coalesce((
      select jsonb_agg(_api_client_json(c) order by c.revoked_at is not null, c.created_at desc)
        from api_clients c
       where c.tenant_id = v_tenant), '[]'::jsonb));
end;
$$;
revoke all on function api_clients_list() from public, anon;
grant execute on function api_clients_list() to authenticated;

create or replace function api_client_create(p_name text, p_scopes text[], p_rate_limit integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(true);
  v_scopes text[] := _api_scopes_clean(p_scopes);
  v_secret text := 'nss_' || encode(gen_random_bytes(32), 'hex');
  v_cid    text := 'nsc_' || encode(gen_random_bytes(12), 'hex');
  v_row    api_clients;
begin
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'name_required' using errcode = 'check_violation';
  end if;
  if (select count(*) from api_clients c where c.tenant_id = v_tenant and c.revoked_at is null) >= 10 then
    raise exception 'too_many_clients' using errcode = 'check_violation';
  end if;
  insert into api_clients (tenant_id, name, client_id, secret_hash, secret_hint, scopes,
                           rate_limit_per_min, created_by)
  values (v_tenant, btrim(p_name), v_cid, _api_sha256(v_secret), right(v_secret, 4), v_scopes,
          coalesce(p_rate_limit, 600), auth.uid())
  returning * into v_row;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'api_client', v_row.id, 'api_client_created', null, _api_client_json(v_row));

  -- El secreto viaja sólo en esta respuesta.
  return _api_client_json(v_row) || jsonb_build_object('client_secret', v_secret);
end;
$$;
revoke all on function api_client_create(text, text[], integer) from public, anon;
grant execute on function api_client_create(text, text[], integer) to authenticated;

create or replace function api_client_update(p_id uuid, p_name text default null, p_scopes text[] default null,
                                             p_rate_limit integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(true);
  v_old    api_clients;
  v_row    api_clients;
  v_scopes text[];
begin
  select * into v_old from api_clients c where c.id = p_id and c.tenant_id = v_tenant for update;
  if v_old.id is null then raise exception 'client_not_found'; end if;
  if v_old.revoked_at is not null then raise exception 'client_revoked'; end if;
  v_scopes := case when p_scopes is null then v_old.scopes else _api_scopes_clean(p_scopes) end;
  if p_name is not null and nullif(btrim(p_name), '') is null then
    raise exception 'name_required' using errcode = 'check_violation';
  end if;

  update api_clients c
     set name = coalesce(nullif(btrim(p_name), ''), c.name),
         scopes = v_scopes,
         rate_limit_per_min = coalesce(p_rate_limit, c.rate_limit_per_min),
         updated_at = now()
   where c.id = v_old.id and c.tenant_id = v_tenant
  returning * into v_row;

  -- Si se quitaron alcances, los tokens vigentes (que los llevan) se cortan.
  if not (v_old.scopes <@ v_row.scopes) then
    update api_access_tokens t set revoked_at = now()
     where t.client_id = v_row.id and t.tenant_id = v_tenant and t.revoked_at is null;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'api_client', v_row.id, 'api_client_updated',
          _api_client_json(v_old), _api_client_json(v_row));
  return _api_client_json(v_row);
end;
$$;
revoke all on function api_client_update(uuid, text, text[], integer) from public, anon;
grant execute on function api_client_update(uuid, text, text[], integer) to authenticated;

-- Rotación: secreto nuevo (se muestra una vez); el anterior y sus tokens dejan
-- de servir en el acto.
create or replace function api_client_rotate(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(true);
  v_secret text := 'nss_' || encode(gen_random_bytes(32), 'hex');
  v_old    api_clients;
  v_row    api_clients;
begin
  select * into v_old from api_clients c where c.id = p_id and c.tenant_id = v_tenant for update;
  if v_old.id is null then raise exception 'client_not_found'; end if;
  if v_old.revoked_at is not null then raise exception 'client_revoked'; end if;

  update api_clients c
     set secret_hash = _api_sha256(v_secret), secret_hint = right(v_secret, 4),
         rotated_at = now(), updated_at = now()
   where c.id = v_old.id and c.tenant_id = v_tenant
  returning * into v_row;
  update api_access_tokens t set revoked_at = now()
   where t.client_id = v_row.id and t.tenant_id = v_tenant and t.revoked_at is null;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'api_client', v_row.id, 'api_client_rotated',
          jsonb_build_object('secret_hint', v_old.secret_hint),
          jsonb_build_object('secret_hint', v_row.secret_hint));
  return _api_client_json(v_row) || jsonb_build_object('client_secret', v_secret);
end;
$$;
revoke all on function api_client_rotate(uuid) from public, anon;
grant execute on function api_client_rotate(uuid) to authenticated;

-- Revocación (baja lógica, definitiva): no pide la feature.
create or replace function api_client_revoke(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(false);
  v_old    api_clients;
  v_row    api_clients;
begin
  select * into v_old from api_clients c where c.id = p_id and c.tenant_id = v_tenant for update;
  if v_old.id is null then raise exception 'client_not_found'; end if;
  if v_old.revoked_at is not null then return _api_client_json(v_old); end if;

  update api_clients c
     set revoked_at = now(), revoked_by = auth.uid(),
         revoke_reason = nullif(left(btrim(coalesce(p_reason, '')), 300), ''), updated_at = now()
   where c.id = v_old.id and c.tenant_id = v_tenant
  returning * into v_row;
  update api_access_tokens t set revoked_at = now()
   where t.client_id = v_row.id and t.tenant_id = v_tenant and t.revoked_at is null;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'api_client', v_row.id, 'api_client_revoked',
          _api_client_json(v_old), _api_client_json(v_row), v_row.revoke_reason);
  return _api_client_json(v_row);
end;
$$;
revoke all on function api_client_revoke(uuid, text) from public, anon;
grant execute on function api_client_revoke(uuid, text) to authenticated;
