-- =============================================================================
-- 20261028100200_impuestos_motor  (F18 · H103-H106, ADR-068)
--
-- Motor de impuestos. Espejo EXACTO de lib/tax/engine.ts y
-- lib/tax/comprobante.ts (paridad probada con tests/fixtures/taxMatrix.ts en
-- unit y en integración).
--
--   A) Datos de la venta: sales (letra inferida, foto del receptor, neto
--      gravado, exento, no gravado, IVA, internos, percepciones), sale_items
--      (alícuota, precio final repartido, neto, IVA, internos) y
--      sale_tax_lines (AlicIva, tributos y percepciones por venta, con la RLS
--      de la venta).
--   B) _tax_allocate (resto mayor), _tax_price_to_final (precio cargado →
--      final para el resolver: IVA de listas netas e internos adicionales),
--      cbte_letter_infer.
--   C) _sale_tax_compute: reparto del total en las líneas, internos, IVA por
--      alícuota sobre la base agregada, receptor, letra y percepciones (padrón,
--      alícuota por condición o general, exclusión, base y mínimos).
--   D) sale_tax_preview (el POS muestra y cobra las percepciones antes de
--      confirmar), tax_retention_suggest (retenciones de la orden de pago
--      desde el padrón) y report_iva_ventas (resumen por alícuota, letra y
--      jurisdicción).
--   E) tax_suffered: vista de percepciones sufridas en comprobantes de compra
--      (registro para H106/H108).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Datos de la venta
-- -----------------------------------------------------------------------------
alter table sales add column if not exists cbte_letter text;
alter table sales add column if not exists fiscal_snapshot jsonb not null default '{}'::jsonb;
alter table sales add column if not exists net_taxed numeric(14,2) not null default 0;
alter table sales add column if not exists net_exempt numeric(14,2) not null default 0;
alter table sales add column if not exists net_untaxed numeric(14,2) not null default 0;
alter table sales add column if not exists iva_total numeric(14,2) not null default 0;
alter table sales add column if not exists internal_tax_total numeric(14,2) not null default 0;
alter table sales add column if not exists perception_total numeric(14,2) not null default 0;

alter table sales drop constraint if exists sales_cbte_letter_check;
alter table sales add constraint sales_cbte_letter_check
  check (cbte_letter is null or cbte_letter in ('A', 'B', 'C', 'M', 'E'));

comment on column sales.cbte_letter is
  'Tipo de comprobante que corresponde (ADR-068): emisor × receptor. Todavía no se factura (F3).';
comment on column sales.fiscal_snapshot is
  'Foto del emisor y del receptor al vender: condición, documento (ids de ARCA), domicilio, avisos.';
comment on column sales.perception_total is
  'Percepciones cobradas (incluidas en total). tax_total = IVA + internos + percepciones.';

alter table sale_items add column if not exists tax_rate_code text;
alter table sale_items add column if not exists iva_rate numeric(5,2);
alter table sale_items add column if not exists taxed_total numeric(14,2);
alter table sale_items add column if not exists net_amount numeric(14,2);
alter table sale_items add column if not exists iva_amount numeric(14,2);
alter table sale_items add column if not exists internal_tax_amount numeric(14,2);
comment on column sale_items.taxed_total is
  'Precio final de la línea con su parte de los descuentos de la venta, el redondeo y el envío (= neto + IVA + internos).';

create table if not exists sale_tax_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  sale_id          uuid not null references sales(id) on delete cascade,
  kind             text not null check (kind in ('iva', 'internos', 'perception')),
  tax              text not null check (tax in ('iva', 'iibb', 'internos')),
  jurisdiction     text references tax_jurisdictions(code),
  rate_code        text references tax_iva_rates(code),
  rate             numeric(7,4),
  base             numeric(14,2) not null default 0,
  amount           numeric(14,2) not null default 0,
  arca_id          int,
  regime_id        uuid references tax_regimes(id) on delete set null,
  source           text check (source is null or source in ('padron', 'condition', 'default', 'product')),
  name             text,
  created_at       timestamptz not null default now()
);
comment on table sale_tax_lines is
  'Desglose fiscal de la venta (ADR-068): AlicIva (kind iva), tributo de internos y percepciones (Tributos de WSFE).';
create index if not exists sale_tax_lines_sale_idx on sale_tax_lines (sale_id);
create index if not exists sale_tax_lines_tenant_idx on sale_tax_lines (tenant_id, kind, created_at desc);

