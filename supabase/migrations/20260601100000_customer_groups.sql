-- =============================================================================
-- 20260601100000_customer_groups  (H31 base — grupos de clientes)
-- Grupos para segmentar clientes (mayorista, VIP, etc.). Base para precios/
-- promos/riesgo futuros. Select: miembros. Alta/edición: owner/manager.
-- =============================================================================
create table if not exists customer_groups (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name       text not null,
  sort       int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists customer_groups_tenant_idx on customer_groups(tenant_id, sort);
alter table customer_groups enable row level security;

create policy customer_groups_select on customer_groups
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy customer_groups_write on customer_groups
  for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')));

alter table customers add column if not exists group_id uuid references customer_groups(id);
