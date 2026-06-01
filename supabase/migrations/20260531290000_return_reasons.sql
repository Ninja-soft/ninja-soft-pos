-- =============================================================================
-- 20260531290000_return_reasons  (H29 — catálogo de motivos de devolución)
-- Motivos configurables por tenant para usar en la devolución (en vez de texto
-- libre). Select para miembros; alta/edición para owner/manager.
-- =============================================================================
create table if not exists return_reasons (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  label      text not null,
  sort       int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists return_reasons_tenant_idx on return_reasons(tenant_id, sort);
alter table return_reasons enable row level security;

create policy return_reasons_select on return_reasons
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy return_reasons_write on return_reasons
  for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')));
