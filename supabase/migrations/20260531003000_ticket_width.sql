-- =============================================================================
-- Recuperada del remoto (schema_migrations, version 20260531013430): aplicada
-- vía MCP el 2026-05-31 pero nunca commiteada. Restaurada el 2026-06-04 para
-- que el historial replaye en DBs frescas (detectado por el job rls de CI).
-- =============================================================================
-- H9 (F6) — Ancho de ticket configurable por tenant (térmica 58/80mm).
alter table tenant_branding
  add column if not exists ticket_width text not null default '80'
  check (ticket_width in ('58','80'));
