-- =============================================================================
-- 20261130100000_cotizacion_dolar_api  (ADR-135, sobre F21 · ADR-121)
--
-- Cotización del dólar diaria para el panel interno: venta del dólar OFICIAL
-- de ArgentinaDatos (https://api.argentinadatos.com/v1/cotizaciones/dolares/
-- oficial), traída todos los días por la Edge platform_fx_sync (pg_cron +
-- pg_net), con backfill de 2 años en la primera corrida. La liquidación del
-- staff (F21) usa la venta del día de cada gasto en dólares o la última
-- disponible antes; la tabla mensual staff_fx_rates queda sólo de respaldo.
--
-- Modelo (de plataforma, sin tenant_id; RLS con (select internal_scope()),
-- nunca OR is_internal()). No se reutiliza fx_rates (es de cada negocio,
-- listas de precios pro) ni staff_fx_rates (mensual, sin compra/venta):
--   · platform_fx_rates  una fila por día, casa y fuente ('api' | 'manual').
--                        Idempotente por (rate_date, casa, source): la Edge
--                        hace upsert. La manual tiene prioridad sobre la de la
--                        API ese día (platform_fx_daily_rates resuelve). Baja
--                        lógica de la manual con deleted_at (vuelve a mandar
--                        la de la API).
--   · platform_fx_runs   cada corrida de la Edge (ok / error, intentos,
--                        mensaje): el panel avisa si la última falló o si la
--                        cotización quedó vieja.
--
-- Quién:
--   · Lee: cualquier staff interno en el panel interno.
--   · Carga o borra a mano: el super_admin (como el resto de F21), auditado.
--   · Ingesta de la API: sólo service_role (la Edge).
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tablas
-- -----------------------------------------------------------------------------
create table if not exists platform_fx_rates (
  id          uuid primary key default gen_random_uuid(),
  rate_date   date not null,
  casa        text not null default 'oficial' check (casa ~ '^[a-z]{2,20}$'),
  compra      numeric(14, 4) check (compra is null or compra > 0),
  venta       numeric(14, 4) not null check (venta > 0 and venta <= 1000000),
  source      text not null check (source in ('api', 'manual')),
  note        text check (note is null or length(note) <= 120),
  fetched_at  timestamptz,
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (rate_date, casa, source)
);

create index if not exists platform_fx_rates_casa_date_idx on platform_fx_rates (casa, rate_date desc);
create index if not exists platform_fx_rates_created_by_idx on platform_fx_rates (created_by) where created_by is not null;
create index if not exists platform_fx_rates_updated_by_idx on platform_fx_rates (updated_by) where updated_by is not null;

create table if not exists platform_fx_runs (
  id           uuid primary key default gen_random_uuid(),
  origin       text not null check (origin in ('cron', 'manual', 'backfill')),
  status       text not null check (status in ('ok', 'error')),
  casa         text not null default 'oficial',
  attempts     int not null default 1 check (attempts between 1 and 20),
  received     int not null default 0,
  upserted     int not null default 0,
  latest_date  date,
  message      text check (message is null or length(message) <= 500),
  actor        uuid references users(id),
  created_at   timestamptz not null default now()
);

create index if not exists platform_fx_runs_created_idx on platform_fx_runs (created_at desc);
create index if not exists platform_fx_runs_actor_idx on platform_fx_runs (actor) where actor is not null;

-- -----------------------------------------------------------------------------
-- B) RLS: sólo lectura para el staff interno en el panel interno. Nadie
--    escribe directo: RPC (manual) o service_role (Edge).
-- -----------------------------------------------------------------------------
alter table platform_fx_rates enable row level security;
alter table platform_fx_runs  enable row level security;

drop policy if exists platform_fx_rates_internal_read on platform_fx_rates;
create policy platform_fx_rates_internal_read on platform_fx_rates for select to authenticated
  using ((select internal_scope()));

drop policy if exists platform_fx_runs_internal_read on platform_fx_runs;
create policy platform_fx_runs_internal_read on platform_fx_runs for select to authenticated
  using ((select internal_scope()));

