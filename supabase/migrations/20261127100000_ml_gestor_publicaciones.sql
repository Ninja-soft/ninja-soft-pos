-- =============================================================================
-- 20261127100000_ml_gestor_publicaciones  (H141 · ADR-132 · Gestor de Mercado Libre, parte A)
--
-- Publicaciones del gestor de Mercado Libre (docs/41-mercadolibre-gestor.md):
--
--   A) ml_listing_rules: reglas de precio por tipo de publicación y por
--      cuenta (gold_special Clásica, gold_pro Premium...): recargo % sobre el
--      precio base de la cuenta o una lista de precios propia, redondeo hacia
--      arriba al múltiplo, precio mínimo y si se ofrece por defecto al
--      publicar. Sin regla, el tipo usa el precio base (comportamiento de
--      ADR-104).
--   B) ml_product_listing_prices: override por producto y tipo (heredar,
--      recargo propio, lista propia, precio fijo o no publicar en ese tipo).
--   C) Stock publicable: % de reserva y tope por publicación en
--      ml_location_map (además de la reserva fija de ADR-104).
--   D) ml_category_memory: la última categoría usada y los valores de los
--      atributos por categoría para precompletar la publicación rápida.
--   E) ml_items: visitas de los últimos 30 días (lectura de ML a pedido).
--   F) Funciones: _ml_listing_price (espejo exacto de
--      lib/mercadolibre/pricing.ts), _ml_available_qty y
--      ml_item_price_snapshot recreadas (el precio de cada publicación sale
--      de SU tipo), trigger de precio que también mira las listas de las
--      reglas, vista previa con precios por tipo, candidatos para la
--      publicación rápida y RPC de configuración (auditadas).
--
-- Gating: feature `mercadolibre` (ADR-104) en cada RPC de la UI (ml_assert) y
-- en la Edge (ml_edge_guard). La publicación es parte de la integración base,
-- no del gestor (ver ADR-132).
-- Seguridad: tenant_id NOT NULL sin default (P3/P8), RLS de lectura con
-- "(select current_tenant_id())", sin policies de escritura (sólo RPC
-- SECURITY DEFINER o service_role), role_write_guard, índice en cada FK.
-- Nunca "OR is_internal()".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Reglas de precio por tipo de publicación.
-- -----------------------------------------------------------------------------
create table if not exists ml_listing_rules (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  account_id       uuid not null references ml_accounts(id) on delete cascade,
  listing_type_id  text not null check (listing_type_id ~ '^[a-z_]{2,30}$'),
  enabled          boolean not null default true,
  -- markup: precio base de la cuenta + recargo. price_list: precio de la
  -- lista elegida (+ recargo, si hay).
  mode             text not null default 'markup' check (mode in ('markup', 'price_list')),
  markup_pct       numeric(7,2) not null default 0 check (markup_pct between -90 and 500),
  price_list_id    uuid references price_lists(id) on delete set null,
  -- 0 = usa el redondeo de la cuenta.
  rounding         numeric(12,2) not null default 0 check (rounding >= 0),
  min_price        numeric(14,2) not null default 0 check (min_price >= 0),
  -- Se tilda solo en la publicación rápida.
  default_on       boolean not null default false,
  sort             integer not null default 0,
  updated_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ml_listing_rules_list_ck check (mode <> 'price_list' or price_list_id is not null)
);
comment on table ml_listing_rules is
  'ADR-132: precio por tipo de publicación de una cuenta de ML (recargo % o lista propia, redondeo y mínimo).';
create unique index if not exists ml_listing_rules_uq on ml_listing_rules (account_id, listing_type_id);
create index if not exists ml_listing_rules_tenant_idx on ml_listing_rules (tenant_id, created_at);
create index if not exists ml_listing_rules_list_idx on ml_listing_rules (price_list_id) where price_list_id is not null;
create index if not exists ml_listing_rules_updated_by_idx on ml_listing_rules (updated_by) where updated_by is not null;
drop trigger if exists set_updated_at_ml_listing_rules on ml_listing_rules;
create trigger set_updated_at_ml_listing_rules before update on ml_listing_rules
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- B) Override por producto y tipo.
-- -----------------------------------------------------------------------------
create table if not exists ml_product_listing_prices (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  account_id       uuid not null references ml_accounts(id) on delete cascade,
  product_id       uuid not null references products(id) on delete cascade,
  listing_type_id  text not null check (listing_type_id ~ '^[a-z_]{2,30}$'),
  mode             text not null default 'inherit'
                     check (mode in ('inherit', 'markup', 'price_list', 'fixed', 'skip')),
  markup_pct       numeric(7,2) check (markup_pct is null or markup_pct between -90 and 500),
  price_list_id    uuid references price_lists(id) on delete set null,
  fixed_price      numeric(14,2) check (fixed_price is null or fixed_price > 0),
  min_price        numeric(14,2) check (min_price is null or min_price >= 0),
  updated_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ml_product_listing_prices_ck check (
    (mode <> 'fixed' or fixed_price is not null) and (mode <> 'price_list' or price_list_id is not null))
);
comment on table ml_product_listing_prices is
  'ADR-132: override del precio de un producto en un tipo de publicación (heredar, recargo, lista, fijo o no publicar).';
