-- =============================================================================
-- Tiendita — Catálogos precargados (FUNDACIÓN del addon).
--
-- NinjaSoft sube periódicamente un Excel enorme (cientos de miles de productos);
-- cada HOJA es una tienda de origen (CARREFOUR, COTO, DIA, EASY, JUMBO). Tiendas
-- de la misma categoría se agrupan en un CATÁLOGO vendible (pago ÚNICO). El
-- cliente compra un catálogo y puede buscar/agregar productos a SU catálogo.
--
-- Esta migración define el esquema base, RLS, las funciones de búsqueda
-- (catalog_search) y de "agregar a mis productos" (add_catalog_product_to_tenant),
-- la notificación de actualización (notify_catalog_update) y el bucket de assets.
-- El storefront del cliente lo construye otro agente sobre esta base.
-- =============================================================================

create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- 1) catalog_stores — tiendas de origen (una por hoja del Excel).
-- Globales (sin tenant). product_count/last_import_at los actualiza el import.
-- -----------------------------------------------------------------------------
create table if not exists catalog_stores (
  key            text primary key,                 -- ej 'CARREFOUR'
  name           text not null,
  logo_url       text,
  product_count  bigint not null default 0,
  last_import_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 2) catalogs — catálogos vendibles (agrupan tiendas). Pago ÚNICO.
-- -----------------------------------------------------------------------------
create table if not exists catalogs (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  name          text not null,
  description   text,
  cover_url     text,
  price_ars     numeric(12,2) not null default 0 check (price_ars >= 0),
  dedupe_by_ean boolean not null default true,     -- "vender como un paquete"
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users(id)
);

create index if not exists catalogs_active_idx on catalogs(is_active);

-- -----------------------------------------------------------------------------
-- 3) catalog_store_map — qué tiendas componen cada catálogo (N:M).
-- -----------------------------------------------------------------------------
create table if not exists catalog_store_map (
  catalog_id uuid not null references catalogs(id) on delete cascade,
  store_key  text not null references catalog_stores(key) on delete cascade,
  primary key (catalog_id, store_key)
);

create index if not exists catalog_store_map_store_idx on catalog_store_map(store_key);

-- -----------------------------------------------------------------------------
-- 4) catalog_products — tabla MASIVA (cientos de miles de filas por tienda).
-- id bigint identity. Diseñada para upsert por (store_key, ean) y búsqueda por
-- título (trigram) o EAN exacto.
-- -----------------------------------------------------------------------------
create table if not exists catalog_products (
  id            bigint generated always as identity primary key,
  store_key     text not null references catalog_stores(key) on delete cascade,
  ean           text not null,
  titulo        text not null,
  precio        numeric(12,2),
  precio_lista  numeric(12,2),
  marca         text,
  categoria_path text,                              -- anidada con " > "
  foto_url      text,
  disponible    boolean not null default true,
  estado        text,
  id_origen     text,
  updated_at    timestamptz not null default now()
);

-- Upsert key: una fila por (tienda, EAN). El import hace ON CONFLICT update.
create unique index if not exists catalog_products_store_ean_idx
  on catalog_products(store_key, ean);
-- Búsqueda por EAN exacto a través de varias tiendas.
create index if not exists catalog_products_ean_idx on catalog_products(ean);
-- Búsqueda por título (similaridad / ilike). GIN trigram escala a millones.
create index if not exists catalog_products_titulo_trgm_idx
  on catalog_products using gin (titulo gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- 5) tenant_catalog_purchases — quién compró/recibió cada catálogo.
-- last_notified_product_count: base para avisar "+N productos nuevos".
-- -----------------------------------------------------------------------------
create table if not exists tenant_catalog_purchases (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  catalog_id   uuid not null references catalogs(id) on delete cascade,
  source       text not null check (source in ('paid','granted')),
  price_paid   numeric(12,2),
  purchased_at timestamptz not null default now(),
  last_notified_product_count bigint not null default 0,
  unique (tenant_id, catalog_id)
);

create index if not exists tenant_catalog_purchases_tenant_idx
  on tenant_catalog_purchases(tenant_id);
