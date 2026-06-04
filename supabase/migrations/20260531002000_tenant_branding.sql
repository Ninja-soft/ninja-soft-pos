-- =============================================================================
-- Recuperada del remoto (schema_migrations, version 20260531011914): aplicada
-- vía MCP el 2026-05-31 pero nunca commiteada. Restaurada el 2026-06-04 para
-- que el historial replaye en DBs frescas (detectado por el job rls de CI).
-- =============================================================================
-- H8 (F6) — Branding por tenant: logo, color de acento y datos comerciales,
-- para aplicar en tickets, catálogo y emails. Lo edita owner/manager.

create table if not exists tenant_branding (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  logo_path     text,
  logo_url      text,
  accent        text,                       -- hex, dentro de límites de marca
  legal_name    text,
  cuit          text,
  phone         text,
  address       text,
  ticket_footer text,
  updated_at    timestamptz not null default now()
);

create trigger set_updated_at_tenant_branding
  before update on tenant_branding
  for each row execute function set_updated_at();

alter table tenant_branding enable row level security;

-- Lectura: miembros del tenant (o interno). Escritura: owner/manager del tenant.
create policy tenant_branding_select on tenant_branding
  for select using (tenant_id = current_tenant_id() or is_internal());

create policy tenant_branding_write on tenant_branding
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

-- Bucket de assets del tenant (logos, etc.). Público para mostrar en tickets/catálogo.
insert into storage.buckets (id, name, public)
values ('tenant-assets', 'tenant-assets', true)
on conflict (id) do nothing;

create policy "tenant_assets_write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-assets' and (storage.foldername(name))[1] = current_tenant_id()::text);
create policy "tenant_assets_modify"
  on storage.objects for update to authenticated
  using (bucket_id = 'tenant-assets' and (storage.foldername(name))[1] = current_tenant_id()::text);
create policy "tenant_assets_remove"
  on storage.objects for delete to authenticated
  using (bucket_id = 'tenant-assets' and (storage.foldername(name))[1] = current_tenant_id()::text);