create unique index if not exists ml_product_listing_prices_uq
  on ml_product_listing_prices (account_id, product_id, listing_type_id);
create index if not exists ml_product_listing_prices_tenant_idx on ml_product_listing_prices (tenant_id, created_at);
create index if not exists ml_product_listing_prices_product_idx on ml_product_listing_prices (product_id);
create index if not exists ml_product_listing_prices_list_idx on ml_product_listing_prices (price_list_id) where price_list_id is not null;
create index if not exists ml_product_listing_prices_updated_by_idx on ml_product_listing_prices (updated_by) where updated_by is not null;
drop trigger if exists set_updated_at_ml_product_listing_prices on ml_product_listing_prices;
create trigger set_updated_at_ml_product_listing_prices before update on ml_product_listing_prices
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- C) Stock publicable: % de reserva y tope.
-- -----------------------------------------------------------------------------
alter table ml_location_map add column if not exists reserve_pct numeric(5,2) not null default 0
  check (reserve_pct between 0 and 95);
alter table ml_location_map add column if not exists max_qty integer
  check (max_qty is null or max_qty >= 0);
comment on column ml_location_map.reserve_pct is
  'ADR-132: porcentaje del stock (después de la reserva fija) que no se publica.';
comment on column ml_location_map.max_qty is
  'ADR-132: tope de unidades publicadas por publicación (null = sin tope).';

-- -----------------------------------------------------------------------------
-- D) Memoria de categorías y atributos.
-- -----------------------------------------------------------------------------
create table if not exists ml_category_memory (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  account_id     uuid not null references ml_accounts(id) on delete cascade,
  category_id    text not null check (category_id ~ '^[A-Z]{3}\d{1,12}$'),
  category_name  text not null default '' check (char_length(category_name) <= 200),
  -- {ATTR_ID: {value_id, value_name}} de la última publicación en la categoría.
  attrs          jsonb not null default '{}'::jsonb,
  uses           integer not null default 0,
  last_used_at   timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
create unique index if not exists ml_category_memory_uq on ml_category_memory (account_id, category_id);
create index if not exists ml_category_memory_tenant_idx on ml_category_memory (tenant_id, last_used_at desc);

-- -----------------------------------------------------------------------------
-- E) Visitas.
-- -----------------------------------------------------------------------------
alter table ml_items add column if not exists visits_30d integer check (visits_30d is null or visits_30d >= 0);
alter table ml_items add column if not exists visits_synced_at timestamptz;

-- -----------------------------------------------------------------------------
-- RLS (lectura del negocio activo) y escritura sólo por RPC.
-- -----------------------------------------------------------------------------
alter table ml_listing_rules          enable row level security;
alter table ml_product_listing_prices enable row level security;
alter table ml_category_memory        enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ml_listing_rules', 'ml_product_listing_prices', 'ml_category_memory'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (tenant_id = (select current_tenant_id()))',
      t || '_select', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- F) Funciones.
-- -----------------------------------------------------------------------------

