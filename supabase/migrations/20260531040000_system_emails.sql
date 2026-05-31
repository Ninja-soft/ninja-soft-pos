-- =============================================================================
-- 20260531040000_system_emails  (H13 corregido — F7)
-- Emails del SISTEMA (globales, NinjaSoft). Se editan en /internal/emails.
-- Override de los defaults del catálogo (lib/email/templates.ts) + remitente.
-- Aplicada vía Supabase MCP. Solo staff (is_internal) lee/escribe.
-- =============================================================================
create table if not exists system_email_templates (
  key        text primary key,
  subject    text not null default '',
  html       text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists system_email_config (
  id         boolean primary key default true check (id = true),
  from_name  text not null default 'NinjaPos',
  from_email text not null default '',
  updated_at timestamptz not null default now()
);
insert into system_email_config (id) values (true) on conflict (id) do nothing;

create trigger set_updated_at_system_email_templates
  before update on system_email_templates
  for each row execute function set_updated_at();
create trigger set_updated_at_system_email_config
  before update on system_email_config
  for each row execute function set_updated_at();

alter table system_email_templates enable row level security;
alter table system_email_config enable row level security;

create policy set_tpl on system_email_templates for all
  using (is_internal()) with check (is_internal());
create policy set_cfg on system_email_config for all
  using (is_internal()) with check (is_internal());
