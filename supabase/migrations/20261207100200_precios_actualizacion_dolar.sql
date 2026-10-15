-- =============================================================================
-- 20261207100200_precios_actualizacion_dolar  (ADR-140, PR B)
--
-- Asistente "Actualizar precios" v2 y actualización automática por dólar.
--
--   A) Lotes v2 (price_bulk_batches.engine = 2) sobre las tablas de ADR-058:
--      varias listas destino además del precio de venta, filtros por árbol de
--      categorías, marcas, proveedores, etiqueta, productos y "sólo costos en
--      dólares", y cinco modos:
--        · pct / amount  subir o bajar un % o un monto (como v1).
--        · fx            recalcula el costo en pesos de los productos con costo
--                        en dólares con la cotización (oficial venta del día de
--                        la plataforma, la del negocio o una manual) y, según
--                        `reprice`, mantiene el markup (precio × costo final
--                        nuevo / costo final viejo), aplica la utilidad
--                        objetivo del producto o sólo actualiza el costo.
--        · markup        precio = costo final con un markup o margen nuevo.
--        · cost          recalcula desde el costo final con la utilidad
--                        objetivo de cada producto.
--      Los precios fijos de las listas y de las variantes acompañan al precio
--      de venta en la misma proporción. Cada línea guarda precio y costo
--      anteriores (deshacer), costo final, margen resultante y alertas
--      (bajo costo, bajo el piso, margen bajo).
--   B) Ejecución y deshacer: el costo se escribe con cost_fx_rate (el trigger
--      de 20261207100100 recalcula el costo y el costo final); los precios con
--      _price_write. Historial con lote y motivo (ninja.price_batch / reason).
--      price_bulk_revert vuelve precios y costos que nadie cambió después.
--   C) Regla automática (price_fx_rules): "cuando el dólar se mueva más de X %"
--      arma un lote con la regla guardada, aplicado o pendiente de aprobación
--      del dueño, con aviso. pg_cron 'price-fx-auto' 30 minutos después de la
--      sincronización de la cotización de ADR-135.
--
-- Gating (CLAUDE.md §6): modo fx y reglas automáticas exigen precios_usd;
-- listas destino exigen listas_precios; aprobación sigue la regla de v1.
-- Partió de las definiciones vigentes en producción de _price_bulk_execute y
-- price_bulk_revert. Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Columnas
-- -----------------------------------------------------------------------------
alter table price_bulk_batches drop constraint if exists price_bulk_batches_mode_check;
alter table price_bulk_batches add constraint price_bulk_batches_mode_check
  check (mode in ('pct', 'amount', 'index', 'fx', 'markup', 'cost'));
alter table price_bulk_batches add column if not exists engine smallint not null default 1 check (engine in (1, 2));
alter table price_bulk_batches add column if not exists options jsonb;
alter table price_bulk_batches add column if not exists list_ids uuid[];
alter table price_bulk_batches add column if not exists fx_rate numeric(14,4);
alter table price_bulk_batches add column if not exists fx_rate_date date;
alter table price_bulk_batches add column if not exists fx_origin text;
alter table price_bulk_batches add column if not exists origin text not null default 'manual'
  check (origin in ('manual', 'auto'));
alter table price_bulk_batches add column if not exists rule_id uuid;

alter table price_bulk_lines add column if not exists old_cost numeric(14,2);
alter table price_bulk_lines add column if not exists new_cost numeric(14,2);
alter table price_bulk_lines add column if not exists old_fx_rate numeric(14,4);
alter table price_bulk_lines add column if not exists new_fx_rate numeric(14,4);
alter table price_bulk_lines add column if not exists old_fx_date date;
alter table price_bulk_lines add column if not exists final_cost numeric(14,2);
alter table price_bulk_lines add column if not exists margin_pct numeric(9,2);
alter table price_bulk_lines add column if not exists flags text[];

-- -----------------------------------------------------------------------------
-- Funciones puras (espejo de lib/prices/costing.ts, paridad en PGlite).
-- -----------------------------------------------------------------------------
create or replace function price_bulk_round(p_value numeric, p_rounding jsonb)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_value is null then null
              when p_rounding is null or jsonb_typeof(p_rounding) <> 'object'
                   or coalesce(p_rounding ->> 'mode', 'none') = 'none' or p_value <= 0
                then greatest(round(p_value, 2), 0)
              else _price_round(p_value, p_rounding) end;
$$;

-- Precio de venta nuevo SIN redondeo de la regla (null = no cambia).
--   p_mode      pct | amount | fx | markup | cost
--   p_value     % o monto (pct, amount); markup o margen (markup)
--   p_markup_mode markup | margin para el modo markup
--   p_target_mode / p_target_pct  utilidad objetivo del producto (cost, fx+target)
--   p_reprice   keep_markup | target | none (sólo fx)
create or replace function price_bulk_raw(
  p_mode text, p_value numeric, p_markup_mode text,
  p_old_price numeric, p_old_final numeric, p_new_final numeric,
  p_target_mode text, p_target_pct numeric, p_reprice text, p_iva_pct numeric)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v numeric;
begin
  if p_mode = 'pct' then
    if p_old_price is null then return null; end if;
    v := round(p_old_price * (100 + p_value) / 100, 2);
  elsif p_mode = 'amount' then
    if p_old_price is null then return null; end if;
    v := round(p_old_price + p_value, 2);
  elsif p_mode = 'fx' then
    if coalesce(p_reprice, 'keep_markup') = 'none' then return null; end if;
    if p_reprice = 'target' then
      v := price_from_cost(p_new_final, p_target_mode, p_target_pct, p_iva_pct);
    else
      if p_old_price is null or p_old_final is null or p_old_final <= 0 or p_new_final is null then return null; end if;
      v := round(p_old_price * p_new_final / p_old_final, 2);
    end if;
  elsif p_mode = 'markup' then
    v := price_from_cost(p_new_final, p_markup_mode, p_value, p_iva_pct);
  elsif p_mode = 'cost' then
    v := price_from_cost(p_new_final, p_target_mode, p_target_pct, p_iva_pct);
  else
    return null;
  end if;
  if v is null then return null; end if;
  return greatest(v, 0);