-- Redondeo hacia arriba al múltiplo (0 = sin redondeo). Espejo: roundUp().
create or replace function _ml_round_up(p_value numeric, p_step numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_value is null then null
              when coalesce(p_step, 0) > 0 then ceil(p_value / p_step) * p_step
              else p_value end;
$$;
revoke all on function _ml_round_up(numeric, numeric) from public, anon, authenticated;

-- Precio de un producto/variante en un tipo de publicación. null = no se
-- publica en ese tipo (override 'skip') o no hay precio.
-- Espejo exacto de listingPrice() en lib/mercadolibre/pricing.ts:
--   1. override skip -> null; fixed -> precio fijo (sin redondeo; el mínimo
--      del override aplica igual).
--   2. base: lista (del override o de la regla, si el modo es price_list) o
--      el precio base de la cuenta (_ml_price_for: lista de la cuenta o POS
--      con el margen, ya redondeado con el redondeo de la cuenta).
--   3. recargo: el del override si es 'markup', si no el de la regla.
--   4. redondeo de la regla (o el de la cuenta si la regla tiene 0).
--   5. mínimo: el del override si viene, si no el de la regla.
create or replace function _ml_listing_price(p_acc ml_accounts, p_product uuid, p_variant uuid, p_listing text)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule  ml_listing_rules%rowtype;
  v_ov    ml_product_listing_prices%rowtype;
  v_mode  text;
  v_list  uuid;
  v_pct   numeric := 0;
  v_min   numeric := 0;
  v_step  numeric;
  v       numeric;
begin
  select * into v_rule from ml_listing_rules r
   where r.account_id = p_acc.id and r.listing_type_id = p_listing and r.enabled;
  select * into v_ov from ml_product_listing_prices o
   where o.account_id = p_acc.id and o.product_id = p_product and o.listing_type_id = p_listing;

  if v_ov.id is not null and v_ov.mode = 'skip' then
    return null;
  end if;
  v_min := coalesce(v_ov.min_price, v_rule.min_price, 0);
  if v_ov.id is not null and v_ov.mode = 'fixed' then
    return round(greatest(v_ov.fixed_price, v_min), 2);
  end if;

  if v_ov.id is not null and v_ov.mode = 'price_list' then
    v_mode := 'price_list'; v_list := v_ov.price_list_id;
  elsif v_rule.id is not null and v_rule.mode = 'price_list' then
    v_mode := 'price_list'; v_list := v_rule.price_list_id;
  else
    v_mode := 'markup';
  end if;

  if v_mode = 'price_list' and v_list is not null then
    v := _resolve_unit_price(p_acc.tenant_id, p_product, p_variant, 1, null, null, v_list, now());
  else
    v := _ml_price_for(p_acc, p_product, p_variant);
  end if;
  if v is null then return null; end if;

  if v_ov.id is not null and v_ov.mode = 'markup' then
    v_pct := coalesce(v_ov.markup_pct, 0);
  elsif v_ov.id is not null and v_ov.mode = 'price_list' then
    v_pct := coalesce(v_ov.markup_pct, 0);
  else
    v_pct := coalesce(v_rule.markup_pct, 0);
  end if;
  if v_pct <> 0 then
    v := v * (1 + v_pct / 100);
  end if;

  v_step := case when coalesce(v_rule.rounding, 0) > 0 then v_rule.rounding else coalesce(p_acc.price_rounding, 0) end;
  if v_pct <> 0 or v_mode = 'price_list' then
    v := _ml_round_up(v, v_step);
  end if;
  return round(greatest(v, v_min), 2);
end;
$$;
revoke all on function _ml_listing_price(ml_accounts, uuid, uuid, text) from public, anon, authenticated;

-- Copia de 20261110400200 (ADR-104) + % de reserva y tope (ADR-132). Espejo:
-- publishableQty() en lib/mercadolibre/pricing.ts.
create or replace function _ml_available_qty(p_map ml_location_map, p_product uuid, p_variant uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_track  boolean;
  v_store  uuid := coalesce(p_map.store_id, stock_default_store(p_map.tenant_id));
  v_wh     warehouses%rowtype;
  v_qty    numeric;
begin
  select coalesce(p.track_stock, true) into v_track from products p
   where p.id = p_product and p.tenant_id = p_map.tenant_id and p.deleted_at is null;
  if v_track is null or not v_track or v_store is null then
    return null;
  end if;
  if p_map.warehouse_id is not null then
    select * into v_wh from warehouses w where w.id = p_map.warehouse_id and w.deleted_at is null;
  end if;
  if v_wh.id is not null and v_wh.kind <> 'principal' then
    v_qty := coalesce((select ws.qty from warehouse_stock ws
                        where ws.warehouse_id = v_wh.id and ws.product_id = p_product
                          and ws.variant_id is not distinct from p_variant), 0);
  elsif v_wh.id is not null then
    v_qty := warehouse_principal_qty(v_wh.store_id, p_product, p_variant)
             - stock_reserved_qty(v_wh.store_id, p_product, p_variant, null);
  else
    v_qty := coalesce((select ps.qty from product_stock ps
                        where ps.store_id = v_store and ps.product_id = p_product
                          and ps.variant_id is not distinct from p_variant), 0)
             - stock_reserved_qty(v_store, p_product, p_variant, null);
  end if;
  v_qty := greatest(floor(coalesce(v_qty, 0) - coalesce(p_map.reserve_qty, 0)), 0);
  if coalesce(p_map.reserve_pct, 0) > 0 then
    v_qty := floor(v_qty * (1 - p_map.reserve_pct / 100));
  end if;
  if p_map.max_qty is not null then
    v_qty := least(v_qty, p_map.max_qty);
  end if;
  return greatest(v_qty, 0)::integer;
end;
$$;
revoke all on function _ml_available_qty(ml_location_map, uuid, uuid) from public, anon, authenticated;

-- Copia de 20261110400200 con el precio del tipo de la publicación (ADR-132).
create or replace function ml_item_price_snapshot(p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_item ml_items%rowtype;
  v_acc  ml_accounts%rowtype;
begin
  select * into v_item from ml_items where id = p_item;
  if v_item.id is null then return null; end if;
  select * into v_acc from ml_accounts where id = v_item.account_id;
  return jsonb_build_object(
    'ml_item_id', v_item.ml_item_id,
    'price_source', v_item.price_source,
    'has_variations', v_item.has_variations,
    'listing_type_id', v_item.listing_type_id,
    'push_enabled', v_acc.deleted_at is null and v_acc.status = 'active' and v_acc.price_sync
                    and v_item.price_source = 'pos'
                    and tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre'),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('ml_variation_id', l.ml_variation_id::text,
                                          'price', case when v_item.listing_type_id is null
                                                        then _ml_price_for(v_acc, l.product_id, l.variant_id)
                                                        else _ml_listing_price(v_acc, l.product_id, l.variant_id,
                                                                               v_item.listing_type_id) end)
                       order by l.ml_variation_id nulls first)
        from ml_item_links l where l.item_id = p_item), '[]'::jsonb));
