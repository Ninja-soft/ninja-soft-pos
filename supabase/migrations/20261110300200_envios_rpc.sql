-- =============================================================================
-- 20261110300200_envios_rpc  (Envíos y logística, fase 1 · ADR-103)
--
-- Reglas y operaciones del módulo de envíos:
--
--   A) Gating y alcance: _shipping_feature_check (envios + key del carrier),
--      shipping_access_check (para la Edge, service_role: rol, sucursal,
--      multi_sucursal) y la conexión efectiva sucursal → negocio (ADR-057).
--   B) RPC del cliente (SECURITY DEFINER, tenant_id explícito en cada insert):
--      shipment_create (idempotente por idempotency_key), shipment_submit,
--      shipment_cancel, shipment_retry, shipment_request_track y
--      shipping_effective_connections. Auditan alta y cancelación.
--   C) Cola (service_role): _shipping_enqueue (un trabajo vivo por envío y
--      tipo), shipping_jobs_claim (FOR UPDATE SKIP LOCKED, recupera locks
--      viejos), shipping_job_finish (reintento con espera o falla) y
--      shipment_record_events (dedupe y estado normalizado).
--   D) Seguimiento por polling: shipping_track_schedule encola cada 30 min los
--      envíos vivos de los últimos 30 días; shipping_any_due para el cron que
--      despierta a la Edge `shipping` (en 20261110300300).
--
-- Roles (docs/06): dueño y encargado configuran logísticas; dueño, encargado
-- y cajero crean envíos, imprimen etiquetas y cancelan lo que todavía no está
-- en el carrier; cancelar algo creado en el carrier y reintentar es de dueño o
-- encargado; viewer sólo lee (role_write_guard lo frena también por RPC).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Gating y alcance
-- -----------------------------------------------------------------------------
-- null = permitido; si no, el código de error.
create or replace function _shipping_feature_check(p_tenant uuid, p_provider text, p_allow_skeleton boolean default false)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_key    text;
begin
  if not tenant_has_feature_for(p_tenant, 'envios') then
    return 'feature_not_in_plan: envios';
  end if;
  if p_provider is null then return null; end if;
  select sp.status into v_status from shipping_providers sp where sp.key = p_provider and sp.is_active;
  if v_status is null or v_status = 'planned' then return 'invalid_provider'; end if;
  if v_status = 'skeleton' and not p_allow_skeleton then return 'provider_not_available'; end if;
  v_key := shipping_provider_plan_key(p_provider);
  if v_key is not null and not tenant_has_feature_for(p_tenant, v_key) then
    return 'feature_not_in_plan: ' || v_key;
  end if;
  return null;
end;
$$;
revoke all on function _shipping_feature_check(uuid, text, boolean) from public, anon, authenticated;
grant execute on function _shipping_feature_check(uuid, text, boolean) to service_role;