create index if not exists tenant_catalog_purchases_catalog_idx
  on tenant_catalog_purchases(catalog_id);

-- updated_at triggers (set_updated_at ya existe globalmente).
drop trigger if exists trg_catalog_stores_updated on catalog_stores;
create trigger trg_catalog_stores_updated before update on catalog_stores
  for each row execute function set_updated_at();
drop trigger if exists trg_catalogs_updated on catalogs;
create trigger trg_catalogs_updated before update on catalogs
  for each row execute function set_updated_at();
drop trigger if exists trg_catalog_products_updated on catalog_products;
create trigger trg_catalog_products_updated before update on catalog_products
  for each row execute function set_updated_at();

-- =============================================================================
-- RLS
-- =============================================================================
alter table catalog_stores enable row level security;
alter table catalogs enable row level security;
alter table catalog_store_map enable row level security;
alter table catalog_products enable row level security;
alter table tenant_catalog_purchases enable row level security;

-- catalog_stores: lectura para cualquier autenticado (mostrar la oferta);
-- escritura sólo staff interno.
drop policy if exists catalog_stores_read on catalog_stores;
create policy catalog_stores_read on catalog_stores for select to authenticated
  using (true);
drop policy if exists catalog_stores_write on catalog_stores;
create policy catalog_stores_write on catalog_stores for all to authenticated
  using (is_internal()) with check (is_internal());

-- catalogs: lectura pública/autenticada (los activos para todos; internal ve
-- también los inactivos). Escritura sólo staff interno.
drop policy if exists catalogs_read on catalogs;
create policy catalogs_read on catalogs for select to authenticated
  using (is_active or is_internal());
drop policy if exists catalogs_write on catalogs;
create policy catalogs_write on catalogs for all to authenticated
  using (is_internal()) with check (is_internal());

-- catalog_store_map: lectura para autenticado (saber qué compone un catálogo);
-- escritura sólo staff interno.
drop policy if exists catalog_store_map_read on catalog_store_map;
create policy catalog_store_map_read on catalog_store_map for select to authenticated
  using (true);
drop policy if exists catalog_store_map_write on catalog_store_map;
create policy catalog_store_map_write on catalog_store_map for all to authenticated
  using (is_internal()) with check (is_internal());

-- catalog_products: un tenant puede leer un producto SÓLO si compró/recibió un
-- catálogo (activo) que incluye ese store_key. Staff interno ve todo.
drop policy if exists catalog_products_read on catalog_products;
create policy catalog_products_read on catalog_products for select to authenticated
  using (
    is_internal()
    or exists (
      select 1
        from tenant_catalog_purchases tcp
        join catalog_store_map csm on csm.catalog_id = tcp.catalog_id
        join catalogs c on c.id = tcp.catalog_id
       where tcp.tenant_id = current_tenant_id()
         and csm.store_key = catalog_products.store_key
         and c.is_active
    )
  );
-- Escritura sólo staff interno (en la práctica el bulk entra por script con
-- service_role, que saltea RLS; esta policy cubre ABM puntual desde internal).
drop policy if exists catalog_products_write on catalog_products;
create policy catalog_products_write on catalog_products for all to authenticated
  using (is_internal()) with check (is_internal());

-- tenant_catalog_purchases: el tenant ve las suyas; staff interno ve todas y
-- gestiona (bonificar). El alta "paid" real la hará el checkout server-side.
drop policy if exists tcp_read on tenant_catalog_purchases;
create policy tcp_read on tenant_catalog_purchases for select to authenticated
  using (tenant_id = current_tenant_id() or is_internal());
drop policy if exists tcp_write on tenant_catalog_purchases;
create policy tcp_write on tenant_catalog_purchases for all to authenticated
  using (is_internal()) with check (is_internal());

-- =============================================================================
-- Función: catalog_search(p_catalog_id, p_query, p_limit, p_offset)
-- Busca en los productos de las tiendas del catálogo. Si el catálogo es
-- dedupe_by_ean, devuelve UN row por EAN (preferí disponible y última
-- actualización). Match por título (ilike/trigram) o EAN exacto.
-- SECURITY DEFINER con check de que el caller compró/recibió el catálogo (o es
-- staff interno). Pensada para el storefront.
-- =============================================================================
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
  disponible boolean
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_q text := btrim(coalesce(p_query, ''));
  v_like text;
