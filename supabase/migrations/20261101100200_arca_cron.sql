-- =============================================================================
-- 20261101100200_arca_cron  (F3 · ADR-072)
--
-- Cada minuto, si hay comprobantes vencidos en la cola (arca_any_due()), POST
-- a la Edge `arca_wsfe` con el patrón de los demás crons internos
-- (nubceo_sync, account_reminders): X-Cron-Secret =
-- platform_secrets('internal_cron').token y el anon key como Bearer para pasar
-- el gateway (verify_jwt = true), leídos en cada corrida; nada en git.
-- El backoff exponencial de cada comprobante lo decide next_attempt_at.
-- Sin pg_cron o sin pg_net (stack local, CI) se omite.
-- =============================================================================
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/arca_wsfe';
  v_cmd text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el job de ARCA.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el job de ARCA.';
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
    where public.arca_any_due();
  $job$, v_url);

  if exists (select 1 from cron.job where jobname = 'arca-wsfe') then
    perform cron.unschedule('arca-wsfe');
  end if;
  perform cron.schedule('arca-wsfe', '* * * * *', v_cmd);
end;
$cron$;
