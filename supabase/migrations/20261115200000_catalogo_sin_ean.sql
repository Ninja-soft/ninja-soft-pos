-- =============================================================================
-- 20261115200000_catalogo_sin_ean  (ADR-118)
--
-- Va después de 20261115100000_tiendita_destacados_rapidos (PR #413): parte de
-- su catalog_search y conserva el camino rápido sin texto.
--
-- Primera corrida completa del catálogo maestro (14/10): 683.395 ofertas OK,
-- pero (a) los productos sin EAN válido no entraban (Megatone y Bancor no
-- publican EAN: 0 ofertas) y (b) el cierre superó el statement_timeout de
-- PostgREST (8 s) y la corrida quedó "ok" igual.
--
--  1) Productos SIN EAN por tienda: catalog_items.ean pasa a NULL para ellos,
--     con store_scope = la tienda y codigo_tienda = el código propio de la
--     tienda (la key de la publicación en el scraper). Único parcial
--     (store_scope, codigo_tienda) where ean is null. Se reutiliza el ámbito
--     por tienda de ADR-109 (pesables y códigos inválidos). Las ofertas pueden
--     no tener ean_origen.
--  2) EAN con espacios, guiones o puntos: catalog_normalize_gtin los saca antes
--     de validar el dígito verificador (misma regla que el scraper). Los ~200
--     productos de tienda que con la regla nueva son un GTIN global se pasan a
--     global (o sus ofertas al global que ya existe).
--  3) Código de barras vs referencia: catalog_item_has_ean / catalog_item_ref_code.
--     Un producto tiene EAN si su código es un GTIN válido (globales y pesables);
--     si no (sin código o código inválido de la tienda) el código de la tienda
--     es REFERENCIA: catalog_search lo devuelve en codigo_tienda (ean null) y
--     import_catalog_product lo carga como SKU, nunca como código de barras.
--     catalog_search devuelve además las medidas (para el diálogo de import).
--  4) Cierre por lotes (cada llamada < 2 s con ~1,3 M de ofertas):
--       catalog_sync_close_store_batch  faltantes + conteo de una tienda, de a
--                                       N ofertas por keyset sobre el índice
--                                       único (store_key, item_id, vendedor_key).
--       catalog_recount_step            productos únicos de un catálogo por
--                                       rangos de item_id (índice
--                                       catalog_offers_item_idx); el avance
--                                       queda en catalogs.recount.
--       catalog_sync_finalize           ya no cuenta: aviso con el conteo
--                                       guardado y estado; "partial" si una
--                                       tienda, un recuento o el feed fallaron.
--     catalog_product_count devuelve el conteo guardado (ya no cuenta en vivo:
--     el panel interno lo llamaba por catálogo y con 340k productos rozaba el
--     timeout). Sin índices nuevos sobre catalog_offers (disco de 8 GB).
--
-- No es una función de plan (CLAUDE.md §6 no aplica): operación de plataforma
-- sobre datos globales; el acceso sigue gateado por tenant_catalog_purchases.
-- NO aplicada en ningún entorno al commitear.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) GTIN: sin espacios, guiones ni puntos (misma regla que scrapping-productos/src/ean.js)
-- -----------------------------------------------------------------------------
create or replace function public.catalog_normalize_gtin(p text)
returns text
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare
  d text := regexp_replace(btrim(coalesce(p, '')), '[[:space:].-]+', '', 'g');
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

