-- =============================================================================
-- ADR-164 · F22 · H146 (L3 de ADR-149): mapa, planificación entre camiones,
-- seguimiento del camión y desvíos.
--
--   A) Configuración del seguimiento (route_tracking_settings, tabla propia:
--      no toca logistics_settings ni sus RPC): cada cuánto manda el teléfono,
--      umbral y minutos del desvío, retención de posiciones, velocidad
--      promedio y minutos por parada para la ETA.
--   B) Planificación: route_plans agrupa las hojas que salen juntas;
--      delivery_routes suma plan_id, duración, recorrido planificado
--      (planned_path) y el modo 'ors'; route_stops suma el minuto estimado
--      de llegada desde la salida (planned_offset_s). route_plan_confirm crea
--      las hojas de una vez reutilizando delivery_route_save,
--      route_add_dispatches y route_set_status (mismas validaciones).
--   C) Seguimiento: route_positions (append-only, id del teléfono,
--      idempotente para la cola offline), route_positions_last (una fila por
--      hoja para el mapa en vivo) y route_alerts (desvíos). Escritura sólo por
--      route_positions_push, sólo el repartidor o acompañante de la hoja y
--      sólo con la hoja en curso (o hasta el cierre, para lo que quedó en la
--      cola). Desvío: la última posición a más del umbral (600 m) del
--      recorrido planificado durante N minutos (5) abre una alerta y avisa a
--      dueño y encargado.
--   D) Lectura del mapa: route_live (hojas del día con la última posición,
--      recorrido, paradas y alerta) y route_track (recorrido real), con
--      logistics.track en el servidor; route_alert_ack.
--   E) Retención: route_positions_purge con pg_cron (90 días por defecto).
--   F) Edge routing (OpenRouteService opcional): routing_guard, cupo por
--      negocio en geo_usage y turno global en geo_providers ('ors').
--
-- Todo con reparto_propio (_logi_assert). No redefine funciones existentes:
-- no toca route_detail, delivery_event_record, logistics_settings ni nada de
-- Expedición (L5 trabaja en paralelo). Nunca "OR is_internal()".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Ayudas
-- -----------------------------------------------------------------------------
-- Número o null, sin error.
create or replace function _num_or_null(p text)
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p ~ '^-?[0-9]{1,12}(\.[0-9]{1,15})?$' then p::double precision end;
$$;
revoke all on function _num_or_null(text) from public, anon, authenticated;

-- Fecha y hora ISO o null, sin error.
create or replace function _ts_or_null(p text)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then
    return null;
  end if;
  return p::timestamptz;
exception when others then
  return null;
end;
$$;
revoke all on function _ts_or_null(text) from public, anon, authenticated;

-- Lectura para el panel: negocio, feature y capacidad (sin exigir que
-- escriba: el auditor ve el mapa).
create or replace function _logi_read_assert(p_cap text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null or stock_my_role() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'reparto_propio') then
    raise exception 'feature_not_in_plan: reparto_propio' using errcode = 'check_violation';
  end if;
  if not member_has_capability(v_tenant, p_cap) then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:' || p_cap;
  end if;
  return v_tenant;
end;
$$;
revoke all on function _logi_read_assert(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- A) Configuración del seguimiento
-- -----------------------------------------------------------------------------
create table if not exists route_tracking_settings (
  tenant_id         uuid primary key default current_tenant_id() references tenants(id) on delete cascade,
  enabled           boolean not null default true,
  interval_s        integer not null default 30 check (interval_s between 10 and 120),
  min_move_m        integer not null default 50 check (min_move_m between 10 and 1000),
  deviation_m       integer not null default 600 check (deviation_m between 100 and 5000),
  deviation_minutes integer not null default 5 check (deviation_minutes between 1 and 60),
  retention_days    integer not null default 90 check (retention_days between 7 and 365),
  avg_speed_kmh     integer not null default 25 check (avg_speed_kmh between 5 and 90),
  service_minutes   integer not null default 5 check (service_minutes between 0 and 60),
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);
comment on table route_tracking_settings is
  'ADR-164: seguimiento del reparto (frecuencia, desvío, retención y ETA). Una fila por negocio; sin fila valen los defaults de _route_tracking_cfg. Escritura por route_tracking_settings_save.';

drop trigger if exists set_updated_at_route_tracking_settings on route_tracking_settings;
create trigger set_updated_at_route_tracking_settings
  before update on route_tracking_settings
  for each row execute function set_updated_at();

alter table route_tracking_settings enable row level security;
revoke all on route_tracking_settings from anon, authenticated;
grant select on route_tracking_settings to authenticated;
drop policy if exists route_tracking_settings_select on route_tracking_settings;
create policy route_tracking_settings_select on route_tracking_settings
  for select using (tenant_id = (select current_tenant_id()));