begin
  -- Autorización: staff interno o tenant con compra/grant del catálogo activo.
  if not is_internal() then
    if not exists (
      select 1 from tenant_catalog_purchases tcp
        join catalogs c on c.id = tcp.catalog_id
       where tcp.catalog_id = p_catalog_id
         and tcp.tenant_id = current_tenant_id()
         and c.is_active
    ) then
      raise exception 'forbidden';
    end if;
  end if;

  select c.dedupe_by_ean into v_dedupe from catalogs c where c.id = p_catalog_id;
  if v_dedupe is null then
    raise exception 'catalog_not_found';
  end if;

  v_like := '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%';

  if v_dedupe then
    -- Un row por EAN: elegimos el "mejor" (disponible primero, luego el más
    -- actualizado) usando distinct on. El catálogo lo más completo posible.
    return query
    with scoped as (
      select cp.*
        from catalog_products cp
        join catalog_store_map csm on csm.store_key = cp.store_key
       where csm.catalog_id = p_catalog_id
         and (
           v_q = ''
           or cp.titulo ilike v_like
           or cp.ean = v_q
         )
    ),
    deduped as (
      select distinct on (s.ean) s.*
        from scoped s
       order by s.ean, s.disponible desc, s.updated_at desc, s.id desc
    )
    select d.id, d.store_key, d.ean, d.titulo, d.precio, d.precio_lista,
           d.marca, d.categoria_path, d.foto_url, d.disponible
      from deduped d
     order by d.disponible desc, d.titulo
     limit v_limit offset v_offset;
  else
    -- Sin dedupe: todas las filas de las tiendas del catálogo.
    return query
    select cp.id, cp.store_key, cp.ean, cp.titulo, cp.precio, cp.precio_lista,
           cp.marca, cp.categoria_path, cp.foto_url, cp.disponible
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id
       and (
         v_q = ''
         or cp.titulo ilike v_like
         or cp.ean = v_q
       )
     order by cp.disponible desc, cp.titulo
     limit v_limit offset v_offset;
  end if;
end;
$function$;

revoke all on function public.catalog_search(uuid, text, integer, integer) from public, anon;
grant execute on function public.catalog_search(uuid, text, integer, integer) to authenticated;

