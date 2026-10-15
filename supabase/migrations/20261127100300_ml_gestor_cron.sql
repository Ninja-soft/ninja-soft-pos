-- =============================================================================
-- 20261127100300_ml_gestor_cron  (H141 · ADR-132 · parte B)
--
-- Foto diaria de la reputación: job `ml-reputation` a las 06:20 de Argentina
-- (09:20 UTC) hacia la Edge `ml_worker` (mode = 'reputation'), con el mismo
-- patrón de 20261110400300_mercadolibre_cron (X-Cron-Secret y anon key de
-- platform_secrets('internal_cron'), leídos en cada corrida). Sólo llama si
-- hay cuentas con el gestor sin la foto de hoy (ml_gestor_accounts_due).
-- Los reclamos se reconcilian dentro de `ml-reconcile` (cada 10 minutos).
-- Sin pg_cron o pg_net (stack local, CI) se omite.
-- =============================================================================
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_cron o pg_net no disponibles; se omite el job de reputación de Mercado Libre.';
    return;
  end if;

  perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'ml-reputation';

  perform cron.schedule('ml-reputation', '20 9 * * *', $job$
    select net.http_post(
      url := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/ml_worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := jsonb_build_object('mode', 'reputation'),
      timeout_milliseconds := 55000
    )
    where exists (select 1 from public.ml_gestor_accounts_due('reputation'));
  $job$);
end;
$cron$;