alter table sale_tax_lines enable row level security;
drop policy if exists sale_tax_lines_read on sale_tax_lines;
create policy sale_tax_lines_read on sale_tax_lines for select
  using ((tenant_id = current_tenant_id()
          and exists (select 1 from sales s where s.id = sale_tax_lines.sale_id))
         or internal_scope());
revoke insert, update, delete on sale_tax_lines from anon, authenticated;
grant select on sale_tax_lines to authenticated;

-- -----------------------------------------------------------------------------
-- B) Helpers
-- -----------------------------------------------------------------------------
-- Reparte p_total (centavos) por resto mayor según p_weights (centavos >= 0).
create or replace function _tax_allocate(p_total bigint, p_weights bigint[])
returns bigint[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  n     int := coalesce(array_length(p_weights, 1), 0);
  s     numeric := 0;
  w     numeric;
  v_out bigint[] := '{}';
  rems  numeric[] := '{}';
  v_left bigint;
  k     int;
begin
  if n = 0 then return '{}'; end if;
  for i in 1..n loop s := s + greatest(coalesce(p_weights[i], 0), 0); end loop;
  if s <= 0 or coalesce(p_total, 0) <= 0 then return array_fill(0::bigint, array[n]); end if;
  v_left := p_total;
  for i in 1..n loop
    w := greatest(coalesce(p_weights[i], 0), 0);
    v_out[i] := div(p_total::numeric * w, s)::bigint;
    rems[i] := mod(p_total::numeric * w, s);
    v_left := v_left - v_out[i];
  end loop;
  for k in select x.i from unnest(rems) with ordinality as x(r, i) order by x.r desc, x.i asc limit v_left loop
    v_out[k] := v_out[k] + 1;
  end loop;
  return v_out;
end;
$$;

-- Centavos → pesos con dos decimales.
create or replace function _c2p(p bigint)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$ select round(p / 100.0, 2); $$;

-- El emisor discrimina IVA (responsable inscripto o sin configurar).
create or replace function _tax_discriminates(p_cond text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$ select p_cond is null or p_cond = '' or p_cond = 'responsable_inscripto'; $$;

-- Letra del comprobante (espejo de inferLetter).
create or replace function cbte_letter_infer(p_emitter text, p_receptor text, p_issues_m boolean default false)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_emitter is null or p_emitter = '' then null
    when coalesce(nullif(p_receptor, ''), 'consumidor_final') = 'exterior' then 'E'
    when not _tax_discriminates(p_emitter) then 'C'
    when coalesce(nullif(p_receptor, ''), 'consumidor_final') in ('responsable_inscripto', 'monotributo', 'monotributo_social')
      then case when coalesce(p_issues_m, false) then 'M' else 'A' end
    else 'B'
  end;
$$;
grant execute on function cbte_letter_infer(text, text, boolean) to authenticated, service_role;

-- Precio cargado → precio final (espejo de priceToFinal). Caso común (lista
-- con IVA, sin internos adicionales): devuelve el mismo precio.
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
  select ir.rate, ir.kind into v_rate, v_kind from tax_iva_rates ir where ir.code = coalesce(v_code, '21');
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
-- C) Desglose de la venta
--    p_lines: [{product_id?, variant_id?, quantity, gross}] en el orden de los
--    ítems (gross = unit_price × cantidad − descuento de la línea).
--    p_total: total de la venta SIN percepciones (con descuentos, promo,
--    cupón, redondeo y envío).
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
    select ir.rate, ir.kind into v_ir from tax_iva_rates ir where ir.code = v_code;
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
    select ir.rate, ir.kind, ir.arca_id into v_ir from tax_iva_rates ir where ir.code = v_code;
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
  v_thr := tax_param('cf_id_threshold', v_date);
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
      select * from tax_regimes r
       where r.tenant_id = p_tenant and r.is_active and r.deleted_at is null and r.role = 'perception'
         and r.tax in ('iva', 'iibb')
       order by case r.tax when 'iva' then 0 else 1 end, r.jurisdiction nulls first, r.created_at
    loop
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
-- D) RPC
-- -----------------------------------------------------------------------------
-- Vista previa para el POS: mismos ítems que create_sale y el total sin
-- percepciones. Sólo lectura.
create or replace function sale_tax_preview(p_items jsonb, p_total numeric, p_customer uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_lines  jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception 'invalid_items'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'too_many_items'; end if;
  if p_customer is not null
     and not exists (select 1 from customers c where c.id = p_customer and c.tenant_id = v_tenant) then
    raise exception 'customer_not_found';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id', 'variant_id', x.v ->> 'variant_id',
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'gross', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                          - coalesce((x.v ->> 'discount')::numeric, 0), 2)) order by x.i), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(p_items) with ordinality as x(v, i);
  return _sale_tax_compute(v_tenant, p_customer, v_lines, greatest(coalesce(p_total, 0), 0), now());
