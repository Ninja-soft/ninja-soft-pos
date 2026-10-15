-- =============================================================================
-- 20261206100000_marcas_mayusculas
-- Las marcas van SIEMPRE en mayúsculas (pedido del dueño).
--
--   1) brand_name_normalize(text): upper(btrim()) con espacios internos
--      colapsados. upper() de Postgres con la collation del proyecto
--      (en_US.UTF-8) respeta acentos y ñ: 'Ayudín' -> 'AYUDÍN'.
--   2) Trigger BEFORE INSERT/UPDATE OF name en brands: normaliza siempre, por
--      lo que cubre todos los caminos de alta (ficha de producto, gestión de
--      marcas, importación Excel ADR-078, import_catalog_product, API
--      pública, ML, IA...). Un nombre vacío tras normalizar se rechaza.
--   3) _brands_merge(keep, drop): fusiona dos marcas del mismo negocio
--      (reasigna products.brand_id, promotions.scope_brand_id y
--      promotions.scope_ids), da de baja lógica la descartada y lo audita.
--   4) Backfill: fusiona las que colisionan al pasar a mayúsculas (queda la
--      más usada; empate: la más vieja) y normaliza el resto.
--   5) Las búsquedas por nombre de _import_brand e import_catalog_product
--      pasan a comparar contra el nombre normalizado (si no, "Coca  Cola"
--      con doble espacio no encontraría "COCA COLA" y el insert chocaría
--      con el índice único). Se recrean desde su definición viva.
--
-- El índice único brands_tenant_name_idx (tenant_id, name) where deleted_at
-- is null sigue valiendo: como name queda siempre normalizado, ahora es
-- además único sin distinguir mayúsculas.
-- =============================================================================

-- 1) Normalizador -------------------------------------------------------------
create or replace function brand_name_normalize(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select nullif(upper(btrim(regexp_replace(p_name, '\s+', ' ', 'g'))), '');
$$;

grant execute on function brand_name_normalize(text) to authenticated, service_role;

-- 2) Trigger -------------------------------------------------------------------
create or replace function trg_brands_normalize_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.name := brand_name_normalize(new.name);
  if new.name is null then
    raise exception 'brand_name_required' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists brands_normalize_name on brands;
create trigger brands_normalize_name
  before insert or update of name on brands
  for each row execute function trg_brands_normalize_name();

-- 3) Fusión de dos marcas --------------------------------------------------
create or replace function _brands_merge(p_keep uuid, p_drop uuid, p_reason text default 'brand_merge')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keep brands%rowtype;
  v_drop brands%rowtype;
  v_products int;
  v_promos   int;
begin
  if p_keep = p_drop then return; end if;
  select * into v_keep from brands where id = p_keep and deleted_at is null;
  select * into v_drop from brands where id = p_drop and deleted_at is null;
  if v_keep.id is null or v_drop.id is null then
    raise exception 'brand_not_found' using errcode = 'P0002';
  end if;
  if v_keep.tenant_id <> v_drop.tenant_id then
    raise exception 'brand_merge_cross_tenant' using errcode = '42501';
  end if;

  update products set brand_id = p_keep
   where tenant_id = v_drop.tenant_id and brand_id = p_drop;
  get diagnostics v_products = row_count;

  update promotions
     set scope_brand_id = case when scope_brand_id = p_drop then p_keep else scope_brand_id end,
         scope_ids = case
           when scope_ids is not null and p_drop = any (scope_ids)
             then (select array_agg(distinct x) from unnest(array_replace(scope_ids, p_drop, p_keep)) x)
           else scope_ids end
   where tenant_id = v_drop.tenant_id
     and (scope_brand_id = p_drop or p_drop = any (coalesce(scope_ids, '{}'::uuid[])));
  get diagnostics v_promos = row_count;

  update brands set deleted_at = now() where id = p_drop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_drop.tenant_id, auth.uid(), 'brand', p_drop, 'brand.merged',
          jsonb_build_object('id', v_drop.id, 'name', v_drop.name),
          jsonb_build_object('merged_into', v_keep.id, 'name', v_keep.name,
                             'products', v_products, 'promotions', v_promos),
          p_reason);
end;
$$;

revoke all on function _brands_merge(uuid, uuid, text) from public, anon, authenticated;
grant execute on function _brands_merge(uuid, uuid, text) to service_role;

-- 4) Backfill ------------------------------------------------------------------
do $$
declare
  g record;
  v_keep uuid;
  v_id uuid;
begin
  -- 4a) Fusionar colisiones (mismo negocio, mismo nombre normalizado).
  for g in
    select tenant_id, brand_name_normalize(name) as n
      from brands
     where deleted_at is null
     group by 1, 2
    having count(*) > 1
  loop
    select b.id into v_keep
      from brands b
     where b.tenant_id = g.tenant_id and b.deleted_at is null
       and brand_name_normalize(b.name) = g.n
     order by (select count(*) from products p where p.brand_id = b.id) desc,
              b.created_at, b.id
     limit 1;
    for v_id in
      select b.id from brands b
       where b.tenant_id = g.tenant_id and b.deleted_at is null
         and brand_name_normalize(b.name) = g.n and b.id <> v_keep
    loop
      perform _brands_merge(v_keep, v_id, 'marcas_mayusculas: duplicada al pasar a mayúsculas');
    end loop;
  end loop;

  -- 4b) Normalizar el resto (el trigger aplica brand_name_normalize).
  update brands set name = name
   where deleted_at is null
     and name is distinct from brand_name_normalize(name);
end
$$;

-- 5) Búsquedas por nombre normalizado ------------------------------------------
do $$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('_import_brand', 'import_catalog_product')
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def,
      'lower(name) = lower(btrim(p_name))',
      'name = brand_name_normalize(p_name)');
    v_new := replace(v_new,
      'lower(name) = lower(v_brand)',
      'name = brand_name_normalize(v_brand)');
    if v_new <> v_def then
      execute v_new;
    else
      raise notice 'marcas_mayusculas: % sin búsqueda de marca para reemplazar', r.proname;
    end if;
  end loop;
end
$$;
