-- =============================================================================
-- 20261110200300_canales_delivery_cron  (F13 · H49 integraciones, ADR-102)
--
-- Cada minuto, si hay trabajo (delivery_channel_any_due(): llamadas salientes
-- vencidas, eventos con error para reintentar o conexiones para reconciliar),
-- POST a la Edge `delivery_channel_worker` con el patrón de los demás crons
-- internos (arca_wsfe, nubceo_sync): X-Cron-Secret =
-- platform_secrets('internal_cron').token y el anon key como Bearer para pasar
-- el gateway (verify_jwt = true), leídos en cada corrida; nada en git.
-- Sin pg_cron o sin pg_net (stack local, CI) se omite.
-- =============================================================================
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/delivery_channel_worker';
  v_cmd text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el job de canales de delivery.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el job de canales de delivery.';
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
    where public.delivery_channel_any_due();
  $job$, v_url);

  if exists (select 1 from cron.job where jobname = 'delivery-channels') then
    perform cron.unschedule('delivery-channels');
  end if;
  perform cron.schedule('delivery-channels', '* * * * *', v_cmd);
end;
$cron$;