end;
$$;
revoke all on function ml_item_price_snapshot(uuid) from public, anon, authenticated;
grant execute on function ml_item_price_snapshot(uuid) to service_role;

-- Copia de 20261110400200: una lista de precios también dispara el push si la
-- usa una regla por tipo o un override de producto (ADR-132).
create or replace function trg_ml_price_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid;
  v_product uuid;
  v_variant uuid;
  v_list    uuid;
begin
  if tg_table_name = 'products' then
    v_tenant := new.tenant_id; v_product := new.id; v_variant := null;
  elsif tg_table_name = 'product_variants' then
    v_tenant := new.tenant_id; v_product := new.product_id; v_variant := new.id;
  else
    if tg_op = 'DELETE' then
      v_tenant := old.tenant_id; v_product := old.product_id; v_variant := old.variant_id; v_list := old.price_list_id;
    else
      v_tenant := new.tenant_id; v_product := new.product_id; v_variant := new.variant_id; v_list := new.price_list_id;
    end if;
    if not exists (select 1 from ml_accounts a where a.tenant_id = v_tenant and a.price_list_id = v_list
                                                 and a.deleted_at is null)
       and not exists (select 1 from ml_listing_rules r where r.tenant_id = v_tenant and r.price_list_id = v_list)
       and not exists (select 1 from ml_product_listing_prices o where o.tenant_id = v_tenant
                                                                   and o.price_list_id = v_list) then
      return null;
    end if;
  end if;
  if not exists (select 1 from ml_item_links l where l.product_id = v_product) then
    return null;
  end if;
  begin
    perform _ml_enqueue_item_pushes(v_tenant, v_product, v_variant, 'price_push');
  exception when others then
    raise warning 'trg_ml_price_change: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_ml_price_change() from public, anon, authenticated;

-- Precios por tipo de un producto (y sus variantes) para una cuenta.
-- Interno: lo usan la vista previa (UI) y la Edge al publicar.
create or replace function _ml_listing_prices_json(p_acc ml_accounts, p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_types text[];
  v_out   jsonb := '[]'::jsonb;
  t       text;
begin
  select array_agg(distinct x) into v_types from (
    select unnest(array['gold_special', 'gold_pro']) x
    union select r.listing_type_id from ml_listing_rules r where r.account_id = p_acc.id and r.enabled
    union select p_acc.default_listing_type
  ) s;
  foreach t in array v_types loop
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'listing_type_id', t,
      'rule', (select jsonb_build_object('enabled', r.enabled, 'mode', r.mode, 'markup_pct', r.markup_pct,
                                         'price_list_id', r.price_list_id, 'rounding', r.rounding,
                                         'min_price', r.min_price, 'default_on', r.default_on)
                 from ml_listing_rules r where r.account_id = p_acc.id and r.listing_type_id = t),
      'override', (select jsonb_build_object('mode', o.mode, 'markup_pct', o.markup_pct, 'price_list_id', o.price_list_id,
                                             'fixed_price', o.fixed_price, 'min_price', o.min_price)
                     from ml_product_listing_prices o
                    where o.account_id = p_acc.id and o.product_id = p_product and o.listing_type_id = t),
      'price', _ml_listing_price(p_acc, p_product, null, t),
      'variants', coalesce((select jsonb_object_agg(v.id::text, _ml_listing_price(p_acc, p_product, v.id, t))
                              from product_variants v where v.product_id = p_product and v.deleted_at is null), '{}'::jsonb)));
  end loop;
  return v_out;
end;
$$;
revoke all on function _ml_listing_prices_json(ml_accounts, uuid) from public, anon, authenticated;

