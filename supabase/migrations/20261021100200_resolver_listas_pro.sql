-- =============================================================================
-- 20261021100200_resolver_listas_pro  (F18 · H100, ADR-058)
--
-- _resolve_unit_price con listas PRO. Espejo EXACTO de resolveUnitPrice en
-- lib/prices/resolve.ts (la paridad se prueba con tests/fixtures/priceMatrix.ts
-- en unit y en integración). create_sale NO se recrea: sigue llamando
--   _resolve_unit_price(tenant, producto, variante, cantidad, cliente, sucursal, null, now())
-- y ahora resuelve la firma nueva (dos parámetros más con default).
--
--   1. Lista: p_list_id; si no, la elegida en el POS (parámetro o header
--      x-ninja-price-list, sólo si la lista es "elegible en el POS"), cliente,
--      grupo de clientes, sucursal y grupo de sucursales (asignaciones), canal
--      mostrador. Se saltea la inactiva, borrada o fuera de vigencia.
--   2. Base: precio programado vigente de la variante o del producto, si no
--      price_override de la variante o precio del producto.
--   3. Precio de lista: programado vigente o ítem (variante → producto); si
--      no, por tipo (PRO): fija, derivada, sobre costo o en moneda.
--   4. PRO: escala por cantidad, condición de pago (parámetro, header
--      x-ninja-payment-term o ficha del cliente; 'none' = contado), redondeo
--      de la lista sobre lo calculado y piso (precio mínimo y margen mínimo).
--
-- También: price_context_snapshot (todo lo que necesita el POS para resolver
-- igual que el servidor en una sola llamada) y product_prices_overview (precio
-- por lista y programados de un producto, para la ficha).
-- =============================================================================

drop function if exists resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz);
drop function if exists _resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz);

