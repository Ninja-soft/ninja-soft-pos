-- =============================================================================
-- 20261011210000_tiendita_productos_completos
--
-- Tiendita + carga de producto "muy completa":
--
--  1) products: modelo (model) y atributos libres (attributes jsonb, lista
--     ordenada de {key, value}). La descripción ya existía.
--  2) product_packages: medidas por bulto (alto/ancho/profundidad en cm, peso
--     en kg, unidades por bulto, cantidad de bultos). Varios bultos por
--     producto (Producto #1, #2...). UUID PK, tenant_id + RLS, baja lógica.
--     Feature BASE `medidas_bultos` (is_basic=true) con gating server-side por
--     trigger (trg_assert_tenant_feature), igual que el resto de las features.
--  3) catalog_products: descripción y atributos opcionales del maestro, que el
--     buscador (catalog_search) ahora devuelve y el import copia.
--  4) BUG de la foto al importar: add_catalog_product_to_tenant sólo copiaba la
--     URL del maestro a products.image_url y NO creaba la fila en
--     product_images. La galería del producto (única UI de fotos en edición)
--     lee product_images: el producto importado se veía SIN foto y la primera
--     foto subida se tomaba como principal y PISABA image_url (la del catálogo
--     se perdía). Ahora el import crea la fila (path '' = externa, pendiente de
--     copia) y la Edge Function tiendita_copy_image la copia al bucket
--     product-images del tenant como WebP. Si la copia falla, queda la externa.
--  5) import_catalog_product(p_catalog_id, p_catalog_product_id, p_overrides):
--     import con edición previa (nombre, descripción, atributos, precio, costo,
--     stock, EAN/SKU, marca, árbol de categorías, foto sí/no).
--  6) Backfill: productos ya importados de Tiendita sin fila en product_images.
--
-- NO aplicada en ningún entorno al commitear.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) products.model + products.attributes
-- -----------------------------------------------------------------------------
alter table products add column if not exists model text;
alter table products add column if not exists attributes jsonb not null default '[]'::jsonb;

alter table products drop constraint if exists products_attributes_is_array;
alter table products add constraint products_attributes_is_array
  check (jsonb_typeof(attributes) = 'array');

-- -----------------------------------------------------------------------------
-- 2) product_packages (medidas por bulto)
-- -----------------------------------------------------------------------------
create table if not exists product_packages (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  product_id     uuid not null references products(id) on delete cascade,
  idx            int  not null default 1 check (idx >= 1),
  code           text,
  units_per_pack numeric(12,3) not null default 1 check (units_per_pack > 0),
  pack_count     int  not null default 1 check (pack_count >= 1),
  weight_kg      numeric(12,3) check (weight_kg is null or weight_kg >= 0),
  height_cm      numeric(10,2) check (height_cm is null or height_cm >= 0),
  width_cm       numeric(10,2) check (width_cm is null or width_cm >= 0),
  depth_cm       numeric(10,2) check (depth_cm is null or depth_cm >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index if not exists idx_product_packages_tenant on product_packages(tenant_id);
create index if not exists idx_product_packages_product on product_packages(product_id)
  where deleted_at is null;

drop trigger if exists set_updated_at_product_packages on product_packages;
create trigger set_updated_at_product_packages
  before update on product_packages
  for each row execute function set_updated_at();

alter table product_packages enable row level security;

drop policy if exists product_packages_select on product_packages;
create policy product_packages_select on product_packages
  for select using (
    tenant_id = (select current_tenant_id()) or (select is_internal())
  );

-- Alta/edición: owner/manager del tenant y el producto tiene que ser del mismo
-- tenant (no se puede colgar un bulto de un producto ajeno).
drop policy if exists product_packages_insert on product_packages;
create policy product_packages_insert on product_packages
  for insert with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from products p
      where p.id = product_packages.product_id
        and p.tenant_id = (select current_tenant_id())
    )
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );

drop policy if exists product_packages_update on product_packages;
create policy product_packages_update on product_packages
  for update using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  )
  with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from products p
      where p.id = product_packages.product_id
        and p.tenant_id = (select current_tenant_id())
    )
  );
-- Sin policy de DELETE: la baja es lógica (deleted_at).

-- Feature BASE: siempre incluida salvo apagado explícito modules.medidas_bultos=false.
insert into features (key, label, description, grupo, is_basic, sort) values
  ('medidas_bultos', 'Medidas por bulto',
   'Medidas, peso y unidades por bulto de cada producto (logística y volumen)',
   'catalogo', true, 75)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = true;

-- Gating real server-side (cubre también service_role).
drop trigger if exists product_packages_assert_feature on product_packages;
create trigger product_packages_assert_feature
  before insert or update on product_packages
  for each row execute function trg_assert_tenant_feature('medidas_bultos');

