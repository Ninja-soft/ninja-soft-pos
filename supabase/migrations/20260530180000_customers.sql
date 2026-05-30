-- =============================================================================
-- 20260530180000_customers
-- Hito 4 — clientes. Ver docs/04-database.md §4.3. RLS por tenant, defaults,
-- auditoría y FK sales.customer_id -> customers.
-- =============================================================================
create table if not exists customers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name            text not null,
  document_type   text check (document_type in ('cuit','dni','cuil','passport','other')),
  document_number text,
  iva_condition   text check (iva_condition in ('consumidor_final','responsable_inscripto','monotributo','exento','no_responsable')),
  email           text,
  phone           text,
  address         text,
  notes           text,
  is_active       boolean not null default true,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists customers_tenant_doc_idx on customers(tenant_id, document_number);
create index if not exists customers_tenant_name_idx on customers(tenant_id, name);

create trigger set_updated_at_customers before update on customers for each row execute function set_updated_at();

alter table customers enable row level security;
create policy customers_tenant_isolation on customers
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

alter table sales
  add constraint sales_customer_id_fkey
  foreign key (customer_id) references customers(id);
