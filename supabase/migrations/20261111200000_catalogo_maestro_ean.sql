-- =============================================================================
-- 20261111200000_catalogo_maestro_ean  (ADR-109)
--
-- Tiendita: el catálogo precargado pasa de "una fila por (tienda, EAN)"
-- (catalog_products, ~350k filas que repiten la misma ficha en cada tienda) a:
--
--   catalog_items   producto maestro: UNA fila por producto (EAN canónico, o
--                   código propio de una tienda) con la ficha fusionada de
--                   todas las tiendas (la fusión la hace el scraper, feed
--                   /api/feed/catalog; ver ADR-109).
--   catalog_offers  ofertas livianas: una por (tienda, producto, vendedor) con
--                   precio, precio de lista, disponible, URL y fechas. Incluye
--                   a TODOS los vendedores (la publicación de la tienda es
--                   vendedor_key = '').
--
-- Compatibilidad (nada se corta):
--   * catalog_offers.id conserva el id de catalog_products en el backfill: el
--     catalog_product_id que devuelve catalog_search, que recibe
--     import_catalog_product y que quedó guardado en products.metadata sigue
--     apuntando a lo mismo (la publicación de esa tienda).
--   * Mismas firmas y columnas de catalog_search, catalog_product_count,
--     catalog_recount_products, notify_catalog_update, import_catalog_product,
--     add_catalog_product_to_tenant y de las RPC de la sync de ADR-107
--     (catalog_sync_upsert_products / catalog_sync_finish_store reescritas
--     sobre el modelo nuevo: la Edge vieja y el import por Excel siguen
--     funcionando). catalog_price_reference conserva (ean, reference_price,
--     store_count) y suma columnas (mínimo, máximo, vendedores, dónde).
--   * Entitlement igual: un negocio ve un producto si tiene una publicación de
--     tienda (vendedor_key = '') en alguna tienda de un catálogo activo que
--     compró o recibió. Staff interno: sólo en el panel interno
--     ((select internal_scope())).
--   * catalog_products queda CONGELADA (sin lectores ni escritores; un trigger
--     rechaza escrituras). Limpieza en una migración futura (ADR-109).
--
-- Nuevo:
--   * catalog_normalize_gtin(): misma regla que el scraper (src/ean.js).
--   * catalog_sync_upsert_catalog(): upsert batcheado del feed maestro.
--   * catalog_price_compare(ean): todas las ofertas visibles de un producto
--     ordenadas por precio (comparación de mercado).
--   * catalog_dedupe_stats(): productos únicos vs ofertas por tienda (panel).
--   * catalog_item_attributes(): atributos ordenados (medidas primero) para
--     el import.
--   * import_catalog_product: precio de venta SIEMPRE 0 salvo que el negocio
--     lo cargue (nunca el de una tienda), todas las fotos, medidas a bultos.
--
-- NO aplicada en ningún entorno al commitear.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Helpers de código de barras (misma regla que scrapping-productos/src/ean.js)
-- -----------------------------------------------------------------------------
create or replace function public.catalog_normalize_gtin(p text)
returns text
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare
  d text := btrim(coalesce(p, ''));
  g text;
  n int;
  s int := 0;
  i int;
begin
  if d !~ '^[0-9]+$' then
    return null;
  end if;
  n := length(d);
  if n = 8 then
    g := d;
  elsif n between 11 and 14 then
    g := lpad(d, 14, '0');
  else
    return null;
  end if;
  for i in 1 .. length(g) - 1 loop
    s := s + substr(g, length(g) - i, 1)::int * case when i % 2 = 1 then 3 else 1 end;
  end loop;
  if (10 - s % 10) % 10 <> substr(g, length(g), 1)::int then
    return null;
  end if;
  if n = 8 then
    return d;
  end if;
  return case when left(g, 1) = '0' then substr(g, 2) else g end;
end;
$function$;

-- Ámbito del producto: '' = EAN global (se fusiona entre tiendas); si no, la
-- tienda (código inválido o de circulación restringida, prefijo 2 en EAN-13).
create or replace function public.catalog_item_scope(p_store text, p_raw text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select case
    when catalog_normalize_gtin(p_raw) is not null
     and not (length(catalog_normalize_gtin(p_raw)) = 13 and left(catalog_normalize_gtin(p_raw), 1) = '2')
      then ''
    else upper(btrim(coalesce(p_store, '')))
  end;
$function$;

-- Código del producto: el GTIN canónico si es válido; si no, el código tal cual.
create or replace function public.catalog_item_ean(p_raw text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(catalog_normalize_gtin(p_raw), btrim(coalesce(p_raw, '')));
$function$;

-- Confiabilidad de la ficha por tienda (igual que STORE_RANK del scraper).
create or replace function public.catalog_store_rank(p_store text)
returns int
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(array_position(array[
    'JUMBO','CARREFOUR','DIA','COTO','EASY','FRAVEGA','MEGATONE',
    'PROVINCIA','BNA','CIUDAD','GALICIA','MACRO','BANCOR'], upper(p_store)), 99);
$function$;

-- -----------------------------------------------------------------------------
-- 1) catalog_items (producto maestro)
-- -----------------------------------------------------------------------------
create table if not exists public.catalog_items (
  id              bigint generated always as identity primary key,
  ean             text not null,
  store_scope     text not null default '',
  titulo          text not null,
  descripcion     text,
  marca           text,
  categoria_path  text,
  atributos       jsonb,
  medidas         jsonb,
  foto_url        text,
  fotos           jsonb,
  fuentes         jsonb,
  feed_updated_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint catalog_items_ean_scope_key unique (ean, store_scope)
);

comment on table public.catalog_items is
  'Producto maestro del catálogo Tiendita (ADR-109): una fila por EAN canónico '
  '(store_scope = '''') o por código propio de una tienda (store_scope = tienda). '
  'Ficha fusionada de todas las tiendas. Global: sin tenant_id; visibilidad por '
  'catálogo (catalog_offers + catalog_store_map + tenant_catalog_purchases).';
comment on column public.catalog_items.medidas is
  'Medidas fusionadas: alto_cm, ancho_cm, profundidad_cm, medidas, peso_kg, '
  'bultos, bultos_detalle [{dims, peso}], contenido {valor, unidad ml|g}, '
  'unidades_pack, fuentes {campo: tienda}.';

create index if not exists catalog_items_titulo_trgm_idx
  on public.catalog_items using gin (titulo gin_trgm_ops);

drop trigger if exists trg_catalog_items_updated on public.catalog_items;
create trigger trg_catalog_items_updated before update on public.catalog_items
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- 2) catalog_offers (ofertas por tienda y vendedor)
-- -----------------------------------------------------------------------------
create table if not exists public.catalog_offers (
  id            bigint generated by default as identity primary key,
  item_id       bigint not null references public.catalog_items(id) on delete cascade,
  store_key     text not null references public.catalog_stores(key) on delete cascade,
  vendedor_key  text not null default '',
  vendedor      text,
  ean_origen    text not null,
  id_origen     text,
  precio        numeric(12,2),
  precio_lista  numeric(12,2),
  disponible    boolean not null default true,
  estado        text,
  url           text,
  first_seen_at timestamptz,
  last_seen_at  timestamptz,
  feed_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint catalog_offers_store_item_seller_key unique (store_key, item_id, vendedor_key)
);

comment on table public.catalog_offers is
  'Ofertas del catálogo Tiendita (ADR-109): una por (tienda, producto, vendedor). '
  'vendedor_key = '''' es la publicación de la propia tienda (define la visibilidad '
  'en la tiendita); el resto son otros vendedores (sólo comparación de precios). '
  'id conserva el de catalog_products para lo migrado (catalog_product_id).';

-- Producto → sus ofertas (búsqueda, precio de referencia, comparación). La
-- unique (store_key, item_id, vendedor_key) cubre los usos por tienda.
create index if not exists catalog_offers_item_idx
  on public.catalog_offers (item_id, store_key);

drop trigger if exists trg_catalog_offers_updated on public.catalog_offers;
-- updated_at lo maneja el upsert (sólo cuando cambia un dato, no el visto).

-- -----------------------------------------------------------------------------
-- 3) RLS: lectura por entitlement; sin escritura por REST (sólo service_role)
-- -----------------------------------------------------------------------------
alter table public.catalog_items enable row level security;
alter table public.catalog_offers enable row level security;

