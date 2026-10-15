-- =============================================================================
-- 20261208100000_ml_vincular_candidatos  (ADR-141 · parte A)
--
-- "Vincular con un producto" (Mercado Libre): candidatos del catálogo para una
-- publicación, con foto, marca, SKU y código de barras, y la sugerencia por
-- GTIN, SKU o palabras del título.
--
--   ml_link_candidates(p_item, p_search, p_gtins, p_skus, p_limit)
--     · Sin búsqueda: sugerencias. Primero el GTIN de la publicación igual al
--       código de barras del producto o de una variante, después el SKU igual
--       y por último los productos que comparten palabras del título (al
--       menos 2, o la mitad si el título es corto).
--     · Con búsqueda: nombre, SKU, código de barras, PLU, marca y SKU o código
--       de las variantes; las coincidencias por GTIN, SKU o título suben.
--   Lectura: cualquier rol operativo con la feature `mercadolibre`
--   (ml_assert(false, true)); vincular sigue siendo de dueño o encargado
--   (ml_item_link). La publicación tiene que ser del negocio. Los combos no se
--   vinculan (ADR-104) y no se listan. SECURITY DEFINER con el negocio del
--   JWT: nunca devuelve filas de otro negocio.
--
-- Sin tablas nuevas. No recrea funciones de otras ramas.
-- =============================================================================