end;
$$;

-- Precio fijo de una lista o de una variante que acompaña al precio de venta:
-- misma proporción (precio de venta nuevo sin redondear / anterior).
create or replace function price_bulk_follow(p_old numeric, p_base_old numeric, p_base_raw numeric, p_rounding jsonb)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_old is null or p_base_old is null or p_base_old <= 0 or p_base_raw is null then null
              else price_bulk_round(round(p_old * p_base_raw / p_base_old, 2), p_rounding) end;
$$;

-- Margen sobre el precio sin IVA (en %, 2 decimales). null sin precio o costo.
create or replace function price_margin_pct(p_price numeric, p_final numeric, p_iva_pct numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_price is null or p_price <= 0 or p_final is null or p_final <= 0 then null
              else round(((p_price / (1 + coalesce(p_iva_pct, 0) / 100)) - p_final)
                         / (p_price / (1 + coalesce(p_iva_pct, 0) / 100)) * 100, 2) end;
$$;

-- -----------------------------------------------------------------------------
-- Alcance y validación
-- -----------------------------------------------------------------------------
create or replace function _price_bulk_v2_scope(p_tenant uuid, p_scope jsonb)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recursive cats(id, depth) as (
    select c.id, 0 from categories c
     where c.tenant_id = p_tenant and c.deleted_at is null
       and jsonb_typeof(p_scope -> 'category_ids') = 'array'
       and c.id::text in (select jsonb_array_elements_text(p_scope -> 'category_ids'))
    union
    select c.id, k.depth + 1 from categories c join cats k on c.parent_id = k.id
     where c.tenant_id = p_tenant and c.deleted_at is null and k.depth < 10)
  select p.id from products p
   where p.tenant_id = p_tenant and p.deleted_at is null
     and (coalesce((p_scope ->> 'include_inactive')::boolean, false) or p.is_active)
     and (jsonb_typeof(p_scope -> 'category_ids') is distinct from 'array'
          or jsonb_array_length(p_scope -> 'category_ids') = 0
          or p.category_id in (select id from cats))
     and (jsonb_typeof(p_scope -> 'brand_ids') is distinct from 'array'
          or jsonb_array_length(p_scope -> 'brand_ids') = 0
          or p.brand_id::text in (select jsonb_array_elements_text(p_scope -> 'brand_ids')))
     and (jsonb_typeof(p_scope -> 'supplier_ids') is distinct from 'array'
          or jsonb_array_length(p_scope -> 'supplier_ids') = 0
          or exists (select 1 from supplier_products sp
                      where sp.product_id = p.id and sp.tenant_id = p_tenant and sp.deleted_at is null
                        and sp.supplier_id::text in (select jsonb_array_elements_text(p_scope -> 'supplier_ids'))))
     and (nullif(p_scope ->> 'tag', '') is null or (p_scope ->> 'tag') = any (coalesce(p.tags, '{}')))
     and (jsonb_typeof(p_scope -> 'product_ids') is distinct from 'array'
          or jsonb_array_length(p_scope -> 'product_ids') = 0
          or p.id::text in (select jsonb_array_elements_text(p_scope -> 'product_ids')))
     and (not coalesce((p_scope ->> 'usd_only')::boolean, false) or p.cost_currency = 'USD');
$$;

-- Normaliza y valida el pedido. Devuelve el pedido con la cotización resuelta
-- (modo fx): { mode, value, markup_mode, reprice, targets: {base, list_ids},
-- scope, rounding, fx: {rate, rate_date, origin, source}, effective_at, reason }.
create or replace function _price_bulk_v2_assert(p_tenant uuid, p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode   text := coalesce(p ->> 'mode', 'pct');
  v_value  numeric;
  v_mm     text := coalesce(nullif(p ->> 'markup_mode', ''), 'markup');
  v_rep    text := coalesce(nullif(p ->> 'reprice', ''), 'keep_markup');
  v_base   boolean := coalesce((p -> 'targets' ->> 'base')::boolean, true);
  v_lists  jsonb := coalesce(p -> 'targets' -> 'list_ids', '[]'::jsonb);
  v_err    text;
  v_fx     jsonb;
  v_src    text;
  v_rate   numeric;
  q        record;
  v_eff    timestamptz := nullif(p ->> 'effective_at', '')::timestamptz;
begin
  if v_mode not in ('pct', 'amount', 'fx', 'markup', 'cost') then raise exception 'invalid_mode'; end if;
  if v_mm not in ('markup', 'margin') then raise exception 'invalid_markup_mode'; end if;
  if v_rep not in ('keep_markup', 'target', 'none') then raise exception 'invalid_reprice'; end if;
  if jsonb_typeof(v_lists) <> 'array' or jsonb_array_length(v_lists) > 50 then raise exception 'invalid_targets'; end if;
  if not v_base and jsonb_array_length(v_lists) = 0 and v_mode <> 'fx' then raise exception 'no_targets'; end if;
  if jsonb_array_length(v_lists) > 0 then
    if not tenant_has_feature_for(p_tenant, 'listas_precios') then
      raise exception 'feature_not_in_plan: listas_precios' using errcode = 'check_violation';
    end if;
    if exists (select 1 from jsonb_array_elements_text(v_lists) x(id)
                where _price_uuid(x.id) is null
                   or not exists (select 1 from price_lists l
                                   where l.id = _price_uuid(x.id) and l.tenant_id = p_tenant and l.deleted_at is null)) then
      raise exception 'price_list_not_found';
    end if;
  end if;
  v_err := price_rounding_error(p -> 'rounding');
  if v_err is not null then raise exception '%', v_err; end if;

  if v_mode in ('pct', 'amount', 'markup') then
    v_value := (p ->> 'value')::numeric;
    if v_value is null then raise exception 'invalid_value'; end if;
    if v_mode = 'pct' and (v_value <= -100 or v_value > 1000) then raise exception 'invalid_value'; end if;
    if v_mode = 'amount' and abs(v_value) > 100000000 then raise exception 'invalid_value'; end if;
    if v_mode = 'markup' and (v_value <= -100 or v_value > 10000 or (v_mm = 'margin' and v_value >= 100)) then
      raise exception 'invalid_value';
    end if;
  else
    v_value := 0;
  end if;

  if v_mode = 'fx' then
    if not tenant_has_feature_for(p_tenant, 'precios_usd') then
      raise exception 'feature_not_in_plan: precios_usd' using errcode = 'check_violation';
    end if;
    if v_eff is not null then raise exception 'fx_cannot_schedule'; end if;
    v_rate := nullif(p -> 'fx' ->> 'rate', '')::numeric;
    v_src := coalesce(nullif(p -> 'fx' ->> 'source', ''),
                      (select s.fx_source from price_settings s where s.tenant_id = p_tenant), 'oficial');
    if v_src not in ('oficial', 'mep', 'bna', 'manual') then raise exception 'invalid_fx_source'; end if;
    if v_rate is not null then
      if v_rate <= 0 or v_rate >= 100000000 then raise exception 'invalid_fx_rate'; end if;
      v_fx := jsonb_build_object('rate', round(v_rate, 4),
                                 'rate_date', (now() at time zone 'America/Argentina/Buenos_Aires')::date,
                                 'origin', 'manual', 'source', 'manual');
    else
      select * into q from fx_usd_quote(p_tenant, null, v_src);
      if q.rate is null then raise exception 'fx_rate_missing'; end if;
      v_fx := jsonb_build_object('rate', round(q.rate, 4), 'rate_date', q.rate_date, 'origin', q.origin, 'source', v_src);
    end if;
  end if;

  return jsonb_build_object(
    'mode', v_mode, 'value', v_value, 'markup_mode', v_mm, 'reprice', v_rep,
    'targets', jsonb_build_object('base', v_base, 'list_ids', v_lists),
    'scope', coalesce(p -> 'scope', '{}'::jsonb),
    'rounding', p -> 'rounding',
    'fx', v_fx,
    'effective_at', v_eff,
    'reason', nullif(btrim(coalesce(p ->> 'reason', '')), ''));
end;
$$;

-- -----------------------------------------------------------------------------
-- Cálculo de las líneas (autoritativo; la vista previa y el lote salen de acá)
-- -----------------------------------------------------------------------------
create or replace function _price_bulk_v2_compute(p_tenant uuid, r jsonb)
returns table (
  product_id uuid, variant_id uuid, list_id uuid, name text, sku text, image_url text,
  old_price numeric, new_price numeric, old_cost numeric, new_cost numeric,
  old_fx_rate numeric, new_fx_rate numeric, old_fx_date date,
  final_cost numeric, margin_pct numeric, flags text[])
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode   text := r ->> 'mode';
  v_value  numeric := (r ->> 'value')::numeric;
  v_mm     text := r ->> 'markup_mode';
  v_rep    text := r ->> 'reprice';
  v_round  jsonb := r -> 'rounding';
  v_base   boolean := (r -> 'targets' ->> 'base')::boolean;
  v_lists  uuid[] := array(select _price_uuid(x) from jsonb_array_elements_text(r -> 'targets' -> 'list_ids') x);
  v_rate   numeric := nullif(r -> 'fx' ->> 'rate', '')::numeric;
  v_floor  numeric;
  v_alert  numeric;
  p        record;
  it       record;
  v_ofinal numeric;
  v_nfinal numeric;
  v_ncost  numeric;
  v_iva    numeric;
  v_bold   numeric;
  v_braw   numeric;
  v_bnew   numeric;
  v_pfloor numeric;
  v_inc    boolean;
  v_lp     numeric;
begin
  select s.floor_margin_pct into v_floor from price_settings s where s.tenant_id = p_tenant;
  if not price_pro_enabled(p_tenant) then v_floor := null; end if;
  select coalesce(m.min_margin_pct, 20) into v_alert from margin_alert_settings m where m.tenant_id = p_tenant;
  v_alert := coalesce(v_alert, 20);

  for p in
    select x.* from products x
     where x.id in (select _price_bulk_v2_scope(p_tenant, r -> 'scope'))
     order by x.name, x.id
  loop
    v_ofinal := coalesce(p.final_cost, price_final_cost(p.cost, p.cost_extras));
    if v_mode = 'fx' then
      continue when p.cost_currency <> 'USD' or p.cost_usd is null;
      v_ncost := price_usd_to_ars(p.cost_usd, v_rate);
      v_nfinal := price_final_cost(v_ncost, p.cost_extras);
    else
      v_ncost := p.cost;
      v_nfinal := v_ofinal;
    end if;
    v_iva := _price_iva_pct(p_tenant, p.id);
    v_bold := round(coalesce(_price_sched(p_tenant, null, p.id, null, now()), p.price, 0), 2);
    v_braw := price_bulk_raw(v_mode, v_value, v_mm, v_bold, v_ofinal, v_nfinal,
                             p.markup_mode, p.markup_pct, v_rep, v_iva);
    -- Sin utilidad objetivo (cost, fx+target) el producto no cambia de precio.
    v_bnew := coalesce(price_bulk_round(v_braw, v_round), v_bold);
    v_pfloor := greatest(coalesce(case when p.min_price > 0 then round(p.min_price, 2) end, 0),
                         case when v_floor is not null then price_floor_from_final(v_nfinal, v_floor, v_iva) else 0 end);

    -- Línea del precio de venta (en fx lleva además el costo aunque el precio no cambie).
    if (v_base and v_bnew is distinct from v_bold) or (v_mode = 'fx' and v_ncost is distinct from p.cost) then
      product_id := p.id; variant_id := null; list_id := null;
      name := p.name; sku := p.sku; image_url := p.image_url;
      old_price := v_bold;
      new_price := case when v_base then v_bnew else v_bold end;
      old_cost := p.cost; new_cost := v_ncost;
      old_fx_rate := case when v_mode = 'fx' then p.cost_fx_rate end;
      new_fx_rate := case when v_mode = 'fx' then v_rate end;
      old_fx_date := case when v_mode = 'fx' then p.cost_fx_date end;
      final_cost := v_nfinal;
      margin_pct := price_margin_pct(new_price, v_nfinal, v_iva);
      flags := array_remove(array[
        case when v_nfinal > 0 and new_price > 0 and margin_pct < 0 then 'below_cost' end,
        case when new_price < v_pfloor then 'below_floor' end,
        case when margin_pct is not null and margin_pct >= 0 and margin_pct < v_alert then 'low_margin' end], null);
      return next;
    end if;

    -- Variantes con precio propio.
    if v_base then
      for it in
        select v.id, v.option1, v.option2, v.sku,
               round(coalesce(_price_sched(p_tenant, null, p.id, v.id, now()), v.price_override), 2) as price
          from product_variants v
         where v.product_id = p.id and v.tenant_id = p_tenant and v.deleted_at is null and v.price_override is not null
         order by v.option1, v.option2, v.id
      loop
        v_lp := case when v_mode in ('pct', 'amount') then _price_bulk_new(it.price, v_mode, v_value, v_round)
                     else price_bulk_follow(it.price, v_bold, v_braw, v_round) end;
        continue when v_lp is null or v_lp = it.price;
        product_id := p.id; variant_id := it.id; list_id := null;
        name := p.name || ' · ' || coalesce(it.option1, '') || coalesce(' / ' || it.option2, '');
        sku := coalesce(it.sku, p.sku); image_url := p.image_url;
        old_price := it.price; new_price := v_lp;
        old_cost := null; new_cost := null; old_fx_rate := null; new_fx_rate := null; old_fx_date := null;
        final_cost := v_nfinal;
        margin_pct := price_margin_pct(new_price, v_nfinal, v_iva);
        flags := array_remove(array[
          case when v_nfinal > 0 and margin_pct < 0 then 'below_cost' end,
          case when new_price < v_pfloor then 'below_floor' end,
          case when margin_pct is not null and margin_pct >= 0 and margin_pct < v_alert then 'low_margin' end], null);
        return next;
      end loop;
    end if;

    -- Precios fijos de las listas elegidas (los calculados por regla se recalculan solos).
    if array_length(v_lists, 1) > 0 then
      for it in
        select i.price_list_id, i.variant_id, i.price, l.prices_include_tax, l.name as list_name,
               (select concat_ws(' / ', nullif(v.option1, ''), nullif(v.option2, ''))
                  from product_variants v where v.id = i.variant_id) as vlabel
          from price_list_items i
          join price_lists l on l.id = i.price_list_id
         where i.tenant_id = p_tenant and i.product_id = p.id and i.price_list_id = any (v_lists)
           and l.deleted_at is null and coalesce(l.kind, 'fixed') <> 'currency'
         order by l.name, i.variant_id nulls first
      loop
        v_lp := case when v_mode in ('pct', 'amount') then _price_bulk_new(it.price, v_mode, v_value, v_round)
                     else price_bulk_follow(it.price, v_bold, v_braw, v_round) end;
        continue when v_lp is null or v_lp = it.price;
        v_inc := coalesce(it.prices_include_tax, true);
        product_id := p.id; variant_id := it.variant_id; list_id := it.price_list_id;
        name := p.name || coalesce(' · ' || nullif(it.vlabel, ''), '');
        sku := p.sku; image_url := p.image_url;
        old_price := it.price; new_price := v_lp;
        old_cost := null; new_cost := null; old_fx_rate := null; new_fx_rate := null; old_fx_date := null;
        final_cost := v_nfinal;
        margin_pct := price_margin_pct(new_price, v_nfinal, case when v_inc then v_iva else 0 end);
        flags := array_remove(array[
          case when v_nfinal > 0 and margin_pct < 0 then 'below_cost' end,
          case when v_floor is not null
                    and new_price < price_floor_from_final(v_nfinal, v_floor, case when v_inc then v_iva else 0 end)
               then 'below_floor' end,
          case when margin_pct is not null and margin_pct >= 0 and margin_pct < v_alert then 'low_margin' end], null);
        return next;
      end loop;
    end if;
  end loop;
end;
$$;

create or replace function _price_bulk_v2_role_check()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;

create or replace function price_bulk_v2_preview(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _price_bulk_v2_role_check();
  r jsonb := _price_bulk_v2_assert(v_tenant, p);
  v_scope int;
  v_usd   int;
  v_skip  int;
  v_mode  text := r ->> 'mode';
begin
  -- Productos que el modo no puede calcular: sin costo (markup y desde costo) o
  -- sin utilidad objetivo (desde costo y dólar con utilidad objetivo).
  select count(*), count(*) filter (where x.cost_currency = 'USD' and x.cost_usd is not null),
         count(*) filter (where
           (v_mode = 'markup' and coalesce(x.final_cost, price_final_cost(x.cost, x.cost_extras), 0) <= 0)
           or ((v_mode = 'cost' or (v_mode = 'fx' and r ->> 'reprice' = 'target'
                                    and x.cost_currency = 'USD' and x.cost_usd is not null))
               and (x.markup_pct is null or coalesce(x.final_cost, price_final_cost(x.cost, x.cost_extras), 0) <= 0)))
    into v_scope, v_usd, v_skip
    from products x where x.id in (select _price_bulk_v2_scope(v_tenant, r -> 'scope'));
  return (
    with d as (select * from _price_bulk_v2_compute(v_tenant, r))
    select jsonb_build_object(
      'count', (select count(*) from d),
      'products', v_scope,
      'usd_products', v_usd,
      'fx', r -> 'fx',
      'before', coalesce((select sum(old_price) from d), 0),
      'after', coalesce((select sum(new_price) from d), 0),
      'price_changes', (select count(*) from d where new_price is distinct from old_price),
      'cost_changes', (select count(*) from d where new_cost is distinct from old_cost and new_fx_rate is not null),
      'below_cost', (select count(*) from d where 'below_cost' = any (flags)),
      'below_floor', (select count(*) from d where 'below_floor' = any (flags)),
      'low_margin', (select count(*) from d where 'low_margin' = any (flags)),
      'skipped', v_skip,
      'rows', coalesce((select jsonb_agg(to_jsonb(x)) from (select * from d limit 1000) x), '[]'::jsonb)));
end;
$$;

-- Crea el lote (manual o automático) y lo aplica, lo programa o lo deja para
-- aprobar. Interna: quien llama ya validó negocio y rol.
create or replace function _price_bulk_v2_new(p_tenant uuid, r jsonb, p_origin text, p_rule uuid, p_force_approval boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id     uuid;
  v_count  int;
  v_status text;
  v_appr   boolean;
  v_lists  uuid[] := array(select _price_uuid(x) from jsonb_array_elements_text(r -> 'targets' -> 'list_ids') x);
  v_eff    timestamptz := nullif(r ->> 'effective_at', '')::timestamptz;
begin
  if v_eff is not null and v_eff < now() - interval '1 minute' then raise exception 'effective_at_past'; end if;
  select coalesce(s.require_approval, false) into v_appr from price_settings s where s.tenant_id = p_tenant;
  v_appr := coalesce(p_force_approval, false)
            or (coalesce(v_appr, false) and price_pro_enabled(p_tenant) and coalesce(stock_my_role(), '') <> 'owner');

  insert into price_bulk_batches (tenant_id, target_list_id, scope, mode, value, rounding, effective_at, status, reason,
                                  engine, options, list_ids, fx_rate, fx_rate_date, fx_origin, origin, rule_id)
  values (p_tenant, case when array_length(v_lists, 1) = 1 and not (r -> 'targets' ->> 'base')::boolean then v_lists[1] end,
          r -> 'scope', r ->> 'mode', (r ->> 'value')::numeric, r -> 'rounding', v_eff, 'pending_approval',
          left(r ->> 'reason', 300), 2,
          jsonb_build_object('targets', r -> 'targets', 'reprice', r ->> 'reprice', 'markup_mode', r ->> 'markup_mode'),
          v_lists, (r -> 'fx' ->> 'rate')::numeric, (r -> 'fx' ->> 'rate_date')::date, r -> 'fx' ->> 'origin',
          p_origin, p_rule)
  returning id into v_id;

  insert into price_bulk_lines (tenant_id, batch_id, product_id, variant_id, list_id, old_price, new_price,
                                old_cost, new_cost, old_fx_rate, new_fx_rate, old_fx_date, final_cost, margin_pct, flags)
  select p_tenant, v_id, d.product_id, d.variant_id, d.list_id, d.old_price, d.new_price,
         d.old_cost, d.new_cost, d.old_fx_rate, d.new_fx_rate, d.old_fx_date, d.final_cost, d.margin_pct, d.flags
    from _price_bulk_v2_compute(p_tenant, r) d;
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'bulk_empty'; end if;
  if v_count > 20000 then raise exception 'bulk_too_large'; end if;
  update price_bulk_batches set line_count = v_count where id = v_id;

  if v_appr then
    v_status := 'pending_approval';
  else
    v_status := _price_bulk_execute(v_id);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), 'price_bulk_batches', v_id, 'price_bulk_created',
          jsonb_build_object('engine', 2, 'status', v_status, 'lines', v_count, 'mode', r ->> 'mode',
                             'value', r -> 'value', 'targets', r -> 'targets', 'scope', r -> 'scope',
                             'reprice', r ->> 'reprice', 'fx', r -> 'fx', 'effective_at', v_eff,
                             'origin', p_origin, 'rule_id', p_rule));
  return jsonb_build_object('id', v_id, 'status', v_status, 'count', v_count);
end;
$$;

create or replace function price_bulk_v2_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _price_bulk_v2_role_check();
begin
  return _price_bulk_v2_new(v_tenant, _price_bulk_v2_assert(v_tenant, p), 'manual', null, false);
end;
$$;

-- -----------------------------------------------------------------------------
-- B) Ejecución (v1 sin cambios; v2 con costos) y deshacer
-- -----------------------------------------------------------------------------
create or replace function _price_bulk_v2_execute(p_batch uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b price_bulk_batches%rowtype;
  l record;
begin
  select * into b from price_bulk_batches where id = p_batch for update;
  perform set_config('ninja.price_source', 'bulk', true);
  perform set_config('ninja.price_batch', b.id::text, true);
  perform set_config('ninja.price_reason', coalesce(b.reason, case b.origin when 'auto' then 'Actualización automática por dólar'
                                                                  else 'Actualización masiva' end), true);
  perform set_config('ninja.cost_source', 'fx', true);
  perform set_config('ninja.cost_reference', b.id::text, true);

  if b.effective_at is not null and b.effective_at > now() then
    insert into price_schedules (tenant_id, list_id, product_id, variant_id, price, effective_at, status, batch_id, source, created_by)
    select b.tenant_id, l2.list_id, l2.product_id, l2.variant_id, l2.new_price, b.effective_at, 'scheduled', b.id, 'bulk', b.created_by
      from price_bulk_lines l2 where l2.batch_id = b.id and l2.new_price is distinct from l2.old_price;
    update price_bulk_batches set status = 'scheduled' where id = b.id;
    return 'scheduled';
  end if;

  -- Costos primero (el trigger recalcula costo y costo final), después precios.
  for l in select * from price_bulk_lines where batch_id = b.id and new_fx_rate is not null loop
    update products set cost_fx_rate = l.new_fx_rate, cost_fx_date = b.fx_rate_date
     where id = l.product_id and tenant_id = b.tenant_id and cost_currency = 'USD';
  end loop;
  for l in select * from price_bulk_lines where batch_id = b.id and new_price is distinct from old_price loop
    perform _price_write(b.tenant_id, l.list_id, l.product_id, l.variant_id, l.new_price);
  end loop;
  update price_bulk_batches set status = 'applied', applied_at = now() where id = b.id;
  return 'applied';
end;
$$;
revoke all on function _price_bulk_v2_execute(uuid) from public, anon, authenticated;

create or replace function _price_bulk_execute(p_batch uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b price_bulk_batches%rowtype;
  l record;
begin
  select * into b from price_bulk_batches where id = p_batch for update;
  if b.engine = 2 then
    return _price_bulk_v2_execute(p_batch);
  end if;
  perform set_config('ninja.price_source', 'bulk', true);
  perform set_config('ninja.price_batch', b.id::text, true);
  perform set_config('ninja.price_reason', coalesce(b.reason, 'Actualización masiva'), true);
  if b.effective_at is not null and b.effective_at > now() then
    insert into price_schedules (tenant_id, list_id, product_id, variant_id, price, effective_at, status, batch_id, source, created_by)
    select b.tenant_id, l2.list_id, l2.product_id, l2.variant_id, l2.new_price, b.effective_at, 'scheduled', b.id, 'bulk', b.created_by
      from price_bulk_lines l2 where l2.batch_id = b.id;
    update price_bulk_batches set status = 'scheduled' where id = b.id;
    return 'scheduled';
  end if;
  for l in select * from price_bulk_lines where batch_id = b.id loop
    perform _price_write(b.tenant_id, l.list_id, l.product_id, l.variant_id, l.new_price);
  end loop;
  update price_bulk_batches set status = 'applied', applied_at = now() where id = b.id;
  return 'applied';
end;
$$;

create or replace function price_bulk_revert(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  b         price_bulk_batches%rowtype;
  l         record;
  v_cur     numeric;
  v_done    int := 0;
  v_skipped int := 0;
  v_cancel  int := 0;
  v_costs   int := 0;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into b from price_bulk_batches where id = p_batch and tenant_id = v_tenant for update;
  if not found then raise exception 'batch_not_found'; end if;
  if b.status not in ('applied', 'scheduled') then raise exception 'batch_not_revertible'; end if;
  perform set_config('ninja.price_source', 'bulk', true);
  perform set_config('ninja.price_batch', b.id::text, true);
  perform set_config('ninja.price_reason', 'Deshacer lote', true);
  perform set_config('ninja.cost_source', 'fx', true);
  perform set_config('ninja.cost_reference', b.id::text, true);

  update price_schedules set status = 'cancelled'
   where batch_id = b.id and status in ('scheduled', 'pending');
  get diagnostics v_cancel = row_count;

  if b.status = 'applied' or exists (select 1 from price_schedules s where s.batch_id = b.id and s.status = 'applied') then
    -- Costos en dólares: vuelve la cotización anterior si nadie la cambió después.
    for l in select * from price_bulk_lines where batch_id = b.id and new_fx_rate is not null loop
      update products set cost_fx_rate = l.old_fx_rate, cost_fx_date = l.old_fx_date
       where id = l.product_id and tenant_id = v_tenant and cost_currency = 'USD'
         and cost_fx_rate = l.new_fx_rate and l.old_fx_rate is not null;
      if found then v_costs := v_costs + 1; end if;
    end loop;
    for l in select * from price_bulk_lines where batch_id = b.id and new_price is distinct from old_price loop
      v_cur := null;
      if l.list_id is null and l.variant_id is null then
        select price into v_cur from products where id = l.product_id;
      elsif l.list_id is null then
        select price_override into v_cur from product_variants where id = l.variant_id;
      else
        select price into v_cur from price_list_items
         where price_list_id = l.list_id and product_id = l.product_id and variant_id is not distinct from l.variant_id;
      end if;
      if v_cur is not null and abs(v_cur - l.new_price) <= 0.005 then
        perform _price_write(v_tenant, l.list_id, l.product_id, l.variant_id, l.old_price);
        v_done := v_done + 1;
      else
        v_skipped := v_skipped + 1;
      end if;
    end loop;
  end if;

  update price_bulk_batches set status = 'reverted', reverted_at = now(), reverted_by = auth.uid() where id = b.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'price_bulk_batches', b.id, 'price_bulk_reverted',
          jsonb_build_object('reverted', v_done, 'skipped', v_skipped, 'cancelled', v_cancel, 'costs', v_costs));
  return jsonb_build_object('reverted', v_done, 'skipped', v_skipped, 'cancelled', v_cancel, 'costs', v_costs);
end;
$$;

-- Líneas de un lote para la pantalla (con miniatura y nombre de lista).
create or replace function price_bulk_lines_get(p_batch uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', l.product_id, 'variant_id', l.variant_id, 'list_id', l.list_id,
      'list_name', pl.name, 'name', p.name, 'sku', p.sku, 'image_url', p.image_url,
      'old_price', l.old_price, 'new_price', l.new_price, 'old_cost', l.old_cost, 'new_cost', l.new_cost,
      'final_cost', l.final_cost, 'margin_pct', l.margin_pct, 'flags', l.flags)
      order by p.name, pl.name nulls first), '[]'::jsonb)
    from price_bulk_lines l
    join products p on p.id = l.product_id
    left join price_lists pl on pl.id = l.list_id
   where l.batch_id = p_batch and l.tenant_id = (select current_tenant_id())
     and coalesce(stock_my_role(), '') in ('owner', 'manager');
$$;

-- -----------------------------------------------------------------------------
-- C) Regla automática por variación del dólar
-- -----------------------------------------------------------------------------
create table if not exists price_fx_rules (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 1 and 80),
  is_active        boolean not null default true,
  threshold_pct    numeric(6,3) not null check (threshold_pct > 0 and threshold_pct <= 100),
  fx_source        text not null default 'oficial' check (fx_source in ('oficial', 'mep', 'bna', 'manual')),
  request          jsonb not null default '{}'::jsonb,
  require_approval boolean not null default true,
  last_rate        numeric(14,4),
  last_rate_date   date,
  last_checked_at  timestamptz,
  last_batch_id    uuid references price_bulk_batches(id) on delete set null,
  last_result      text check (last_result is null or char_length(last_result) <= 300),
  created_by       uuid references users(id) default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists price_fx_rules_tenant_idx on price_fx_rules (tenant_id) where deleted_at is null;