drop policy if exists catalog_items_read on public.catalog_items;
create policy catalog_items_read on public.catalog_items
  for select to authenticated
  using (
    (select internal_scope())
    or exists (
      select 1
        from catalog_offers o
        join catalog_store_map csm on csm.store_key = o.store_key
        join tenant_catalog_purchases tcp on tcp.catalog_id = csm.catalog_id
        join catalogs c on c.id = tcp.catalog_id
       where o.item_id = catalog_items.id
         and o.vendedor_key = ''
         and tcp.tenant_id = (select current_tenant_id())
         and c.is_active
    )
  );

drop policy if exists catalog_offers_read on public.catalog_offers;
create policy catalog_offers_read on public.catalog_offers
  for select to authenticated
  using (
    (select internal_scope())
    or exists (
      select 1
        from catalog_store_map csm
        join tenant_catalog_purchases tcp on tcp.catalog_id = csm.catalog_id
        join catalogs c on c.id = tcp.catalog_id
       where csm.store_key = catalog_offers.store_key
         and tcp.tenant_id = (select current_tenant_id())
         and c.is_active
    )
  );

revoke all on table public.catalog_items, public.catalog_offers from anon;
revoke insert, update, delete, truncate on table public.catalog_items, public.catalog_offers from authenticated;
grant select on table public.catalog_items, public.catalog_offers to authenticated;
grant all on table public.catalog_items, public.catalog_offers to service_role;

-- -----------------------------------------------------------------------------
-- 4) catalog_sync_runs: estado del feed maestro y totales de ofertas
-- -----------------------------------------------------------------------------
alter table public.catalog_sync_runs add column if not exists feed jsonb;
alter table public.catalog_sync_runs add column if not exists ofertas_nuevas integer not null default 0;
alter table public.catalog_sync_runs add column if not exists ofertas_actualizadas integer not null default 0;

comment on column public.catalog_sync_runs.feed is
  'ADR-109: estado de la lectura de /api/feed/catalog { since, full, cursor, done, '
  'pages, errores, error }. stores queda con el resultado por tienda (ofertas).';
comment on column public.catalog_sync_runs.nuevos is
  'Desde ADR-109: productos únicos nuevos (catalog_items). Antes: filas por tienda.';

-- -----------------------------------------------------------------------------
-- 5) Backfill desde catalog_products (versión SQL simplificada de las reglas
--    de fusión; la primera corrida completa del feed maestro las reemplaza
--    por la fusión completa del scraper).
-- -----------------------------------------------------------------------------
create temporary table _cp on commit drop as
select cp.id, cp.store_key, btrim(cp.ean) as ean_origen,
       catalog_item_ean(cp.ean) as ean, catalog_item_scope(cp.store_key, cp.ean) as scope,
       btrim(cp.titulo) as titulo, nullif(btrim(cp.descripcion), '') as descripcion,
       nullif(btrim(cp.marca), '') as marca, nullif(btrim(cp.categoria_path), '') as categoria_path,
       nullif(btrim(cp.foto_url), '') as foto_url,
       case when cp.atributos is null then null else normalize_product_attributes(cp.atributos) end as atributos,
       cp.precio, cp.precio_lista, cp.disponible, cp.estado, nullif(btrim(cp.id_origen), '') as id_origen,
       cp.feed_seen_at, cp.updated_at,
       catalog_store_rank(cp.store_key) as rnk
  from catalog_products cp
 where nullif(btrim(cp.ean), '') is not null
   and nullif(btrim(cp.titulo), '') is not null;

create index on _cp (ean, scope);

with t as (
  select x.*,
         count(*) over (partition by x.ean, x.scope, lower(x.titulo)) as tfreq,
         count(*) over (partition by x.ean, x.scope, lower(coalesce(x.marca, ''))) as mfreq
    from _cp x
), title as (
  select distinct on (ean, scope) ean, scope, titulo, store_key
    from t
   order by ean, scope, tfreq desc, (titulo = upper(titulo)), length(titulo) desc, rnk, id
), descr as (
  select distinct on (ean, scope) ean, scope, descripcion, store_key
    from t
   where length(descripcion) >= 20 and lower(descripcion) <> lower(titulo)
   order by ean, scope, length(descripcion) desc, rnk, id
), brand as (
  select distinct on (ean, scope) ean, scope, marca, store_key
    from t
   where marca is not null
   order by ean, scope, mfreq desc, (marca = upper(marca) and length(marca) > 4), rnk, id
), cat as (
  select distinct on (ean, scope) ean, scope, categoria_path, store_key
    from t
   where categoria_path is not null
   order by ean, scope, array_length(string_to_array(categoria_path, '>'), 1) desc, rnk, id
), attrs as (
  select distinct on (ean, scope) ean, scope, atributos
    from t
   where jsonb_array_length(coalesce(atributos, '[]'::jsonb)) > 0
   order by ean, scope, jsonb_array_length(atributos) desc, rnk, id
), photo as (
  select distinct on (ean, scope) ean, scope, foto_url
    from t
   where foto_url is not null
   order by ean, scope, (foto_url ilike '%firebasestorage%') desc, rnk, id
)
insert into catalog_items (ean, store_scope, titulo, descripcion, marca, categoria_path, atributos,
                           foto_url, fotos, fuentes)
select ti.ean, ti.scope, left(ti.titulo, 160), d.descripcion, b.marca, c.categoria_path, a.atributos,
       p.foto_url,
       case when p.foto_url is not null then jsonb_build_array(p.foto_url) end,
       jsonb_strip_nulls(jsonb_build_object(
         'titulo', ti.store_key, 'descripcion', d.store_key, 'marca', b.store_key,
         'categoria', c.store_key, 'origen', 'backfill_catalog_products'))
  from title ti
  left join descr d using (ean, scope)
  left join brand b using (ean, scope)
  left join cat c using (ean, scope)
  left join attrs a using (ean, scope)
  left join photo p using (ean, scope)
on conflict (ean, store_scope) do nothing;

-- Ofertas: conservan el id de catalog_products. Si dos códigos de una misma
-- tienda caen en el mismo producto (p. ej. "41331014915" y "041331014915"),
-- queda la publicación disponible y más barata.
insert into catalog_offers (id, item_id, store_key, vendedor_key, ean_origen, id_origen, precio,
                            precio_lista, disponible, estado, feed_seen_at, created_at, updated_at)
select distinct on (x.store_key, i.id)
       x.id, i.id, x.store_key, '', x.ean_origen, x.id_origen, x.precio, x.precio_lista,
       x.disponible, x.estado, x.feed_seen_at, x.updated_at, x.updated_at
  from _cp x
  join catalog_items i on i.ean = x.ean and i.store_scope = x.scope
 order by x.store_key, i.id, x.disponible desc, coalesce(nullif(x.precio, 0), 1e15), x.id
on conflict do nothing;

-- Las ofertas nuevas nunca reusan un id viejo de catalog_products.
select setval(
  pg_get_serial_sequence('public.catalog_offers', 'id'),
  greatest(coalesce((select max(id) from catalog_offers), 0),
           coalesce((select max(id) from catalog_products), 0)) + 1,
  false);

-- Estadísticas al día: sin esto el planner no sabe que hay ~300k filas y no
-- elige el índice trigram en la primera búsqueda.
analyze public.catalog_items;
analyze public.catalog_offers;

