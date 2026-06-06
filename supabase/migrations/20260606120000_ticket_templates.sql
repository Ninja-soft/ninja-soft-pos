-- H9b (F6) — Plantillas de ticket multi-modelo por tenant + email de comprobante.
-- Modos: blocks (PR1), canvas/html (PR2, mismo esquema).

create table if not exists ticket_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  kind        text not null default 'sale' check (kind in ('sale','promo','gift')),
  mode        text not null default 'blocks' check (mode in ('blocks','canvas','html')),
  paper       text not null default '80' check (paper in ('58','80','a4')),
  content     jsonb not null default '{"blocks":[]}'::jsonb,
  show_ninjasoft_logo boolean not null default false,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_ticket_templates_tenant on ticket_templates(tenant_id);
-- Un solo default activo por tipo de documento por tenant.
create unique index if not exists uq_ticket_templates_default
  on ticket_templates(tenant_id, kind) where is_default and deleted_at is null;

create trigger set_updated_at_ticket_templates
  before update on ticket_templates
  for each row execute function set_updated_at();

alter table ticket_templates enable row level security;

create policy ticket_templates_select on ticket_templates
  for select using (tenant_id = current_tenant_id() or is_internal());

create policy ticket_templates_write on ticket_templates
  for all
  using (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
        and me.role in ('owner','manager')
    )
  )
  with check (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
        and me.role in ('owner','manager')
    )
  );

-- Email del comprobante: registro del último envío + setting de envío automático.
alter table sales add column if not exists receipt_email_to text;
alter table sales add column if not exists receipt_emailed_at timestamptz;
alter table pos_settings add column if not exists auto_email_receipt boolean not null default false;
