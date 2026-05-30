-- =============================================================================
-- 20260530130000_catalog_products
-- Hito 1 — Catálogo y stock: categories, products, stock_movements.
-- Ver docs/04-database.md §4.3, docs/08-multi-tenant.md §4 (plantilla operativa).
-- stock_movements.store_id queda como uuid nullable SIN FK: la tabla stores
-- llega en Hito 3; la FK se agrega entonces.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- categories (1 nivel de jerarquía en MVP vía parent_id self-ref).
-- -----------------------------------------------------------------------------
create table if not exists categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  parent_id   uuid references categories(id),
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists categories_tenant_idx on categories(tenant_id) where deleted_at is null;
create index if not exists categories_parent_idx on categories(parent_id);

create trigger set_updated_at_categories
  before update on categories
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- products.
-- -----------------------------------------------------------------------------
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  category_id uuid references categories(id),
  sku         text,
  barcode     text,
  name        text not null,
  description text,
  price       numeric(12,2) not null check (price >= 0),
  cost        numeric(12,2),
  stock       numeric(12,3) not null default 0,
  stock_min   numeric(12,3) default 0,
  unit        text not null default 'un',
  image_url   text,
  is_active   boolean not null default true,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users(id),
  updated_by  uuid references public.users(id),
  deleted_at  timestamptz
);

create unique index if not exists products_tenant_sku_idx
  on products(tenant_id, sku) where sku is not null and deleted_at is null;
create unique index if not exists products_tenant_barcode_idx
  on products(tenant_id, barcode) where barcode is not null and deleted_at is null;
create index if not exists products_tenant_name_idx on products(tenant_id, name);
create index if not exists products_category_idx on products(category_id);

create trigger set_updated_at_products
  before update on products
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- stock_movements (append-only; sin updated_at).
-- -----------------------------------------------------------------------------
create table if not exists stock_movements (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  product_id   uuid not null references products(id),
  store_id     uuid,  -- FK a stores() se agrega en Hito 3
  delta        numeric(12,3) not null,
  reason       text not null
                 check (reason in ('purchase','sale','sale_void','adjustment','transfer','loss','return')),
  reference_id uuid,
  notes        text,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.users(id)
);

create index if not exists stock_movements_product_idx on stock_movements(product_id, created_at desc);
create index if not exists stock_movements_tenant_idx on stock_movements(tenant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- RLS: aislamiento por tenant (plantilla docs/08 §4).
-- -----------------------------------------------------------------------------
alter table categories enable row level security;
create policy categories_tenant_isolation on categories
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

alter table products enable row level security;
create policy products_tenant_isolation on products
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

alter table stock_movements enable row level security;
create policy stock_movements_tenant_isolation on stock_movements
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- -----------------------------------------------------------------------------
-- Auditoría: cambios de producto (precio) y movimientos manuales de stock.
-- Ver docs/05-security.md §8.1.
-- -----------------------------------------------------------------------------
create trigger audit_products
  after insert or update or delete on products
  for each row execute function write_audit_log();

create trigger audit_stock_movements
  after insert or delete on stock_movements
  for each row execute function write_audit_log();
