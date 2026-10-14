-- Tiendita: "Destacados del catálogo" rápidos (catalog_search sin texto).
--
-- Problema (14/10/2026): al abrir un catálogo grande (Supermercado, ~343 mil
-- productos) el buscador quedaba con el spinner girando y el campo vacío. No
-- era un loading permanente: era el fetch inicial de "Destacados", que llama
-- a catalog_search con p_query = ''. Esa rama deduplicaba TODAS las ofertas
-- del catálogo (distinct on sobre ~416 mil filas), las cruzaba con
-- catalog_items y ordenaba por título para quedarse con 30: ~35 s en prod.
-- Con statement_timeout = 8s del rol authenticated se cortaba, y el front
-- reintentaba 3 veces: medio minuto de spinner y después "No se pudo buscar".
--
-- Arreglo: sin texto, los destacados son las publicaciones DISPONIBLES más
-- recientes (item_id descendente). Se recorre catalog_offers_item_idx hacia
-- atrás y se corta en cuanto hay v_limit ítems distintos (~300 ms en frío).
-- Las 30 elegidas se muestran ordenadas por título, como antes. La rama con
-- texto queda IGUAL. Mismas firma, columnas y permisos.

create or replace function public.catalog_search(
  p_catalog_id uuid,
  p_query text default ''::text,
  p_limit integer default 30,
  p_offset integer default 0
)
returns table(
  catalog_product_id bigint, store_key text, ean text, titulo text,
  precio numeric, precio_lista numeric, marca text, categoria_path text,
  foto_url text, disponible boolean, descripcion text, atributos jsonb
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_limit  integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_q      text := btrim(coalesce(p_query, ''));
  v_like   text;
  v_stores text[];
  v_eans   text[];
begin
  if not (select internal_scope()) then
    if not exists (
      select 1 from tenant_catalog_purchases tcp
        join catalogs c on c.id = tcp.catalog_id
       where tcp.catalog_id = p_catalog_id
         and tcp.tenant_id = (select current_tenant_id())
         and c.is_active
    ) then
      raise exception 'forbidden';
    end if;
  end if;

  select c.dedupe_by_ean into v_dedupe from catalogs c where c.id = p_catalog_id;
  if v_dedupe is null then
    raise exception 'catalog_not_found';
  end if;

  v_stores := catalog_store_keys(p_catalog_id);

  -- Sin texto: las publicaciones disponibles más recientes del catálogo.
  -- El orden por item_id desc va por el índice (item_id, store_key) y el
  -- limit corta temprano; con dedupe, una oferta por ítem (la más fresca).
  if v_q = '' then
    return query
    with picked as (
      select distinct on (o.item_id, case when v_dedupe then 0::bigint else o.id end)
             o.id as offer_id, o.item_id, o.store_key, o.precio, o.precio_lista,
             o.disponible
        from catalog_offers o
       where o.store_key = any (v_stores)
         and o.vendedor_key = ''
         and o.disponible
       order by o.item_id desc,
                case when v_dedupe then 0::bigint else o.id end,
                o.updated_at desc, o.id desc
       limit v_limit offset v_offset
    )
    select p.offer_id, p.store_key, i.ean, i.titulo, p.precio, p.precio_lista, i.marca,
           i.categoria_path, i.foto_url, p.disponible, i.descripcion,
           catalog_item_attributes(i.atributos, i.medidas)
      from picked p
      join catalog_items i on i.id = p.item_id
     order by i.titulo, p.offer_id;
    return;
  end if;

  v_like := '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%';
  v_eans := array_remove(array[v_q, catalog_normalize_gtin(v_q)], null);

  -- Con texto: EXECUTE ... USING se planifica con los valores reales, así
  -- "titulo ilike" usa catalog_items_titulo_trgm_idx y "ean = any" la unique
  -- (ean, store_scope).
  return query execute
    $q$
    with cand as (
      select o.id as offer_id, o.item_id, o.store_key, o.precio, o.precio_lista,
             o.disponible, o.updated_at as o_upd
        from catalog_items i
        join catalog_offers o on o.item_id = i.id
       where (i.titulo ilike $2 or i.ean = any ($3))
         and o.store_key = any ($1)
         and o.vendedor_key = ''
    ), picked as (
      select distinct on (case when $6 then c.item_id else c.offer_id end) c.*
        from cand c
       order by case when $6 then c.item_id else c.offer_id end,
                c.disponible desc, c.o_upd desc, c.offer_id desc
    )
    select p.offer_id, p.store_key, i.ean, i.titulo, p.precio, p.precio_lista, i.marca,
           i.categoria_path, i.foto_url, p.disponible, i.descripcion,
           catalog_item_attributes(i.atributos, i.medidas)
      from picked p
      join catalog_items i on i.id = p.item_id
     order by p.disponible desc, i.titulo, p.offer_id
     limit $4 offset $5
    $q$
    using v_stores, v_like, v_eans, v_limit, v_offset, v_dedupe;
end;
$function$;

revoke all on function public.catalog_search(uuid, text, integer, integer) from public, anon;
grant execute on function public.catalog_search(uuid, text, integer, integer) to authenticated;
