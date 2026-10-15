-- =============================================================================
-- 20261208100300_ml_facturacion_cron  (ADR-141 · parte B)
--
-- Vencimiento de los links de pago de percepciones: job `ml-perception-expire`
-- cada 30 minutos, sólo SQL (ml_perception_expire_due), sin llamar a ninguna
-- Edge. Sin pg_cron (stack local, CI) se omite.
-- =============================================================================
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el vencimiento de percepciones de Mercado Libre.';
    return;
  end if;

  perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'ml-perception-expire';

  perform cron.schedule('ml-perception-expire', '*/30 * * * *', $job$
    select public.ml_perception_expire_due()
     where exists (select 1 from public.ml_perception_charges c
                    where c.status = 'link_sent' and c.expires_at <= now());
  $job$);
end;
$cron$;
