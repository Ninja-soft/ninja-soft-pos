-- =============================================================================
-- 20260604160000_tenant_notes
-- F2 — notas internas de soporte por tenant. Solo staff NinjaSoft (is_internal)
-- puede ver y escribir; los usuarios del tenant NUNCA las ven. Baja lógica.
-- Sin FK dura al autor (la nota sobrevive si el usuario se borra).
-- =============================================================================

create table if not exists tenant_notes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  author_user_id uuid,
  body           text not null check (length(trim(body)) > 0),
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index if not exists tenant_notes_tenant_idx
  on tenant_notes (tenant_id, created_at desc);

alter table tenant_notes enable row level security;

create policy tenant_notes_select on tenant_notes
  for select using ((select is_internal()));

create policy tenant_notes_insert on tenant_notes
  for insert with check (
    (select is_internal())
    and author_user_id = (select auth.uid())
  );

-- Update solo para baja lógica / edición del propio staff.
create policy tenant_notes_update on tenant_notes
  for update using ((select is_internal()))
  with check ((select is_internal()));