create or replace function _ml_title_words(p_text text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  -- Minúsculas, sin acentos y sin signos; palabras de 3 letras o más, sin
  -- repetir y sin las muy comunes; como mucho 10.
  select coalesce(array_agg(w order by first_pos), '{}')
    from (
      select w, min(pos) as first_pos
        from regexp_split_to_table(
               regexp_replace(
                 translate(lower(coalesce(p_text, '')), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'),
                 '[^a-z0-9]+', ' ', 'g'),
               '\s+') with ordinality as t(w, pos)
       where char_length(w) >= 3
         and w not in ('con', 'para', 'por', 'los', 'las', 'del', 'una', 'uno', 'sin', 'the', 'and', 'x10', 'pack', 'kit')
       group by w
       order by min(pos)
       limit 10
    ) s;
$$;
grant execute on function _ml_title_words(text) to authenticated, service_role;

create or replace function ml_link_candidates(p_item uuid, p_search text default null, p_gtins text[] default null,
                                              p_skus text[] default null, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := ml_assert(false, true);
  v_item    ml_items%rowtype;
  v_search  text := nullif(btrim(coalesce(p_search, '')), '');
  v_like    text;
  v_words   text[];
  v_need    int;
  v_gtins   text[] := coalesce((select array_agg(distinct g) from unnest(coalesce(p_gtins, '{}')) x(v)
                                 cross join lateral (select regexp_replace(x.v, '\D', '', 'g') as g) y
                                where char_length(y.g) between 8 and 14), '{}');
  v_skus    text[] := coalesce((select array_agg(distinct upper(btrim(x.v))) from unnest(coalesce(p_skus, '{}')) x(v)
                                where char_length(btrim(coalesce(x.v, ''))) between 1 and 80), '{}');
  v_limit   int := least(greatest(coalesce(p_limit, 30), 1), 60);
  v_out     jsonb;
begin
  select * into v_item from ml_items i where i.id = p_item and i.tenant_id = v_tenant and i.deleted_at is null;
  if v_item.id is null then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  v_words := _ml_title_words(v_item.title);
  v_need := case when coalesce(array_length(v_words, 1), 0) <= 3 then greatest(coalesce(array_length(v_words, 1), 0) / 2, 1)
                 else 2 end;
  if v_search is not null then
    v_like := '%' || replace(replace(replace(left(v_search, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with base as (
    select p.id, p.name, p.sku, p.barcode, p.plu, p.image_url, p.has_variants, p.price, p.stock,
           b.name as brand,
           translate(lower(p.name), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc') as name_norm
      from products p
      left join brands b on b.id = p.brand_id and b.tenant_id = p.tenant_id
     where p.tenant_id = v_tenant and p.deleted_at is null and not coalesce(p.is_kit, false)
  ),
  scored as (
    select x.*,
           -- Variante que coincide por GTIN o SKU (si la hay).
           (select v.id from product_variants v
             where v.product_id = x.id and v.tenant_id = v_tenant and v.deleted_at is null
               and (regexp_replace(coalesce(v.barcode, ''), '\D', '', 'g') = any (v_gtins)
                    or upper(btrim(coalesce(v.sku, ''))) = any (v_skus))
             order by (regexp_replace(coalesce(v.barcode, ''), '\D', '', 'g') = any (v_gtins)) desc
             limit 1) as variant_id,
           (regexp_replace(coalesce(x.barcode, ''), '\D', '', 'g') = any (v_gtins)
            or exists (select 1 from product_variants v
                        where v.product_id = x.id and v.tenant_id = v_tenant and v.deleted_at is null
                          and regexp_replace(coalesce(v.barcode, ''), '\D', '', 'g') = any (v_gtins))) as by_gtin,
           (upper(btrim(coalesce(x.sku, ''))) = any (v_skus)
            or exists (select 1 from product_variants v
                        where v.product_id = x.id and v.tenant_id = v_tenant and v.deleted_at is null
                          and upper(btrim(coalesce(v.sku, ''))) = any (v_skus))) as by_sku,
           (select count(*) from unnest(v_words) w where x.name_norm like '%' || w || '%')::int as words_hit,
           (v_like is not null and (
              x.name ilike v_like or x.sku ilike v_like or x.barcode ilike v_like or x.plu ilike v_like
              or x.brand ilike v_like
              or exists (select 1 from product_variants v
                          where v.product_id = x.id and v.tenant_id = v_tenant and v.deleted_at is null
                            and (v.sku ilike v_like or v.barcode ilike v_like
                                 or v.option1 ilike v_like or v.option2 ilike v_like)))) as by_search
      from base x
  ),
  ranked as (
    select s.*,
           case when s.by_gtin then 'gtin' when s.by_sku then 'sku'
                when s.words_hit >= v_need then 'title' when s.by_search then 'search' end as match,
           (case when s.by_gtin then 1000 else 0 end) + (case when s.by_sku then 800 else 0 end)
           + s.words_hit * 20 + (case when s.by_search then 100 else 0 end)
           + (case when v_search is not null and lower(s.name) like lower(left(v_search, 80)) || '%' then 50 else 0 end)
             as score
      from scored s
     where (v_search is null and (s.by_gtin or s.by_sku or s.words_hit >= v_need))
        or (v_search is not null and s.by_search)
     order by score desc, s.name
     limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', r.id, 'name', r.name, 'sku', r.sku, 'barcode', r.barcode, 'brand', r.brand,
           'image_url', r.image_url, 'has_variants', r.has_variants, 'price', r.price, 'stock', r.stock,
           'variant_id', r.variant_id,
           'variant_label', (select v.option1 || coalesce(' / ' || v.option2, '') from product_variants v where v.id = r.variant_id),
           'match', r.match, 'score', r.score, 'words_hit', r.words_hit,
           'linked_elsewhere', (select count(*) from ml_item_links l
                                 where l.tenant_id = v_tenant and l.product_id = r.id and l.item_id <> v_item.id))
         order by r.score desc, r.name), '[]'::jsonb)
    into v_out
    from ranked r;

  return jsonb_build_object(
    'item', jsonb_build_object('id', v_item.id, 'ml_item_id', v_item.ml_item_id, 'title', v_item.title,
                               'thumbnail', v_item.thumbnail, 'price', v_item.price, 'permalink', v_item.permalink),
    'words', to_jsonb(v_words),
    'searching', v_search is not null,
    'candidates', v_out);
end;
$$;
revoke all on function ml_link_candidates(uuid, text, text[], text[], integer) from public, anon;
grant execute on function ml_link_candidates(uuid, text, text[], text[], integer) to authenticated;
