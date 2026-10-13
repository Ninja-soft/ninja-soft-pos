-- =============================================================================
-- 20261110400200_mercadolibre_rpc  (H87 · ADR-104 · Mercado Libre MVP)
--
-- Lógica de la integración en la base:
--
--   A) Guardas: ml_assert (UI: rol + feature + cuenta activa del negocio),
--      ml_edge_guard (Edge con service_role).
--   B) Cola: _ml_enqueue (outbox con coalescing), claim/finish de
--      notificaciones y trabajos con FOR UPDATE SKIP LOCKED, backoff y
--      dead-letter; ml_any_due para el cron.
--   C) Tokens: ml_token_lock / release / save / fail (refresh de un solo uso,
--      serializado por cuenta) y ml_account_upsert (alta o reconexión).
--   D) Límite de llamadas: ml_rate_take / ml_rate_block (token bucket por
--      cuenta y familia de recurso).
--   E) Espejo: ml_item_upsert, ml_shipment_upsert, ml_question_upsert.
--   F) Stock y precio por canal: _ml_available_qty, _ml_price_for,
--      ml_item_stock_snapshot, ml_item_price_snapshot, ml_item_pushed y los
--      triggers que encolan pushes (movimientos de stock, depósitos, precio
--      del producto, de la variante y de la lista del canal).
--   G) Ventas: ml_ingest_pack. UNA venta del POS por carrito (pack) o por
--      orden sin carrito, idempotente (lock por pack + sale_id): canal
--      'mercadolibre', medio 'mercadolibre' SIN movimiento de caja, stock de
--      la sucursal/depósito de la cuenta (una sola vez: stock_applied_at),
--      cancelación que revierte (y anula la venta: la NC la emite ARCA si ya
--      estaba facturada). No usa create_sale: create_sale exige turno de
--      caja abierto, usuario y precio del POS; la venta de ML trae su precio
--      y la registra el worker (service_role, sin usuario).
--   H) Facturación: según la cuenta (al pagar, al despachar o a mano) con la
--      cola ARCA existente (arca_enqueue_sale). arca_sales_trg se recrea
--      (copia de 20261101100100 + un bloque ADR-104) para NO encolar al
--      insertar una venta de Mercado Libre. Al aprobarse el comprobante se
--      encola la subida del PDF al pack.
--   I) RPC de la UI: configuración de la cuenta, desconectar, vincular y
--      desvincular, acciones sobre publicaciones, responder preguntas,
--      facturar a mano. Todo en audit_logs (inmutable: sólo inserts).
--
-- tenant_id explícito en cada insert (P8). Policies: ninguna nueva.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Guardas
-- -----------------------------------------------------------------------------
-- UI: devuelve el negocio. p_manage: dueño o encargado; si no, cualquier rol
-- operativo (no solo lectura). p_feature: exige la feature del plan.
create or replace function ml_assert(p_manage boolean default true, p_feature boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
begin
  if v_tenant is null or v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_role = 'viewer' or (p_manage and v_role not in ('owner', 'manager')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_feature and not tenant_has_feature_for(v_tenant, 'mercadolibre') then
    raise exception 'feature_not_in_plan: mercadolibre' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function ml_assert(boolean, boolean) from public, anon;
grant execute on function ml_assert(boolean, boolean) to authenticated;

-- Edge (service_role): null = puede; si no, el código del error.
create or replace function ml_edge_guard(p_tenant uuid, p_user uuid, p_manage boolean default true)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  select tu.role into v_role from tenant_users tu
   where tu.tenant_id = p_tenant and tu.user_id = p_user and tu.status = 'active'
   limit 1;
  if v_role is null or v_role = 'viewer' then return 'forbidden'; end if;
  if p_manage and v_role not in ('owner', 'manager') then return 'forbidden'; end if;
  if not tenant_has_feature_for(p_tenant, 'mercadolibre') then return 'feature_not_in_plan'; end if;
  return null;
end;
$$;
revoke all on function ml_edge_guard(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function ml_edge_guard(uuid, uuid, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- B) Cola
-- -----------------------------------------------------------------------------
-- Encola (o actualiza el pendiente con la misma clave: el último valor gana).
create or replace function _ml_enqueue(
  p_tenant uuid, p_account uuid, p_kind text, p_dedupe text, p_ref text,
  p_payload jsonb, p_delay_seconds integer default 0, p_user uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into ml_sync_jobs (tenant_id, account_id, kind, dedupe_key, ref, payload, next_attempt_at, created_by)
  values (p_tenant, p_account, p_kind, p_dedupe, p_ref, coalesce(p_payload, '{}'::jsonb),
          now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0)), p_user)
  on conflict (dedupe_key) where status = 'pending'
  do update set payload = excluded.payload,
                ref = coalesce(excluded.ref, ml_sync_jobs.ref),
                next_attempt_at = least(ml_sync_jobs.next_attempt_at, excluded.next_attempt_at)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function _ml_enqueue(uuid, uuid, text, text, text, jsonb, integer, uuid) from public, anon, authenticated;

-- ¿Hay algo para el worker? (el cron no llama a la Edge si no).
create or replace function ml_any_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from ml_notifications where status in ('pending', 'error') and next_attempt_at <= now())
      or exists (select 1 from ml_sync_jobs where status in ('pending', 'error') and next_attempt_at <= now())
      or exists (select 1 from ml_notifications where status = 'processing' and locked_until < now())
      or exists (select 1 from ml_sync_jobs where status = 'running' and locked_until < now());
$$;
revoke all on function ml_any_due() from public, anon, authenticated;
grant execute on function ml_any_due() to service_role;

-- Notificación del webhook (o de missed_feeds / búsqueda de órdenes).
-- Devuelve 'stored' | 'duplicate' | 'unknown_user'. Una sola ida a la base:
-- el webhook tiene que responder en menos de 500 ms.
create or replace function ml_notification_ingest(p jsonb)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    bigint;
  v_acc     ml_accounts%rowtype;
  v_id      uuid;
  v_source  text := coalesce(nullif(p ->> 'source', ''), 'webhook');
  v_handled boolean := coalesce((p ->> 'handled')::boolean, true);
  v_result  text;
begin
  begin
    v_user := (p ->> 'user_id')::bigint;
  exception when others then
    v_user := null;
  end;
  if v_user is not null then
    select * into v_acc from ml_accounts a where a.ml_user_id = v_user and a.deleted_at is null limit 1;
  end if;
  if v_acc.id is null then
    v_result := 'unknown_user';
  else
    insert into ml_notifications (tenant_id, account_id, dedupe_key, notification_id, source, topic, resource,
                                  ml_user_id, actions, attempts, sent_at, status, processed_at, last_error)
    values (v_acc.tenant_id, v_acc.id, left(p ->> 'dedupe_key', 400), nullif(p ->> 'notification_id', ''),
            v_source, left(p ->> 'topic', 60), left(p ->> 'resource', 300), v_user,
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'actions', '[]'::jsonb)) x), '{}'),
            coalesce((p ->> 'attempts')::int, 0), nullif(p ->> 'sent', '')::timestamptz,
            case when v_handled then 'pending' else 'ignored' end,
            case when v_handled then null else now() end,
            case when v_handled then null else 'topic_not_in_mvp' end)
    on conflict (dedupe_key) do nothing
    returning id into v_id;
    v_result := case when v_id is null then 'duplicate' else 'stored' end;
  end if;

  if v_source = 'webhook' then
    insert into webhook_events (tenant_id, provider, function_name, status, http_status, payload_ref)
    values (v_acc.tenant_id, 'mercadolibre', 'ml_webhook',
            case when v_result = 'stored' and v_handled then 'ok' else 'ignored' end, 200,
            left(coalesce(p ->> 'topic', '') || ' ' || coalesce(p ->> 'resource', '') || ' ' || v_result, 200));
  end if;
  return v_result;
end;
$$;
revoke all on function ml_notification_ingest(jsonb) from public, anon, authenticated;
grant execute on function ml_notification_ingest(jsonb) to service_role;

create or replace function ml_notifications_claim(p_limit integer default 25)
returns setof ml_notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with c as (
    select n.id from ml_notifications n
     where (n.status in ('pending', 'error') and n.next_attempt_at <= now())
        or (n.status = 'processing' and n.locked_until < now())
     order by n.received_at
     limit least(greatest(coalesce(p_limit, 25), 1), 200)
     for update skip locked
  ), u as (
    update ml_notifications n
       set status = 'processing', locked_until = now() + interval '3 minutes', tries = n.tries + 1
      from c
     where n.id = c.id
    returning n.*
  )
  select * from u;
end;
$$;
revoke all on function ml_notifications_claim(integer) from public, anon, authenticated;
grant execute on function ml_notifications_claim(integer) to service_role;

-- Cierra una notificación. 'done' también cierra las pendientes del mismo
-- recurso recibidas antes de tomarla (el GET ya trajo el estado actual).
create or replace function ml_notification_finish(p_id uuid, p_status text, p_error text default null,
                                                  p_retry_ms integer default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v ml_notifications%rowtype;
begin
  if p_status not in ('done', 'ignored', 'error') then
    raise exception 'invalid_status';
  end if;
  select * into v from ml_notifications where id = p_id for update;
  if not found then return; end if;
  if p_status in ('done', 'ignored') then
    update ml_notifications
       set status = p_status, processed_at = now(), locked_until = null, last_error = left(p_error, 500)
     where id = p_id;
    if p_status = 'done' then
      update ml_notifications
         set status = 'done', processed_at = now(), last_error = 'coalesced'
       where account_id = v.account_id and topic = v.topic and resource = v.resource
         and status in ('pending', 'error') and id <> p_id
         and received_at <= coalesce(v.locked_until, now()) - interval '3 minutes';
    end if;
  else
    update ml_notifications
       set status = case when v.tries >= 10 then 'dead' else 'error' end,
           locked_until = null,
           last_error = left(coalesce(p_error, 'error'), 500),
           next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_ms, 60000), 1000) / 1000.0)
     where id = p_id;
  end if;
end;
$$;
revoke all on function ml_notification_finish(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function ml_notification_finish(uuid, text, text, integer) to service_role;

create or replace function ml_jobs_claim(p_limit integer default 25)
returns setof ml_sync_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with c as (
    select j.id from ml_sync_jobs j
     where (j.status in ('pending', 'error') and j.next_attempt_at <= now())
        or (j.status = 'running' and j.locked_until < now())
     order by j.next_attempt_at
     limit least(greatest(coalesce(p_limit, 25), 1), 200)
     for update skip locked
  ), u as (
    update ml_sync_jobs j
       set status = 'running', locked_until = now() + interval '3 minutes', attempts = j.attempts + 1
      from c
     where j.id = c.id
    returning j.*
  )
  select * from u;
end;
$$;
revoke all on function ml_jobs_claim(integer) from public, anon, authenticated;
grant execute on function ml_jobs_claim(integer) to service_role;

create or replace function ml_job_finish(p_id uuid, p_status text, p_error text default null,
                                         p_result jsonb default null, p_retry_ms integer default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v ml_sync_jobs%rowtype;
begin
  if p_status not in ('done', 'error', 'cancelled', 'retry') then
    raise exception 'invalid_status';
  end if;
  select * into v from ml_sync_jobs where id = p_id for update;
  if not found then return; end if;
  if p_status in ('done', 'cancelled') then
    update ml_sync_jobs
       set status = p_status, locked_until = null, result = p_result, last_error = left(p_error, 500)
     where id = p_id;
  elsif p_status = 'retry' then
    -- Esperar sin gastar un intento (límite de llamadas, lock de token).
    update ml_sync_jobs
       set status = 'error', locked_until = null, attempts = greatest(v.attempts - 1, 0),
           last_error = left(coalesce(p_error, 'retry'), 500),
           next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_ms, 10000), 500) / 1000.0)
     where id = p_id;
  else
    update ml_sync_jobs
       set status = case when v.attempts >= v.max_attempts then 'dead' else 'error' end,
           locked_until = null, result = p_result,
           last_error = left(coalesce(p_error, 'error'), 500),
           next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_ms, 60000), 1000) / 1000.0)
     where id = p_id;
  end if;
