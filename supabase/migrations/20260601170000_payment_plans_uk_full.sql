-- =============================================================================
-- 20260601170000_payment_plans_uk_full  (H27 fix)
-- El índice único parcial (WHERE code is not null) no se puede usar como target
-- de ON CONFLICT vía PostgREST → el upsert de celdas/seed/import fallaba en
-- silencio (no se guardaba nada). Lo reemplazamos por un índice completo.
-- `code` siempre viene seteado desde el front (planCode), así que es seguro.
-- =============================================================================
drop index if exists payment_plans_tenant_provider_code_uk;
create unique index if not exists payment_plans_tenant_provider_code_uk
  on payment_plans(tenant_id, provider_key, code);