-- =============================================================================
-- Función: add_catalog_product_to_tenant(p_catalog_id, p_catalog_product_id)
-- Inserta un catalog_product en los products del tenant actual. Crea la
-- categoría anidada (hasta 10 niveles) a partir de categoria_path (" > "),
-- resuelve/crea la marca, y mapea precio/foto/ean. Idempotente por barcode:
-- si el tenant ya tiene ese EAN como barcode (no borrado), devuelve ese product.
-- Autoriza: el tenant debe haber comprado/recibido un catálogo que incluya el
-- store_key del producto. Error claro si no.
-- =============================================================================
create or replace function public.add_catalog_product_to_tenant(
  p_catalog_id uuid,
  p_catalog_product_id bigint
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant uuid := current_tenant_id();
  v_cp catalog_products%rowtype;
  v_allowed boolean;
  v_cat_id uuid;
  v_parent uuid;
  v_brand_id uuid;
  v_existing uuid;
  v_seg text;
  v_segs text[];
  v_i int;
  v_product_id uuid;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  select * into v_cp from catalog_products where id = p_catalog_product_id;
  if not found then
    raise exception 'catalog_product_not_found';
  end if;

  -- El tenant debe tener el catálogo (activo) y ese catálogo debe incluir la
  -- tienda del producto. Esto es la misma condición que la RLS de lectura.
  select exists (
    select 1
      from tenant_catalog_purchases tcp
      join catalog_store_map csm on csm.catalog_id = tcp.catalog_id
      join catalogs c on c.id = tcp.catalog_id
     where tcp.tenant_id = v_tenant
       and tcp.catalog_id = p_catalog_id
       and csm.store_key = v_cp.store_key
       and c.is_active
  ) into v_allowed;
  if not v_allowed then
    raise exception 'catalog_not_owned';
  end if;

  -- Idempotencia: si el EAN ya existe como barcode del tenant, lo devolvemos.
  select id into v_existing
    from products
   where tenant_id = v_tenant
     and barcode = v_cp.ean
     and deleted_at is null
   limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  -- Categoría anidada: split por " > ", crear cada nivel si falta (máx 10).
  v_parent := null;
  v_cat_id := null;
  if coalesce(btrim(v_cp.categoria_path), '') <> '' then
    v_segs := string_to_array(v_cp.categoria_path, '>');
    v_i := 0;
    foreach v_seg in array v_segs loop
      v_seg := btrim(v_seg);
      if v_seg = '' then continue; end if;
      v_i := v_i + 1;
      if v_i > 10 then exit; end if;

      -- Reusar categoría existente del tenant en ese nivel (mismo nombre+padre).
      select id into v_cat_id
        from categories
       where tenant_id = v_tenant
         and name = v_seg
         and coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce(v_parent, '00000000-0000-0000-0000-000000000000'::uuid)
         and deleted_at is null
       limit 1;

      if v_cat_id is null then
        insert into categories (tenant_id, parent_id, name)
        values (v_tenant, v_parent, v_seg)
        returning id into v_cat_id;
      end if;

      v_parent := v_cat_id;
    end loop;
  end if;

  -- Marca: resolver/crear en brands del tenant (si viene marca).
  v_brand_id := null;
  if coalesce(btrim(v_cp.marca), '') <> '' then
    select id into v_brand_id
      from brands
     where tenant_id = v_tenant
       and name = btrim(v_cp.marca)
       and deleted_at is null
     limit 1;
    if v_brand_id is null then
      insert into brands (tenant_id, name)
      values (v_tenant, btrim(v_cp.marca))
      returning id into v_brand_id;
    end if;
  end if;

  -- Insert del producto. price = precio del catálogo (0 si null). precio_lista
  -- se preserva en metadata (el modelo de price_lists del tenant es por % de
  -- canal, no admite un precio de lista por producto). track_stock off: los
  -- catálogos precargados no traen stock real.
  insert into products (
    tenant_id, category_id, brand_id, name, barcode, price, image_url,
    track_stock, stock, is_active, metadata
  )
  values (
    v_tenant, v_cat_id, v_brand_id, v_cp.titulo, v_cp.ean,
    coalesce(v_cp.precio, 0), nullif(btrim(v_cp.foto_url), ''),
    false, 0, true,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'tiendita',
      'catalog_store', v_cp.store_key,
      'catalog_precio_lista', v_cp.precio_lista,
      'catalog_product_id', v_cp.id
    ))
  )
  returning id into v_product_id;

  return v_product_id;
end;
$function$;

revoke all on function public.add_catalog_product_to_tenant(uuid, bigint) from public, anon;
grant execute on function public.add_catalog_product_to_tenant(uuid, bigint) to authenticated;

