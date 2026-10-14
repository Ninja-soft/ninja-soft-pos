-- =============================================================================
-- 20261111400000_catalogo_sync_config  (ADR-113)
--
-- La sincronización automática del catálogo (ADR-107/109) deja de tener una
-- agenda fija (job `catalog-sync-weekly`, sábado 06:00 AR) y pasa a
-- configurarse desde el panel interno.
--
--  1) catalog_sync_config: fila única con la agenda (activa, diaria / semanal
--     con días / cada N días / cron avanzado, hora Argentina), tipo de corrida
--     automática (incremental o completa) y "una completa cada K corridas".
--     RLS: sólo lectura para staff interno en el panel interno
--     ((select internal_scope()), initplan; nunca OR is_internal()). Sin
--     escritura por REST: sólo la RPC de abajo.
--  2) catalog_sync_runs: pausa (paused_at / resumed_at) y estado 'cancelled'
--     (baja lógica: la corrida queda en el historial, no se borra nada). Un
--     trigger impide que una corrida cancelada vuelva a otro estado (una Edge
--     vieja que termine su tanda no la "revive").
--     catalog_sync_claim / catalog_sync_any_due no toman corridas pausadas;
--     catalog_sync_enqueue no cierra por timeout una pausada y cuenta las 12 h
--     desde que se reanudó. Mismas firmas.
--  3) Agenda en SQL (mismas reglas que modules/internal/catalogSyncSchedule.ts):
--       catalog_sync_cron_set        expande un campo de cron (o 'invalid_cron').
--       catalog_sync_cron_valid      ¿expresión de 5 campos válida?
--       catalog_sync_cron_matches    ¿el minuto (hora AR) coincide?
--       catalog_sync_schedule_matches  agenda completa (incluye cada N días).
--       catalog_sync_due             ¿toca abrir una corrida automática?
--       catalog_sync_tick            si toca, la abre (completa o incremental)
--                                    y devuelve si hay una corrida para continuar.
--  4) RPC del panel (SECURITY DEFINER, search_path fijo, staff interno en el
--     panel interno, nivel admin o super_admin; soporte no; auditadas en
--     audit_logs antes de responder):
--       internal_catalog_sync_config_save(jsonb)   valida y guarda la agenda.
--       internal_catalog_sync_control(uuid, text)  pause / resume / cancel.
--  5) pg_cron: se BORRA `catalog-sync-weekly` y `catalog-sync-continue` (cada
--     minuto, mismo nombre y mismo POST) pasa a `where catalog_sync_tick()`:
--     abre la corrida automática cuando la agenda lo pide y continúa la que
--     esté abierta. No se reprograma pg_cron desde la RPC: la agenda vive en
--     la tabla (cada N días y "completa cada K" no se pueden expresar en cron,
--     y no dependemos de permisos sobre el esquema cron). La config inicial
--     reproduce el job viejo (sábado 06:00 AR, incremental). Sin pg_cron o
--     pg_net (stack local, CI) se omite.
--
-- NO aplicada en ningún entorno al commitear.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) catalog_sync_config
-- -----------------------------------------------------------------------------
create table if not exists public.catalog_sync_config (
  id                   boolean primary key default true check (id),
  enabled              boolean not null default true,
  frequency            text not null default 'weekly'
                         check (frequency in ('daily', 'weekly', 'interval', 'cron')),
  -- 0 = domingo … 6 = sábado (hora Argentina).
  weekdays             smallint[] not null default '{6}',
  interval_days        smallint check (interval_days between 1 and 90),
  anchor_date          date,
  hour                 smallint not null default 6 check (hour between 0 and 23),
  minute               smallint not null default 0 check (minute between 0 and 59),
  cron_expr            text,
  run_kind             text not null default 'incremental' check (run_kind in ('incremental', 'full')),
  full_every           smallint check (full_every between 2 and 52),
  auto_runs_since_full integer not null default 0,
  last_check_at        timestamptz,
  last_auto_at         timestamptz,
  last_auto_run        uuid,
  last_auto_note       text,
  updated_by           uuid references public.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint catalog_sync_config_weekly_days check (
    frequency <> 'weekly'
    or (cardinality(weekdays) >= 1 and weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
  ),
  constraint catalog_sync_config_interval check (frequency <> 'interval' or interval_days is not null),
  constraint catalog_sync_config_cron check (frequency <> 'cron' or nullif(btrim(cron_expr), '') is not null)
);

comment on table public.catalog_sync_config is
  'Agenda de la sincronización automática del catálogo (ADR-113). Fila única. La evalúa '
  'catalog_sync_tick() cada minuto (job catalog-sync-continue). Escribe sólo '
  'internal_catalog_sync_config_save().';

create index if not exists catalog_sync_config_updated_by_idx on public.catalog_sync_config (updated_by);

alter table public.catalog_sync_config enable row level security;

drop policy if exists catalog_sync_config_internal_read on public.catalog_sync_config;
create policy catalog_sync_config_internal_read on public.catalog_sync_config
  for select to authenticated
  using ((select internal_scope()));
-- Sin policies de escritura: sólo internal_catalog_sync_config_save (definer).

revoke all on table public.catalog_sync_config from anon;
revoke insert, update, delete, truncate on table public.catalog_sync_config from authenticated;
grant select on table public.catalog_sync_config to authenticated;
grant all on table public.catalog_sync_config to service_role;

-- Agenda inicial = el job fijo que reemplaza (sábado 06:00 AR, incremental).
insert into public.catalog_sync_config (id, last_check_at)
values (true, now())
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 2) catalog_sync_runs: pausa y cancelación
-- -----------------------------------------------------------------------------
alter table public.catalog_sync_runs add column if not exists paused_at timestamptz;
alter table public.catalog_sync_runs add column if not exists resumed_at timestamptz;

