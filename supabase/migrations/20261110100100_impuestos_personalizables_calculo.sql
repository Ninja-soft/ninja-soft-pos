-- =============================================================================
-- 20261110100100_impuestos_personalizables_calculo  (F18, ADR-105)
--
-- El cálculo en el servidor lee SIEMPRE el valor efectivo del negocio
-- (versión con vigencia de tax_custom_values > plantilla de NinjaSoft). Las
-- funciones se RECREAN copiando la definición más nueva de cada una y
-- cambiando sólo la lectura del valor:
--
--   A) _tax_price_to_final (20261028100200): IVA efectivo (listas netas).
--   B) price_context_snapshot (20261028100300): tax.rates con las alícuotas
--      del negocio, para que el resolver del navegador (lib/prices/resolve.ts)
--      calcule el mismo precio final que valida create_sale.
--   C) _sale_tax_compute (20261028100200): IVA efectivo, tope del consumidor
--      final del negocio, regímenes en vigencia (tax_regimes.valid_from /
--      valid_to) con sus valores a la fecha (regime_values). create_sale la
--      llama y NO se recrea.
--   D) tax_settings_get (20261028100100): tope y parámetros del negocio.
--   E) _tax_retention_compute (20261104200100): regímenes en vigencia con sus
--      valores, escala del negocio (_tax_ret_scale_amount_for), criterio del
--      proveedor sin condición en Ganancias (gan_unknown_as_unregistered) y
--      código de SICORE de IVA. Los conceptos ya salían de tax_ret_concept_eff
--      (recreada en 20261110100000 con los valores del negocio).
--   F) _iibb_compute (20261109300100): alícuota y mínimo de cada actividad
--      vigentes en el mes liquidado.
--   G) _tax_suffered_classify_for (nueva): reglas del negocio antes de la
--      clasificación de NinjaSoft; _tax_suffered_from_settlement
--      (20261109300000) la usa.
--   H) Padrones (20261028100100): _tax_padron_rate prioriza la carga manual,
--      tax_padron_import_start acepta perfiles del negocio y
--      tax_padron_import_finish no reemplaza cargas manuales.
--
-- Sin cambios para un negocio que no personalizó nada: todo resuelve a la
-- plantilla y da exactamente lo mismo que antes (paridad de las matrices).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Precio final con la alícuota de IVA efectiva (copia de 20261028100200).
-- -----------------------------------------------------------------------------
create or replace function _tax_price_to_final(p_tenant uuid, p_product uuid, p_variant uuid, p_price numeric,
                                               p_includes boolean)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_p     products%rowtype;
  v_code  text;
  v_rate  numeric := 0;
  v_kind  text;
  v_set   jsonb;
  r       numeric;
  t       numeric;
  e       numeric;
  v_i     numeric;
  v_f     numeric;
  v_int   boolean;
begin
  if p_price is null then return null; end if;
  select * into v_p from products where id = p_product and tenant_id = p_tenant;
  if not found then return p_price; end if;
  v_int := v_p.internal_tax_mode <> 'none' and tenant_has_feature_for(p_tenant, 'impuestos_internos');
  if coalesce(p_includes, true) and not v_int then return p_price; end if;

  v_code := v_p.tax_rate_code;
  if p_variant is not null then
    select coalesce(v.tax_rate_code, v_code) into v_code from product_variants v
     where v.id = p_variant and v.product_id = p_product;
  end if;
  select ir.rate, ir.kind into v_rate, v_kind
    from _tax_iva_rate_eff(p_tenant, coalesce(v_code, '21'),
                           (now() at time zone 'America/Argentina/Buenos_Aires')::date) ir;
  v_set := _tax_settings_eff(p_tenant);
  r := case when _tax_discriminates(v_set ->> 'iva_condition') and v_kind = 'gravado' then v_rate / 100 else 0 end;

  if not v_int then
    v_f := p_price * (1 + r);
  elsif v_p.internal_tax_mode = 'pct' and v_p.internal_tax_base = 'price' then
    t := least(greatest(coalesce(v_p.internal_tax_rate, 0), 0), 99) / 100;
    e := t / (1 - t);
    if v_p.internal_tax_included then
      v_f := case when coalesce(p_includes, true) then p_price else p_price + r * p_price / (1 + e) end;
    else
      v_f := case when coalesce(p_includes, true) then p_price + e * p_price / (1 + r)
                  else p_price * (1 + r) + e * p_price end;
    end if;
  else
    v_i := case when v_p.internal_tax_mode = 'fixed' then coalesce(v_p.internal_tax_amount, 0)
                else coalesce(v_p.cost, 0) * least(greatest(coalesce(v_p.internal_tax_rate, 0), 0), 99) / 100 end;
    if v_p.internal_tax_included then
      v_f := case when coalesce(p_includes, true) then p_price else p_price + r * greatest(p_price - v_i, 0) end;
    else
      v_f := case when coalesce(p_includes, true) then p_price + v_i else p_price * (1 + r) + v_i end;
    end if;
  end if;
  return greatest(0, round(v_f, 2));