-- =============================================================================
-- Función: notify_catalog_update(p_catalog_id)
-- Computa el total de productos del catálogo (deduplicado por EAN si aplica) y
-- notifica a cada tenant que lo compró/recibió cuánto creció desde su último
-- aviso. Actualiza last_notified_product_count. La invoca el import al terminar.
-- SECURITY DEFINER, sólo staff interno (o service_role, que la llama directo).
-- Devuelve la cantidad de tenants notificados.
-- =============================================================================
create or replace function public.notify_catalog_update(p_catalog_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_name text;
  v_total bigint;
  r record;
  v_delta bigint;
  v_count integer := 0;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;

  select c.dedupe_by_ean, c.name into v_dedupe, v_name
    from catalogs c where c.id = p_catalog_id;
  if v_name is null then
    raise exception 'catalog_not_found';
  end if;

  if v_dedupe then
    select count(distinct cp.ean) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  else
    select count(*) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
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

revoke all on function public.notify_catalog_update(uuid) from public, anon;
grant execute on function public.notify_catalog_update(uuid) to authenticated;

-- =============================================================================
-- Función helper interna: internal_grant_catalog(p_tenant_id, p_catalog_id)
-- Bonificar: da acceso gratis (source='granted') a un tenant. Idempotente.
-- Usada por el panel interno. Audita la acción.
-- =============================================================================
create or replace function public.internal_grant_catalog(
  p_tenant_id uuid,
  p_catalog_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;

  insert into tenant_catalog_purchases (tenant_id, catalog_id, source, price_paid)
  values (p_tenant_id, p_catalog_id, 'granted', 0)
  on conflict (tenant_id, catalog_id) do update
    set source = 'granted'
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'tenant_catalog_purchases', v_id, 'catalog_granted',
          jsonb_build_object('catalog_id', p_catalog_id, 'source', 'granted'));

  return v_id;
end;
$function$;

revoke all on function public.internal_grant_catalog(uuid, uuid) from public, anon;
grant execute on function public.internal_grant_catalog(uuid, uuid) to authenticated;

-- Revocar una bonificación (sólo grants; las compras pagadas no se tocan acá).
create or replace function public.internal_revoke_catalog(
  p_tenant_id uuid,
  p_catalog_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;

  delete from tenant_catalog_purchases
   where tenant_id = p_tenant_id
     and catalog_id = p_catalog_id
     and source = 'granted';

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'tenant_catalog_purchases', null, 'catalog_revoked',
          jsonb_build_object('catalog_id', p_catalog_id));
end;
$function$;

revoke all on function public.internal_revoke_catalog(uuid, uuid) from public, anon;
grant execute on function public.internal_revoke_catalog(uuid, uuid) to authenticated;

-- =============================================================================
-- Seed: las 5 tiendas de origen con su logo (servido desde /tiendas en public).
-- =============================================================================
insert into catalog_stores (key, name, logo_url) values
  ('CARREFOUR', 'Carrefour', '/tiendas/carrefour.svg'),
  ('COTO',      'Coto',      '/tiendas/coto.png'),
  ('DIA',       'Dia',       '/tiendas/dia.png'),
  ('EASY',      'Easy',      '/tiendas/easy.png'),
  ('JUMBO',     'Jumbo',     '/tiendas/jumbo.png')
on conflict (key) do update
  set name = excluded.name, logo_url = excluded.logo_url;

-- =============================================================================
-- Buckets de Storage.
--  - catalog-assets: público; carátulas de catálogos. Escritura sólo interno.
--  - catalog-imports: privado; Excels subidos por el staff para correr el import
--    por script. Lectura/escritura sólo staff interno.
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('catalog-assets', 'catalog-assets', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('catalog-imports', 'catalog-imports', false)
on conflict (id) do nothing;

drop policy if exists "catalog_assets_write" on storage.objects;
drop policy if exists "catalog_assets_modify" on storage.objects;
drop policy if exists "catalog_assets_remove" on storage.objects;
create policy "catalog_assets_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'catalog-assets' and is_internal());
create policy "catalog_assets_modify" on storage.objects for update to authenticated
  using (bucket_id = 'catalog-assets' and is_internal())
  with check (bucket_id = 'catalog-assets' and is_internal());
create policy "catalog_assets_remove" on storage.objects for delete to authenticated
  using (bucket_id = 'catalog-assets' and is_internal());

drop policy if exists "catalog_imports_read" on storage.objects;
drop policy if exists "catalog_imports_write" on storage.objects;
drop policy if exists "catalog_imports_modify" on storage.objects;
drop policy if exists "catalog_imports_remove" on storage.objects;
create policy "catalog_imports_read" on storage.objects for select to authenticated
  using (bucket_id = 'catalog-imports' and is_internal());
create policy "catalog_imports_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'catalog-imports' and is_internal());
create policy "catalog_imports_modify" on storage.objects for update to authenticated
  using (bucket_id = 'catalog-imports' and is_internal())
  with check (bucket_id = 'catalog-imports' and is_internal());
create policy "catalog_imports_remove" on storage.objects for delete to authenticated
  using (bucket_id = 'catalog-imports' and is_internal());