-- Header del request (null si no hay o no se puede leer).
create or replace function _price_header(p_name text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return nullif(btrim(nullif(current_setting('request.headers', true), '')::json ->> p_name), '');
exception when others then
  return null;
end;
$$;

create or replace function _price_uuid(p text)
returns uuid
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p is null or p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  return p::uuid;
end;
$$;

-- Redondeo (espejo de applyRounding, en centavos enteros).
create or replace function _price_round(p_price numeric, p_rule jsonb)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_mode text := coalesce(p_rule ->> 'mode', 'none');
  v_dir  text := coalesce(nullif(p_rule ->> 'direction', ''), 'nearest');
  p      numeric := round(coalesce(p_price, 0) * 100);
  v_step numeric;
  v_e    numeric;
  v_m    numeric;
  v_base numeric;
  v_down numeric;
  v_up   numeric;
  r      numeric;
begin
  if p_rule is null or jsonb_typeof(p_rule) <> 'object' or v_mode = 'none' then
    return p / 100;
  end if;
  if v_mode = 'multiple' then
    v_step := round(coalesce((p_rule ->> 'step')::numeric, 0) * 100);
    if v_step <= 0 then return p / 100; end if;
    v_down := floor(p / v_step) * v_step;
    v_up := case when v_down = p then p else v_down + v_step end;
    r := case v_dir when 'up' then v_up when 'down' then v_down
              else case when p - v_down < v_up - p then v_down else v_up end end;
    if r <= 0 then r := case when v_up > 0 then v_up else v_step end; end if;
    return r / 100;
  elsif v_mode = 'ending' then
    if p_rule ->> 'ending' is null or (p_rule ->> 'ending')::numeric < 0 then return p / 100; end if;
    v_e := round((p_rule ->> 'ending')::numeric * 100);
    v_m := 100;
    while v_m <= v_e loop v_m := v_m * 10; end loop;
    v_base := floor(p / v_m) * v_m + v_e;
    v_down := case when v_base > p then v_base - v_m else v_base end;
    v_up := case when v_base < p then v_base + v_m else v_base end;
    r := case v_dir when 'up' then v_up when 'down' then v_down
              else case when p - v_down < v_up - p then v_down else v_up end end;
    if r <= 0 then r := v_up; end if;
    return r / 100;
  end if;
  return p / 100;
end;
$$;
grant execute on function _price_round(numeric, jsonb) to authenticated, service_role;

create or replace function _price_list_valid(l price_lists, p_at timestamptz)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select l.id is not null and l.is_active and l.deleted_at is null
     and (l.valid_from is null or l.valid_from <= p_at)
     and (l.valid_to is null or p_at < l.valid_to);
$$;

-- Precio programado vigente para un destino exacto (lista o base, variante o no).
create or replace function _price_sched(p_tenant uuid, p_list uuid, p_product uuid, p_variant uuid, p_at timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.price from price_schedules s
   where s.tenant_id = p_tenant and s.product_id = p_product and s.status = 'scheduled'
     and s.list_id is not distinct from p_list and s.variant_id is not distinct from p_variant
     and s.effective_at <= p_at
   order by s.effective_at desc, s.created_at desc, s.id desc
   limit 1;
$$;
revoke all on function _price_sched(uuid, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;

-- Cotización vigente (la última cargada hasta el día de p_at en Argentina).
create or replace function _price_fx(p_tenant uuid, p_currency text, p_source text, p_at timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.rate from fx_rates r
   where r.tenant_id = p_tenant and r.currency = p_currency and r.source = coalesce(p_source, 'manual')
     and r.rate_date <= (p_at at time zone 'America/Argentina/Buenos_Aires')::date
   order by r.rate_date desc
   limit 1;
$$;
revoke all on function _price_fx(uuid, text, text, timestamptz) from public, anon, authenticated;

create or replace function _price_cost(p_product uuid, p_basis text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(case p_basis when 'last' then p.last_cost when 'average' then p.avg_cost
                               when 'replacement' then p.replacement_cost else p.cost end, p.cost)
    from products p where p.id = p_product;
$$;
revoke all on function _price_cost(uuid, text) from public, anon, authenticated;

-- % y monto de la lista sobre un precio.
create or replace function _price_adjust(l price_lists, p_price numeric, p_computed boolean,
                                         out price numeric, out computed boolean)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  price := p_price;
  computed := p_computed;
  if l.adjustment_pct is null and l.adjustment_amount is null then return; end if;
  if l.adjustment_pct is not null then price := round(price * (100 + l.adjustment_pct) / 100, 2); end if;
  if l.adjustment_amount is not null then price := price + round(l.adjustment_amount, 2); end if;
  price := greatest(0, price);
  computed := true;
end;
$$;

-- Precio de una lista para el producto (sin escalas, plazo ni piso).
create or replace function _price_list_price(
  p_tenant uuid, p_list uuid, p_product uuid, p_variant uuid, p_base numeric,
  p_at timestamptz, p_pro boolean, p_depth int,
  out price numeric, out computed boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  l       price_lists%rowtype;
  parent  price_lists%rowtype;
  v_kind  text;
  v_item  numeric;
  v_rate  numeric;
  v_cost  numeric;
  r       record;
begin
  select * into l from price_lists where id = p_list and tenant_id = p_tenant;
  v_kind := case when p_pro then coalesce(l.kind, 'fixed') else 'fixed' end;
  price := null;
  computed := false;

  -- Sin PRO, los ítems de una lista en moneda extranjera no son pesos: se ignoran.
  if not p_pro and l.kind = 'currency' then
    v_item := null;
  elsif p_variant is not null then
    v_item := _price_sched(p_tenant, l.id, p_product, p_variant, p_at);
    if v_item is null then
      select i.price into v_item from price_list_items i
       where i.price_list_id = l.id and i.product_id = p_product and i.variant_id = p_variant limit 1;
    end if;
  end if;
  if v_item is null and (p_pro or l.kind <> 'currency') then
    v_item := _price_sched(p_tenant, l.id, p_product, null, p_at);
    if v_item is null then
      select i.price into v_item from price_list_items i
       where i.price_list_id = l.id and i.product_id = p_product and i.variant_id is null limit 1;
    end if;
  end if;

  if v_item is not null then
    if v_kind = 'currency' then
      v_rate := _price_fx(p_tenant, l.currency, l.fx_source, p_at);
      if v_rate is not null and v_rate > 0 then
        price := round(v_item * v_rate, 2);
        computed := true;
      end if;
    else
      price := v_item;
      computed := false;
    end if;
  end if;

  if price is null then
    if v_kind = 'derived' then
      if l.base_list_id is not null then
        select * into parent from price_lists where id = l.base_list_id and tenant_id = p_tenant;
      end if;
      if p_depth < 4 and parent.id is not null and parent.id <> l.id and _price_list_valid(parent, p_at) then
        select x.price, x.computed into r
          from _price_list_price(p_tenant, parent.id, p_product, p_variant, p_base, p_at, p_pro, p_depth + 1) x;
        select a.price, a.computed into price, computed from _price_adjust(l, r.price, r.computed) a;
      else
        select a.price, a.computed into price, computed from _price_adjust(l, p_base, false) a;
      end if;
    elsif v_kind = 'cost' then
      v_cost := _price_cost(p_product, l.cost_basis);
      if v_cost is not null and v_cost > 0 and l.markup_value is not null
         and (coalesce(l.markup_mode, 'markup') <> 'margin' or l.markup_value < 100) then
        price := case when l.markup_mode = 'margin'
                      then round(v_cost / (1 - l.markup_value / 100), 2)
                      else round(v_cost * (1 + l.markup_value / 100), 2) end;
        computed := true;
      else
        select a.price, a.computed into price, computed from _price_adjust(l, p_base, false) a;
      end if;
    else
      select a.price, a.computed into price, computed from _price_adjust(l, p_base, false) a;
    end if;
  end if;

  if p_pro and computed and l.rounding is not null then
    price := _price_round(price, l.rounding);
  end if;
end;
$$;
revoke all on function _price_list_price(uuid, uuid, uuid, uuid, numeric, timestamptz, boolean, int) from public, anon, authenticated;

-- Listas asignadas en orden: cliente, grupo de clientes, sucursal, grupo de sucursales.
create or replace function _price_assigned_lists(p_tenant uuid, p_customer uuid, p_store uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_out   uuid[] := '{}';
  v_group uuid;
  v_sg    uuid;
  v_id    uuid;
  v_lp    boolean := tenant_has_feature_for(p_tenant, 'listas_precios');
  v_multi boolean := tenant_has_feature_for(p_tenant, 'multi_sucursal');
begin
  if v_lp and p_customer is not null then
    select a.price_list_id into v_id from price_list_assignments a
     where a.tenant_id = p_tenant and a.scope = 'customer' and a.scope_id = p_customer;
    v_out := v_out || v_id;
    v_id := null;
    select c.group_id into v_group from customers c where c.id = p_customer and c.tenant_id = p_tenant;
    if v_group is not null then
      select a.price_list_id into v_id from price_list_assignments a
       where a.tenant_id = p_tenant and a.scope = 'customer_group' and a.scope_id = v_group;
    end if;
    v_out := v_out || v_id;
  else
    v_out := v_out || null::uuid || null::uuid;
  end if;
  v_id := null;
  if v_lp and v_multi and p_store is not null then
    select a.price_list_id into v_id from price_list_assignments a
     where a.tenant_id = p_tenant and a.scope = 'store' and a.scope_id = p_store;
    v_out := v_out || v_id;
    v_id := null;
    select s.store_group_id into v_sg from stores s where s.id = p_store and s.tenant_id = p_tenant;
    if v_sg is not null then
      select a.price_list_id into v_id from price_list_assignments a
       where a.tenant_id = p_tenant and a.scope = 'store_group' and a.scope_id = v_sg;
    end if;
    v_out := v_out || v_id;
  else
    v_out := v_out || null::uuid || null::uuid;
  end if;
  return v_out;
end;
$$;
revoke all on function _price_assigned_lists(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function _resolve_unit_price(
  p_tenant   uuid,
  p_product  uuid,
  p_variant  uuid default null,
  p_qty      numeric default 1,
  p_customer uuid default null,
  p_store    uuid default null,
  p_list_id  uuid default null,
  p_at       timestamptz default now(),
  p_term     text default null,
  p_pos_list uuid default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pro     boolean;
  v_pbase   numeric;
  v_vprice  numeric;
  v_base    numeric;
  v_list    price_lists%rowtype;
  v_cand    price_lists%rowtype;
  v_sel     uuid;
  v_id      uuid;
  v_price   numeric;
  v_comp    boolean := false;
  v_reround boolean := false;
  v_bkind   text;
  v_bval    numeric;
  v_term    text;
  v_termid  uuid;
  v_sur     numeric;
  v_floor   numeric := 0;
  v_minp    numeric;
  v_cost    numeric;
begin
  if p_tenant is null or p_product is null then return null; end if;

  select p.price, p.min_price into v_pbase, v_minp
    from products p where p.id = p_product and p.tenant_id = p_tenant;
  if not found then return null; end if;
  v_pro := price_pro_enabled(p_tenant);

  v_pbase := coalesce(_price_sched(p_tenant, null, p_product, null, p_at), v_pbase, 0);
  v_base := v_pbase;
  if p_variant is not null then
    v_vprice := _price_sched(p_tenant, null, p_product, p_variant, p_at);
    if v_vprice is null then
      select v.price_override into v_vprice from product_variants v
       where v.id = p_variant and v.product_id = p_product and v.tenant_id = p_tenant;
    end if;
    v_base := coalesce(v_vprice, v_pbase);
  end if;
  v_base := round(coalesce(v_base, 0), 2);

  -- Lista.
  if p_list_id is not null then
    select * into v_cand from price_lists l where l.id = p_list_id and l.tenant_id = p_tenant;
    if _price_list_valid(v_cand, p_at) then v_list := v_cand; end if;
  else
    v_sel := coalesce(p_pos_list, _price_uuid(_price_header('x-ninja-price-list')));
    if v_sel is not null then
      select * into v_cand from price_lists l
       where l.id = v_sel and l.tenant_id = p_tenant and l.pos_selectable;
      if _price_list_valid(v_cand, p_at) then v_list := v_cand; end if;
    end if;
    if v_list.id is null then
      foreach v_id in array _price_assigned_lists(p_tenant, p_customer, p_store) loop
        continue when v_id is null;
        v_cand := null;
        select * into v_cand from price_lists l where l.id = v_id and l.tenant_id = p_tenant;
        if _price_list_valid(v_cand, p_at) then
          v_list := v_cand;
          exit;
        end if;
      end loop;
    end if;
    if v_list.id is null then
      v_cand := null;
      select * into v_cand from price_lists l
       where l.tenant_id = p_tenant and l.channel = 'mostrador' and l.is_active and l.deleted_at is null
       order by l.created_at
       limit 1;
      if _price_list_valid(v_cand, p_at) then v_list := v_cand; end if;
    end if;
  end if;

  if v_list.id is not null then
    select x.price, x.computed into v_price, v_comp
      from _price_list_price(p_tenant, v_list.id, p_product, p_variant, v_base, p_at, v_pro, 0) x;
  else
    v_price := v_base;
  end if;

  -- Escala por cantidad (PRO).
  if v_pro and v_list.id is not null then
    if p_variant is not null then
      select b.kind, b.value into v_bkind, v_bval from price_list_breaks b
       where b.price_list_id = v_list.id and b.product_id = p_product and b.variant_id = p_variant
         and b.min_qty <= coalesce(p_qty, 1)
       order by b.min_qty desc limit 1;
    end if;
    if v_bkind is null then
      select b.kind, b.value into v_bkind, v_bval from price_list_breaks b
       where b.price_list_id = v_list.id and b.product_id = p_product and b.variant_id is null
         and b.min_qty <= coalesce(p_qty, 1)
       order by b.min_qty desc limit 1;
    end if;
    if v_bkind is null then
      select b.kind, b.value into v_bkind, v_bval from price_list_breaks b
       where b.price_list_id = v_list.id and b.product_id is null
         and b.min_qty <= coalesce(p_qty, 1)
       order by b.min_qty desc limit 1;
    end if;
    if v_bkind = 'price' then
      v_price := round(v_bval, 2);
      v_comp := false;
    elsif v_bkind = 'pct' then
      v_price := round(v_price * (100 + v_bval) / 100, 2);
      v_comp := true;
      v_reround := true;
    end if;
  end if;

  -- Condición de pago (PRO): parámetro, header o ficha del cliente.
  if v_pro then
    v_term := coalesce(p_term, _price_header('x-ninja-payment-term'));
    if v_term is null and p_customer is not null then
      select c.payment_term_id::text into v_term from customers c
       where c.id = p_customer and c.tenant_id = p_tenant;
    end if;
    v_termid := case when v_term = 'none' then null else _price_uuid(v_term) end;
    if v_termid is not null then
      select t.surcharge_pct into v_sur from payment_terms t
       where t.id = v_termid and t.tenant_id = p_tenant and t.is_active and t.deleted_at is null;
      if v_sur is not null and v_sur <> 0 then
        v_price := round(v_price * (100 + v_sur) / 100, 2);
        v_reround := true;
      end if;
    end if;
  end if;

  if v_pro and v_list.id is not null and v_reround and v_list.rounding is not null then
    v_price := _price_round(v_price, v_list.rounding);
  end if;

  -- Piso (PRO).
  if v_pro then
    if v_minp is not null and v_minp > 0 then v_floor := round(v_minp, 2); end if;
    if v_list.id is not null and v_list.min_margin_pct is not null and v_list.min_margin_pct < 100 then
      v_cost := _price_cost(p_product, v_list.cost_basis);
      if v_cost is not null and v_cost > 0 then
        v_floor := greatest(v_floor, ceil(v_cost / (1 - v_list.min_margin_pct / 100) * 100) / 100);
      end if;
    end if;
    if v_price < v_floor then v_price := v_floor; end if;
  end if;

  return greatest(0, round(v_price, 2));
end;
$$;
revoke all on function _resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz, text, uuid) from public, anon, authenticated;

create or replace function resolve_unit_price(
  p_tenant   uuid,
  p_product  uuid,
  p_variant  uuid default null,
  p_qty      numeric default 1,
  p_customer uuid default null,
  p_store    uuid default null,
  p_list_id  uuid default null,
  p_at       timestamptz default now(),
  p_term     text default null,
  p_pos_list uuid default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_tenant is distinct from current_tenant_id() and not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return _resolve_unit_price(p_tenant, p_product, p_variant, p_qty, p_customer, p_store, p_list_id, p_at, p_term, p_pos_list);
end;
$$;
revoke all on function resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz, text, uuid) from public, anon;
grant execute on function resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Foto de precios para el POS: con esto resolveUnitPrice (TS) da lo mismo que
-- el servidor. Sólo el negocio actual; la sucursal tiene que ser accesible.
-- -----------------------------------------------------------------------------
create or replace function price_context_snapshot(p_store uuid default null, p_customer uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_pro      boolean;
  v_assigned uuid[];
  v_rel      uuid[];
  v_costs    boolean;
  v_term     uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_store is not null then
    if not exists (select 1 from stores s where s.id = p_store and s.tenant_id = v_tenant) then
      raise exception 'store_not_found';
    end if;
    if not user_can_access_store(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  end if;
  if p_customer is not null and not exists (select 1 from customers c where c.id = p_customer and c.tenant_id = v_tenant) then
    raise exception 'customer_not_found';
  end if;
  v_pro := price_pro_enabled(v_tenant);
  v_assigned := _price_assigned_lists(v_tenant, p_customer, p_store);

  -- Listas relevantes: asignadas, elegibles en el POS, mostrador y sus madres.
  with recursive rel(id, depth) as (
    select l.id, 0 from price_lists l
     where l.tenant_id = v_tenant and l.deleted_at is null
       and (l.id = any (v_assigned) or l.pos_selectable or l.channel = 'mostrador')
    union
    select l.base_list_id, r.depth + 1 from price_lists l join rel r on l.id = r.id
     where l.base_list_id is not null and r.depth < 5)
  select coalesce(array_agg(distinct id), '{}') into v_rel from rel;

  v_costs := v_pro and (exists (select 1 from price_lists l where l.id = any (v_rel)
                                  and (l.kind = 'cost' or l.min_margin_pct is not null)));
  if v_pro and p_customer is not null then
    select c.payment_term_id into v_term from customers c where c.id = p_customer;
  end if;

  return jsonb_build_object(
    'pro', v_pro,
    'at', now(),
    'assigned', to_jsonb(v_assigned),
    'customerTermId', v_term,
    'lists', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'channel', l.channel, 'kind', l.kind,
        'adjustment_pct', l.adjustment_pct, 'adjustment_amount', l.adjustment_amount,
        'base_list_id', l.base_list_id, 'cost_basis', l.cost_basis, 'markup_mode', l.markup_mode,
        'markup_value', l.markup_value, 'currency', l.currency, 'fx_source', l.fx_source,
        'rounding', l.rounding, 'min_margin_pct', l.min_margin_pct, 'valid_from', l.valid_from,
        'valid_to', l.valid_to, 'is_active', l.is_active, 'pos_selectable', l.pos_selectable,
        'created_at', l.created_at) order by l.created_at)
      from price_lists l where l.tenant_id = v_tenant and l.deleted_at is null), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'price_list_id', i.price_list_id, 'product_id', i.product_id, 'variant_id', i.variant_id, 'price', i.price))
      from price_list_items i where i.tenant_id = v_tenant and i.price_list_id = any (v_rel)), '[]'::jsonb),
    'schedules', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'list_id', s.list_id, 'product_id', s.product_id, 'variant_id', s.variant_id,
        'price', s.price, 'effective_at', s.effective_at, 'status', s.status, 'created_at', s.created_at))
      from price_schedules s where s.tenant_id = v_tenant and s.status = 'scheduled'
        and (s.list_id is null or s.list_id = any (v_rel))), '[]'::jsonb),
    'breaks', case when v_pro then coalesce((select jsonb_agg(jsonb_build_object(
        'price_list_id', b.price_list_id, 'product_id', b.product_id, 'variant_id', b.variant_id,
        'min_qty', b.min_qty, 'kind', b.kind, 'value', b.value))
      from price_list_breaks b where b.tenant_id = v_tenant and b.price_list_id = any (v_rel)), '[]'::jsonb)
      else '[]'::jsonb end,
    'terms', case when v_pro then coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'days', t.days, 'surcharge_pct', t.surcharge_pct,
        'rate_mode', t.rate_mode, 'monthly_rate', t.monthly_rate, 'is_active', t.is_active)
        order by t.sort, t.days, t.name)
      from payment_terms t where t.tenant_id = v_tenant and t.deleted_at is null and t.is_active), '[]'::jsonb)
      else '[]'::jsonb end,
    'fx', case when v_pro then coalesce((select jsonb_agg(jsonb_build_object(
        'currency', r.currency, 'source', r.source, 'rate', r.rate, 'rate_date', r.rate_date))
      from fx_rates r where r.tenant_id = v_tenant
        and r.rate_date >= (now() at time zone 'America/Argentina/Buenos_Aires')::date - 45), '[]'::jsonb)
      else '[]'::jsonb end,
    'costs', case when v_pro then coalesce((select jsonb_object_agg(p.id, jsonb_build_object(
        'cost', p.cost, 'last_cost', p.last_cost, 'avg_cost', p.avg_cost,
        'replacement_cost', p.replacement_cost, 'min_price', p.min_price))
      from products p where p.tenant_id = v_tenant and p.deleted_at is null
        and (v_costs or p.min_price is not null)), '{}'::jsonb)
      else '{}'::jsonb end);