-- -----------------------------------------------------------------------------
-- 6) catalog_products congelada: nadie la lee ni la escribe desde acá.
-- -----------------------------------------------------------------------------
comment on table public.catalog_products is
  'CONGELADA (ADR-109): reemplazada por catalog_items + catalog_offers. Sin lectores '
  'ni escritores; se conserva como respaldo del backfill hasta la migración de limpieza.';

create or replace function public.trg_catalog_products_frozen()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  raise exception 'catalog_products_frozen: usar catalog_items / catalog_offers (ADR-109)';
end;
$function$;
revoke execute on function public.trg_catalog_products_frozen() from public, anon, authenticated;

drop trigger if exists trg_catalog_products_frozen on public.catalog_products;
create trigger trg_catalog_products_frozen
  before insert or update or delete on public.catalog_products
  for each statement execute function trg_catalog_products_frozen();

revoke insert, update, delete, truncate on table public.catalog_products from authenticated;
drop policy if exists catalog_products_insert on public.catalog_products;
drop policy if exists catalog_products_update on public.catalog_products;
drop policy if exists catalog_products_delete on public.catalog_products;

-- -----------------------------------------------------------------------------
-- 7) Atributos para el producto del negocio: medidas primero (Contenido,
--    Unidades por pack, Peso, Alto, Ancho, Profundidad), después los de la
--    ficha en su orden, sin claves repetidas (sin tildes ni mayúsculas) y con
--    unidades consistentes (ml/g, kg, cm; coma decimal).
-- -----------------------------------------------------------------------------
-- 1500 → "1500"; 0.42 → "0,42"; 59.50 → "59,5"
create or replace function public.catalog_fmt_num(p numeric)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select case when p is null then null
    else replace(case when round(p, 3) = trunc(p) then trunc(p)::text
                      else rtrim(rtrim(round(p, 3)::text, '0'), '.') end, '.', ',') end;
$function$;

create or replace function public.catalog_item_attributes(p_atributos jsonb, p_medidas jsonb)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  with num as (
    select nullif(m #>> '{contenido,valor}', '')::numeric as cont,
           m #>> '{contenido,unidad}' as cont_u,
           nullif(m ->> 'unidades_pack', '')::numeric as pack,
           nullif(m ->> 'peso_kg', '')::numeric as peso,
           nullif(m ->> 'alto_cm', '')::numeric as alto,
           nullif(m ->> 'ancho_cm', '')::numeric as ancho,
           nullif(m ->> 'profundidad_cm', '')::numeric as prof
      from (select case when jsonb_typeof(p_medidas) = 'object' then p_medidas else '{}'::jsonb end as m) s
  ), measures as (
    select x.k, x.v, x.ord
      from num,
      lateral (values
        (1, 'Contenido', case
           when cont is null or cont <= 0 or cont_u not in ('ml', 'g') then null
           when cont_u = 'ml' and cont >= 1000 then catalog_fmt_num(cont / 1000) || ' l'
           when cont_u = 'g' and cont >= 1000 then catalog_fmt_num(cont / 1000) || ' kg'
           else catalog_fmt_num(cont) || ' ' || cont_u end),
        (2, 'Unidades por pack', case when pack > 1 then trunc(pack)::text end),
        (3, 'Peso', case when peso > 0 then catalog_fmt_num(peso) || ' kg' end),
        (4, 'Alto', case when alto > 0 then catalog_fmt_num(alto) || ' cm' end),
        (5, 'Ancho', case when ancho > 0 then catalog_fmt_num(ancho) || ' cm' end),
        (6, 'Profundidad', case when prof > 0 then catalog_fmt_num(prof) || ' cm' end)
      ) as x(ord, k, v)
     where x.v is not null
  ), base as (
    select e ->> 'key' as k, e ->> 'value' as v, (100 + o)::int as ord
      from jsonb_array_elements(normalize_product_attributes(coalesce(p_atributos, '[]'::jsonb)))
           with ordinality as t(e, o)
  ), allrows as (
    select k, v, ord,
           lower(translate(btrim(k), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')) as nk
      from (select k, v, ord from measures union all select k, v, ord from base) u
  ), dedup as (
    select distinct on (nk) k, v, ord from allrows order by nk, ord
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'value', v) order by ord), '[]'::jsonb)
    from dedup;
$function$;

-- -----------------------------------------------------------------------------
-- 8) Lectores reescritos sobre el modelo nuevo (mismas firmas)
-- -----------------------------------------------------------------------------

-- Tiendas de un catálogo (helper interno de las funciones de abajo).
create or replace function public.catalog_store_keys(p_catalog_id uuid)
returns text[]
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(array_agg(csm.store_key), '{}'::text[])
    from catalog_store_map csm
   where csm.catalog_id = p_catalog_id;
$function$;
revoke all on function public.catalog_store_keys(uuid) from public, anon;
grant execute on function public.catalog_store_keys(uuid) to authenticated, service_role;

