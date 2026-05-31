-- =============================================================================
-- 20260531030000_email_templates  (H13 — F7)
-- Plantillas de email por tenant (editor HTML + variables). El envío real
-- (Resend/Brevo) se conecta en una etapa siguiente. Aplicada vía Supabase MCP.
-- =============================================================================
create table if not exists email_templates (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  key        text not null,
  subject    text not null default '',
  html       text not null default '',
  enabled    boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create trigger set_updated_at_email_templates
  before update on email_templates
  for each row execute function set_updated_at();

alter table email_templates enable row level security;

create policy email_templates_select on email_templates
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy email_templates_write on email_templates
  for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')));
