-- =============================================================================
-- 20260608395000_catalog_price_reference
-- Referencia de precios de mercado para Productos y Listas de precios.
--
-- Si el tenant COMPRÓ (o recibió) al menos un catálogo (tenant_catalog_purchases),
-- podemos comparar SU precio contra el "precio de referencia" de los principales
-- competidores (las tiendas que componen ese catálogo: COTO, CARREFOUR, DIA,
-- JUMBO, EASY...). La comparación es meramente informativa (tendencias de
-- mercado), no vinculante.
--
-- Esta migración aporta:
--   * pos_settings.show_catalog_price_hints (bool, default true): permite
--     desactivar las flechas/sugerencias desde la config del POS. El control y
--     las flechas SÓLO se muestran si el tenant compró un catálogo (eso lo decide
--     el frontend leyendo tenant_catalog_purchases).
--   * catalog_price_reference(p_eans text[]): SECURITY DEFINER. Para los EANs
--     pedidos devuelve UN precio de referencia representativo por EAN, calculado
--     SÓLO sobre los catálogos (activos) que el tenant compró/recibió. Pensada
--     para traer en batch las referencias de los productos visibles (sin N+1).
--
-- Conservador: si el tenant no compró ningún catálogo, la función devuelve vacío
-- (la RLS de catalog_products ya lo aislaría igual, pero la función lo corta
-- antes). No regresiona nada existente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Toggle del POS: mostrar/ocultar las flechas de precio vs catálogo. Default on.
-- -----------------------------------------------------------------------------
alter table pos_settings
  add column if not exists show_catalog_price_hints boolean not null default true;

-- -----------------------------------------------------------------------------
-- catalog_price_reference(p_eans) -> (ean, reference_price, store_count)
--
-- Para cada EAN pedido devuelve:
--   * reference_price: precio de referencia REPRESENTATIVO entre las tiendas que
--     el tenant tiene habilitadas (catálogos comprados/activos). Se usa la
--     MEDIANA de los precios positivos (percentile_cont 0.5): robusta frente a
--     outliers y a una sola tienda con precio cargado mal. Si para un EAN no hay
--     ningún precio positivo, ese EAN no se devuelve (sin referencia).
--   * store_count: cuántas tiendas (con precio positivo) respaldan la referencia,
--     para poder matizar el tooltip si hiciera falta.
--
-- Autorización: staff interno ve todo; un tenant sólo ve las tiendas de los
-- catálogos activos que compró/recibió (misma condición que la RLS de
-- catalog_products). Si el tenant no compró nada, el join no matchea y devuelve
-- vacío. search_path fijo (hardening).
--
-- Performance: filtra catalog_products por ean = any(p_eans) (índice por ean) y
-- por las store_key habilitadas; agrupa por EAN. Acota p_eans a 1000 para no
-- traer la tabla entera por accidente.
-- -----------------------------------------------------------------------------
create or replace function public.catalog_price_reference(p_eans text[])
returns table (
  ean text,
  reference_price numeric,
  store_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with eans as (
    -- EANs pedidos: deduplicados, sin vacíos, tope defensivo de 1000.
    select distinct e
    from unnest(coalesce(p_eans, array[]::text[])) as e
    where e is not null and btrim(e) <> ''
    limit 1000
  ),
  allowed_stores as (
    -- Tiendas que el tenant puede ver: las de los catálogos activos que compró/
    -- recibió. Staff interno: todas las tiendas.
    select distinct csm.store_key
    from catalog_store_map csm
    join catalogs c on c.id = csm.catalog_id
    where c.is_active
      and (
        is_internal()
        or exists (
          select 1
          from tenant_catalog_purchases tcp
          where tcp.catalog_id = c.id
            and tcp.tenant_id = current_tenant_id()
        )
      )
  ),
  scoped as (
    select cp.ean, cp.precio
    from catalog_products cp
    join eans en on en.e = cp.ean
    join allowed_stores a on a.store_key = cp.store_key
    where cp.precio is not null
      and cp.precio > 0
  )
  select
    s.ean,
    round(
      percentile_cont(0.5) within group (order by s.precio)::numeric,
      2
    ) as reference_price,
    count(*)::int as store_count
  from scoped s
  group by s.ean;
$$;

revoke all on function public.catalog_price_reference(text[]) from public, anon;
grant execute on function public.catalog_price_reference(text[]) to authenticated;