end;
$$;
revoke all on function ml_job_finish(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function ml_job_finish(uuid, text, text, jsonb, integer) to service_role;

-- -----------------------------------------------------------------------------
-- C) Tokens y alta de la cuenta
-- -----------------------------------------------------------------------------
create or replace function ml_token_get(p_account uuid)
returns table (access_token text, refresh_token text, expires_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.access_token, t.refresh_token, t.expires_at from ml_tokens t where t.account_id = p_account;
$$;
revoke all on function ml_token_get(uuid) from public, anon, authenticated;
grant execute on function ml_token_get(uuid) to service_role;

-- Toma el lock de renovación (atómico): sólo si está libre o vencido.
create or replace function ml_token_lock(p_account uuid, p_lock uuid, p_seconds integer default 30)
returns table (access_token text, refresh_token text, expires_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_tokens t
     set refresh_lock_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 30), 5), 120)),
         refresh_lock_id = p_lock
   where t.account_id = p_account
     and (t.refresh_lock_until is null or t.refresh_lock_until < now())
  returning t.access_token, t.refresh_token, t.expires_at;
$$;
revoke all on function ml_token_lock(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function ml_token_lock(uuid, uuid, integer) to service_role;

create or replace function ml_token_release(p_account uuid, p_lock uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_tokens set refresh_lock_until = null, refresh_lock_id = null
   where account_id = p_account and refresh_lock_id = p_lock;
$$;
revoke all on function ml_token_release(uuid, uuid) from public, anon, authenticated;
grant execute on function ml_token_release(uuid, uuid) to service_role;

-- Guarda el par nuevo. El refresh de ML es de un solo uso: lo que acaba de
-- devolver ML es lo único válido, así que se guarda si el lock es nuestro o
-- si ya venció (nadie más pudo renovar con el refresh viejo).
create or replace function ml_token_save(p_account uuid, p_lock uuid, p_access text, p_refresh text,
                                         p_expires_at timestamptz, p_scope text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update ml_tokens
     set access_token = p_access,
         refresh_token = coalesce(nullif(p_refresh, ''), refresh_token),
         expires_at = p_expires_at,
         scope = coalesce(p_scope, scope),
         refresh_lock_until = null, refresh_lock_id = null,
         last_refresh_at = now(), refresh_count = refresh_count + 1,
         last_error = null, updated_at = now()
   where account_id = p_account
     and (refresh_lock_id = p_lock or refresh_lock_id is null or refresh_lock_until < now());
  if not found then
    return false;
  end if;
  update ml_accounts set status = 'active', status_reason = null
   where id = p_account and status = 'reauth_required' and deleted_at is null;
  return true;
end;
$$;
revoke all on function ml_token_save(uuid, uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function ml_token_save(uuid, uuid, text, text, timestamptz, text) to service_role;

-- La renovación falló. invalid_grant: la cuenta queda para reconectar.
create or replace function ml_token_fail(p_account uuid, p_lock uuid, p_code text, p_message text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc ml_accounts%rowtype;
begin
  update ml_tokens
     set refresh_lock_until = null, refresh_lock_id = null, last_error = left(coalesce(p_code, '') || ': ' || coalesce(p_message, ''), 500)
   where account_id = p_account and (refresh_lock_id = p_lock or refresh_lock_id is null);
  if p_code = 'invalid_grant' then
    update ml_accounts
       set status = 'reauth_required', status_reason = left(coalesce(p_message, 'Conexión vencida'), 500)
     where id = p_account and status = 'active' and deleted_at is null
    returning * into v_acc;
    if v_acc.id is not null then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_acc.tenant_id, null, 'ml_accounts', v_acc.id, 'ml_account_reauth_required',
              jsonb_build_object('ml_user_id', v_acc.ml_user_id, 'nickname', v_acc.nickname, 'reason', left(p_message, 300)));
    end if;
  end if;
end;
$$;
revoke all on function ml_token_fail(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function ml_token_fail(uuid, uuid, text, text) to service_role;

-- Alta o reconexión de una cuenta desde ml_oauth_callback (service_role).
-- p: {ml_user_id, nickname, site_id, tags[], access_token, refresh_token,
--     expires_at, scope}. Devuelve {ok, account_id, reconnected} o {ok:false, error}.
create or replace function ml_account_upsert(p_tenant uuid, p_user uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ml_user bigint := (p ->> 'ml_user_id')::bigint;
  v_tags    text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'tags', '[]'::jsonb)) x), '{}');
  v_acc     ml_accounts%rowtype;
  v_other   uuid;
  v_re      boolean := false;
  v_store   uuid;
begin
  if p_tenant is null or v_ml_user is null or nullif(p ->> 'access_token', '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  if not tenant_has_feature_for(p_tenant, 'mercadolibre') then
    return jsonb_build_object('ok', false, 'error', 'feature_not_in_plan');
  end if;
  perform pg_advisory_xact_lock(hashtext('ml_account:' || v_ml_user::text));

  -- Una cuenta de ML en un solo negocio.
  select a.tenant_id into v_other from ml_accounts a
   where a.ml_user_id = v_ml_user and a.deleted_at is null and a.tenant_id <> p_tenant limit 1;
  if v_other is not null then
    return jsonb_build_object('ok', false, 'error', 'ml_account_taken');
  end if;

  select * into v_acc from ml_accounts a
   where a.ml_user_id = v_ml_user and a.tenant_id = p_tenant and a.deleted_at is null
   for update;
  if v_acc.id is null then
    -- Reconexión de una cuenta desconectada: se recupera (vínculos e historial).
    select * into v_acc from ml_accounts a
     where a.ml_user_id = v_ml_user and a.tenant_id = p_tenant and a.deleted_at is not null
     order by a.deleted_at desc limit 1
     for update;
    if v_acc.id is not null then
      update ml_accounts set deleted_at = null where id = v_acc.id;
    end if;
  end if;

  if v_acc.id is not null then
    v_re := true;
    update ml_accounts
       set nickname = left(coalesce(p ->> 'nickname', nickname), 120),
           site_id = coalesce(nullif(p ->> 'site_id', ''), site_id),
           tags = v_tags,
           user_product_seller = 'user_product_seller' = any (v_tags),
           status = 'active', status_reason = null, last_error = null,
           connected_by = p_user, connected_at = now()
     where id = v_acc.id
    returning * into v_acc;
  else
    insert into ml_accounts (tenant_id, ml_user_id, nickname, site_id, tags, user_product_seller, connected_by)
    values (p_tenant, v_ml_user, left(coalesce(p ->> 'nickname', ''), 120), coalesce(nullif(p ->> 'site_id', ''), 'MLA'),
            v_tags, 'user_product_seller' = any (v_tags), p_user)
    returning * into v_acc;
  end if;

  insert into ml_tokens (account_id, tenant_id, access_token, refresh_token, scope, expires_at, last_refresh_at)
  values (v_acc.id, p_tenant, p ->> 'access_token', nullif(p ->> 'refresh_token', ''), nullif(p ->> 'scope', ''),
          coalesce(nullif(p ->> 'expires_at', '')::timestamptz, now() + interval '5 hours'), now())
  on conflict (account_id) do update
    set access_token = excluded.access_token, refresh_token = excluded.refresh_token, scope = excluded.scope,
        expires_at = excluded.expires_at, refresh_lock_until = null, refresh_lock_id = null,
        last_refresh_at = now(), last_error = null, updated_at = now();

  -- Origen del stock por defecto: la sucursal principal del negocio.
  if not exists (select 1 from ml_location_map m where m.account_id = v_acc.id and m.location_type = 'item_stock') then
    v_store := stock_default_store(p_tenant);
    insert into ml_location_map (tenant_id, account_id, location_type, store_id)
    values (p_tenant, v_acc.id, 'item_stock', v_store);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, p_user, 'ml_accounts', v_acc.id,
          case when v_re then 'ml_account_reconnected' else 'ml_account_connected' end,
          jsonb_build_object('ml_user_id', v_ml_user, 'nickname', v_acc.nickname, 'site_id', v_acc.site_id,
                             'user_product_seller', v_acc.user_product_seller));
  return jsonb_build_object('ok', true, 'account_id', v_acc.id, 'reconnected', v_re);
end;
$$;
revoke all on function ml_account_upsert(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_account_upsert(uuid, uuid, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- D) Límite de llamadas (token bucket por cuenta y familia).
-- -----------------------------------------------------------------------------
-- Capacidad por minuto (propia, conservadora: ML no publica un global). Stock
-- de User Products: 100 RPM documentado (se usa 90).
create or replace function ml_rate_capacity(p_family text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_family
    when 'stock' then 90
    when 'items' then 300
    when 'orders' then 600
    when 'shipments' then 300
    when 'labels' then 120
    when 'questions' then 300
    when 'invoices' then 60
    when 'oauth' then 30
    else 600
  end::numeric;
$$;

-- Devuelve cuántos ms esperar (0 = se puede llamar ya y se consumió el cupo).
create or replace function ml_rate_take(p_account uuid, p_family text, p_cost numeric default 1)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cap    numeric := ml_rate_capacity(p_family);
  v_rate   numeric := ml_rate_capacity(p_family) / 60.0;  -- tokens por segundo
  v_b      ml_rate_buckets%rowtype;
  v_tokens numeric;
  v_cost   numeric := greatest(coalesce(p_cost, 1), 0.001);
  v_tenant uuid;
begin
  select * into v_b from ml_rate_buckets where account_id = p_account and family = p_family for update;
  if not found then
    select tenant_id into v_tenant from ml_accounts where id = p_account;
    if v_tenant is null then return 0; end if;
    insert into ml_rate_buckets (account_id, family, tenant_id, tokens, refilled_at)
    values (p_account, p_family, v_tenant, v_cap - v_cost, now())
    on conflict (account_id, family) do nothing;
    return 0;
  end if;
  if v_b.blocked_until is not null and v_b.blocked_until > now() then
    return ceil(extract(epoch from (v_b.blocked_until - now())) * 1000)::int;
  end if;
  v_tokens := least(v_cap, v_b.tokens + extract(epoch from (now() - v_b.refilled_at)) * v_rate);
  if v_tokens >= v_cost then
    update ml_rate_buckets set tokens = v_tokens - v_cost, refilled_at = now(), blocked_until = null
     where account_id = p_account and family = p_family;
    return 0;
  end if;
  update ml_rate_buckets set tokens = v_tokens, refilled_at = now()
   where account_id = p_account and family = p_family;
  return ceil((v_cost - v_tokens) / v_rate * 1000)::int;
end;
$$;
revoke all on function ml_rate_take(uuid, text, numeric) from public, anon, authenticated;
grant execute on function ml_rate_take(uuid, text, numeric) to service_role;

-- ML respondió 429: bloquear la familia un rato.
create or replace function ml_rate_block(p_account uuid, p_family text, p_ms integer)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_rate_buckets
     set blocked_until = now() + make_interval(secs => least(greatest(coalesce(p_ms, 10000), 1000), 900000) / 1000.0),
         tokens = 0, refilled_at = now()
   where account_id = p_account and family = p_family;
$$;
revoke all on function ml_rate_block(uuid, text, integer) from public, anon, authenticated;
grant execute on function ml_rate_block(uuid, text, integer) to service_role;

-- -----------------------------------------------------------------------------
-- E) Espejo de recursos de ML.
-- -----------------------------------------------------------------------------
-- p: {ml_item_id, user_product_id, family_id, title, category_id,
--     listing_type_id, status, sub_status[], tags[], logistic_type,
--     shipping_mode, free_shipping, catalog_listing, catalog_product_id,
--     permalink, thumbnail, currency, price, available_quantity, sold_quantity,
--     has_variations, health, price_automation, stock_mode}
create or replace function ml_item_upsert(p_account uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_id     uuid;
begin
  select tenant_id into v_tenant from ml_accounts where id = p_account;
  if v_tenant is null then raise exception 'account_not_found'; end if;
  insert into ml_items (tenant_id, account_id, ml_item_id, user_product_id, family_id, title, category_id,
                        listing_type_id, status, sub_status, tags, logistic_type, shipping_mode, free_shipping,
                        catalog_listing, catalog_product_id, permalink, thumbnail, currency, price,
                        available_quantity, sold_quantity, has_variations, health, price_source, stock_mode,
                        synced_at, deleted_at)
  values (v_tenant, p_account, p ->> 'ml_item_id', nullif(p ->> 'user_product_id', ''), nullif(p ->> 'family_id', ''),
          left(coalesce(p ->> 'title', ''), 300), nullif(p ->> 'category_id', ''), nullif(p ->> 'listing_type_id', ''),
          coalesce(nullif(p ->> 'status', ''), 'active'),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'sub_status', '[]'::jsonb)) x), '{}'),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'tags', '[]'::jsonb)) x), '{}'),
          nullif(p ->> 'logistic_type', ''), nullif(p ->> 'shipping_mode', ''),
          coalesce((p ->> 'free_shipping')::boolean, false), coalesce((p ->> 'catalog_listing')::boolean, false),
          nullif(p ->> 'catalog_product_id', ''), left(nullif(p ->> 'permalink', ''), 500), left(nullif(p ->> 'thumbnail', ''), 500),
          coalesce(nullif(p ->> 'currency', ''), 'ARS'), nullif(p ->> 'price', '')::numeric,
          nullif(p ->> 'available_quantity', '')::integer, nullif(p ->> 'sold_quantity', '')::integer,
          coalesce((p ->> 'has_variations')::boolean, false), nullif(p ->> 'health', '')::numeric,
          case when coalesce((p ->> 'price_automation')::boolean, false) then 'automation' else 'pos' end,
          nullif(p ->> 'stock_mode', ''), now(), null)
  on conflict (account_id, ml_item_id) do update
    set user_product_id = coalesce(excluded.user_product_id, ml_items.user_product_id),
        family_id = coalesce(excluded.family_id, ml_items.family_id),
        title = excluded.title, category_id = excluded.category_id, listing_type_id = excluded.listing_type_id,
        status = excluded.status, sub_status = excluded.sub_status, tags = excluded.tags,
        logistic_type = excluded.logistic_type, shipping_mode = excluded.shipping_mode,
        free_shipping = excluded.free_shipping, catalog_listing = excluded.catalog_listing,
        catalog_product_id = excluded.catalog_product_id, permalink = excluded.permalink,
        thumbnail = excluded.thumbnail, currency = excluded.currency, price = excluded.price,
        available_quantity = excluded.available_quantity, sold_quantity = excluded.sold_quantity,
        has_variations = excluded.has_variations, health = excluded.health,
        -- La automatización de ML manda; si se apagó, vuelve al precio del POS.
        price_source = case when excluded.price_source = 'automation' then 'automation'
                            when ml_items.price_source = 'automation' then 'pos'
                            else ml_items.price_source end,
        stock_mode = coalesce(excluded.stock_mode, ml_items.stock_mode),
        synced_at = now(), deleted_at = null
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function ml_item_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_item_upsert(uuid, jsonb) to service_role;

