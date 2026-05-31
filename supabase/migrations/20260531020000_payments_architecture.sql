-- =============================================================================
-- 20260531020000_payments_architecture  (H14 — F8)
-- Arquitectura de pagos: catálogo global de proveedores, config por tenant
-- (no secreta) y secretos (solo service_role). Aplicada vía Supabase MCP.
-- =============================================================================

create table if not exists payment_providers (
  key        text primary key,
  name       text not null,
  kind       text not null check (kind in ('manual','gateway','qr','orchestrator')),
  sort       int not null default 0,
  is_active  boolean not null default true
);
alter table payment_providers enable row level security;
create policy payment_providers_read on payment_providers for select using (true);

insert into payment_providers (key, name, kind, sort) values
  ('cash','Efectivo','manual',0),
  ('transfer','Transferencia bancaria','manual',1),
  ('mercadopago','Mercado Pago','gateway',2),
  ('mercadopago_point','Mercado Point','gateway',3),
  ('modo','MODO (QR)','qr',4),
  ('payway','Payway / Prisma','gateway',5),
  ('getnet','Getnet','gateway',6),
  ('fiserv','Fiserv / Posnet / Clover','gateway',7),
  ('mobbex','Mobbex (orquestador)','orchestrator',8),
  ('pagos360','Pagos360','gateway',9)
on conflict (key) do nothing;

create table if not exists tenant_payment_methods (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  provider_key  text not null references payment_providers(key),
  enabled       boolean not null default false,
  sandbox       boolean not null default true,
  surcharge_pct numeric not null default 0,
  config        jsonb not null default '{}'::jsonb,
  sort          int not null default 0,
  updated_at    timestamptz not null default now(),
  unique (tenant_id, provider_key)
);
create index if not exists tenant_payment_methods_tenant_idx on tenant_payment_methods(tenant_id);
create trigger set_updated_at_tenant_payment_methods
  before update on tenant_payment_methods
  for each row execute function set_updated_at();

alter table tenant_payment_methods enable row level security;
create policy tpm_select on tenant_payment_methods
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy tpm_write on tenant_payment_methods
  for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')));

-- Secretos de proveedor: SOLO service_role (RLS sin policies = deny a todos).
create table if not exists payment_secrets (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  provider_key text not null references payment_providers(key),
  secrets      jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, provider_key)
);
alter table payment_secrets enable row level security;