create or replace function _route_tracking_cfg(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v route_tracking_settings;
begin
  select * into v from route_tracking_settings where tenant_id = p_tenant;
  return jsonb_build_object(
    'enabled', coalesce(v.enabled, true),
    'interval_s', coalesce(v.interval_s, 30),
    'min_move_m', coalesce(v.min_move_m, 50),
    'deviation_m', coalesce(v.deviation_m, 600),
    'deviation_minutes', coalesce(v.deviation_minutes, 5),
    'retention_days', coalesce(v.retention_days, 90),
    'avg_speed_kmh', coalesce(v.avg_speed_kmh, 25),
    'service_minutes', coalesce(v.service_minutes, 5),
    'saved', v.tenant_id is not null);
end;
$$;
revoke all on function _route_tracking_cfg(uuid) from public, anon, authenticated;

-- La lee el repartidor (frecuencia) y el panel (ETA y desvío).
create or replace function public.route_tracking_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or stock_my_role() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  return _route_tracking_cfg(v_tenant);
end;
$$;
revoke all on function public.route_tracking_settings_get() from public, anon;
grant execute on function public.route_tracking_settings_get() to authenticated;

create or replace function public.route_tracking_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.settings');
  v_old    jsonb := _route_tracking_cfg(v_tenant);
  v_new    jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_tracking_settings';
  end if;
  insert into route_tracking_settings as s (tenant_id, enabled, interval_s, min_move_m, deviation_m, deviation_minutes,
                                            retention_days, avg_speed_kmh, service_minutes, updated_by)
  values (
    v_tenant,
    coalesce((p ->> 'enabled')::boolean, (v_old ->> 'enabled')::boolean),
    least(120, greatest(10, coalesce(_num_or_null(p ->> 'interval_s')::int, (v_old ->> 'interval_s')::int))),
    least(1000, greatest(10, coalesce(_num_or_null(p ->> 'min_move_m')::int, (v_old ->> 'min_move_m')::int))),
    least(5000, greatest(100, coalesce(_num_or_null(p ->> 'deviation_m')::int, (v_old ->> 'deviation_m')::int))),
    least(60, greatest(1, coalesce(_num_or_null(p ->> 'deviation_minutes')::int, (v_old ->> 'deviation_minutes')::int))),
    least(365, greatest(7, coalesce(_num_or_null(p ->> 'retention_days')::int, (v_old ->> 'retention_days')::int))),
    least(90, greatest(5, coalesce(_num_or_null(p ->> 'avg_speed_kmh')::int, (v_old ->> 'avg_speed_kmh')::int))),
    least(60, greatest(0, coalesce(_num_or_null(p ->> 'service_minutes')::int, (v_old ->> 'service_minutes')::int))),
    auth.uid())
  on conflict (tenant_id) do update set
    enabled = excluded.enabled, interval_s = excluded.interval_s, min_move_m = excluded.min_move_m,
    deviation_m = excluded.deviation_m, deviation_minutes = excluded.deviation_minutes,
    retention_days = excluded.retention_days, avg_speed_kmh = excluded.avg_speed_kmh,
    service_minutes = excluded.service_minutes, updated_by = excluded.updated_by;
  v_new := _route_tracking_cfg(v_tenant);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'route_tracking_settings', v_tenant, 'route_tracking_settings_saved',
          v_old - 'saved', v_new - 'saved');
  return v_new;
end;
$$;
revoke all on function public.route_tracking_settings_save(jsonb) from public, anon;
grant execute on function public.route_tracking_settings_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Planificación entre camiones
-- -----------------------------------------------------------------------------
create table if not exists route_plans (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id     uuid not null references stores(id),
  origin_id    uuid references logistics_origins(id) on delete set null,
  service_date date not null,
  mode         text not null default 'heuristica' check (mode in ('heuristica', 'ors')),
  params       jsonb check (params is null or (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 4096)),
  summary      jsonb check (summary is null or (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 8192)),
  created_by   uuid,
  created_at   timestamptz not null default now()
);
comment on table route_plans is
  'ADR-164: reparto del día armado de una vez entre varios camiones (heurística local u OpenRouteService). Agrupa las hojas por plan_id.';
create index if not exists route_plans_day_idx on route_plans (tenant_id, service_date desc);
create index if not exists route_plans_store_idx on route_plans (store_id);
create index if not exists route_plans_origin_idx on route_plans (origin_id) where origin_id is not null;

alter table route_plans enable row level security;
revoke all on route_plans from anon, authenticated;
grant select on route_plans to authenticated;
drop policy if exists route_plans_select on route_plans;
create policy route_plans_select on route_plans
  for select using (tenant_id = (select current_tenant_id()) and (select has_capability('logistics.view')));

alter table delivery_routes add column if not exists plan_id uuid references route_plans(id) on delete set null;
alter table delivery_routes add column if not exists planned_duration_s integer;
alter table delivery_routes add column if not exists planned_path jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'delivery_routes_planned_duration_s_check') then
    alter table delivery_routes add constraint delivery_routes_planned_duration_s_check
      check (planned_duration_s is null or planned_duration_s >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'delivery_routes_planned_path_check') then
    alter table delivery_routes add constraint delivery_routes_planned_path_check
      check (planned_path is null or (jsonb_typeof(planned_path) = 'array' and pg_column_size(planned_path) <= 262144));
  end if;
end;
$$;
-- Modo 'ors': ordenada y trazada por OpenRouteService.
alter table delivery_routes drop constraint if exists delivery_routes_optimize_mode_check;
alter table delivery_routes add constraint delivery_routes_optimize_mode_check
  check (optimize_mode in ('manual', 'heuristica', 'ors'));
create index if not exists delivery_routes_plan_idx on delivery_routes (plan_id) where plan_id is not null;
comment on column delivery_routes.planned_path is
  'ADR-164: recorrido planificado [[lat, lng], ...] (calles de ORS o línea entre paradas). null = se arma con el origen y las paradas en orden. Se borra solo al reordenar a mano.';

alter table route_stops add column if not exists planned_offset_s integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'route_stops_planned_offset_s_check') then
    alter table route_stops add constraint route_stops_planned_offset_s_check
      check (planned_offset_s is null or planned_offset_s >= 0);
  end if;
end;
$$;
comment on column route_stops.planned_offset_s is 'ADR-164: segundos estimados desde la salida hasta llegar a la parada (plan).';

-- Reordenar a mano (route_reorder cambia el modo o los km) deja viejo el
-- recorrido planificado: se borra y el desvío se mide contra las paradas.
create or replace function trg_delivery_routes_path_stale()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.planned_path is not null
     and new.planned_path is not distinct from old.planned_path
     and (new.optimize_mode is distinct from old.optimize_mode
          or new.planned_distance_m is distinct from old.planned_distance_m) then
    new.planned_path := null;
    new.planned_duration_s := null;
  end if;
  return new;
end;
$$;
revoke all on function trg_delivery_routes_path_stale() from public, anon, authenticated;

drop trigger if exists delivery_routes_path_stale on delivery_routes;
create trigger delivery_routes_path_stale
  before update of optimize_mode, planned_distance_m on delivery_routes
  for each row execute function trg_delivery_routes_path_stale();

