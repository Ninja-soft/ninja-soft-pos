-- =============================================================================
-- 20260531250000_require_customer  (H30 — requerir cliente al vender)
-- Flag por tenant. La validación se hace en el POS (regla operativa).
-- =============================================================================
alter table pos_settings
  add column if not exists require_customer boolean not null default false;