-- p: ShipmentNormalized (orders.ts). Con la cuenta en 'on_shipped', al
-- despacharse se encola la factura de la venta del pack.
create or replace function ml_shipment_upsert(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc   ml_accounts%rowtype;
  v_ship  bigint := (p ->> 'shipment_id')::bigint;
  v_pack  text;
  v_o     record;
  v_doc   uuid;
  v_n     int := 0;
begin
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  select o.pack_key into v_pack from ml_orders o
   where o.account_id = p_account and (o.shipment_id = v_ship or o.ml_order_id = nullif(p ->> 'order_id', '')::bigint)
   limit 1;
  insert into ml_shipments (tenant_id, account_id, shipment_id, pack_key, mode, logistic_type, status, substatus,
                            tracking_number, tracking_method, cost, city, state, zip, date_created, synced_at)
  values (v_acc.tenant_id, p_account, v_ship, v_pack, nullif(p ->> 'mode', ''), nullif(p ->> 'logistic_type', ''),
          coalesce(nullif(p ->> 'status', ''), 'pending'), nullif(p ->> 'substatus', ''),
          nullif(p ->> 'tracking_number', ''), nullif(p ->> 'tracking_method', ''), nullif(p ->> 'cost', '')::numeric,
          left(nullif(p ->> 'city', ''), 120), left(nullif(p ->> 'state', ''), 120), left(nullif(p ->> 'zip', ''), 20),
          nullif(p ->> 'date_created', '')::timestamptz, now())
  on conflict (account_id, shipment_id) do update
    set pack_key = coalesce(excluded.pack_key, ml_shipments.pack_key), mode = excluded.mode,
        logistic_type = excluded.logistic_type, status = excluded.status, substatus = excluded.substatus,
        tracking_number = excluded.tracking_number, tracking_method = excluded.tracking_method,
        cost = coalesce(excluded.cost, ml_shipments.cost), city = excluded.city, state = excluded.state,
        zip = excluded.zip, synced_at = now();

  if v_pack is not null then
    update ml_orders set shipping_cost = coalesce(nullif(p ->> 'cost', '')::numeric, shipping_cost)
     where account_id = p_account and pack_key = v_pack;
  end if;

  if v_pack is not null and v_acc.invoice_mode = 'on_shipped' and coalesce(p ->> 'status', '') in ('shipped', 'delivered')
     and tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre') then
    for v_o in
      select distinct o.sale_id from ml_orders o
       where o.account_id = p_account and o.pack_key = v_pack and o.sale_id is not null
         and o.invoice_status in ('none', 'pending')
    loop
      v_doc := arca_enqueue_sale(v_o.sale_id, false);
      update ml_orders set invoice_status = case when v_doc is null then 'pending' else 'queued' end,
                           fiscal_document_id = coalesce(v_doc, fiscal_document_id)
       where account_id = p_account and pack_key = v_pack;
      v_n := v_n + 1;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'pack_key', v_pack, 'invoiced', v_n);
end;
$$;
revoke all on function ml_shipment_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_shipment_upsert(uuid, jsonb) to service_role;

-- p: {question_id, ml_item_id, text, status, date_created, from_id, answer_text, answer_date}
create or replace function ml_question_upsert(p_account uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_item   uuid;
  v_id     uuid;
begin
  select tenant_id into v_tenant from ml_accounts where id = p_account;
  if v_tenant is null then raise exception 'account_not_found'; end if;
  select i.id into v_item from ml_items i where i.account_id = p_account and i.ml_item_id = p ->> 'ml_item_id';
  insert into ml_questions (tenant_id, account_id, question_id, ml_item_id, item_row_id, text, status, date_created,
                            from_id, answer_text, answer_date, answer_state)
  values (v_tenant, p_account, (p ->> 'question_id')::bigint, p ->> 'ml_item_id', v_item, left(coalesce(p ->> 'text', ''), 2000),
          coalesce(nullif(p ->> 'status', ''), 'UNANSWERED'), nullif(p ->> 'date_created', '')::timestamptz,
          nullif(p ->> 'from_id', '')::bigint, left(nullif(p ->> 'answer_text', ''), 2000),
          nullif(p ->> 'answer_date', '')::timestamptz,
          case when nullif(p ->> 'answer_text', '') is not null then 'sent' else 'none' end)
  on conflict (account_id, question_id) do update
    set status = excluded.status, item_row_id = coalesce(excluded.item_row_id, ml_questions.item_row_id),
        text = excluded.text,
        answer_text = coalesce(excluded.answer_text, ml_questions.answer_text),
        answer_date = coalesce(excluded.answer_date, ml_questions.answer_date),
        answer_state = case when excluded.answer_text is not null then 'sent' else ml_questions.answer_state end,
        last_error = case when excluded.answer_text is not null then null else ml_questions.last_error end
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function ml_question_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_question_upsert(uuid, jsonb) to service_role;

create or replace function ml_question_answered(p_question uuid, p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_questions
     set answer_state = case when p_ok then 'sent' else 'error' end,
         status = case when p_ok then 'ANSWERED' else status end,
         answer_date = case when p_ok then now() else answer_date end,
         last_error = case when p_ok then null else left(p_error, 500) end
   where id = p_question;
$$;
revoke all on function ml_question_answered(uuid, boolean, text) from public, anon, authenticated;
grant execute on function ml_question_answered(uuid, boolean, text) to service_role;

-- -----------------------------------------------------------------------------
-- F) Stock y precio del canal.
-- -----------------------------------------------------------------------------
-- Stock publicable de un producto/variante para una ubicación de ML:
-- sucursal (menos reservas de clientes), salón o depósito; menos la reserva
-- de seguridad de la cuenta; entero, nunca negativo. null = no lleva stock.
create or replace function _ml_available_qty(p_map ml_location_map, p_product uuid, p_variant uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_track  boolean;
  v_store  uuid := coalesce(p_map.store_id, stock_default_store(p_map.tenant_id));
  v_wh     warehouses%rowtype;
  v_qty    numeric;
begin
  select coalesce(p.track_stock, true) into v_track from products p
   where p.id = p_product and p.tenant_id = p_map.tenant_id and p.deleted_at is null;
  if v_track is null or not v_track or v_store is null then
    return null;
  end if;
  if p_map.warehouse_id is not null then
    select * into v_wh from warehouses w where w.id = p_map.warehouse_id and w.deleted_at is null;
  end if;
  if v_wh.id is not null and v_wh.kind <> 'principal' then
    v_qty := coalesce((select ws.qty from warehouse_stock ws
                        where ws.warehouse_id = v_wh.id and ws.product_id = p_product
                          and ws.variant_id is not distinct from p_variant), 0);
  elsif v_wh.id is not null then
    v_qty := warehouse_principal_qty(v_wh.store_id, p_product, p_variant)
             - stock_reserved_qty(v_wh.store_id, p_product, p_variant, null);
  else
    v_qty := coalesce((select ps.qty from product_stock ps
                        where ps.store_id = v_store and ps.product_id = p_product
                          and ps.variant_id is not distinct from p_variant), 0)
             - stock_reserved_qty(v_store, p_product, p_variant, null);
  end if;
  return greatest(floor(coalesce(v_qty, 0) - coalesce(p_map.reserve_qty, 0)), 0)::integer;
end;
$$;
revoke all on function _ml_available_qty(ml_location_map, uuid, uuid) from public, anon, authenticated;

-- Precio del canal: la lista de precios de la cuenta o el precio del POS con
-- el margen; redondeo hacia arriba al múltiplo configurado.
create or replace function _ml_price_for(p_acc ml_accounts, p_product uuid, p_variant uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v numeric;
begin
  v := _resolve_unit_price(p_acc.tenant_id, p_product, p_variant, 1, null, null, p_acc.price_list_id, now());
  if v is null then return null; end if;
  if p_acc.price_list_id is null and coalesce(p_acc.price_markup_pct, 0) <> 0 then
    v := v * (1 + p_acc.price_markup_pct / 100);
  end if;
  if coalesce(p_acc.price_rounding, 0) > 0 then
    v := ceil(v / p_acc.price_rounding) * p_acc.price_rounding;
  end if;
  return round(v, 2);
end;
$$;
revoke all on function _ml_price_for(ml_accounts, uuid, uuid) from public, anon, authenticated;

-- Lo que el worker manda a ML para una publicación (calculado al enviar).
create or replace function ml_item_stock_snapshot(p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_item ml_items%rowtype;
  v_acc  ml_accounts%rowtype;
  v_map  ml_location_map%rowtype;
begin
  select * into v_item from ml_items where id = p_item;
  if v_item.id is null then return null; end if;
  select * into v_acc from ml_accounts where id = v_item.account_id;
  select * into v_map from ml_location_map m where m.account_id = v_item.account_id and m.location_type = 'item_stock';
  return jsonb_build_object(
    'ml_item_id', v_item.ml_item_id,
    'user_product_id', v_item.user_product_id,
    'stock_mode', v_item.stock_mode,
    'has_variations', v_item.has_variations,
    'push_enabled', v_acc.deleted_at is null and v_acc.status = 'active' and v_acc.stock_sync
                    and coalesce(v_map.push_enabled, true)
                    and tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre'),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('ml_variation_id', l.ml_variation_id::text, 'product_id', l.product_id,
                                          'variant_id', l.variant_id,
                                          'qty', case when v_map.id is null then null
                                                      else _ml_available_qty(v_map, l.product_id, l.variant_id) end)
                       order by l.ml_variation_id nulls first)
        from ml_item_links l where l.item_id = p_item), '[]'::jsonb));