revoke all on table platform_fx_rates, platform_fx_runs from anon;
revoke insert, update, delete, truncate on table platform_fx_rates, platform_fx_runs from authenticated;
grant select on table platform_fx_rates, platform_fx_runs to authenticated;

-- -----------------------------------------------------------------------------
-- C) Cotización efectiva por día: una fila por fecha, la manual (sin borrar)
--    gana sobre la de la API. SECURITY INVOKER: respeta la RLS de platform_fx_rates
--    (staff interno) y la Edge la lee con service_role.
-- -----------------------------------------------------------------------------
create or replace function platform_fx_daily_rates(p_casa text default 'oficial', p_from date default null, p_to date default null)
returns table (rate_date date, venta numeric, compra numeric, source text, note text, updated_at timestamptz)
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct on (f.rate_date)
         f.rate_date, f.venta, f.compra, f.source, f.note, f.updated_at
    from platform_fx_rates f
   where f.casa = coalesce(p_casa, 'oficial')
     and f.deleted_at is null
     and (p_from is null or f.rate_date >= p_from)
     and (p_to is null or f.rate_date <= p_to)
   order by f.rate_date, (f.source = 'manual') desc, f.updated_at desc;
$$;

-- -----------------------------------------------------------------------------
-- D) Ingesta de la API (sólo service_role): upsert idempotente por día y
--    registro de la corrida. Con p_status = 'error' sólo registra el aviso.
--    p_rows: [{ "date": "YYYY-MM-DD", "compra": n|null, "venta": n }]
-- -----------------------------------------------------------------------------
create or replace function platform_fx_ingest(p_trigger text, p_status text, p_rows jsonb, p_attempts int,
                                           p_message text, p_actor uuid default null, p_casa text default 'oficial')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_casa     text := coalesce(nullif(btrim(p_casa), ''), 'oficial');
  v_received int := coalesce(jsonb_array_length(case when jsonb_typeof(p_rows) = 'array' then p_rows end), 0);
  v_upserted int := 0;
  v_latest   date;
  v_run      uuid;
begin
  if p_trigger not in ('cron', 'manual', 'backfill') or p_status not in ('ok', 'error') then
    raise exception 'invalid_args' using errcode = '22023';
  end if;

  if p_status = 'ok' and v_received > 0 then
    with src as (
      select (x ->> 'date')::date as d,
             nullif(x ->> 'compra', '')::numeric as compra,
             (x ->> 'venta')::numeric as venta
        from jsonb_array_elements(p_rows) x
       where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
         and nullif(x ->> 'venta', '') is not null
    ), ok as (
      select distinct on (d) d, compra, venta from src
       where venta > 0 and venta <= 1000000
       order by d
    ), up as (
      insert into platform_fx_rates (rate_date, casa, compra, venta, source, note, fetched_at)
      select d, v_casa, case when compra > 0 then round(compra, 4) end, round(venta, 4), 'api', 'ArgentinaDatos', now()
        from ok
      on conflict (rate_date, casa, source) do update
        set compra = excluded.compra,
            venta = excluded.venta,
            fetched_at = excluded.fetched_at,
            updated_at = now()
        where platform_fx_rates.venta is distinct from excluded.venta
           or platform_fx_rates.compra is distinct from excluded.compra
      returning rate_date
    )
    select count(*) into v_upserted from up;
  end if;

  select max(rate_date) into v_latest from platform_fx_rates where casa = v_casa and source = 'api';

  insert into platform_fx_runs (origin, status, casa, attempts, received, upserted, latest_date, message, actor)
  values (p_trigger, p_status, v_casa, greatest(1, least(coalesce(p_attempts, 1), 20)), v_received, v_upserted, v_latest,
          left(nullif(btrim(coalesce(p_message, '')), ''), 500), p_actor)
  returning id into v_run;

  -- Historial acotado: las corridas de más de 180 días no aportan.
  delete from platform_fx_runs where created_at < now() - interval '180 days';

  return jsonb_build_object('run_id', v_run, 'received', v_received, 'upserted', v_upserted, 'latest_date', v_latest);
