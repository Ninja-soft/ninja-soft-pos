-- Performance advisor fixes (Supabase advisors, 2026-06-04)
-- Covering indexes for the 34 unindexed foreign keys reported by the
-- "unindexed_foreign_keys" performance lint. Pure additive change.

create index if not exists cash_movements_created_by_idx on public.cash_movements (created_by);
create index if not exists cash_movements_tenant_id_idx on public.cash_movements (tenant_id);
create index if not exists cash_registers_store_id_idx on public.cash_registers (store_id);
create index if not exists cash_shifts_closed_by_idx on public.cash_shifts (closed_by);
create index if not exists cash_shifts_opened_by_idx on public.cash_shifts (opened_by);
create index if not exists cash_z_closures_closed_by_idx on public.cash_z_closures (closed_by);
create index if not exists cash_z_closures_opened_by_idx on public.cash_z_closures (opened_by);
create index if not exists customer_account_movements_created_by_idx on public.customer_account_movements (created_by);
create index if not exists customer_account_movements_customer_id_idx on public.customer_account_movements (customer_id);
create index if not exists customers_group_id_idx on public.customers (group_id);
create index if not exists mp_payment_intents_sale_id_idx on public.mp_payment_intents (sale_id);
create index if not exists payment_plans_provider_key_idx on public.payment_plans (provider_key);
create index if not exists payment_secrets_provider_key_idx on public.payment_secrets (provider_key);
create index if not exists product_kit_components_component_product_id_idx on public.product_kit_components (component_product_id);
create index if not exists product_serials_sale_id_idx on public.product_serials (sale_id);
create index if not exists products_created_by_idx on public.products (created_by);
create index if not exists products_updated_by_idx on public.products (updated_by);
create index if not exists sale_items_tenant_id_idx on public.sale_items (tenant_id);
create index if not exists sale_return_items_sale_item_id_idx on public.sale_return_items (sale_item_id);
create index if not exists sale_returns_created_by_idx on public.sale_returns (created_by);
create index if not exists sale_returns_customer_id_idx on public.sale_returns (customer_id);
create index if not exists sales_created_by_idx on public.sales (created_by);
create index if not exists sales_customer_id_idx on public.sales (customer_id);
create index if not exists sales_store_id_idx on public.sales (store_id);
create index if not exists sales_voided_by_idx on public.sales (voided_by);
create index if not exists stock_movements_created_by_idx on public.stock_movements (created_by);
create index if not exists stock_movements_store_id_idx on public.stock_movements (store_id);
create index if not exists store_credit_movements_created_by_idx on public.store_credit_movements (created_by);
create index if not exists store_credit_movements_customer_id_idx on public.store_credit_movements (customer_id);
create index if not exists store_credit_movements_sale_return_id_idx on public.store_credit_movements (sale_return_id);
create index if not exists subscriptions_plan_id_idx on public.subscriptions (plan_id);
create index if not exists tenant_feature_flags_configured_by_idx on public.tenant_feature_flags (configured_by);
create index if not exists tenant_feature_flags_feature_flag_id_idx on public.tenant_feature_flags (feature_flag_id);
create index if not exists tenant_payment_methods_provider_key_idx on public.tenant_payment_methods (provider_key);
