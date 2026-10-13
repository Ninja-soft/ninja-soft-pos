-- =============================================================================
-- 20261110400300_mercadolibre_cron  (H87 · ADR-104 · Mercado Libre MVP)
--
-- Jobs de pg_cron hacia la Edge `ml_worker` con el patrón de los demás crons
-- internos (arca-wsfe, nubceo): X-Cron-Secret = platform_secrets('internal_cron')
-- y el anon key como Bearer para el gateway (verify_jwt = true), leídos en
-- cada corrida; nada en git.
--
--   ml-worker     cada minuto, sólo si ml_any_due(): procesa el inbox de
--                 notificaciones (primero) y después la cola de escrituras.
--   ml-reconcile  cada 10 minutos: missed_feeds de la app + búsqueda de
--                 órdenes actualizadas de cada cuenta (cubre notificaciones
--                 perdidas o tópicos desactivados).
--   ml-tokens     cada hora: renueva los tokens que vencen pronto y "toca"
--                 las cuentas sin uso (ML invalida el refresh tras 4 meses
--                 sin llamadas).
--   ml-retention  diario: borra notificaciones y trabajos terminados de más
--                 de 15 días (son técnicos; lo de negocio vive en ml_orders,
--                 ventas y audit_logs).
-- Sin pg_cron o pg_net (stack local, CI) se omite.
-- =============================================================================
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/ml_worker';
  v_job text;
  v_mode text;
  v_sched text;
  v_where text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten los jobs de Mercado Libre.';
    return;
  end if;

  perform cron.unschedule(j.jobname) from cron.job j
   where j.jobname in ('ml-worker', 'ml-reconcile', 'ml-tokens', 'ml-retention');

  perform cron.schedule('ml-retention', '40 4 * * *', $r$
    delete from public.ml_notifications
     where status in ('done', 'ignored') and received_at < now() - interval '15 days';
    delete from public.ml_sync_jobs
     where status in ('done', 'cancelled') and updated_at < now() - interval '15 days';
  $r$);

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omiten los jobs del worker de Mercado Libre.';
    return;
  end if;

  for v_job, v_mode, v_sched, v_where in
    select * from (values
      ('ml-worker', 'cron', '* * * * *', 'public.ml_any_due()'),
      ('ml-reconcile', 'reconcile', '*/10 * * * *',
       'exists (select 1 from public.ml_accounts a where a.deleted_at is null and a.status = ''active'')'),
      ('ml-tokens', 'tokens', '17 * * * *',
       'exists (select 1 from public.ml_accounts a where a.deleted_at is null)')
    ) as t(job, mode, sched, cond)
  loop
    perform cron.schedule(v_job, v_sched, format($job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
          'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
          'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
        ),
        body := jsonb_build_object('mode', %L),
        timeout_milliseconds := 55000
      )
      where %s;
    $job$, v_url, v_mode, v_where));
  end loop;
end;
$cron$;