comment on column public.catalog_sync_runs.paused_at is
  'Pausada por el staff (ADR-113): no se toma ni se continúa hasta reanudarla. Sigue siendo la corrida abierta.';
comment on column public.catalog_sync_runs.resumed_at is
  'Última vez que se reanudó. El timeout de 12 h se cuenta desde acá (o desde started_at).';

alter table public.catalog_sync_runs drop constraint if exists catalog_sync_runs_status_check;
alter table public.catalog_sync_runs add constraint catalog_sync_runs_status_check
  check (status in ('running', 'ok', 'partial', 'error', 'cancelled'));

-- Una corrida cancelada no vuelve a otro estado (la Edge que termina su tanda
-- no la puede cerrar como ok/partial). Los datos ya escritos quedan. Una
-- corrida cerrada nunca queda marcada como pausada.
create or replace function public.catalog_sync_runs_keep_cancelled()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if old.status = 'cancelled' then
    new.status := 'cancelled';
    new.finished_at := old.finished_at;
    new.locked_until := null;
    new.paused_at := null;
  elsif new.status <> 'running' then
    -- Cerrada (ok/partial/error): ya no está pausada.
    new.paused_at := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_catalog_sync_runs_keep_cancelled on public.catalog_sync_runs;
create trigger trg_catalog_sync_runs_keep_cancelled
  before update on public.catalog_sync_runs
  for each row execute function public.catalog_sync_runs_keep_cancelled();

-- Mismas firmas que 20261110500000; sólo se suma la pausa.
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

  -- Timeout: abierta más de 12 h desde que arrancó o se reanudó. Una pausada
  -- no vence sola (la pausó el staff a propósito).
  update catalog_sync_runs
     set status = 'error', finished_at = now(), locked_until = null,
         last_error = coalesce(last_error, 'timeout: la corrida quedó abierta más de 12 h')
   where status = 'running'
     and paused_at is null
     and coalesce(resumed_at, started_at) < now() - interval '12 hours';

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
     and paused_at is null
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
       and paused_at is null
       and (locked_until is null or locked_until < now())
  );
$function$;

-- -----------------------------------------------------------------------------
-- 3) Agenda
-- -----------------------------------------------------------------------------

-- Expande un campo de cron: números, "*", listas, rangos a-b y pasos /n
-- ("*/n", "a-b/n", "a/n" = de a al máximo). Sin nombres.
create or replace function public.catalog_sync_cron_set(p_field text, p_lo integer, p_hi integer)
returns integer[]
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tok text;
  m text[];
  a integer;
  b integer;
  s integer;
  v_out integer[] := '{}';
begin
  if p_field is null or p_field = '' or p_field !~ '^[0-9*,/-]+$' then
    raise exception 'invalid_cron';
  end if;
  foreach v_tok in array string_to_array(p_field, ',') loop
    m := regexp_match(v_tok, '^(\*|([0-9]{1,2})(-([0-9]{1,2}))?)(/([0-9]{1,2}))?$');
    if m is null then
      raise exception 'invalid_cron';
    end if;
    s := coalesce(m[6]::integer, 1);
    if s < 1 then
      raise exception 'invalid_cron';
    end if;
    if m[1] = '*' then
      a := p_lo;
      b := p_hi;
    else
      a := m[2]::integer;
      b := case when m[4] is not null then m[4]::integer when m[6] is not null then p_hi else a end;
    end if;
    if a < p_lo or b > p_hi or a > b then
      raise exception 'invalid_cron';
    end if;
    select v_out || array_agg(g) into v_out from generate_series(a, b, s) as g;
  end loop;
  return (select array_agg(distinct x order by x) from unnest(v_out) as x);
