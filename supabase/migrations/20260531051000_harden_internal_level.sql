-- =============================================================================
-- Recuperada del remoto (schema_migrations, version 20260531105754): aplicada
-- vía MCP el 2026-05-31 pero nunca commiteada. Restaurada el 2026-06-04 para
-- que el historial replaye en DBs frescas (detectado por el job rls de CI).
-- =============================================================================
-- Hardening: fijar search_path en internal_level().
create or replace function internal_level()
returns text language sql stable
set search_path = public, pg_temp
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'internal_level', '');
$$;
