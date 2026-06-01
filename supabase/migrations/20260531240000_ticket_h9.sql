-- =============================================================================
-- 20260531240000_ticket_h9  (H9 — tickets: título, leyenda y QR)
-- Campos opcionales del comprobante por tenant. Defaults vacíos/false → el
-- ticket actual no cambia hasta que el dueño los configure.
-- =============================================================================
alter table tenant_branding add column if not exists ticket_title   text;
alter table tenant_branding add column if not exists ticket_legend  text;
alter table tenant_branding add column if not exists ticket_show_qr boolean not null default false;