end;
$function$;

create or replace function public.catalog_sync_cron_valid(p_expr text)
returns boolean
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare
  f text[] := regexp_split_to_array(btrim(coalesce(p_expr, '')), '\s+');
begin
  if cardinality(f) <> 5 then
    return false;
  end if;
  perform catalog_sync_cron_set(f[1], 0, 59);
  perform catalog_sync_cron_set(f[2], 0, 23);
  perform catalog_sync_cron_set(f[3], 1, 31);
  perform catalog_sync_cron_set(f[4], 1, 12);
  perform catalog_sync_cron_set(f[5], 0, 7);
  return true;
exception when others then
  return false;
end;
$function$;

-- ¿El minuto p_local (reloj de Argentina) coincide con la expresión?
-- Día del mes y de la semana restringidos los dos: alcanza con uno.
create or replace function public.catalog_sync_cron_matches(p_expr text, p_local timestamp)
returns boolean
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare
  f text[] := regexp_split_to_array(btrim(coalesce(p_expr, '')), '\s+');
  v_dow integer[];
  v_dom_ok boolean;
  v_dow_ok boolean;
begin
  if cardinality(f) <> 5 then
    return false;
  end if;
  if not extract(minute from p_local)::integer = any (catalog_sync_cron_set(f[1], 0, 59)) then return false; end if;
  if not extract(hour from p_local)::integer = any (catalog_sync_cron_set(f[2], 0, 23)) then return false; end if;
  if not extract(month from p_local)::integer = any (catalog_sync_cron_set(f[4], 1, 12)) then return false; end if;
  select array_agg(case when d = 7 then 0 else d end) into v_dow from unnest(catalog_sync_cron_set(f[5], 0, 7)) as d;
  v_dom_ok := extract(day from p_local)::integer = any (catalog_sync_cron_set(f[3], 1, 31));
  v_dow_ok := extract(dow from p_local)::integer = any (v_dow);
  if left(f[3], 1) = '*' or left(f[5], 1) = '*' then
    return v_dom_ok and v_dow_ok;
  end if;
  return v_dom_ok or v_dow_ok;
exception when others then
  return false;
end;
$function$;

-- ¿La agenda pide una corrida en el minuto p_at? (todo en hora Argentina)
create or replace function public.catalog_sync_schedule_matches(c public.catalog_sync_config, p_at timestamptz)
returns boolean
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_local timestamp := p_at at time zone 'America/Argentina/Buenos_Aires';
  v_expr text;
  v_diff integer;
begin
  if not c.enabled then
    return false;
  end if;
  v_expr := case c.frequency
    when 'daily' then format('%s %s * * *', c.minute, c.hour)
    when 'interval' then format('%s %s * * *', c.minute, c.hour)
    when 'weekly' then format('%s %s * * %s', c.minute, c.hour, array_to_string(c.weekdays, ','))
    else c.cron_expr
  end;
  if not catalog_sync_cron_matches(v_expr, v_local) then
    return false;
  end if;
  if c.frequency = 'interval' then
    v_diff := v_local::date - coalesce(c.anchor_date, v_local::date);
    return v_diff >= 0 and v_diff % greatest(coalesce(c.interval_days, 1), 1) = 0;
  end if;
  return true;
end;
$function$;

-- ¿Toca abrir una corrida automática? Revisa los minutos desde el último
-- chequeo (hasta 60 min para atrás si el cron se salteó alguno).
create or replace function public.catalog_sync_due()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  c catalog_sync_config;
  v_to timestamptz := date_trunc('minute', now());
  m timestamptz;
begin
  select * into c from catalog_sync_config where id;
  if not found or not c.enabled then
    return false;
  end if;
  m := greatest(date_trunc('minute', coalesce(c.last_check_at, now() - interval '1 minute')),
                v_to - interval '60 minutes');
  while m < v_to loop
    m := m + interval '1 minute';
    if (c.last_auto_at is null or c.last_auto_at < m) and catalog_sync_schedule_matches(c, m) then
      return true;
    end if;
  end loop;
  return false;
