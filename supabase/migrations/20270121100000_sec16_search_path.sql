-- =============================================================================
-- SEC-16 · search_path fijo en las 25 funciones que lo tenían mutable
-- =============================================================================
-- Advisor function_search_path_mutable. Se fija con `alter function` (sin
-- recrearlas) a `public, pg_temp`, como el resto del repo. 20 son plpgsql (no
-- se inlinean) y 5 son SQL inmutables y puras (_dining_item_sent, _promo_card_key,
-- _promo_txt_arr, cheque_transition_ok, product_basis_cost): fijar search_path
-- impide inlinearlas; el test de rendimiento de create_sale
-- (perf-f4-create-sale) lo controla en CI. security-lint (3) exige 0 desde acá.
-- =============================================================================

alter function public._delivery_order_item_guard_qty() set search_path = public, pg_temp;
alter function public._dining_item_sent(p_printed_at timestamp with time zone, p_kds_status text) set search_path = public, pg_temp;
alter function public._kds_sla_valid(p jsonb) set search_path = public, pg_temp;
alter function public._promo_alloc(p jsonb, p_rem numeric[], p_pid text[], p_cat text[], p_brand text[], p_qty numeric[], p_elig boolean[]) set search_path = public, pg_temp;
alter function public._promo_applies(p jsonb, p_ctx jsonb, p_pid text[], p_cat text[], p_brand text[], p_tot numeric[], p_elig boolean[]) set search_path = public, pg_temp;
alter function public._promo_card_key(p text) set search_path = public, pg_temp;
alter function public._promo_distribute(p_d numeric, p_w numeric[]) set search_path = public, pg_temp;
alter function public._promo_eval_core(p_promos jsonb, p_lines jsonb, p_ctx jsonb) set search_path = public, pg_temp;
alter function public._promo_in_scope(p jsonb, p_pid text, p_cat text, p_brand text) set search_path = public, pg_temp;
alter function public._promo_payments_ok(p jsonb, p_ctx jsonb) set search_path = public, pg_temp;
alter function public._promo_txt_arr(j jsonb) set search_path = public, pg_temp;
alter function public._table_order_item_guard_qty() set search_path = public, pg_temp;
alter function public._table_orders_stamp_closed() set search_path = public, pg_temp;
alter function public.cheque_transition_ok(p_kind text, p_from text, p_to text) set search_path = public, pg_temp;
alter function public.cuit_is_valid(p text) set search_path = public, pg_temp;
alter function public.product_basis_cost(p_basis text, p_last numeric, p_avg numeric, p_repl numeric) set search_path = public, pg_temp;
alter function public.purchase_avg_after_outflow(p_stock_before numeric, p_avg numeric, p_qty numeric, p_unit_cost numeric) set search_path = public, pg_temp;
alter function public.purchase_line_net(p_qty numeric, p_cost numeric, p_discounts numeric[]) set search_path = public, pg_temp;
alter function public.purchase_unit_net(p_cost numeric, p_discounts numeric[], p_global numeric) set search_path = public, pg_temp;
alter function public.purchase_weighted_avg(p_stock_before numeric, p_avg_before numeric, p_qty numeric, p_unit_cost numeric) set search_path = public, pg_temp;
alter function public.purchase_withholdings_total(p_wh jsonb) set search_path = public, pg_temp;
alter function public.trg_goods_receipts_voided_guard() set search_path = public, pg_temp;
alter function public.trg_product_lots_defaults() set search_path = public, pg_temp;
alter function public.trg_suppliers_normalize() set search_path = public, pg_temp;
alter function public.trg_treasury_accounts_normalize() set search_path = public, pg_temp;
