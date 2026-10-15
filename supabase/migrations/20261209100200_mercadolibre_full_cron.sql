-- =============================================================================
-- 20261209100200_mercadolibre_full_cron  (ADR-142 · Mercado Libre Full)
--
-- Job de pg_cron hacia la Edge `ml_full` (modo cron) con el patrón de los
-- demás crons internos: X-Cron-Secret = platform_secrets('internal_cron') y el
-- anon key como Bearer para el gateway (verify_jwt = true), leídos en cada
-- corrida; nada en git.
--
--   ml-full-sync  cada 15 minutos, sólo si ml_full_accounts_due() trae algo
--                 (cuentas con las features, sin sincronizar hace 25 minutos
--                 o con una venta Full pendiente de releer): stock de Full,
--                 operaciones de 30 días, recepción de los envíos abiertos y,
--                 una vez por día, los cargos de Full.
--   ml-full-retention  diario: operaciones de Full de más de 400 días (ML
--                 guarda 12 meses; lo de negocio vive en los envíos y la
--                 auditoría).
-- Sin pg_cron o pg_net (stack local, CI) se omite.
-- =============================================================================
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/ml_full';
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten los jobs de Mercado Libre Full.';
    return;
  end if;

  perform cron.unschedule(j.jobname) from cron.job j
   where j.jobname in ('ml-full-sync', 'ml-full-retention');

  perform cron.schedule('ml-full-retention', '50 4 * * *', $r$
    delete from public.ml_full_stock_ops where date_created < now() - interval '400 days';
  $r$);

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite la sincronización de Mercado Libre Full.';
    return;
  end if;

  perform cron.schedule('ml-full-sync', '*/15 * * * *', format($job$
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
    )
    where exists (select 1 from public.ml_full_accounts_due());
  $job$, v_url));
end;
$cron$;
