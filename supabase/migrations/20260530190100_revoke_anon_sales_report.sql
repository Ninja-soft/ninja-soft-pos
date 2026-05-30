-- =============================================================================
-- 20260530190100_revoke_anon_sales_report
-- sales_report es SECURITY DEFINER: lo restringimos a usuarios autenticados.
-- (anon no tiene tenant, pero por defensa en profundidad le quitamos EXECUTE.)
-- =============================================================================
revoke execute on function sales_report(timestamptz, timestamptz) from anon;
