-- =============================================================================
-- 20260530200100_lock_definer_execute
-- Las funciones SECURITY DEFINER tenían EXECUTE para PUBLIC (default de
-- Postgres), que cubre a anon. Revocamos de PUBLIC/anon y concedemos solo a
-- authenticated. El guard real sigue dentro (is_internal() / current_tenant_id()).
-- =============================================================================
revoke execute on function sales_report(timestamptz, timestamptz) from public, anon;
grant  execute on function sales_report(timestamptz, timestamptz) to authenticated;

revoke execute on function internal_set_plan(uuid, text) from public, anon;
grant  execute on function internal_set_plan(uuid, text) to authenticated;

revoke execute on function internal_set_subscription_status(uuid, text) from public, anon;
grant  execute on function internal_set_subscription_status(uuid, text) to authenticated;

revoke execute on function internal_set_flag(uuid, text, boolean) from public, anon;
grant  execute on function internal_set_flag(uuid, text, boolean) to authenticated;
