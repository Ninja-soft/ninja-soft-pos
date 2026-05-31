-- =============================================================================
-- 20260531120000_brands
-- Catálogo de marcas por tenant (H10b). Asignable a productos y usable como
-- condición de promociones por marca (F9). Baja lógica (deleted_at).
-- =============================================================================
create table if not exists brands (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists brands_tenant_name_idx
  on brands(tenant_id, name) where deleted_at is null;
create index if not exists brands_tenant_idx on brands(tenant_id) where deleted_at is null;

alter table brands enable row level security;
create policy brands_tenant_isolation on brands
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

alter table products add column if not exists brand_id uuid references brands(id);
create index if not exists products_brand_idx on products(brand_id) where brand_id is not null;
