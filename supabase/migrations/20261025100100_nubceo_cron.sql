-- =============================================================================
-- 20261025100100_nubceo_cron  (ADR-062)
--
-- Cada minuto, si algún negocio tiene una vuelta de NubCeo vencida
-- (nubceo_any_due()), POST a la Edge `nubceo_sync` con el patrón de los demás
-- crons internos (account_reminders, pending_charges_sync): X-Cron-Secret =
-- platform_secrets('internal_cron').token y el anon key como Bearer para pasar
-- el gateway (verify_jwt = true), todo leído en cada corrida; nada en git.
-- El ritmo de cada negocio (cada X minutos u horas y su ventana horaria) lo
-- decide la base con next_run_at y nubceo_in_window(); la Edge procesa hasta
-- 20 negocios por llamada.
-- Sin pg_cron o sin pg_net (stack local, CI) se omite.
-- =============================================================================
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/nubceo_sync';
  v_cmd text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el job de NubCeo.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el job de NubCeo.';
    return;
  end if;

  v_cmd := format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := '{"mode":"cron"}'::jsonb,
      timeout_milliseconds := 55000
    )
    where public.nubceo_any_due();
  $job$, v_url);

  if exists (select 1 from cron.job where jobname = 'nubceo-sync') then
    perform cron.unschedule('nubceo-sync');
  end if;
  perform cron.schedule('nubceo-sync', '* * * * *', v_cmd);
end;
$cron$;
