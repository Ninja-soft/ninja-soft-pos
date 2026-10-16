-- =============================================================================
-- Cotización del dólar (ADR-135): la consulta a ArgentinaDatos pasa de dos veces
-- por día (09:15 y 18:15 ART) a cada hora en horario bancario, de lunes a
-- viernes de 10 a 15 ART (13 a 18 UTC). Mismo job, misma Edge y mismos headers;
-- la Edge hace upsert del día y nunca pisa la carga manual, así que correr cada
-- hora sólo refresca el valor si ArgentinaDatos lo publicó.
-- =============================================================================
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
  perform cron.schedule('platform-fx-sync', '0 13-18 * * 1-5', format($job$
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