-- -----------------------------------------------------------------------------
-- 3) catalog_products: descripción + atributos del maestro (opcionales).
--    atributos: objeto {"Contenido": "500 g", ...} o lista [{key, value}].
-- -----------------------------------------------------------------------------
alter table catalog_products add column if not exists descripcion text;
alter table catalog_products add column if not exists atributos jsonb;

-- catalog_search: misma lógica + descripcion/atributos. Cambia el tipo de
-- retorno, así que hay que dropearla y recrearla.
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
  atributos jsonb
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
    return query
    with scoped as (
      select cp.*
        from catalog_products cp
        join catalog_store_map csm on csm.store_key = cp.store_key
       where csm.catalog_id = p_catalog_id
         and (v_q = '' or cp.titulo ilike v_like or cp.ean = v_q)
    ),
    deduped as (
      select distinct on (s.ean) s.*
        from scoped s
       order by s.ean, s.disponible desc, s.updated_at desc, s.id desc
    )
    select d.id, d.store_key, d.ean, d.titulo, d.precio, d.precio_lista,
           d.marca, d.categoria_path, d.foto_url, d.disponible,
           d.descripcion, d.atributos
      from deduped d
     order by d.disponible desc, d.titulo
     limit v_limit offset v_offset;
  else
    return query
    select cp.id, cp.store_key, cp.ean, cp.titulo, cp.precio, cp.precio_lista,
           cp.marca, cp.categoria_path, cp.foto_url, cp.disponible,
           cp.descripcion, cp.atributos
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id
       and (v_q = '' or cp.titulo ilike v_like or cp.ean = v_q)
     order by cp.disponible desc, cp.titulo
     limit v_limit offset v_offset;
  end if;
end;
$function$;

