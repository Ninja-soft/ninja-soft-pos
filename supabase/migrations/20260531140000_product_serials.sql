-- =============================================================================
-- 20260531140000_product_serials
-- Producto serializado (H10b): cada unidad tiene un N° de serie único (IMEI, S/N).
-- Seriales pre-cargados (status in_stock) que se eligen al vender; también se
-- admite tipear uno nuevo al vender (lo maneja create_sale en el paso siguiente).
-- =============================================================================
alter table products add column if not exists is_serialized boolean not null default false;

-- N° de serie en la línea de venta (para ticket/registro).
alter table sale_items add column if not exists serial text;

create table if not exists product_serials (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  serial     text not null,
  status     text not null default 'in_stock' check (status in ('in_stock','sold')),
  sale_id    uuid references sales(id),
  created_at timestamptz not null default now(),
  unique (product_id, serial)
);
create index if not exists psl_product_idx on product_serials(product_id, status);
create index if not exists psl_tenant_idx on product_serials(tenant_id);

alter table product_serials enable row level security;
create policy psl_tenant_isolation on product_serials
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
