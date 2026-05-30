-- =============================================================================
-- 20260530120300_audit_logs
-- Hito 0 — bitácora de auditoría append-only. Ver docs/04-database.md §4.1,
-- docs/05-security.md §8, docs/08-multi-tenant.md §6.
-- tenant_id nullable: permite registros del sistema (jobs internos, rotación).
-- Sin FKs duras a propósito: el log debe sobrevivir aunque se borre la entidad.
-- =============================================================================

create table if not exists audit_logs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid,
  actor_user_id uuid,
  entity_type   text not null,
  entity_id     uuid,
  action        text not null,   -- INSERT, UPDATE, DELETE, o custom (sale_voided…)
  before_data   jsonb,
  after_data    jsonb,
  reason        text,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index if not exists audit_logs_tenant_idx on audit_logs(tenant_id, created_at desc);
create index if not exists audit_logs_entity_idx on audit_logs(entity_type, entity_id);
create index if not exists audit_logs_actor_idx on audit_logs(actor_user_id, created_at desc);
