-- =============================================================================
-- SEC-10 · Cerrar helpers internos de contabilidad expuestos a anon/authenticated
-- =============================================================================
-- acc_sync_nubceo_ledger y acc_sync_treasury_opening son SECURITY DEFINER,
-- reciben p_tenant sin validar membresía y llaman a acc_post/acc_unpost: con el
-- default privilege de public (EXECUTE a anon y authenticated) cualquiera podía
-- postear o desarmar asientos de otro negocio. Las crearon
-- 20261227100100_tesoreria_asientos_por_cuenta y 20261231100200_nubceo_contabilidad
-- sin revoke, a diferencia de sus hermanas (acc_post, acc_unpost, acc_sync_*).
--
-- Sólo las invoca acc_sync(...) (SECURITY DEFINER, corre como owner), así que el
-- revoke no cambia el flujo normal.
--
-- Ya aplicada en producción el 2026-11-16 por MCP apply_migration con la versión
-- 20261117005447 (mismo SQL). El archivo lleva un timestamp posterior porque las
-- funciones nacen en migraciones de 2026-12; el repair del historial (SEC-01/02)
-- reconcilia la versión por nombre.
-- =============================================================================

revoke execute on function public.acc_sync_nubceo_ledger(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.acc_sync_treasury_opening(uuid, uuid, boolean) from public, anon, authenticated;
