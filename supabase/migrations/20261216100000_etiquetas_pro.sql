-- =============================================================================
-- 20261216100000_etiquetas_pro.sql  (H24 · ADR-148)
-- Etiquetas PRO: selección por stock/sucursal/depósito/categorías, plantillas
-- de diseño del negocio y ficha pública del producto (QR).
--
--   1. Feature `etiquetas_pro` (OPTIONAL, grupo catalogo) marcada en Pro,
--      Business y Enterprise. Imprimir etiquetas simples sigue siendo BASE
--      (`productos`): no se gatea.
--   2. products.net_content / net_content_unit: contenido neto para el precio
--      por unidad de medida (Ley 27.545 de Góndolas). Opcional: si falta, la
--      etiqueta lo toma del nombre ("Aceite 900 ml").
--   3. label_templates: diseños guardados del negocio. RLS por tenant; alta y
--      edición piden products.edit + etiquetas_pro (server-side). Baja lógica.
--      Auditoría con write_audit_log().
--   4. label_catalog(...): productos/variantes a etiquetar con su stock en el
--      alcance pedido (todo, sucursal o depósito), filtros por categorías
--      (con subcategorías), marcas, búsqueda y productos puntuales. Sólo lee
--      el negocio del usuario y pide products.view.
--   5. public_product_sheet(slug, product): ficha pública del QR. SECURITY
--      DEFINER, anon. Devuelve sólo el producto pedido del negocio del slug,
--      si el negocio está activo y su plan incluye etiquetas_pro. Precio de
--      la lista del catálogo (misma regla que public_catalog), fotos,
--      descripción, marca, medios de pago y planes de cuotas para simular.
--      El carrito sólo se ofrece si _catalog_ordering() (H10) está activo.
-- =============================================================================

-- 1. Feature ------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('etiquetas_pro', 'Etiquetas PRO',
   'Diseños de etiqueta personalizables y plantillas del negocio, QR a la ficha pública del producto con fotos y simulador de cuotas.',
   'catalogo', false, 118)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('etiquetas_pro', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'etiquetas_pro');

-- 2. Contenido neto -----------------------------------------------------------
alter table products add column if not exists net_content numeric(12,3);
alter table products add column if not exists net_content_unit text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_net_content_chk') then
    alter table products add constraint products_net_content_chk check (
      (net_content is null or net_content > 0)
      and (net_content_unit is null or net_content_unit in ('g', 'kg', 'ml', 'l', 'cm3', 'm', 'cm', 'un'))
    );
  end if;
end $$;
comment on column products.net_content is 'Contenido neto (etiquetas, precio por unidad de medida). ADR-148.';
comment on column products.net_content_unit is 'Unidad del contenido neto: g, kg, ml, l, cm3, m, cm, un. ADR-148.';

-- 3. Plantillas ---------------------------------------------------------------
create table if not exists label_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  design      jsonb not null default '{}'::jsonb check (jsonb_typeof(design) = 'object' and pg_column_size(design) < 8192),
  media       jsonb not null default '{}'::jsonb check (jsonb_typeof(media) = 'object' and pg_column_size(media) < 4096),
  is_default  boolean not null default false,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists label_templates_tenant_idx
  on label_templates (tenant_id) where deleted_at is null;
create unique index if not exists label_templates_default_uk
  on label_templates (tenant_id) where is_default and deleted_at is null;

drop trigger if exists set_updated_at_label_templates on label_templates;
create trigger set_updated_at_label_templates
  before update on label_templates
  for each row execute function set_updated_at();

-- Una sola plantilla por defecto: al marcar una, se desmarcan las otras.
create or replace function label_templates_single_default()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.is_default and new.deleted_at is null then
    update label_templates
       set is_default = false
     where tenant_id = new.tenant_id and id <> new.id and is_default;
  end if;
  if new.deleted_at is not null then
    new.is_default := false;
  end if;
  return new;
end;
$$;
revoke all on function label_templates_single_default() from public, anon, authenticated;
drop trigger if exists label_templates_single_default on label_templates;
create trigger label_templates_single_default
  before insert or update of is_default, deleted_at on label_templates
  for each row execute function label_templates_single_default();

alter table label_templates enable row level security;

drop policy if exists label_templates_select on label_templates;
create policy label_templates_select on label_templates
  for select using (tenant_id = (select current_tenant_id()));

drop policy if exists label_templates_insert on label_templates;
create policy label_templates_insert on label_templates
  for insert with check (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
    and tenant_has_feature_for((select current_tenant_id()), 'etiquetas_pro')
  );

drop policy if exists label_templates_update on label_templates;
create policy label_templates_update on label_templates
  for update using (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
    and tenant_has_feature_for((select current_tenant_id()), 'etiquetas_pro')
  )
  with check (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
    and tenant_has_feature_for((select current_tenant_id()), 'etiquetas_pro')
  );
-- Sin DELETE: baja lógica (deleted_at).

drop trigger if exists audit_label_templates on label_templates;
create trigger audit_label_templates
  after insert or update or delete on label_templates
  for each row execute function write_audit_log();