end;
$$;
revoke all on function ml_item_stock_snapshot(uuid) from public, anon, authenticated;
grant execute on function ml_item_stock_snapshot(uuid) to service_role;

create or replace function ml_item_price_snapshot(p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_item ml_items%rowtype;
  v_acc  ml_accounts%rowtype;
begin
  select * into v_item from ml_items where id = p_item;
  if v_item.id is null then return null; end if;
  select * into v_acc from ml_accounts where id = v_item.account_id;
  return jsonb_build_object(
    'ml_item_id', v_item.ml_item_id,
    'price_source', v_item.price_source,
    'has_variations', v_item.has_variations,
    'push_enabled', v_acc.deleted_at is null and v_acc.status = 'active' and v_acc.price_sync
                    and v_item.price_source = 'pos'
                    and tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre'),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('ml_variation_id', l.ml_variation_id::text,
                                          'price', _ml_price_for(v_acc, l.product_id, l.variant_id))
                       order by l.ml_variation_id nulls first)
        from ml_item_links l where l.item_id = p_item), '[]'::jsonb));
end;
$$;
revoke all on function ml_item_price_snapshot(uuid) from public, anon, authenticated;
grant execute on function ml_item_price_snapshot(uuid) to service_role;

create or replace function ml_item_pushed(p_item uuid, p jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_items
     set last_pushed_qty = coalesce(nullif(p ->> 'qty', '')::integer, last_pushed_qty),
         available_quantity = coalesce(nullif(p ->> 'qty', '')::integer, available_quantity),
         last_pushed_price = coalesce(nullif(p ->> 'price', '')::numeric, last_pushed_price),
         price = coalesce(nullif(p ->> 'price', '')::numeric, price),
         stock_mode = coalesce(nullif(p ->> 'stock_mode', ''), stock_mode),
         price_source = case when p ->> 'price_source' = 'automation' then 'automation' else price_source end,
         status = coalesce(nullif(p ->> 'status', ''), status),
         last_error = nullif(p ->> 'error', ''),
         last_pushed_at = now()
   where id = p_item;
$$;
revoke all on function ml_item_pushed(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_item_pushed(uuid, jsonb) to service_role;

-- Encola pushes de las publicaciones vinculadas a un producto (o variante).
create or replace function _ml_enqueue_item_pushes(p_tenant uuid, p_product uuid, p_variant uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in
    select distinct l.item_id, l.account_id
      from ml_item_links l
      join ml_accounts a on a.id = l.account_id
     where l.tenant_id = p_tenant and l.product_id = p_product
       and (p_variant is null or l.variant_id is null or l.variant_id = p_variant)
       and a.deleted_at is null and a.status = 'active'
       and (case when p_kind = 'stock_push' then a.stock_sync else a.price_sync end)
  loop
    perform _ml_enqueue(p_tenant, r.account_id, p_kind, p_kind || ':' || r.item_id::text, null,
                        jsonb_build_object('item_id', r.item_id), 5, null);
  end loop;
end;
$$;
revoke all on function _ml_enqueue_item_pushes(uuid, uuid, uuid, text) from public, anon, authenticated;

-- Triggers: nunca frenan la operación del POS.
create or replace function trg_ml_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row stock_movements;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  if not exists (select 1 from ml_item_links l where l.product_id = v_row.product_id) then
    return null;
  end if;
  begin
    perform _ml_enqueue_item_pushes(v_row.tenant_id, v_row.product_id, v_row.variant_id, 'stock_push');
  exception when others then
    raise warning 'trg_ml_stock_movement: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_ml_stock_movement() from public, anon, authenticated;
drop trigger if exists ml_stock_movement_push on stock_movements;
create trigger ml_stock_movement_push
  after insert or delete on stock_movements
  for each row execute function trg_ml_stock_movement();

create or replace function trg_ml_warehouse_stock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row warehouse_stock;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  if not exists (select 1 from ml_item_links l where l.product_id = v_row.product_id) then
    return null;
  end if;
  begin
    perform _ml_enqueue_item_pushes(v_row.tenant_id, v_row.product_id, v_row.variant_id, 'stock_push');
  exception when others then
    raise warning 'trg_ml_warehouse_stock: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_ml_warehouse_stock() from public, anon, authenticated;
drop trigger if exists ml_warehouse_stock_push on warehouse_stock;
create trigger ml_warehouse_stock_push
  after insert or update of qty or delete on warehouse_stock
  for each row execute function trg_ml_warehouse_stock();

create or replace function trg_ml_price_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid;
  v_product uuid;
  v_variant uuid;
  v_list    uuid;
begin
  if tg_table_name = 'products' then
    v_tenant := new.tenant_id; v_product := new.id; v_variant := null;
  elsif tg_table_name = 'product_variants' then
    v_tenant := new.tenant_id; v_product := new.product_id; v_variant := new.id;
  else
    if tg_op = 'DELETE' then
      v_tenant := old.tenant_id; v_product := old.product_id; v_variant := old.variant_id; v_list := old.price_list_id;
    else
      v_tenant := new.tenant_id; v_product := new.product_id; v_variant := new.variant_id; v_list := new.price_list_id;
    end if;
    if not exists (select 1 from ml_accounts a where a.tenant_id = v_tenant and a.price_list_id = v_list
                                                 and a.deleted_at is null) then
      return null;
    end if;
  end if;
  if not exists (select 1 from ml_item_links l where l.product_id = v_product) then
    return null;
  end if;
  begin
    perform _ml_enqueue_item_pushes(v_tenant, v_product, v_variant, 'price_push');
  exception when others then
    raise warning 'trg_ml_price_change: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_ml_price_change() from public, anon, authenticated;
drop trigger if exists ml_price_push on products;
create trigger ml_price_push
  after update of price on products
  for each row when (new.price is distinct from old.price)
  execute function trg_ml_price_change();
drop trigger if exists ml_price_push on product_variants;
create trigger ml_price_push
  after update of price_override on product_variants
  for each row when (new.price_override is distinct from old.price_override)
  execute function trg_ml_price_change();
drop trigger if exists ml_price_push on price_list_items;
create trigger ml_price_push
  after insert or update or delete on price_list_items
  for each row execute function trg_ml_price_change();

-- -----------------------------------------------------------------------------
-- G) Ventas: orden (o carrito) de ML -> venta del POS.
-- -----------------------------------------------------------------------------
-- Suma o resta el stock de una línea en la sucursal (y el depósito de la
-- cuenta si no es el salón). Devuelve lo sacado del depósito (para revertir
-- exacto). Sin chequeo de faltante: ML ya vendió; si no alcanza, el stock
-- queda negativo y la pantalla de stock lo marca.
create or replace function _ml_stock_apply(p_tenant uuid, p_sale uuid, p_store uuid, p_wh uuid,
                                           p_product uuid, p_variant uuid, p_qty numeric, p_wh_back numeric,
                                           p_reason text)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind  text;
  v_avail numeric;
  v_take  numeric := 0;
begin
  if coalesce(p_qty, 0) = 0 then return 0; end if;
  if p_variant is not null then
    update product_variants set stock = stock - p_qty, updated_at = now()
     where id = p_variant and tenant_id = p_tenant;
  else
    update products set stock = stock - p_qty, updated_at = now()
     where id = p_product and tenant_id = p_tenant;
  end if;
  insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id)
  values (p_tenant, p_product, p_variant, p_store, -p_qty, p_reason, p_sale);

  if p_wh is not null then
    select w.kind into v_kind from warehouses w where w.id = p_wh and w.tenant_id = p_tenant and w.deleted_at is null;
    if v_kind is not null and v_kind <> 'principal' then
      if p_qty > 0 then
        select coalesce(ws.qty, 0) into v_avail from warehouse_stock ws
         where ws.warehouse_id = p_wh and ws.product_id = p_product and ws.variant_id is not distinct from p_variant
         for update;
        v_take := least(coalesce(v_avail, 0), p_qty);
        if v_take > 0 then
          perform warehouse_apply(p_tenant, p_wh, p_product, p_variant, -v_take);
        end if;
      elsif coalesce(p_wh_back, 0) > 0 then
        perform warehouse_apply(p_tenant, p_wh, p_product, p_variant, p_wh_back);
        v_take := -p_wh_back;
      end if;
    end if;
  end if;
  return v_take;
end;
$$;
revoke all on function _ml_stock_apply(uuid, uuid, uuid, uuid, uuid, uuid, numeric, numeric, text) from public, anon, authenticated;

-- Revierte el stock de UNA orden (cancelada). Idempotente (stock_reverted_at).
create or replace function _ml_order_revert(p_order uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o   ml_orders%rowtype;
  v_l   jsonb;
  v_map ml_location_map%rowtype;
begin
  select * into v_o from ml_orders where id = p_order for update;
  if v_o.id is null or v_o.stock_applied_at is null or v_o.stock_reverted_at is not null then
    return false;
  end if;
  for v_l in select value from jsonb_array_elements(v_o.lines) loop
    continue when not coalesce((v_l ->> 'applied')::boolean, false);
    perform _ml_stock_apply(v_o.tenant_id, v_o.sale_id, (v_l ->> 'store_id')::uuid, nullif(v_l ->> 'warehouse_id', '')::uuid,
                            (v_l ->> 'product_id')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
                            -((v_l ->> 'quantity')::numeric), coalesce((v_l ->> 'wh_taken')::numeric, 0), 'sale_void');
  end loop;
  update ml_orders set stock_reverted_at = now() where id = p_order;
  return true;
end;
$$;
revoke all on function _ml_order_revert(uuid) from public, anon, authenticated;

-- p: PackPayload (orders.ts). Devuelve {ok, decision, sale_id, number}.
create or replace function ml_ingest_pack(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc        ml_accounts%rowtype;
  v_tenant     uuid;
  v_pack       text := nullif(btrim(coalesce(p ->> 'pack_key', '')), '');
  v_o          jsonb;
  v_l          jsonb;
  v_all_paid   boolean;
  v_all_cancel boolean;
  v_any_cancel boolean;
  v_fraud      boolean;
  v_sale       uuid;
  v_sale_row   sales%rowtype;
  v_map        ml_location_map%rowtype;
  v_store      uuid;
  v_bill       jsonb := case when jsonb_typeof(p -> 'billing') = 'object' then p -> 'billing' end;
  v_doc        text;
  v_customer   uuid;
  v_lines      jsonb := '[]'::jsonb;
  v_lp         uuid;
  v_lv         uuid;
  v_tax_in     jsonb := '[]'::jsonb;
  v_tax        jsonb;
  v_tl         jsonb;
  v_total      numeric := 0;
  v_gross      numeric;
  v_number     bigint;
  v_i          int := 0;
  v_pname      text;
  v_psku       text;
  v_track      boolean;
  v_taken      numeric;
  v_fiscal     uuid;
  v_decision   text;
  v_ord        record;
  v_reverted   int := 0;
  v_unlinked   int;
begin
  if v_pack is null or jsonb_typeof(p -> 'orders') <> 'array' or jsonb_array_length(p -> 'orders') = 0 then
    raise exception 'invalid_payload';
  end if;
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  v_tenant := v_acc.tenant_id;
  if not tenant_has_feature_for(v_tenant, 'mercadolibre') then
    return jsonb_build_object('ok', false, 'error', 'feature_not_in_plan');
  end if;
  -- Dos notificaciones del mismo carrito no crean dos ventas.
  perform pg_advisory_xact_lock(hashtext('ml_pack:' || p_account::text || ':' || v_pack));

  -- 1) Espejo de cada orden (no pisa con un estado más viejo).
  for v_o in select value from jsonb_array_elements(p -> 'orders') loop
    insert into ml_orders (tenant_id, account_id, ml_order_id, pack_key, pack_id, status, status_detail, tags,
                           date_created, date_closed, ml_last_updated, total_amount, paid_amount, currency,
                           sale_fee_total, buyer_id, buyer_nickname, shipment_id, fraud_risk, cancel_detail, lines)
    values (v_tenant, p_account, (v_o ->> 'ml_order_id')::bigint, v_pack, nullif(p ->> 'pack_id', '')::bigint,
            left(coalesce(v_o ->> 'status', 'unknown'), 40), left(v_o ->> 'status_detail', 200),
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_o -> 'tags', '[]'::jsonb)) x), '{}'),
            nullif(v_o ->> 'date_created', '')::timestamptz, nullif(v_o ->> 'date_closed', '')::timestamptz,
            nullif(v_o ->> 'last_updated', '')::timestamptz,
            coalesce((v_o ->> 'total_amount')::numeric, 0), coalesce((v_o ->> 'paid_amount')::numeric, 0),
            coalesce(nullif(v_o ->> 'currency', ''), 'ARS'), coalesce((v_o ->> 'sale_fee_total')::numeric, 0),
            nullif(v_o -> 'buyer' ->> 'id', '')::bigint, left(v_o -> 'buyer' ->> 'nickname', 120),
            nullif(v_o ->> 'shipment_id', '')::bigint, coalesce((v_o ->> 'fraud_risk')::boolean, false),
            case when jsonb_typeof(v_o -> 'cancel_detail') = 'object' then v_o -> 'cancel_detail' end,
            coalesce(v_o -> 'lines', '[]'::jsonb))
    on conflict (account_id, ml_order_id) do update
      set status = excluded.status, status_detail = excluded.status_detail, tags = excluded.tags,
          date_closed = excluded.date_closed, ml_last_updated = excluded.ml_last_updated,
          total_amount = excluded.total_amount, paid_amount = excluded.paid_amount,
          sale_fee_total = excluded.sale_fee_total, shipment_id = coalesce(excluded.shipment_id, ml_orders.shipment_id),
          fraud_risk = excluded.fraud_risk, cancel_detail = excluded.cancel_detail,
          pack_key = excluded.pack_key, pack_id = excluded.pack_id,
          -- Las líneas resueltas (producto, stock aplicado) no se pisan después de la venta.
          lines = case when ml_orders.sale_id is null then excluded.lines else ml_orders.lines end
      where ml_orders.ml_last_updated is null or excluded.ml_last_updated is null
         or excluded.ml_last_updated >= ml_orders.ml_last_updated;
  end loop;

  -- Costo de envío (si vino el envío normalizado).
  if jsonb_typeof(p -> 'shipment') = 'object' and nullif(p -> 'shipment' ->> 'cost', '') is not null then
    update ml_orders set shipping_cost = (p -> 'shipment' ->> 'cost')::numeric
     where account_id = p_account and pack_key = v_pack;
  end if;

  -- 2) Estado del carrito completo.
  select bool_and(o.status = 'paid'), bool_and(o.status in ('cancelled', 'invalid')),
         bool_or(o.status in ('cancelled', 'invalid')), bool_or(o.fraud_risk), max(o.sale_id::text)::uuid
    into v_all_paid, v_all_cancel, v_any_cancel, v_fraud, v_sale
    from ml_orders o
   where o.account_id = p_account and o.pack_key = v_pack;

  -- 2.a) Fraude sin venta: no se crea (ML la cancela; no despachar).
  if v_fraud and v_sale is null then
    update ml_orders set needs_review = 'Mercado Libre detectó riesgo de fraude: no despachar.'
     where account_id = p_account and pack_key = v_pack;
    return jsonb_build_object('ok', true, 'decision', 'fraud');
  end if;
  if v_fraud then
    update ml_orders set needs_review = 'Mercado Libre detectó riesgo de fraude después del pago: no despachar; se anula si ML la cancela.'
     where account_id = p_account and pack_key = v_pack and needs_review is null;
  end if;

  -- 2.b) Cancelaciones: revierte el stock de cada orden cancelada.
  if v_any_cancel then
    for v_ord in
      select o.id from ml_orders o
       where o.account_id = p_account and o.pack_key = v_pack and o.status in ('cancelled', 'invalid')
    loop
      if _ml_order_revert(v_ord.id) then v_reverted := v_reverted + 1; end if;
    end loop;
    if v_all_cancel then
      if v_sale is not null then
        update sales
           set status = 'voided', voided_at = now(), void_reason = 'Cancelada en Mercado Libre'
         where id = v_sale and tenant_id = v_tenant and status = 'completed';
        if found then
          insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
          values (v_tenant, null, 'sales', v_sale, 'ml_sale_cancelled',
                  jsonb_build_object('pack_key', v_pack, 'reverted_orders', v_reverted));
        end if;
      end if;
      update ml_orders set needs_review = null
       where account_id = p_account and pack_key = v_pack and needs_review like 'Carrito%';
      return jsonb_build_object('ok', true, 'decision', 'cancel', 'sale_id', v_sale, 'reverted', v_reverted);
    end if;
    update ml_orders set needs_review = 'Carrito con órdenes canceladas y otras no: revisá la venta (devolución parcial).'
     where account_id = p_account and pack_key = v_pack and needs_review is null;
    if v_reverted > 0 then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, null, 'sales', v_sale, 'ml_order_partial_cancel',
              jsonb_build_object('pack_key', v_pack, 'reverted_orders', v_reverted));
    end if;
    return jsonb_build_object('ok', true, 'decision', 'partial_cancel', 'sale_id', v_sale, 'reverted', v_reverted);
  end if;

  if v_sale is not null then
    return jsonb_build_object('ok', true, 'decision', 'noop', 'sale_id', v_sale);
  end if;
  if not coalesce(v_all_paid, false) then
    return jsonb_build_object('ok', true, 'decision', 'wait_payment');
  end if;

  -- 3) Crear la venta.
  perform assert_account_active(v_tenant);
  select * into v_map from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  v_store := coalesce(v_map.store_id, stock_default_store(v_tenant));
  if v_store is null then raise exception 'no_store'; end if;
  if v_map.warehouse_id is not null and not exists (
       select 1 from warehouses w where w.id = v_map.warehouse_id and w.store_id = v_store and w.deleted_at is null) then
    v_map.warehouse_id := null;
  end if;

  -- Cliente desde los datos de facturación (o consumidor final).
  if v_bill is not null then
    v_doc := nullif(regexp_replace(coalesce(v_bill ->> 'docNumber', ''), '\D', '', 'g'), '');
    if v_doc is not null then
      select c.id into v_customer from customers c
       where c.tenant_id = v_tenant and c.deleted_at is null
         and regexp_replace(coalesce(c.document_number, ''), '\D', '', 'g') = v_doc
       order by c.created_at limit 1;
      if v_customer is null then
        insert into customers (tenant_id, name, document_type, document_number, iva_condition, address, metadata)
        values (v_tenant, left(coalesce(nullif(v_bill ->> 'name', ''), 'Comprador de Mercado Libre'), 200),
                case when v_bill ->> 'docType' in ('cuit', 'cuil', 'dni', 'passport', 'other') then v_bill ->> 'docType' else 'other' end,
                v_doc,
                case when v_bill ->> 'ivaCondition' in ('consumidor_final', 'responsable_inscripto', 'monotributo',
                                                        'monotributo_social', 'exento', 'no_alcanzado', 'no_categorizado')
                     then v_bill ->> 'ivaCondition' else 'consumidor_final' end,
                left(v_bill ->> 'address', 300),
                jsonb_build_object('source', 'mercadolibre', 'ml_account_id', p_account,
                                   'taxpayer_type', v_bill ->> 'taxpayerRaw'))
        returning id into v_customer;
      end if;
    end if;
  end if;

  -- Líneas: publicación (y variación) vinculada -> producto/variante del POS.
  for v_ord in
    select o.id, o.ml_order_id, o.lines from ml_orders o
     where o.account_id = p_account and o.pack_key = v_pack order by o.ml_order_id
  loop
    for v_l in select value from jsonb_array_elements(v_ord.lines) loop
      v_lp := null; v_lv := null;
      select l.product_id, l.variant_id into v_lp, v_lv
        from ml_item_links l
        join ml_items i on i.id = l.item_id
       where i.account_id = p_account and i.ml_item_id = v_l ->> 'ml_item_id'
         and (l.ml_variation_id is null or l.ml_variation_id::text = coalesce(v_l ->> 'ml_variation_id', ''))
       order by (l.ml_variation_id is null)
       limit 1;
      v_gross := round(coalesce((v_l ->> 'unit_price')::numeric, 0) * coalesce((v_l ->> 'quantity')::numeric, 0), 2);
      v_total := v_total + v_gross;
      v_lines := v_lines || jsonb_build_array(v_l || jsonb_build_object(
        'order_row', v_ord.id, 'product_id', v_lp, 'variant_id', v_lv, 'gross', v_gross));
      v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object(
        'product_id', v_lp, 'variant_id', v_lv,
        'quantity', coalesce((v_l ->> 'quantity')::numeric, 0), 'gross', v_gross));
    end loop;
  end loop;
  if v_total <= 0 then raise exception 'empty_sale'; end if;

  -- Desglose fiscal (letra según emisor y receptor). La venta de ML no lleva
  -- percepciones: el precio lo fijó ML y ya está cobrado.
  v_tax := _sale_tax_compute(v_tenant, v_customer, v_tax_in, v_total, now());

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from sales where tenant_id = v_tenant;

  insert into sales (tenant_id, store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes, channel, channel_ref,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total, created_by)
  values (v_tenant, v_store, null, v_customer, v_number, 'completed',
          v_total, 0,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0),
          v_total, left('Mercado Libre ' || case when nullif(p ->> 'pack_id', '') is not null then 'carrito ' else 'orden ' end || v_pack, 200),
          'mercadolibre', v_pack,
          v_tax ->> 'letter',
          jsonb_build_object('emitter', v_tax -> 'emitter', 'receptor', v_tax -> 'receptor',
                             'requires_identification', v_tax -> 'requires_identification',
                             'warnings', v_tax -> 'warnings'),
          coalesce((v_tax ->> 'net_taxed')::numeric, 0), coalesce((v_tax ->> 'net_exempt')::numeric, 0),
          coalesce((v_tax ->> 'net_untaxed')::numeric, 0), coalesce((v_tax ->> 'iva_total')::numeric, 0),
          coalesce((v_tax ->> 'internal_total')::numeric, 0), 0, null)
  returning * into v_sale_row;
  v_sale := v_sale_row.id;

  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, rate_code, rate, base, amount, arca_id, source)
  select v_tenant, v_sale, 'iva', 'iva', x.code, x.rate, x.base, x.amount, x.arca_id, 'product'
    from jsonb_to_recordset(coalesce(v_tax -> 'iva', '[]'::jsonb))
      as x(code text, rate numeric, base numeric, amount numeric, arca_id int);
  if coalesce((v_tax ->> 'internal_total')::numeric, 0) > 0 then
    insert into sale_tax_lines (tenant_id, sale_id, kind, tax, base, amount, arca_id, source, name)
    values (v_tenant, v_sale, 'internos', 'internos', coalesce((v_tax ->> 'internal_base')::numeric, 0),
            (v_tax ->> 'internal_total')::numeric, 4, 'product', 'Impuestos internos');
  end if;

  -- Renglones y stock (una sola vez; la cancelación revierte lo mismo).
  for v_i in 0 .. jsonb_array_length(v_lines) - 1 loop
    v_l := v_lines -> v_i;
    v_tl := v_tax -> 'lines' -> v_i;
    v_pname := null; v_psku := null; v_track := false; v_taken := 0;
    if nullif(v_l ->> 'product_id', '') is not null then
      select p2.name, p2.sku, coalesce(p2.track_stock, true) and not coalesce(p2.is_kit, false)
        into v_pname, v_psku, v_track
        from products p2 where p2.id = (v_l ->> 'product_id')::uuid and p2.tenant_id = v_tenant;
      if nullif(v_l ->> 'variant_id', '') is not null then
        select v_pname || ' · ' || v.option1 || coalesce(' / ' || v.option2, ''), coalesce(v.sku, v_psku)
          into v_pname, v_psku
          from product_variants v where v.id = (v_l ->> 'variant_id')::uuid and v.tenant_id = v_tenant;
      end if;
    end if;
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale, nullif(v_l ->> 'product_id', '')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
            left(coalesce(v_pname, v_l ->> 'title', 'Publicación de Mercado Libre'), 250),
            coalesce(v_psku, nullif(v_l ->> 'seller_sku', '')), null,
            (v_l ->> 'quantity')::numeric, (v_l ->> 'unit_price')::numeric, 0, (v_l ->> 'gross')::numeric, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
    if v_track then
      v_taken := _ml_stock_apply(v_tenant, v_sale, v_store, v_map.warehouse_id,
                                 (v_l ->> 'product_id')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
                                 (v_l ->> 'quantity')::numeric, 0, 'sale');
    end if;
    v_lines := jsonb_set(v_lines, array[v_i::text],
                         v_l || jsonb_build_object('applied', v_track, 'store_id', v_store,
                                                   'warehouse_id', v_map.warehouse_id, 'wh_taken', v_taken));
  end loop;

  -- Cobro del canal: sin caja (lo liquida Mercado Pago).
  insert into payments (tenant_id, sale_id, method, amount, reference, card_voucher)
  values (v_tenant, v_sale, 'mercadolibre', v_total, left('ML ' || v_pack, 120), '{}'::jsonb);

  -- Cada orden guarda sus líneas resueltas (para revertir exacto).
  for v_ord in
    select o.id from ml_orders o where o.account_id = p_account and o.pack_key = v_pack
  loop
    select count(*) filter (where nullif(x ->> 'product_id', '') is null) into v_unlinked
      from jsonb_array_elements(v_lines) x where (x ->> 'order_row')::uuid = v_ord.id;
    update ml_orders
       set sale_id = v_sale, stock_applied_at = now(),
           lines = coalesce((select jsonb_agg(x - 'order_row') from jsonb_array_elements(v_lines) x
                              where (x ->> 'order_row')::uuid = v_ord.id), '[]'::jsonb),
           unlinked_lines = coalesce(v_unlinked, 0),
           needs_review = case when coalesce(v_unlinked, 0) > 0
                               then 'Hay publicaciones sin vincular: la venta se registró sin descontar su stock.'
                               else needs_review end,
           invoice_status = case v_acc.invoice_mode when 'none' then 'not_applicable'
                                                    when 'ml_billing' then 'not_applicable'
                                                    else 'pending' end
     where id = v_ord.id;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, null, 'sales', v_sale, 'ml_sale_ingested',
          jsonb_build_object('pack_key', v_pack, 'sale_number', v_number, 'total', v_total,
                             'orders', (select jsonb_agg(o.ml_order_id) from ml_orders o
                                         where o.account_id = p_account and o.pack_key = v_pack),
                             'account_id', p_account),
          v_store);

  -- Facturación al pagar (cola ARCA existente; nunca frena la venta).
  if v_acc.invoice_mode = 'on_paid' then
    begin
      v_fiscal := arca_enqueue_sale(v_sale, false);
      if v_fiscal is not null then
        update ml_orders set invoice_status = 'queued', fiscal_document_id = v_fiscal
         where account_id = p_account and pack_key = v_pack;
      end if;
    exception when others then
      raise warning 'ml_ingest_pack arca: %', sqlerrm;
    end;
  end if;

  return jsonb_build_object('ok', true, 'decision', 'create_sale', 'sale_id', v_sale, 'number', v_number,
                            'total', v_total);
