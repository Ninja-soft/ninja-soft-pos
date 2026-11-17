-- =============================================================================
-- SEC-11 · Grupo C: RPCs autenticadas que quedaron ejecutables por anon
-- =============================================================================
-- Las 6 son SECURITY DEFINER y validan adentro (current_tenant_id(),
-- _dining_assert_member()), así que con anon fallan; igual no tienen por qué
-- estar expuestas: el default privilege de public les dio EXECUTE a anon.
-- Sólo las llaman módulos autenticados (modules/pos, products, dining, coupons);
-- ningún flujo público (catálogo, /pagar, presupuesto) las usa.
-- Se revoca a public y anon y se deja explícito el grant a authenticated.
-- =============================================================================

revoke execute on function public.open_cash_shift(uuid, numeric) from public, anon;
revoke execute on function public.empty_my_catalog() from public, anon;
revoke execute on function public.add_table_order_item(uuid, uuid, text, numeric, numeric, jsonb, text, smallint, boolean, text) from public, anon;
revoke execute on function public.fire_table_order_course(uuid, smallint) from public, anon;
revoke execute on function public.set_table_order_item_course(uuid, smallint) from public, anon;
revoke execute on function public.validate_coupon(text, numeric, uuid) from public, anon;

grant execute on function public.open_cash_shift(uuid, numeric) to authenticated;
grant execute on function public.empty_my_catalog() to authenticated;
grant execute on function public.add_table_order_item(uuid, uuid, text, numeric, numeric, jsonb, text, smallint, boolean, text) to authenticated;
grant execute on function public.fire_table_order_course(uuid, smallint) to authenticated;
grant execute on function public.set_table_order_item_course(uuid, smallint) to authenticated;
grant execute on function public.validate_coupon(text, numeric, uuid) to authenticated;