-- Recorrido [[lat, lng], ...] limpio: sólo pares válidos, hasta 2000 puntos
-- (si viene más largo se toma uno de cada n y el último).
create or replace function _route_path_clean(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_n    int;
  v_step int;
  v_out  jsonb;
begin
  if jsonb_typeof(p) is distinct from 'array' then
    return null;
  end if;
  with pts as (
    select o, _num_or_null(x ->> 0) as lat, _num_or_null(x ->> 1) as lng
      from jsonb_array_elements(p) with ordinality as e(x, o)
     where jsonb_typeof(x) = 'array'
  ), ok as (
    select row_number() over (order by o) as i, lat, lng
      from pts
     where lat between -90 and 90 and lng between -180 and 180 and not (lat = 0 and lng = 0)
  )
  select count(*) into v_n from ok;
  if v_n < 2 then
    return null;
  end if;
  v_step := greatest(1, ceil(v_n / 2000.0)::int);
  with pts as (
    select o, _num_or_null(x ->> 0) as lat, _num_or_null(x ->> 1) as lng
      from jsonb_array_elements(p) with ordinality as e(x, o)
     where jsonb_typeof(x) = 'array'
  ), ok as (
    select row_number() over (order by o) as i, lat, lng
      from pts
     where lat between -90 and 90 and lng between -180 and 180 and not (lat = 0 and lng = 0)
  )
  select jsonb_agg(jsonb_build_array(round(lat::numeric, 6), round(lng::numeric, 6)) order by i) into v_out
    from ok
   where (i - 1) % v_step = 0 or i = v_n;
  return v_out;
end;
$$;
revoke all on function _route_path_clean(jsonb) from public, anon, authenticated;

-- Recorrido contra el que se mide el desvío: el planificado o, si no hay,
-- origen y paradas con ubicación en orden (y la vuelta).
create or replace function _route_path(p_route uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(r.planned_path, (
    select jsonb_agg(pt order by k)
      from (
        select 0 as k, jsonb_build_array(o.lat, o.lng) as pt
          from logistics_origins o where o.id = r.origin_id and o.lat is not null
        union all
        select s.seq, jsonb_build_array(s.lat, s.lng)
          from route_stops s
         where s.route_id = r.id and s.deleted_at is null and s.lat is not null
        union all
        select 1000000, jsonb_build_array(o.lat, o.lng)
          from logistics_origins o where o.id = r.origin_id and o.lat is not null and r.return_to_origin
      ) x))
    from delivery_routes r
   where r.id = p_route;
$$;
revoke all on function _route_path(uuid) from public, anon, authenticated;

-- Metros de un punto al recorrido (segmento más cercano, proyección plana
-- local: alcanza para distancias de una ciudad). Espejo de distanceToPathM.
create or replace function _path_distance_m(p_lat double precision, p_lng double precision, p_path jsonb)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_k    double precision;
  v_n    int;
  v_i    int;
  v_x1   double precision;
  v_y1   double precision;
  v_x2   double precision;
  v_y2   double precision;
  v_dx   double precision;
  v_dy   double precision;
  v_t    double precision;
  v_d    double precision;
  v_best double precision;
begin
  if p_lat is null or p_lng is null or jsonb_typeof(p_path) is distinct from 'array' then
    return null;
  end if;
  v_n := jsonb_array_length(p_path);
  if v_n = 0 then
    return null;
  end if;
  v_k := cos(radians(p_lat)) * 111320.0;
  v_x2 := ((p_path -> 0 ->> 1)::double precision - p_lng) * v_k;
  v_y2 := ((p_path -> 0 ->> 0)::double precision - p_lat) * 110574.0;
  v_best := sqrt(v_x2 * v_x2 + v_y2 * v_y2);
  for v_i in 1 .. v_n - 1 loop
    v_x1 := v_x2;
    v_y1 := v_y2;
    v_x2 := ((p_path -> v_i ->> 1)::double precision - p_lng) * v_k;
    v_y2 := ((p_path -> v_i ->> 0)::double precision - p_lat) * 110574.0;
    v_dx := v_x2 - v_x1;
    v_dy := v_y2 - v_y1;
    if v_dx = 0 and v_dy = 0 then
      v_t := 0;
    else
      v_t := greatest(0, least(1, -(v_x1 * v_dx + v_y1 * v_dy) / (v_dx * v_dx + v_dy * v_dy)));
    end if;
    v_d := sqrt(power(v_x1 + v_t * v_dx, 2) + power(v_y1 + v_t * v_dy, 2));
    if v_d < v_best then
      v_best := v_d;
    end if;
  end loop;
  return round(v_best)::int;
end;
$$;
revoke all on function _path_distance_m(double precision, double precision, jsonb) from public, anon;
grant execute on function _path_distance_m(double precision, double precision, jsonb) to authenticated;

-- Confirmar el reparto planificado: crea una hoja por camión con sus
-- entregas en el orden del plan (las de un mismo cliente y dirección van a la
-- misma parada), el recorrido, los km, la duración y la llegada estimada de
-- cada parada. Todo o nada.
--   p = { store_id, origin_id?, service_date, mode: 'heuristica'|'ors',
--         params?, plan_now?: boolean,
--         routes: [{ vehicle_id, driver_user_id?, helper_user_id?,
--                    dispatch_ids: [...en orden], distance_m?, duration_s?,
--                    path?: [[lat, lng], ...], offsets?: { dispatch_id: s } }] }
create or replace function public.route_plan_confirm(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _logi_assert('logistics.route.manage');
  v_store   uuid := _uuid_or_null(p ->> 'store_id');
  v_origin  uuid := _uuid_or_null(p ->> 'origin_id');
  v_date    date := coalesce(_ts_or_null((p ->> 'service_date') || 'T12:00')::date, branch_today());
  v_mode    text := coalesce(p ->> 'mode', 'heuristica');
  v_plan    uuid;
  v_routes  jsonb := p -> 'routes';
  v_r       jsonb;
  v_ids     uuid[];
  v_all     uuid[] := '{}';
  v_veh     uuid;
  v_vehs    uuid[] := '{}';
  v_route   jsonb;
  v_id      uuid;
  v_max     int;
  v_stops   int;
  v_out     jsonb := '[]'::jsonb;
  v_total   int := 0;
begin
  if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(v_routes) is distinct from 'array'
     or jsonb_array_length(v_routes) = 0 or jsonb_array_length(v_routes) > 20 then
    raise exception 'invalid_plan';
  end if;
  if v_mode not in ('heuristica', 'ors') then
    raise exception 'invalid_mode';
  end if;
  if v_store is null or not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  if not coalesce(user_can_access_store(v_store), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;

  -- Cada camión una vez y cada entrega en una sola hoja.
  for v_r in select x from jsonb_array_elements(v_routes) x loop
    v_veh := _uuid_or_null(v_r ->> 'vehicle_id');
    if v_veh is null then
      raise exception 'route_needs_vehicle';
    end if;
    if v_veh = any (v_vehs) then
      raise exception 'vehicle_repeated';
    end if;
    v_vehs := v_vehs || v_veh;
    select coalesce(array_agg(_uuid_or_null(e) order by o), '{}') into v_ids
      from jsonb_array_elements_text(case when jsonb_typeof(v_r -> 'dispatch_ids') = 'array' then v_r -> 'dispatch_ids'
                                          else '[]'::jsonb end) with ordinality as t(e, o);
    if cardinality(v_ids) = 0 or cardinality(v_ids) > 200 or array_position(v_ids, null) is not null then
      raise exception 'invalid_dispatches';
    end if;
    if v_all && v_ids or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then
      raise exception 'dispatch_repeated';
    end if;
    v_all := v_all || v_ids;
  end loop;

  insert into route_plans (tenant_id, store_id, origin_id, service_date, mode, params, created_by)
  values (v_tenant, v_store, v_origin, v_date, v_mode,
          case when jsonb_typeof(p -> 'params') = 'object' and pg_column_size(p -> 'params') <= 4096 then p -> 'params' end,
          auth.uid())
  returning id into v_plan;

  for v_r in select x from jsonb_array_elements(v_routes) x loop
    select coalesce(array_agg(e::uuid order by o), '{}') into v_ids
      from jsonb_array_elements_text(v_r -> 'dispatch_ids') with ordinality as t(e, o);
    -- Mismas validaciones que armar la hoja a mano.
    v_route := delivery_route_save(null, jsonb_build_object(
      'store_id', v_store, 'origin_id', v_origin, 'service_date', v_date,
      'vehicle_id', v_r ->> 'vehicle_id', 'driver_user_id', v_r ->> 'driver_user_id',
      'helper_user_id', v_r ->> 'helper_user_id', 'notes', v_r ->> 'notes'));
    v_id := (v_route ->> 'id')::uuid;
    perform route_add_dispatches(v_id, v_ids);

    select max_stops into v_max from vehicles where id = _uuid_or_null(v_r ->> 'vehicle_id');
    select count(*) into v_stops from route_stops where route_id = v_id and deleted_at is null;
    if v_max is not null and v_stops > v_max then
      raise exception 'vehicle_max_stops' using detail = 'max:' || v_max;
    end if;

    update delivery_routes set
      plan_id = v_plan,
      optimize_mode = v_mode,
      planned_distance_m = case when _num_or_null(v_r ->> 'distance_m') >= 0
                                then least(_num_or_null(v_r ->> 'distance_m'), 2000000000)::int end,
      planned_duration_s = case when _num_or_null(v_r ->> 'duration_s') >= 0
                                then least(_num_or_null(v_r ->> 'duration_s'), 2000000000)::int end,
      planned_path = _route_path_clean(v_r -> 'path')
    where id = v_id;

    if jsonb_typeof(v_r -> 'offsets') = 'object' then
      update route_stops s set planned_offset_s = o.off
        from (select x.stop_id, min(_num_or_null(e.value)::int) as off
                from route_stop_dispatches x
                join jsonb_each_text(v_r -> 'offsets') e on e.key = x.dispatch_id::text
               where x.route_id = v_id and x.outcome = 'pendiente'
                 and _num_or_null(e.value) between 0 and 604800
               group by x.stop_id) o
       where s.id = o.stop_id;
    end if;

    if coalesce((p ->> 'plan_now')::boolean, true) and nullif(v_r ->> 'driver_user_id', '') is not null then
      perform route_set_status(v_id, 'planificada');
    end if;
    v_total := v_total + cardinality(v_ids);
    v_out := v_out || jsonb_build_object('id', v_id, 'number', (v_route ->> 'number')::int, 'stops', v_stops);
  end loop;

  update route_plans set summary = jsonb_build_object('routes', jsonb_array_length(v_out), 'dispatches', v_total)
   where id = v_plan;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'route_plans', v_plan, 'route_plan_confirmed',
          jsonb_build_object('mode', v_mode, 'service_date', v_date, 'routes', v_out, 'dispatches', v_total), v_store);
  return jsonb_build_object('plan_id', v_plan, 'routes', v_out);
end;
$$;
revoke all on function public.route_plan_confirm(jsonb) from public, anon;
grant execute on function public.route_plan_confirm(jsonb) to authenticated;

-- Recorrido de una hoja armada a mano (trazado por calles o línea entre
-- paradas) con km, duración y llegada estimada de cada parada. Antes de salir.
--   p = { path: [[lat, lng], ...], distance_m?, duration_s?, offsets?: { stop_id: s } }
create or replace function public.route_set_path(p_route uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r    delivery_routes := _route_lock(p_route, 'manage');
  v_path jsonb;
begin
  if v_r.status not in ('borrador', 'planificada', 'cargando') then
    raise exception 'route_not_editable';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_path';
  end if;
  v_path := _route_path_clean(p -> 'path');
  if v_path is null then
    raise exception 'invalid_path';
  end if;
  update delivery_routes set
    planned_path = v_path,
    planned_distance_m = case when _num_or_null(p ->> 'distance_m') >= 0
                              then least(_num_or_null(p ->> 'distance_m'), 2000000000)::int else planned_distance_m end,
    planned_duration_s = case when _num_or_null(p ->> 'duration_s') >= 0
                              then least(_num_or_null(p ->> 'duration_s'), 2000000000)::int end
  where id = p_route;
  if jsonb_typeof(p -> 'offsets') = 'object' then
    update route_stops s set planned_offset_s = _num_or_null(e.value)::int
      from jsonb_each_text(p -> 'offsets') e
     where s.route_id = p_route and s.deleted_at is null and s.id::text = e.key
       and _num_or_null(e.value) between 0 and 604800;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', p_route, 'route_path_set',
          jsonb_build_object('points', jsonb_array_length(v_path), 'distance_m', p ->> 'distance_m',
                             'duration_s', p ->> 'duration_s'), v_r.store_id);
  return jsonb_build_object('ok', true, 'points', jsonb_array_length(v_path));
end;
$$;
revoke all on function public.route_set_path(uuid, jsonb) from public, anon;
grant execute on function public.route_set_path(uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Seguimiento: posiciones, última posición y alertas de desvío
-- -----------------------------------------------------------------------------
create table if not exists route_alerts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  route_id        uuid not null references delivery_routes(id) on delete cascade,
  kind            text not null default 'desvio' check (kind in ('desvio')),
  started_at      timestamptz not null,
  detected_at     timestamptz not null default now(),
  ended_at        timestamptz,
  max_distance_m  integer check (max_distance_m is null or max_distance_m >= 0),
  lat             double precision check (lat is null or lat between -90 and 90),
  lng             double precision check (lng is null or lng between -180 and 180),
  acknowledged_by uuid references public.users(id) on delete set null,
  acknowledged_at timestamptz
);
comment on table route_alerts is
  'ADR-164: avisos del seguimiento (el camión se fue de la ruta planificada más del umbral durante N minutos). Los abre y cierra route_positions_push; el panel los marca vistos con route_alert_ack.';
create index if not exists route_alerts_route_idx on route_alerts (route_id, detected_at desc);
create index if not exists route_alerts_tenant_idx on route_alerts (tenant_id, detected_at desc);
create index if not exists route_alerts_ack_idx on route_alerts (acknowledged_by) where acknowledged_by is not null;

create table if not exists route_positions (
  id          uuid primary key,
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  route_id    uuid not null references delivery_routes(id) on delete cascade,
  user_id     uuid not null,
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  accuracy_m  integer check (accuracy_m is null or accuracy_m between 0 and 100000),
  speed_mps   numeric(6,2) check (speed_mps is null or speed_mps between 0 and 120),
  heading     smallint check (heading is null or heading between 0 and 360),
  battery     smallint check (battery is null or battery between 0 and 100),
  charging    boolean,
  device_id   text check (device_id is null or char_length(device_id) <= 80)
);
comment on table route_positions is
  'ADR-164: posiciones del camión mientras la hoja está en curso (las manda la app /reparto en lote). Append-only, id del teléfono (idempotente). Retención por route_positions_purge (90 días por defecto).';
create index if not exists route_positions_route_idx on route_positions (route_id, recorded_at);
create index if not exists route_positions_tenant_idx on route_positions (tenant_id, recorded_at);

create table if not exists route_positions_last (
  route_id        uuid primary key references delivery_routes(id) on delete cascade,
  tenant_id       uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  user_id         uuid not null,
  lat             double precision not null check (lat between -90 and 90),
  lng             double precision not null check (lng between -180 and 180),
  accuracy_m      integer,
  speed_mps       numeric(6,2),
  heading         smallint,
  battery         smallint,
  charging        boolean,
  recorded_at     timestamptz not null,
  received_at     timestamptz not null default now(),
  points          integer not null default 0,
  off_route_m     integer,
  off_route_since timestamptz,
  alert_id        uuid references route_alerts(id) on delete set null
);
comment on table route_positions_last is
  'ADR-164: última posición de cada hoja (tabla chica para el mapa en vivo) con el estado del desvío.';
create index if not exists route_positions_last_tenant_idx on route_positions_last (tenant_id);
create index if not exists route_positions_last_alert_idx on route_positions_last (alert_id) where alert_id is not null;

alter table route_alerts enable row level security;
alter table route_positions enable row level security;
alter table route_positions_last enable row level security;
revoke all on route_alerts, route_positions, route_positions_last from anon, authenticated;
grant select on route_alerts, route_positions, route_positions_last to authenticated;

drop policy if exists route_alerts_select on route_alerts;
create policy route_alerts_select on route_alerts
  for select using (tenant_id = (select current_tenant_id()) and (select has_capability('logistics.track')));
drop policy if exists route_positions_select on route_positions;
create policy route_positions_select on route_positions
  for select using (tenant_id = (select current_tenant_id())
                    and ((select has_capability('logistics.track')) or user_id = (select auth.uid())));
drop policy if exists route_positions_last_select on route_positions_last;
create policy route_positions_last_select on route_positions_last
  for select using (tenant_id = (select current_tenant_id()) and (select has_capability('logistics.track')));

-- Recibe un lote de posiciones del teléfono. Sólo el repartidor o
-- acompañante de la hoja, con la hoja en curso (o hasta 2 minutos después
-- del cierre: lo que quedó en la cola sin señal). Idempotente por id.
--   p_points = [{ id, t, lat, lng, acc?, spd?, hdg?, bat?, chg?, dev? }]
create or replace function public.route_positions_push(p_route uuid, p_points jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.deliver');
  v_r      delivery_routes;
  v_cfg    jsonb;
  v_ok     jsonb;
  v_n      int := 0;
  v_valid  int := 0;
  v_last   record;
  v_prev   route_positions_last;
  v_off    int;
  v_since  timestamptz;
  v_alert  uuid;
  v_new    boolean := false;
  v_dev_m  int;
  v_dev_min int;
  v_veh    vehicles;
begin
  select * into v_r from delivery_routes where id = p_route and tenant_id = v_tenant and deleted_at is null;
  if v_r.id is null then
    raise exception 'route_not_found';
  end if;
  if not coalesce(v_r.driver_user_id = auth.uid() or v_r.helper_user_id = auth.uid(), false) then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:logistics.deliver';
  end if;
  if v_r.status not in ('en_curso', 'cerrada') or v_r.started_at is null then
    raise exception 'route_not_started';
  end if;
  v_cfg := _route_tracking_cfg(v_tenant);
  if not (v_cfg ->> 'enabled')::boolean then
    return jsonb_build_object('ok', true, 'accepted', 0, 'disabled', true);
  end if;
  if jsonb_typeof(p_points) is distinct from 'array' then
    raise exception 'invalid_points';
  end if;
  if jsonb_array_length(p_points) > 300 then
    raise exception 'too_many_points';
  end if;

  -- Puntos válidos: ids del teléfono, coordenadas reales y hora dentro de la
  -- hoja (nunca futura).
  select coalesce(jsonb_agg(pt order by pt ->> 't'), '[]'::jsonb), count(*)
    into v_ok, v_valid
    from (
      select jsonb_build_object(
               'id', _uuid_or_null(x ->> 'id'),
               't', _ts_or_null(x ->> 't'),
               'lat', _num_or_null(x ->> 'lat'),
               'lng', _num_or_null(x ->> 'lng'),
               'acc', case when _num_or_null(x ->> 'acc') between 0 and 100000 then round(_num_or_null(x ->> 'acc'))::int end,
               'spd', case when _num_or_null(x ->> 'spd') between 0 and 120 then round(_num_or_null(x ->> 'spd')::numeric, 2) end,
               'hdg', case when _num_or_null(x ->> 'hdg') between 0 and 360 then round(_num_or_null(x ->> 'hdg'))::int end,
               'bat', case when _num_or_null(x ->> 'bat') between 0 and 100 then round(_num_or_null(x ->> 'bat'))::int end,
               'chg', case when x ->> 'chg' in ('true', 'false') then (x ->> 'chg')::boolean end,
               'dev', left(nullif(x ->> 'dev', ''), 80)) as pt
        from jsonb_array_elements(p_points) x
       where jsonb_typeof(x) = 'object'
    ) q
   where (pt ->> 'id') is not null
     and (pt ->> 't') is not null
     and (pt ->> 'lat')::double precision between -90 and 90
     and (pt ->> 'lng')::double precision between -180 and 180
     and not ((pt ->> 'lat')::double precision = 0 and (pt ->> 'lng')::double precision = 0)
     and (pt ->> 't')::timestamptz <= now() + interval '2 minutes'
     and (pt ->> 't')::timestamptz >= v_r.started_at - interval '5 minutes'
     and (v_r.closed_at is null or (pt ->> 't')::timestamptz <= v_r.closed_at + interval '2 minutes');

  if v_valid = 0 then
    return jsonb_build_object('ok', true, 'accepted', 0, 'ignored', jsonb_array_length(p_points));
  end if;

  insert into route_positions (id, tenant_id, route_id, user_id, recorded_at, lat, lng, accuracy_m, speed_mps,
                               heading, battery, charging, device_id)
  select (e ->> 'id')::uuid, v_tenant, v_r.id, auth.uid(), (e ->> 't')::timestamptz,
         (e ->> 'lat')::double precision, (e ->> 'lng')::double precision,
         (e ->> 'acc')::int, (e ->> 'spd')::numeric, (e ->> 'hdg')::smallint, (e ->> 'bat')::smallint,
         (e ->> 'chg')::boolean, e ->> 'dev'
    from jsonb_array_elements(v_ok) e
  on conflict (id) do nothing;
  get diagnostics v_n = row_count;

  -- La más nueva del lote.
  select (e ->> 't')::timestamptz as t, (e ->> 'lat')::double precision as lat, (e ->> 'lng')::double precision as lng,
         (e ->> 'acc')::int as acc, (e ->> 'spd')::numeric as spd, (e ->> 'hdg')::smallint as hdg,
         (e ->> 'bat')::smallint as bat, (e ->> 'chg')::boolean as chg
    into v_last
    from jsonb_array_elements(v_ok) e
   order by (e ->> 't')::timestamptz desc
   limit 1;

  select * into v_prev from route_positions_last where route_id = v_r.id for update;
  if v_prev.route_id is not null and v_last.t <= v_prev.recorded_at then
    update route_positions_last set points = points + v_n where route_id = v_r.id;
    return jsonb_build_object('ok', true, 'accepted', v_n, 'off_route_m', v_prev.off_route_m,
                              'alert', v_prev.alert_id is not null);
  end if;

  v_since := v_prev.off_route_since;
  v_alert := v_prev.alert_id;
  v_off := v_prev.off_route_m;
  if v_r.status = 'en_curso' then
    v_dev_m := (v_cfg ->> 'deviation_m')::int;
    v_dev_min := (v_cfg ->> 'deviation_minutes')::int;
    -- Con mala precisión no se juzga el desvío.
    if v_last.acc is null or v_last.acc <= 200 then
      v_off := _path_distance_m(v_last.lat, v_last.lng, _route_path(v_r.id));
      if v_off is not null and v_off > v_dev_m then
        v_since := coalesce(v_since, v_last.t);
        if v_alert is null and v_last.t - v_since >= make_interval(mins => v_dev_min) then
          insert into route_alerts (tenant_id, route_id, kind, started_at, max_distance_m, lat, lng)
          values (v_tenant, v_r.id, 'desvio', v_since, v_off, v_last.lat, v_last.lng)
          returning id into v_alert;
          v_new := true;
          select * into v_veh from vehicles where id = v_r.vehicle_id;
          insert into notifications (target_tenant_id, target_role, type, severity, title, body, action_label, action_url,
                                     requires_ack, expires_at)
          select v_tenant, role, 'pedidos', 'warning',
                 'Un camión se desvió de la ruta',
                 'Hoja N° ' || v_r.number
                   || coalesce(' (' || v_veh.name || coalesce(' ' || v_veh.plate, '') || ')', '')
                   || ': está a ' || case when v_off >= 1000 then replace(round(v_off / 1000.0, 1)::text, '.', ',') || ' km'
                                  else v_off::text || ' m' end
                   || ' de la ruta planificada desde hace ' || v_dev_min || ' minutos o más.',
                 'Ver en el mapa', '/logistica/mapa?hoja=' || v_r.id::text,
                 false, now() + interval '12 hours'
            from unnest(array['owner', 'manager']) role;
          insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
          values (v_tenant, auth.uid(), 'delivery_routes', v_r.id, 'route_deviation_detected',
                  jsonb_build_object('alert_id', v_alert, 'distance_m', v_off, 'since', v_since,
                                     'lat', v_last.lat, 'lng', v_last.lng), v_r.store_id);
        elsif v_alert is not null then
          update route_alerts set max_distance_m = greatest(coalesce(max_distance_m, 0), v_off)
           where id = v_alert;
        end if;
      elsif v_off is not null then
        -- Volvió a la ruta: se cierra el desvío.
        if v_alert is not null then
          update route_alerts set ended_at = v_last.t where id = v_alert and ended_at is null;
        end if;
        v_since := null;
        v_alert := null;
      end if;
    end if;
  else
    -- Hoja cerrada: no hay desvío abierto.
    if v_alert is not null then
      update route_alerts set ended_at = coalesce(v_r.closed_at, now()) where id = v_alert and ended_at is null;
    end if;
    v_since := null;
    v_alert := null;
  end if;

  insert into route_positions_last (route_id, tenant_id, user_id, lat, lng, accuracy_m, speed_mps, heading, battery, charging,
                                    recorded_at, received_at, points, off_route_m, off_route_since, alert_id)
  values (v_r.id, v_tenant, auth.uid(), v_last.lat, v_last.lng, v_last.acc, v_last.spd, v_last.hdg, v_last.bat, v_last.chg,
          v_last.t, now(), v_n, v_off, v_since, v_alert)
  on conflict (route_id) do update set
    user_id = excluded.user_id, lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
    speed_mps = excluded.speed_mps, heading = excluded.heading,
    battery = coalesce(excluded.battery, route_positions_last.battery),
    charging = coalesce(excluded.charging, route_positions_last.charging),
    recorded_at = excluded.recorded_at, received_at = excluded.received_at,
    points = route_positions_last.points + excluded.points,
    off_route_m = excluded.off_route_m, off_route_since = excluded.off_route_since, alert_id = excluded.alert_id;

  return jsonb_build_object('ok', true, 'accepted', v_n, 'off_route_m', v_off, 'alert', v_alert is not null,
                            'new_alert', v_new);
end;
$$;
revoke all on function public.route_positions_push(uuid, jsonb) from public, anon;
grant execute on function public.route_positions_push(uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Mapa en vivo
-- -----------------------------------------------------------------------------
-- Hojas del día (no canceladas) con vehículo,
-- repartidor, origen, recorrido, última posición, alerta y paradas.
create or replace function public.route_live(p_date date, p_store uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_read_assert('logistics.track');
  v_stores uuid[] := user_allowed_store_ids();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'number', r.number, 'status', r.status, 'store_id', r.store_id,
             'service_date', r.service_date, 'started_at', r.started_at, 'closed_at', r.closed_at,
             'optimize_mode', r.optimize_mode, 'return_to_origin', r.return_to_origin,
             'planned_distance_m', r.planned_distance_m, 'planned_duration_s', r.planned_duration_s,
             'planned_path', r.planned_path,
             'vehicle', (select jsonb_build_object('id', v.id, 'name', v.name, 'plate', v.plate, 'kind', v.kind,
                                                   'brand', v.brand, 'model', v.model, 'color', v.color,
                                                   'cover_photo_path', v.cover_photo_path,
                                                   'capacity_kg', v.capacity_kg, 'capacity_packages', v.capacity_packages)
                           from vehicles v where v.id = r.vehicle_id),
             'driver', (select jsonb_build_object('user_id', u.id,
                                                  'name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email),
                                                  'phone', dp.phone)
                          from public.users u
                          left join tenant_users tu on tu.user_id = u.id and tu.tenant_id = v_tenant
                          left join driver_profiles dp on dp.user_id = u.id and dp.tenant_id = v_tenant and dp.deleted_at is null
                         where u.id = r.driver_user_id),
             'origin', (select jsonb_build_object('id', o.id, 'name', o.name, 'lat', o.lat, 'lng', o.lng)
                          from logistics_origins o where o.id = r.origin_id),
             'last', (select jsonb_build_object('lat', l.lat, 'lng', l.lng, 'accuracy_m', l.accuracy_m,
                                                'speed_mps', l.speed_mps, 'heading', l.heading, 'battery', l.battery,
                                                'charging', l.charging, 'recorded_at', l.recorded_at,
                                                'received_at', l.received_at, 'off_route_m', l.off_route_m,
                                                'off_route_since', l.off_route_since)
                        from route_positions_last l where l.route_id = r.id),
             'alert', (select jsonb_build_object('id', a.id, 'started_at', a.started_at, 'detected_at', a.detected_at,
                                                 'ended_at', a.ended_at, 'max_distance_m', a.max_distance_m,
                                                 'lat', a.lat, 'lng', a.lng)
                         from route_alerts a
                        where a.route_id = r.id and a.acknowledged_at is null
                        order by a.detected_at desc limit 1),
             'stops', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', s.id, 'seq', s.seq, 'status', s.status, 'lat', s.lat, 'lng', s.lng,
                        'contact_name', s.contact_name, 'address_text', s.address_text,
                        'locality', s.ship_to ->> 'locality', 'planned_offset_s', s.planned_offset_s,
                        'arrived_at', s.arrived_at, 'completed_at', s.completed_at,
                        'failure_reason_label', s.failure_reason_label,
                        'dispatches', (select count(*) from route_stop_dispatches x where x.stop_id = s.id))
                      order by s.seq)
                 from route_stops s
                where s.route_id = r.id and s.deleted_at is null), '[]'::jsonb))
           order by r.number)
      from delivery_routes r
     where r.tenant_id = v_tenant and r.deleted_at is null
       and r.service_date = coalesce(p_date, branch_today())
       and r.status in ('borrador', 'planificada', 'cargando', 'en_curso', 'cerrada')
       and (p_store is null or r.store_id = p_store)
       and r.store_id = any (v_stores)), '[]'::jsonb);
