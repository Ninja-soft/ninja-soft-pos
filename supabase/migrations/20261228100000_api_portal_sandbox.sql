-- =============================================================================
-- 20261228100000_api_portal_sandbox  (ADR-159 · H68b · Portal de la API)
--
-- Credenciales de PRUEBA (sandbox) para la API pública v1 (ADR-094).
--
--   * api_clients.environment: 'live' (como hasta ahora) o 'test'. Las de
--     prueba llevan prefijos propios en todo el circuito:
--       client_id      nsc_test_<24 hex>
--       client_secret  nss_test_<64 hex>   (sólo sha256 en la base, como live)
--       access_token   nsat_test_<64 hex>  (sólo sha256 en la base)
--     El ambiente se fija al crear la credencial y no se puede cambiar.
--   * _api_auth devuelve `sandbox` según la credencial (dato de la base, no
--     del prefijo que manda el cliente).
--   * Escrituras con un token de prueba = dry_run: las 4 RPC de escritura
--     (products, prices, stock, customers) corren la operación REAL dentro de
--     un subbloque (validación completa, mismos resultados por ítem) y lo
--     deshacen con una excepción centinela antes de devolver. Nada persiste:
--     ni productos, ni stock, ni movimientos, ni auditoría del lote, ni la
--     reserva de Idempotency-Key, ni colas de sincronización (Mercado Libre,
--     catálogo, etc. viven en tablas y se deshacen con el subbloque). No hay
--     camino para facturar en ARCA, cobrar ni publicar: la API v1 no expone
--     esas operaciones y lo que encolan los triggers se deshace.
--     La respuesta lleva body.dry_run = true y el sobre `sandbox: true`.
--     Los ids de altas que devuelve son simulados (no existen después).
--   * Lecturas con un token de prueba: datos reales del negocio, sólo lectura,
--     con los mismos alcances que eligió el dueño (equivale a una credencial
--     live de sólo lectura).
--   * Gating: igual que live. Crear, rotar y emitir tokens de prueba exige
--     `api_publica` (Enterprise); _api_auth la vuelve a exigir en cada
--     llamada. Revocar siempre se puede.
--   * Auditoría: alta, rotación y revocación ya se auditan en audit_logs
--     (api_client_created / _rotated / _revoked); el JSON de la credencial
--     suma `environment`. Nunca el secreto ni su hash.
--
-- Sin tablas ni policies nuevas: api_clients sigue con su policy del dueño
-- (con (select ...)) y grants por columna; se suma la columna environment.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Ambiente de la credencial.
-- -----------------------------------------------------------------------------
alter table api_clients add column if not exists environment text not null default 'live';

alter table api_clients drop constraint if exists api_clients_environment_check;
alter table api_clients add constraint api_clients_environment_check
  check (environment in ('live', 'test'));

alter table api_clients drop constraint if exists api_clients_client_id_check;
alter table api_clients add constraint api_clients_client_id_check
  check (client_id ~ '^nsc_(test_)?[0-9a-f]{24}$');

-- El prefijo del client_id y el ambiente siempre coinciden.
alter table api_clients drop constraint if exists api_clients_environment_prefix_check;
alter table api_clients add constraint api_clients_environment_prefix_check
  check ((environment = 'test') = (left(client_id, 9) = 'nsc_test_'));

comment on column api_clients.environment is
  'live = producción; test = sandbox (ADR-159): las escrituras se validan y se deshacen (dry_run).';

grant select (environment) on api_clients to authenticated;

-- -----------------------------------------------------------------------------
-- B) Vista pública de la credencial (suma environment; nunca el hash).
-- -----------------------------------------------------------------------------
create or replace function _api_client_json(c api_clients)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'client_id', c.client_id, 'secret_hint', c.secret_hint,
    'scopes', to_jsonb(c.scopes), 'rate_limit_per_min', c.rate_limit_per_min,
    'environment', c.environment,
    'created_at', c.created_at, 'updated_at', c.updated_at, 'rotated_at', c.rotated_at,
    'last_used_at', c.last_used_at, 'revoked_at', c.revoked_at, 'revoke_reason', c.revoke_reason,
    'status', case when c.revoked_at is not null then 'revoked' else 'active' end);
$$;
revoke all on function _api_client_json(api_clients) from public, anon, authenticated;

