-- =============================================================================
-- 20260607140000_public_catalog_price_list  (H10 — catálogo con lista 'catalogo')
-- Spec: docs/superpowers/specs/2026-06-06-h10-variants-price-lists-design.md
--
-- Reescribe public_catalog (definición viva en 20260531004000) para que el
-- precio mostrado resuelva contra la lista de precios activa del canal 'catalogo'
-- del tenant, con la misma precedencia que lib/prices/resolve.ts:
--   1. item de la lista por producto (variant_id null)
--   2. adjustment_pct de la lista sobre el precio base
--   3. precio base (products.price)
-- (El catálogo aún no muestra variantes → solo se resuelve precio por producto.)
--
-- SECURITY DEFINER, callable por anon. Solo cambia la expresión de precio; el
-- resto del shape (tenant/branding/products) se reproduce idéntico.
-- =============================================================================
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
            'id', p.id, 'name', p.name,
            -- Precio resuelto por la lista 'catalogo' activa (item por producto →
            -- ajuste % → base). Sin lista activa → precio base.
            'price', coalesce(
              pli.price,
              case when pl.adjustment_pct is not null
                then round(p.price * (1 + pl.adjustment_pct / 100), 2)
                else p.price end
            ),
            'image_url', p.image_url, 'category', c.name
          ) as x
        from products p
        left join categories c on c.id = p.category_id
        left join lateral (
          select id, adjustment_pct from price_lists
          where tenant_id = tt.id and channel = 'catalogo'
            and is_active and deleted_at is null
          limit 1
        ) pl on true
        left join price_list_items pli
          on pli.price_list_id = pl.id
         and pli.product_id = p.id
         and pli.variant_id is null
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
