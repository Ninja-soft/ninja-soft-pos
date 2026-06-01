-- =============================================================================
-- 20260601110000_warranty_plans  (H28 — planes de garantía extendida)
-- Planes de garantía extendida por tenant (meses extra, prima fija, comisión
-- del vendedor). Select: miembros. Alta/edición: owner/manager.
-- =============================================================================
create table if not exists warranty_plans (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  label          text not null,
  months         int not null default 0,
  price          numeric not null default 0,        -- prima fija ($)
  commission_pct numeric not null default 0,        -- comisión del vendedor
  sort           int not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists warranty_plans_tenant_idx on warranty_plans(tenant_id, sort);
alter table warranty_plans enable row level security;

create policy warranty_plans_select on warranty_plans
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy warranty_plans_write on warranty_plans
  for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')));
