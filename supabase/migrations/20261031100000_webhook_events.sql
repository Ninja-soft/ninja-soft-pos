-- =============================================================================
-- 20261031100000_webhook_events  (ADR-070)
--
-- Observabilidad operativa de los webhooks de cobro, sin servicios externos.
--
--  A) webhook_events: una fila por notificación recibida por las Edge
--     *_webhook (mp, mp_orders, getnet, payway, nave, gocuotas, directo,
--     clover, modo, mobbex). Guarda proveedor, función, resultado
--     ('ok' | 'error' | 'ignored'), status HTTP devuelto, error (texto corto),
--     duración y payload_ref: el id externo de la notificación o del intent.
--     NUNCA el payload completo ni datos sensibles (tokens, tarjetas, firmas).
--     Es un log técnico, no un dato de negocio: no tiene deleted_at y se
--     borra físicamente a los 30 días (cron `webhook-events-retention`).
--     Distinta de mp_webhook_events (dedup de mp_billing_webhook, ADR billing).
--  B) RLS (ADR-052): el dueño o encargado ve sólo lo de su negocio; el staff
--     interno sólo desde el panel interno con internal_scope() (nunca
--     is_internal() suelto; rls_internal_scope_leaks() sigue en 0). Sin
--     policies de escritura: escribe sólo service_role desde las Edge.
--  C) webhook_health(p_hours): resumen por proveedor para el panel interno
--     (security invoker: respeta la RLS de quien llama).
--  D) Retención con pg_cron (se omite si no hay pg_cron: stack local, CI).
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

create table if not exists webhook_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references tenants(id) on delete cascade,
  provider       text not null,
  function_name  text not null,
  status         text not null check (status in ('ok', 'error', 'ignored')),
  http_status    int,
  error          text check (error is null or char_length(error) <= 500),
  duration_ms    int check (duration_ms is null or duration_ms >= 0),
  payload_ref    text check (payload_ref is null or char_length(payload_ref) <= 200),
  created_at     timestamptz not null default now()
);

create index if not exists webhook_events_created_idx
  on webhook_events (created_at desc);
create index if not exists webhook_events_provider_created_idx
  on webhook_events (provider, created_at desc);
create index if not exists webhook_events_tenant_created_idx
  on webhook_events (tenant_id, created_at desc)
  where tenant_id is not null;

comment on table webhook_events is
  'Log técnico de webhooks de cobro (ADR-070): resultado, status HTTP, error, duración e id externo. Sin payload. Retención 30 días.';

alter table webhook_events enable row level security;

drop policy if exists webhook_events_select on webhook_events;
create policy webhook_events_select on webhook_events
  for select using (
    internal_scope()
    or (tenant_id = current_tenant_id() and is_tenant_manager())
  );

revoke insert, update, delete on webhook_events from anon, authenticated;
grant select on webhook_events to authenticated;
grant all on webhook_events to service_role;

-- -----------------------------------------------------------------------------
-- C) Resumen por proveedor (últimas p_hours horas, 1 a 168).
-- -----------------------------------------------------------------------------
create or replace function public.webhook_health(p_hours int default 24)
returns table (
  provider          text,
  total             bigint,
  ok_count          bigint,
  error_count       bigint,
  ignored_count     bigint,
  last_event_at     timestamptz,
  last_error_at     timestamptz,
  last_error        text,
  last_error_function text,
  avg_duration_ms   int
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with w as (
    select *
      from webhook_events
     where created_at >= now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 168))
  ),
  last_err as (
    select distinct on (w.provider) w.provider, w.created_at, w.error, w.function_name
      from w
     where w.status = 'error'
     order by w.provider, w.created_at desc
  )
  select w.provider,
         count(*)                                   as total,
         count(*) filter (where w.status = 'ok')      as ok_count,
         count(*) filter (where w.status = 'error')   as error_count,
         count(*) filter (where w.status = 'ignored') as ignored_count,
         max(w.created_at)                          as last_event_at,
         le.created_at                              as last_error_at,
         le.error                                   as last_error,
         le.function_name                           as last_error_function,
         round(avg(w.duration_ms))::int             as avg_duration_ms
    from w
    left join last_err le on le.provider = w.provider
   group by w.provider, le.created_at, le.error, le.function_name
   order by w.provider;
$$;

revoke all on function public.webhook_health(int) from public, anon;
grant execute on function public.webhook_health(int) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- D) Retención: borra lo de más de 30 días, todos los días 04:15 UTC.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite la retención de webhook_events.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'webhook-events-retention') then
    perform cron.unschedule('webhook-events-retention');
  end if;
  perform cron.schedule(
    'webhook-events-retention',
    '15 4 * * *',
    $$delete from public.webhook_events where created_at < now() - interval '30 days'$$
  );
end;
$cron$;
