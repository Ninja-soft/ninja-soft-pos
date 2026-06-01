-- =============================================================================
-- 20260531300000_product_warranty  (H28 base — garantía de fábrica por producto)
-- Meses de garantía de fábrica por producto (0 = sin garantía).
-- =============================================================================
alter table products add column if not exists warranty_months int not null default 0;
