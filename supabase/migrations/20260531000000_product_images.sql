-- =============================================================================
-- 20260531000000_product_images  (H7 — F6)
-- Galería de imágenes de producto. La conversión a WebP es client-side
-- (sharp no corre en Supabase Edge/Deno). Tabla + bucket de Storage + RLS.
-- Aplicada vía Supabase MCP el 2026-05-31 (product_images, product_images_no_listing).
-- =============================================================================

create table if not exists product_images (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  path        text not null,
  url         text not null,
  sort        int  not null default 0,
  is_primary  boolean not null default false,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists product_images_product_idx on product_images(product_id);
create index if not exists product_images_tenant_idx on product_images(tenant_id);

alter table product_images enable row level security;

create policy product_images_select on product_images
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy product_images_insert on product_images
  for insert with check (tenant_id = current_tenant_id());
create policy product_images_update on product_images
  for update using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
create policy product_images_delete on product_images
  for delete using (tenant_id = current_tenant_id());

-- Bucket público: lectura por URL directa (sin policy SELECT, así no se puede LISTAR).
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Escritura en Storage: solo el tenant dueño del primer folder del path.
create policy "product_images_write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = current_tenant_id()::text
  );
create policy "product_images_modify"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = current_tenant_id()::text
  );
create policy "product_images_remove"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = current_tenant_id()::text
  );