-- ¿El código del producto es un código de barras (GTIN válido, incluidos los
-- pesables de prefijo 2)? Si no, es una referencia de la tienda.
create or replace function public.catalog_item_has_ean(p_ean text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select p_ean is not null and catalog_normalize_gtin(p_ean) is not null;
$function$;

-- Código de referencia de la tienda (SKU sugerido) de un producto sin EAN:
-- su código propio, o el código inválido que publicó la tienda.
create or replace function public.catalog_item_ref_code(p_ean text, p_codigo text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(nullif(btrim(p_codigo), ''),
                  case when catalog_normalize_gtin(p_ean) is null then nullif(btrim(p_ean), '') end);
$function$;

-- -----------------------------------------------------------------------------
-- 1) Esquema
-- -----------------------------------------------------------------------------
alter table public.catalog_items alter column ean drop not null;
alter table public.catalog_items add column if not exists codigo_tienda text;

comment on column public.catalog_items.codigo_tienda is
  'ADR-118: código propio de la tienda de un producto SIN EAN (ean null, '
  'store_scope = la tienda). Referencia (SKU), nunca código de barras.';

-- Sin EAN sólo como producto de una tienda y con su código (NOT VALID +
-- VALIDATE: la validación no bloquea lecturas).
alter table public.catalog_items drop constraint if exists catalog_items_sin_ean_check;
alter table public.catalog_items add constraint catalog_items_sin_ean_check
  check (ean is not null or (store_scope <> '' and nullif(btrim(codigo_tienda), '') is not null)) not valid;
alter table public.catalog_items validate constraint catalog_items_sin_ean_check;

-- Identidad de los productos sin EAN (parcial: sólo esas filas, índice chico).
create unique index if not exists catalog_items_tienda_codigo_key
  on public.catalog_items (store_scope, codigo_tienda) where ean is null;

alter table public.catalog_offers alter column ean_origen drop not null;

-- Recuento por lotes en curso de un catálogo: { after, partial, started_at }.
alter table public.catalogs add column if not exists recount jsonb;
comment on column public.catalogs.recount is
  'ADR-118: avance del recuento por lotes (catalog_recount_step). null = sin recuento en curso.';

-- Estado del cierre por lotes de la corrida (Edge catalog_sync, runClosing).
alter table public.catalog_sync_runs add column if not exists closing jsonb;
comment on column public.catalog_sync_runs.closing is
  'ADR-118: cierre por lotes { catalogs, recounted, current, intentos, errors, finalize_intentos }. '
  'El avance por tienda está en stores.<KEY>.cursor / contadas.';

-- -----------------------------------------------------------------------------
-- 2) EAN con separadores que ahora son un GTIN: de la tienda a global
-- -----------------------------------------------------------------------------
drop table if exists pg_temp._ean_fix;
create temporary table _ean_fix as
select i.id,
       i.store_scope as store,
       catalog_normalize_gtin(i.ean) as target_ean,
       case when length(catalog_normalize_gtin(i.ean)) = 13 and left(catalog_normalize_gtin(i.ean), 1) = '2'
            then i.store_scope else '' end as target_scope
  from public.catalog_items i
 where i.store_scope <> ''
   and i.ean ~ '[[:space:].-]'
   and catalog_normalize_gtin(i.ean) is not null;

-- 2a) Si no existe el destino, el producto se mueve entero (conserva su id).
update public.catalog_items i
   set ean = f.target_ean, store_scope = f.target_scope
  from (
    select distinct on (x.target_ean, x.target_scope) x.*
      from _ean_fix x
     where not exists (select 1 from public.catalog_items t
                        where t.ean = x.target_ean and t.store_scope = x.target_scope)
     order by x.target_ean, x.target_scope, catalog_store_rank(x.store), x.id
  ) f
 where i.id = f.id;

-- 2b) Si ya existía, sus ofertas pasan al destino (las que no chocan).
update public.catalog_offers o
   set item_id = t.id, updated_at = now()
  from _ean_fix f
  join public.catalog_items t on t.ean = f.target_ean and t.store_scope = f.target_scope
 where o.item_id = f.id
   and t.id <> f.id
   and not exists (select 1 from public.catalog_offers x
                    where x.store_key = o.store_key and x.item_id = t.id and x.vendedor_key = o.vendedor_key);

-- 2c) Lo que quedó en el producto viejo es un duplicado: no disponible (nunca se borra).
update public.catalog_offers o
   set disponible = false, estado = 'FALTANTE_EN_FEED', updated_at = now()
  from _ean_fix f
  join public.catalog_items t on t.ean = f.target_ean and t.store_scope = f.target_scope
 where o.item_id = f.id
   and t.id <> f.id;

drop table if exists pg_temp._ean_fix;

