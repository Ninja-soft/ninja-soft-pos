-- =============================================================================
-- 20260608570000_customer_extras  (F12 · H40 — clientes livianos y recurrencia)
-- -----------------------------------------------------------------------------
-- Preferencias / gustos del cliente: texto libre para que el comercio anote las
-- preferencias del cliente (ej. "corte degradé, sin máquina", "cortado con leche
-- de almendras", "talle M, colores oscuros"). Es DISTINTO de `notes` (notas
-- internas/operativas que ya existen): preferences describe gustos del cliente
-- para personalizar la atención y la recompra.
--
-- La tabla customers ya tiene RLS por tenant (customers_tenant_isolation); un
-- ADD COLUMN no la altera. Sin backfill: arranca NULL para los existentes.
-- =============================================================================

alter table customers add column if not exists preferences text;

comment on column customers.preferences is
  'Preferencias / gustos del cliente (texto libre, H40). Distinto de notes (notas internas).';
