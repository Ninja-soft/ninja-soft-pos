-- =============================================================================
-- 20260601150000_payment_plans_provider  (H27 — planes por medio de pago)
-- Scopea cada plan a un medio conectado (provider_key). Los planes viejos
-- quedan con provider_key NULL (globales / legacy).
-- =============================================================================
alter table payment_plans add column if not exists provider_key text
  references payment_providers(key);
create index if not exists payment_plans_provider_idx
  on payment_plans(tenant_id, provider_key);

-- El code dedup ahora es por (tenant, provider, code) para que el mismo code
-- (ej. "credito_3") pueda existir en distintos medios.
drop index if exists payment_plans_tenant_code_uk;
create unique index if not exists payment_plans_tenant_provider_code_uk
  on payment_plans(tenant_id, provider_key, code) where code is not null;
