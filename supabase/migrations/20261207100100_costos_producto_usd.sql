-- =============================================================================
-- 20261207100100_costos_producto_usd  (ADR-140, PR A)
--
-- Modelo de costos del producto y resolución única de precios:
--
--   A) Cotización del dólar para los negocios: fx_usd_quote(tenant, fecha,
--      fuente) = la del día o la última anterior, entre la del negocio
--      (fx_rates, ADR-058) y la oficial venta de la plataforma
--      (platform_fx_rates, ADR-135). Gana la fecha más nueva; si empatan,
--      la del negocio (es la que el dueño fijó a mano). La de la plataforma
--      sólo existe para la fuente 'oficial'. fx_rate_usd_on() devuelve sólo
--      el número; price_fx_quote() es el wrapper para el usuario.
--   B) Costos del producto: moneda del costo (ARS o USD), costo en USD con la
--      cotización usada (tasa y fecha), componentes del costo (jsonb: % o $,
--      con signo para bonificaciones), costo final (columna generada) y
--      utilidad objetivo (markup sobre costo o margen sobre precio).
--      Invariante en USD: cost = round(cost_usd × cost_fx_rate, 2).
--   C) Funciones puras (IMMUTABLE) del cálculo, espejo de lib/prices/costing.ts
--      con paridad probada en PGlite sobre cientos de casos al azar.
--   D) Historial de precios y de costos con lote y motivo (columnas con
--      default desde la sesión: ninja.price_batch / ninja.price_reason), sin
--      recrear los triggers de ADR-056.
--   E) Resolución: base de costo 'final' en las listas sobre costo y en el
--      margen mínimo, piso global de margen sobre el costo final (PRO,
--      price_settings.floor_margin_pct), dólar de la plataforma en las listas
--      en moneda y en el índice 'fx', y _catalog_unit_price pasa por
--      _resolve_unit_price (el catálogo, el POS y ML resuelven igual).
--
-- Partió de las definiciones vigentes en producción (pg_get_functiondef, solo
-- lectura) de _resolve_unit_price, _price_cost, _price_fx, _price_index_pct,
-- price_context_snapshot, price_settings_get y price_settings_save.
-- Aditiva. NO aplicada todavía. Requiere 20261130100000 (ADR-135).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Cotización del dólar: negocio o plataforma, la del día o la anterior.
-- -----------------------------------------------------------------------------
create or replace function fx_usd_quote(p_tenant uuid, p_date date default null, p_source text default 'oficial')
returns table (rate numeric, rate_date date, origin text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.rate, x.rate_date, x.origin from (
    (select r.rate, r.rate_date, 'negocio'::text as origin, 0 as prio
       from fx_rates r
      where r.tenant_id = p_tenant and r.currency = 'USD'
        and r.source = coalesce(nullif(p_source, ''), 'oficial')
        and r.rate_date <= coalesce(p_date, (now() at time zone 'America/Argentina/Buenos_Aires')::date)
      order by r.rate_date desc
      limit 1)
    union all
    (select f.venta, f.rate_date, 'plataforma'::text, 1
       from platform_fx_rates f
      where coalesce(nullif(p_source, ''), 'oficial') = 'oficial'
        and f.casa = 'oficial' and f.deleted_at is null
        and f.rate_date <= coalesce(p_date, (now() at time zone 'America/Argentina/Buenos_Aires')::date)
      order by f.rate_date desc, (f.source = 'manual') desc, f.updated_at desc
      limit 1)
  ) x
  where x.rate > 0
  order by x.rate_date desc, x.prio
  limit 1;
$$;
revoke all on function fx_usd_quote(uuid, date, text) from public, anon, authenticated;

-- Semántica pedida por ADR-135: "cotización del día o la última anterior".
create or replace function fx_rate_usd_on(p_tenant uuid, p_date date default null, p_source text default 'oficial')
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select q.rate from fx_usd_quote(p_tenant, p_date, p_source) q;
$$;
revoke all on function fx_rate_usd_on(uuid, date, text) from public, anon, authenticated;

-- Para el usuario (cualquier rol del negocio: es una cotización pública).
create or replace function price_fx_quote(p_date date default null, p_source text default 'oficial')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  q record;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if coalesce(p_source, 'oficial') not in ('oficial', 'mep', 'bna', 'manual') then raise exception 'invalid_fx_source'; end if;
  select * into q from fx_usd_quote(v_tenant, p_date, p_source);
  return jsonb_build_object('rate', q.rate, 'rate_date', q.rate_date, 'origin', q.origin,
                            'source', coalesce(p_source, 'oficial'));
end;
$$;
revoke all on function price_fx_quote(date, text) from public, anon;
grant execute on function price_fx_quote(date, text) to authenticated;

-- Las listas en moneda extranjera usan la misma regla para el dólar.
create or replace function _price_fx(p_tenant uuid, p_currency text, p_source text, p_at timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p_currency = 'USD' then
    (select q.rate from fx_usd_quote(p_tenant, (p_at at time zone 'America/Argentina/Buenos_Aires')::date,
                                     coalesce(p_source, 'manual')) q)
  else
    (select r.rate from fx_rates r
      where r.tenant_id = p_tenant and r.currency = p_currency and r.source = coalesce(p_source, 'manual')
        and r.rate_date <= (p_at at time zone 'America/Argentina/Buenos_Aires')::date
      order by r.rate_date desc
      limit 1)
  end;
$$;

create or replace function _price_index_pct(p_tenant uuid, p jsonb)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := p ->> 'kind';
  v_from numeric;
  v_to   numeric;
  v_pct  numeric;
  v_cap  numeric := nullif(p ->> 'cap_pct', '')::numeric;
  v_tod  date := coalesce(nullif(p ->> 'to', '')::date, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  v_cur  text := coalesce(p ->> 'currency', 'USD');
  v_src  text := coalesce(p ->> 'source', 'oficial');
begin
  if v_kind = 'fx' then
    if v_cur = 'USD' then
      v_from := fx_rate_usd_on(p_tenant, (p ->> 'from')::date, v_src);
      v_to := fx_rate_usd_on(p_tenant, v_tod, v_src);
    else
      select r.rate into v_from from fx_rates r
       where r.tenant_id = p_tenant and r.currency = v_cur and r.source = v_src and r.rate_date <= (p ->> 'from')::date
       order by r.rate_date desc limit 1;
      select r.rate into v_to from fx_rates r
       where r.tenant_id = p_tenant and r.currency = v_cur and r.source = v_src and r.rate_date <= v_tod
       order by r.rate_date desc limit 1;
    end if;
  elsif v_kind = 'index' then
    select v.value into v_from from price_index_values v
     where v.tenant_id = p_tenant and v.index_key = coalesce(p ->> 'key', 'ipc') and v.period <= (p ->> 'from')::date
     order by v.period desc limit 1;
    select v.value into v_to from price_index_values v
     where v.tenant_id = p_tenant and v.index_key = coalesce(p ->> 'key', 'ipc') and v.period <= v_tod
     order by v.period desc limit 1;
  else
    raise exception 'invalid_index';
  end if;
  if v_from is null or v_to is null or v_from <= 0 then raise exception 'index_value_missing'; end if;
  v_pct := round((v_to / v_from - 1) * 100, 4);
  if v_cap is not null and v_pct > v_cap then v_pct := v_cap; end if;
  return v_pct;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Funciones puras del cálculo (espejo de lib/prices/costing.ts).
-- -----------------------------------------------------------------------------

-- Componentes del costo: [{ "label": text, "type": "pct" | "amount", "value": n }]
-- Hasta 10. % entre -100 y 1000 (negativo = bonificación); $ entre ±1.000.000.000.
create or replace function price_cost_extras_error(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  e jsonb;
  v numeric;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 10 then return 'invalid_cost_extras'; end if;
  for e in select x from jsonb_array_elements(p) x loop
    if jsonb_typeof(e) <> 'object' then return 'invalid_cost_extras'; end if;
    if coalesce(e ->> 'type', '') not in ('pct', 'amount') then return 'invalid_cost_extras'; end if;
    if char_length(coalesce(e ->> 'label', '')) > 60 then return 'invalid_cost_extras'; end if;
    begin
      v := (e ->> 'value')::numeric;
    exception when others then
      return 'invalid_cost_extras';
    end;
    if v is null then return 'invalid_cost_extras'; end if;
    if e ->> 'type' = 'pct' and (v <= -100 or v > 1000) then return 'invalid_cost_extras'; end if;
    if e ->> 'type' = 'amount' and abs(v) > 1000000000 then return 'invalid_cost_extras'; end if;
  end loop;
  return null;
end;
$$;

-- Costo final = costo + Σ (costo × % / 100, a centavos) + Σ $. Nunca negativo.
-- Los % se aplican sobre el costo de compra (no en cascada).
create or replace function price_final_cost(p_cost numeric, p_extras jsonb)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_base numeric;
  v      numeric;
  e      jsonb;
begin
  if p_cost is null then return null; end if;
  v_base := round(p_cost, 2);
  v := v_base;
  if p_extras is not null and jsonb_typeof(p_extras) = 'array' then
    for e in select x from jsonb_array_elements(p_extras) x loop
      continue when jsonb_typeof(e) <> 'object' or (e ->> 'value') is null;
      if e ->> 'type' = 'pct' then
        v := v + round(v_base * (e ->> 'value')::numeric / 100, 2);
      elsif e ->> 'type' = 'amount' then
        v := v + round((e ->> 'value')::numeric, 2);
      end if;
    end loop;
  end if;
  return greatest(v, 0);
end;
$$;

-- Precio neto desde el costo: markup (costo × (1 + m)) o margen (costo / (1 − m)).
-- Con IVA (p_iva_pct > 0) el resultado es el precio final: neto × (1 + IVA).
-- null cuando no se puede calcular (sin costo, margen >= 100).
create or replace function price_from_cost(p_cost numeric, p_mode text, p_value numeric, p_iva_pct numeric default 0)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v numeric;
begin
  if p_cost is null or p_cost <= 0 or p_value is null then return null; end if;
  if coalesce(p_mode, 'markup') = 'margin' then
    if p_value >= 100 then return null; end if;
    v := round(p_cost / (1 - p_value / 100), 2);
  else
    if p_value <= -100 then return null; end if;
    v := round(p_cost * (1 + p_value / 100), 2);
  end if;
  if coalesce(p_iva_pct, 0) <> 0 then
    v := round(v * (1 + p_iva_pct / 100), 2);
  end if;
  return v;
end;
$$;

-- Costo en pesos desde el costo en dólares.
create or replace function price_usd_to_ars(p_usd numeric, p_rate numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_usd is null or p_rate is null or p_rate <= 0 then null else round(p_usd * p_rate, 2) end;
$$;

-- -----------------------------------------------------------------------------
-- B) Costos del producto.
-- -----------------------------------------------------------------------------
alter table products add column if not exists cost_currency text not null default 'ARS';
alter table products add column if not exists cost_usd numeric(14,4);
alter table products add column if not exists cost_fx_rate numeric(14,4);
alter table products add column if not exists cost_fx_date date;
alter table products add column if not exists cost_fx_source text;
alter table products add column if not exists cost_extras jsonb not null default '[]'::jsonb;
alter table products add column if not exists markup_mode text;
alter table products add column if not exists markup_pct numeric(9,3);
-- Costo final: lo mantiene el trigger en cada alta y cambio. null = nunca se
-- tocó desde esta migración = igual al costo (sin componentes): los lectores
-- usan coalesce(final_cost, cost). Sin backfill (no dispara triggers de 189+
-- productos ni ensucia auditoría e historial).
alter table products add column if not exists final_cost numeric(14,2);

alter table products drop constraint if exists products_costing_check;
alter table products add constraint products_costing_check check (
  cost_currency in ('ARS', 'USD')
  and (cost_usd is null or (cost_usd >= 0 and cost_usd < 1000000000))
  and (cost_fx_rate is null or (cost_fx_rate > 0 and cost_fx_rate < 100000000))
  and (cost_fx_source is null or cost_fx_source in ('oficial', 'mep', 'bna', 'manual'))
  and (cost_currency = 'ARS' or cost_fx_rate is not null)
  and (markup_mode is null or markup_mode in ('markup', 'margin'))
  and (markup_pct is null or (markup_pct > -100 and markup_pct <= 10000))
  and (markup_mode is distinct from 'margin' or markup_pct is null or markup_pct < 100)
  and jsonb_typeof(cost_extras) = 'array'
);

create index if not exists products_cost_usd_idx on products (tenant_id) where cost_currency = 'USD' and deleted_at is null;

comment on column products.cost_currency is 'ADR-140: moneda del costo de compra (ARS o USD). En USD, cost = round(cost_usd × cost_fx_rate, 2).';
comment on column products.cost_extras is 'ADR-140: componentes del costo [{label, type pct|amount, value}] sobre el costo de compra.';
comment on column products.final_cost is 'ADR-140: costo final = costo + componentes (trigger; null = igual al costo).';
comment on column products.markup_pct is 'ADR-140: utilidad objetivo; markup_mode markup = sobre costo, margin = sobre precio.';

-- Trigger: valida, gatea y mantiene el invariante del costo en dólares.
-- Corre DESPUÉS de products_cost_track (orden alfabético: "products_cost_"
-- < "products_costing_"), así ve el costo que dejó la sincronización de compras.
create or replace function trg_products_costing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_err  text;
  v_in   numeric := new.cost;
  q      record;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  v_err := price_cost_extras_error(new.cost_extras);
  if v_err is not null then raise exception '%', v_err using errcode = 'check_violation'; end if;
  new.cost_extras := coalesce(new.cost_extras, '[]'::jsonb);

  -- Costo final y utilidad objetivo (BASE: sólo si el plan la apagó a mano).
  if (jsonb_array_length(new.cost_extras) > 0 or new.markup_pct is not null)
     and (tg_op = 'INSERT' or new.cost_extras is distinct from old.cost_extras
          or new.markup_pct is distinct from old.markup_pct or new.markup_mode is distinct from old.markup_mode)
     and not tenant_has_feature_for(new.tenant_id, 'costo_final') then
    raise exception 'feature_not_in_plan: costo_final' using errcode = 'check_violation';
  end if;

  if new.cost_currency = 'USD' then
    if (tg_op = 'INSERT' or old.cost_currency <> 'USD' or new.cost_usd is distinct from old.cost_usd)
       and not tenant_has_feature_for(new.tenant_id, 'precios_usd') then
      raise exception 'feature_not_in_plan: precios_usd' using errcode = 'check_violation';
    end if;
    if new.cost_fx_rate is null then
      select * into q from fx_usd_quote(new.tenant_id, v_today, coalesce(new.cost_fx_source, 'oficial'));
      if q.rate is null then raise exception 'fx_rate_missing' using errcode = 'check_violation'; end if;
      new.cost_fx_rate := round(q.rate, 4);
      new.cost_fx_date := q.rate_date;
    end if;
    new.cost_fx_source := coalesce(new.cost_fx_source, 'oficial');
    if tg_op = 'INSERT' or old.cost_currency <> 'USD' then
      if new.cost_usd is null and new.cost is not null then
        new.cost_usd := round(new.cost / new.cost_fx_rate, 4);
      end if;
      if new.cost_usd is not null then new.cost := price_usd_to_ars(new.cost_usd, new.cost_fx_rate); end if;
    elsif new.cost_usd is distinct from old.cost_usd or new.cost_fx_rate is distinct from old.cost_fx_rate then
      if new.cost_usd is not null then new.cost := price_usd_to_ars(new.cost_usd, new.cost_fx_rate); end if;
    elsif new.cost is distinct from old.cost then
      -- Una recepción o una carga en pesos: el costo en dólares la sigue.
      new.cost_usd := case when new.cost is null then null else round(new.cost / new.cost_fx_rate, 4) end;
    end if;
  else
    new.cost_usd := null;
    new.cost_fx_rate := null;
    new.cost_fx_date := null;
  end if;

  -- products_cost_track ya registró el cambio que vio; acá sólo el que hizo este trigger.
  if tg_op = 'UPDATE' and new.cost is distinct from v_in then
    insert into product_cost_history (tenant_id, product_id, kind, old_value, new_value, source, reference_id)
    values (new.tenant_id, new.id, 'cost', v_in, new.cost,
            coalesce(nullif(current_setting('ninja.cost_source', true), ''), 'fx'),
            nullif(current_setting('ninja.cost_reference', true), '')::uuid);
    new.cost_updated_at := now();
  end if;
  new.final_cost := price_final_cost(new.cost, new.cost_extras);
  return new;
end;
$$;

drop trigger if exists products_costing_usd on products;
-- Sólo cuando se tocan columnas de costo: el descuento de stock de cada venta
-- (update de products.stock) no paga este trigger.
create trigger products_costing_usd
  before insert or update of cost, last_cost, avg_cost, replacement_cost, cost_currency, cost_usd,
                             cost_fx_rate, cost_fx_source, cost_extras, markup_mode, markup_pct, final_cost
  on products
  for each row execute function trg_products_costing();

-- -----------------------------------------------------------------------------
-- D) Historial con lote y motivo.
-- -----------------------------------------------------------------------------
create or replace function _price_session_batch()
returns uuid
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return _price_uuid(nullif(current_setting('ninja.price_batch', true), ''));
exception when others then
  return null;
end;
$$;

create or replace function _price_session_reason()
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return left(nullif(btrim(coalesce(current_setting('ninja.price_reason', true), '')), ''), 300);
exception when others then
  return null;
end;
$$;

alter table product_price_history add column if not exists batch_id uuid default _price_session_batch();
alter table product_price_history add column if not exists reason text default _price_session_reason();
alter table product_cost_history add column if not exists batch_id uuid default _price_session_batch();
alter table product_cost_history add column if not exists reason text default _price_session_reason();
create index if not exists product_price_history_batch_idx on product_price_history (batch_id) where batch_id is not null;
create index if not exists product_cost_history_batch_idx on product_cost_history (batch_id) where batch_id is not null;

-- -----------------------------------------------------------------------------
-- E) Resolución.
-- -----------------------------------------------------------------------------

-- Base de costo 'final' (costo final con componentes).
alter table price_lists drop constraint if exists price_lists_pro_check;
alter table price_lists add constraint price_lists_pro_check check (
  kind in ('fixed', 'derived', 'cost', 'currency')
  and (cost_basis is null or cost_basis in ('cost', 'last', 'average', 'replacement', 'final'))
  and (markup_mode is null or markup_mode in ('markup', 'margin'))
  and (markup_value is null or (markup_value > -100 and markup_value <= 10000))
  and (markup_mode is distinct from 'margin' or markup_value is null or markup_value < 100)
  and (currency is null or currency ~ '^[A-Z]{3}$')
  and (fx_source is null or fx_source in ('oficial', 'mep', 'bna', 'manual'))
  and (min_margin_pct is null or (min_margin_pct >= 0 and min_margin_pct < 100))
  and (adjustment_amount is null or abs(adjustment_amount) <= 100000000)
  and (valid_from is null or valid_to is null or valid_from < valid_to)
  and (base_list_id is null or base_list_id <> id)
  and (kind <> 'derived' or base_list_id is not null)
  and (kind <> 'currency' or currency is not null)
  and (notes is null or char_length(notes) <= 500)
);

create or replace function _price_cost(p_product uuid, p_basis text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(case p_basis when 'last' then p.last_cost when 'average' then p.avg_cost
                               when 'replacement' then p.replacement_cost
                               when 'final' then coalesce(p.final_cost, round(p.cost, 2)) else p.cost end, p.cost)
    from products p where p.id = p_product;
$$;

-- IVA (en %) que lleva el precio final del producto: alícuota vigente del
-- negocio si discrimina IVA y la alícuota es gravada; si no, 0.
create or replace function _price_iva_pct(p_tenant uuid, p_product uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when _tax_discriminates(_tax_settings_eff(p_tenant) ->> 'iva_condition') then coalesce((
    select case when ir.kind = 'gravado' then ir.rate else 0 end
      from products p
      cross join lateral _tax_iva_rate_eff(p_tenant, coalesce(p.tax_rate_code, '21'),
                                           (now() at time zone 'America/Argentina/Buenos_Aires')::date) ir
     where p.id = p_product and p.tenant_id = p_tenant), 0) else 0 end;
$$;

-- Configuración: piso global de margen (PRO) y fuente del dólar por defecto.
alter table price_settings add column if not exists floor_margin_pct numeric(6,3)
  check (floor_margin_pct is null or (floor_margin_pct >= 0 and floor_margin_pct < 100));
alter table price_settings add column if not exists fx_source text not null default 'oficial'
  check (fx_source in ('oficial', 'mep', 'bna', 'manual'));

-- Piso sobre el costo final: precio >= costo final / (1 − m) (+ IVA si la lista
-- lleva IVA y el negocio lo discrimina). Redondea hacia arriba a centavos.
create or replace function price_floor_from_final(p_final numeric, p_margin numeric, p_iva_pct numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_final is null or p_final <= 0 or p_margin is null or p_margin >= 100 then 0
              else ceil(p_final / (1 - p_margin / 100) * (1 + coalesce(p_iva_pct, 0) / 100) * 100) / 100 end;
$$;

create or replace function _resolve_unit_price(
  p_tenant uuid, p_product uuid, p_variant uuid default null, p_qty numeric default 1,
  p_customer uuid default null, p_store uuid default null, p_list_id uuid default null,
  p_at timestamptz default now(), p_term text default null, p_pos_list uuid default null)
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
  v_final   numeric;
  v_fm      numeric;
begin
  if p_tenant is null or p_product is null then return null; end if;

  select p.price, p.min_price, coalesce(p.final_cost, round(p.cost, 2)) into v_pbase, v_minp, v_final
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
    -- ADR-140: piso global sobre el costo final (con IVA si la lista lo lleva).
    select s.floor_margin_pct into v_fm from price_settings s where s.tenant_id = p_tenant;
    if v_fm is not null and v_final is not null and v_final > 0 then
      v_floor := greatest(v_floor, price_floor_from_final(v_final, v_fm,
                   case when coalesce(v_list.prices_include_tax, true) then _price_iva_pct(p_tenant, p_product) else 0 end));
    end if;
    if v_price < v_floor then v_price := v_floor; end if;
  end if;

  -- ADR-068: lista neta (sin IVA) o internos adicionales → precio final.
  v_price := _tax_price_to_final(p_tenant, p_product, p_variant, greatest(0, round(v_price, 2)),
                                 coalesce(v_list.prices_include_tax, true));
  return greatest(0, round(v_price, 2));
end;
$$;

-- El catálogo público resuelve igual que el POS y ML: misma función. Con lista
-- (la del canal catálogo) va por _resolve_unit_price con esa lista explícita y
-- contado; sin lista, el precio base de siempre. p_adj queda por compatibilidad.
create or replace function _catalog_unit_price(p_list uuid, p_adj numeric, p_product uuid, p_variant uuid, p_base numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v numeric;
begin
  if p_list is null then return coalesce(p_base, 0); end if;
  select l.tenant_id into v_tenant from price_lists l where l.id = p_list;
  if v_tenant is null then return coalesce(p_base, 0); end if;
  v := _resolve_unit_price(v_tenant, p_product, p_variant, 1, null, null, p_list, now(), 'none', null);
  return coalesce(v, p_base, 0);
end;
$$;
revoke all on function _catalog_unit_price(uuid, numeric, uuid, uuid, numeric) from public, anon, authenticated;

-- Configuración de precios: suma piso global y fuente del dólar.
create or replace function price_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v price_settings%rowtype;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  select * into v from price_settings where tenant_id = v_tenant;
  return jsonb_build_object(
    'mode', coalesce(v.mode, 'simple'),
    'require_approval', coalesce(v.require_approval, false),
    'label_queue', coalesce(v.label_queue, true),
    'floor_margin_pct', v.floor_margin_pct,
    'fx_source', coalesce(v.fx_source, 'oficial'),
    'pro', price_pro_enabled(v_tenant),
    'usd', coalesce(tenant_has_feature_for(v_tenant, 'precios_usd'), false),
    'final_cost', coalesce(tenant_has_feature_for(v_tenant, 'costo_final'), false));
end;
$$;

create or replace function price_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
  v_before jsonb;
  v_mode   text;
  v_appr   boolean;
  v_labels boolean;
  v_floor  numeric;
  v_fx     text;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_before := price_settings_get();
  v_mode   := coalesce(p ->> 'mode', v_before ->> 'mode');
  v_appr   := coalesce((p ->> 'require_approval')::boolean, (v_before ->> 'require_approval')::boolean);
  v_labels := coalesce((p ->> 'label_queue')::boolean, (v_before ->> 'label_queue')::boolean);
  v_floor  := case when p ? 'floor_margin_pct' then nullif(p ->> 'floor_margin_pct', '')::numeric
                   else (v_before ->> 'floor_margin_pct')::numeric end;
  v_fx     := coalesce(nullif(p ->> 'fx_source', ''), v_before ->> 'fx_source');
  if v_mode not in ('simple', 'pro') then raise exception 'invalid_mode'; end if;
  if v_fx not in ('oficial', 'mep', 'bna', 'manual') then raise exception 'invalid_fx_source'; end if;
  if v_floor is not null and (v_floor < 0 or v_floor >= 100) then raise exception 'invalid_floor_margin'; end if;
  if (v_mode = 'pro' and v_before ->> 'mode' <> 'pro') or (v_appr and not (v_before ->> 'require_approval')::boolean)
     or (v_floor is not null and v_floor is distinct from (v_before ->> 'floor_margin_pct')::numeric) then
    if not price_pro_enabled(v_tenant) then
      raise exception 'feature_not_in_plan: listas_precios_pro' using errcode = 'check_violation';
    end if;
  end if;
  if v_appr is distinct from (v_before ->> 'require_approval')::boolean and v_role <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- El piso cambia lo que cobra el POS: sólo el dueño.
  if v_floor is distinct from (v_before ->> 'floor_margin_pct')::numeric and v_role <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into price_settings as s (tenant_id, mode, require_approval, label_queue, floor_margin_pct, fx_source,
                                   updated_at, updated_by)
  values (v_tenant, v_mode, v_appr, v_labels, v_floor, v_fx, now(), auth.uid())
  on conflict (tenant_id) do update
    set mode = excluded.mode, require_approval = excluded.require_approval,
        label_queue = excluded.label_queue, floor_margin_pct = excluded.floor_margin_pct,
        fx_source = excluded.fx_source, updated_at = now(), updated_by = auth.uid();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'price_settings', v_tenant, 'price_settings_changed', v_before,
          jsonb_build_object('mode', v_mode, 'require_approval', v_appr, 'label_queue', v_labels,
                             'floor_margin_pct', v_floor, 'fx_source', v_fx));
  return price_settings_get();
end;
$$;

-- Foto del contexto de precios para el POS: suma el dólar de la plataforma
-- (como fuente 'oficial', origen 'plataforma'), el costo final y el IVA por
-- producto cuando hay piso global, y el piso.
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
  v_neto     boolean;
  v_int      boolean;
  v_fm       numeric;
  v_today    date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
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
  if v_pro then
    select s.floor_margin_pct into v_fm from price_settings s where s.tenant_id = v_tenant;
  end if;

  with recursive rel(id, depth) as (
    select l.id, 0 from price_lists l
     where l.tenant_id = v_tenant and l.deleted_at is null
       and (l.id = any (v_assigned) or l.pos_selectable or l.channel = 'mostrador')
    union
    select l.base_list_id, r.depth + 1 from price_lists l join rel r on l.id = r.id
     where l.base_list_id is not null and r.depth < 5)
  select coalesce(array_agg(distinct id), '{}') into v_rel from rel;

  v_costs := v_pro and (v_fm is not null or exists (select 1 from price_lists l where l.id = any (v_rel)
                                  and (l.kind = 'cost' or l.min_margin_pct is not null)));
  v_neto := exists (select 1 from price_lists l where l.id = any (v_rel) and not l.prices_include_tax);
  v_int := tenant_has_feature_for(v_tenant, 'impuestos_internos')
           and exists (select 1 from products p where p.tenant_id = v_tenant and p.deleted_at is null
                          and p.internal_tax_mode <> 'none');
  if v_pro and p_customer is not null then
    select c.payment_term_id into v_term from customers c where c.id = p_customer;
  end if;

  return jsonb_build_object(
    'pro', v_pro,
    'at', now(),
    'assigned', to_jsonb(v_assigned),
    'customerTermId', v_term,
    'floorMarginPct', v_fm,
    'lists', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'channel', l.channel, 'kind', l.kind,
        'adjustment_pct', l.adjustment_pct, 'adjustment_amount', l.adjustment_amount,
        'base_list_id', l.base_list_id, 'cost_basis', l.cost_basis, 'markup_mode', l.markup_mode,
        'markup_value', l.markup_value, 'currency', l.currency, 'fx_source', l.fx_source,
        'rounding', l.rounding, 'min_margin_pct', l.min_margin_pct, 'valid_from', l.valid_from,
        'valid_to', l.valid_to, 'is_active', l.is_active, 'pos_selectable', l.pos_selectable,
        'created_at', l.created_at, 'prices_include_tax', l.prices_include_tax) order by l.created_at)
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
    'fx', case when v_pro then coalesce((select jsonb_agg(x.r) from (
        select jsonb_build_object('currency', r.currency, 'source', r.source, 'rate', r.rate,
                                  'rate_date', r.rate_date, 'origin', 'negocio') as r
          from fx_rates r where r.tenant_id = v_tenant and r.rate_date >= v_today - 45
        union all
        select jsonb_build_object('currency', 'USD', 'source', 'oficial', 'rate', q.rate,
                                  'rate_date', q.rate_date, 'origin', 'plataforma')
          from (select f.venta as rate, f.rate_date from platform_fx_rates f
                 where f.casa = 'oficial' and f.deleted_at is null and f.rate_date <= v_today
                 order by f.rate_date desc, (f.source = 'manual') desc, f.updated_at desc limit 1) q) x), '[]'::jsonb)
      else '[]'::jsonb end,
    'costs', case when v_pro then coalesce((select jsonb_object_agg(p.id, jsonb_build_object(
        'cost', p.cost, 'last_cost', p.last_cost, 'avg_cost', p.avg_cost,
        'replacement_cost', p.replacement_cost, 'min_price', p.min_price, 'final_cost', coalesce(p.final_cost, round(p.cost, 2)),
        'iva_pct', case when v_fm is not null then _price_iva_pct(v_tenant, p.id) end))
      from products p where p.tenant_id = v_tenant and p.deleted_at is null
        and (v_costs or p.min_price is not null)), '{}'::jsonb)
      else '{}'::jsonb end,
    'tax', jsonb_build_object(
      'discriminates', _tax_discriminates(_tax_settings_eff(v_tenant) ->> 'iva_condition'),
      'internalEnabled', tenant_has_feature_for(v_tenant, 'impuestos_internos'),
      'rates', coalesce((select jsonb_object_agg(r.code, e.rate)
                           from tax_iva_rates r
                           cross join lateral _tax_iva_rate_eff(v_tenant, r.code, v_today) e
                          where e.rate is distinct from r.rate), '{}'::jsonb),
      'products', case when v_neto or v_int then coalesce((select jsonb_object_agg(p.id, jsonb_build_object(
          'rate_code', p.tax_rate_code, 'mode', p.internal_tax_mode, 'base', p.internal_tax_base,
          'rate', p.internal_tax_rate, 'amount', p.internal_tax_amount, 'included', p.internal_tax_included,
          'cost', p.cost,
          'variants', (select jsonb_object_agg(v.id, v.tax_rate_code) from product_variants v
                        where v.product_id = p.id and v.tax_rate_code is not null)))
        from products p where p.tenant_id = v_tenant and p.deleted_at is null
          and (v_neto or p.internal_tax_mode <> 'none')), '{}'::jsonb)
        else '{}'::jsonb end));
end;
$$;

-- -----------------------------------------------------------------------------
-- Permisos: las internas no se exponen; las puras se pueden llamar (sin datos).
-- -----------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    '_price_iva_pct(uuid, uuid)',
    'trg_products_costing()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end
$grants$;
