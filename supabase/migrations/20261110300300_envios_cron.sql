-- =============================================================================
-- 20261110300300_envios_cron  (Envíos y logística, fase 1 · ADR-103)
--
--   • shipping-track-schedule (cada 30 minutos): encola el seguimiento de los
--     envíos vivos de los últimos 30 días cuyo turno venció (ninguna logística
--     de esta fase avisa por webhook: Andreani se consulta por polling).
--   • shipping-worker (cada 2 minutos, sólo si hay trabajos vencidos): POST a
--     la Edge `shipping` con el patrón de los demás crons internos
--     (X-Cron-Secret = platform_secrets('internal_cron').token y el anon key
--     como Bearer para pasar el gateway con verify_jwt = true). El worker toma
--     trabajos con SKIP LOCKED: si dos corridas se pisan, no duplican nada.
-- Sin pg_cron o sin pg_net (stack local, CI) se omite.
-- =============================================================================
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/shipping';
  v_cmd text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten los jobs de envíos.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'shipping-track-schedule') then
    perform cron.unschedule('shipping-track-schedule');
  end if;
  perform cron.schedule('shipping-track-schedule', '*/30 * * * *', $$select public.shipping_track_schedule(500)$$);

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el worker de envíos.';
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
    where public.shipping_any_due();
  $job$, v_url);

  if exists (select 1 from cron.job where jobname = 'shipping-worker') then
    perform cron.unschedule('shipping-worker');
  end if;
  perform cron.schedule('shipping-worker', '*/2 * * * *', v_cmd);
end;
$cron$;