end;
$$;
revoke all on function _tax_price_to_final(uuid, uuid, uuid, numeric, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Contexto de precios del POS con las alícuotas del negocio (copia de
--    20261028100300; suma tax.rates para que el resolver del navegador dé el
--    mismo precio final que el servidor).
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
  v_neto     boolean;
  v_int      boolean;
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
  -- ADR-068: datos fiscales sólo si algún precio cambia (lista neta o
  -- internos adicionales); si no, el mapa va vacío y el POS no hace nada.
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
      else '{}'::jsonb end,
    'tax', jsonb_build_object(
      'discriminates', _tax_discriminates(_tax_settings_eff(v_tenant) ->> 'iva_condition'),
      'internalEnabled', tenant_has_feature_for(v_tenant, 'impuestos_internos'),
      -- ADR-105: alícuotas de IVA del negocio que difieren de la plantilla.
      'rates', coalesce((select jsonb_object_agg(r.code, e.rate)
                           from tax_iva_rates r
                           cross join lateral _tax_iva_rate_eff(v_tenant, r.code,
                                        (now() at time zone 'America/Argentina/Buenos_Aires')::date) e
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
revoke all on function price_context_snapshot(uuid, uuid) from public, anon;
grant execute on function price_context_snapshot(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Desglose de la venta (copia de 20261028100200): IVA efectivo a la fecha,
--    tope del consumidor final del negocio y regímenes en vigencia con sus
--    valores a la fecha. create_sale la llama: no se recrea.
-- -----------------------------------------------------------------------------
create or replace function _sale_tax_compute(p_tenant uuid, p_customer uuid, p_lines jsonb, p_total numeric,
                                             p_at timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_set      jsonb := _tax_settings_eff(p_tenant);
  v_cond     text := v_set ->> 'iva_condition';
  v_disc     boolean := _tax_discriminates(v_set ->> 'iva_condition');
  v_def      text := coalesce(v_set ->> 'default_rate_code', '21');
  v_int_on   boolean := tenant_has_feature_for(p_tenant, 'impuestos_internos');
  v_n        int := coalesce(jsonb_array_length(case when jsonb_typeof(p_lines) = 'array' then p_lines end), 0);
  v_t        bigint := greatest(round(coalesce(p_total, 0) * 100), 0)::bigint;
  v_date     date := (coalesce(p_at, now()) at time zone 'America/Argentina/Buenos_Aires')::date;
  j          jsonb;
  g          bigint[] := '{}';
  qty        numeric[] := '{}';
  codes      text[] := '{}';
  rates      numeric[] := '{}';
  kinds      text[] := '{}';
  imode      text[] := '{}';
  ibase      text[] := '{}';
  irate      numeric[] := '{}';
  iamt       numeric[] := '{}';
  icost      numeric[] := '{}';
  gg         bigint[];
  ii         bigint[] := '{}';
  aa         bigint[] := '{}';
  nn         bigint[] := '{}';
  v_pid      uuid;
  v_vid      uuid;
  v_prod     record;
  v_code     text;
  v_ir       record;
  t          numeric;
  e          numeric;
  v_nn       numeric;
  v_ix       int[];
  v_suma     bigint;
  v_base     bigint;
  v_alloc    bigint[];
  v_w        bigint[];
  v_groups   jsonb := '[]'::jsonb;
  v_lines    jsonb := '[]'::jsonb;
  v_taxed    bigint := 0;
  v_exempt   bigint := 0;
  v_untaxed  bigint := 0;
  v_iva      bigint := 0;
  v_intsum   bigint := 0;
  v_intbase  bigint := 0;
  v_cust     record;
  v_rcond    text := 'consumidor_final';
  v_doc      text;
  v_cuit     text;
  v_letter   text;
  v_warn     jsonb := '[]'::jsonb;
  v_perc     jsonb := '[]'::jsonb;
  v_ptotal   bigint := 0;
  rg         record;
  v_prate    numeric;
  v_rate     numeric;
  v_src      text;
  v_ex       numeric;
  v_pbase    bigint;
  v_pamt     bigint;
  v_thr      numeric;
  v_needid   boolean := false;
begin
  -- 1. Líneas: bruto, alícuota e internos del producto (o de la variante).
  for i in 1..v_n loop
    j := p_lines -> (i - 1);
    g[i] := greatest(round(coalesce((j ->> 'gross')::numeric, 0) * 100), 0)::bigint;
    qty[i] := coalesce((j ->> 'quantity')::numeric, 0);
    v_pid := nullif(j ->> 'product_id', '')::uuid;
    v_vid := nullif(j ->> 'variant_id', '')::uuid;
    v_code := null;
    imode[i] := 'none';
    ibase[i] := 'price';
    irate[i] := null;
    iamt[i] := null;
    icost[i] := null;
    if v_pid is not null then
      select p.tax_rate_code, p.internal_tax_mode, p.internal_tax_base, p.internal_tax_rate,
             p.internal_tax_amount, p.cost
        into v_prod
        from products p where p.id = v_pid and p.tenant_id = p_tenant;
      if found then
        v_code := v_prod.tax_rate_code;
        if v_vid is not null then
          select coalesce(v.tax_rate_code, v_code) into v_code from product_variants v
           where v.id = v_vid and v.product_id = v_pid;
        end if;
        if v_int_on then
          imode[i] := v_prod.internal_tax_mode;
          ibase[i] := v_prod.internal_tax_base;
          irate[i] := v_prod.internal_tax_rate;
          iamt[i] := v_prod.internal_tax_amount;
          icost[i] := v_prod.cost;
        end if;
      end if;
    end if;
    v_code := coalesce(v_code, v_def);
    select ir.rate, ir.kind into v_ir from _tax_iva_rate_eff(p_tenant, v_code, v_date) ir;
    codes[i] := v_code;
    kinds[i] := v_ir.kind;
    rates[i] := case when v_disc and v_ir.kind = 'gravado' then v_ir.rate else 0 end;
  end loop;

  -- 2. Reparto del total.
  gg := _tax_allocate(v_t, g);

  -- 3. Internos por línea.
  for i in 1..v_n loop
    ii[i] := 0;
    if imode[i] <> 'none' and gg[i] > 0 then
      if imode[i] = 'fixed' then
        ii[i] := round(qty[i] * coalesce(iamt[i], 0) * 100)::bigint;
      else
        t := least(greatest(coalesce(irate[i], 0), 0), 99) / 100;
        if ibase[i] = 'cost' then
          ii[i] := round(qty[i] * coalesce(icost[i], 0) * t * 100)::bigint;
        else
          e := t / (1 - t);
          v_nn := round(gg[i] / (1 + rates[i] / 100 + e));
          ii[i] := round(v_nn * e)::bigint;
        end if;
      end if;
      ii[i] := least(greatest(ii[i], 0), gg[i]);
    end if;
    aa[i] := gg[i] - ii[i];
    nn[i] := aa[i];
  end loop;

  -- 4. IVA por alícuota sobre la base agregada (orden de primera aparición).
  for v_code in select c.code from unnest(codes) with ordinality as c(code, i) group by c.code order by min(c.i) loop
    select ir.rate, ir.kind, ir.arca_id into v_ir from _tax_iva_rate_eff(p_tenant, v_code, v_date) ir;
    continue when not v_disc or v_ir.kind <> 'gravado';
    select array_agg(x.i order by x.i) into v_ix from unnest(codes) with ordinality as x(code, i) where x.code = v_code;
    v_suma := 0;
    v_w := '{}';
    for k in 1..array_length(v_ix, 1) loop
      v_suma := v_suma + aa[v_ix[k]];
      v_w[k] := aa[v_ix[k]];
    end loop;
    v_base := v_suma;
    if v_ir.rate > 0 then
      v_base := round(v_suma * 100.0 / (100 + v_ir.rate))::bigint;
      v_alloc := _tax_allocate(v_base, v_w);
      for k in 1..array_length(v_ix, 1) loop nn[v_ix[k]] := v_alloc[k]; end loop;
    end if;
    v_groups := v_groups || jsonb_build_array(jsonb_build_object(
      'code', v_code, 'arca_id', v_ir.arca_id, 'rate', v_ir.rate,
      'base', _c2p(v_base), 'amount', _c2p((v_suma - v_base))));
  end loop;

  for i in 1..v_n loop
    if not v_disc or kinds[i] = 'gravado' then v_taxed := v_taxed + nn[i];
    elsif kinds[i] = 'exento' then v_exempt := v_exempt + nn[i];
    else v_untaxed := v_untaxed + nn[i];
    end if;
    v_iva := v_iva + aa[i] - nn[i];
    v_intsum := v_intsum + ii[i];
    if ii[i] > 0 then v_intbase := v_intbase + nn[i]; end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'tax_rate_code', codes[i], 'iva_rate', rates[i],
      'taxed_total', _c2p(gg[i]), 'net', _c2p(nn[i]),
      'iva', _c2p((aa[i] - nn[i])), 'internal', _c2p(ii[i])));
  end loop;

  -- 5. Receptor y comprobante.
  select null::uuid as id, null::text as name, null::text as document_type, null::text as document_number,
         null::text as iva_condition, null::text as address, null::text as iibb_jurisdiction
    into v_cust;
  if p_customer is not null then
    select c.id, c.name, c.document_type, c.document_number, c.iva_condition, c.address, c.iibb_jurisdiction
      into v_cust
      from customers c where c.id = p_customer and c.tenant_id = p_tenant;
    if found then
      v_rcond := coalesce(v_cust.iva_condition, 'consumidor_final');
      v_doc := nullif(regexp_replace(coalesce(v_cust.document_number, ''), '\D', '', 'g'), '');
      if v_cust.document_type in ('cuit', 'cuil') and length(coalesce(v_doc, '')) = 11 and cuit_is_valid(v_doc) then
        v_cuit := v_doc;
      end if;
    end if;
  end if;
  v_letter := cbte_letter_infer(v_cond, v_rcond, coalesce((v_set ->> 'issues_cbte_m')::boolean, false));
  v_thr := tax_param_for(p_tenant, 'cf_id_threshold', v_date);
  if v_letter in ('B', 'C') and v_rcond = 'consumidor_final' and v_doc is null
     and v_thr is not null and v_thr > 0 and v_t >= v_thr * 100 then
    v_needid := true;
    v_warn := v_warn || jsonb_build_array('cf_identification_required');
  end if;
  if v_letter in ('A', 'M') and v_cuit is null then
    v_warn := v_warn || jsonb_build_array('receptor_cuit_missing');
  end if;

  -- 6. Percepciones (el negocio como agente).
  if p_customer is not null and tenant_has_feature_for(p_tenant, 'percepciones_retenciones') then
    for rg in
      select e.* from tax_regimes r cross join lateral _tax_regime_eff(r, v_date) e
       where r.tenant_id = p_tenant and r.is_active and r.deleted_at is null and r.role = 'perception'
         and r.tax in ('iva', 'iibb')
         and _tax_regime_in_force(r.valid_from, r.valid_to, v_date)
       order by case r.tax when 'iva' then 0 else 1 end, r.jurisdiction nulls first, r.created_at
    loop
      continue when not rg.is_active;
      continue when not (v_rcond = any (rg.applies_to));
      if v_cuit is null then
        v_warn := v_warn || jsonb_build_array('perception_no_cuit');
        continue;
      end if;
      v_prate := null;
      if rg.padron_source <> 'none' then
        v_prate := _tax_padron_rate(p_tenant, rg.jurisdiction, v_cuit, 'perception', v_date);
      end if;
      if rg.padron_source <> 'none' and v_prate is not null then
        v_rate := v_prate;
        v_src := 'padron';
      elsif rg.rates_by_condition ? v_rcond then
        v_rate := (rg.rates_by_condition ->> v_rcond)::numeric;
        v_src := 'condition';
      else
        v_rate := rg.default_rate;
        v_src := 'default';
      end if;
      if v_rate is null then
        if rg.padron_source <> 'none' then v_warn := v_warn || jsonb_build_array('not_in_padron'); end if;
        continue;
      end if;
      continue when v_rate <= 0;
      v_ex := _tax_exemption_pct(p_tenant, 'customer', p_customer, rg.tax, rg.jurisdiction, v_date);
      v_rate := round(v_rate * (1 - v_ex / 100), 4);
      continue when v_rate <= 0;
      v_pbase := case rg.base_kind when 'net_taxed' then v_taxed when 'total' then v_t
                                   else v_taxed + v_exempt + v_untaxed end;
      continue when v_pbase <= 0 or v_pbase < round(rg.min_base * 100);
      v_pamt := round(v_pbase * v_rate / 100)::bigint;
      continue when v_pamt <= 0 or v_pamt < round(rg.min_amount * 100);
      v_ptotal := v_ptotal + v_pamt;
      v_perc := v_perc || jsonb_build_array(jsonb_build_object(
        'regime_id', rg.id, 'tax', rg.tax, 'jurisdiction', rg.jurisdiction, 'name', rg.name,
        'rate', v_rate, 'base', _c2p(v_pbase), 'amount', _c2p(v_pamt), 'source', v_src,
        'exemption_pct', v_ex, 'arca_tributo_id', rg.arca_tributo_id));
    end loop;
  end if;

  return jsonb_build_object(
    'emitter', jsonb_build_object(
      'iva_condition', v_cond, 'cuit', v_set ->> 'cuit', 'iibb_number', v_set ->> 'iibb_number',
      'iibb_jurisdiction', v_set ->> 'iibb_jurisdiction', 'discriminates', v_disc),
    'receptor', jsonb_build_object(
      'customer_id', p_customer, 'name', v_cust.name,
      'iva_condition', v_rcond, 'arca_condition_id', fiscal_condition_arca_id(v_rcond),
      'doc_type', case when v_doc is null then null else v_cust.document_type end,
      'arca_doc_type', case when v_doc is null then 99 else doc_type_arca_id(v_cust.document_type) end,
      'doc_number', coalesce(v_doc, '0'), 'address', v_cust.address,
      'iibb_jurisdiction', v_cust.iibb_jurisdiction),
    'letter', v_letter,
    'requires_identification', v_needid,
    'lines', v_lines,
    'iva', v_groups,
    'net_taxed', _c2p(v_taxed),
    'net_exempt', _c2p(v_exempt),
    'net_untaxed', _c2p(v_untaxed),
    'iva_total', _c2p(v_iva),
    'internal_total', _c2p(v_intsum),
    'internal_base', _c2p(v_intbase),
    'perceptions', v_perc,
    'perception_total', _c2p(v_ptotal),
    'warnings', (select coalesce(jsonb_agg(distinct w), '[]'::jsonb) from jsonb_array_elements(v_warn) w));
end;
$$;
revoke all on function _sale_tax_compute(uuid, uuid, jsonb, numeric, timestamptz) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Datos fiscales con los parámetros del negocio (copia de 20261028100100).
-- -----------------------------------------------------------------------------
create or replace function tax_settings_get()
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
  return _tax_settings_eff(v_tenant) || jsonb_build_object(
    'features', jsonb_build_object(
      'iva', tenant_has_feature_for(v_tenant, 'impuestos_iva'),
      'internos', tenant_has_feature_for(v_tenant, 'impuestos_internos'),
      'percepciones', tenant_has_feature_for(v_tenant, 'percepciones_retenciones')),
    'can_write', coalesce(stock_my_role() in ('owner', 'manager'), false),
    'agent', exists (select 1 from tax_regimes r
                      where r.tenant_id = v_tenant and r.is_active and r.deleted_at is null
                        and r.role = 'perception'
                        and (r.valid_to is null or r.valid_to >= current_date))
             and tenant_has_feature_for(v_tenant, 'percepciones_retenciones'),
    'cf_id_threshold', tax_param_for(v_tenant, 'cf_id_threshold', current_date),
    -- ADR-105: valores de los archivos y criterio del proveedor sin constancia.
    'params', jsonb_build_object(
      'gan_unknown_as_unregistered', tax_param_for(v_tenant, 'gan_unknown_as_unregistered', current_date),
      'sicore_iva_tax_code', tax_param_for(v_tenant, 'sicore_iva_tax_code', current_date),
      'sicore_cbte_code', tax_param_for(v_tenant, 'sicore_cbte_code', current_date),
      'arba_branch', tax_param_for(v_tenant, 'arba_branch', current_date),
      'arba_activity', tax_param_for(v_tenant, 'arba_activity', current_date)));
end;
$$;
revoke all on function tax_settings_get() from public, anon;
grant execute on function tax_settings_get() to authenticated;

-- -----------------------------------------------------------------------------
-- E) Retenciones como agente (copia de 20261104200100): regímenes en vigencia
--    con sus valores a la fecha, escala del negocio, criterio del proveedor
--    sin constancia y código de SICORE de IVA del negocio.
-- -----------------------------------------------------------------------------
create or replace function _tax_retention_compute(p_tenant uuid, p_supplier uuid, p_bases jsonb, p_at date,
                                                  p_opts jsonb default '{}'::jsonb,
                                                  p_exclude_payment uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sup        record;
  v_prof       supplier_tax_profiles%rowtype;
  v_opts       jsonb := coalesce(p_opts, '{}'::jsonb);
  v_cuit       text;
  v_ivacond    text;
  v_gcond      text;
  v_gcode      text;
  v_scode      text;
  v_gc         jsonb;
  v_sc         jsonb;
  v_at         date := coalesce(p_at, current_date);
  v_month      date := date_trunc('month', coalesce(p_at, current_date))::date;
  b_net        numeric := round(coalesce((p_bases ->> 'net')::numeric, 0), 2);
  b_nt         numeric := round(coalesce((p_bases ->> 'net_taxed')::numeric, 0), 2);
  b_tot        numeric := round(coalesce((p_bases ->> 'total')::numeric, 0), 2);
  b_vat        numeric := round(coalesce((p_bases ->> 'vat')::numeric, 0), 2);
  rg           record;
  v_lines      jsonb := '[]'::jsonb;
  v_total      numeric := 0;
  v_warn       jsonb := '[]'::jsonb;
  v_has_gan    boolean := false;
  -- línea
  v_base       numeric;
  v_rate       numeric;
  v_padron     numeric;
  v_src        text;
  v_ex         numeric;
  v_amt        numeric;
  v_reason     text;
  v_applies    boolean;
  v_prior_base numeric;
  v_prior_wh   numeric;
  v_accum      numeric;
  v_min        numeric;
  v_subject    numeric;
  v_mtotal     numeric;
  v_computed   numeric;
  v_minwh      numeric;
  v_minbase    numeric;
  v_accumulates boolean;
  v_concept    text;
  v_cname      text;
  v_cond_out   text;
  v_unknown    text := case when tax_param_for(p_tenant, 'gan_unknown_as_unregistered', coalesce(p_at, current_date)) = 1
                            then 'no_inscripto' else 'inscripto' end;
  v_iva_code   int := coalesce(tax_param_for(p_tenant, 'sicore_iva_tax_code', coalesce(p_at, current_date)), 767)::int;
begin
  select s.id, s.name, s.cuit, s.iva_condition into v_sup
    from suppliers s where s.id = p_supplier and s.tenant_id = p_tenant;
  if not found then raise exception 'supplier_not_found'; end if;
  select * into v_prof from supplier_tax_profiles where tenant_id = p_tenant and supplier_id = p_supplier;
  v_cuit := nullif(regexp_replace(coalesce(v_sup.cuit, ''), '\D', '', 'g'), '');
  v_ivacond := v_sup.iva_condition;

  v_gcond := case when v_opts ? 'ganancias_condition' then nullif(v_opts ->> 'ganancias_condition', '')
                  else v_prof.ganancias_condition end;
  if v_gcond is not null and v_gcond not in ('inscripto', 'no_inscripto', 'exento', 'no_alcanzado') then
    raise exception 'invalid_condition';
  end if;
  v_gcode := case when v_opts ? 'ganancias_concept' then nullif(v_opts ->> 'ganancias_concept', '')
                  else v_prof.ganancias_concept end;
  v_scode := case when v_opts ? 'suss_code' then nullif(v_opts ->> 'suss_code', '') else v_prof.suss_code end;
  if v_gcode is not null then
    v_gc := tax_ret_concept_eff(p_tenant, 'ganancias', v_gcode, v_at);
    if v_gc is null then raise exception 'invalid_concept'; end if;
    if not coalesce((v_gc ->> 'is_active')::boolean, true) then v_gc := null; end if;
  end if;
  if v_scode is not null then
    v_sc := tax_ret_concept_eff(p_tenant, 'suss', v_scode, v_at);
    if v_sc is null then raise exception 'invalid_suss'; end if;
    if not coalesce((v_sc ->> 'is_active')::boolean, true) then v_sc := null; end if;
  end if;

  for rg in
    select e.* from tax_regimes r cross join lateral _tax_regime_eff(r, v_at) e
     where r.tenant_id = p_tenant and r.is_active and r.deleted_at is null and r.role = 'retention'
       and _tax_regime_in_force(r.valid_from, r.valid_to, v_at)
     order by case r.tax when 'ganancias' then 1 when 'iva' then 2 when 'iibb' then 3 else 4 end,
              coalesce(r.jurisdiction, '')
  loop
    continue when not rg.is_active;
    v_base := 0; v_rate := null; v_src := null; v_ex := 0; v_amt := 0; v_reason := null; v_applies := false;
    v_prior_base := 0; v_prior_wh := 0; v_accum := 0; v_min := 0; v_subject := 0; v_mtotal := 0;
    v_computed := 0; v_minwh := 0; v_accumulates := false; v_concept := null; v_cname := null; v_cond_out := null;

    if rg.tax = 'ganancias' then
      v_has_gan := true;
      v_base := b_net;
      if v_ivacond in ('monotributo', 'monotributo_social') then
        v_reason := 'monotributo';
      else
        v_cond_out := coalesce(v_gcond, v_unknown);
        if v_cond_out in ('exento', 'no_alcanzado') then
          v_reason := 'gan_not_subject';
        elsif v_gc is null then
          v_reason := 'no_concept';
        else
          v_concept := v_gc ->> 'code';
          v_cname := v_gc ->> 'name';
          v_minwh := coalesce((v_gc ->> 'min_withholding')::numeric, 0);
          if v_base <= 0 then
            v_reason := 'no_base';
          else
            v_accumulates := true;
            select coalesce(sum(w.payment_base), 0), coalesce(sum(w.amount), 0)
              into v_prior_base, v_prior_wh
              from tax_withholdings w
             where w.tenant_id = p_tenant and w.supplier_id = p_supplier and w.tax = 'ganancias'
               and w.concept_code = v_concept and w.status = 'issued' and w.period = v_month
               and (p_exclude_payment is null or w.payment_id <> p_exclude_payment);
            v_prior_base := round(v_prior_base, 2);
            v_prior_wh := round(v_prior_wh, 2);
            v_accum := round(v_prior_base + v_base, 2);
            v_min := case when v_cond_out = 'inscripto' or coalesce((v_gc ->> 'unregistered_min_applies')::boolean, false)
                          then coalesce((v_gc ->> 'min_non_taxable')::numeric, 0) else 0 end;
            v_subject := round(greatest(v_accum - v_min, 0), 2);
            if v_cond_out = 'inscripto' and coalesce((v_gc ->> 'uses_scale')::boolean, false) then
              v_src := 'scale';
            else
              v_rate := case when v_cond_out = 'inscripto' then (v_gc ->> 'rate_registered')::numeric
                             else (v_gc ->> 'rate_unregistered')::numeric end;
              v_src := case when v_cond_out = 'inscripto' then 'registered' else 'unregistered' end;
            end if;
            if v_src <> 'scale' and v_rate is null then
              v_reason := 'no_rate';
            else
              v_ex := _tax_exemption_pct(p_tenant, 'supplier', p_supplier, 'ganancias', null, v_at);
              if v_ex >= 100 then
                v_reason := 'exempt';
              elsif v_subject <= 0 then
                v_reason := 'below_non_taxable';
              else
                v_mtotal := case when v_src = 'scale'
                                 then _tax_ret_scale_amount_for(p_tenant, v_gc ->> 'scale_code', v_subject, v_at)
                                 else round(v_subject * v_rate / 100, 2) end;
                v_computed := round(v_mtotal - v_prior_wh, 2);
                if v_computed <= 0 then
                  v_computed := 0;
                  v_reason := 'already_withheld';
                else
                  v_amt := case when v_ex > 0 then round(v_computed * (100 - v_ex) / 100, 2) else v_computed end;
                  if v_amt <= 0 or v_amt < v_minwh then
                    v_amt := 0;
                    v_reason := 'below_min_withholding';
                  else
                    v_applies := true;
                    v_reason := 'applied';
                  end if;
                end if;
              end if;
            end if;
          end if;
        end if;
      end if;

    else
      v_base := round(case rg.base_kind when 'net_taxed' then b_nt when 'total' then b_tot when 'vat' then b_vat
                                        else b_net end, 2);
      v_minbase := rg.min_base;
      v_minwh := rg.min_amount;
      v_src := 'default';
      if rg.tax = 'suss' then
        if v_sc is null then
          v_reason := 'suss_not_applicable';
        else
          v_concept := v_sc ->> 'code';
          v_cname := v_sc ->> 'name';
          v_minbase := greatest(v_minbase, coalesce((v_sc ->> 'min_non_taxable')::numeric, 0));
          v_minwh := greatest(v_minwh, coalesce((v_sc ->> 'min_withholding')::numeric, 0));
          v_rate := coalesce(rg.default_rate, (v_sc ->> 'rate_registered')::numeric);
        end if;
      end if;
      if v_reason is null then
        if not (coalesce(v_ivacond, 'responsable_inscripto') = any (rg.applies_to)) then
          v_reason := 'condition_not_reached';
        elsif v_base <= 0 then
          v_reason := 'no_base';
        else
          if rg.tax <> 'suss' then
            v_padron := null;
            if rg.padron_source <> 'none' and v_cuit is not null then
              v_padron := _tax_padron_rate(p_tenant, rg.jurisdiction, v_cuit, 'retention', v_at);
            end if;
            if v_padron is not null then
              v_rate := v_padron;
              v_src := 'padron';
            elsif v_ivacond is not null and rg.rates_by_condition ? v_ivacond then
              v_rate := (rg.rates_by_condition ->> v_ivacond)::numeric;
              v_src := 'condition';
            else
              v_rate := rg.default_rate;
            end if;
          end if;
          if v_rate is null or v_rate <= 0 then
            v_reason := 'no_rate';
          else
            v_ex := _tax_exemption_pct(p_tenant, 'supplier', p_supplier, rg.tax, rg.jurisdiction, v_at);
            if v_ex >= 100 then
              v_reason := 'exempt';
            else
              v_rate := round(v_rate * (1 - v_ex / 100), 4);
              if v_base < v_minbase then
                v_reason := 'below_min_base';
              else
                v_amt := round(v_base * v_rate / 100, 2);
                v_computed := v_amt;
                if v_amt <= 0 or v_amt < v_minwh then
                  v_amt := 0;
                  v_reason := 'below_min_amount';
                else
                  v_applies := true;
                  v_reason := 'applied';
                end if;
              end if;
            end if;
          end if;
        end if;
      end if;
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'regime_id', rg.id, 'tax', rg.tax, 'jurisdiction', rg.jurisdiction, 'name', rg.name,
      'agent_number', rg.agent_number, 'regime_code', rg.regime_code,
      'applies', v_applies, 'reason', v_reason, 'amount', case when v_applies then v_amt else 0 end,
      'base', v_base, 'rate', v_rate, 'rate_source', v_src, 'exemption_pct', v_ex,
      'concept_code', v_concept, 'concept_name', v_cname, 'condition', v_cond_out,
      'prior_base', v_prior_base, 'accumulated_base', v_accum, 'non_taxable_min', v_min,
      'taxable_base', v_subject, 'month_total', v_mtotal, 'prior_withheld', v_prior_wh,
      'computed', v_computed, 'min_withholding', v_minwh, 'accumulates', v_accumulates,
      'sicore_tax_code', case rg.tax when 'ganancias' then (v_gc ->> 'sicore_tax_code')::int
                                     when 'suss' then (v_sc ->> 'sicore_tax_code')::int
                                     when 'iva' then v_iva_code end,
      'sicore_regime_code', case rg.tax when 'ganancias' then v_gc ->> 'sicore_regime_code'
                                        when 'suss' then coalesce(v_sc ->> 'sicore_regime_code', rg.regime_code)
                                        else rg.regime_code end));
    if v_applies then
      v_total := v_total + v_amt;
    end if;
  end loop;

  if v_has_gan and v_gcond is null and coalesce(v_ivacond, '') not in ('monotributo', 'monotributo_social') then
    v_warn := v_warn || '["ganancias_condition_unknown"]'::jsonb;
  end if;
  if v_cuit is null then
    v_warn := v_warn || '["supplier_without_cuit"]'::jsonb;
  end if;

  return jsonb_build_object(
    'lines', v_lines,
    'total', round(v_total, 2),
    'bases', jsonb_build_object('net', b_net, 'net_taxed', b_nt, 'total', b_tot, 'vat', b_vat),
    'supplier', jsonb_build_object('id', v_sup.id, 'name', v_sup.name, 'cuit', v_cuit, 'iva_condition', v_ivacond,
                                   'ganancias_condition', v_gcond, 'ganancias_concept', v_gcode, 'suss_code', v_scode,
                                   'has_profile', v_prof.id is not null),
    'warnings', v_warn);
end;
$$;
revoke all on function _tax_retention_compute(uuid, uuid, jsonb, date, jsonb, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) Liquidación de IIBB (copia de 20261109300100) con la alícuota y el mínimo
--    de cada actividad vigentes en el mes.
-- -----------------------------------------------------------------------------
create or replace function _iibb_compute(p_tenant uuid, p_jur text, p_period date, p_opening numeric default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_month  date := date_trunc('month', p_period)::date;
  v_next   date := (date_trunc('month', p_period) + interval '1 month')::date;
  v_from   timestamptz := (v_month::timestamp at time zone 'America/Argentina/Buenos_Aires');
  v_to     timestamptz := (v_next::timestamp at time zone 'America/Argentina/Buenos_Aires');
  v_set    jsonb := _tax_settings_eff(p_tenant);
  v_cm     boolean := coalesce((v_set ->> 'convenio_multilateral')::boolean, false);
  v_home   text := v_set ->> 'iibb_jurisdiction';
  v_coef   numeric;
  v_acts   jsonb;
  v_ded    jsonb;
  v_compras numeric;
  v_prev   iibb_liquidations%rowtype;
  v_prev_credit numeric := 0;
  v_math   jsonb;
  v_warn   jsonb := '[]'::jsonb;
  v_sales  int;
  v_legacy int;
  v_nomatch boolean;
  v_entries int;
  v_purch  int;
  v_review int;
begin
  if p_jur is null or not exists (select 1 from tax_jurisdictions where code = p_jur) then
    raise exception 'iibb_invalid_jurisdiction';
  end if;
  if not exists (select 1 from iibb_activities a where a.tenant_id = p_tenant and a.jurisdiction = p_jur and a.is_active) then
    raise exception 'iibb_no_activity';
  end if;
  if v_cm then
    select c.coefficient into v_coef from iibb_cm_coefficients c
     where c.tenant_id = p_tenant and c.jurisdiction = p_jur and c.valid_from <= v_month
     order by c.valid_from desc limit 1;
    if v_coef is null then
      v_coef := 0;
      v_warn := v_warn || '"cm_without_coefficient"'::jsonb;
    end if;
  end if;

  -- Base por actividad.
  with acts as (
    -- ADR-105: alícuota y mínimo vigentes al primer día del mes liquidado.
    select a.id, a.code, a.name, a.sort, a.created_at, a.is_default, a.category_ids,
           case when o.data ? 'rate' then (o.data ->> 'rate')::numeric else a.rate end as rate,
           case when o.data ? 'min_tax' then (o.data ->> 'min_tax')::numeric else a.min_tax end as min_tax
      from iibb_activities a
      left join lateral (
        select c.data from tax_custom_values c
         where c.tenant_id = p_tenant and c.catalog = 'iibb_activity' and c.item_key = a.id::text
           and c.deleted_at is null and c.is_active
           and c.valid_from <= v_month and (c.valid_to is null or c.valid_to >= v_month)
         order by c.valid_from desc, c.created_at desc
         limit 1) o on true
     where a.tenant_id = p_tenant and a.jurisdiction = p_jur and a.is_active
  ),
  def as (
    select id from acts order by is_default desc, sort, created_at limit 1
  ),
  ss as (
    -- Ventas que suman en el mes (+1) o restan por anulación en el mes (−1).
    select s.id, s.total, s.perception_total,
           case when s.created_at >= v_from and s.created_at < v_to then 1 else -1 end as sign
      from sales s
      left join stores st on st.id = s.store_id
     where s.tenant_id = p_tenant
       and (v_cm or coalesce(_tax_jurisdiction_code(st.province), v_home) = p_jur)
       and (
             (s.created_at >= v_from and s.created_at < v_to
              and (s.status = 'completed' or (s.status = 'voided' and s.voided_at >= v_to)))
          or (s.created_at < v_from and s.status = 'voided' and s.voided_at >= v_from and s.voided_at < v_to)
       )
  ),
  rs as (
    -- Ventas con devoluciones en el mes (de cualquier mes).
    select s.id, s.total, s.perception_total, r.total as ret_total
      from sale_returns r
      join sales s on s.id = r.sale_id
      left join stores st on st.id = s.store_id
     where r.tenant_id = p_tenant and r.created_at >= v_from and r.created_at < v_to
       and (v_cm or coalesce(_tax_jurisdiction_code(st.province), v_home) = p_jur)
  ),
  ln as (
    select si.sale_id,
           coalesce((select a.id from acts a where p.category_id = any (a.category_ids)
                      order by a.sort, a.created_at limit 1), (select id from def)) as activity_id,
           (p.category_id is not null and not exists (select 1 from acts a where p.category_id = any (a.category_ids))
            and exists (select 1 from acts a where cardinality(a.category_ids) > 0)) as nomatch,
           coalesce(si.net_amount, round(si.subtotal / (1 + coalesce(si.iva_rate, 21) / 100), 2)) as net,
           si.net_amount is null as legacy
      from sale_items si
      left join products p on p.id = si.product_id
     where si.sale_id in (select id from ss union select id from rs)
  ),
  sale_net as (
    select sale_id, sum(net) as net from ln group by sale_id
  ),
  per_act as (
    select a.id, a.code, a.name, a.rate, a.min_tax, a.sort, a.created_at,
           coalesce((select sum(l.net) from ln l join ss on ss.id = l.sale_id
                      where l.activity_id = a.id and ss.sign = 1), 0) as sales,
           coalesce((select sum(l.net) from ln l join ss on ss.id = l.sale_id
                      where l.activity_id = a.id and ss.sign = -1), 0) as voids,
           coalesce((select sum(round(rs.ret_total * l.net / nullif(rs.total - coalesce(rs.perception_total, 0), 0), 2))
                       from rs join ln l on l.sale_id = rs.id
                      where l.activity_id = a.id), 0) as returns
      from acts a
  )
  select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'rate', rate, 'min_tax', min_tax,
                                      'sales', sales, 'voids', voids, 'returns', returns,
                                      'base_raw', sales - voids - returns)
                   order by sort, created_at),
         (select count(*) from ss where sign = 1),
         (select count(distinct sale_id) from ln where legacy and sale_id in (select id from ss)),
         coalesce((select bool_or(nomatch) from ln), false)
    into v_acts, v_sales, v_legacy, v_nomatch
    from per_act;

  -- Deducciones.
  select jsonb_build_object(
           'retencion', coalesce(sum(amount) filter (where kind = 'retencion' and regime not in ('sircreb', 'sirtac')), 0),
           'percepcion', coalesce(sum(amount) filter (where kind = 'percepcion' and regime not in ('sircreb', 'sirtac')), 0),
           'sircreb', coalesce(sum(amount) filter (where regime = 'sircreb'), 0),
           'sirtac', coalesce(sum(amount) filter (where regime = 'sirtac'), 0)),
         count(*)
    into v_ded, v_entries
    from tax_suffered_entries
   where tenant_id = p_tenant and status = 'active' and tax = 'iibb' and jurisdiction = p_jur and period = v_month;

  select coalesce(sum(v.amount_ars), 0), count(distinct v.source_id)
    into v_compras, v_purch
    from tax_suffered v
   where v.tenant_id = p_tenant and v.kind = 'percepcion_iibb'
     and _tax_jurisdiction_code(v.jurisdiction) = p_jur
     and v.date >= v_month and v.date < v_next;
  v_ded := jsonb_set(v_ded, '{percepcion}', to_jsonb((v_ded ->> 'percepcion')::numeric + v_compras));

  select count(*) into v_review from tax_suffered_entries
   where tenant_id = p_tenant and status = 'active' and tax = 'iibb' and jurisdiction is null and period = v_month;

  -- Saldo a favor anterior.
  select * into v_prev from iibb_liquidations
   where tenant_id = p_tenant and jurisdiction = p_jur and status = 'confirmed' and period < v_month
   order by period desc limit 1;
  if found then
    v_prev_credit := v_prev.credit_next;
    if v_prev.period <> (v_month - interval '1 month')::date then
      v_warn := v_warn || '"gap"'::jsonb;
    end if;
    if coalesce(p_opening, 0) > 0 then
      v_warn := v_warn || '"opening_ignored"'::jsonb;
    end if;
  else
    v_prev_credit := greatest(round(coalesce(p_opening, 0), 2), 0);
  end if;

  v_math := _iibb_math(jsonb_build_object(
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('key', x ->> 'id', 'base_raw', x -> 'base_raw',
                                                                 'rate', x -> 'rate', 'min_tax', x -> 'min_tax')),
                                   '[]'::jsonb)
                     from jsonb_array_elements(v_acts) x),
    'coefficient', case when v_cm then v_coef end,
    'deductions', v_ded,
    'previous_credit', v_prev_credit));

  if (v_set ->> 'iva_condition') in ('monotributo', 'monotributo_social') then
    v_warn := v_warn || '"monotributo"'::jsonb;
  end if;
  if v_nomatch then v_warn := v_warn || '"no_activity_match"'::jsonb; end if;
  if v_legacy > 0 then v_warn := v_warn || '"legacy_sales"'::jsonb; end if;
  if v_review > 0 then v_warn := v_warn || '"review_pending"'::jsonb; end if;
  if exists (select 1 from jsonb_array_elements(v_math -> 'activities') x where (x ->> 'base')::numeric < 0) then
    v_warn := v_warn || '"negative_base"'::jsonb;
  end if;
  if v_next > (now() at time zone 'America/Argentina/Buenos_Aires')::date then
    v_warn := v_warn || '"current_month"'::jsonb;
  end if;

  return jsonb_build_object(
    'jurisdiction', p_jur, 'period', v_month, 'regime', case when v_cm then 'cm' else 'local' end,
    'coefficient', case when v_cm then v_coef end,
    'activities', (select jsonb_agg(x || jsonb_build_object('base', m -> 'base', 'tax', m -> 'tax',
                                                            'minimum_applied', m -> 'minimum_applied') order by o)
                     from jsonb_array_elements(v_acts) with ordinality as a(x, o)
                     join jsonb_array_elements(v_math -> 'activities') m on m ->> 'key' = x ->> 'id'),
    'base_total', v_math -> 'base_total', 'determined', v_math -> 'determined',
    'deductions', v_ded || jsonb_build_object('compras', v_compras),
    'deductions_total', v_math -> 'deductions_total',
    'previous_credit', v_math -> 'previous_credit',
    'previous_liquidation_id', v_prev.id, 'previous_period', v_prev.period,
    'opening_credit', case when v_prev.id is null and coalesce(p_opening, 0) > 0 then round(p_opening, 2) end,
    'available', v_math -> 'available', 'used', v_math -> 'used', 'to_pay', v_math -> 'to_pay',
    'credit_next', v_math -> 'credit_next',
    'entries', v_entries, 'purchase_perceptions', v_purch,
    'sales_count', v_sales, 'sales_without_breakdown', v_legacy,
    'warnings', v_warn);