end;
$$;
revoke all on function ml_ingest_pack(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_ingest_pack(uuid, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- H) Facturación
-- -----------------------------------------------------------------------------
-- Copia de arca_sales_trg (20261101100100, la única definición) con un bloque
-- ADR-104: la venta de Mercado Libre no se encola al insertarse (la factura
-- según la cuenta: al pagar, al despachar o a mano). La anulación sigue igual.
create or replace function arca_sales_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from arca_settings where tenant_id = new.tenant_id and enabled) then
    return null;
  end if;
  begin
    if tg_op = 'INSERT' then
      if new.status = 'completed' then
        -- ADR-104 >>>
        if new.channel is distinct from 'mercadolibre' then
          perform arca_enqueue_sale(new.id, false);
        end if;
        -- <<< ADR-104
      end if;
    elsif new.status is distinct from old.status then
      if new.status = 'completed' then
        perform arca_enqueue_sale(new.id, false);
      elsif new.status = 'voided' then
        perform arca_on_void(new.id);
      end if;
    end if;
  exception when others then
    -- La facturación nunca frena una venta: queda para emitir a mano.
    raise warning 'arca_sales_trg: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function arca_sales_trg() from public, anon, authenticated;

-- Comprobante de una venta de ML aprobado (o con problemas): estado en la
-- orden y, si la cuenta sube la factura, el trabajo de subida al pack.
create or replace function trg_ml_fiscal_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if new.origin <> 'sale' or new.status is not distinct from old.status then
    return null;
  end if;
  if not exists (select 1 from ml_orders o where o.sale_id = new.sale_id) then
    return null;
  end if;
  begin
    for r in
      select distinct o.account_id, o.pack_key, a.upload_invoice, a.tenant_id
        from ml_orders o join ml_accounts a on a.id = o.account_id
       where o.sale_id = new.sale_id
    loop
      if new.status = 'aprobado' then
        update ml_orders set invoice_status = 'approved', fiscal_document_id = new.id
         where account_id = r.account_id and pack_key = r.pack_key;
        if r.upload_invoice then
          perform _ml_enqueue(r.tenant_id, r.account_id, 'invoice_upload', 'invoice_upload:' || new.id::text,
                              r.pack_key, jsonb_build_object('fiscal_document_id', new.id, 'pack_key', r.pack_key,
                                                             'sale_id', new.sale_id), 0, null);
        end if;
      elsif new.status in ('rechazado', 'requiere_accion') then
        update ml_orders set invoice_status = 'error', fiscal_document_id = new.id
         where account_id = r.account_id and pack_key = r.pack_key;
      elsif new.status in ('pendiente', 'enviando') then
        update ml_orders set invoice_status = 'queued', fiscal_document_id = new.id
         where account_id = r.account_id and pack_key = r.pack_key and invoice_status <> 'uploaded';
      end if;
    end loop;
  exception when others then
    raise warning 'trg_ml_fiscal_status: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_ml_fiscal_status() from public, anon, authenticated;
