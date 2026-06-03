-- =============================================================================
-- 20260603120000_revoke_trigger_fn_execute  (seguridad)
-- Las funciones de trigger no deben ser invocables como RPC. El advisor las
-- marcaba como SECURITY DEFINER ejecutables por anon/authenticated vía PostgREST.
-- Revocamos EXECUTE: los triggers siguen disparándose (corren con el dueño de la
-- función), pero ya no se exponen en /rest/v1/rpc.
-- =============================================================================
revoke execute on function public.payment_account_charge() from anon, authenticated, public;
revoke execute on function public.products_auto_sku() from anon, authenticated, public;
