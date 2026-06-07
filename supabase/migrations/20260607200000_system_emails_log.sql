-- =============================================================================
-- 20260607200000_system_emails_log  (paridad Food — bitácora de envíos)
-- Registro de cada email saliente (sistema, prueba SMTP y comprobantes):
-- pending → sent | failed (+ error). Solo staff interno lo lee; escriben las
-- Edge Functions con service_role.
-- =============================================================================
create table if not exists system_emails (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete set null,
  recipient     text not null,
  subject       text not null,
  kind          text not null default 'system'
                  check (kind in ('system','receipt','smtp_test')),
  status        text not null default 'pending'
                  check (status in ('pending','sent','failed')),
  error_message text,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_system_emails_created on system_emails(created_at desc);
create index if not exists idx_system_emails_tenant on system_emails(tenant_id);

alter table system_emails enable row level security;

-- Solo staff interno lee; sin policies de escritura (solo service_role).
create policy system_emails_select on system_emails
  for select using ((select is_internal()));