create index if not exists price_fx_rules_batch_idx on price_fx_rules (last_batch_id) where last_batch_id is not null;
create index if not exists price_fx_rules_created_by_idx on price_fx_rules (created_by) where created_by is not null;
create index if not exists price_bulk_batches_rule_idx on price_bulk_batches (rule_id) where rule_id is not null;

alter table price_fx_rules enable row level security;
drop policy if exists price_fx_rules_select on price_fx_rules;
create policy price_fx_rules_select on price_fx_rules for select to authenticated
  using (tenant_id = (select current_tenant_id()));
revoke all on table price_fx_rules from anon;
revoke insert, update, delete, truncate on table price_fx_rules from authenticated;
grant select on table price_fx_rules to authenticated;

create or replace function price_fx_rule_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _price_bulk_v2_role_check();
  v_id     uuid := _price_uuid(p ->> 'id');
  v_req    jsonb := coalesce(p -> 'request', '{}'::jsonb);
  v_thr    numeric := (p ->> 'threshold_pct')::numeric;
  v_src    text := coalesce(nullif(p ->> 'fx_source', ''), 'oficial');
  v_before jsonb;
  q        record;
begin
  if not tenant_has_feature_for(v_tenant, 'precios_usd') then
    raise exception 'feature_not_in_plan: precios_usd' using errcode = 'check_violation';
  end if;
  if v_thr is null or v_thr <= 0 or v_thr > 100 then raise exception 'invalid_threshold'; end if;
  -- La regla siempre es por dólar; se valida como un pedido del asistente.
  v_req := v_req || jsonb_build_object('mode', 'fx', 'fx', jsonb_build_object('source', v_src));
  perform _price_bulk_v2_assert(v_tenant, v_req);
  v_req := v_req - 'fx' - 'effective_at';
  -- Aprobar es del dueño: un encargado no puede sacar la aprobación.
  if not coalesce((p ->> 'require_approval')::boolean, true) and stock_my_role() <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_id is null then
    select * into q from fx_usd_quote(v_tenant, null, v_src);
    insert into price_fx_rules (tenant_id, name, is_active, threshold_pct, fx_source, request, require_approval,
                                last_rate, last_rate_date)
    values (v_tenant, coalesce(nullif(btrim(p ->> 'name'), ''), 'Actualizar por dólar'),
            coalesce((p ->> 'is_active')::boolean, true), v_thr, v_src, v_req,
            coalesce((p ->> 'require_approval')::boolean, true), q.rate, q.rate_date)
    returning id into v_id;
  else
    select to_jsonb(x) into v_before from price_fx_rules x where x.id = v_id and x.tenant_id = v_tenant and x.deleted_at is null;
    if v_before is null then raise exception 'rule_not_found'; end if;
    update price_fx_rules
       set name = coalesce(nullif(btrim(p ->> 'name'), ''), name),
           is_active = coalesce((p ->> 'is_active')::boolean, is_active),
           threshold_pct = v_thr, fx_source = v_src, request = v_req,
           require_approval = coalesce((p ->> 'require_approval')::boolean, require_approval),
           updated_at = now()
     where id = v_id;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'price_fx_rules', v_id, 'price_fx_rule_saved', v_before,
          (select to_jsonb(x) from price_fx_rules x where x.id = v_id));
  return v_id;