-- Edge (service_role): precios por tipo al publicar (el servidor no confía en
-- el precio que manda el navegador).
create or replace function ml_listing_prices_for(p_account uuid, p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc ml_accounts%rowtype;
begin
  select * into v_acc from ml_accounts where id = p_account and deleted_at is null;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  if not exists (select 1 from products p where p.id = p_product and p.tenant_id = v_acc.tenant_id and p.deleted_at is null) then
    raise exception 'product_not_found';
  end if;
  return _ml_listing_prices_json(v_acc, p_product);
end;
$$;
revoke all on function ml_listing_prices_for(uuid, uuid) from public, anon, authenticated;
grant execute on function ml_listing_prices_for(uuid, uuid) to service_role;

-- Copia de 20261110400200 + marca, modelo, precios por tipo y stock
-- publicable con la regla nueva (ADR-132).
create or replace function ml_product_channel_preview(p_account uuid, p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_acc    ml_accounts%rowtype;
  v_map    ml_location_map%rowtype;
  v_prod   products%rowtype;
begin
  select * into v_acc from ml_accounts where id = p_account and tenant_id = v_tenant and deleted_at is null;
  if v_acc.id is null then raise exception 'not_found'; end if;
  select * into v_prod from products where id = p_product and tenant_id = v_tenant and deleted_at is null;
  if v_prod.id is null then raise exception 'product_not_found'; end if;
  select * into v_map from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  return jsonb_build_object(
    'product_id', v_prod.id, 'name', v_prod.name, 'description', v_prod.description,
    'sku', v_prod.sku, 'barcode', v_prod.barcode, 'is_kit', coalesce(v_prod.is_kit, false),
    'has_variants', coalesce(v_prod.has_variants, false),
    'brand', (select b.name from brands b where b.id = v_prod.brand_id),
    'model', v_prod.model,
    'warranty_months', v_prod.warranty_months,
    'price', _ml_price_for(v_acc, v_prod.id, null),
    'qty', case when v_map.id is null then null else _ml_available_qty(v_map, v_prod.id, null) end,
    'listing_type', v_acc.default_listing_type,
    'user_product_seller', v_acc.user_product_seller,
    'listing_prices', _ml_listing_prices_json(v_acc, v_prod.id),
    'pictures', coalesce((select jsonb_agg(i.url order by i.is_primary desc, i.sort, i.created_at)
                            from product_images i where i.product_id = v_prod.id and i.deleted_at is null), '[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object(
                             'variant_id', v.id, 'option1', v.option1, 'option2', v.option2, 'sku', v.sku,
                             'barcode', v.barcode, 'price', _ml_price_for(v_acc, v_prod.id, v.id),
                             'qty', case when v_map.id is null then null else _ml_available_qty(v_map, v_prod.id, v.id) end)
                           order by v.option1, v.option2)
                            from product_variants v where v.product_id = v_prod.id and v.deleted_at is null), '[]'::jsonb),
    'links', coalesce((select jsonb_agg(jsonb_build_object('link_id', l.id, 'item_id', i.id, 'ml_item_id', i.ml_item_id,
                                                           'variant_id', l.variant_id, 'title', i.title, 'status', i.status,
                                                           'permalink', i.permalink, 'listing_type_id', i.listing_type_id))
                         from ml_item_links l join ml_items i on i.id = l.item_id
                        where l.product_id = v_prod.id and l.account_id = p_account), '[]'::jsonb));
end;
$$;
revoke all on function ml_product_channel_preview(uuid, uuid) from public, anon;
grant execute on function ml_product_channel_preview(uuid, uuid) to authenticated;

-- Reglas por tipo de una cuenta (reemplaza todas). p: [{listing_type_id,
-- enabled, mode, markup_pct, price_list_id, rounding, min_price, default_on}]
create or replace function ml_listing_rules_save(p_account uuid, p_rules jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_acc    ml_accounts%rowtype;
  v_before jsonb;
  v_r      jsonb;
  v_types  text[] := '{}';
  v_type   text;
  v_mode   text;
  v_list   uuid;
  v_n      int := 0;
  r        record;
begin
  perform assert_account_active(v_tenant);
  select * into v_acc from ml_accounts where id = p_account and tenant_id = v_tenant and deleted_at is null for update;
  if v_acc.id is null then raise exception 'not_found'; end if;
  if jsonb_typeof(coalesce(p_rules, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rules, '[]'::jsonb)) > 10 then
    raise exception 'invalid_rules';
  end if;
  select coalesce(jsonb_agg(to_jsonb(r0) - 'tenant_id' - 'id' order by r0.sort), '[]'::jsonb) into v_before
    from ml_listing_rules r0 where r0.account_id = p_account;

  for v_r in select value from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) loop
    v_type := v_r ->> 'listing_type_id';
    if v_type is null or v_type !~ '^[a-z_]{2,30}$' or v_type = any (v_types) then raise exception 'invalid_listing_type'; end if;
    v_types := v_types || v_type;
    v_mode := coalesce(nullif(v_r ->> 'mode', ''), 'markup');
    if v_mode not in ('markup', 'price_list') then raise exception 'invalid_mode'; end if;
    v_list := nullif(v_r ->> 'price_list_id', '')::uuid;
    if v_mode = 'price_list' and v_list is null then raise exception 'price_list_required'; end if;
    if v_list is not null and not exists (select 1 from price_lists l where l.id = v_list and l.tenant_id = v_tenant) then
      raise exception 'invalid_price_list';
    end if;
    insert into ml_listing_rules (tenant_id, account_id, listing_type_id, enabled, mode, markup_pct, price_list_id,
                                  rounding, min_price, default_on, sort, updated_by)
    values (v_tenant, p_account, v_type, coalesce((v_r ->> 'enabled')::boolean, true), v_mode,
            coalesce((v_r ->> 'markup_pct')::numeric, 0), case when v_mode = 'price_list' then v_list else null end,
            greatest(coalesce((v_r ->> 'rounding')::numeric, 0), 0), greatest(coalesce((v_r ->> 'min_price')::numeric, 0), 0),
            coalesce((v_r ->> 'default_on')::boolean, false), v_n, auth.uid())
    on conflict (account_id, listing_type_id) do update
      set enabled = excluded.enabled, mode = excluded.mode, markup_pct = excluded.markup_pct,
          price_list_id = excluded.price_list_id, rounding = excluded.rounding, min_price = excluded.min_price,
          default_on = excluded.default_on, sort = excluded.sort, updated_by = excluded.updated_by;
    v_n := v_n + 1;
  end loop;
  delete from ml_listing_rules where account_id = p_account and not (listing_type_id = any (v_types));

  -- Los precios por tipo cambiaron: se reenvían las publicaciones vinculadas.
  if v_acc.price_sync then
    for r in select distinct l.item_id from ml_item_links l where l.account_id = p_account loop
      perform _ml_enqueue(v_tenant, p_account, 'price_push', 'price_push:' || r.item_id::text, null,
                          jsonb_build_object('item_id', r.item_id), 5, auth.uid());
    end loop;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'ml_accounts', p_account, 'ml_listing_rules_saved', v_before, p_rules);
  return jsonb_build_object('ok', true, 'count', v_n);