end;
$function$;

-- Lo llama el job catalog-sync-continue cada minuto. Si la agenda lo pide,
-- abre la corrida automática (completa si la config lo dice o si tocan las
-- K corridas). Si ya hay una abierta (corriendo o pausada), la saltea y lo
-- anota. Devuelve si hay una corrida para continuar (= catalog_sync_any_due).
create or replace function public.catalog_sync_tick()
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  c catalog_sync_config;
  v_full boolean;
  v_run uuid;
begin
  -- Fila única: si otro tick la tiene, éste no hace nada con la agenda.
  select * into c from catalog_sync_config where id for update skip locked;
  if found then
    if catalog_sync_due() then
      if exists (select 1 from catalog_sync_runs where status = 'running') then
        update catalog_sync_config
           set last_check_at = now(), last_auto_at = now(),
               last_auto_note = 'Salteada: había una corrida abierta (en curso o pausada).'
         where id;
      else
        v_full := c.run_kind = 'full'
                  or (c.full_every is not null and c.auto_runs_since_full + 1 >= c.full_every);
        v_run := catalog_sync_enqueue('cron', null, v_full);
        update catalog_sync_config
           set last_check_at = now(), last_auto_at = now(), last_auto_run = v_run, last_auto_note = null,
               auto_runs_since_full = case when v_full then 0 else auto_runs_since_full + 1 end
         where id;
      end if;
    else
      update catalog_sync_config set last_check_at = now() where id;
    end if;
  end if;
  return catalog_sync_any_due();
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4) RPC del panel interno
-- -----------------------------------------------------------------------------
create or replace function public.catalog_sync_assert_admin()
returns void
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not internal_scope() or coalesce(internal_level(), 'admin') not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$function$;

-- p_config: { enabled, frequency, weekdays, interval_days, hour, minute,
--             cron_expr, run_kind, full_every }
create or replace function public.internal_catalog_sync_config_save(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old catalog_sync_config;
  v_new catalog_sync_config;
  v_freq text := coalesce(p_config ->> 'frequency', 'weekly');
  v_enabled boolean := coalesce((p_config ->> 'enabled')::boolean, true);
  v_hour integer;
  v_minute integer;
  v_days smallint[];
  v_interval integer;
  v_cron text;
  v_kind text := coalesce(p_config ->> 'run_kind', 'incremental');
  v_full_every integer;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  perform catalog_sync_assert_admin();

  if v_freq not in ('daily', 'weekly', 'interval', 'cron') then
    raise exception 'invalid_frequency' using errcode = '22023';
  end if;
  if v_kind not in ('incremental', 'full') then
    raise exception 'invalid_run_kind' using errcode = '22023';
  end if;

  begin
    v_hour := coalesce((p_config ->> 'hour')::integer, 6);
    v_minute := coalesce((p_config ->> 'minute')::integer, 0);
    v_interval := (p_config ->> 'interval_days')::integer;
    v_full_every := (p_config ->> 'full_every')::integer;
    select coalesce(array_agg(distinct d::smallint order by d::smallint), '{}')
      into v_days
      from jsonb_array_elements_text(coalesce(p_config -> 'weekdays', '[]'::jsonb)) as d;
  exception when others then
    raise exception 'invalid_config' using errcode = '22023';
  end;

  if v_hour not between 0 and 23 or v_minute not between 0 and 59 then
    raise exception 'invalid_hour' using errcode = '22023';
  end if;
  if v_freq = 'weekly' and (cardinality(v_days) = 0 or not v_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]) then
    raise exception 'invalid_weekdays' using errcode = '22023';
  end if;
  if v_freq = 'interval' and (v_interval is null or v_interval not between 1 and 90) then
    raise exception 'invalid_interval' using errcode = '22023';
  end if;
  if v_freq = 'cron' then
    v_cron := regexp_replace(btrim(coalesce(p_config ->> 'cron_expr', '')), '\s+', ' ', 'g');
    if not catalog_sync_cron_valid(v_cron) then
      raise exception 'invalid_cron' using errcode = '22023';
    end if;
  end if;
  if v_kind = 'full' then
    v_full_every := null;
  elsif v_full_every is not null and v_full_every not between 2 and 52 then
    raise exception 'invalid_full_every' using errcode = '22023';
  end if;
  if cardinality(v_days) = 0 then
    v_days := '{6}';
  end if;

  insert into catalog_sync_config (id, last_check_at) values (true, now()) on conflict (id) do nothing;
  select * into v_old from catalog_sync_config where id for update;

  update catalog_sync_config
     set enabled = v_enabled,
         frequency = v_freq,
         weekdays = v_days,
         interval_days = case when v_freq = 'interval' then v_interval end,
         -- Cada N días se cuenta desde hoy cuando se elige o cambia N.
         anchor_date = case
           when v_freq <> 'interval' then null
           when v_old.frequency <> 'interval' or v_old.interval_days is distinct from v_interval
                or v_old.anchor_date is null then v_today
           else v_old.anchor_date
         end,
         hour = v_hour,
         minute = v_minute,
         cron_expr = case when v_freq = 'cron' then v_cron end,
         run_kind = v_kind,
         full_every = v_full_every,
         -- Lo que ya pasó no se dispara por el cambio de agenda.
         last_check_at = now(),
         updated_by = auth.uid(),
         updated_at = now()
   where id
  returning * into v_new;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, auth.uid(), 'catalog_sync_config', null, 'catalog_sync_config_updated',
          to_jsonb(v_old) - array['last_check_at', 'last_auto_at', 'last_auto_run', 'last_auto_note', 'updated_at'],
          to_jsonb(v_new) - array['last_check_at', 'last_auto_at', 'last_auto_run', 'last_auto_note', 'updated_at']);

  return to_jsonb(v_new);
