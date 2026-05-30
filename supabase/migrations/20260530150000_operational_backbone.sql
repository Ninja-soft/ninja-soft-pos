-- =============================================================================
-- 20260530150000_operational_backbone
-- Hito 2/3 — backbone operativo: stores, cash_registers, cash_shifts,
-- cash_movements, sales, sale_items, payments. Ver docs/04-database.md §4.3.
-- Las ventas dependen de un turno de caja abierto (docs/03 §5), por eso caja
-- entra junto con ventas. customers (Hito 4) aún no existe: sales.customer_id
-- queda uuid nullable sin FK.
-- tenant_id default current_tenant_id() en todas; created_by default auth.uid().
-- =============================================================================

-- ---------- stores ----------
create table if not exists stores (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name       text not null,
  address    text,
  phone      text,
  is_default boolean not null default false,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists stores_tenant_idx on stores(tenant_id) where deleted_at is null;
create trigger set_updated_at_stores before update on stores for each row execute function set_updated_at();

-- ---------- cash_registers ----------
create table if not exists cash_registers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id   uuid not null references stores(id),
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cash_registers_tenant_idx on cash_registers(tenant_id);
create trigger set_updated_at_cash_registers before update on cash_registers for each row execute function set_updated_at();

-- ---------- cash_shifts ----------
create table if not exists cash_shifts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  cash_register_id uuid not null references cash_registers(id),
  opened_by        uuid not null default auth.uid() references public.users(id),
  closed_by        uuid references public.users(id),
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  opening_amount   numeric(12,2) not null,
  expected_amount  numeric(12,2),
  closing_amount   numeric(12,2),
  difference       numeric(12,2) generated always as (closing_amount - expected_amount) stored,
  status           text not null default 'open' check (status in ('open','closed')),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists cash_shifts_tenant_idx on cash_shifts(tenant_id, opened_at desc);
create index if not exists cash_shifts_register_idx on cash_shifts(cash_register_id, status);
create trigger set_updated_at_cash_shifts before update on cash_shifts for each row execute function set_updated_at();

-- ---------- cash_movements ----------
create table if not exists cash_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  cash_shift_id  uuid not null references cash_shifts(id),
  type           text not null check (type in ('income','expense','sale','sale_void')),
  amount         numeric(12,2) not null,
  payment_method text,
  reason         text,
  reference_id   uuid,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references public.users(id)
);
create index if not exists cash_movements_shift_idx on cash_movements(cash_shift_id, created_at);

-- ---------- sales ----------
create table if not exists sales (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id       uuid not null references stores(id),
  cash_shift_id  uuid references cash_shifts(id),
  customer_id    uuid,  -- FK a customers() en Hito 4
  number         bigint not null,
  status         text not null default 'completed' check (status in ('completed','voided','suspended')),
  subtotal       numeric(12,2) not null,
  discount_total numeric(12,2) not null default 0,
  tax_total      numeric(12,2) not null default 0,
  total          numeric(12,2) not null,
  notes          text,
  voided_at      timestamptz,
  voided_by      uuid references public.users(id),
  void_reason    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references public.users(id),
  unique(tenant_id, number)
);
create index if not exists sales_tenant_created_idx on sales(tenant_id, created_at desc);
create index if not exists sales_shift_idx on sales(cash_shift_id);
create index if not exists sales_status_idx on sales(tenant_id, status);
create trigger set_updated_at_sales before update on sales for each row execute function set_updated_at();

-- ---------- sale_items ----------
create table if not exists sale_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  sale_id      uuid not null references sales(id) on delete cascade,
  product_id   uuid not null references products(id),
  product_name text not null,
  sku          text,
  quantity     numeric(12,3) not null,
  unit_price   numeric(12,2) not null,
  discount     numeric(12,2) not null default 0,
  subtotal     numeric(12,2) not null,
  created_at   timestamptz not null default now()
);
create index if not exists sale_items_sale_idx on sale_items(sale_id);
create index if not exists sale_items_product_idx on sale_items(product_id);

-- ---------- payments ----------
create table if not exists payments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  sale_id    uuid not null references sales(id) on delete cascade,
  method     text not null check (method in ('cash','debit','credit','transfer','qr','other')),
  amount     numeric(12,2) not null,
  reference  text,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payments_sale_idx on payments(sale_id);
create index if not exists payments_tenant_method_idx on payments(tenant_id, method, created_at desc);

-- ---------- stock_movements.store_id FK (ahora que stores existe) ----------
alter table stock_movements
  add constraint stock_movements_store_id_fkey
  foreign key (store_id) references stores(id);

-- ---------- RLS: aislamiento por tenant ----------
alter table stores enable row level security;
create policy stores_tenant_isolation on stores for all using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
alter table cash_registers enable row level security;
create policy cash_registers_tenant_isolation on cash_registers for all using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
alter table cash_shifts enable row level security;
create policy cash_shifts_tenant_isolation on cash_shifts for all using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
alter table cash_movements enable row level security;
create policy cash_movements_tenant_isolation on cash_movements for all using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
alter table sales enable row level security;
create policy sales_tenant_isolation on sales for all using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
alter table sale_items enable row level security;
create policy sale_items_tenant_isolation on sale_items for all using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
alter table payments enable row level security;
create policy payments_tenant_isolation on payments for all using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

-- ---------- Auditoría en tablas críticas ----------
create trigger audit_sales after insert or update or delete on sales for each row execute function write_audit_log();
create trigger audit_payments after insert or delete on payments for each row execute function write_audit_log();
create trigger audit_cash_shifts after insert or update or delete on cash_shifts for each row execute function write_audit_log();
create trigger audit_cash_movements after insert or delete on cash_movements for each row execute function write_audit_log();