end;
$$;
revoke all on function sale_tax_preview(jsonb, numeric, uuid) from public, anon;
grant execute on function sale_tax_preview(jsonb, numeric, uuid) to authenticated;

-- Retenciones sugeridas para una orden de pago (el negocio como agente de
-- retención). Base: lo imputado a cada comprobante sin IVA (proporción neto /
-- total del comprobante) o, sin imputación, p_amount. Devuelve líneas con la
-- forma de supplier_payments.withholdings: [{kind, description, amount, ...}].
create or replace function tax_retention_suggest(p_supplier uuid, p_allocations jsonb default '[]'::jsonb,
                                                 p_amount numeric default null, p_at date default current_date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_sup    record;
  v_cuit   text;
  v_base   numeric := 0;
  v_out    jsonb := '[]'::jsonb;
  rg       record;
  v_rate   numeric;
  v_src    text;
  v_ex     numeric;
  v_amt    numeric;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not coalesce(stock_my_role() in ('owner', 'manager'), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'percepciones_retenciones') then return '[]'::jsonb; end if;
  select s.id, s.cuit, s.iva_condition into v_sup from suppliers s where s.id = p_supplier and s.tenant_id = v_tenant;
  if not found then raise exception 'supplier_not_found'; end if;
  v_cuit := nullif(regexp_replace(coalesce(v_sup.cuit, ''), '\D', '', 'g'), '');

  if jsonb_typeof(coalesce(p_allocations, '[]'::jsonb)) = 'array' and jsonb_array_length(coalesce(p_allocations, '[]'::jsonb)) > 0 then
    select coalesce(sum(round(a.amount * (i.net_total + i.exempt_amount + i.non_taxed_amount) / nullif(i.total, 0), 2)), 0)
      into v_base
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
      join supplier_invoices i on i.id = a.invoice_id and i.tenant_id = v_tenant and i.supplier_id = v_sup.id
     where coalesce(a.amount, 0) > 0;
  else
    v_base := greatest(coalesce(p_amount, 0), 0);
  end if;
  if v_base <= 0 then return '[]'::jsonb; end if;

  for rg in
    select * from tax_regimes r
     where r.tenant_id = v_tenant and r.is_active and r.deleted_at is null and r.role = 'retention'
     order by r.tax, r.jurisdiction nulls first
  loop
    continue when not (coalesce(v_sup.iva_condition, 'responsable_inscripto') = any (rg.applies_to));
    v_rate := null;
    v_src := 'default';
    if rg.padron_source <> 'none' and v_cuit is not null then
      v_rate := _tax_padron_rate(v_tenant, rg.jurisdiction, v_cuit, 'retention', p_at);
      if v_rate is not null then v_src := 'padron'; end if;
    end if;
    if v_rate is null then
      if rg.rates_by_condition ? coalesce(v_sup.iva_condition, '') then
        v_rate := (rg.rates_by_condition ->> v_sup.iva_condition)::numeric;
        v_src := 'condition';
      else
        v_rate := rg.default_rate;
      end if;
    end if;
    continue when v_rate is null or v_rate <= 0;
    v_ex := _tax_exemption_pct(v_tenant, 'supplier', v_sup.id, rg.tax, rg.jurisdiction, p_at);
    v_rate := round(v_rate * (1 - v_ex / 100), 4);
    continue when v_rate <= 0 or v_base < rg.min_base;
    v_amt := round(v_base * v_rate / 100, 2);
    continue when v_amt <= 0 or v_amt < rg.min_amount;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'kind', rg.tax,
      'description', left(rg.name || ' ' || to_char(v_rate, 'FM990.0099') || ' %', 120),
      'amount', v_amt, 'base', v_base, 'rate', v_rate, 'jurisdiction', rg.jurisdiction,
      'source', v_src, 'regime_id', rg.id));
  end loop;
  return v_out;
end;
$$;
revoke all on function tax_retention_suggest(uuid, jsonb, numeric, date) from public, anon;
grant execute on function tax_retention_suggest(uuid, jsonb, numeric, date) to authenticated;