drop trigger if exists ml_fiscal_status on fiscal_documents;
create trigger ml_fiscal_status
  after update of status on fiscal_documents
  for each row execute function trg_ml_fiscal_status();

-- Datos del PDF del comprobante (worker, invoice_upload).
create or replace function ml_invoice_pdf_data(p_doc uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc  fiscal_documents%rowtype;
  v_sale sales%rowtype;
  v_tax  jsonb;
  v_b    tenant_branding%rowtype;
  v_rec  jsonb;
begin
  select * into v_doc from fiscal_documents where id = p_doc;
  if v_doc.id is null or v_doc.status <> 'aprobado' then return null; end if;
  select * into v_sale from sales where id = v_doc.sale_id;
  select * into v_b from tenant_branding where tenant_id = v_doc.tenant_id;
  v_tax := _tax_settings_eff(v_doc.tenant_id);
  v_rec := coalesce(v_doc.receptor_override, v_sale.fiscal_snapshot -> 'receptor', '{}'::jsonb);
  return jsonb_build_object(
    'emitter', jsonb_build_object(
      'name', coalesce(nullif(v_b.legal_name, ''), (select t.name from tenants t where t.id = v_doc.tenant_id)),
      'cuit', v_tax ->> 'cuit', 'ivaCondition', v_tax ->> 'iva_condition', 'address', v_b.address,
      'iibb', v_tax ->> 'iibb_number', 'activityStart', v_tax ->> 'activity_start'),
    'doc', jsonb_build_object(
      'letter', v_doc.cbte_letter, 'cbteTipo', v_doc.cbte_tipo, 'ptoVta', v_doc.pto_vta, 'nro', v_doc.cbte_nro,
      'fecha', v_doc.cbte_fch, 'cae', v_doc.cae, 'caeVto', v_doc.cae_vto, 'qrUrl', v_doc.qr_url,
      'total', v_doc.imp_total, 'netTaxed', v_sale.net_taxed, 'iva', v_sale.iva_total,
      'otherTaxes', coalesce(v_sale.internal_tax_total, 0) + coalesce(v_sale.perception_total, 0)),
    'receptor', jsonb_build_object(
      'name', coalesce(v_rec ->> 'name', 'Consumidor Final'), 'docType', v_rec ->> 'doc_type',
      'docNumber', nullif(v_rec ->> 'doc_number', '0'), 'ivaCondition', v_rec ->> 'iva_condition',
      'address', v_rec ->> 'address'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('description', i.product_name, 'qty', i.quantity,
                                                           'unitPrice', i.unit_price, 'subtotal', i.subtotal)
                                        order by i.created_at, i.id)
                         from sale_items i where i.sale_id = v_sale.id), '[]'::jsonb),
    'notes', 'Venta en Mercado Libre ' || coalesce(v_sale.channel_ref, ''));