end;
$$;
revoke all on function ml_listing_rules_save(uuid, jsonb) from public, anon;
grant execute on function ml_listing_rules_save(uuid, jsonb) to authenticated;

-- Override de un producto (reemplaza los de ese producto en la cuenta).
-- p: [{listing_type_id, mode, markup_pct, price_list_id, fixed_price, min_price}]
-- mode 'inherit' borra el override.
create or replace function ml_product_listing_save(p_account uuid, p_product uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_acc    ml_accounts%rowtype;
  v_before jsonb;
  v_r      jsonb;
  v_mode   text;
  v_list   uuid;
  v_fixed  numeric;
  r        record;
begin
  perform assert_account_active(v_tenant);
  select * into v_acc from ml_accounts where id = p_account and tenant_id = v_tenant and deleted_at is null;
  if v_acc.id is null then raise exception 'not_found'; end if;
  if not exists (select 1 from products x where x.id = p_product and x.tenant_id = v_tenant and x.deleted_at is null) then
    raise exception 'product_not_found';
  end if;
  if jsonb_typeof(coalesce(p, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p, '[]'::jsonb)) > 10 then
    raise exception 'invalid_overrides';
  end if;
  select coalesce(jsonb_agg(to_jsonb(o) - 'tenant_id' - 'id'), '[]'::jsonb) into v_before
    from ml_product_listing_prices o where o.account_id = p_account and o.product_id = p_product;
  delete from ml_product_listing_prices where account_id = p_account and product_id = p_product;
  for v_r in select value from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    v_mode := coalesce(nullif(v_r ->> 'mode', ''), 'inherit');
    if v_mode not in ('inherit', 'markup', 'price_list', 'fixed', 'skip') then raise exception 'invalid_mode'; end if;
    if coalesce(v_r ->> 'listing_type_id', '') !~ '^[a-z_]{2,30}$' then raise exception 'invalid_listing_type'; end if;
    continue when v_mode = 'inherit' and nullif(v_r ->> 'min_price', '') is null;
    v_list := nullif(v_r ->> 'price_list_id', '')::uuid;
    v_fixed := nullif(v_r ->> 'fixed_price', '')::numeric;
    if v_mode = 'price_list' and (v_list is null or not exists (
         select 1 from price_lists l where l.id = v_list and l.tenant_id = v_tenant)) then
      raise exception 'invalid_price_list';
    end if;
    if v_mode = 'fixed' and not (v_fixed > 0) then raise exception 'invalid_fixed_price'; end if;
    insert into ml_product_listing_prices (tenant_id, account_id, product_id, listing_type_id, mode, markup_pct,
                                           price_list_id, fixed_price, min_price, updated_by)
    values (v_tenant, p_account, p_product, v_r ->> 'listing_type_id', v_mode,
            case when v_mode in ('markup', 'price_list') then nullif(v_r ->> 'markup_pct', '')::numeric end,
            case when v_mode = 'price_list' then v_list end,
            case when v_mode = 'fixed' then v_fixed end,
            nullif(v_r ->> 'min_price', '')::numeric, auth.uid())
    on conflict (account_id, product_id, listing_type_id) do nothing;
  end loop;

  for r in select distinct l.item_id from ml_item_links l where l.account_id = p_account and l.product_id = p_product loop
    perform _ml_enqueue(v_tenant, p_account, 'price_push', 'price_push:' || r.item_id::text, null,
                        jsonb_build_object('item_id', r.item_id), 5, auth.uid());
  end loop;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'products', p_product, 'ml_product_listing_saved', v_before,
          jsonb_build_object('account_id', p_account, 'overrides', p));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_product_listing_save(uuid, uuid, jsonb) from public, anon;