end;
$$;
revoke all on function public.route_live(date, uuid) from public, anon;
grant execute on function public.route_live(date, uuid) to authenticated;

-- Recorrido real de una hoja: [lat, lng, epoch] desde la salida, hasta
-- p_max puntos (uno de cada n y el último).
create or replace function public.route_track(p_route uuid, p_max integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_read_assert('logistics.track');
  v_r      delivery_routes;
  v_n      int;
  v_step   int;
  v_max    int := least(greatest(coalesce(p_max, 1500), 50), 3000);
begin
  select * into v_r from delivery_routes where id = p_route and tenant_id = v_tenant and deleted_at is null;
  if v_r.id is null or not (v_r.store_id = any (user_allowed_store_ids())) then
    raise exception 'route_not_found';
  end if;
  select count(*) into v_n from route_positions where route_id = p_route;
  v_step := greatest(1, ceil(v_n / v_max::numeric)::int);
  return jsonb_build_object(
    'count', v_n,
    'points', coalesce((
      select jsonb_agg(jsonb_build_array(round(lat::numeric, 6), round(lng::numeric, 6),
                                         extract(epoch from recorded_at)::bigint) order by recorded_at)
        from (select lat, lng, recorded_at, row_number() over (order by recorded_at) as i
                from route_positions where route_id = p_route) q
       where (i - 1) % v_step = 0 or i = v_n), '[]'::jsonb));
end;
$$;
revoke all on function public.route_track(uuid, integer) from public, anon;
grant execute on function public.route_track(uuid, integer) to authenticated;

-- Marcar visto un aviso de desvío.
create or replace function public.route_alert_ack(p_alert uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.track');
  v_a      route_alerts;
  v_store  uuid;
begin
  select * into v_a from route_alerts where id = p_alert and tenant_id = v_tenant;
  if v_a.id is null then
    raise exception 'alert_not_found';
  end if;
  select store_id into v_store from delivery_routes where id = v_a.route_id;
  if not coalesce(user_can_access_store(v_store), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_a.acknowledged_at is not null then
    return;
  end if;
  update route_alerts set acknowledged_by = auth.uid(), acknowledged_at = now() where id = p_alert;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_routes', v_a.route_id, 'route_alert_acknowledged',
          jsonb_build_object('alert_id', p_alert, 'kind', v_a.kind, 'max_distance_m', v_a.max_distance_m), v_store);
end;
$$;
revoke all on function public.route_alert_ack(uuid) from public, anon;
grant execute on function public.route_alert_ack(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Retención de posiciones (Ley 25.326: no se guardan para siempre)
-- -----------------------------------------------------------------------------
create or replace function public.route_positions_purge()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total int := 0;
  v_n     int;
  v_i     int := 0;
begin
  loop
    delete from route_positions
     where id in (
       select p.id
         from route_positions p
         left join route_tracking_settings s on s.tenant_id = p.tenant_id
        where p.recorded_at < now() - interval '7 days'
          and p.recorded_at < now() - make_interval(days => coalesce(s.retention_days, 90))
        limit 20000);
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    v_i := v_i + 1;
    exit when v_n < 20000 or v_i >= 50;
  end loop;
  delete from route_positions_last l
   using delivery_routes r
   left join route_tracking_settings s on s.tenant_id = r.tenant_id
   where r.id = l.route_id
     and l.recorded_at < now() - make_interval(days => coalesce(s.retention_days, 90));
  return v_total;
end;
$$;
revoke all on function public.route_positions_purge() from public, anon, authenticated;

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite la purga de posiciones.';
    return;
  end if;
  perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'route-positions-purge';
  -- 06:27 UTC = 03:27 en Argentina.
  perform cron.schedule('route-positions-purge', '27 6 * * *', $job$select public.route_positions_purge();$job$);
end;
$cron$;

-- -----------------------------------------------------------------------------
-- F) Edge routing (OpenRouteService opcional)
-- -----------------------------------------------------------------------------
alter table geo_usage drop constraint if exists geo_usage_kind_check;
alter table geo_usage add constraint geo_usage_kind_check
  check (kind in ('suggest', 'normalize', 'reverse', 'route_optimize', 'route_directions'));
alter table geo_providers drop constraint if exists geo_providers_key_check;
alter table geo_providers add constraint geo_providers_key_check
  check (key in ('photon', 'georef', 'nominatim', 'ors'));
-- ORS gratuito: 40 pedidos por minuto para toda la cuenta.
insert into geo_providers (key, enabled, min_interval_ms) values ('ors', true, 1600)
on conflict (key) do nothing;

-- ¿Puede este usuario planificar con la Edge routing? null = sí.
create or replace function routing_guard(p_tenant uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from tenant_users
                      where tenant_id = p_tenant and user_id = p_user and status = 'active') then 'forbidden'
    when not tenant_has_feature_for(p_tenant, 'reparto_propio') then 'feature_not_in_plan'
    when not ('logistics.route.manage' = any (capabilities_for(p_tenant, p_user, null))) then 'forbidden_capability'
    else null
  end;
$$;
revoke all on function routing_guard(uuid, uuid) from public, anon, authenticated;
grant execute on function routing_guard(uuid, uuid) to service_role;

comment on function public.route_positions_push(uuid, jsonb) is
  'ADR-164: lote de posiciones del repartidor (idempotente por id) con detección de desvío contra el recorrido planificado.';
