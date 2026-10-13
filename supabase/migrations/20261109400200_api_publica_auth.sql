-- =============================================================================
-- 20261109400200_api_publica_auth  (ADR-094 · F5 · API pública v1)
--
-- Token OAuth2 (client_credentials), autenticación de cada llamada, límite
-- por cliente con ventana deslizante e idempotencia.
--
-- Modelo de seguridad:
--   * El negocio sale SOLO de la credencial: el token opaco se hashea y se
--     busca en api_access_tokens; nada del request (ids, tenant, headers)
--     elige el negocio. Las RPC públicas (api_token_issue, api_v1_*) reciben
--     el token, no un tenant.
--   * Cada operación (20261109400300) es una RPC SECURITY DEFINER que recibe
--     el negocio YA validado por _api_auth y filtra todo por ese tenant_id.
--     Sin service_role: la ruta /api/v1 de Next llama con la anon key, y las
--     RPC públicas sólo se otorgan a anon.
--   * Gating real: la feature `api_publica` se exige al emitir el token y en
--     cada llamada (apagarla corta tokens vigentes en la llamada siguiente).
--   * Errores de autenticación y de límite se DEVUELVEN (no se lanzan) para
--     que el contador de la ventana y el último uso persistan.
--
-- Sobre de respuesta (lo traduce app/api/v1): {status, body, rate?}; los
-- errores llevan body = {error: {code, message, details?}}.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Sobres.
-- -----------------------------------------------------------------------------
create or replace function _api_err(p_status integer, p_code text, p_message text, p_details jsonb default null)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'status', p_status,
    'body', jsonb_build_object('error',
      jsonb_strip_nulls(jsonb_build_object('code', p_code, 'message', p_message, 'details', p_details))));
$$;
revoke all on function _api_err(integer, text, text, jsonb) from public, anon, authenticated;

-- Corta la operación con un error de la API (lo traduce _api_from_exception).
create or replace function _api_fail(p_status integer, p_code text, p_message text, p_details jsonb default null)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'api_fail'
    using detail = jsonb_build_object('status', p_status, 'code', p_code, 'message', p_message,
                                      'details', p_details)::text;
end;
$$;
revoke all on function _api_fail(integer, text, text, jsonb) from public, anon, authenticated;

-- Excepción dentro de una operación -> sobre de error. Nunca filtra el
-- mensaje interno de un error inesperado.
create or replace function _api_from_exception(p_state text, p_message text, p_detail text)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  d jsonb;
begin
  if p_message = 'api_fail' and p_detail is not null then
    d := p_detail::jsonb;
    return _api_err((d ->> 'status')::integer, d ->> 'code', d ->> 'message',
                    nullif(d -> 'details', 'null'::jsonb));
  end if;
  if p_message like 'feature_not_in_plan%' then
    return _api_err(403, 'feature_not_in_plan', 'El plan del negocio no incluye esta función: '
                    || btrim(split_part(p_message, ':', 2)));
  end if;
  if p_state = '23505' then
    return _api_err(409, 'conflict', 'Otro pedido modificó los mismos datos al mismo tiempo. Reintentá.');
  end if;
  if p_state like '22%' or p_state like '23%' then
    return _api_err(422, 'validation_error', 'Datos inválidos: ' || left(p_message, 200));
  end if;
  return _api_err(500, 'internal_error', 'Error interno. Reintentá más tarde.');