grant execute on function ml_product_listing_save(uuid, uuid, jsonb) to authenticated;

-- Copia de 20261110400200 + reserve_pct y max_qty (ADR-132).
create or replace function ml_account_settings_save(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_acc    ml_accounts%rowtype;
  v_before jsonb;
  v_store  uuid := nullif(p ->> 'store_id', '')::uuid;
  v_wh     uuid := nullif(p ->> 'warehouse_id', '')::uuid;
  v_list   uuid := nullif(p ->> 'price_list_id', '')::uuid;
  v_pct    numeric := nullif(p ->> 'reserve_pct', '')::numeric;
  v_max    integer := nullif(p ->> 'max_qty', '')::integer;
  v_map    ml_location_map%rowtype;
  r        record;
begin
  perform assert_account_active(v_tenant);
  select * into v_acc from ml_accounts where id = p_account and tenant_id = v_tenant and deleted_at is null for update;
  if v_acc.id is null then raise exception 'not_found'; end if;
  if v_store is not null and not exists (select 1 from stores s where s.id = v_store and s.tenant_id = v_tenant and s.deleted_at is null) then
    raise exception 'invalid_store';
  end if;
  if v_wh is not null and not exists (select 1 from warehouses w where w.id = v_wh and w.tenant_id = v_tenant
                                                               and w.deleted_at is null
                                                               and w.store_id = coalesce(v_store, w.store_id)) then
    raise exception 'invalid_warehouse';
  end if;
  if v_list is not null and not exists (select 1 from price_lists l where l.id = v_list and l.tenant_id = v_tenant) then
    raise exception 'invalid_price_list';
  end if;
  if coalesce(p ->> 'invoice_mode', v_acc.invoice_mode) not in ('on_paid', 'on_shipped', 'manual', 'none') then
    raise exception 'invalid_invoice_mode';
  end if;
  if v_pct is not null and (v_pct < 0 or v_pct > 95) then raise exception 'invalid_reserve_pct'; end if;
  if v_max is not null and v_max < 0 then raise exception 'invalid_max_qty'; end if;
  select * into v_map from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  v_before := to_jsonb(v_acc) - 'tags' || jsonb_build_object('store_id', v_map.store_id, 'warehouse_id', v_map.warehouse_id,
                                                            'reserve_qty', v_map.reserve_qty, 'reserve_pct', v_map.reserve_pct,
                                                            'max_qty', v_map.max_qty);

  update ml_accounts
     set price_list_id = case when p ? 'price_list_id' then v_list else price_list_id end,
         price_markup_pct = coalesce((p ->> 'price_markup_pct')::numeric, price_markup_pct),
         price_rounding = coalesce((p ->> 'price_rounding')::numeric, price_rounding),
         price_sync = coalesce((p ->> 'price_sync')::boolean, price_sync),
         stock_sync = coalesce((p ->> 'stock_sync')::boolean, stock_sync),
         invoice_mode = coalesce(nullif(p ->> 'invoice_mode', ''), invoice_mode),
         upload_invoice = coalesce((p ->> 'upload_invoice')::boolean, upload_invoice),
         default_listing_type = coalesce(nullif(p ->> 'default_listing_type', ''), default_listing_type),
         label_format = coalesce(nullif(p ->> 'label_format', ''), label_format)
   where id = p_account
  returning * into v_acc;

  if v_map.id is null then
    insert into ml_location_map (tenant_id, account_id, location_type, store_id, warehouse_id, reserve_qty, reserve_pct, max_qty)
    values (v_tenant, p_account, 'item_stock', coalesce(v_store, stock_default_store(v_tenant)), v_wh,
            greatest(coalesce((p ->> 'reserve_qty')::numeric, 0), 0), coalesce(v_pct, 0), v_max);
  else
    update ml_location_map
       set store_id = case when p ? 'store_id' then coalesce(v_store, stock_default_store(v_tenant)) else store_id end,
           warehouse_id = case when p ? 'warehouse_id' or p ? 'store_id' then v_wh else warehouse_id end,
           reserve_qty = greatest(coalesce((p ->> 'reserve_qty')::numeric, reserve_qty), 0),
           reserve_pct = case when p ? 'reserve_pct' then coalesce(v_pct, 0) else reserve_pct end,
           max_qty = case when p ? 'max_qty' then v_max else max_qty end
     where id = v_map.id;
  end if;

  for r in select distinct l.item_id from ml_item_links l where l.account_id = p_account loop
    if v_acc.stock_sync then
      perform _ml_enqueue(v_tenant, p_account, 'stock_push', 'stock_push:' || r.item_id::text, null,
                          jsonb_build_object('item_id', r.item_id), 5, auth.uid());
    end if;
    if v_acc.price_sync then
      perform _ml_enqueue(v_tenant, p_account, 'price_push', 'price_push:' || r.item_id::text, null,
                          jsonb_build_object('item_id', r.item_id), 5, auth.uid());
    end if;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'ml_accounts', p_account, 'ml_account_settings_saved', v_before, p);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_account_settings_save(uuid, jsonb) from public, anon;