end;
$$;
revoke all on function ml_invoice_pdf_data(uuid) from public, anon, authenticated;
grant execute on function ml_invoice_pdf_data(uuid) to service_role;

create or replace function ml_invoice_uploaded(p_account uuid, p_pack text, p_doc uuid, p_ok boolean,
                                               p_ml_id text default null, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  update ml_orders
     set invoice_status = case when p_ok then 'uploaded' else invoice_status end,
         ml_fiscal_doc_id = case when p_ok then left(p_ml_id, 120) else ml_fiscal_doc_id end,
         needs_review = case when p_ok then needs_review
                             else left('No se pudo subir la factura a Mercado Libre: ' || coalesce(p_error, ''), 300) end
   where account_id = p_account and pack_key = p_pack;
  select a.tenant_id into v_tenant from ml_accounts a where a.id = p_account;
  if p_ok and v_tenant is not null then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, null, 'fiscal_documents', p_doc, 'ml_invoice_uploaded',
            jsonb_build_object('pack_key', p_pack, 'ml_fiscal_document_id', p_ml_id));
  end if;
end;
$$;
revoke all on function ml_invoice_uploaded(uuid, text, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function ml_invoice_uploaded(uuid, text, uuid, boolean, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- I) RPC de la UI
-- -----------------------------------------------------------------------------
-- Configuración de la cuenta. p: {price_list_id, price_markup_pct,
-- price_rounding, price_sync, stock_sync, invoice_mode, upload_invoice,
-- default_listing_type, label_format, store_id, warehouse_id, reserve_qty}
create or replace function ml_account_settings_save(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_acc    ml_accounts%rowtype;
  v_before jsonb;
  v_store  uuid := nullif(p ->> 'store_id', '')::uuid;
  v_wh     uuid := nullif(p ->> 'warehouse_id', '')::uuid;
  v_list   uuid := nullif(p ->> 'price_list_id', '')::uuid;
  v_map    ml_location_map%rowtype;
  r        record;
begin
  perform assert_account_active(v_tenant);
  select * into v_acc from ml_accounts where id = p_account and tenant_id = v_tenant and deleted_at is null for update;
  if v_acc.id is null then raise exception 'not_found'; end if;
  if v_store is not null and not exists (select 1 from stores s where s.id = v_store and s.tenant_id = v_tenant and s.deleted_at is null) then
    raise exception 'invalid_store';
  end if;
  if v_wh is not null and not exists (select 1 from warehouses w where w.id = v_wh and w.tenant_id = v_tenant
                                                               and w.deleted_at is null
                                                               and w.store_id = coalesce(v_store, w.store_id)) then
    raise exception 'invalid_warehouse';
  end if;
  if v_list is not null and not exists (select 1 from price_lists l where l.id = v_list and l.tenant_id = v_tenant) then
    raise exception 'invalid_price_list';
  end if;
  if coalesce(p ->> 'invoice_mode', v_acc.invoice_mode) not in ('on_paid', 'on_shipped', 'manual', 'none') then
    raise exception 'invalid_invoice_mode';
  end if;
  select * into v_map from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  v_before := to_jsonb(v_acc) - 'tags' || jsonb_build_object('store_id', v_map.store_id, 'warehouse_id', v_map.warehouse_id,
                                                            'reserve_qty', v_map.reserve_qty);

  update ml_accounts
     set price_list_id = case when p ? 'price_list_id' then v_list else price_list_id end,
         price_markup_pct = coalesce((p ->> 'price_markup_pct')::numeric, price_markup_pct),
         price_rounding = coalesce((p ->> 'price_rounding')::numeric, price_rounding),
         price_sync = coalesce((p ->> 'price_sync')::boolean, price_sync),
         stock_sync = coalesce((p ->> 'stock_sync')::boolean, stock_sync),
         invoice_mode = coalesce(nullif(p ->> 'invoice_mode', ''), invoice_mode),
         upload_invoice = coalesce((p ->> 'upload_invoice')::boolean, upload_invoice),
         default_listing_type = coalesce(nullif(p ->> 'default_listing_type', ''), default_listing_type),
         label_format = coalesce(nullif(p ->> 'label_format', ''), label_format)
   where id = p_account
  returning * into v_acc;

  if v_map.id is null then
    insert into ml_location_map (tenant_id, account_id, location_type, store_id, warehouse_id, reserve_qty)
    values (v_tenant, p_account, 'item_stock', coalesce(v_store, stock_default_store(v_tenant)), v_wh,
            greatest(coalesce((p ->> 'reserve_qty')::numeric, 0), 0));
  else
    update ml_location_map
       set store_id = case when p ? 'store_id' then coalesce(v_store, stock_default_store(v_tenant)) else store_id end,
           warehouse_id = case when p ? 'warehouse_id' or p ? 'store_id' then v_wh else warehouse_id end,
           reserve_qty = greatest(coalesce((p ->> 'reserve_qty')::numeric, reserve_qty), 0)
     where id = v_map.id;
  end if;

  -- Cambió el origen del stock o del precio: se reenvía todo lo vinculado.
  for r in select distinct l.item_id from ml_item_links l where l.account_id = p_account loop
    if v_acc.stock_sync then
      perform _ml_enqueue(v_tenant, p_account, 'stock_push', 'stock_push:' || r.item_id::text, null,
                          jsonb_build_object('item_id', r.item_id), 5, auth.uid());
    end if;
    if v_acc.price_sync then
      perform _ml_enqueue(v_tenant, p_account, 'price_push', 'price_push:' || r.item_id::text, null,
                          jsonb_build_object('item_id', r.item_id), 5, auth.uid());
    end if;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'ml_accounts', p_account, 'ml_account_settings_saved', v_before, p);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_account_settings_save(uuid, jsonb) from public, anon;
grant execute on function ml_account_settings_save(uuid, jsonb) to authenticated;

-- Desconectar (cortar el acceso siempre se puede, sin feature).
create or replace function ml_account_disconnect(p_account uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, false);
  v_acc    ml_accounts%rowtype;
begin
  update ml_accounts
     set status = 'disconnected', status_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Desconectada desde el POS'), 500),
         deleted_at = now()
   where id = p_account and tenant_id = v_tenant and deleted_at is null
  returning * into v_acc;
  if v_acc.id is null then raise exception 'not_found'; end if;
  delete from ml_tokens where account_id = p_account;
  update ml_sync_jobs set status = 'cancelled', last_error = 'account_disconnected'
   where account_id = p_account and status in ('pending', 'error');
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (v_tenant, auth.uid(), 'ml_accounts', p_account, 'ml_account_disconnected',
          jsonb_build_object('ml_user_id', v_acc.ml_user_id, 'nickname', v_acc.nickname), left(p_reason, 300));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_account_disconnect(uuid, text) from public, anon;
grant execute on function ml_account_disconnect(uuid, text) to authenticated;

-- Vínculo publicación <-> producto (interno: UI y publicación desde la Edge).
create or replace function _ml_link_create(p_tenant uuid, p_user uuid, p_item uuid, p_variation bigint,
                                           p_product uuid, p_variant uuid, p_by text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item ml_items%rowtype;
  v_prod record;
  v_id   uuid;
begin
  select * into v_item from ml_items where id = p_item and tenant_id = p_tenant and deleted_at is null;
  if v_item.id is null then raise exception 'item_not_found'; end if;
  select p.id, p.has_variants, p.is_kit into v_prod from products p
   where p.id = p_product and p.tenant_id = p_tenant and p.deleted_at is null;
  if v_prod.id is null then raise exception 'product_not_found'; end if;
  if coalesce(v_prod.is_kit, false) then raise exception 'kit_not_supported'; end if;
  if coalesce(v_prod.has_variants, false) and p_variant is null then raise exception 'variant_required'; end if;
  if p_variant is not null and not exists (
       select 1 from product_variants v where v.id = p_variant and v.product_id = p_product
                                          and v.tenant_id = p_tenant and v.deleted_at is null) then
    raise exception 'variant_not_found';
  end if;
  if v_item.has_variations and p_variation is null then raise exception 'variation_required'; end if;

  insert into ml_item_links (tenant_id, account_id, item_id, ml_variation_id, product_id, variant_id, linked_by, created_by)
  values (p_tenant, v_item.account_id, p_item, p_variation, p_product, p_variant, coalesce(p_by, 'manual'), p_user)
  on conflict (item_id, coalesce(ml_variation_id, 0)) do update
    set product_id = excluded.product_id, variant_id = excluded.variant_id, linked_by = excluded.linked_by,
        created_by = excluded.created_by
  returning id into v_id;

  perform _ml_enqueue(p_tenant, v_item.account_id, 'stock_push', 'stock_push:' || p_item::text, null,
                      jsonb_build_object('item_id', p_item), 5, p_user);
  perform _ml_enqueue(p_tenant, v_item.account_id, 'price_push', 'price_push:' || p_item::text, null,
                      jsonb_build_object('item_id', p_item), 5, p_user);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, p_user, 'ml_item_links', v_id, 'ml_item_linked',
          jsonb_build_object('ml_item_id', v_item.ml_item_id, 'ml_variation_id', p_variation,
                             'product_id', p_product, 'variant_id', p_variant, 'by', p_by));
  return v_id;
end;
$$;
revoke all on function _ml_link_create(uuid, uuid, uuid, bigint, uuid, uuid, text) from public, anon, authenticated;

create or replace function ml_item_link(p_item uuid, p_variation bigint, p_product uuid, p_variant uuid,
                                        p_by text default 'manual')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
begin
  return _ml_link_create(v_tenant, auth.uid(), p_item, p_variation, p_product, p_variant,
                         case when p_by in ('manual', 'sku', 'gtin') then p_by else 'manual' end);
end;
$$;
revoke all on function ml_item_link(uuid, bigint, uuid, uuid, text) from public, anon;
grant execute on function ml_item_link(uuid, bigint, uuid, uuid, text) to authenticated;

create or replace function ml_item_unlink(p_link uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, false);
  v_link   ml_item_links%rowtype;
begin
  delete from ml_item_links where id = p_link and tenant_id = v_tenant returning * into v_link;
  if v_link.id is null then raise exception 'not_found'; end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'ml_item_links', p_link, 'ml_item_unlinked', to_jsonb(v_link));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_item_unlink(uuid) from public, anon;
grant execute on function ml_item_unlink(uuid) to authenticated;

