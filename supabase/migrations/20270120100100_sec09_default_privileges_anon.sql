-- =============================================================================
-- SEC-09 · Default privileges seguros para objetos futuros (ADR-184)
-- =============================================================================
-- SEC-07 ya sacó a anon la escritura y el EXECUTE por defecto. Faltaba:
-- las tablas nuevas nacían con SELECT (y MAINTAIN en PG17) para anon y las
-- secuencias con SELECT. Desde acá un objeto nuevo creado por postgres no le
-- da nada a anon: si un flujo público necesita leer una tabla directo, la
-- migración que la crea lo otorga explícito (docs/04-database.md §6.1).
--
-- authenticated no cambia (rompería cada RPC/tabla nueva; lo controla el lint
-- de SEC-15). Los defaults de supabase_admin no se pueden alterar con el rol de
-- las migraciones ("permission denied to change default privileges"): sólo
-- aplican a objetos internos de Supabase, nuestras migraciones crean como
-- postgres.
-- `revoke all` en vez de nombrar privilegios: MAINTAIN existe en PG17 (prod)
-- y no en PG15 (local).
-- Funciones: el EXECUTE de PUBLIC es un default GLOBAL de Postgres y un
-- default por esquema sólo puede sumar, no quitar; revocarlo globalmente
-- afectaría funciones de otros esquemas (p. ej. `private`, usado en policies).
-- Por eso cada función nueva de `public` lleva `revoke execute … from public,
-- anon` explícito en su migración (docs/04-database.md §6.1, lint SEC-15).
-- =============================================================================

alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