revoke all on function public.catalog_search(uuid, text, integer, integer) from public, anon;
grant execute on function public.catalog_search(uuid, text, integer, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- Helper: normaliza atributos del maestro (objeto o lista) a la lista
-- [{key, value}] que guarda products.attributes. Descarta vacíos.
-- -----------------------------------------------------------------------------
create or replace function public.normalize_product_attributes(p jsonb)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'value', v) order by ord), '[]'::jsonb)
  from (
    select btrim(e.key) as k, btrim(e.value #>> '{}') as v, row_number() over () as ord
      from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e
    union all
    select btrim(x ->> 'key'), btrim(x ->> 'value'), 100000 + o
      from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
           with ordinality as t(x, o)
     where jsonb_typeof(x) = 'object'
  ) s
  where coalesce(k, '') <> '' and coalesce(v, '') <> '';
$function$;

-- -----------------------------------------------------------------------------
-- 5) import_catalog_product: import con edición previa.
--
-- p_overrides (todo opcional; ausente = valor del catálogo):
--   name, description, model, brand (texto), barcode, sku, price, cost,
--   stock (número; > 0 activa control de stock), track_stock (bool),
--   attributes ([{key,value}]), keep_image (bool, default true),
--   category_path ([{id: uuid|null, name: text}], raíz → hoja). Un nodo con
--   id existente del tenant (y del padre correcto) se reusa; si no, se busca
--   por nombre bajo el padre y si no existe se crea. Lista vacía = sin
--   categoría. Ausente = árbol del catálogo (categoria_path).
--
-- Devuelve jsonb {product_id, existing, image_pending}.
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
  v_cp catalog_products%rowtype;
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
  v_price numeric;
  v_cost numeric;
  v_stock numeric;
  v_track boolean;
  v_attrs jsonb;
  v_keep_image boolean;
  v_image text;
  v_nodes jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  -- Rol: el alta de productos es de owner/manager (igual que el ABM manual);
  -- staff interno (impersonación/soporte) también puede.
  if not is_internal() and not exists (
    select 1 from tenant_users me
     where me.tenant_id = v_tenant
       and me.user_id = auth.uid()
       and me.status = 'active'
       and me.role in ('owner', 'manager')
  ) then
    raise exception 'forbidden';
  end if;

  select * into v_cp from catalog_products where id = p_catalog_product_id;
  if not found then
    raise exception 'catalog_product_not_found';
  end if;

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

  v_barcode := nullif(btrim(coalesce(v_o ->> 'barcode', v_cp.ean)), '');

  -- Idempotencia por código de barras.
  if v_barcode is not null then
    select id into v_existing
      from products
     where tenant_id = v_tenant
       and barcode = v_barcode
       and deleted_at is null
     limit 1;
    if v_existing is not null then
      return jsonb_build_object('product_id', v_existing, 'existing', true, 'image_pending', false);
    end if;
  end if;

  -- Árbol de categorías.
  v_parent := null;
  v_cat_id := null;
  if v_o ? 'category_path' and jsonb_typeof(v_o -> 'category_path') = 'array' then
    v_nodes := v_o -> 'category_path';
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', null, 'name', btrim(s))), '[]'::jsonb)
      into v_nodes
      from unnest(string_to_array(coalesce(v_cp.categoria_path, ''), '>')) s
     where btrim(s) <> '';
  end if;

  v_i := 0;
  for v_node in select * from jsonb_array_elements(v_nodes) loop
    v_i := v_i + 1;
    if v_i > 10 then exit; end if;
    v_seg := left(btrim(coalesce(v_node ->> 'name', '')), 80);
    v_node_id := null;

    -- Nodo existente elegido en el editor: tiene que ser del tenant y colgar
    -- del padre resuelto (si no, se ignora el id y se resuelve por nombre).
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
  v_brand := nullif(btrim(coalesce(v_o ->> 'brand', v_cp.marca, '')), '');
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

  v_name := left(nullif(btrim(coalesce(v_o ->> 'name', v_cp.titulo)), ''), 120);
  if v_name is null then
    v_name := left(v_cp.titulo, 120);
  end if;
  v_price := greatest(coalesce(nullif(v_o ->> 'price', '')::numeric, v_cp.precio, 0), 0);
  v_cost := nullif(v_o ->> 'cost', '')::numeric;
  if v_cost is not null and v_cost < 0 then v_cost := null; end if;
  v_stock := greatest(coalesce(nullif(v_o ->> 'stock', '')::numeric, 0), 0);
  v_track := coalesce((v_o ->> 'track_stock')::boolean, v_stock > 0);
  v_attrs := normalize_product_attributes(
    case when v_o ? 'attributes' then v_o -> 'attributes' else v_cp.atributos end
  );
  v_keep_image := coalesce((v_o ->> 'keep_image')::boolean, true);
  v_image := case when v_keep_image then nullif(btrim(v_cp.foto_url), '') end;

  insert into products (
    tenant_id, category_id, brand_id, name, model, description, barcode, sku,
    price, cost, image_url, track_stock, stock, is_active, attributes, metadata
  )
  values (
    v_tenant, v_cat_id, v_brand_id, v_name,
    nullif(btrim(coalesce(v_o ->> 'model', '')), ''),
    nullif(btrim(coalesce(v_o ->> 'description', v_cp.descripcion, '')), ''),
    v_barcode,
    nullif(btrim(coalesce(v_o ->> 'sku', '')), ''),
    v_price, v_cost, v_image, v_track, case when v_track then v_stock else 0 end,
    true, v_attrs,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'tiendita',
      'catalog_id', p_catalog_id,
      'catalog_store', v_cp.store_key,
      'catalog_precio_lista', v_cp.precio_lista,
      'catalog_product_id', v_cp.id
    ))
  )
  returning id into v_product_id;

  -- Foto: fila en la galería (path '' = externa, pendiente de copia al bucket
  -- del tenant por la Edge tiendita_copy_image). Así la galería la muestra y la
  -- primera foto subida a mano ya no pisa la del catálogo.
  if v_image is not null then
    insert into product_images (tenant_id, product_id, path, url, sort, is_primary)
    values (v_tenant, v_product_id, '', v_image, 0, true);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'products', v_product_id, 'catalog_product_imported',
          jsonb_build_object('catalog_id', p_catalog_id, 'catalog_product_id', v_cp.id,
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

-- El RPC viejo queda como alta rápida (sin edición) delegando en el nuevo, así
-- también deja la foto en la galería.
create or replace function public.add_catalog_product_to_tenant(
  p_catalog_id uuid,
  p_catalog_product_id bigint
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return (import_catalog_product(p_catalog_id, p_catalog_product_id, '{}'::jsonb) ->> 'product_id')::uuid;
end;
$function$;

revoke all on function public.add_catalog_product_to_tenant(uuid, bigint) from public, anon;
grant execute on function public.add_catalog_product_to_tenant(uuid, bigint) to authenticated;

-- -----------------------------------------------------------------------------
-- 6) Backfill: productos de Tiendita con image_url y sin galería.
-- -----------------------------------------------------------------------------
insert into product_images (tenant_id, product_id, path, url, sort, is_primary)
select p.tenant_id, p.id, '', p.image_url, 0, true
  from products p
 where p.deleted_at is null
   and p.metadata ->> 'source' = 'tiendita'
   and coalesce(btrim(p.image_url), '') <> ''
   and not exists (
     select 1 from product_images pi
      where pi.product_id = p.id and pi.deleted_at is null
   );
