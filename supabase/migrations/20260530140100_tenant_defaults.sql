-- =============================================================================
-- 20260530140100_tenant_defaults
-- Hito 1 — defaults que simplifican inserts desde el cliente y mantienen RLS:
-- tenant_id toma current_tenant_id() y created_by toma auth.uid() por defecto.
-- Así el frontend inserta sin pasar tenant_id y la with-check de RLS pasa.
-- =============================================================================
alter table categories alter column tenant_id set default current_tenant_id();
alter table products   alter column tenant_id set default current_tenant_id();
alter table products   alter column created_by set default auth.uid();