-- Conteo del catálogo: productos únicos (dedupe_by_ean) o publicaciones de
-- tienda (sin dedupe). Los otros vendedores no suman: son comparación.
create or replace function public.catalog_count_internal(p_catalog_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_stores text[];
  v_total bigint;
begin
  select c.dedupe_by_ean into v_dedupe from catalogs c where c.id = p_catalog_id;
  if v_dedupe is null then
    return 0;
  end if;
  v_stores := catalog_store_keys(p_catalog_id);
  if v_dedupe then
    select count(distinct o.item_id) into v_total
      from catalog_offers o
     where o.store_key = any (v_stores) and o.vendedor_key = '';
  else
    select count(*) into v_total
      from catalog_offers o
     where o.store_key = any (v_stores) and o.vendedor_key = '';
  end if;
  return coalesce(v_total, 0);
end;
$function$;
revoke all on function public.catalog_count_internal(uuid) from public, anon, authenticated;
grant execute on function public.catalog_count_internal(uuid) to service_role;

create or replace function public.catalog_product_count(p_catalog_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_internal() and not exists (
    select 1
      from tenant_catalog_purchases p
      join catalog_store_map m on m.catalog_id = p.catalog_id
     where p.tenant_id = current_tenant_id()
       and p.catalog_id = p_catalog_id
  ) then
    raise exception 'forbidden';
  end if;
  return catalog_count_internal(p_catalog_id);
end;
$function$;
revoke all on function public.catalog_product_count(uuid) from public, anon;
grant execute on function public.catalog_product_count(uuid) to authenticated;

create or replace function public.catalog_recount_products(p_catalog_id uuid)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_total bigint;
begin
  if auth.uid() is not null and not is_internal() then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from catalogs where id = p_catalog_id) then
    return 0;
  end if;
  v_total := catalog_count_internal(p_catalog_id);
  update catalogs set product_count = v_total where id = p_catalog_id;
  return v_total;
end;
$function$;
revoke all on function public.catalog_recount_products(uuid) from public, anon;
grant execute on function public.catalog_recount_products(uuid) to authenticated, service_role;

create or replace function public.notify_catalog_update(p_catalog_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_name text;
  v_total bigint;
  r record;
  v_delta bigint;
  v_count integer := 0;
begin
  if auth.uid() is not null and not is_internal() then
    raise exception 'forbidden';
  end if;

  select c.name into v_name from catalogs c where c.id = p_catalog_id;
  if v_name is null then
    raise exception 'catalog_not_found';
  end if;

  v_total := catalog_count_internal(p_catalog_id);

  update catalogs set product_count = v_total where id = p_catalog_id;

  for r in
    select tcp.id, tcp.tenant_id, tcp.last_notified_product_count
      from tenant_catalog_purchases tcp
      join tenants t on t.id = tcp.tenant_id
     where tcp.catalog_id = p_catalog_id
       and t.deleted_at is null
  loop
    v_delta := v_total - r.last_notified_product_count;
    if v_delta > 0 and r.last_notified_product_count > 0 then
      insert into notifications (
        target_tenant_id, target_role, type, severity, title, body, created_by
      )
      values (
        r.tenant_id, 'owner', 'news', 'info',
        'Tu catálogo "' || v_name || '" se actualizó',
        'Se sumaron ' || v_delta::text || ' productos nuevos al catálogo "'
          || v_name || '". Ya podés buscarlos y agregarlos a tu tienda.',
        auth.uid()
      );
      v_count := v_count + 1;
    end if;
    update tenant_catalog_purchases
       set last_notified_product_count = v_total
     where id = r.id;
  end loop;

  return v_count;
end;
$function$;
revoke all on function public.notify_catalog_update(uuid) from public, anon;
grant execute on function public.notify_catalog_update(uuid) to authenticated, service_role;

-- catalog_search: mismas columnas. catalog_product_id = id de la publicación
-- de tienda (oferta) representativa; ficha (título, marca, categoría, foto,
-- descripción, atributos ordenados con medidas) del producto maestro; precio y
-- disponible de esa publicación. Con dedupe: una fila por producto (la
-- publicación disponible y más reciente). Sin dedupe: una por publicación de
-- tienda. Búsqueda por título (trigram en catalog_items) o EAN (crudo o
-- canónico).
create or replace function public.catalog_search(
  p_catalog_id uuid,
  p_query text default '',
  p_limit integer default 30,
  p_offset integer default 0
)
returns table (
  catalog_product_id bigint,
  store_key text,
  ean text,
  titulo text,
  precio numeric,
  precio_lista numeric,
  marca text,
  categoria_path text,
  foto_url text,
  disponible boolean,
  descripcion text,
  atributos jsonb
)
language plpgsql
stable
security definer
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

  -- Sin texto: los primeros productos del catálogo (como antes).
  if v_q = '' then
    return query
    with cand as (
      select o.id as offer_id, o.item_id, o.store_key, o.precio, o.precio_lista,
             o.disponible, o.updated_at as o_upd
        from catalog_offers o
       where o.store_key = any (v_stores)
         and o.vendedor_key = ''
    ), picked as (
      select distinct on (case when v_dedupe then c.item_id else c.offer_id end) c.*
        from cand c
       order by case when v_dedupe then c.item_id else c.offer_id end,
                c.disponible desc, c.o_upd desc, c.offer_id desc
    )
    select p.offer_id, p.store_key, i.ean, i.titulo, p.precio, p.precio_lista, i.marca,
           i.categoria_path, i.foto_url, p.disponible, i.descripcion,
           catalog_item_attributes(i.atributos, i.medidas)
      from picked p
      join catalog_items i on i.id = p.item_id
     order by p.disponible desc, i.titulo, p.offer_id
     limit v_limit offset v_offset;
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

-- -----------------------------------------------------------------------------
-- 9) Comparación de precios de mercado
--
-- Quién ve qué: staff interno en el panel interno ve todas las tiendas; un
-- negocio ve sólo las ofertas (de todos los vendedores) de las tiendas de los
-- catálogos activos que compró o recibió (el mismo entitlement de la
-- tiendita). Sólo precio, tienda, vendedor, disponible, URL y fecha: nunca la
-- ficha de un producto fuera de su catálogo.
-- -----------------------------------------------------------------------------
create or replace function public.catalog_allowed_stores()
returns text[]
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select case
    when (select internal_scope()) then
      (select coalesce(array_agg(cs.key), '{}'::text[]) from catalog_stores cs)
    else
      (select coalesce(array_agg(distinct csm.store_key), '{}'::text[])
         from tenant_catalog_purchases tcp
         join catalogs c on c.id = tcp.catalog_id
         join catalog_store_map csm on csm.catalog_id = tcp.catalog_id
        where tcp.tenant_id = (select current_tenant_id())
          and c.is_active)
  end;
$function$;
revoke all on function public.catalog_allowed_stores() from public, anon;
grant execute on function public.catalog_allowed_stores() to authenticated, service_role;

-- Cambia el tipo de retorno (columnas nuevas al final): drop + create en la
-- misma transacción. Las tres primeras columnas no cambian de significado:
-- reference_price = mediana de los precios positivos de las publicaciones de
-- tienda (si no hay, de todos los vendedores); store_count = cuántas
-- publicaciones de tienda la respaldan.
drop function if exists public.catalog_price_reference(text[]);
create function public.catalog_price_reference(p_eans text[])
returns table (
  ean text,
  reference_price numeric,
  store_count integer,
  min_price numeric,
  max_price numeric,
  offer_count integer,
  seller_count integer,
  min_store_key text,
  min_store_name text,
  min_seller text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with eans as (
    select distinct btrim(e) as e
      from unnest(coalesce(p_eans, array[]::text[])) as e
     where e is not null and btrim(e) <> ''
     limit 1000
  ), allowed as (
    select unnest(catalog_allowed_stores()) as store_key
  ), offs as (
    select en.e, o.store_key, o.vendedor_key, o.precio,
           cs.name as store_name, coalesce(o.vendedor, cs.name) as seller
      from eans en
      join catalog_items i on i.ean = catalog_item_ean(en.e)
      join catalog_offers o on o.item_id = i.id
      join allowed a on a.store_key = o.store_key
      join catalog_stores cs on cs.key = o.store_key
     where o.precio > 0
  )
  select f.e,
         round(coalesce(
           percentile_cont(0.5) within group (order by f.precio) filter (where f.vendedor_key = ''),
           percentile_cont(0.5) within group (order by f.precio))::numeric, 2),
         (count(*) filter (where f.vendedor_key = ''))::int,
         min(f.precio),
         max(f.precio),
         count(*)::int,
         count(distinct (f.store_key, f.vendedor_key))::int,
         (array_agg(f.store_key order by f.precio, f.store_key, f.vendedor_key))[1],
         (array_agg(f.store_name order by f.precio, f.store_key, f.vendedor_key))[1],
         (array_agg(f.seller order by f.precio, f.store_key, f.vendedor_key))[1]
    from offs f
   group by f.e;
$function$;
revoke all on function public.catalog_price_reference(text[]) from public, anon;
grant execute on function public.catalog_price_reference(text[]) to authenticated;

-- Todas las ofertas visibles de un producto, ordenadas por precio.
create or replace function public.catalog_price_compare(p_ean text)
returns table (
  store_key text,
  store_name text,
  store_logo text,
  vendedor text,
  principal boolean,
  precio numeric,
  precio_lista numeric,
  disponible boolean,
  url text,
  last_seen_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select o.store_key, cs.name, cs.logo_url, coalesce(o.vendedor, cs.name), o.vendedor_key = '',
         o.precio, o.precio_lista, o.disponible, o.url,
         coalesce(o.last_seen_at, o.feed_seen_at), o.updated_at
    from catalog_items i
    join catalog_offers o on o.item_id = i.id
    join catalog_stores cs on cs.key = o.store_key
   where nullif(btrim(p_ean), '') is not null
     and i.ean = catalog_item_ean(p_ean)
     and o.store_key = any (catalog_allowed_stores())
   order by o.precio is null, o.precio, o.disponible desc, cs.name, o.vendedor_key
   limit 200;
$function$;
revoke all on function public.catalog_price_compare(text) from public, anon;
grant execute on function public.catalog_price_compare(text) to authenticated;

-- Panel interno: productos únicos vs ofertas por tienda y ahorro.
create or replace function public.catalog_dedupe_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v jsonb;
begin
  if not (select internal_scope()) then
    raise exception 'forbidden';
  end if;
  select jsonb_build_object(
    'items', (select count(*) from catalog_items),
    'items_globales', (select count(*) from catalog_items where store_scope = ''),
    'items_por_tienda', (select count(*) from catalog_items where store_scope <> ''),
    'items_con_varias_tiendas', (select count(*) from (
        select item_id from catalog_offers where vendedor_key = ''
         group by item_id having count(*) > 1) m),
    'ofertas', (select count(*) from catalog_offers),
    'ofertas_tienda', (select count(*) from catalog_offers where vendedor_key = ''),
    'ofertas_vendedores', (select count(*) from catalog_offers where vendedor_key <> ''),
    'tiendas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', s.key, 'name', s.name,
               'ofertas_tienda', coalesce(o.tienda, 0),
               'ofertas_vendedores', coalesce(o.vendedores, 0),
               'disponibles', coalesce(o.disponibles, 0),
               'en_catalogo', exists (select 1 from catalog_store_map m where m.store_key = s.key))
             order by s.name)
        from catalog_stores s
        left join (
          select store_key,
                 count(*) filter (where vendedor_key = '') as tienda,
                 count(*) filter (where vendedor_key <> '') as vendedores,
                 count(*) filter (where disponible) as disponibles
            from catalog_offers group by store_key) o on o.store_key = s.key), '[]'::jsonb)
  ) into v;
  return v;
