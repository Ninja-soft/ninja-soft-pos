-- =============================================================================
-- 20260531070000_lock_industry_fns
-- Igual que 20260530200100: las SECURITY DEFINER de rubro tenían EXECUTE para
-- PUBLIC (cubre anon). Revocamos de PUBLIC/anon y concedemos solo a
-- authenticated. El guard real sigue dentro (owner/manager o is_internal()).
-- =============================================================================
revoke execute on function set_my_tenant_industry(text) from public, anon;
grant  execute on function set_my_tenant_industry(text) to authenticated;

revoke execute on function internal_set_industry(uuid, text) from public, anon;
grant  execute on function internal_set_industry(uuid, text) to authenticated;

revoke execute on function _assert_valid_industry(text) from public, anon;
