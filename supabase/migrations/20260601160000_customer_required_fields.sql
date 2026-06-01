-- =============================================================================
-- 20260601160000_customer_required_fields  (H31 — datos obligatorios + cumple)
-- Agrega fecha de nacimiento al cliente y una config por tenant de qué campos
-- del cliente son obligatorios. Default '{}' = nada obligatorio (conservador,
-- no cambia el comportamiento de los tenants existentes).
-- =============================================================================
alter table customers add column if not exists birth_date date;
alter table pos_settings add column if not exists customer_required jsonb not null default '{}'::jsonb;