-- IVA ventas: resumen por alícuota, comprobante y jurisdicción de las ventas
-- completadas del período (fecha argentina). Dueño o encargado; con sucursal,
-- tiene que tener acceso.
create or replace function report_iva_ventas(p_from date, p_to date, p_store uuid default null)
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
  if not coalesce(stock_my_role() in ('owner', 'manager'), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid_period'; end if;
  if p_to - p_from > 400 then raise exception 'period_too_long'; end if;
  if p_store is not null and not user_can_access_store(p_store) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return (
    with s as (
      select s.* from sales s
       where s.tenant_id = v_tenant and s.status = 'completed'
         and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
         and (p_store is null or s.store_id = p_store)
         and (p_store is not null or is_internal() or s.store_id = any ((select user_allowed_store_ids())::uuid[]))
    ),
    tl as (
      select l.* from sale_tax_lines l join s on s.id = l.sale_id
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'store_id', p_store,
      'sales', (select count(*) from s),
      'sales_without_breakdown', (select count(*) from s where s.fiscal_snapshot = '{}'::jsonb),
      'total', (select coalesce(sum(total), 0) from s),
      'net_taxed', (select coalesce(sum(net_taxed), 0) from s),
      'net_exempt', (select coalesce(sum(net_exempt), 0) from s),
      'net_untaxed', (select coalesce(sum(net_untaxed), 0) from s),
      'iva_total', (select coalesce(sum(iva_total), 0) from s),
      'internal_total', (select coalesce(sum(internal_tax_total), 0) from s),
      'perception_total', (select coalesce(sum(perception_total), 0) from s),
      'by_rate', coalesce((
        select jsonb_agg(jsonb_build_object('code', x.rate_code, 'label', r.label, 'arca_id', r.arca_id,
                                            'base', x.base, 'amount', x.amount, 'sales', x.n) order by r.sort)
          from (select rate_code, sum(base) as base, sum(amount) as amount, count(distinct sale_id) as n
                  from tl where kind = 'iva' group by rate_code) x
          join tax_iva_rates r on r.code = x.rate_code), '[]'::jsonb),
      'perceptions', coalesce((
        select jsonb_agg(jsonb_build_object('tax', x.tax, 'jurisdiction', x.jurisdiction, 'name', j.name,
                                            'base', x.base, 'amount', x.amount, 'sales', x.n)
                         order by x.tax, x.jurisdiction)
          from (select tax, jurisdiction, sum(base) as base, sum(amount) as amount, count(distinct sale_id) as n
                  from tl where kind = 'perception' group by tax, jurisdiction) x
          left join tax_jurisdictions j on j.code = x.jurisdiction), '[]'::jsonb),
      'by_letter', coalesce((
        select jsonb_agg(jsonb_build_object('letter', coalesce(x.cbte_letter, '-'), 'sales', x.n, 'total', x.total)
                         order by x.cbte_letter nulls last)
          from (select cbte_letter, count(*) as n, sum(total) as total from s group by cbte_letter) x), '[]'::jsonb),
      'by_store', coalesce((
        select jsonb_agg(jsonb_build_object('store_id', x.store_id, 'name', st.name, 'net_taxed', x.net,
                                            'iva', x.iva, 'perceptions', x.perc, 'total', x.total)
                         order by st.name)
          from (select store_id, sum(net_taxed) as net, sum(iva_total) as iva, sum(perception_total) as perc,
                       sum(total) as total from s group by store_id) x
          left join stores st on st.id = x.store_id), '[]'::jsonb))
  );
end;
$$;
revoke all on function report_iva_ventas(date, date, uuid) from public, anon;
grant execute on function report_iva_ventas(date, date, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Percepciones sufridas en compras (registro para H106 y H108)
-- -----------------------------------------------------------------------------
create or replace view tax_suffered
with (security_invoker = true) as
select i.tenant_id,
       'supplier_invoice'::text as source,
       i.id as source_id,
       i.supplier_id,
       i.issue_date as date,
       i.letter, i.point_of_sale, i.number,
       x.kind,
       x.jurisdiction,
       x.description,
       round(coalesce(x.amount, 0) * coalesce(i.fx_rate, 1), 2) as amount_ars
  from supplier_invoices i
  cross join lateral jsonb_to_recordset(i.other_taxes)
    as x(kind text, jurisdiction text, description text, amount numeric)
 where i.status = 'posted' and i.kind in ('invoice', 'debit_note');
comment on view tax_suffered is
  'Percepciones y otros tributos sufridos en comprobantes de compra vigentes (ADR-068). Registro base para retenciones y percepciones sufridas (H106) y libros (H108).';
revoke all on tax_suffered from anon;
grant select on tax_suffered to authenticated;