grant select, insert, update on label_templates to authenticated;

-- 4. Catálogo para etiquetar --------------------------------------------------
create or replace function label_catalog(
  p_store_id uuid default null,
  p_warehouse_id uuid default null,
  p_category_ids uuid[] default null,
  p_brand_ids uuid[] default null,
  p_search text default null,
  p_only_stock boolean default false,
  p_include_variants boolean default true,
  p_product_ids uuid[] default null,
  p_limit int default 2000
)
returns table (
  product_id uuid,
  variant_id uuid,
  name text,
  variant_label text,
  brand text,
  category text,
  sku text,
  barcode text,
  plu text,
  unit text,
  price numeric,
  image_url text,
  net_content numeric,
  net_content_unit text,
  stock numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store uuid := p_store_id;
  v_wh_kind text;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit int := least(greatest(coalesce(p_limit, 2000), 1), 5000);
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not has_capability('products.view') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_store is not null and not exists (
    select 1 from stores s where s.id = v_store and s.tenant_id = v_tenant and s.deleted_at is null
  ) then
    raise exception 'store_not_found' using errcode = '22023';
  end if;
  if p_warehouse_id is not null then
    select w.store_id, w.kind into v_store, v_wh_kind
      from warehouses w
     where w.id = p_warehouse_id and w.tenant_id = v_tenant and w.deleted_at is null;
    if not found then
      raise exception 'warehouse_not_found' using errcode = '22023';
    end if;
  end if;

  return query
  with recursive cats as (
    select c.id from categories c
     where p_category_ids is not null and c.tenant_id = v_tenant and c.id = any (p_category_ids) and c.deleted_at is null
    union
    select c.id from categories c join cats on c.parent_id = cats.id
     where c.tenant_id = v_tenant and c.deleted_at is null
  ),
  base as (
    select p.id as pid, v.id as vid, p.name as pname,
           case when v.id is null then null
                else nullif(btrim(concat_ws(' / ', nullif(v.option1, ''), nullif(v.option2, ''))), '') end as vlabel,
           b.name as bname, c.name as cname,
           coalesce(nullif(v.sku, ''), p.sku) as psku,
           coalesce(nullif(v.barcode, ''), p.barcode) as pbarcode,
           p.plu as pplu, p.unit as punit,
           coalesce(v.price_override, p.price) as pprice,
           p.image_url as pimage, p.net_content as pnet, p.net_content_unit as pnetu,
           p.track_stock as ptrack, p.stock as pstock, v.stock as vstock,
           (v.id is null and p.has_variants) as all_variants
      from products p
      left join brands b on b.id = p.brand_id
      left join categories c on c.id = p.category_id
      left join lateral (
        select pv.* from product_variants pv
         where p_include_variants and p.has_variants and pv.product_id = p.id
           and pv.tenant_id = v_tenant and pv.deleted_at is null
      ) v on true
     where p.tenant_id = v_tenant
       and p.deleted_at is null
       and p.is_active
       and (p_category_ids is null or p.category_id in (select id from cats))
       and (p_brand_ids is null or p.brand_id = any (p_brand_ids))
       and (p_product_ids is null or p.id = any (p_product_ids))
       and (v_search is null
            or p.name ilike '%' || v_search || '%'
            or p.sku ilike '%' || v_search || '%'
            or p.barcode ilike '%' || v_search || '%'
            or p.plu ilike '%' || v_search || '%')
  ),
  scoped as (
    select base.*,
      case
        when not base.ptrack then null
        when p_warehouse_id is not null and v_wh_kind = 'principal' then
          case when base.all_variants then
                 (select coalesce(sum(warehouse_principal_qty(v_store, base.pid, ps.variant_id)), 0)
                    from product_stock ps
                   where ps.store_id = v_store and ps.product_id = base.pid)
               else warehouse_principal_qty(v_store, base.pid, base.vid) end
        when p_warehouse_id is not null then
          (select coalesce(sum(ws.qty), 0) from warehouse_stock ws
            where ws.warehouse_id = p_warehouse_id and ws.product_id = base.pid
              and (base.all_variants or ws.variant_id is not distinct from base.vid))
        when v_store is not null then
          (select coalesce(sum(ps.qty), 0) from product_stock ps
            where ps.store_id = v_store and ps.product_id = base.pid
              and (base.all_variants or ps.variant_id is not distinct from base.vid))
        else coalesce(
          (select sum(ps.qty) from product_stock ps
            where ps.tenant_id = v_tenant and ps.product_id = base.pid
              and (base.all_variants or ps.variant_id is not distinct from base.vid)),
          case when base.vid is null then base.pstock else base.vstock end)
      end as qty
      from base
  )
  select s.pid, s.vid, s.pname, s.vlabel, s.bname, s.cname, s.psku, s.pbarcode, s.pplu, s.punit,
         s.pprice, s.pimage, s.pnet, s.pnetu, s.qty
    from scoped s
   where not coalesce(p_only_stock, false) or coalesce(s.qty, 0) > 0
   order by s.pname, s.vlabel nulls first
   limit v_limit;
end;
$$;
revoke all on function label_catalog(uuid, uuid, uuid[], uuid[], text, boolean, boolean, uuid[], int) from public, anon;
grant execute on function label_catalog(uuid, uuid, uuid[], uuid[], text, boolean, boolean, uuid[], int) to authenticated, service_role;

-- 5. Ficha pública del producto (QR) ------------------------------------------
create or replace function public.public_product_sheet(p_slug text, p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_t record;
  v_p record;
  v_list_id uuid;
  v_list_adj numeric;
  v_price numeric;
  v_ordering boolean;
  v_catalog boolean;
begin
  if p_slug is null or p_product is null then
    return null;
  end if;

  select t.id, t.name, t.slug into v_t
    from tenants t
   where t.slug = p_slug and t.deleted_at is null and t.status in ('trial', 'active')
     and tenant_has_feature_for(t.id, 'etiquetas_pro')
   limit 1;
  if not found then
    return null;
  end if;

  select p.id, p.name, p.description, p.price, p.unit, p.image_url, p.has_variants,
         p.net_content, p.net_content_unit, b.name as brand, c.name as category
    into v_p
    from products p
    left join brands b on b.id = p.brand_id
    left join categories c on c.id = p.category_id
   where p.id = p_product and p.tenant_id = v_t.id and p.deleted_at is null and p.is_active;
  if not found then
    return null;
  end if;

  select pl.id, pl.adjustment_pct into v_list_id, v_list_adj
    from price_lists pl
   where pl.tenant_id = v_t.id and pl.channel = 'catalogo' and pl.is_active and pl.deleted_at is null
   limit 1;
  v_price := _catalog_unit_price(v_list_id, v_list_adj, v_p.id, null, v_p.price);
  v_catalog := tenant_has_feature_for(v_t.id, 'catalogo_publico');
  v_ordering := _catalog_ordering(v_t.id);

  return jsonb_build_object(
    'tenant', jsonb_build_object('name', v_t.name, 'slug', v_t.slug),
    'branding', (
      select jsonb_build_object('logo_url', tb.logo_url, 'accent', tb.accent, 'legal_name', tb.legal_name,
                                'trade_name', tb.trade_name, 'phone', tb.phone, 'address', tb.address)
        from tenant_branding tb where tb.tenant_id = v_t.id
    ),
    'product', jsonb_build_object(
      'id', v_p.id,
      'name', v_p.name,
      'description', v_p.description,
      'brand', v_p.brand,
      'category', v_p.category,
      'unit', v_p.unit,
      'price', v_price,
      'net_content', v_p.net_content,
      'net_content_unit', v_p.net_content_unit,
      'images', coalesce((
        select jsonb_agg(x.url order by x.is_primary desc, x.sort, x.created_at)
          from (
            select pi.url, pi.is_primary, pi.sort, pi.created_at
              from product_images pi
             where pi.tenant_id = v_t.id and pi.product_id = v_p.id and pi.deleted_at is null
               and pi.url is not null
             limit 8
          ) x
      ), case when v_p.image_url is not null then jsonb_build_array(v_p.image_url) else '[]'::jsonb end),
      'variants', case when v_p.has_variants then (
        select jsonb_agg(jsonb_build_object(
                 'label', nullif(btrim(concat_ws(' / ', nullif(pv.option1, ''), nullif(pv.option2, ''))), ''),
                 'price', _catalog_unit_price(v_list_id, v_list_adj, v_p.id, pv.id, coalesce(pv.price_override, v_p.price)))
               order by pv.option1, pv.option2)
          from product_variants pv
         where pv.product_id = v_p.id and pv.tenant_id = v_t.id and pv.deleted_at is null
      ) end
    ),
    'payments', jsonb_build_object(
      'methods', coalesce((
        select jsonb_agg(jsonb_build_object('key', pp.key, 'name', pp.name, 'kind', pp.kind,
                                            'surcharge_pct', coalesce(tpm.surcharge_pct, 0))
                         order by tpm.sort, pp.sort)
          from tenant_payment_methods tpm
          join payment_providers pp on pp.key = tpm.provider_key and pp.is_active
         where tpm.tenant_id = v_t.id and tpm.enabled
      ), '[]'::jsonb),
      'plans', coalesce((
        select jsonb_agg(jsonb_build_object('label', pl.label, 'base', pl.base, 'brand', pl.brand,
                                            'installments', pl.installments, 'surcharge_pct', pl.surcharge_pct,
                                            'provider_key', pl.provider_key)
                         order by pl.sort, pl.installments)
          from payment_plans pl
         where pl.tenant_id = v_t.id and pl.is_active and pl.store_id is null
           and (pl.valid_from is null or pl.valid_from <= current_date)
           and (pl.valid_until is null or pl.valid_until >= current_date)
      ), '[]'::jsonb)
    ),
    'catalog', jsonb_build_object('enabled', v_catalog, 'ordering', coalesce(v_ordering, false))
  );
end;
$function$;
revoke all on function public.public_product_sheet(text, uuid) from public;
grant execute on function public.public_product_sheet(text, uuid) to anon, authenticated;