-- -----------------------------------------------------------------------------
-- 3) Upsert del feed maestro con productos sin EAN
-- -----------------------------------------------------------------------------
-- p_items: como en ADR-109, más codigo_tienda. Sin EAN (ean null/""): entra
-- si trae scope (tienda) y codigo_tienda; identidad (store_scope, codigo_tienda).
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
  v_n integer;
  v_a integer;
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
    item_id bigint, ean text, scope text, codigo text, titulo text, descripcion text, marca text,
    categoria_path text, atributos jsonb, medidas jsonb, foto_url text, fotos jsonb, fuentes jsonb,
    feed_updated_at timestamptz, ofertas jsonb
  ) on commit drop;
  truncate _sync_items;

  insert into _sync_items
  select distinct on (k.ean, k.scope, k.codigo)
         null::bigint, k.ean, k.scope, k.codigo, left(btrim(r.titulo), 160), nullif(btrim(r.descripcion), ''),
         nullif(btrim(r.marca), ''), nullif(btrim(r.categoria_path), ''),
         case when jsonb_typeof(r.atributos) = 'array' and jsonb_array_length(r.atributos) > 0 then r.atributos end,
         case when jsonb_typeof(r.medidas) = 'object' and r.medidas <> '{}'::jsonb then r.medidas end,
         nullif(btrim(r.foto_url), ''),
         case when jsonb_typeof(r.fotos) = 'array' and jsonb_array_length(r.fotos) > 0 then r.fotos end,
         r.fuentes, r.feed_updated_at,
         case when jsonb_typeof(r.ofertas) = 'array' then r.ofertas else '[]'::jsonb end
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as r(
           ean text, scope text, codigo_tienda text, titulo text, descripcion text, marca text,
           categoria_path text, atributos jsonb, medidas jsonb, foto_url text, fotos jsonb, fuentes jsonb,
           feed_updated_at timestamptz, ofertas jsonb)
   cross join lateral (
     select case
              when nullif(btrim(r.ean), '') is null then null
              when coalesce(btrim(r.scope), '') = '' then catalog_item_ean(r.ean)
              else btrim(r.ean)
            end as ean,
            upper(coalesce(btrim(r.scope), '')) as scope,
            case when nullif(btrim(r.ean), '') is null then nullif(btrim(r.codigo_tienda), '') end as codigo
   ) k
   where nullif(btrim(r.titulo), '') is not null
     and (k.ean is not null or (k.scope <> '' and k.codigo is not null))
   order by k.ean, k.scope, k.codigo, r.feed_updated_at desc nulls last;

  get diagnostics v_recibidos = row_count;

  -- Con EAN (o código de tienda en el ean): identidad (ean, store_scope).
  with up as (
    insert into catalog_items as ci (ean, store_scope, titulo, descripcion, marca, categoria_path,
                                     atributos, medidas, foto_url, fotos, fuentes, feed_updated_at)
    select ean, scope, titulo, descripcion, marca, categoria_path, atributos, medidas, foto_url,
           fotos, fuentes, feed_updated_at
      from _sync_items
     where ean is not null
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
    into v_n, v_a
    from up;
  v_nuevos := v_nuevos + coalesce(v_n, 0);
  v_actualizados := v_actualizados + coalesce(v_a, 0);

  -- Sin EAN: identidad (store_scope, codigo_tienda) (único parcial where ean is null).
  with up as (
    insert into catalog_items as ci (ean, store_scope, codigo_tienda, titulo, descripcion, marca,
                                     categoria_path, atributos, medidas, foto_url, fotos, fuentes,
                                     feed_updated_at)
    select null, scope, codigo, titulo, descripcion, marca, categoria_path, atributos, medidas,
           foto_url, fotos, fuentes, feed_updated_at
      from _sync_items
     where ean is null
    on conflict (store_scope, codigo_tienda) where ean is null do update
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
    into v_n, v_a
    from up;
  v_nuevos := v_nuevos + coalesce(v_n, 0);
  v_actualizados := v_actualizados + coalesce(v_a, 0);

  update _sync_items s set item_id = i.id
    from catalog_items i
   where s.ean is not null and i.ean = s.ean and i.store_scope = s.scope;
  update _sync_items s set item_id = i.id
    from catalog_items i
   where s.ean is null and i.ean is null and i.store_scope = s.scope and i.codigo_tienda = s.codigo;

  create temporary table if not exists _sync_offers (
    item_id bigint, store_key text, vendedor_key text, vendedor text, ean_origen text,
    id_origen text, precio numeric, precio_lista numeric, disponible boolean, estado text,
    url text, first_seen_at timestamptz, last_seen_at timestamptz
  ) on commit drop;
  truncate _sync_offers;

  insert into _sync_offers
  select distinct on (x.store_key, s.item_id, x.vendedor_key)
         s.item_id, x.store_key, x.vendedor_key, x.vendedor, x.ean_origen, x.id_origen,
         x.precio, x.precio_lista, x.disponible, x.estado, x.url, x.first_seen_at, x.last_seen_at
    from _sync_items s
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
   where s.item_id is not null
   order by x.store_key, s.item_id, x.vendedor_key, x.disponible desc, coalesce(nullif(x.precio, 0), 1e15);

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

-- -----------------------------------------------------------------------------
-- 4) Cierre por lotes
-- -----------------------------------------------------------------------------

-- Un lote del cierre de una tienda: las p_limit ofertas siguientes a
-- (p_after_item, p_after_vendor) en el índice único (store_key, item_id,
-- vendedor_key). Si la lectura fue COMPLETA, las que no vinieron en la corrida
-- quedan no disponibles (nunca se borran). Cuenta las publicaciones de tienda
-- del lote; en el último lote guarda catalog_stores.product_count =
-- p_counted (lo contado en los lotes anteriores) + las de este.
create or replace function public.catalog_sync_close_store_batch(
  p_run uuid,
  p_store text,
  p_full boolean,
  p_after_item bigint default null,
  p_after_vendor text default null,
  p_limit integer default 20000,
  p_counted bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_started timestamptz;
  v_store text := upper(btrim(coalesce(p_store, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 20000), 100), 50000);
  v_filas integer;
  v_contadas integer;
  v_marcados integer := 0;
  v_last_item bigint;
  v_last_vendor text;
  v_done boolean;
begin
  select started_at into v_started from catalog_sync_runs where id = p_run;
  if v_started is null then
    raise exception 'run_not_found';
  end if;

  create temporary table if not exists _close_page (
    id bigint, item_id bigint, vendedor_key text, stale boolean
  ) on commit drop;
  truncate _close_page;

  insert into _close_page
  select o.id, o.item_id, o.vendedor_key,
         (o.feed_seen_at is null or o.feed_seen_at < v_started)
           and (o.disponible or coalesce(o.estado, '') not like 'FALTANTE%')
    from catalog_offers o
   where o.store_key = v_store
     and (o.item_id, o.vendedor_key) > (coalesce(p_after_item, -1), coalesce(p_after_vendor, ''))
   order by o.item_id, o.vendedor_key
   limit v_limit;
  get diagnostics v_filas = row_count;

  select count(*) filter (where vendedor_key = '') into v_contadas from _close_page;
  select item_id, vendedor_key into v_last_item, v_last_vendor
    from _close_page order by item_id desc, vendedor_key desc limit 1;

  if coalesce(p_full, false) then
    update catalog_offers o
       set disponible = false, estado = 'FALTANTE_EN_FEED', updated_at = now()
      from _close_page c
     where c.stale and o.id = c.id;
    get diagnostics v_marcados = row_count;
  end if;

  v_done := v_filas < v_limit;
  if v_done then
    update catalog_stores
       set product_count = greatest(coalesce(p_counted, 0), 0) + v_contadas, last_import_at = now()
     where key = v_store;
  end if;

  return jsonb_build_object(
    'filas', v_filas,
    'contadas', v_contadas,
    'marcados', v_marcados,
    'last_item', v_last_item,
    'last_vendor', v_last_vendor,
    'done', v_done
  );
end;
$function$;

-- Un paso del recuento de un catálogo: productos únicos (dedupe_by_ean) o
-- publicaciones de tienda (sin dedupe) con item_id en (after, after + p_limit].
-- El avance queda en catalogs.recount (fila bloqueada: dos recuentos del mismo
-- catálogo a la vez se reparten el trabajo sin contar doble). Al terminar
-- guarda catalogs.product_count. p_restart empieza de cero.
-- Llamable por service_role (Edge) o staff interno admin/super_admin en el
-- panel interno (recuento al editar las tiendas de un catálogo).
create or replace function public.catalog_recount_step(
  p_catalog_id uuid,
  p_restart boolean default false,
  p_limit integer default 50000
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_state jsonb;
  v_stores text[];
  v_limit bigint := least(greatest(coalesce(p_limit, 50000), 1000), 500000);
  v_after bigint;
  v_partial bigint;
  v_to bigint;
  v_n bigint;
  v_max bigint;
  v_done boolean;
begin
  if auth.uid() is not null then
    perform catalog_sync_assert_admin();
  end if;

  select c.dedupe_by_ean, c.recount into v_dedupe, v_state
    from catalogs c where c.id = p_catalog_id
     for update;
  if v_dedupe is null then
    raise exception 'catalog_not_found';
  end if;

  if coalesce(p_restart, false) or v_state is null then
    v_after := 0;
    v_partial := 0;
  else
    v_after := coalesce((v_state ->> 'after')::bigint, 0);
    v_partial := coalesce((v_state ->> 'partial')::bigint, 0);
  end if;

  v_stores := catalog_store_keys(p_catalog_id);
  v_to := v_after + v_limit;

  if v_dedupe then
    select count(distinct o.item_id) into v_n
      from catalog_offers o
     where o.item_id > v_after and o.item_id <= v_to
       and o.store_key = any (v_stores) and o.vendedor_key = '';
  else
    select count(*) into v_n
      from catalog_offers o
     where o.item_id > v_after and o.item_id <= v_to
       and o.store_key = any (v_stores) and o.vendedor_key = '';
  end if;

  select max(id) into v_max from catalog_items;
  v_done := v_to >= coalesce(v_max, 0);
  v_partial := v_partial + coalesce(v_n, 0);

  if v_done then
    update catalogs set product_count = v_partial, recount = null where id = p_catalog_id;
  else
    update catalogs
       set recount = jsonb_build_object('after', v_to, 'partial', v_partial,
                                        'started_at', coalesce(case when coalesce(p_restart, false) then null
                                                                    else v_state ->> 'started_at' end,
                                                               now()::text))
     where id = p_catalog_id;
  end if;

  return jsonb_build_object('done', v_done, 'after', v_to, 'product_count', v_partial);
end;
$function$;

-- Conteo de productos de un catálogo: el guardado (lo actualiza el cierre de
-- cada corrida y el recuento del panel). Antes contaba en vivo.
create or replace function public.catalog_product_count(p_catalog_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count bigint;
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
  select c.product_count into v_count from catalogs c where c.id = p_catalog_id;
  return coalesce(v_count, 0);
end;
$function$;

-- Aviso "+N productos" a los negocios que compraron el catálogo, con el conteo
-- ya guardado (sin recontar).
create or replace function public.catalog_notify_buyers(p_catalog_id uuid)
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
  select c.name, c.product_count into v_name, v_total from catalogs c where c.id = p_catalog_id;
  if v_name is null then
    raise exception 'catalog_not_found';
  end if;

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

-- Misma firma y comportamiento (recuento en vivo + aviso), ahora reutilizando
-- catalog_notify_buyers. Lo usa el import por Excel (scripts/import_catalog.cjs).
create or replace function public.notify_catalog_update(p_catalog_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is not null and not is_internal() then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from catalogs where id = p_catalog_id) then
    raise exception 'catalog_not_found';
  end if;
  update catalogs set product_count = catalog_count_internal(p_catalog_id) where id = p_catalog_id;
  return catalog_notify_buyers(p_catalog_id);
end;
$function$;

-- Cierre de la corrida: aviso por catálogo afectado con el conteo que dejó
-- catalog_recount_step y estado. "partial" si falló el feed, el cierre de una
-- tienda o el recuento de un catálogo (closing.errors).
create or replace function public.catalog_sync_finalize(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_stores jsonb;
  v_feed jsonb;
  v_closing jsonb;
  v_keys text[];
  v_errors boolean;
  r record;
  v_catalogs integer := 0;
  v_notified integer := 0;
begin
  select stores, feed, closing into v_stores, v_feed, v_closing from catalog_sync_runs where id = p_run;
  if v_stores is null then
    raise exception 'run_not_found';
  end if;

  select coalesce(array_agg(k), '{}'),
         coalesce(bool_or(nullif(v_stores -> k ->> 'error', '') is not null), false)
    into v_keys, v_errors
    from jsonb_object_keys(v_stores) as k;
  v_errors := v_errors
           or nullif(v_feed ->> 'error', '') is not null
           or (jsonb_typeof(v_closing -> 'errors') = 'object' and v_closing -> 'errors' <> '{}'::jsonb);

  for r in
    select distinct csm.catalog_id
      from catalog_store_map csm
     where csm.store_key = any (v_keys)
  loop
    v_notified := v_notified + coalesce(catalog_notify_buyers(r.catalog_id), 0);
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

-- -----------------------------------------------------------------------------
-- 5) Búsqueda: EAN real o código de la tienda, y medidas
-- -----------------------------------------------------------------------------
-- Cambia el tipo de retorno (columnas nuevas al final): drop + create.
--   ean            el código de barras (GTIN válido) o null si no tiene.
--   codigo_tienda  la referencia de la tienda para los que no tienen EAN.
--   medidas        las medidas fusionadas (peso, contenido, dimensiones, pack).
-- Búsqueda por texto, EAN (crudo o canónico) o código de la tienda.
drop function if exists public.catalog_search(uuid, text, integer, integer);
create function public.catalog_search(
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
  atributos jsonb,
  codigo_tienda text,
  medidas jsonb
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

  -- Sin texto: camino rápido de 20261115100000_tiendita_destacados_rapidos
  -- (sin cambios): las publicaciones disponibles más recientes, por el índice
  -- (item_id, store_key) hacia atrás; el limit corta temprano.
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
    select p.offer_id, p.store_key,
           case when catalog_item_has_ean(i.ean) then i.ean end,
           i.titulo, p.precio, p.precio_lista, i.marca,
           i.categoria_path, i.foto_url, p.disponible, i.descripcion,
           catalog_item_attributes(i.atributos, i.medidas),
           case when catalog_item_has_ean(i.ean) then null else catalog_item_ref_code(i.ean, i.codigo_tienda) end,
           i.medidas
      from picked p
      join catalog_items i on i.id = p.item_id
     order by i.titulo, p.offer_id;
    return;
  end if;

  v_like := '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%';
  v_eans := array_remove(array[v_q, catalog_normalize_gtin(v_q)], null);

  -- EXECUTE ... USING: se planifica con los valores reales ("titulo ilike" usa
  -- el trigram, "ean = any" la unique (ean, store_scope) y el código de la
  -- tienda la unique parcial (store_scope, codigo_tienda) where ean is null).
  return query execute
    $q$
    with cand as (
      select o.id as offer_id, o.item_id, o.store_key, o.precio, o.precio_lista,
             o.disponible, o.updated_at as o_upd
        from catalog_items i
        join catalog_offers o on o.item_id = i.id
       where (i.titulo ilike $2
              or i.ean = any ($3)
              or (i.ean is null and i.store_scope = any ($1) and i.codigo_tienda = $7))
         and o.store_key = any ($1)
         and o.vendedor_key = ''
    ), picked as (
      select distinct on (case when $6 then c.item_id else c.offer_id end) c.*
        from cand c
       order by case when $6 then c.item_id else c.offer_id end,
                c.disponible desc, c.o_upd desc, c.offer_id desc
    )
    select p.offer_id, p.store_key,
           case when catalog_item_has_ean(i.ean) then i.ean end,
           i.titulo, p.precio, p.precio_lista, i.marca,
           i.categoria_path, i.foto_url, p.disponible, i.descripcion,
           catalog_item_attributes(i.atributos, i.medidas),
           case when catalog_item_has_ean(i.ean) then null else catalog_item_ref_code(i.ean, i.codigo_tienda) end,
           i.medidas
      from picked p
      join catalog_items i on i.id = p.item_id
     order by p.disponible desc, i.titulo, p.offer_id
     limit $4 offset $5
    $q$
    using v_stores, v_like, v_eans, v_limit, v_offset, v_dedupe, v_q;
end;
$function$;

revoke all on function public.catalog_search(uuid, text, integer, integer) from public, anon;
grant execute on function public.catalog_search(uuid, text, integer, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- 6) Import: sin EAN el código de la tienda va como SKU, nunca como código de barras
--
-- Cambios contra 20261111200000 (misma firma y retorno):
--   * Código de barras: override `barcode` (el negocio puede cargar el EAN en
--     el diálogo); si no, el EAN del producto SÓLO si es un GTIN válido.
--   * SKU: override `sku` si viene (aunque sea null); si no, el código de la
--     tienda de un producto sin EAN (referencia). Si ese SKU ya lo usa otro
--     producto del negocio, se omite; si lo cargó el negocio, 'sku_taken'.
--   * Idempotencia sin código de barras: el producto ya importado de ese
--     producto del catálogo (metadata.catalog_item_id) o el que se importó
--     antes con el código de la tienda como código de barras.
--   * metadata guarda catalog_codigo_tienda (referencia) si no hay EAN.
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
  v_has_ean boolean;
  v_ref text;
  v_barcode text;
  v_sku text;
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

  v_has_ean := catalog_item_has_ean(v_item.ean);
  v_ref := case when v_has_ean then null else catalog_item_ref_code(v_item.ean, v_item.codigo_tienda) end;
  v_barcode := nullif(btrim(coalesce(v_o ->> 'barcode', case when v_has_ean then v_item.ean end, '')), '');

  -- Idempotencia por código de barras (y sus variantes del catálogo).
  if v_barcode is not null then
    v_variants := array[v_barcode];
    if not (v_o ? 'barcode') and v_has_ean then
      v_variants := v_variants || array[ltrim(v_item.ean, '0'), v_off.ean_origen,
                                        catalog_normalize_gtin(v_off.ean_origen)];
    end if;
    select id into v_existing
      from products
     where tenant_id = v_tenant
       and barcode = any (array_remove(v_variants, null))
       and deleted_at is null
     limit 1;
  else
    -- Sin código de barras: el mismo producto del catálogo ya importado, o el
    -- que se importó antes con el código de la tienda como código de barras.
    select id into v_existing
      from products
     where tenant_id = v_tenant
       and deleted_at is null
       and (metadata ->> 'catalog_item_id' = v_item.id::text
            or (v_ref is not null and barcode = v_ref))
     limit 1;
  end if;
  if v_existing is not null then
    return jsonb_build_object('product_id', v_existing, 'existing', true, 'image_pending', false);
  end if;

  -- SKU: el del negocio; si no lo mandó, la referencia de la tienda.
  if v_o ? 'sku' then
    v_sku := nullif(btrim(coalesce(v_o ->> 'sku', '')), '');
  else
    v_sku := v_ref;
  end if;
  if v_sku is not null and exists (
    select 1 from products
     where tenant_id = v_tenant and sku = v_sku and deleted_at is null
  ) then
    if v_sku is not distinct from v_ref then
      v_sku := null;
    else
      raise exception 'sku_taken';
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
    v_sku,
    v_price, v_cost, v_image, v_track, case when v_track then v_stock else 0 end,
    true, v_attrs,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'tiendita',
      'catalog_id', p_catalog_id,
      'catalog_store', v_off.store_key,
      'catalog_product_id', v_off.id,
      'catalog_item_id', v_item.id,
      'catalog_codigo_tienda', v_ref
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
                             'sin_ean', v_barcode is null,
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

-- -----------------------------------------------------------------------------
-- 7) Permisos
-- -----------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.catalog_sync_upsert_catalog(uuid, jsonb)',
    'public.catalog_sync_close_store_batch(uuid, text, boolean, bigint, text, integer, bigint)',
    'public.catalog_sync_finalize(uuid)',
    'public.catalog_notify_buyers(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $grants$;

-- Recuento: Edge (service_role) y panel interno (staff admin, validado adentro).
revoke all on function public.catalog_recount_step(uuid, boolean, integer) from public, anon;
grant execute on function public.catalog_recount_step(uuid, boolean, integer) to authenticated, service_role;

revoke all on function public.catalog_product_count(uuid) from public, anon;
grant execute on function public.catalog_product_count(uuid) to authenticated;

revoke all on function public.notify_catalog_update(uuid) from public, anon;
grant execute on function public.notify_catalog_update(uuid) to authenticated, service_role;

-- Helpers sin datos (inmutables).
grant execute on function public.catalog_normalize_gtin(text) to authenticated, service_role;
grant execute on function public.catalog_item_has_ean(text) to authenticated, service_role;
grant execute on function public.catalog_item_ref_code(text, text) to authenticated, service_role;

analyze public.catalog_items;