-- Prefijo de secreto y token según el ambiente.
create or replace function _api_env_prefix(p_environment text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_environment = 'test' then 'test_' else '' end;
$$;
revoke all on function _api_env_prefix(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Alta con ambiente. Reemplaza la firma de 3 argumentos (con un default
--    nuevo, la vieja quedaría ambigua).
-- -----------------------------------------------------------------------------
drop function if exists api_client_create(text, text[], integer);

create or replace function api_client_create(p_name text, p_scopes text[], p_rate_limit integer default null,
                                             p_environment text default 'live')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(true);
  v_scopes text[] := _api_scopes_clean(p_scopes);
  v_env    text := coalesce(nullif(btrim(p_environment), ''), 'live');
  v_secret text;
  v_cid    text;
  v_row    api_clients;
begin
  if v_env not in ('live', 'test') then
    raise exception 'invalid_environment' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'name_required' using errcode = 'check_violation';
  end if;
  if (select count(*) from api_clients c where c.tenant_id = v_tenant and c.revoked_at is null) >= 10 then
    raise exception 'too_many_clients' using errcode = 'check_violation';
  end if;

  v_secret := 'nss_' || _api_env_prefix(v_env) || encode(gen_random_bytes(32), 'hex');
  v_cid    := 'nsc_' || _api_env_prefix(v_env) || encode(gen_random_bytes(12), 'hex');

  insert into api_clients (tenant_id, name, client_id, secret_hash, secret_hint, scopes,
                           rate_limit_per_min, created_by, environment)
  values (v_tenant, btrim(p_name), v_cid, _api_sha256(v_secret), right(v_secret, 4), v_scopes,
          coalesce(p_rate_limit, 600), auth.uid(), v_env)
  returning * into v_row;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'api_client', v_row.id, 'api_client_created', null, _api_client_json(v_row));

  -- El secreto viaja sólo en esta respuesta.
  return _api_client_json(v_row) || jsonb_build_object('client_secret', v_secret);
end;
$$;
revoke all on function api_client_create(text, text[], integer, text) from public, anon;
grant execute on function api_client_create(text, text[], integer, text) to authenticated;

-- Rotación: conserva el prefijo del ambiente.
create or replace function api_client_rotate(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(true);
  v_secret text;
  v_old    api_clients;
  v_row    api_clients;
begin
  select * into v_old from api_clients c where c.id = p_id and c.tenant_id = v_tenant for update;
  if v_old.id is null then raise exception 'client_not_found'; end if;
  if v_old.revoked_at is not null then raise exception 'client_revoked'; end if;

  v_secret := 'nss_' || _api_env_prefix(v_old.environment) || encode(gen_random_bytes(32), 'hex');

  update api_clients c
     set secret_hash = _api_sha256(v_secret), secret_hint = right(v_secret, 4),
         rotated_at = now(), updated_at = now()
   where c.id = v_old.id and c.tenant_id = v_tenant
  returning * into v_row;
  update api_access_tokens t set revoked_at = now()
   where t.client_id = v_row.id and t.tenant_id = v_tenant and t.revoked_at is null;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'api_client', v_row.id, 'api_client_rotated',
          jsonb_build_object('secret_hint', v_old.secret_hint, 'environment', v_old.environment),
          jsonb_build_object('secret_hint', v_row.secret_hint, 'environment', v_row.environment));
  return _api_client_json(v_row) || jsonb_build_object('client_secret', v_secret);
end;
$$;
revoke all on function api_client_rotate(uuid) from public, anon;
grant execute on function api_client_rotate(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Token: el prefijo sale del ambiente de la credencial.
-- -----------------------------------------------------------------------------
create or replace function api_token_issue(p_client_id text, p_client_secret text, p_scope text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_client api_clients;
  v_rate   jsonb;
  v_req    text[];
  v_scopes text[];
  v_token  text;
  v_tok_id uuid;
begin
  select * into v_client from api_clients c where c.client_id = btrim(coalesce(p_client_id, ''));
  if v_client.id is null or v_client.revoked_at is not null then
    return _api_err(401, 'invalid_client', 'Credenciales inválidas.');
  end if;

  -- El límite también frena los intentos con secreto equivocado.
  v_rate := _api_rate_hit(v_client.tenant_id, v_client.id, v_client.rate_limit_per_min);
  if not (v_rate ->> 'allowed')::boolean then
    return _api_err(429, 'rate_limited', 'Demasiadas solicitudes. Esperá y reintentá.')
           || jsonb_build_object('rate', v_rate);
  end if;

  if _api_sha256(coalesce(p_client_secret, '')) <> v_client.secret_hash then
    return _api_err(401, 'invalid_client', 'Credenciales inválidas.') || jsonb_build_object('rate', v_rate);
  end if;
  if not _api_tenant_ok(v_client.tenant_id) then
    return _api_err(403, 'tenant_inactive', 'El negocio no está activo.') || jsonb_build_object('rate', v_rate);
  end if;
  if not tenant_has_feature_for(v_client.tenant_id, 'api_publica') then
    return _api_err(403, 'feature_not_in_plan', 'El plan del negocio no incluye la API pública (Enterprise).')
           || jsonb_build_object('rate', v_rate);
  end if;

  v_req := array(select distinct s from regexp_split_to_table(btrim(coalesce(p_scope, '')), '\s+') s where s <> '');
  if cardinality(v_req) = 0 then
    v_scopes := v_client.scopes;
  elsif v_req <@ v_client.scopes then
    v_scopes := array(select s from unnest(v_req) s order by s);
  else
    return _api_err(400, 'invalid_scope', 'La credencial no tiene alguno de los alcances pedidos.',
                    jsonb_build_object('allowed', to_jsonb(v_client.scopes)))
           || jsonb_build_object('rate', v_rate);
  end if;

  -- Limpieza: tokens vencidos hace más de un día.
  delete from api_access_tokens t
   where t.client_id = v_client.id and t.tenant_id = v_client.tenant_id
     and t.expires_at < now() - interval '1 day';

  v_token := 'nsat_' || _api_env_prefix(v_client.environment) || encode(gen_random_bytes(32), 'hex');
  insert into api_access_tokens (tenant_id, client_id, token_hash, scopes, expires_at)
  values (v_client.tenant_id, v_client.id, _api_sha256(v_token), v_scopes, now() + interval '1 hour')
  returning id into v_tok_id;

  update api_clients c set last_used_at = now()
   where c.id = v_client.id and c.tenant_id = v_client.tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_client.tenant_id, null, 'api_client', v_client.id, 'api_token_issued', null,
          jsonb_build_object('token_id', v_tok_id, 'scopes', to_jsonb(v_scopes),
                             'environment', v_client.environment));

  return jsonb_build_object(
    'status', 200,
    'body', jsonb_build_object('access_token', v_token, 'token_type', 'Bearer', 'expires_in', 3600,
                               'scope', array_to_string(v_scopes, ' '),
                               'environment', v_client.environment),
    'rate', v_rate);
end;
$$;
revoke all on function api_token_issue(text, text, text) from public, authenticated;
grant execute on function api_token_issue(text, text, text) to anon;

-- -----------------------------------------------------------------------------
-- E) Autenticación: acepta tokens de prueba y devuelve `sandbox`.
-- -----------------------------------------------------------------------------
create or replace function _api_auth(p_token text, p_scope text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_rate  jsonb;
begin
  if p_token is null or p_token !~ '^nsat_(test_)?[0-9a-f]{64}$' then
    return _api_err(401, 'invalid_token', 'Falta el token o no es válido.') || '{"ok": false}'::jsonb;
  end if;

  select t.tenant_id, t.client_id, t.scopes, c.rate_limit_per_min, c.last_used_at, c.environment
    into v_tok
    from api_access_tokens t
    join api_clients c on c.id = t.client_id and c.tenant_id = t.tenant_id
   where t.token_hash = _api_sha256(p_token)
     and t.revoked_at is null
     and t.expires_at > now()
     and c.revoked_at is null;
  if v_tok.client_id is null then
    return _api_err(401, 'invalid_token', 'El token venció o fue revocado. Pedí uno nuevo.') || '{"ok": false}'::jsonb;
  end if;

  v_rate := _api_rate_hit(v_tok.tenant_id, v_tok.client_id, v_tok.rate_limit_per_min);
  if not (v_rate ->> 'allowed')::boolean then
    return _api_err(429, 'rate_limited', 'Demasiadas solicitudes. Esperá y reintentá.')
           || jsonb_build_object('ok', false, 'rate', v_rate);
  end if;

  if v_tok.last_used_at is null or v_tok.last_used_at < now() - interval '1 minute' then
    update api_clients c set last_used_at = now()
     where c.id = v_tok.client_id and c.tenant_id = v_tok.tenant_id;
  end if;

  if not _api_tenant_ok(v_tok.tenant_id) then
    return _api_err(403, 'tenant_inactive', 'El negocio no está activo.')
           || jsonb_build_object('ok', false, 'rate', v_rate);
  end if;
  if not tenant_has_feature_for(v_tok.tenant_id, 'api_publica') then
    return _api_err(403, 'feature_not_in_plan', 'El plan del negocio no incluye la API pública (Enterprise).')
           || jsonb_build_object('ok', false, 'rate', v_rate);
  end if;
  if not (p_scope = any (v_tok.scopes)) then
    return _api_err(403, 'insufficient_scope', 'El token no tiene el alcance ' || p_scope || '.',
                    jsonb_build_object('required', p_scope))
           || jsonb_build_object('ok', false, 'rate', v_rate);
  end if;

  return jsonb_build_object('ok', true, 'tenant_id', v_tok.tenant_id, 'client_id', v_tok.client_id,
                            'sandbox', v_tok.environment = 'test', 'rate', v_rate);
end;
$$;
revoke all on function _api_auth(text, text) from public, anon, authenticated;

-- Marca de dry_run en el sobre.
create or replace function _api_mark_dry_run(p_env jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
           when jsonb_typeof(p_env -> 'body') = 'object'
             then jsonb_set(p_env, '{body,dry_run}', 'true'::jsonb)
           else p_env
         end || jsonb_build_object('sandbox', true);
$$;
revoke all on function _api_mark_dry_run(jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) Escrituras: con token de prueba se corre la operación y se deshace.
--    El centinela 'api_sandbox_rollback' sólo lo lanza este bloque; las
--    variables PL/pgSQL conservan el resultado aunque el subbloque se deshaga.
-- -----------------------------------------------------------------------------
create or replace function api_v1_products_upsert(p_token text, p_items jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'products:write');
  v_sandbox boolean := coalesce((v_auth ->> 'sandbox')::boolean, false);
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_products_upsert((v_auth ->> 'tenant_id')::uuid, (v_auth ->> 'client_id')::uuid,
                                     p_items, p_idempotency_key);
    if v_sandbox then raise exception 'api_sandbox_rollback'; end if;
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    if not (v_sandbox and v_msg = 'api_sandbox_rollback') then
      v_out := _api_from_exception(v_st, v_msg, v_det);
    end if;
  end;
  if v_sandbox then v_out := _api_mark_dry_run(v_out); end if;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_products_upsert(text, jsonb, text) from public, authenticated;
grant execute on function api_v1_products_upsert(text, jsonb, text) to anon;

create or replace function api_v1_prices_update(p_token text, p_items jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'prices:write');
  v_sandbox boolean := coalesce((v_auth ->> 'sandbox')::boolean, false);
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_prices_update((v_auth ->> 'tenant_id')::uuid, (v_auth ->> 'client_id')::uuid,
                                   p_items, p_idempotency_key);
    if v_sandbox then raise exception 'api_sandbox_rollback'; end if;
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    if not (v_sandbox and v_msg = 'api_sandbox_rollback') then
      v_out := _api_from_exception(v_st, v_msg, v_det);
    end if;
  end;
  if v_sandbox then v_out := _api_mark_dry_run(v_out); end if;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_prices_update(text, jsonb, text) from public, authenticated;
grant execute on function api_v1_prices_update(text, jsonb, text) to anon;

create or replace function api_v1_stock_adjust(p_token text, p_items jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'stock:write');
  v_sandbox boolean := coalesce((v_auth ->> 'sandbox')::boolean, false);
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_stock_adjust((v_auth ->> 'tenant_id')::uuid, (v_auth ->> 'client_id')::uuid,
                                  p_items, p_idempotency_key);
    if v_sandbox then raise exception 'api_sandbox_rollback'; end if;
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    if not (v_sandbox and v_msg = 'api_sandbox_rollback') then
      v_out := _api_from_exception(v_st, v_msg, v_det);
    end if;
  end;
  if v_sandbox then v_out := _api_mark_dry_run(v_out); end if;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_stock_adjust(text, jsonb, text) from public, authenticated;
grant execute on function api_v1_stock_adjust(text, jsonb, text) to anon;

create or replace function api_v1_customers_upsert(p_token text, p_items jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'customers:write');
  v_sandbox boolean := coalesce((v_auth ->> 'sandbox')::boolean, false);
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_customers_upsert((v_auth ->> 'tenant_id')::uuid, (v_auth ->> 'client_id')::uuid,
                                      p_items, p_idempotency_key);
    if v_sandbox then raise exception 'api_sandbox_rollback'; end if;
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    if not (v_sandbox and v_msg = 'api_sandbox_rollback') then
      v_out := _api_from_exception(v_st, v_msg, v_det);
    end if;
  end;
  if v_sandbox then v_out := _api_mark_dry_run(v_out); end if;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_customers_upsert(text, jsonb, text) from public, authenticated;
grant execute on function api_v1_customers_upsert(text, jsonb, text) to anon;