grant execute on function ml_account_settings_save(uuid, jsonb) to authenticated;

-- Candidatos para la publicación rápida: productos del catálogo con lo que
-- hace falta para precompletar. p_search: nombre, SKU o código de barras
-- exacto (escáner). p_only_unpublished: sin publicación en esta cuenta.
create or replace function ml_quick_candidates(p_account uuid, p_search text default null, p_category uuid default null,
                                               p_only_unpublished boolean default true, p_limit integer default 50)
returns table (product_id uuid, name text, sku text, barcode text, brand text, model text, category_name text,
               price numeric, has_variants boolean, is_kit boolean, image_url text, pictures integer,
               published_count integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not exists (select 1 from ml_accounts a where a.id = p_account and a.tenant_id = v_tenant and a.deleted_at is null) then
    raise exception 'not_found';
  end if;
  return query
  select p.id, p.name, p.sku, p.barcode, b.name, p.model, c.name, p.price, coalesce(p.has_variants, false),
         coalesce(p.is_kit, false), p.image_url,
         (select count(*)::int from product_images i where i.product_id = p.id and i.deleted_at is null),
         (select count(distinct l.item_id)::int from ml_item_links l where l.account_id = p_account and l.product_id = p.id)
    from products p
    left join brands b on b.id = p.brand_id
    left join categories c on c.id = p.category_id
   where p.tenant_id = v_tenant and p.deleted_at is null and coalesce(p.is_active, true)
     and (p_category is null or p.category_id = p_category)
     and (v_q is null
          or p.barcode = v_q or p.sku = v_q
          or exists (select 1 from product_variants v where v.product_id = p.id and v.deleted_at is null
                                                         and (v.barcode = v_q or v.sku = v_q))
          or p.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
     and (not coalesce(p_only_unpublished, true)
          or not exists (select 1 from ml_item_links l where l.account_id = p_account and l.product_id = p.id))
   order by (p.barcode = v_q or p.sku = v_q) desc nulls last, p.name
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;
revoke all on function ml_quick_candidates(uuid, text, uuid, boolean, integer) from public, anon;
grant execute on function ml_quick_candidates(uuid, text, uuid, boolean, integer) to authenticated;

-- Edge (service_role): recuerda la categoría y los valores usados.
create or replace function ml_category_memory_touch(p_account uuid, p_category text, p_name text, p_attrs jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from ml_accounts where id = p_account and deleted_at is null;
  if v_tenant is null or coalesce(p_category, '') !~ '^[A-Z]{3}\d{1,12}$' then return; end if;
  insert into ml_category_memory (tenant_id, account_id, category_id, category_name, attrs, uses, last_used_at)
  values (v_tenant, p_account, p_category, left(coalesce(p_name, ''), 200),
          case when jsonb_typeof(p_attrs) = 'object' then p_attrs else '{}'::jsonb end, 1, now())
  on conflict (account_id, category_id) do update
    set category_name = coalesce(nullif(excluded.category_name, ''), ml_category_memory.category_name),
        attrs = ml_category_memory.attrs || excluded.attrs,
        uses = ml_category_memory.uses + 1, last_used_at = now();
end;
$$;
revoke all on function ml_category_memory_touch(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function ml_category_memory_touch(uuid, text, text, jsonb) to service_role;

-- Edge (service_role): visitas de 30 días. p: [{ml_item_id, visits}]
create or replace function ml_items_visits_save(p_account uuid, p jsonb)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with v as (
    select x ->> 'ml_item_id' as ml_item_id, greatest((x ->> 'visits')::int, 0) as visits
      from jsonb_array_elements(coalesce(p, '[]'::jsonb)) x
     where (x ->> 'visits') ~ '^\d{1,9}$'
  ), u as (
    update ml_items i set visits_30d = v.visits, visits_synced_at = now()
      from v where i.account_id = p_account and i.ml_item_id = v.ml_item_id
    returning 1
  )
  select count(*)::int from u;
$$;
revoke all on function ml_items_visits_save(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_items_visits_save(uuid, jsonb) to service_role;