end;
$$;
revoke all on function _iibb_compute(uuid, text, date, numeric) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) Retenciones sufridas: reglas del negocio (ESPEJO de classifyWithRules en
--    lib/tax/suffered.ts). La regla que coincide (el texto normalizado contiene
--    el patrón; gana el patrón más largo) manda sobre la clasificación de
--    NinjaSoft: ignorar la línea, o impuesto, tipo, régimen y jurisdicción.
-- -----------------------------------------------------------------------------
create or replace function _tax_suffered_classify_for(p_tenant uuid, p_text text, p_default_jur text default null,
                                                      p_default_regime text default 'procesador',
                                                      p_at date default current_date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base jsonb := _tax_suffered_classify(p_text, p_default_jur, p_default_regime);
  t text := btrim(regexp_replace(_tax_text_norm(p_text), '\s+', ' ', 'g'));
  r record;
  v_tax text;
  v_jur text;
  v_found text;
begin
  if p_tenant is null or t = '' then
    return v_base;
  end if;
  select c.item_key, c.data into r
    from tax_custom_values c
   where c.tenant_id = p_tenant and c.catalog = 'suffered_rule' and c.deleted_at is null and c.is_active
     and c.valid_from <= coalesce(p_at, current_date)
     and (c.valid_to is null or c.valid_to >= coalesce(p_at, current_date))
     and strpos(t, c.item_key) > 0
   order by char_length(c.item_key) desc, c.valid_from desc, c.created_at
   limit 1;
  if not found then
    return v_base;
  end if;
  if coalesce((r.data ->> 'skip')::boolean, false) then
    return v_base || jsonb_build_object('skip', true, 'rule', r.item_key);
  end if;
  v_tax := r.data ->> 'tax';
  if v_tax = 'iibb' then
    v_found := coalesce(nullif(r.data ->> 'jurisdiction', ''), _tax_jurisdiction_code(t));
    v_jur := coalesce(v_found, p_default_jur);
  end if;
  return jsonb_build_object(
    'skip', false,
    'tax', v_tax,
    'kind', coalesce(r.data ->> 'kind', case when v_tax = 'debitos_creditos' then 'pago_a_cuenta' else 'retencion' end),
    'regime', coalesce(nullif(r.data ->> 'regime', ''), v_base ->> 'regime'),
    'jurisdiction', v_jur,
    'needs_review', v_tax = 'otro' or (v_tax = 'iibb' and v_found is null),
    'rule', r.item_key);
end;
$$;
revoke all on function _tax_suffered_classify_for(uuid, text, text, text, date) from public, anon, authenticated;
grant execute on function _tax_suffered_classify_for(uuid, text, text, text, date) to service_role;

create or replace function _tax_suffered_from_settlement(p_line uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sl settlement_lines%rowtype;
  v_home text;
  v_store uuid;
  v_c jsonb;
  v_n int := 0;
  v_date date;
  v_amt numeric;
  f record;
begin
  select * into sl from settlement_lines where id = p_line;
  if not found or sl.kind <> 'payment' or coalesce(sl.taxes, 0) = 0 then
    return 0;
  end if;
  v_home := _tax_settings_eff(sl.tenant_id) ->> 'iibb_jurisdiction';
  select s.store_id into v_store from sales s where s.id = sl.sale_id;
  v_store := coalesce(sl.scope_store_id, v_store);
  v_date := (sl.operation_at at time zone 'America/Argentina/Buenos_Aires')::date;

  if jsonb_typeof(sl.fee_detail) = 'array' and exists (
       select 1 from jsonb_array_elements(sl.fee_detail) e where e ->> 'kind' = 'tax') then
    for f in
      select e, o from jsonb_array_elements(sl.fee_detail) with ordinality as x(e, o)
       where e ->> 'kind' = 'tax'
    loop
      v_amt := round(abs(coalesce((f.e ->> 'amount')::numeric, 0)), 2);
      continue when v_amt <= 0;
      v_c := _tax_suffered_classify_for(sl.tenant_id, concat_ws(' ', f.e ->> 'code', f.e ->> 'label'), v_home,
                                        'procesador', v_date);
      continue when (v_c ->> 'skip')::boolean;
      insert into tax_suffered_entries (tenant_id, store_id, tax, kind, regime, jurisdiction, origin, operation_date,
                                        period, amount, settlement_line_id, source_key, needs_review, notes)
      values (sl.tenant_id, v_store, v_c ->> 'tax', v_c ->> 'kind', v_c ->> 'regime', v_c ->> 'jurisdiction',
              'procesador', v_date, date_trunc('month', v_date)::date, v_amt, sl.id,
              'sl:' || sl.id::text || ':' || f.o::text, (v_c ->> 'needs_review')::boolean,
              left(sl.provider_key || ' · ' || coalesce(f.e ->> 'label', 'Impuesto'), 300))
      on conflict (tenant_id, source_key) where source_key is not null do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  else
    -- Sin detalle: el total de impuestos, para revisar.
    insert into tax_suffered_entries (tenant_id, store_id, tax, kind, regime, jurisdiction, origin, operation_date,
                                      period, amount, settlement_line_id, source_key, needs_review, notes)
    values (sl.tenant_id, v_store, 'otro', 'retencion', 'procesador', null, 'procesador', v_date,
            date_trunc('month', v_date)::date, round(abs(sl.taxes), 2), sl.id, 'sl:' || sl.id::text || ':0', true,
            left(sl.provider_key || ' · Impuestos sin detalle', 300))
    on conflict (tenant_id, source_key) where source_key is not null do nothing;
    if found then v_n := v_n + 1; end if;
  end if;
  return v_n;
exception when others then
  -- Nunca frena la importación de la liquidación (p. ej. mes de IIBB ya
  -- liquidado): queda para la RPC de sincronización.
  return 0;
end;
$$;
revoke all on function _tax_suffered_from_settlement(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- H) Padrones (copias de 20261028100100): la carga manual de un CUIT manda
--    sobre los archivos; import con perfil del negocio; al cerrar un import no
--    se reemplazan las cargas manuales.
-- -----------------------------------------------------------------------------
create or replace function _tax_padron_rate(p_tenant uuid, p_jur text, p_cuit text, p_kind text, p_at date)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p_kind = 'retention' then e.retention_rate else e.perception_rate end
    from tax_padron_entries e
    join tax_padron_imports i on i.id = e.import_id and i.status = 'ready'
   where e.tenant_id = p_tenant and e.jurisdiction = p_jur and e.cuit = p_cuit
     and e.valid_from <= p_at and e.valid_to >= p_at
     and (case when p_kind = 'retention' then e.retention_rate else e.perception_rate end) is not null
   order by (i.format = 'manual') desc, i.created_at desc, e.valid_from desc
   limit 1;
$$;
revoke all on function _tax_padron_rate(uuid, text, text, text, date) from public, anon, authenticated;

create or replace function tax_padron_import_start(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_padron_assert();
  v_jur    text := p ->> 'jurisdiction';
  v_fmt    text := coalesce(p ->> 'format', 'generic');
  v_kind   text := coalesce(p ->> 'kind', 'both');
  v_id     uuid;
  v_prof   uuid := nullif(p ->> 'profile_id', '')::uuid;
begin
  if not exists (select 1 from tax_jurisdictions j where j.code = v_jur) then raise exception 'invalid_jurisdiction'; end if;
  if v_fmt not in ('arba', 'agip', 'generic', 'profile') then raise exception 'invalid_format'; end if;
  if v_fmt = 'profile' and (v_prof is null or not exists (
       select 1 from tax_padron_profiles pp
        where pp.id = v_prof and pp.tenant_id = v_tenant and pp.deleted_at is null)) then
    raise exception 'padron_profile_not_found';
  end if;
  if v_fmt <> 'profile' then v_prof := null; end if;
  if (v_fmt = 'arba' and v_jur <> '902') or (v_fmt = 'agip' and v_jur <> '901') then
    raise exception 'format_jurisdiction_mismatch';
  end if;
  if v_kind not in ('perception', 'retention', 'both') then raise exception 'invalid_kind'; end if;
  -- Un import a medio cargar de hace más de un día no sirve: se descarta.
  delete from tax_padron_imports
   where tenant_id = v_tenant and status = 'loading' and created_at < now() - interval '1 day';
  insert into tax_padron_imports (tenant_id, jurisdiction, format, kind, file_name, only_known, profile_id)
  values (v_tenant, v_jur, v_fmt, v_kind, left(p ->> 'file_name', 200),
          coalesce((p ->> 'only_known')::boolean, true), v_prof)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function tax_padron_import_start(jsonb) from public, anon;
grant execute on function tax_padron_import_start(jsonb) to authenticated;

create or replace function tax_padron_import_finish(p_import uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_padron_assert();
  v_imp    tax_padron_imports%rowtype;
  v_from   date;
  v_to     date;
  v_repl   int;
begin
  select * into v_imp from tax_padron_imports where id = p_import and tenant_id = v_tenant for update;
  if not found then raise exception 'import_not_found'; end if;
  if v_imp.status <> 'loading' then raise exception 'import_closed'; end if;
  select min(e.valid_from), max(e.valid_to) into v_from, v_to from tax_padron_entries e where e.import_id = v_imp.id;
  v_from := coalesce(v_from, nullif(p ->> 'period_from', '')::date);
  v_to := coalesce(v_to, nullif(p ->> 'period_to', '')::date);

  with old as (
    update tax_padron_imports i set status = 'replaced'
     where i.tenant_id = v_tenant and i.id <> v_imp.id and i.status = 'ready' and i.format <> 'manual'
       and i.jurisdiction = v_imp.jurisdiction
       and (i.kind = v_imp.kind or v_imp.kind = 'both')
       and v_from is not null and i.period_from >= v_from and i.period_to <= v_to
    returning i.id)
  select count(*) into v_repl from old;
  delete from tax_padron_entries e
   using tax_padron_imports i
   where e.import_id = i.id and i.tenant_id = v_tenant and i.status = 'replaced';

  update tax_padron_imports
     set status = 'ready', finished_at = now(), period_from = v_from, period_to = v_to,
         rows_skipped = greatest(coalesce((p ->> 'rows_skipped')::int, 0), 0),
         rows_error = greatest(coalesce((p ->> 'rows_error')::int, 0), 0)
   where id = v_imp.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_padron_imports', v_imp.id, 'tax_padron_imported',
          jsonb_build_object('jurisdiction', v_imp.jurisdiction, 'format', v_imp.format, 'kind', v_imp.kind,
                             'file_name', v_imp.file_name, 'rows', v_imp.rows_loaded,
                             'period_from', v_from, 'period_to', v_to, 'replaced', v_repl,
                             'profile_id', v_imp.profile_id));
  return (select to_jsonb(i) from tax_padron_imports i where i.id = v_imp.id);
end;
$$;
revoke all on function tax_padron_import_finish(uuid, jsonb) from public, anon;
grant execute on function tax_padron_import_finish(uuid, jsonb) to authenticated;