end;
$$;

create or replace function price_fx_rule_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _price_bulk_v2_role_check();
begin
  update price_fx_rules set deleted_at = now(), is_active = false, updated_at = now()
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then raise exception 'rule_not_found'; end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action)
  values (v_tenant, auth.uid(), 'price_fx_rules', p_id, 'price_fx_rule_deleted');
end;
$$;

-- Corrida (pg_cron, service_role): por cada regla activa de un negocio con
-- precios_usd, si la cotización se movió X % o más desde la última base, arma
-- el lote. La base se mueve a la cotización nueva (aplicado, pendiente o sin
-- productos para cambiar), así cada salto se procesa una sola vez.
create or replace function price_fx_auto_tick()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ru      price_fx_rules%rowtype;
  q       record;
  v_var   numeric;
  v_res   jsonb;
  v_req   jsonb;
  v_runs  int := 0;
  v_made  int := 0;
  v_msg   text;
begin
  for ru in
    select x.* from price_fx_rules x
     where x.is_active and x.deleted_at is null
     order by x.tenant_id, x.created_at
  loop
    v_runs := v_runs + 1;
    begin
      if not tenant_has_feature_for(ru.tenant_id, 'precios_usd') then
        update price_fx_rules set last_checked_at = now(), last_result = 'Sin la función Costos en dólares en el plan'
         where id = ru.id;
        continue;
      end if;
      select * into q from fx_usd_quote(ru.tenant_id, null, ru.fx_source);
      if q.rate is null then
        update price_fx_rules set last_checked_at = now(), last_result = 'Sin cotización' where id = ru.id;
        continue;
      end if;
      if ru.last_rate is null or ru.last_rate <= 0 then
        update price_fx_rules set last_rate = q.rate, last_rate_date = q.rate_date, last_checked_at = now(),
                                  last_result = 'Cotización base guardada' where id = ru.id;
        continue;
      end if;
      v_var := round((q.rate / ru.last_rate - 1) * 100, 3);
      if abs(v_var) < ru.threshold_pct then
        update price_fx_rules set last_checked_at = now(),
               last_result = 'Variación ' || v_var::text || ' %, debajo del umbral' where id = ru.id;
        continue;
      end if;

      v_req := ru.request || jsonb_build_object(
        'mode', 'fx',
        'fx', jsonb_build_object('rate', round(q.rate, 4), 'rate_date', q.rate_date, 'origin', q.origin, 'source', ru.fx_source),
        'reason', 'Dólar ' || to_char(ru.last_rate, 'FM999999990.00') || ' a ' || to_char(q.rate, 'FM999999990.00')
                  || ' (' || v_var::text || ' %)');
      -- Valida como un pedido con cotización fija y deja el origen real (plataforma o negocio).
      v_req := _price_bulk_v2_assert(ru.tenant_id, v_req) || jsonb_build_object('fx', v_req -> 'fx');
      begin
        v_res := _price_bulk_v2_new(ru.tenant_id, v_req, 'auto', ru.id, ru.require_approval);
        v_made := v_made + 1;
        v_msg := case when v_res ->> 'status' = 'pending_approval'
                      then 'Hay ' || (v_res ->> 'count') || ' cambios para aprobar'
                      else 'Se aplicaron ' || (v_res ->> 'count') || ' cambios' end;
        insert into notifications (target_tenant_id, target_role, type, severity, title, body, action_label, action_url, expires_at)
        values (ru.tenant_id, 'owner', 'comercial', 'info',
                'El dólar se movió ' || v_var::text || ' %',
                ru.name || ': ' || v_msg || '. Dólar ' || to_char(q.rate, 'FM999999990.00') || '.',
                'Ver cambios', '/configuracion?seccion=precios', now() + interval '14 days');
        update price_fx_rules set last_rate = q.rate, last_rate_date = q.rate_date, last_checked_at = now(),
                                  last_batch_id = (v_res ->> 'id')::uuid, last_result = v_msg where id = ru.id;
      exception when others then
        if sqlerrm = 'bulk_empty' then
          update price_fx_rules set last_rate = q.rate, last_rate_date = q.rate_date, last_checked_at = now(),
                                    last_result = 'Sin productos para cambiar' where id = ru.id;
        else
          raise;
        end if;
      end;
    exception when others then
      update price_fx_rules set last_checked_at = now(), last_result = left('Error: ' || sqlerrm, 300) where id = ru.id;
    end;
  end loop;
  return jsonb_build_object('rules', v_runs, 'batches', v_made);
end;
$$;

-- -----------------------------------------------------------------------------
-- Permisos
-- -----------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'price_bulk_v2_preview(jsonb)',
    'price_bulk_v2_create(jsonb)',
    'price_bulk_lines_get(uuid)',
    'price_fx_rule_save(jsonb)',
    'price_fx_rule_delete(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    '_price_bulk_v2_scope(uuid, jsonb)',
    '_price_bulk_v2_assert(uuid, jsonb)',
    '_price_bulk_v2_compute(uuid, jsonb)',
    '_price_bulk_v2_new(uuid, jsonb, text, uuid, boolean)',
    '_price_bulk_v2_role_check()',
    '_price_bulk_execute(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  execute 'revoke all on function price_fx_auto_tick() from public, anon, authenticated';
  execute 'grant execute on function price_fx_auto_tick() to service_role';
end
$grants$;

-- pg_cron: 30 minutos después de platform-fx-sync (ADR-135). SQL directo, sin
-- Edge. Sin pg_cron (local, CI) se omite.
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite price-fx-auto.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'price-fx-auto') then
    perform cron.unschedule('price-fx-auto');
  end if;
  perform cron.schedule('price-fx-auto', '45 12,21 * * *', 'select public.price_fx_auto_tick()');
end
$cron$;
