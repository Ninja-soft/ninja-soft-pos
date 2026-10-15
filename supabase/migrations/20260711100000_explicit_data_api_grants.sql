-- =============================================================================
-- 20260711100000_explicit_data_api_grants
--
-- Salida DURABLE del breaking change del Supabase CLI v2.106.0: los objetos
-- nuevos de `public` ya no se exponen al Data API por defecto (el start local
-- revoca los privilegios y `[api].auto_expose_new_tables` quedó deprecado, se
-- elimina 2026-10-30). Este archivo declara los GRANTs de forma EXPLÍCITA,
-- reproduciendo el modelo de seguridad vigente del proyecto:
--
--   * La frontera de seguridad de filas es RLS (CLAUDE.md §3) — los grants de
--     tabla son la capa de transporte del Data API, como en el default legado
--     de Supabase (anon/authenticated/service_role con acceso de tabla, RLS
--     decide las filas).
--   * Las FUNCIONES no se tocan: el repo siempre las maneja con grant/revoke
--     explícito por migración (un grant masivo desharía docenas de revokes).
--   * Tras los grants masivos se RE-AFIRMAN los revokes de tabla explícitos
--     históricos (hardening 20260608400000 y users de 20260530120400), porque
--     este archivo corre después y los pisaría.
--
-- En remoto es esencialmente un no-op (los grants legados ya existen) + la
-- re-afirmación del hardening. En local/CI habilita retirar el flag deprecado.
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant select, insert, update, delete on all tables in schema public
  to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- Objetos FUTUROS creados por migraciones (rol postgres): mismo modelo, para
-- que las próximas tablas no necesiten grants a mano y el local siga andando
-- cuando el flag deprecado desaparezca.
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Re-afirmación de los revokes de tabla explícitos (el grant masivo de arriba
-- los pisó; el orden lexicográfico garantiza que esto corre al final).
-- ─────────────────────────────────────────────────────────────────────────────

-- 20260530120400_rls_and_audit_triggers: users es de solo lectura para el resto
-- (cada uno edita su perfil vía RPC/trigger controlado).
revoke update on public.users from authenticated;

-- 20260608400000_security_hardening: tablas sensibles fuera del Data API para
-- clientes; solo service_role (Edge Functions).
revoke all on public.platform_secrets   from anon, authenticated;
revoke all on public.payment_secrets    from anon, authenticated;
revoke all on public.email_providers    from anon, authenticated;
revoke all on public.system_email_smtp  from anon, authenticated;
revoke all on public.tenant_email_smtp  from anon, authenticated;
revoke all on public.mp_oauth_states    from anon, authenticated;
revoke all on public.billing_records    from anon, authenticated;

-- anon no opera el POS: sin escritura en absolutamente nada del Data API.
-- (Lectura la siguen gobernando las policies RLS, que para anon no matchean
-- salvo catálogos públicos vía RPC SECURITY DEFINER.)
revoke insert, update, delete on all tables in schema public from anon;
alter default privileges in schema public
  revoke insert, update, delete on tables from anon;