end;
$$;

-- Fecha desde la que la Edge pide: sin datos de la API, backfill de 2 años;
-- si no, los últimos 15 días (cubre fines de semana, feriados y caídas).
create or replace function platform_fx_sync_from(p_casa text default 'oficial')
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
           when exists (select 1 from platform_fx_rates where casa = coalesce(p_casa, 'oficial') and source = 'api')
             then staff_ar_today() - 15
           else (staff_ar_today() - interval '2 years')::date
         end;
$$;

-- -----------------------------------------------------------------------------
-- E) Carga manual (super_admin, auditada). Manda sobre la de la API ese día.
-- -----------------------------------------------------------------------------
create or replace function internal_fx_set_manual(p_date date, p_venta numeric, p_compra numeric, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  perform staff_assert_owner();
  if p_date is null or p_date > staff_ar_today() + 1 or p_date < date '2000-01-01' then
    raise exception 'invalid_date' using errcode = '22023';
  end if;
  if p_venta is null or p_venta <= 0 or p_venta > 1000000 or (p_compra is not null and (p_compra <= 0 or p_compra > 1000000)) then
    raise exception 'invalid_rate' using errcode = '22023';
  end if;
  select to_jsonb(f) into v_before from platform_fx_rates f where rate_date = p_date and casa = 'oficial' and source = 'manual';
  insert into platform_fx_rates (rate_date, casa, compra, venta, source, note, created_by, updated_by)
  values (p_date, 'oficial', round(p_compra, 4), round(p_venta, 4), 'manual', nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), auth.uid())
  on conflict (rate_date, casa, source) do update
    set compra = excluded.compra, venta = excluded.venta, note = excluded.note,
        updated_by = excluded.updated_by, updated_at = now(), deleted_at = null;
  perform staff_audit('fx_rate', null, 'fx_manual_set', v_before,
                      jsonb_build_object('date', p_date, 'venta', round(p_venta, 4), 'compra', round(p_compra, 4), 'note', p_note),
                      'Cotización del dólar cargada a mano');
end;
$$;

create or replace function internal_fx_clear_manual(p_date date, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
begin
  perform staff_assert_owner();
  select to_jsonb(f) into v_before from platform_fx_rates f
   where rate_date = p_date and casa = 'oficial' and source = 'manual' and deleted_at is null;
  if v_before is null then
    raise exception 'fx_manual_not_found' using errcode = 'P0002';
  end if;
  update platform_fx_rates set deleted_at = now(), updated_by = auth.uid(), updated_at = now()
   where rate_date = p_date and casa = 'oficial' and source = 'manual';
  perform staff_audit('fx_rate', (v_before ->> 'id')::uuid, 'fx_manual_cleared', v_before, null, v_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- F) Permisos de funciones
-- -----------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'platform_fx_daily_rates(text, date, date)',
    'internal_fx_set_manual(date, numeric, numeric, text)',
    'internal_fx_clear_manual(date, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'platform_fx_ingest(text, text, jsonb, int, text, uuid, text)',
    'platform_fx_sync_from(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$grants$;

-- -----------------------------------------------------------------------------
-- G) pg_cron: platform-fx-sync dos veces por día (09:15 y 18:15 ART = 12:15 y
--    21:15 UTC) por la Edge platform_fx_sync. Idempotente: la segunda corrida
--    sólo completa lo que falte o haya cambiado. Sin pg_cron o sin pg_net
--    (local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/platform_fx_sync';
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_cron o pg_net no disponible; se omite platform-fx-sync.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-fx-sync') then
    perform cron.unschedule('platform-fx-sync');
  end if;
  perform cron.schedule('platform-fx-sync', '15 12,21 * * *', format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := jsonb_build_object('mode', 'cron'),
      timeout_milliseconds := 55000
    );
  $job$, v_url));
end
$cron$;
