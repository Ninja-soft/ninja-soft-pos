-- =============================================================================
-- 20260531320000_audit_fixes_db  (correcciones de auditoría — capa DB)
-- #5 (CRÍTICO): stock_movements.tenant_id es NOT NULL sin default; create_sale y
--   return_sale insertan sin tenant_id → fallaría al mover stock. Se agrega el
--   default current_tenant_id() (mismo patrón que products/categories).
-- #8: numeración de devoluciones sin unicidad → se agrega unique(tenant_id,number).
-- =============================================================================
alter table stock_movements alter column tenant_id set default current_tenant_id();

alter table sale_returns
  add constraint sale_returns_tenant_number_uk unique (tenant_id, number);
