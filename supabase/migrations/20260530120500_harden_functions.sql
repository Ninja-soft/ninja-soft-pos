-- =============================================================================
-- 20260530120500_harden_functions
-- Hito 0 — hardening de funciones señalado por el linter de seguridad de Supabase.
--   • search_path inmutable en helpers (evita secuestro de search_path).
--   • handle_new_user es trigger-only: se revoca EXECUTE del API público.
-- =============================================================================

alter function public.current_tenant_id() set search_path = '';
alter function public.is_internal()       set search_path = '';
alter function public.set_updated_at()    set search_path = '';
alter function public.write_audit_log()   set search_path = public, pg_temp;
alter function public.handle_new_user()   set search_path = public, pg_temp;

revoke execute on function public.handle_new_user() from anon, authenticated, public;