end;
$$;
revoke all on function price_context_snapshot(uuid, uuid) from public, anon;
grant execute on function price_context_snapshot(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Ficha del producto: precio por lista (hoy, de contado, por unidad) y
-- precios programados que vienen.
-- -----------------------------------------------------------------------------
create or replace function product_prices_overview(p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not exists (select 1 from products p where p.id = p_product and p.tenant_id = v_tenant) then
    raise exception 'product_not_found';
  end if;
  return jsonb_build_object(
    'base', (select coalesce(_price_sched(v_tenant, null, p.id, null, now()), p.price)
               from products p where p.id = p_product),
    'lists', coalesce((select jsonb_agg(jsonb_build_object(
        'list_id', l.id, 'name', l.name, 'channel', l.channel, 'kind', l.kind,
        'is_active', l.is_active, 'valid', _price_list_valid(l, now()),
        'item_price', (select i.price from price_list_items i
                        where i.price_list_id = l.id and i.product_id = p_product and i.variant_id is null limit 1),
        'price', case when _price_list_valid(l, now())
                      then _resolve_unit_price(v_tenant, p_product, null, 1, null, null, l.id, now(), 'none', null)
                      else null end)
        order by l.channel, l.name)
      from price_lists l where l.tenant_id = v_tenant and l.deleted_at is null), '[]'::jsonb),
    'upcoming', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'list_id', s.list_id, 'list_name', l.name, 'variant_id', s.variant_id,
        'price', s.price, 'effective_at', s.effective_at, 'status', s.status, 'batch_id', s.batch_id)
        order by s.effective_at)
      from price_schedules s left join price_lists l on l.id = s.list_id
      where s.tenant_id = v_tenant and s.product_id = p_product
        and s.status in ('pending', 'scheduled') and s.effective_at > now()), '[]'::jsonb));
end;
$$;
revoke all on function product_prices_overview(uuid) from public, anon;
grant execute on function product_prices_overview(uuid) to authenticated;