-- Acciones (también masivas) sobre publicaciones: pausar, activar, reenviar
-- stock o precio, releer de ML, precio manual o del POS. Van a la cola con
-- límite de llamadas (ML sanciona el uso masivo descontrolado).
create or replace function ml_items_action(p_items uuid[], p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_item   ml_items%rowtype;
  v_n      int := 0;
begin
  if p_action not in ('pause', 'activate', 'push_stock', 'push_price', 'refresh', 'price_manual', 'price_pos') then
    raise exception 'invalid_action';
  end if;
  if coalesce(array_length(p_items, 1), 0) = 0 or array_length(p_items, 1) > 500 then
    raise exception 'invalid_selection';
  end if;
  perform assert_account_active(v_tenant);
  for v_item in
    select i.* from ml_items i
      join ml_accounts a on a.id = i.account_id and a.deleted_at is null
     where i.id = any (p_items) and i.tenant_id = v_tenant and i.deleted_at is null
  loop
    if p_action in ('pause', 'activate') then
      perform _ml_enqueue(v_tenant, v_item.account_id, 'item_status', 'item_status:' || v_item.id::text,
                          v_item.ml_item_id, jsonb_build_object('item_id', v_item.id,
                          'status', case when p_action = 'pause' then 'paused' else 'active' end), 0, auth.uid());
    elsif p_action = 'push_stock' then
      perform _ml_enqueue(v_tenant, v_item.account_id, 'stock_push', 'stock_push:' || v_item.id::text, null,
                          jsonb_build_object('item_id', v_item.id), 0, auth.uid());
    elsif p_action = 'push_price' then
      perform _ml_enqueue(v_tenant, v_item.account_id, 'price_push', 'price_push:' || v_item.id::text, null,
                          jsonb_build_object('item_id', v_item.id), 0, auth.uid());
    elsif p_action = 'refresh' then
      perform _ml_enqueue(v_tenant, v_item.account_id, 'item_refresh', 'item_refresh:' || v_item.id::text,
                          v_item.ml_item_id, jsonb_build_object('item_id', v_item.id), 0, auth.uid());
    elsif p_action = 'price_manual' then
      update ml_items set price_source = 'manual' where id = v_item.id and price_source <> 'automation';
    elsif p_action = 'price_pos' then
      update ml_items set price_source = 'pos' where id = v_item.id and price_source <> 'automation';
      perform _ml_enqueue(v_tenant, v_item.account_id, 'price_push', 'price_push:' || v_item.id::text, null,
                          jsonb_build_object('item_id', v_item.id), 0, auth.uid());
    end if;
    v_n := v_n + 1;
  end loop;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'ml_items', null, 'ml_items_' || p_action,
          jsonb_build_object('count', v_n, 'items', to_jsonb(p_items[1:50])));
  return jsonb_build_object('ok', true, 'count', v_n);
end;
$$;
revoke all on function ml_items_action(uuid[], text) from public, anon;
grant execute on function ml_items_action(uuid[], text) to authenticated;

-- Responder una pregunta (cualquier rol operativo con la feature).
create or replace function ml_question_answer(p_question uuid, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(false, true);
  v_q      ml_questions%rowtype;
  v_text   text := btrim(coalesce(p_text, ''));
begin
  if char_length(v_text) < 2 or char_length(v_text) > 2000 then raise exception 'invalid_text'; end if;
  select * into v_q from ml_questions where id = p_question and tenant_id = v_tenant for update;
  if v_q.id is null then raise exception 'not_found'; end if;
  if v_q.status <> 'UNANSWERED' or v_q.answer_state in ('sending', 'sent') then raise exception 'already_answered'; end if;
  update ml_questions set answer_text = v_text, answer_state = 'sending', answered_by = auth.uid(), last_error = null
   where id = p_question;
  perform _ml_enqueue(v_tenant, v_q.account_id, 'answer_question', 'answer_question:' || p_question::text,
                      v_q.question_id::text, jsonb_build_object('question_row', p_question, 'text', v_text), 0, auth.uid());
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'ml_questions', p_question, 'ml_question_answered',
          jsonb_build_object('question_id', v_q.question_id, 'ml_item_id', v_q.ml_item_id, 'length', char_length(v_text)));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_question_answer(uuid, text) from public, anon;
grant execute on function ml_question_answer(uuid, text) to authenticated;

-- Facturar a mano la venta de un carrito (cola ARCA existente).
create or replace function ml_order_invoice(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_o      ml_orders%rowtype;
  v_doc    uuid;
begin
  select * into v_o from ml_orders where id = p_order and tenant_id = v_tenant;
  if v_o.id is null then raise exception 'not_found'; end if;
  if v_o.sale_id is null then raise exception 'no_sale'; end if;
  if v_o.fraud_risk then raise exception 'fraud_risk'; end if;
  if not exists (select 1 from arca_settings s where s.tenant_id = v_tenant and s.enabled) then
    raise exception 'arca_not_enabled';
  end if;
  v_doc := arca_enqueue_sale(v_o.sale_id, true);
  if v_doc is null then raise exception 'already_enqueued'; end if;
  update ml_orders set invoice_status = 'queued', fiscal_document_id = v_doc
   where account_id = v_o.account_id and pack_key = v_o.pack_key;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'fiscal_documents', v_doc, 'ml_invoice_enqueued',
          jsonb_build_object('sale_id', v_o.sale_id, 'pack_key', v_o.pack_key));
  return jsonb_build_object('ok', true, 'document_id', v_doc);
end;
$$;
revoke all on function ml_order_invoice(uuid) from public, anon;
grant execute on function ml_order_invoice(uuid) to authenticated;

-- Reintentar la subida de la factura aprobada al pack.
create or replace function ml_order_invoice_upload_retry(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_o      ml_orders%rowtype;
begin
  select * into v_o from ml_orders where id = p_order and tenant_id = v_tenant;
  if v_o.id is null then raise exception 'not_found'; end if;
  if v_o.fiscal_document_id is null or not exists (
       select 1 from fiscal_documents d where d.id = v_o.fiscal_document_id and d.status = 'aprobado') then
    raise exception 'invoice_not_approved';
  end if;
  perform _ml_enqueue(v_tenant, v_o.account_id, 'invoice_upload', 'invoice_upload:' || v_o.fiscal_document_id::text,
                      v_o.pack_key, jsonb_build_object('fiscal_document_id', v_o.fiscal_document_id,
                                                       'pack_key', v_o.pack_key, 'sale_id', v_o.sale_id), 0, auth.uid());
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_order_invoice_upload_retry(uuid) from public, anon;
grant execute on function ml_order_invoice_upload_retry(uuid) to authenticated;

-- Publicación creada desde el POS (Edge ml_api): espejo + vínculos + auditoría.
-- p_links: [{variant_id, ml_variation_id}] (User Products: uno por ítem).
create or replace function ml_publish_register(p_account uuid, p_user uuid, p_item jsonb, p_product uuid, p_links jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_item   uuid;
  v_l      jsonb;
begin
  select tenant_id into v_tenant from ml_accounts where id = p_account and deleted_at is null;
  if v_tenant is null then raise exception 'account_not_found'; end if;
  if ml_edge_guard(v_tenant, p_user, true) is not null then raise exception 'forbidden'; end if;
  v_item := ml_item_upsert(p_account, p_item);
  for v_l in select value from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    perform _ml_link_create(v_tenant, p_user, v_item, nullif(v_l ->> 'ml_variation_id', '')::bigint, p_product,
                            nullif(v_l ->> 'variant_id', '')::uuid, 'publish');
  end loop;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, p_user, 'ml_items', v_item, 'ml_item_published',
          jsonb_build_object('ml_item_id', p_item ->> 'ml_item_id', 'product_id', p_product,
                             'listing_type_id', p_item ->> 'listing_type_id', 'price', p_item ->> 'price'));
  return v_item;
end;
$$;
revoke all on function ml_publish_register(uuid, uuid, jsonb, uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_publish_register(uuid, uuid, jsonb, uuid, jsonb) to service_role;

-- Cuentas a reconciliar (búsqueda de órdenes recientes) y a "tocar"
-- (renovar el token antes de que venza o tras mucho sin uso).
create or replace function ml_accounts_due(p_kind text)
returns table (account_id uuid, tenant_id uuid, ml_user_id bigint, last_orders_poll_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.tenant_id, a.ml_user_id, a.last_orders_poll_at
    from ml_accounts a
    left join ml_tokens t on t.account_id = a.id
   where a.deleted_at is null and a.status = 'active'
     and tenant_has_feature_for(a.tenant_id, 'mercadolibre')
     and case p_kind
           when 'poll' then a.last_orders_poll_at is null or a.last_orders_poll_at < now() - interval '10 minutes'
           when 'tokens' then t.expires_at < now() + interval '90 minutes'
                              or t.last_refresh_at is null or t.last_refresh_at < now() - interval '20 days'
           else true
         end
   order by a.last_orders_poll_at nulls first
   limit 200;
$$;
revoke all on function ml_accounts_due(text) from public, anon, authenticated;
grant execute on function ml_accounts_due(text) to service_role;

create or replace function ml_account_polled(p_account uuid, p_at timestamptz, p_error text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_accounts
     set last_orders_poll_at = coalesce(p_at, last_orders_poll_at), last_sync_at = now(),
         last_error = left(p_error, 500)
   where id = p_account;
$$;
revoke all on function ml_account_polled(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function ml_account_polled(uuid, timestamptz, text) to service_role;

-- Precio del canal y stock publicable de un producto (y sus variantes) para
-- una cuenta: lo usa la pantalla de publicar (vista previa) y la Edge.
create or replace function ml_product_channel_preview(p_account uuid, p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_acc    ml_accounts%rowtype;
  v_map    ml_location_map%rowtype;
  v_prod   products%rowtype;
begin
  select * into v_acc from ml_accounts where id = p_account and tenant_id = v_tenant and deleted_at is null;
  if v_acc.id is null then raise exception 'not_found'; end if;
  select * into v_prod from products where id = p_product and tenant_id = v_tenant and deleted_at is null;
  if v_prod.id is null then raise exception 'product_not_found'; end if;
  select * into v_map from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  return jsonb_build_object(
    'product_id', v_prod.id, 'name', v_prod.name, 'description', v_prod.description,
    'sku', v_prod.sku, 'barcode', v_prod.barcode, 'is_kit', coalesce(v_prod.is_kit, false),
    'has_variants', coalesce(v_prod.has_variants, false),
    'price', _ml_price_for(v_acc, v_prod.id, null),
    'qty', case when v_map.id is null then null else _ml_available_qty(v_map, v_prod.id, null) end,
    'listing_type', v_acc.default_listing_type,
    'user_product_seller', v_acc.user_product_seller,
    'pictures', coalesce((select jsonb_agg(i.url order by i.is_primary desc, i.sort, i.created_at)
                            from product_images i where i.product_id = v_prod.id and i.deleted_at is null), '[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object(
                             'variant_id', v.id, 'option1', v.option1, 'option2', v.option2, 'sku', v.sku,
                             'barcode', v.barcode, 'price', _ml_price_for(v_acc, v_prod.id, v.id),
                             'qty', case when v_map.id is null then null else _ml_available_qty(v_map, v_prod.id, v.id) end)
                           order by v.option1, v.option2)
                            from product_variants v where v.product_id = v_prod.id and v.deleted_at is null), '[]'::jsonb),
    'links', coalesce((select jsonb_agg(jsonb_build_object('link_id', l.id, 'item_id', i.id, 'ml_item_id', i.ml_item_id,
                                                           'variant_id', l.variant_id, 'title', i.title, 'status', i.status,
                                                           'permalink', i.permalink))
                         from ml_item_links l join ml_items i on i.id = l.item_id
                        where l.product_id = v_prod.id and l.account_id = p_account), '[]'::jsonb));
end;
$$;
revoke all on function ml_product_channel_preview(uuid, uuid) from public, anon;
grant execute on function ml_product_channel_preview(uuid, uuid) to authenticated;
