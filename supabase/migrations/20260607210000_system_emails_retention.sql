-- =============================================================================
-- 20260607210000_system_emails_retention  (retención de bitácora interna)
-- La bitácora de envíos (system_emails) se purga a los 60 días vía pg_cron
-- (job diario 04:13 UTC). SOLO se borra la bitácora interna del panel:
-- audit_logs y cualquier dato de los negocios/clientes NO se tocan.
-- =============================================================================
create extension if not exists pg_cron;

create or replace function purge_system_emails()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from system_emails where created_at < now() - interval '60 days';
$$;
revoke all on function purge_system_emails() from public, anon, authenticated;

select cron.schedule(
  'purge-system-emails',
  '13 4 * * *',
  $$select purge_system_emails();$$
);
