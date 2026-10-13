-- =============================================================================
-- 20261110500000_catalogo_sync_railway  (ADR-106)
--
-- Tiendita: el catálogo precargado deja de cargarse con el Excel por script
-- (scripts/import_catalog.cjs) y pasa a sincronizarse solo desde el feed del
-- scraper del dueño (Railway, GET /api/feed/*, Bearer FEED_TOKEN). La Edge
-- `catalog_sync` lee el feed por tandas y escribe con service_role por las RPC
-- de abajo; el panel interno sólo lee el estado.
--
--  1) catalog_products.feed_seen_at: inicio de la corrida que vio el producto
--     por última vez en el feed. En una corrida COMPLETA de una tienda, lo que
--     no se vio queda no disponible (estado FALTANTE_EN_FEED). Nunca se borra.
--  2) catalog_sync_runs: una fila por corrida (manual o semanal) con el estado
--     por tienda en `stores` (cursor del feed, since, nuevos, actualizados,
--     faltantes, errores), totales, lease (locked_until) e invocaciones. Una
--     sola corrida abierta a la vez (índice único parcial).
--     RLS: sólo lectura para staff interno en el panel interno
--     ((select internal_scope()), initplan; nunca OR is_internal()). Sin
--     escritura por REST: escribe la Edge con service_role.
--  3) RPC sólo para service_role (SECURITY DEFINER, search_path fijo):
--       catalog_sync_enqueue   abre la corrida (o devuelve la abierta) y audita
--                              la manual en audit_logs.
--       catalog_sync_claim     toma la corrida abierta con lease.
--       catalog_sync_any_due   ¿hay corrida abierta sin lease? (para el cron).
--       catalog_sync_upsert_stores   alta sola de tiendas nuevas del feed.
--       catalog_sync_upsert_products upsert batcheado por (store_key, ean),
--                              misma semántica de columnas que el import.
--       catalog_sync_finish_store    faltantes (si fue completa) + conteo.
--       catalog_sync_finalize  recuento público + aviso a los negocios por
--                              catálogo afectado y cierre de la corrida.
--  4) notify_catalog_update: se puede llamar server-side sin sesión
--     (service_role), igual que catalog_recount_products. Cuerpo idéntico.
--  5) pg_cron: semanal sábado 06:00 AR (09:00 UTC, después de la corrida del
--     viernes) abre la corrida y llama a la Edge; cada minuto, si hay una
--     corrida abierta sin lease, la Edge la continúa desde el cursor guardado.
--     Patrón de los crons internos (X-Cron-Secret = platform_secrets
--     'internal_cron'). Sin pg_cron o pg_net (stack local, CI) se omite.
--
-- NO aplicada en ningún entorno al commitear.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) catalog_products.feed_seen_at
-- -----------------------------------------------------------------------------
alter table public.catalog_products add column if not exists feed_seen_at timestamptz;

comment on column public.catalog_products.feed_seen_at is
  'Inicio de la corrida de catalog_sync que vio el producto en el feed por última vez. '
  'Null = cargado por Excel y nunca visto en el feed.';

-- -----------------------------------------------------------------------------
-- 2) catalog_sync_runs
-- -----------------------------------------------------------------------------
create table if not exists public.catalog_sync_runs (
  id             uuid primary key default gen_random_uuid(),
  trigger        text not null check (trigger in ('manual', 'cron')),
  status         text not null default 'running'
                   check (status in ('running', 'ok', 'partial', 'error')),
  force_full     boolean not null default false,
  mode           text check (mode in ('full', 'incremental', 'mixed')),
  -- Estado por tienda: { "<KEY>": { label, since, full, cursor, done, pages,
  --   nuevos, actualizados, faltantes, marcados, errores, error } }
  stores         jsonb not null default '{}'::jsonb,
  current_store  text,
  nuevos         integer not null default 0,
  actualizados   integer not null default 0,
  faltantes      integer not null default 0,
  errores        integer not null default 0,
  last_error     text,
  invocations    integer not null default 0,
  locked_until   timestamptz,
  heartbeat_at   timestamptz,
  created_by     uuid references public.users(id),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Una sola corrida abierta a la vez.
create unique index if not exists catalog_sync_runs_one_open
  on public.catalog_sync_runs ((true)) where status = 'running';
-- Historial (panel) y "última corrida OK" (since incremental).
create index if not exists catalog_sync_runs_started_idx
  on public.catalog_sync_runs (started_at desc);
create index if not exists catalog_sync_runs_created_by_idx
  on public.catalog_sync_runs (created_by);

drop trigger if exists set_updated_at_catalog_sync_runs on public.catalog_sync_runs;
create trigger set_updated_at_catalog_sync_runs
  before update on public.catalog_sync_runs
  for each row execute function set_updated_at();

alter table public.catalog_sync_runs enable row level security;

drop policy if exists catalog_sync_runs_internal_read on public.catalog_sync_runs;
create policy catalog_sync_runs_internal_read on public.catalog_sync_runs
  for select to authenticated
  using ((select internal_scope()));
-- Sin policies de escritura: sólo la Edge catalog_sync con service_role.

revoke all on table public.catalog_sync_runs from anon;
revoke insert, update, delete, truncate on table public.catalog_sync_runs from authenticated;
grant select on table public.catalog_sync_runs to authenticated;
grant all on table public.catalog_sync_runs to service_role;

-- -----------------------------------------------------------------------------
-- 3) RPC de la sync (sólo service_role)
-- -----------------------------------------------------------------------------

-- Abre una corrida. Si ya hay una abierta, devuelve esa (no duplica). Cierra
-- como error las colgadas hace más de 12 h. La manual se audita acá mismo.
create or replace function public.catalog_sync_enqueue(
  p_trigger text,
  p_user uuid default null,
  p_full boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if p_trigger not in ('manual', 'cron') then
    raise exception 'invalid_trigger';
  end if;

  update catalog_sync_runs
     set status = 'error', finished_at = now(), locked_until = null,
         last_error = coalesce(last_error, 'timeout: la corrida quedó abierta más de 12 h')
   where status = 'running'
     and started_at < now() - interval '12 hours';

  select id into v_id from catalog_sync_runs where status = 'running' limit 1;

  if v_id is null then
    begin
      insert into catalog_sync_runs (trigger, force_full, created_by)
      values (p_trigger, coalesce(p_full, false), p_user)
      returning id into v_id;
    exception when unique_violation then
      select id into v_id from catalog_sync_runs where status = 'running' limit 1;
    end;
  end if;

  if p_trigger = 'manual' then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (null, p_user, 'catalog_sync_runs', v_id, 'catalog_sync_requested',
            jsonb_build_object('run_id', v_id, 'force_full', coalesce(p_full, false)));
  end if;

  return v_id;
end;
$function$;

-- Toma la corrida abierta si nadie la tiene (lease vencido o libre).
create or replace function public.catalog_sync_claim(
  p_run uuid default null,
  p_lease_seconds integer default 170
)
returns setof public.catalog_sync_runs
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  update catalog_sync_runs
     set locked_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 170), 30)),
         heartbeat_at = now(),
         invocations = invocations + 1
   where status = 'running'
     and (locked_until is null or locked_until < now())
     and (p_run is null or id = p_run)
  returning *;
$function$;

create or replace function public.catalog_sync_any_due()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from catalog_sync_runs
     where status = 'running'
       and (locked_until is null or locked_until < now())
  );
$function$;

-- Tiendas del feed: crea las nuevas con label y logo. De las existentes sólo
-- completa el logo si no tiene (no pisa el que subió el staff ni el nombre).
-- p_stores: [{ "key": "COTO", "name": "Coto", "logo_url": "https://..." }]
create or replace function public.catalog_sync_upsert_stores(p_stores jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_new integer;
begin
  with src as (
    select upper(btrim(s.key)) as key,
           coalesce(nullif(btrim(s.name), ''), upper(btrim(s.key))) as name,
           nullif(btrim(s.logo_url), '') as logo_url
      from jsonb_to_recordset(coalesce(p_stores, '[]'::jsonb)) as s(key text, name text, logo_url text)
     where nullif(btrim(s.key), '') is not null
  ), up as (
    insert into catalog_stores as cs (key, name, logo_url)
    select key, name, logo_url from src
    on conflict (key) do update
       set logo_url = coalesce(cs.logo_url, excluded.logo_url)
     where cs.logo_url is null and excluded.logo_url is not null
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_new from up;
  return coalesce(v_new, 0);
end;
$function$;

-- Upsert batcheado de una tienda. Columnas como scripts/import_catalog.cjs
-- (titulo, precio, precio_lista, marca, categoria_path, foto_url, disponible,
-- estado, id_origen) más descripcion/atributos. Varias publicaciones del mismo
-- EAN en una tienda: gana la misma publicación (id_origen), la que todavía no
-- se vio en esta corrida completa, o la "mejor" (disponible y más barata).
-- p_rows: [{ ean, titulo, precio, precio_lista, marca, categoria_path,
--            foto_url, disponible, estado, id_origen, descripcion, atributos }]
create or replace function public.catalog_sync_upsert_products(
  p_run uuid,
  p_store text,
  p_full boolean,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_started timestamptz;
  v_in integer;
  v_nuevos integer;
  v_actualizados integer;
  v_faltantes integer;
begin
  select started_at into v_started from catalog_sync_runs where id = p_run;
  if v_started is null then
    raise exception 'run_not_found';
  end if;

  with src as (
    select distinct on (btrim(r.ean))
           btrim(r.ean) as ean, btrim(r.titulo) as titulo, r.precio, r.precio_lista,
           r.marca, r.categoria_path, r.foto_url, coalesce(r.disponible, false) as disponible,
           r.estado, r.id_origen, r.descripcion, r.atributos
      from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
             ean text, titulo text, precio numeric, precio_lista numeric, marca text,
             categoria_path text, foto_url text, disponible boolean, estado text,
             id_origen text, descripcion text, atributos jsonb)
     where nullif(btrim(r.ean), '') is not null
       and nullif(btrim(r.titulo), '') is not null
     order by btrim(r.ean), coalesce(r.disponible, false) desc, coalesce(nullif(r.precio, 0), 1e15)
  ), up as (
    insert into catalog_products as cp (
      store_key, ean, titulo, precio, precio_lista, marca, categoria_path, foto_url,
      disponible, estado, id_origen, descripcion, atributos, updated_at, feed_seen_at
    )
    select p_store, ean, titulo, precio, precio_lista, marca, categoria_path, foto_url,
           disponible, estado, id_origen, descripcion, atributos, now(), v_started
      from src
    on conflict (store_key, ean) do update
       set titulo = excluded.titulo,
           precio = excluded.precio,
           precio_lista = excluded.precio_lista,
           marca = excluded.marca,
           categoria_path = excluded.categoria_path,
           foto_url = excluded.foto_url,
           disponible = excluded.disponible,
           estado = excluded.estado,
           id_origen = excluded.id_origen,
           descripcion = coalesce(excluded.descripcion, cp.descripcion),
           atributos = coalesce(excluded.atributos, cp.atributos),
           updated_at = now(),
           feed_seen_at = excluded.feed_seen_at
     where cp.feed_seen_at is null
        or cp.id_origen is not distinct from excluded.id_origen
        or (p_full and cp.feed_seen_at < v_started)
        or (excluded.disponible and not cp.disponible)
        or (excluded.disponible = cp.disponible
            and coalesce(nullif(excluded.precio, 0), 1e15) < coalesce(nullif(cp.precio, 0), 1e15))
    returning (xmax = 0) as inserted
  )
  select (select count(*) from src),
         count(*) filter (where inserted),
         count(*) filter (where not inserted)
    into v_in, v_nuevos, v_actualizados
    from up;

  select count(*) into v_faltantes
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(estado text)
   where r.estado like 'FALTANTE%';

  return jsonb_build_object(
    'recibidos', coalesce(v_in, 0),
    'nuevos', coalesce(v_nuevos, 0),
    'actualizados', coalesce(v_actualizados, 0),
    'faltantes', coalesce(v_faltantes, 0),
    'ignorados', greatest(coalesce(v_in, 0) - coalesce(v_nuevos, 0) - coalesce(v_actualizados, 0), 0)
  );
end;
$function$;

-- Cierre de una tienda: si la lectura fue COMPLETA, lo que no vino en el feed
-- queda no disponible (no se borra). Después, conteo y fecha de la tienda.
create or replace function public.catalog_sync_finish_store(
  p_run uuid,
  p_store text,
  p_full boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_started timestamptz;
  v_marcados integer := 0;
  v_count bigint;
begin
  select started_at into v_started from catalog_sync_runs where id = p_run;
  if v_started is null then
    raise exception 'run_not_found';
  end if;

  if p_full then
    update catalog_products
       set disponible = false, estado = 'FALTANTE_EN_FEED', updated_at = now()
     where store_key = p_store
       and (feed_seen_at is null or feed_seen_at < v_started)
       and (disponible or coalesce(estado, '') not like 'FALTANTE%');
    get diagnostics v_marcados = row_count;
  end if;

  select count(*) into v_count from catalog_products where store_key = p_store;

  update catalog_stores
     set product_count = coalesce(v_count, 0), last_import_at = now()
   where key = p_store;

  return jsonb_build_object('marcados', v_marcados, 'product_count', coalesce(v_count, 0));
end;
$function$;

-- Cierre de la corrida: recuento público y aviso "+N productos" por cada
-- catálogo que incluye alguna tienda sincronizada. ok si ninguna tienda quedó
-- con error; partial si alguna sí.
create or replace function public.catalog_sync_finalize(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_stores jsonb;
  v_keys text[];
  v_errors boolean;
  r record;
  v_catalogs integer := 0;
  v_notified integer := 0;
begin
  select stores into v_stores from catalog_sync_runs where id = p_run;
  if v_stores is null then
    raise exception 'run_not_found';
  end if;

  select coalesce(array_agg(k), '{}'),
         coalesce(bool_or(nullif(v_stores -> k ->> 'error', '') is not null), false)
    into v_keys, v_errors
    from jsonb_object_keys(v_stores) as k;

  for r in
    select distinct csm.catalog_id
      from catalog_store_map csm
     where csm.store_key = any (v_keys)
  loop
    perform catalog_recount_products(r.catalog_id);
    v_notified := v_notified + coalesce(notify_catalog_update(r.catalog_id), 0);
    v_catalogs := v_catalogs + 1;
  end loop;

  update catalog_sync_runs
     set status = case when v_errors then 'partial' else 'ok' end,
         finished_at = now(), locked_until = null, current_store = null
   where id = p_run;

  return jsonb_build_object('catalogos', v_catalogs, 'notificados', v_notified,
                            'status', case when v_errors then 'partial' else 'ok' end);
end;
$function$;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.catalog_sync_enqueue(text, uuid, boolean)',
    'public.catalog_sync_claim(uuid, integer)',
    'public.catalog_sync_any_due()',
    'public.catalog_sync_upsert_stores(jsonb)',
    'public.catalog_sync_upsert_products(uuid, text, boolean, jsonb)',
    'public.catalog_sync_finish_store(uuid, text, boolean)',
    'public.catalog_sync_finalize(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $grants$;

-- -----------------------------------------------------------------------------
-- 4) notify_catalog_update: también server-side sin sesión (service_role), como
--    catalog_recount_products. Mismo cuerpo que 20260608450000; sólo cambia el
--    guard (antes exigía is_internal() y el import por script fallaba).
-- -----------------------------------------------------------------------------
create or replace function public.notify_catalog_update(p_catalog_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_name text;
  v_total bigint;
  r record;
  v_delta bigint;
  v_count integer := 0;
begin
  if auth.uid() is not null and not is_internal() then
    raise exception 'forbidden';
  end if;

  select c.dedupe_by_ean, c.name into v_dedupe, v_name
    from catalogs c where c.id = p_catalog_id;
  if v_name is null then
    raise exception 'catalog_not_found';
  end if;

  if v_dedupe then
    select count(distinct cp.ean) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  else
    select count(*) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  end if;

  v_total := coalesce(v_total, 0);

  -- Persistir el conteo público (info comercial del storefront).
  update catalogs set product_count = v_total where id = p_catalog_id;

  for r in
    select tcp.id, tcp.tenant_id, tcp.last_notified_product_count
      from tenant_catalog_purchases tcp
      join tenants t on t.id = tcp.tenant_id
     where tcp.catalog_id = p_catalog_id
       and t.deleted_at is null
  loop
    v_delta := v_total - r.last_notified_product_count;
    if v_delta > 0 and r.last_notified_product_count > 0 then
      insert into notifications (
        target_tenant_id, target_role, type, severity, title, body, created_by
      )
      values (
        r.tenant_id, 'owner', 'news', 'info',
        'Tu catálogo "' || v_name || '" se actualizó',
        'Se sumaron ' || v_delta::text || ' productos nuevos al catálogo "'
          || v_name || '". Ya podés buscarlos y agregarlos a tu tienda.',
        auth.uid()
      );
      v_count := v_count + 1;
    end if;
    update tenant_catalog_purchases
       set last_notified_product_count = v_total
     where id = r.id;
  end loop;

  return v_count;
end;
$function$;

revoke all on function public.notify_catalog_update(uuid) from public, anon;
grant execute on function public.notify_catalog_update(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5) pg_cron: semanal + continuación por minuto
-- -----------------------------------------------------------------------------
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/catalog_sync';
  v_post text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten los jobs de catalog_sync.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omiten los jobs de catalog_sync.';
    return;
  end if;

  v_post := format($post$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := '{"mode":"cron"}'::jsonb,
      timeout_milliseconds := 30000
    )
  $post$, v_url);

  -- Sábado 06:00 AR = 09:00 UTC (Argentina no tiene horario de verano). La
  -- corrida se abre en la base ANTES del POST: si el POST se pierde, el job
  -- de continuación la toma al minuto siguiente.
  if exists (select 1 from cron.job where jobname = 'catalog-sync-weekly') then
    perform cron.unschedule('catalog-sync-weekly');
  end if;
  perform cron.schedule('catalog-sync-weekly', '0 9 * * 6',
    v_post || ' where public.catalog_sync_enqueue(''cron'', null, false) is not null;');

  -- Continuación: cada minuto, sólo si hay una corrida abierta sin lease.
  if exists (select 1 from cron.job where jobname = 'catalog-sync-continue') then
    perform cron.unschedule('catalog-sync-continue');
  end if;
  perform cron.schedule('catalog-sync-continue', '* * * * *',
    v_post || ' where public.catalog_sync_any_due();');
end;
$cron$;
