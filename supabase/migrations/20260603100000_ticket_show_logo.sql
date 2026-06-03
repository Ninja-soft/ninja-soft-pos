-- =============================================================================
-- 20260603100000_ticket_show_logo  (H22 — impresión)
-- Permite ocultar el logo en el ticket impreso. Default true (no cambia el
-- comportamiento actual de los tenants existentes).
-- =============================================================================
alter table tenant_branding
  add column if not exists ticket_show_logo boolean not null default true;