end;
$function$;

-- Pausar / reanudar / cancelar la corrida abierta. Cancelar es baja lógica:
-- la corrida queda 'cancelled' en el historial y lo ya sincronizado se queda.
create or replace function public.internal_catalog_sync_control(p_run uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_row catalog_sync_runs;
begin
  perform catalog_sync_assert_admin();

  if p_action = 'pause' then
    -- El lease se respeta: la tanda en curso termina su página y se detiene.
    update catalog_sync_runs set paused_at = now()
     where id = p_run and status = 'running' and paused_at is null
    returning * into v_row;
  elsif p_action = 'resume' then
    update catalog_sync_runs set paused_at = null, resumed_at = now()
     where id = p_run and status = 'running' and paused_at is not null
    returning * into v_row;
  elsif p_action = 'cancel' then
    update catalog_sync_runs
       set status = 'cancelled', finished_at = now(), paused_at = null, locked_until = null,
           current_store = null, last_error = coalesce(last_error, 'Cancelada desde el panel interno.')
     where id = p_run and status = 'running'
    returning * into v_row;
  else
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  if v_row.id is null then
    raise exception 'run_not_open' using errcode = 'P0002';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (null, auth.uid(), 'catalog_sync_runs', p_run,
          case p_action when 'pause' then 'catalog_sync_paused'
                        when 'resume' then 'catalog_sync_resumed'
                        else 'catalog_sync_cancelled' end,
          jsonb_build_object('run_id', p_run, 'status', v_row.status, 'paused_at', v_row.paused_at,
                             'nuevos', v_row.nuevos, 'actualizados', v_row.actualizados));

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'paused_at', v_row.paused_at);
end;
$function$;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.catalog_sync_cron_set(text, integer, integer)',
    'public.catalog_sync_cron_valid(text)',
    'public.catalog_sync_cron_matches(text, timestamp)',
    'public.catalog_sync_schedule_matches(public.catalog_sync_config, timestamptz)',
    'public.catalog_sync_due()',
    'public.catalog_sync_tick()',
    'public.catalog_sync_runs_keep_cancelled()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- Sólo dentro de las RPC del panel (definer).
  execute 'revoke all on function public.catalog_sync_assert_admin() from public, anon, authenticated';

  foreach f in array array[
    'public.internal_catalog_sync_config_save(jsonb)',
    'public.internal_catalog_sync_control(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $grants$;

-- -----------------------------------------------------------------------------
-- 5) pg_cron: la agenda la decide catalog_sync_tick()
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

  -- Mismo POST que 20261110500000.
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

  -- La agenda fija se reemplaza por catalog_sync_config.
  if exists (select 1 from cron.job where jobname = 'catalog-sync-weekly') then
    perform cron.unschedule('catalog-sync-weekly');
  end if;

  -- Cada minuto: abre la automática si toca y continúa la abierta sin lease.
  if exists (select 1 from cron.job where jobname = 'catalog-sync-continue') then
    perform cron.unschedule('catalog-sync-continue');
  end if;
  perform cron.schedule('catalog-sync-continue', '* * * * *',
    v_post || ' where public.catalog_sync_tick();');
end;
$cron$;