end;
$$;
revoke all on function _api_from_exception(text, text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Límite por cliente: ventana deslizante aproximada (dos ventanas fijas de un
-- minuto, la anterior ponderada por lo que falta). Espejo puro en
-- lib/api-publica/rateLimit.ts. Sólo cuenta lo permitido.
-- -----------------------------------------------------------------------------
create or replace function _api_rate_hit(p_tenant uuid, p_client uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_win     timestamptz := date_trunc('minute', v_now);
  v_elapsed numeric := extract(epoch from (v_now - date_trunc('minute', v_now))) / 60.0;
  v_cur     integer;
  v_prev    integer;
  v_est     numeric;
  v_reset   integer := greatest(1, ceil(60 - v_elapsed * 60)::integer);
begin
  insert into api_rate_windows as w (client_id, window_start, tenant_id, hits)
  values (p_client, v_win, p_tenant, 1)
  on conflict (client_id, window_start) do update set hits = w.hits + 1
  returning w.hits into v_cur;

  if v_cur = 1 then
    delete from api_rate_windows w
     where w.client_id = p_client and w.tenant_id = p_tenant
       and w.window_start < v_win - interval '1 minute';
  end if;

  select w.hits into v_prev from api_rate_windows w
   where w.client_id = p_client and w.window_start = v_win - interval '1 minute';
  v_est := coalesce(v_prev, 0) * (1 - v_elapsed) + v_cur;

  if v_est > p_limit then
    update api_rate_windows w set hits = greatest(w.hits - 1, 0)
     where w.client_id = p_client and w.window_start = v_win;
    return jsonb_build_object('allowed', false, 'limit', p_limit, 'remaining', 0,
                              'reset', v_reset, 'retry_after', v_reset);
  end if;
  return jsonb_build_object('allowed', true, 'limit', p_limit,
                            'remaining', greatest(floor(p_limit - v_est)::integer, 0), 'reset', v_reset);
end;
$$;
revoke all on function _api_rate_hit(uuid, uuid, integer) from public, anon, authenticated;

-- Negocio operativo (no suspendido, cancelado ni dado de baja).
create or replace function _api_tenant_ok(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from tenants t
                  where t.id = p_tenant and t.deleted_at is null
                    and t.status not in ('suspended', 'cancelled'));
$$;
revoke all on function _api_tenant_ok(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Token: POST /api/v1/oauth/token (grant_type=client_credentials).
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

  v_token := 'nsat_' || encode(gen_random_bytes(32), 'hex');
  insert into api_access_tokens (tenant_id, client_id, token_hash, scopes, expires_at)
  values (v_client.tenant_id, v_client.id, _api_sha256(v_token), v_scopes, now() + interval '1 hour')
  returning id into v_tok_id;

  update api_clients c set last_used_at = now()
   where c.id = v_client.id and c.tenant_id = v_client.tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_client.tenant_id, null, 'api_client', v_client.id, 'api_token_issued', null,
          jsonb_build_object('token_id', v_tok_id, 'scopes', to_jsonb(v_scopes)));

  return jsonb_build_object(
    'status', 200,
    'body', jsonb_build_object('access_token', v_token, 'token_type', 'Bearer', 'expires_in', 3600,
                               'scope', array_to_string(v_scopes, ' ')),
    'rate', v_rate);
end;
$$;
revoke all on function api_token_issue(text, text, text) from public, authenticated;
grant execute on function api_token_issue(text, text, text) to anon;

-- -----------------------------------------------------------------------------
-- Autenticación de cada llamada: token -> negocio, cliente, alcance, plan y
-- límite. Devuelve {ok: true, tenant_id, client_id, rate} o un sobre de error
-- con ok = false.
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
  if p_token is null or p_token !~ '^nsat_[0-9a-f]{64}$' then
    return _api_err(401, 'invalid_token', 'Falta el token o no es válido.') || '{"ok": false}'::jsonb;
  end if;

  select t.tenant_id, t.client_id, t.scopes, c.rate_limit_per_min, c.last_used_at
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
                            'rate', v_rate);
end;
$$;
revoke all on function _api_auth(text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Idempotencia (24 h por cliente y clave). Devuelve null si la clave es nueva
-- (queda reservada) o el sobre guardado / un 409.
-- -----------------------------------------------------------------------------
create or replace function _api_idem_begin(p_tenant uuid, p_client uuid, p_key text, p_endpoint text,
                                           p_request_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row api_idempotency_keys;
  v_id  uuid;
begin
  if p_key is null then return null; end if;
  if p_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    perform _api_fail(400, 'invalid_idempotency_key', 'Idempotency-Key: de 8 a 128 caracteres (letras, números, . _ : -).');
  end if;

  delete from api_idempotency_keys k
   where k.client_id = p_client and k.tenant_id = p_tenant and k.key = p_key
     and k.created_at < now() - interval '24 hours';

  insert into api_idempotency_keys (tenant_id, client_id, key, endpoint, request_hash)
  values (p_tenant, p_client, p_key, p_endpoint, p_request_hash)
  on conflict on constraint api_idempotency_keys_client_key do nothing
  returning id into v_id;
  if v_id is not null then return null; end if;

  select * into v_row from api_idempotency_keys k
   where k.client_id = p_client and k.tenant_id = p_tenant and k.key = p_key;
  if v_row.endpoint <> p_endpoint or v_row.request_hash <> p_request_hash then
    perform _api_fail(409, 'idempotency_conflict', 'La Idempotency-Key ya se usó con otro pedido.');
  end if;
  if v_row.status is null then
    perform _api_fail(409, 'idempotency_in_progress', 'Hay un pedido con esa Idempotency-Key en curso.');
  end if;
  return jsonb_build_object('status', v_row.status, 'body', v_row.response, 'replayed', true);
end;
$$;
revoke all on function _api_idem_begin(uuid, uuid, text, text, text) from public, anon, authenticated;

create or replace function _api_idem_finish(p_tenant uuid, p_client uuid, p_key text, p_env jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_key is not null then
    update api_idempotency_keys k
       set status = (p_env ->> 'status')::integer, response = p_env -> 'body'
     where k.client_id = p_client and k.tenant_id = p_tenant and k.key = p_key;
  end if;
  return p_env;
end;
$$;
revoke all on function _api_idem_finish(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- Limpieza diaria de lo vencido (ventanas viejas, tokens e idempotencia).
create or replace function api_publica_cleanup()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from api_rate_windows w where w.window_start < now() - interval '10 minutes';
  delete from api_access_tokens t where t.expires_at < now() - interval '1 day';
  delete from api_idempotency_keys k where k.created_at < now() - interval '24 hours';
end;
$$;
revoke all on function api_publica_cleanup() from public, anon, authenticated;

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite la limpieza diaria de la API pública.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'api-publica-cleanup') then
    perform cron.unschedule('api-publica-cleanup');
  end if;
  perform cron.schedule('api-publica-cleanup', '17 4 * * *', $$select public.api_publica_cleanup()$$);
end;
$cron$;
