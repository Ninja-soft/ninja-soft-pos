-- =============================================================================
-- Recuperada del remoto (schema_migrations, version 20260531014212): aplicada
-- vía MCP el 2026-05-31 pero nunca commiteada. Restaurada el 2026-06-04 para
-- que el historial replaye en DBs frescas (detectado por el job rls de CI).
-- =============================================================================
-- H10 (F6) — Catálogo público por tenant (read-only, anónimo). SECURITY DEFINER
-- para exponer solo productos activos de tenants activos, sin saltar el aislamiento
-- (filtra por el slug pedido). Callable por anon.
create or replace function public_catalog(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when tt.id is null then null else jsonb_build_object(
    'tenant', jsonb_build_object('name', tt.name, 'slug', tt.slug),
    'branding', (
      select jsonb_build_object(
        'logo_url', b.logo_url, 'accent', b.accent, 'legal_name', b.legal_name,
        'phone', b.phone, 'address', b.address
      ) from tenant_branding b where b.tenant_id = tt.id
    ),
    'products', coalesce((
      select jsonb_agg(s.x order by s.name) from (
        select p.name,
          jsonb_build_object(
            'id', p.id, 'name', p.name, 'price', p.price,
            'image_url', p.image_url, 'category', c.name
          ) as x
        from products p
        left join categories c on c.id = p.category_id
        where p.tenant_id = tt.id and p.is_active and p.deleted_at is null
      ) s
    ), '[]'::jsonb)
  ) end
  from (
    select id, name, slug from tenants
    where slug = p_slug and deleted_at is null and status in ('trial','active')
    limit 1
  ) tt;
$$;

revoke all on function public_catalog(text) from public;
grant execute on function public_catalog(text) to anon, authenticated;