end;
$function$;
revoke all on function public.catalog_dedupe_stats() from public, anon;
grant execute on function public.catalog_dedupe_stats() to authenticated;

-- -----------------------------------------------------------------------------
-- 10) import_catalog_product: lo máximo del producto maestro, sin precio.
--
-- Cambios contra 20261011210000 (misma firma y mismo retorno):
--   * p_catalog_product_id es el id de la oferta (= id viejo de
--     catalog_products para lo migrado). La ficha sale del producto maestro.
--   * Precio de venta: el que cargue el negocio (override `price`); si no, 0.
--     NUNCA el precio de una tienda (antes copiaba el de la publicación).
--   * Código de barras: el EAN canónico; la idempotencia también reconoce las
--     variantes (sin ceros a la izquierda, el código de la tienda).
--   * Atributos: catalog_item_attributes (medidas primero, sin repetidos).
--   * Medidas: a product_packages (feature BASE medidas_bultos): un bulto por
--     cada uno del detalle; si no hay detalle, las medidas y el peso del
--     producto como bulto único. Override keep_measures = false las omite.
--   * Fotos: todas las del maestro (hasta 3) a la galería, la primera
--     principal; la Edge tiendita_copy_image las copia al bucket del negocio.
-- -----------------------------------------------------------------------------
create or replace function public.import_catalog_product(
  p_catalog_id uuid,
  p_catalog_product_id bigint,
  p_overrides jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant uuid := current_tenant_id();
  v_o jsonb := coalesce(p_overrides, '{}'::jsonb);
  v_off catalog_offers%rowtype;
  v_item catalog_items%rowtype;
  v_allowed boolean;
  v_cat_id uuid;
  v_parent uuid;
  v_brand_id uuid;
  v_brand text;
  v_existing uuid;
  v_node jsonb;
  v_node_id uuid;
  v_seg text;
  v_i int;
  v_product_id uuid;
  v_name text;
  v_barcode text;
  v_variants text[];
  v_price numeric;
  v_cost numeric;
  v_stock numeric;
  v_track boolean;
  v_attrs jsonb;
  v_keep_image boolean;
  v_images text[];
  v_image text;
  v_nodes jsonb;
  v_m jsonb;
  v_b jsonb;
  v_packages int := 0;
  v_dims jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  if not is_internal() and not exists (
    select 1 from tenant_users me
     where me.tenant_id = v_tenant
       and me.user_id = auth.uid()
       and me.status = 'active'
       and me.role in ('owner', 'manager')
  ) then
    raise exception 'forbidden';
  end if;

  select * into v_off from catalog_offers where id = p_catalog_product_id;
  if not found then
    raise exception 'catalog_product_not_found';
  end if;
  select * into v_item from catalog_items where id = v_off.item_id;

  select exists (
    select 1
      from tenant_catalog_purchases tcp
      join catalog_store_map csm on csm.catalog_id = tcp.catalog_id
      join catalogs c on c.id = tcp.catalog_id
     where tcp.tenant_id = v_tenant
       and tcp.catalog_id = p_catalog_id
       and csm.store_key = v_off.store_key
       and c.is_active
  ) into v_allowed;
  if not v_allowed then
    raise exception 'catalog_not_owned';
  end if;

  v_barcode := nullif(btrim(coalesce(v_o ->> 'barcode', v_item.ean)), '');

  -- Idempotencia por código de barras (y sus variantes del catálogo).
  if v_barcode is not null then
    v_variants := array[v_barcode];
    if not (v_o ? 'barcode') then
      v_variants := v_variants || array[ltrim(v_item.ean, '0'), v_off.ean_origen,
                                        catalog_normalize_gtin(v_off.ean_origen)];
    end if;
    select id into v_existing
      from products
     where tenant_id = v_tenant
       and barcode = any (array_remove(v_variants, null))
       and deleted_at is null
     limit 1;
    if v_existing is not null then
      return jsonb_build_object('product_id', v_existing, 'existing', true, 'image_pending', false);
    end if;
  end if;

  -- Árbol de categorías (igual que antes, desde la categoría del maestro).
  v_parent := null;
  v_cat_id := null;
  if v_o ? 'category_path' and jsonb_typeof(v_o -> 'category_path') = 'array' then
    v_nodes := v_o -> 'category_path';
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', null, 'name', btrim(s))), '[]'::jsonb)
      into v_nodes
      from unnest(string_to_array(coalesce(v_item.categoria_path, ''), '>')) s
     where btrim(s) <> '';
  end if;

  v_i := 0;
  for v_node in select * from jsonb_array_elements(v_nodes) loop
    v_i := v_i + 1;
    if v_i > 10 then exit; end if;
    v_seg := left(btrim(coalesce(v_node ->> 'name', '')), 80);
    v_node_id := null;

    if coalesce(v_node ->> 'id', '') ~ '^[0-9a-fA-F-]{36}$' then
      select id into v_node_id
        from categories
       where id = (v_node ->> 'id')::uuid
         and tenant_id = v_tenant
         and deleted_at is null
         and coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce(v_parent, '00000000-0000-0000-0000-000000000000'::uuid);
    end if;

    if v_node_id is null then
      if v_seg = '' then continue; end if;
      select id into v_node_id
        from categories
       where tenant_id = v_tenant
         and lower(name) = lower(v_seg)
         and coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce(v_parent, '00000000-0000-0000-0000-000000000000'::uuid)
         and deleted_at is null
       limit 1;
    end if;

    if v_node_id is null then
      insert into categories (tenant_id, parent_id, name)
      values (v_tenant, v_parent, v_seg)
      returning id into v_node_id;
    end if;

    v_cat_id := v_node_id;
    v_parent := v_node_id;
  end loop;

  -- Marca.
  v_brand := nullif(btrim(coalesce(v_o ->> 'brand', v_item.marca, '')), '');
  v_brand_id := null;
  if v_brand is not null then
    select id into v_brand_id
      from brands
     where tenant_id = v_tenant
       and lower(name) = lower(v_brand)
       and deleted_at is null
     limit 1;
    if v_brand_id is null then
      insert into brands (tenant_id, name)
      values (v_tenant, v_brand)
      returning id into v_brand_id;
    end if;
  end if;

  v_name := left(nullif(btrim(coalesce(v_o ->> 'name', v_item.titulo)), ''), 120);
  if v_name is null then
    v_name := left(v_item.titulo, 120);
  end if;
  -- Precio: sólo el del negocio. Nunca el de una tienda.
  v_price := greatest(coalesce(nullif(v_o ->> 'price', '')::numeric, 0), 0);
  v_cost := nullif(v_o ->> 'cost', '')::numeric;
  if v_cost is not null and v_cost < 0 then v_cost := null; end if;
  v_stock := greatest(coalesce(nullif(v_o ->> 'stock', '')::numeric, 0), 0);
  v_track := coalesce((v_o ->> 'track_stock')::boolean, v_stock > 0);
  v_attrs := normalize_product_attributes(
    case when v_o ? 'attributes' then v_o -> 'attributes'
         else catalog_item_attributes(v_item.atributos, v_item.medidas) end
  );
  v_keep_image := coalesce((v_o ->> 'keep_image')::boolean, true);
  v_images := '{}';
  if v_keep_image then
    select coalesce(array_agg(d.u order by d.o), '{}'::text[]) into v_images
      from (
        select distinct on (x.u) x.u, x.o
          from (
            select btrim(v_item.foto_url) as u, 0::bigint as o
            union all
            select btrim(t.f), t.n
              from jsonb_array_elements_text(
                     case when jsonb_typeof(v_item.fotos) = 'array' then v_item.fotos else '[]'::jsonb end
                   ) with ordinality as t(f, n)
          ) x
         where coalesce(x.u, '') <> ''
         order by x.u, x.o
      ) d;
    v_images := v_images[1:3];
  end if;
  v_image := v_images[1];

  insert into products (
    tenant_id, category_id, brand_id, name, model, description, barcode, sku,
    price, cost, image_url, track_stock, stock, is_active, attributes, metadata
  )
  values (
    v_tenant, v_cat_id, v_brand_id, v_name,
    nullif(btrim(coalesce(v_o ->> 'model', '')), ''),
    nullif(btrim(coalesce(v_o ->> 'description', v_item.descripcion, '')), ''),
    v_barcode,
    nullif(btrim(coalesce(v_o ->> 'sku', '')), ''),
    v_price, v_cost, v_image, v_track, case when v_track then v_stock else 0 end,
    true, v_attrs,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'tiendita',
      'catalog_id', p_catalog_id,
      'catalog_store', v_off.store_key,
      'catalog_product_id', v_off.id,
      'catalog_item_id', v_item.id
    ))
  )
  returning id into v_product_id;

  -- Fotos: filas externas en la galería (path '' = pendiente de copia).
  for v_i in 1 .. coalesce(array_length(v_images, 1), 0) loop
    insert into product_images (tenant_id, product_id, path, url, sort, is_primary)
    values (v_tenant, v_product_id, '', v_images[v_i], v_i - 1, v_i = 1);
  end loop;

  -- Medidas a bultos (feature BASE medidas_bultos; si el plan la apagó, no).
  v_m := case when jsonb_typeof(v_item.medidas) = 'object' then v_item.medidas else '{}'::jsonb end;
  if coalesce((v_o ->> 'keep_measures')::boolean, true)
     and v_m <> '{}'::jsonb
     and tenant_has_feature_for(v_tenant, 'medidas_bultos') then
    if jsonb_typeof(v_m -> 'bultos_detalle') = 'array' and jsonb_array_length(v_m -> 'bultos_detalle') > 0 then
      for v_b in select * from jsonb_array_elements(v_m -> 'bultos_detalle') loop
        exit when v_packages >= 10;
        v_dims := case when jsonb_typeof(v_b -> 'dims') = 'array' then v_b -> 'dims' else '[]'::jsonb end;
        v_packages := v_packages + 1;
        insert into product_packages (tenant_id, product_id, idx, units_per_pack, pack_count,
                                      weight_kg, height_cm, width_cm, depth_cm)
        values (v_tenant, v_product_id, v_packages, 1, 1,
                nullif(greatest(coalesce(nullif(v_b ->> 'peso', '')::numeric, 0), 0), 0),
                nullif(greatest(coalesce(nullif(v_dims ->> 2, '')::numeric, 0), 0), 0),
                nullif(greatest(coalesce(nullif(v_dims ->> 1, '')::numeric, 0), 0), 0),
                nullif(greatest(coalesce(nullif(v_dims ->> 0, '')::numeric, 0), 0), 0));
      end loop;
    elsif coalesce(v_m ->> 'alto_cm', v_m ->> 'ancho_cm', v_m ->> 'profundidad_cm', v_m ->> 'peso_kg') is not null then
      v_packages := 1;
      insert into product_packages (tenant_id, product_id, idx, units_per_pack, pack_count,
                                    weight_kg, height_cm, width_cm, depth_cm)
      values (v_tenant, v_product_id, 1,
              greatest(coalesce(nullif(v_m ->> 'unidades_pack', '')::numeric, 1), 1), 1,
              nullif(greatest(coalesce(nullif(v_m ->> 'peso_kg', '')::numeric, 0), 0), 0),
              nullif(greatest(coalesce(nullif(v_m ->> 'alto_cm', '')::numeric, 0), 0), 0),
              nullif(greatest(coalesce(nullif(v_m ->> 'ancho_cm', '')::numeric, 0), 0), 0),
              nullif(greatest(coalesce(nullif(v_m ->> 'profundidad_cm', '')::numeric, 0), 0), 0));
    end if;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'products', v_product_id, 'catalog_product_imported',
          jsonb_build_object('catalog_id', p_catalog_id, 'catalog_product_id', v_off.id,
                             'catalog_item_id', v_item.id, 'packages', v_packages,
                             'images', coalesce(array_length(v_images, 1), 0),
                             'edited', v_o <> '{}'::jsonb));

  return jsonb_build_object(
    'product_id', v_product_id,
    'existing', false,
    'image_pending', v_image is not null
  );