-- Para la Edge `shipping` (service_role). p_mode:
--   manage  = conectar o editar una logística (dueño o encargado; sucursal con
--             multi_sucursal y acceso a ella). Acepta logísticas "skeleton"
--             (se pueden dejar las credenciales cargadas antes del adaptador).
--   operate = cotizar, buscar sucursales, procesar, imprimir (dueño,
--             encargado o cajero con acceso a la sucursal).
--   read    = ver la etiqueta o el seguimiento (cualquier miembro activo con
--             acceso a la sucursal, también viewer).
create or replace function shipping_access_check(
  p_tenant   uuid,
  p_user     uuid,
  p_store    uuid,
  p_provider text,
  p_mode     text
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text;
  v_allowed uuid[];
  v_err     text;
begin
  if p_mode not in ('manage', 'operate', 'read') then return 'invalid_mode'; end if;
  select tu.role into v_role from tenant_users tu
   where tu.tenant_id = p_tenant and tu.user_id = p_user and tu.status = 'active'
   limit 1;
  if v_role is null then return 'forbidden'; end if;
  if v_role <> 'owner' and staff_effective_status(p_tenant, p_user, null, null) <> 'active' then
    return 'forbidden';
  end if;
  if p_mode = 'manage' and v_role not in ('owner', 'manager') then return 'forbidden'; end if;
  if p_mode = 'operate' and v_role not in ('owner', 'manager', 'cashier') then return 'forbidden'; end if;

  v_err := _shipping_feature_check(p_tenant, p_provider, p_mode = 'manage');
  if v_err is not null and not (p_mode = 'read' and v_err like 'feature_not_in_plan%') then
    return v_err;
  end if;

  if p_store is not null then
    if not exists (select 1 from stores s where s.id = p_store and s.tenant_id = p_tenant and s.deleted_at is null) then
      return 'store_not_found';
    end if;
    v_allowed := staff_allowed_store_ids(p_tenant, p_user, null, v_role, null);
    if not (p_store = any (coalesce(v_allowed, '{}'::uuid[]))) then return 'forbidden'; end if;
    if p_mode = 'manage' and not tenant_has_feature_for(p_tenant, 'multi_sucursal') then
      return 'feature_not_in_plan: multi_sucursal';
    end if;
  end if;
  return null;
end;
$$;
revoke all on function shipping_access_check(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function shipping_access_check(uuid, uuid, uuid, text, text) to service_role;

-- Conexión efectiva de una sucursal para una logística (ADR-057): la de la
-- sucursal si existe (con multi_sucursal; apagada = apagada en esa sucursal),
-- si no la del negocio. null si no hay o está apagada.
create or replace function shipping_effective_connection(p_tenant uuid, p_store uuid, p_provider text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      uuid;
  v_enabled boolean;
begin
  if p_store is not null and tenant_has_feature_for(p_tenant, 'multi_sucursal') then
    select c.id, c.enabled into v_id, v_enabled
      from shipping_connections c
     where c.tenant_id = p_tenant and c.provider_key = p_provider
       and c.store_id = p_store and c.deleted_at is null;
    if v_id is not null then
      return case when v_enabled then v_id end;
    end if;
  end if;
  select c.id, c.enabled into v_id, v_enabled
    from shipping_connections c
   where c.tenant_id = p_tenant and c.provider_key = p_provider
     and c.store_id is null and c.deleted_at is null;
  return case when v_enabled then v_id end;
end;
$$;
revoke all on function shipping_effective_connection(uuid, uuid, text) from public, anon, authenticated;
grant execute on function shipping_effective_connection(uuid, uuid, text) to service_role;

-- Para la UI: logísticas que la sucursal puede usar hoy (sin secretos).
create or replace function shipping_effective_connections(p_store uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if member_role_in(v_tenant) is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_store is null or not user_can_access_store(p_store) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(x order by x ->> 'sort_key'), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object(
               'provider_key', sp.key,
               'name', sp.name,
               'kind', sp.kind,
               'status', sp.status,
               'capabilities', sp.capabilities,
               'label_formats', to_jsonb(sp.label_formats),
               'connection_id', c.id,
               'scope', case when c.store_id is null then 'tenant' else 'store' end,
               'sandbox', c.sandbox,
               'connected', (sp.key = 'simulador' or cardinality(c.secret_keys) > 0),
               'in_plan', _shipping_feature_check(v_tenant, sp.key) is null,
               'sort_key', lpad(sp.sort::text, 5, '0')
             ) as x
        from shipping_providers sp
        join shipping_connections c on c.id = shipping_effective_connection(v_tenant, p_store, sp.key)
       where sp.is_active and sp.status = 'active'
      union all
      -- El simulador siempre está disponible con `envios` (sin conexión).
      select jsonb_build_object(
               'provider_key', sp.key, 'name', sp.name, 'kind', sp.kind, 'status', sp.status,
               'capabilities', sp.capabilities, 'label_formats', to_jsonb(sp.label_formats),
               'connection_id', null, 'scope', 'tenant', 'sandbox', true, 'connected', true,
               'in_plan', _shipping_feature_check(v_tenant, sp.key) is null,
               'sort_key', lpad(sp.sort::text, 5, '0'))
        from shipping_providers sp
       where sp.key = 'simulador' and sp.is_active
         and shipping_effective_connection(v_tenant, p_store, 'simulador') is null
         and not exists (select 1 from shipping_connections c
                          where c.tenant_id = v_tenant and c.provider_key = 'simulador'
                            and c.deleted_at is null and not c.enabled
                            and (c.store_id is null or c.store_id = p_store))
    ) t;
  return v_out;
end;
$$;
revoke all on function shipping_effective_connections(uuid) from public, anon;
grant execute on function shipping_effective_connections(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Cola (primero: la usan las RPC del cliente)
-- -----------------------------------------------------------------------------
-- Un trabajo vivo por envío y tipo: si ya hay uno pendiente, se adelanta; si
-- está corriendo, no se duplica. Devuelve el id del trabajo vivo.
create or replace function _shipping_enqueue(
  p_tenant        uuid,
  p_shipment      uuid,
  p_kind          text,
  p_delay_seconds int default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_at timestamptz := now() + make_interval(secs => greatest(0, coalesce(p_delay_seconds, 0)));
begin
  insert into shipping_jobs (tenant_id, shipment_id, kind, run_after,
                             max_attempts)
  values (p_tenant, p_shipment, p_kind, v_at,
          case p_kind when 'track' then 3 when 'create' then 5 else 6 end)
  on conflict (shipment_id, kind) where status in ('pending', 'running')
  do update set run_after = least(shipping_jobs.run_after, excluded.run_after)
           where shipping_jobs.status = 'pending'
  returning id into v_id;
  if v_id is null then
    select j.id into v_id from shipping_jobs j
     where j.shipment_id = p_shipment and j.kind = p_kind and j.status in ('pending', 'running')
     limit 1;
  end if;
  return v_id;
end;
$$;
revoke all on function _shipping_enqueue(uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function _shipping_enqueue(uuid, uuid, text, int) to service_role;

-- Toma hasta p_limit trabajos vencidos. Los "running" con lock de más de 5
-- minutos (worker caído) vuelven a pendientes antes. SKIP LOCKED: dos workers
-- en paralelo nunca toman el mismo trabajo.
create or replace function shipping_jobs_claim(p_limit int, p_worker text, p_shipment uuid default null)
returns setof shipping_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update shipping_jobs j
     set status = 'pending', locked_at = null, locked_by = null,
         last_error = left(coalesce(j.last_error || ' · ', '') || 'stale_lock', 500)
   where j.status = 'running'
     and j.locked_at < now() - interval '5 minutes'
     and (p_shipment is null or j.shipment_id = p_shipment);

  return query
  with c as (
    select j.id
      from shipping_jobs j
     where j.status = 'pending'
       and j.run_after <= now()
       and (p_shipment is null or j.shipment_id = p_shipment)
     order by j.run_after, j.created_at
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update shipping_jobs j
     set status = 'running', locked_at = now(), locked_by = left(coalesce(p_worker, 'worker'), 80),
         attempts = j.attempts + 1
    from c
   where j.id = c.id
  returning j.*;
end;
$$;
revoke all on function shipping_jobs_claim(int, text, uuid) from public, anon, authenticated;
grant execute on function shipping_jobs_claim(int, text, uuid) to service_role;

-- Cierre de un trabajo: done, retry (con espera; si agotó los intentos queda
-- failed) o failed (error definitivo, no se reintenta).
create or replace function shipping_job_finish(
  p_id            uuid,
  p_outcome       text,
  p_error         text default null,
  p_retry_seconds int default 60,
  p_result        jsonb default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job shipping_jobs;
  v_status text;
begin
  select * into v_job from shipping_jobs where id = p_id for update;
  if not found then raise exception 'job_not_found'; end if;
  if v_job.status <> 'running' then return v_job.status; end if;
  if p_outcome = 'done' then
    v_status := 'done';
  elsif p_outcome = 'retry' and v_job.attempts < v_job.max_attempts then
    v_status := 'pending';
  else
    v_status := 'failed';
  end if;
  update shipping_jobs
     set status = v_status,
         locked_at = null,
         locked_by = null,
         last_error = case when p_error is null then last_error else left(p_error, 500) end,
         result = coalesce(p_result, result),
         run_after = case when v_status = 'pending'
                          then now() + make_interval(secs => greatest(5, least(coalesce(p_retry_seconds, 60), 21600)))
                          else run_after end,
         finished_at = case when v_status in ('done', 'failed') then now() end
   where id = p_id;
  return v_status;
end;
$$;
revoke all on function shipping_job_finish(uuid, text, text, int, jsonb) from public, anon, authenticated;
grant execute on function shipping_job_finish(uuid, text, text, int, jsonb) to service_role;

-- Orden de avance de los estados de seguimiento (espejo de STATUS_RANK en
-- _shared/shipping/status.ts).
create or replace function _shipping_status_rank(p_status text)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_status
    when 'draft' then 0 when 'quoted' then 1 when 'pending' then 2 when 'error' then 2
    when 'created' then 3 when 'label_ready' then 4 when 'picked_up' then 5
    when 'in_transit' then 6 when 'failed_attempt' then 7 when 'out_for_delivery' then 7
    when 'ready_for_pickup' then 8 when 'delivered' then 9 when 'returned' then 9
    when 'cancelled' then 10 else 0 end;
$$;

-- Registra eventos (dedupe por external_event_id o por estado + fecha) y
-- recalcula el estado: manda el evento más reciente con estado; "created" no
-- pisa a "label_ready"; un envío entregado, devuelto o cancelado no retrocede.
-- p_events: [{status, carrier_status, description, location, occurred_at,
-- external_event_id, raw}].
create or replace function shipment_record_events(p_shipment uuid, p_events jsonb, p_source text default 'poll')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s        shipments;
  v_ins      int := 0;
  v_last     record;
  v_new      text;
  v_final    boolean;
begin
  select * into v_s from shipments where id = p_shipment for update;
  if not found then raise exception 'shipment_not_found'; end if;
  if p_source not in ('system', 'poll', 'webhook', 'manual') then raise exception 'invalid_source'; end if;

  with e as (
    select nullif(x ->> 'status', '') as status,
           left(nullif(x ->> 'carrier_status', ''), 200) as carrier_status,
           left(nullif(x ->> 'description', ''), 500) as description,
           left(nullif(x ->> 'location', ''), 200) as location,
           coalesce(nullif(x ->> 'occurred_at', '')::timestamptz, now()) as occurred_at,
           left(nullif(x ->> 'external_event_id', ''), 200) as external_event_id,
           x -> 'raw' as raw
      from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) x
  ), ins as (
    insert into shipment_events (tenant_id, shipment_id, status, carrier_status, description, location,
                                 occurred_at, source, external_event_id, dedupe_key, raw)
    select v_s.tenant_id, v_s.id,
           case when e.status in ('draft', 'quoted', 'pending', 'created', 'label_ready', 'picked_up',
                                  'in_transit', 'out_for_delivery', 'ready_for_pickup', 'delivered',
                                  'failed_attempt', 'returned', 'cancelled', 'error')
                then e.status end,
           e.carrier_status, e.description, e.location, e.occurred_at, p_source, e.external_event_id,
           coalesce(e.external_event_id,
                    md5(coalesce(e.status, '') || '|' || coalesce(e.carrier_status, '') || '|' ||
                        to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'))),
           e.raw
      from e
    on conflict (shipment_id, dedupe_key) do nothing
    returning 1
  )
  select count(*) into v_ins from ins;

  v_final := v_s.status in ('delivered', 'returned', 'cancelled');
  select ev.status, ev.carrier_status, ev.description, ev.occurred_at into v_last
    from shipment_events ev
   where ev.shipment_id = v_s.id and ev.status is not null and ev.source <> 'system'
   order by ev.occurred_at desc, _shipping_status_rank(ev.status) desc
   limit 1;

  v_new := v_s.status;
  if v_last.status is not null and not v_final then
    if v_last.status = 'created' then
      if v_s.status in ('draft', 'quoted', 'pending', 'error') then v_new := 'created'; end if;
    elsif v_last.status not in ('draft', 'quoted', 'pending', 'error', 'label_ready') then
      v_new := v_last.status;
    end if;
  end if;

  update shipments
     set status = v_new,
         carrier_status = coalesce(v_last.carrier_status, carrier_status),
         status_detail = case when v_last.status is not null and not v_final
                              then coalesce(v_last.description, status_detail) else status_detail end,
         delivered_at = case when v_new = 'delivered' then coalesce(delivered_at, v_last.occurred_at, now()) else delivered_at end,
         cancelled_at = case when v_new = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
         last_tracked_at = case when p_source = 'poll' then now() else last_tracked_at end,
         track_failures = case when p_source = 'poll' then 0 else track_failures end,
         next_track_at = case
           when v_new in ('delivered', 'returned', 'cancelled') then null
           when v_new = 'out_for_delivery' then now() + interval '30 minutes'
           else now() + interval '2 hours' end
   where id = v_s.id;

  return jsonb_build_object('inserted', v_ins, 'status', v_new, 'previous', v_s.status);
end;
$$;
revoke all on function shipment_record_events(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function shipment_record_events(uuid, jsonb, text) to service_role;

-- -----------------------------------------------------------------------------
-- B) RPC del cliente
-- -----------------------------------------------------------------------------
create or replace function _shipping_assert_operator(p_tenant uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  if p_tenant is null then raise exception 'no_tenant'; end if;
  v_role := member_role_in(p_tenant);
  if v_role is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_role = 'viewer' then raise exception 'forbidden_read_only' using errcode = '42501'; end if;
  perform assert_staff_operational();
  return v_role;
end;
$$;
revoke all on function _shipping_assert_operator(uuid) from public, anon, authenticated;

-- Normaliza y valida bultos: [{weight_kg, length_cm, width_cm, height_cm}].
create or replace function _shipping_clean_packages(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_out jsonb := '[]'::jsonb;
  x     jsonb;
  w     numeric;
  l     numeric;
  wd    numeric;
  h     numeric;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 then
    raise exception 'packages_required' using errcode = '22023';
  end if;
  if jsonb_array_length(p) > 20 then raise exception 'too_many_packages' using errcode = '22023'; end if;
  for x in select * from jsonb_array_elements(p) loop
    begin
      w := (x ->> 'weight_kg')::numeric;
      l := (x ->> 'length_cm')::numeric;
      wd := (x ->> 'width_cm')::numeric;
      h := (x ->> 'height_cm')::numeric;
    exception when others then
      raise exception 'invalid_package' using errcode = '22023';
    end;
    if w is null or w <= 0 or w > 1000 then raise exception 'invalid_package_weight' using errcode = '22023'; end if;
    if l is null or wd is null or h is null or l <= 0 or wd <= 0 or h <= 0 or l > 500 or wd > 500 or h > 500 then
      raise exception 'invalid_package_size' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'weight_kg', round(w, 3), 'length_cm', round(l, 1), 'width_cm', round(wd, 1), 'height_cm', round(h, 1),
      'description', left(nullif(btrim(coalesce(x ->> 'description', '')), ''), 120)));
  end loop;
  return v_out;
end;
$$;

create or replace function shipment_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant    uuid := current_tenant_id();
  v_user      uuid := auth.uid();
  v_key       text := btrim(coalesce(p ->> 'idempotency_key', ''));
  v_existing  shipments;
  v_row       shipments;
  v_err       text;
  v_store     uuid;
  v_provider  text := nullif(btrim(coalesce(p ->> 'provider_key', '')), '');
  v_conn      uuid;
  v_source    text := coalesce(nullif(p ->> 'source', ''), 'manual');
  v_sale      uuid;
  v_sale_row  record;
  v_order     text := left(nullif(btrim(coalesce(p ->> 'order_ref', '')), ''), 80);
  v_type      text := coalesce(nullif(p ->> 'service_type', ''), 'door');
  v_rec       jsonb := coalesce(p -> 'recipient', '{}'::jsonb);
  v_dest      jsonb := coalesce(p -> 'destination', '{}'::jsonb);
  v_point     jsonb := p -> 'pickup_point';
  v_pkgs      jsonb;
  v_declared  numeric;
  v_quote     jsonb := p -> 'quote';
  v_cost      numeric;
  v_submit    boolean;
  v_origin    jsonb;
  v_cp        text;
  v_id        uuid;
begin
  perform _shipping_assert_operator(v_tenant);
  v_err := _shipping_feature_check(v_tenant, null);
  if v_err is not null then raise exception '%', v_err using errcode = '42501'; end if;

  if char_length(v_key) < 8 or char_length(v_key) > 120 then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  -- Reintento del cliente con la misma clave: devuelve el envío ya creado.
  select * into v_existing from shipments where tenant_id = v_tenant and idempotency_key = v_key;
  if found then
    return to_jsonb(v_existing) || jsonb_build_object('replayed', true);
  end if;

  if v_source not in ('pos_sale', 'order', 'manual') then
    raise exception 'invalid_source' using errcode = '22023';
  end if;

  v_store := nullif(p ->> 'store_id', '')::uuid;
  if v_source = 'pos_sale' then
    v_sale := nullif(p ->> 'sale_id', '')::uuid;
    if v_sale is null then raise exception 'sale_required' using errcode = '22023'; end if;
    select sa.id, sa.store_id, sa.status into v_sale_row
      from sales sa where sa.id = v_sale and sa.tenant_id = v_tenant;
    if v_sale_row.id is null then raise exception 'sale_not_found' using errcode = '22023'; end if;
    if v_sale_row.status <> 'completed' then raise exception 'sale_not_completed' using errcode = '22023'; end if;
    v_store := coalesce(v_store, v_sale_row.store_id);
  elsif v_source = 'order' and v_order is null then
    raise exception 'order_ref_required' using errcode = '22023';
  end if;

  if v_store is null or not exists (
    select 1 from stores s where s.id = v_store and s.tenant_id = v_tenant and s.deleted_at is null
  ) then
    raise exception 'store_not_found' using errcode = '22023';
  end if;
  if not user_can_access_store(v_store) then raise exception 'forbidden' using errcode = '42501'; end if;

  if v_provider is not null then
    v_err := _shipping_feature_check(v_tenant, v_provider);
    if v_err is not null then raise exception '%', v_err using errcode = '42501'; end if;
    v_conn := shipping_effective_connection(v_tenant, v_store, v_provider);
    if v_conn is null and v_provider <> 'simulador' then
      raise exception 'carrier_not_connected' using errcode = '22023';
    end if;
  end if;

  if v_type not in ('door', 'branch') then raise exception 'invalid_service_type' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(v_rec ->> 'name', ''))) < 2 then
    raise exception 'recipient_name_required' using errcode = '22023';
  end if;
  v_cp := upper(btrim(coalesce(v_dest ->> 'postal_code', '')));
  if v_cp !~ '^([0-9]{4}|[A-Z][0-9]{4}[A-Z]{3})$' then
    raise exception 'invalid_postal_code' using errcode = '22023';
  end if;
  if v_type = 'door' and (
       char_length(btrim(coalesce(v_dest ->> 'street', ''))) < 2
    or char_length(btrim(coalesce(v_dest ->> 'number', ''))) < 1
    or char_length(btrim(coalesce(v_dest ->> 'city', ''))) < 2
    or char_length(btrim(coalesce(v_dest ->> 'province', ''))) < 2) then
    raise exception 'destination_address_required' using errcode = '22023';
  end if;
  if v_type = 'branch' and (v_point is null or char_length(btrim(coalesce(v_point ->> 'id', ''))) = 0) then
    raise exception 'pickup_point_required' using errcode = '22023';
  end if;

  v_pkgs := _shipping_clean_packages(p -> 'packages');
  v_declared := coalesce(nullif(p ->> 'declared_value', '')::numeric, 0);
  if v_declared < 0 or v_declared > 1000000000 then raise exception 'invalid_declared_value' using errcode = '22023'; end if;

  if v_quote is not null and jsonb_typeof(v_quote) = 'object'
     and (v_quote ->> 'provider_key') is not distinct from v_provider then
    v_cost := nullif(v_quote ->> 'cost', '')::numeric;
    if v_cost is not null and v_cost < 0 then v_cost := null; end if;
  else
    v_quote := null;
  end if;

  v_submit := coalesce((p ->> 'submit')::boolean, true) and v_provider is not null;

  select jsonb_build_object('name', s.name, 'street', s.address, 'city', s.city, 'province', s.province,
                            'postal_code', s.postal_code, 'phone', s.phone, 'email', s.email)
    into v_origin
    from stores s where s.id = v_store;

  insert into shipments (
    tenant_id, store_id, connection_id, provider_key, source, sale_id, order_ref, external_ref,
    idempotency_key, service_type, service_code, pickup_point, recipient, destination, origin,
    packages, package_count, total_weight_kg, declared_value, quote, quoted_cost, status, notes, created_by
  ) values (
    v_tenant, v_store, v_conn, v_provider, v_source, v_sale, v_order,
    left(nullif(btrim(coalesce(p ->> 'external_ref', '')), ''), 120),
    v_key, v_type, left(nullif(btrim(coalesce(p ->> 'service_code', v_quote ->> 'service_code', '')), ''), 40),
    case when v_type = 'branch' then v_point end,
    jsonb_strip_nulls(jsonb_build_object(
      'name', left(btrim(v_rec ->> 'name'), 120),
      'document', left(nullif(btrim(coalesce(v_rec ->> 'document', '')), ''), 20),
      'email', left(nullif(btrim(coalesce(v_rec ->> 'email', '')), ''), 160),
      'phone', left(nullif(btrim(coalesce(v_rec ->> 'phone', '')), ''), 40))),
    jsonb_strip_nulls(jsonb_build_object(
      'street', left(nullif(btrim(coalesce(v_dest ->> 'street', '')), ''), 120),
      'number', left(nullif(btrim(coalesce(v_dest ->> 'number', '')), ''), 20),
      'floor', left(nullif(btrim(coalesce(v_dest ->> 'floor', '')), ''), 20),
      'apartment', left(nullif(btrim(coalesce(v_dest ->> 'apartment', '')), ''), 20),
      'city', left(nullif(btrim(coalesce(v_dest ->> 'city', '')), ''), 80),
      'province', left(nullif(btrim(coalesce(v_dest ->> 'province', '')), ''), 80),
      'postal_code', v_cp,
      'reference', left(nullif(btrim(coalesce(v_dest ->> 'reference', '')), ''), 200))),
    coalesce(jsonb_strip_nulls(v_origin), '{}'::jsonb),
    v_pkgs, jsonb_array_length(v_pkgs),
    (select coalesce(sum((x ->> 'weight_kg')::numeric), 0) from jsonb_array_elements(v_pkgs) x),
    v_declared, v_quote, v_cost,
    case when v_submit then 'pending' when v_quote is not null then 'quoted' else 'draft' end,
    left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 500),
    v_user
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Carrera con otro pedido de la misma clave: gana el primero.
    select * into v_existing from shipments where tenant_id = v_tenant and idempotency_key = v_key;
    return to_jsonb(v_existing) || jsonb_build_object('replayed', true);
  end if;

  insert into shipment_events (tenant_id, shipment_id, status, description, source, dedupe_key, created_by)
  values (v_tenant, v_id, case when v_submit then 'pending' else 'draft' end,
          case when v_submit then 'Envío creado; se está generando en la logística'
               else 'Borrador guardado' end,
          'system', 'created', v_user);

  if v_submit then
    perform _shipping_enqueue(v_tenant, v_id, 'create', 0);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, v_user, 'shipment', v_id, 'shipment_created',
          jsonb_build_object('provider_key', v_provider, 'source', v_source, 'sale_id', v_sale,
                             'order_ref', v_order, 'service_type', v_type, 'packages', jsonb_array_length(v_pkgs),
                             'declared_value', v_declared, 'quoted_cost', v_cost, 'submitted', v_submit),
          v_store);

  select * into v_row from shipments where id = v_id;
  return to_jsonb(v_row) || jsonb_build_object('replayed', false);
end;
$$;
revoke all on function shipment_create(jsonb) from public, anon;
grant execute on function shipment_create(jsonb) to authenticated;

-- Un borrador (o cotizado) pasa a la logística elegida.
create or replace function shipment_submit(p_id uuid, p_provider text default null, p_quote jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_s      shipments;
  v_prov   text;
  v_conn   uuid;
  v_err    text;
  v_cost   numeric;
begin
  perform _shipping_assert_operator(v_tenant);
  select * into v_s from shipments where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found or not user_can_access_store(v_s.store_id) then
    raise exception 'shipment_not_found' using errcode = '22023';
  end if;
  if v_s.status not in ('draft', 'quoted') then raise exception 'not_a_draft' using errcode = '22023'; end if;
  v_prov := coalesce(nullif(btrim(coalesce(p_provider, '')), ''), v_s.provider_key);
  if v_prov is null then raise exception 'provider_required' using errcode = '22023'; end if;
  v_err := _shipping_feature_check(v_tenant, v_prov);
  if v_err is not null then raise exception '%', v_err using errcode = '42501'; end if;
  v_conn := shipping_effective_connection(v_tenant, v_s.store_id, v_prov);
  if v_conn is null and v_prov <> 'simulador' then raise exception 'carrier_not_connected' using errcode = '22023'; end if;
  if p_quote is not null and (p_quote ->> 'provider_key') is not distinct from v_prov then
    v_cost := nullif(p_quote ->> 'cost', '')::numeric;
  end if;

  update shipments
     set provider_key = v_prov, connection_id = v_conn, status = 'pending',
         quote = case when p_quote is not null and (p_quote ->> 'provider_key') is not distinct from v_prov then p_quote
                      when v_prov is distinct from v_s.provider_key then null else quote end,
         quoted_cost = case when p_quote is not null and (p_quote ->> 'provider_key') is not distinct from v_prov then v_cost
                            when v_prov is distinct from v_s.provider_key then null else quoted_cost end,
         service_code = coalesce(left(nullif(p_quote ->> 'service_code', ''), 40), service_code)
   where id = p_id;
  insert into shipment_events (tenant_id, shipment_id, status, description, source, dedupe_key, created_by)
  values (v_tenant, p_id, 'pending', 'Envío confirmado; se está generando en la logística', 'system',
          'submitted:' || extract(epoch from clock_timestamp())::text, auth.uid());
  perform _shipping_enqueue(v_tenant, p_id, 'create', 0);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'shipment', p_id, 'shipment_submitted',
          jsonb_build_object('provider_key', v_prov), v_s.store_id);
  select * into v_s from shipments where id = p_id;
  return to_jsonb(v_s);
end;
$$;
revoke all on function shipment_submit(uuid, text, jsonb) from public, anon;
grant execute on function shipment_submit(uuid, text, jsonb) to authenticated;

-- Cancelar. Si el envío todavía no existe en la logística, se cancela acá
-- (cajero incluido). Si ya existe: dueño o encargado; con logística que
-- cancela por API se encola la cancelación; si no, p_local = true lo marca
-- cancelado sólo en NinjaSoft (hay que avisar al carrier) y queda auditado.
create or replace function shipment_cancel(p_id uuid, p_reason text, p_local boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
  v_s      shipments;
  v_reason text := left(btrim(coalesce(p_reason, '')), 300);
  v_can    boolean;
  v_mode   text;
begin
  v_role := _shipping_assert_operator(v_tenant);
  if char_length(v_reason) < 3 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into v_s from shipments where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found or not user_can_access_store(v_s.store_id) then
    raise exception 'shipment_not_found' using errcode = '22023';
  end if;
  if v_s.status in ('delivered', 'returned', 'cancelled') then
    raise exception 'not_cancellable' using errcode = '22023';
  end if;
  if v_s.cancel_requested_at is not null then
    raise exception 'cancel_already_requested' using errcode = '22023';
  end if;

  if v_s.external_id is null and not v_s.create_uncertain then
    -- No está en la logística. Si el alta está corriendo, esperar.
    if exists (select 1 from shipping_jobs j where j.shipment_id = p_id and j.kind = 'create' and j.status = 'running') then
      raise exception 'create_in_progress' using errcode = '55P03';
    end if;
    update shipping_jobs
       set status = 'failed', last_error = 'cancelled_by_user', finished_at = now(), locked_at = null
     where shipment_id = p_id and status = 'pending';
    update shipments
       set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(), next_track_at = null
     where id = p_id;
    v_mode := 'local_before_carrier';
  else
    if v_role not in ('owner', 'manager') then raise exception 'forbidden_role' using errcode = '42501'; end if;
    select coalesce((sp.capabilities ->> 'cancel')::boolean, false) into v_can
      from shipping_providers sp where sp.key = v_s.provider_key;
    if coalesce(v_can, false) and not v_s.create_uncertain then
      update shipments set cancel_requested_at = now(), cancel_reason = v_reason where id = p_id;
      perform _shipping_enqueue(v_tenant, p_id, 'cancel', 0);
      v_mode := 'carrier';
    elsif p_local then
      update shipments
         set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(), next_track_at = null,
             status_detail = 'Cancelado sólo en NinjaSoft: la logística no cancela por API. Avisale al carrier.'
       where id = p_id;
      update shipping_jobs
         set status = 'failed', last_error = 'cancelled_by_user', finished_at = now(), locked_at = null
       where shipment_id = p_id and status = 'pending';
      v_mode := 'local_only';
    else
      raise exception 'carrier_cannot_cancel' using errcode = '22023';
    end if;
  end if;

  insert into shipment_events (tenant_id, shipment_id, status, description, source, dedupe_key, created_by)
  values (v_tenant, p_id,
          case when v_mode = 'carrier' then null else 'cancelled' end,
          case v_mode
            when 'carrier' then 'Cancelación pedida a la logística: ' || v_reason
            when 'local_only' then 'Cancelado sólo en NinjaSoft (avisar a la logística): ' || v_reason
            else 'Cancelado: ' || v_reason end,
          'manual', 'cancel:' || extract(epoch from clock_timestamp())::text, auth.uid());

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason, store_id)
  values (v_tenant, auth.uid(), 'shipment', p_id,
          case when v_mode = 'carrier' then 'shipment_cancel_requested' else 'shipment_cancelled' end,
          jsonb_build_object('mode', v_mode, 'provider_key', v_s.provider_key,
                             'tracking_number', v_s.tracking_number, 'previous_status', v_s.status),
          v_reason, v_s.store_id);

  select * into v_s from shipments where id = p_id;
  return to_jsonb(v_s) || jsonb_build_object('cancel_mode', v_mode);
end;
$$;
revoke all on function shipment_cancel(uuid, text, boolean) from public, anon;
grant execute on function shipment_cancel(uuid, text, boolean) to authenticated;

-- Reintentar un envío con error (dueño o encargado). Si el alta quedó en duda
-- (timeout del carrier), p_force confirma que se revisó el panel del carrier
-- y que no existe: sin eso se podría crear (y cobrar) dos veces.
create or replace function shipment_retry(p_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
  v_s      shipments;
  v_kind   text;
begin
  v_role := _shipping_assert_operator(v_tenant);
  if v_role not in ('owner', 'manager') then raise exception 'forbidden_role' using errcode = '42501'; end if;
  select * into v_s from shipments where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found or not user_can_access_store(v_s.store_id) then
    raise exception 'shipment_not_found' using errcode = '22023';
  end if;
  if v_s.status in ('delivered', 'returned', 'cancelled', 'draft', 'quoted') then
    raise exception 'not_retryable' using errcode = '22023';
  end if;
  if v_s.external_id is null then
    if v_s.create_uncertain and not p_force then
      raise exception 'create_uncertain' using errcode = '22023';
    end if;
    v_kind := 'create';
    update shipments set status = 'pending', create_uncertain = false, create_attempted_at = null,
                         status_detail = null where id = p_id;
  elsif v_s.label_path is null then
    v_kind := 'label';
    update shipments set status = 'created', status_detail = null where id = p_id and status = 'error';
  else
    v_kind := 'track';
  end if;
  perform _shipping_enqueue(v_tenant, p_id, v_kind, 0);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'shipment', p_id, 'shipment_retried',
          jsonb_build_object('job', v_kind, 'forced', p_force, 'previous_status', v_s.status), v_s.store_id);
  select * into v_s from shipments where id = p_id;
  return to_jsonb(v_s);
end;
$$;
revoke all on function shipment_retry(uuid, boolean) from public, anon;
grant execute on function shipment_retry(uuid, boolean) to authenticated;

-- Pedir un seguimiento ahora (como mucho uno cada 2 minutos por envío).
create or replace function shipment_request_track(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_s      shipments;
begin
  perform _shipping_assert_operator(v_tenant);
  select * into v_s from shipments where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found or not user_can_access_store(v_s.store_id) then
    raise exception 'shipment_not_found' using errcode = '22023';
  end if;
  if v_s.external_id is null or v_s.status in ('delivered', 'returned', 'cancelled') then
    return null;
  end if;
  if v_s.last_tracked_at is not null and v_s.last_tracked_at > now() - interval '2 minutes' then
    return null;
  end if;
  return _shipping_enqueue(v_tenant, p_id, 'track', 0);
end;
$$;
revoke all on function shipment_request_track(uuid) from public, anon;
grant execute on function shipment_request_track(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Seguimiento por polling
-- -----------------------------------------------------------------------------
create or replace function shipping_track_schedule(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int := 0;
  r   record;
begin
  for r in
    select s.id, s.tenant_id
      from shipments s
      join shipping_providers sp on sp.key = s.provider_key
     where s.external_id is not null
       and s.deleted_at is null
       and s.status not in ('draft', 'quoted', 'pending', 'delivered', 'returned', 'cancelled', 'error')
       and coalesce(s.next_track_at, now()) <= now()
       and s.created_at > now() - interval '30 days'
       and coalesce((sp.capabilities ->> 'track')::boolean, false)
     order by s.next_track_at nulls first
     limit greatest(1, least(coalesce(p_limit, 500), 2000))
     for update of s skip locked
  loop
    perform _shipping_enqueue(r.tenant_id, r.id, 'track', 0);
    -- Pre-reserva el próximo turno: si el worker no corre, no se re-encola en
    -- cada pasada.
    update shipments set next_track_at = now() + interval '2 hours' where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function shipping_track_schedule(int) from public, anon, authenticated;
grant execute on function shipping_track_schedule(int) to service_role;

create or replace function shipping_any_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from shipping_jobs j where j.status = 'pending' and j.run_after <= now());
$$;
revoke all on function shipping_any_due() from public, anon, authenticated;
grant execute on function shipping_any_due() to service_role;
