-- =============================================================================
-- 20260531310000_payment_plans  (H27 — planes de pago con recargo)
-- Planes/variantes con recargo % (ej. "Visa 3 cuotas" +8%). El recargo se
-- agrega como ítem "Recargo …" en la venta (no toca create_sale).
-- Select: miembros del tenant. Alta/edición: owner/manager.
-- =============================================================================
create table if not exists payment_plans (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  label         text not null,
  surcharge_pct numeric not null default 0,
  sort          int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists payment_plans_tenant_idx on payment_plans(tenant_id, sort);
alter table payment_plans enable row level security;

create policy payment_plans_select on payment_plans
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy payment_plans_write on payment_plans
  for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')));