end;
$function$;

revoke all on function public.import_catalog_product(uuid, bigint, jsonb) from public, anon;
grant execute on function public.import_catalog_product(uuid, bigint, jsonb) to authenticated;
-- add_catalog_product_to_tenant delega en import_catalog_product (sin cambios):
-- también queda sin precio.

-- -----------------------------------------------------------------------------
-- 11) Sync: feed maestro (nuevo) + RPC de ADR-107 sobre el modelo nuevo
-- -----------------------------------------------------------------------------

-- p_items: ítems de /api/feed/catalog ya mapeados por la Edge:
--   [{ ean, scope, titulo, descripcion, marca, categoria_path, atributos,
--      medidas, foto_url, fotos, fuentes, feed_updated_at,
--      ofertas: [{ store_key, vendedor_key, vendedor, ean_origen, id_origen,
--                  precio, precio_lista, disponible, estado, url,
--                  first_seen_at, last_seen_at }] }]
-- Ofertas de tiendas que no están en catalog_stores se ignoran (la Edge da de
-- alta las tiendas del feed antes de leer).
create or replace function public.catalog_sync_upsert_catalog(
  p_run uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_started timestamptz;
  v_recibidos integer := 0;
  v_nuevos integer := 0;
  v_actualizados integer := 0;
  v_of_in integer := 0;
  v_of_nuevas integer := 0;
  v_of_act integer := 0;
  v_falt integer := 0;
  v_por_tienda jsonb;
begin
  select started_at into v_started from catalog_sync_runs where id = p_run;
  if v_started is null then
    raise exception 'run_not_found';
  end if;

  create temporary table if not exists _sync_items (
    ean text, scope text, titulo text, descripcion text, marca text, categoria_path text,
    atributos jsonb, medidas jsonb, foto_url text, fotos jsonb, fuentes jsonb,
    feed_updated_at timestamptz, ofertas jsonb
  ) on commit drop;
  truncate _sync_items;

  insert into _sync_items
  select distinct on (k.ean, k.scope)
         k.ean, k.scope, left(btrim(r.titulo), 160), nullif(btrim(r.descripcion), ''),
         nullif(btrim(r.marca), ''), nullif(btrim(r.categoria_path), ''),
         case when jsonb_typeof(r.atributos) = 'array' and jsonb_array_length(r.atributos) > 0 then r.atributos end,
         case when jsonb_typeof(r.medidas) = 'object' and r.medidas <> '{}'::jsonb then r.medidas end,
         nullif(btrim(r.foto_url), ''),
         case when jsonb_typeof(r.fotos) = 'array' and jsonb_array_length(r.fotos) > 0 then r.fotos end,
         r.fuentes, r.feed_updated_at,
         case when jsonb_typeof(r.ofertas) = 'array' then r.ofertas else '[]'::jsonb end
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as r(
           ean text, scope text, titulo text, descripcion text, marca text, categoria_path text,
           atributos jsonb, medidas jsonb, foto_url text, fotos jsonb, fuentes jsonb,
           feed_updated_at timestamptz, ofertas jsonb)
   cross join lateral (
     select case when coalesce(btrim(r.scope), '') = '' then catalog_item_ean(r.ean) else btrim(r.ean) end as ean,
            upper(coalesce(btrim(r.scope), '')) as scope
   ) k
   where nullif(btrim(r.ean), '') is not null
     and nullif(btrim(r.titulo), '') is not null
   order by k.ean, k.scope, r.feed_updated_at desc nulls last;

  get diagnostics v_recibidos = row_count;

  with up as (
    insert into catalog_items as ci (ean, store_scope, titulo, descripcion, marca, categoria_path,
                                     atributos, medidas, foto_url, fotos, fuentes, feed_updated_at)
    select ean, scope, titulo, descripcion, marca, categoria_path, atributos, medidas, foto_url,
           fotos, fuentes, feed_updated_at
      from _sync_items
    on conflict (ean, store_scope) do update
       set titulo = excluded.titulo,
           descripcion = excluded.descripcion,
           marca = excluded.marca,
           categoria_path = excluded.categoria_path,
           atributos = excluded.atributos,
           medidas = excluded.medidas,
           foto_url = excluded.foto_url,
           fotos = excluded.fotos,
           fuentes = excluded.fuentes,
           feed_updated_at = excluded.feed_updated_at
     where (ci.titulo, ci.descripcion, ci.marca, ci.categoria_path, ci.atributos, ci.medidas,
            ci.foto_url, ci.fotos)
           is distinct from
           (excluded.titulo, excluded.descripcion, excluded.marca, excluded.categoria_path,
            excluded.atributos, excluded.medidas, excluded.foto_url, excluded.fotos)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_nuevos, v_actualizados
    from up;

  create temporary table if not exists _sync_offers (
    item_id bigint, store_key text, vendedor_key text, vendedor text, ean_origen text,
    id_origen text, precio numeric, precio_lista numeric, disponible boolean, estado text,
    url text, first_seen_at timestamptz, last_seen_at timestamptz
  ) on commit drop;
  truncate _sync_offers;

  insert into _sync_offers
  select distinct on (x.store_key, i.id, x.vendedor_key)
         i.id, x.store_key, x.vendedor_key, x.vendedor, x.ean_origen, x.id_origen,
         x.precio, x.precio_lista, x.disponible, x.estado, x.url, x.first_seen_at, x.last_seen_at
    from _sync_items s
    join catalog_items i on i.ean = s.ean and i.store_scope = s.scope
   cross join lateral (
     select upper(btrim(o.store_key)) as store_key,
            coalesce(btrim(o.vendedor_key), '') as vendedor_key,
            case when coalesce(btrim(o.vendedor_key), '') = '' then null else nullif(btrim(o.vendedor), '') end as vendedor,
            coalesce(nullif(btrim(o.ean_origen), ''), s.ean) as ean_origen,
            nullif(btrim(o.id_origen), '') as id_origen,
            case when o.precio >= 0 and o.precio < 1e10 then round(o.precio, 2) end as precio,
            case when o.precio_lista >= 0 and o.precio_lista < 1e10 then round(o.precio_lista, 2) end as precio_lista,
            coalesce(o.disponible, false) as disponible,
            nullif(btrim(o.estado), '') as estado,
            nullif(btrim(o.url), '') as url,
            o.first_seen_at, o.last_seen_at
       from jsonb_to_recordset(s.ofertas) as o(
              store_key text, vendedor_key text, vendedor text, ean_origen text, id_origen text,
              precio numeric, precio_lista numeric, disponible boolean, estado text, url text,
              first_seen_at timestamptz, last_seen_at timestamptz)
   ) x
    join catalog_stores cs on cs.key = x.store_key
   order by x.store_key, i.id, x.vendedor_key, x.disponible desc, coalesce(nullif(x.precio, 0), 1e15);

  get diagnostics v_of_in = row_count;

  select count(*) into v_falt from _sync_offers where not disponible and coalesce(estado, '') like 'FALTANTE%';

  with up as (
    insert into catalog_offers as co (item_id, store_key, vendedor_key, vendedor, ean_origen, id_origen,
                                      precio, precio_lista, disponible, estado, url, first_seen_at,
                                      last_seen_at, feed_seen_at)
    select item_id, store_key, vendedor_key, vendedor, ean_origen, id_origen, precio, precio_lista,
           disponible, estado, url, first_seen_at, last_seen_at, v_started
      from _sync_offers
    on conflict (store_key, item_id, vendedor_key) do update
       set vendedor = excluded.vendedor,
           ean_origen = excluded.ean_origen,
           id_origen = excluded.id_origen,
           precio = excluded.precio,
           precio_lista = excluded.precio_lista,
           disponible = excluded.disponible,
           estado = excluded.estado,
           url = excluded.url,
           first_seen_at = coalesce(co.first_seen_at, excluded.first_seen_at),
           last_seen_at = excluded.last_seen_at,
           feed_seen_at = excluded.feed_seen_at,
           updated_at = case
             when (co.precio, co.precio_lista, co.disponible, co.estado, co.url, co.vendedor,
                   co.ean_origen, co.id_origen)
                  is distinct from
                  (excluded.precio, excluded.precio_lista, excluded.disponible, excluded.estado,
                   excluded.url, excluded.vendedor, excluded.ean_origen, excluded.id_origen)
             then now() else co.updated_at end
    returning co.store_key, (xmax = 0) as inserted, (co.updated_at = now()) as changed
  ), agg as (
    select up.store_key,
           count(*) filter (where up.inserted) as nuevas,
           count(*) filter (where not up.inserted and up.changed) as actualizadas
      from up group by up.store_key
  ), falt as (
    select so.store_key, count(*) as faltantes
      from _sync_offers so
     where not so.disponible and coalesce(so.estado, '') like 'FALTANTE%'
     group by so.store_key
  )
  select coalesce(sum(a.nuevas), 0), coalesce(sum(a.actualizadas), 0),
         coalesce(jsonb_object_agg(coalesce(a.store_key, f.store_key), jsonb_build_object(
           'nuevas', coalesce(a.nuevas, 0), 'actualizadas', coalesce(a.actualizadas, 0),
           'faltantes', coalesce(f.faltantes, 0))), '{}'::jsonb)
    into v_of_nuevas, v_of_act, v_por_tienda
    from agg a
    full join falt f on f.store_key = a.store_key;

  return jsonb_build_object(
    'recibidos', v_recibidos,
    'nuevos', coalesce(v_nuevos, 0),
    'actualizados', coalesce(v_actualizados, 0),
    'ofertas', v_of_in,
    'ofertas_nuevas', coalesce(v_of_nuevas, 0),
    'ofertas_actualizadas', coalesce(v_of_act, 0),
    'faltantes', coalesce(v_falt, 0),
    'por_tienda', coalesce(v_por_tienda, '{}'::jsonb)
  );
end;
$function$;

-- ADR-107 (compatibilidad: Edge vieja durante el deploy e import por Excel):
-- filas por (tienda, código) → producto maestro (sólo completa lo que falta,
-- no pisa la ficha fusionada) + publicación de tienda. p_run null = sin
-- corrida (scripts/import_catalog.cjs).
create or replace function public.catalog_sync_upsert_products(
  p_run uuid,
  p_store text,
  p_full boolean,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_started timestamptz;
  v_store text := upper(btrim(p_store));
  v_in integer;
  v_nuevos integer;
  v_actualizados integer;
  v_faltantes integer;
begin
  if p_run is null then
    v_started := now();
  else
    select started_at into v_started from catalog_sync_runs where id = p_run;
    if v_started is null then
      raise exception 'run_not_found';
    end if;
  end if;
  if not exists (select 1 from catalog_stores where key = v_store) then
    raise exception 'store_not_found';
  end if;

  create temporary table if not exists _legacy_rows (
    ean text, scope text, ean_origen text, titulo text, precio numeric, precio_lista numeric,
    marca text, categoria_path text, foto_url text, disponible boolean, estado text,
    id_origen text, descripcion text, atributos jsonb
  ) on commit drop;
  truncate _legacy_rows;

  insert into _legacy_rows
  select distinct on (catalog_item_ean(r.ean), catalog_item_scope(v_store, r.ean))
         catalog_item_ean(r.ean), catalog_item_scope(v_store, r.ean), btrim(r.ean), btrim(r.titulo),
         r.precio, r.precio_lista, nullif(btrim(r.marca), ''), nullif(btrim(r.categoria_path), ''),
         nullif(btrim(r.foto_url), ''), coalesce(r.disponible, false), r.estado,
         nullif(btrim(r.id_origen), ''), nullif(btrim(r.descripcion), ''),
         case when r.atributos is null then null else normalize_product_attributes(r.atributos) end
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
           ean text, titulo text, precio numeric, precio_lista numeric, marca text,
           categoria_path text, foto_url text, disponible boolean, estado text,
           id_origen text, descripcion text, atributos jsonb)
   where nullif(btrim(r.ean), '') is not null
     and nullif(btrim(r.titulo), '') is not null
   order by catalog_item_ean(r.ean), catalog_item_scope(v_store, r.ean),
            coalesce(r.disponible, false) desc, coalesce(nullif(r.precio, 0), 1e15);
  get diagnostics v_in = row_count;

  insert into catalog_items as ci (ean, store_scope, titulo, descripcion, marca, categoria_path,
                                   atributos, foto_url, fotos, fuentes)
  select l.ean, l.scope, left(l.titulo, 160), l.descripcion, l.marca, l.categoria_path,
         case when jsonb_array_length(coalesce(l.atributos, '[]'::jsonb)) > 0 then l.atributos end,
         l.foto_url, case when l.foto_url is not null then jsonb_build_array(l.foto_url) end,
         jsonb_build_object('titulo', v_store, 'origen', 'por_tienda')
    from _legacy_rows l
  on conflict (ean, store_scope) do update
     set descripcion = coalesce(ci.descripcion, excluded.descripcion),
         marca = coalesce(ci.marca, excluded.marca),
         categoria_path = coalesce(ci.categoria_path, excluded.categoria_path),
         atributos = coalesce(ci.atributos, excluded.atributos),
         foto_url = coalesce(ci.foto_url, excluded.foto_url),
         fotos = coalesce(ci.fotos, excluded.fotos)
   where ci.descripcion is null or ci.marca is null or ci.categoria_path is null
      or ci.atributos is null or ci.foto_url is null;

  with up as (
    insert into catalog_offers as co (item_id, store_key, vendedor_key, ean_origen, id_origen, precio,
                                      precio_lista, disponible, estado, feed_seen_at)
    select i.id, v_store, '', l.ean_origen, l.id_origen, l.precio, l.precio_lista, l.disponible,
           l.estado, v_started
      from _legacy_rows l
      join catalog_items i on i.ean = l.ean and i.store_scope = l.scope
    on conflict (store_key, item_id, vendedor_key) do update
       set ean_origen = excluded.ean_origen,
           id_origen = excluded.id_origen,
           precio = excluded.precio,
           precio_lista = excluded.precio_lista,
           disponible = excluded.disponible,
           estado = excluded.estado,
           feed_seen_at = excluded.feed_seen_at,
           updated_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_nuevos, v_actualizados
    from up;

  select count(*) into v_faltantes from _legacy_rows where estado like 'FALTANTE%';

  return jsonb_build_object(
    'recibidos', coalesce(v_in, 0),
    'nuevos', coalesce(v_nuevos, 0),
    'actualizados', coalesce(v_actualizados, 0),
    'faltantes', coalesce(v_faltantes, 0),
    'ignorados', greatest(coalesce(v_in, 0) - coalesce(v_nuevos, 0) - coalesce(v_actualizados, 0), 0)
  );
end;
$function$;

-- Cierre de una tienda: si la lectura fue COMPLETA, las ofertas de esa tienda
-- (de cualquier vendedor) que no vinieron quedan no disponibles (nunca se
-- borran). Después, conteo de publicaciones de tienda y fecha. p_run null =
-- sin corrida (import por Excel): sólo el conteo.
create or replace function public.catalog_sync_finish_store(
  p_run uuid,
  p_store text,
  p_full boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_started timestamptz;
  v_marcados integer := 0;
  v_count bigint;
begin
  if p_run is not null then
    select started_at into v_started from catalog_sync_runs where id = p_run;
    if v_started is null then
      raise exception 'run_not_found';
    end if;
  end if;

  if p_full and v_started is not null then
    update catalog_offers
       set disponible = false, estado = 'FALTANTE_EN_FEED', updated_at = now()
     where store_key = p_store
       and (feed_seen_at is null or feed_seen_at < v_started)
       and (disponible or coalesce(estado, '') not like 'FALTANTE%');
    get diagnostics v_marcados = row_count;
  end if;

  select count(*) into v_count from catalog_offers where store_key = p_store and vendedor_key = '';

  update catalog_stores
     set product_count = coalesce(v_count, 0), last_import_at = now()
   where key = p_store;

  return jsonb_build_object('marcados', v_marcados, 'product_count', coalesce(v_count, 0));
end;
$function$;

-- Cierre de la corrida: igual que ADR-107; además cuenta como error el del
-- feed maestro (runs.feed.error).
create or replace function public.catalog_sync_finalize(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_stores jsonb;
  v_feed jsonb;
  v_keys text[];
  v_errors boolean;
  r record;
  v_catalogs integer := 0;
  v_notified integer := 0;
begin
  select stores, feed into v_stores, v_feed from catalog_sync_runs where id = p_run;
  if v_stores is null then
    raise exception 'run_not_found';
  end if;

  select coalesce(array_agg(k), '{}'),
         coalesce(bool_or(nullif(v_stores -> k ->> 'error', '') is not null), false)
    into v_keys, v_errors
    from jsonb_object_keys(v_stores) as k;
  v_errors := v_errors or nullif(v_feed ->> 'error', '') is not null;

  for r in
    select distinct csm.catalog_id
      from catalog_store_map csm
     where csm.store_key = any (v_keys)
  loop
    perform catalog_recount_products(r.catalog_id);
    v_notified := v_notified + coalesce(notify_catalog_update(r.catalog_id), 0);
    v_catalogs := v_catalogs + 1;
  end loop;

  update catalog_sync_runs
     set status = case when v_errors then 'partial' else 'ok' end,
         finished_at = now(), locked_until = null, current_store = null
   where id = p_run;

  return jsonb_build_object('catalogos', v_catalogs, 'notificados', v_notified,
                            'status', case when v_errors then 'partial' else 'ok' end);
end;
$function$;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.catalog_sync_upsert_catalog(uuid, jsonb)',
    'public.catalog_sync_upsert_products(uuid, text, boolean, jsonb)',
    'public.catalog_sync_finish_store(uuid, text, boolean)',
    'public.catalog_sync_finalize(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $grants$;

-- Helpers sin datos (inmutables): los usan la RLS y las funciones de arriba.
grant execute on function public.catalog_normalize_gtin(text) to authenticated, service_role;
grant execute on function public.catalog_item_ean(text) to authenticated, service_role;
grant execute on function public.catalog_item_scope(text, text) to authenticated, service_role;
grant execute on function public.catalog_store_rank(text) to authenticated, service_role;
grant execute on function public.catalog_fmt_num(numeric) to authenticated, service_role;
grant execute on function public.catalog_item_attributes(jsonb, jsonb) to authenticated, service_role;
