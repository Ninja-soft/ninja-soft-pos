-- =============================================================================
-- 20261102100200_promociones_motor  (F9 · H53-H56, ADR-074)
--
-- Motor de promociones en SQL: espejo exacto de lib/promotions/engine.ts
-- (mismas reglas, mismo orden de operaciones y redondeo a centavos por línea).
-- La paridad se prueba con tests/fixtures/promoMatrix.ts.
--
--   · _promo_eval_core(promos, líneas, contexto): PURO (immutable). Devuelve
--     {discount, applied:[{id,name,label,discount,stackable,lines}], gifts}.
--   · _promo_evaluate(tenant, líneas, contexto): carga las promos activas del
--     negocio y los usos (ventas no anuladas) y llama al núcleo. Sin la
--     feature `promociones` devuelve "sin promos" (gating real).
--   · _promo_sale_list: la lista de precios con la que se vende (misma regla
--     que _resolve_unit_price: elegida en el POS, asignada, mostrador).
--   · promotion_preview(líneas, contexto, promos?): vista previa para el POS
--     y el asistente del admin ("así se ve en el ticket").
--   · promotion_usage(cliente): usos por promo con tope, para que el POS
--     respete los topes en la vista previa.
--   · promotion_performance y promotion_sim_data: leen sale_promotions (varias
--     promos por venta) y la marca de cada línea.
-- =============================================================================

create or replace function _promo_card_key(p text)
returns text
language sql
immutable
as $$
  select case
    when nullif(lower(btrim(coalesce(p, ''))), '') is null then null
    when lower(btrim(p)) in ('mastercard', 'master') then 'master'
    when lower(btrim(p)) in ('american express', 'americanexpress', 'amex') then 'amex'
    else lower(btrim(p))
  end;
$$;

create or replace function _promo_txt_arr(j jsonb)
returns text[]
language sql
immutable
as $$
  select case when jsonb_typeof(j) = 'array'
              then coalesce(array(select x from jsonb_array_elements_text(j) as t(x) where x is not null and x <> ''), '{}')
              else '{}'::text[] end;
$$;

-- Reparte p_d en proporción a p_w (el último con peso absorbe el redondeo).
create or replace function _promo_distribute(p_d numeric, p_w numeric[])
returns numeric[]
language plpgsql
immutable
as $$
declare
  n       int := coalesce(array_length(p_w, 1), 0);
  v_out   numeric[];
  v_total numeric := 0;
  v_last  int := 0;
  v_acc   numeric := 0;
  v       numeric;
  i       int;
begin
  if n = 0 then return '{}'; end if;
  v_out := array_fill(0::numeric, array[n]);
  for i in 1 .. n loop
    if coalesce(p_w[i], 0) > 0 then
      v_total := v_total + p_w[i];
      v_last := i;
    end if;
  end loop;
  if v_last = 0 or coalesce(p_d, 0) <= 0 then return v_out; end if;
  for i in 1 .. n loop
    continue when coalesce(p_w[i], 0) <= 0;
    if i = v_last then
      v := round(p_d - v_acc, 2);
    else
      v := round(p_d * p_w[i] / v_total, 2);
    end if;
    v_out[i] := greatest(0, least(v, p_w[i]));
    v_acc := round(v_acc + v_out[i], 2);
  end loop;
  return v_out;
end;
$$;

-- ¿La línea entra en el alcance? (el combo usa sus productos).
create or replace function _promo_in_scope(p jsonb, p_pid text, p_cat text, p_brand text)
returns boolean
language plpgsql
immutable
as $$
declare
  v_scope text := coalesce(p ->> 'scope', 'cart');
  v_ids   text[];
begin
  if p ->> 'action_type' = 'bundle' then
    return p_pid is not null and exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p -> 'bundle_items') = 'array'
                                              then p -> 'bundle_items' else '[]'::jsonb end) b
       where b ->> 'product_id' = p_pid);
  end if;
  if v_scope = 'cart' then return true; end if;
  v_ids := _promo_txt_arr(p -> 'scope_ids');
  if cardinality(v_ids) = 0 then
    v_ids := array_remove(array[case v_scope when 'category' then p ->> 'scope_category_id'
                                             when 'product' then p ->> 'scope_product_id'
                                             when 'brand' then p ->> 'scope_brand_id' end], null);
  end if;
  if v_scope = 'category' then return p_cat is not null and p_cat = any (v_ids); end if;
  if v_scope = 'product' then return p_pid is not null and p_pid = any (v_ids); end if;
  if v_scope = 'brand' then return p_brand is not null and p_brand = any (v_ids); end if;
  return false;
end;
$$;

-- Medio, marca de tarjeta y banco: TODOS los pagos deben cumplir. Un pago
-- marcado `ineligible` (Point: el POS no conoce el medio al calcular) no cumple.
create or replace function _promo_payments_ok(p jsonb, p_ctx jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  v_method text := nullif(p ->> 'payment_method', '');
  v_brands text[] := _promo_txt_arr(p -> 'card_brands');
  v_banks  text[] := _promo_txt_arr(p -> 'banks');
  v_pays   jsonb := case when jsonb_typeof(p_ctx -> 'payments') = 'array' then p_ctx -> 'payments' else '[]'::jsonb end;
  v_x      jsonb;
  v_key    text;
begin
  if v_method is null and cardinality(v_brands) = 0 and cardinality(v_banks) = 0 then return true; end if;
  if jsonb_array_length(v_pays) = 0 then return false; end if;
  for v_x in select x from jsonb_array_elements(v_pays) x loop
    if coalesce((v_x ->> 'ineligible')::boolean, false) then return false; end if;
    if v_method is not null and coalesce(v_x ->> 'method', '') <> v_method then return false; end if;
    if cardinality(v_brands) > 0 then
      if coalesce(v_x ->> 'method', '') not in ('debit', 'credit') then return false; end if;
      v_key := _promo_card_key(v_x ->> 'card_brand');
      if v_key is null or not (v_key = any (v_brands)) then return false; end if;
    end if;
    if cardinality(v_banks) > 0 and not (coalesce(v_x ->> 'bank', '') = any (v_banks)) then return false; end if;
  end loop;
  return true;
end;
$$;

-- Condiciones de la promo (espejo de promoApplies).
create or replace function _promo_applies(
  p jsonb, p_ctx jsonb,
  p_pid text[], p_cat text[], p_brand text[], p_tot numeric[], p_elig boolean[]
)
returns boolean
language plpgsql
immutable
as $$
declare
  n       int := coalesce(array_length(p_tot, 1), 0);
  v_date  text := p_ctx ->> 'date';
  v_min   int := coalesce((p_ctx ->> 'minutes')::int, 0);
  v_days  text[] := _promo_txt_arr(p -> 'days_of_week');
  v_list  text[];
  v_use   jsonb := p_ctx -> 'usage' -> (p ->> 'id');
  v_sub   numeric := 0;
  i       int;
begin
  if not coalesce((p ->> 'is_active')::boolean, false) then return false; end if;
  if nullif(p ->> 'valid_from', '') is not null and v_date < (p ->> 'valid_from') then return false; end if;
  if nullif(p ->> 'valid_to', '') is not null and v_date > (p ->> 'valid_to') then return false; end if;
  if cardinality(v_days) > 0 and not ((p_ctx ->> 'weekday') = any (v_days)) then return false; end if;
  if nullif(p ->> 'time_from', '') is not null and v_min < (p ->> 'time_from')::int then return false; end if;
  if nullif(p ->> 'time_to', '') is not null and v_min >= (p ->> 'time_to')::int then return false; end if;
  v_list := _promo_txt_arr(p -> 'store_ids');
  if cardinality(v_list) > 0 and not (coalesce(p_ctx ->> 'store_id', '') = any (v_list)) then return false; end if;
  v_list := _promo_txt_arr(p -> 'price_list_ids');
  if cardinality(v_list) > 0 and not (coalesce(p_ctx ->> 'price_list_id', '') = any (v_list)) then return false; end if;
  if not _promo_payments_ok(p, p_ctx) then return false; end if;
  if nullif(p ->> 'max_uses_total', '') is not null
     and coalesce((v_use ->> 'total')::numeric, 0) >= (p ->> 'max_uses_total')::numeric then
    return false;
  end if;
  if nullif(p ->> 'max_uses_per_customer', '') is not null then
    if nullif(p_ctx ->> 'customer_id', '') is null then return false; end if;
    if coalesce((v_use ->> 'customer')::numeric, 0) >= (p ->> 'max_uses_per_customer')::numeric then return false; end if;
  end if;
  for i in 1 .. n loop
    if p_elig[i] then v_sub := v_sub + p_tot[i]; end if;
  end loop;
  if round(v_sub, 2) < round(coalesce((p ->> 'min_amount')::numeric, 0), 2) then return false; end if;
  for i in 1 .. n loop
    if p_elig[i] and _promo_in_scope(p, p_pid[i], p_cat[i], p_brand[i]) then return true; end if;
  end loop;
  return false;
end;
$$;

-- Descuento de la promo línea por línea sobre lo que queda (espejo de promoAllocation).
create or replace function _promo_alloc(
  p jsonb, p_rem numeric[],
  p_pid text[], p_cat text[], p_brand text[], p_qty numeric[], p_elig boolean[]
)
returns numeric[]
language plpgsql
immutable
as $$
declare
  n       int := coalesce(array_length(p_rem, 1), 0);
  v_ok    boolean[];
  v_out   numeric[];
  v_cnt   int[];
  v_w     numeric[];
  v_base  numeric := 0;
  v_val   numeric := coalesce((p ->> 'action_value')::numeric, 0);
  v_type  text := p ->> 'action_type';
  v_pct   numeric;
  v_qsum  numeric := 0;
  v_units int[];
  v_n     int;
  v_m     int;
  v_free  int;
  v_sets  int;
  v_need  int;
  v_have  int;
  v_b     jsonb;
  v_t     jsonb;
  v_total numeric;
  v_cap   numeric;
  i       int;
  k       int;
begin
  if n = 0 then return '{}'; end if;
  v_ok := array_fill(false, array[n]);
  v_out := array_fill(0::numeric, array[n]);
  v_cnt := array_fill(0, array[n]);
  for i in 1 .. n loop
    v_ok[i] := coalesce(p_elig[i], false) and coalesce(p_rem[i], 0) > 0
               and _promo_in_scope(p, p_pid[i], p_cat[i], p_brand[i]);
    if v_ok[i] then
      v_base := v_base + p_rem[i];
      v_qsum := v_qsum + greatest(0, coalesce(p_qty[i], 0));
    end if;
  end loop;
  v_base := round(v_base, 2);
  if v_base <= 0 then return v_out; end if;

  if v_type in ('percent', 'volume_tier') then
    if v_type = 'percent' then
      v_pct := least(greatest(v_val, 0), 100);
    else
      v_pct := 0;
      for v_t in select x from jsonb_array_elements(case when jsonb_typeof(p -> 'volume_tiers') = 'array'
                                                         then p -> 'volume_tiers' else '[]'::jsonb end) x loop
        if coalesce((v_t ->> 'min_qty')::numeric, 0) >= 1
           and v_qsum >= coalesce((v_t ->> 'min_qty')::numeric, 0)
           and coalesce((v_t ->> 'pct')::numeric, 0) > v_pct then
          v_pct := (v_t ->> 'pct')::numeric;
        end if;
      end loop;
      v_pct := least(v_pct, 100);
    end if;
    if v_pct > 0 then
      for i in 1 .. n loop
        if v_ok[i] then v_out[i] := least(p_rem[i], round(p_rem[i] * v_pct / 100, 2)); end if;
      end loop;
    end if;

  elsif v_type in ('amount', 'fixed_price') then
    v_w := array_fill(0::numeric, array[n]);
    for i in 1 .. n loop
      if v_ok[i] then v_w[i] := p_rem[i]; end if;
    end loop;
    if v_type = 'amount' then
      v_out := _promo_distribute(least(v_val, v_base), v_w);
    else
      v_out := _promo_distribute(greatest(round(v_base - v_val, 2), 0), v_w);
    end if;

  elsif v_type in ('nxm', 'second_item') then
    select coalesce(array_agg(x.i order by x.u, x.i), '{}') into v_units
      from (select g.i, round(p_rem[g.i] / p_qty[g.i], 6) as u
              from generate_series(1, n) g(i)
              cross join lateral generate_series(1, greatest(trunc(coalesce(p_qty[g.i], 0))::int, 0)) gs(j)
             where v_ok[g.i]) x;
    if v_type = 'nxm' then
      v_n := trunc(coalesce((p ->> 'buy_qty')::numeric, 0));
      v_m := trunc(coalesce((p ->> 'pay_qty')::numeric, 0));
      if v_n >= 2 and v_m >= 1 and v_m < v_n then
        v_free := (cardinality(v_units) / v_n) * (v_n - v_m);
        for k in 1 .. least(v_free, cardinality(v_units)) loop
          v_cnt[v_units[k]] := v_cnt[v_units[k]] + 1;
        end loop;
        v_pct := 100;
      end if;
    else
      v_pct := least(greatest(v_val, 0), 100);
      if v_pct > 0 then
        for k in 0 .. (cardinality(v_units) / 2) - 1 loop
          v_cnt[v_units[2 * k + 1]] := v_cnt[v_units[2 * k + 1]] + 1;
        end loop;
      end if;
    end if;
    for i in 1 .. n loop
      if v_ok[i] and v_cnt[i] > 0 then
        v_out[i] := least(p_rem[i], round(p_rem[i] * v_cnt[i] * v_pct / (p_qty[i] * 100), 2));
      end if;
    end loop;

  elsif v_type = 'bundle' then
    select coalesce(array_agg(x.i order by x.u desc, x.i), '{}') into v_units
      from (select g.i, round(p_rem[g.i] / p_qty[g.i], 6) as u
              from generate_series(1, n) g(i)
              cross join lateral generate_series(1, greatest(trunc(coalesce(p_qty[g.i], 0))::int, 0)) gs(j)
             where v_ok[g.i]) x;
    v_sets := null;
    for v_b in select x from jsonb_array_elements(case when jsonb_typeof(p -> 'bundle_items') = 'array'
                                                       then p -> 'bundle_items' else '[]'::jsonb end) x loop
      continue when nullif(v_b ->> 'product_id', '') is null or trunc(coalesce((v_b ->> 'qty')::numeric, 0)) < 1;
      select count(*) into v_have from unnest(v_units) u(i) where p_pid[u.i] = v_b ->> 'product_id';
      v_sets := least(coalesce(v_sets, 2147483647), v_have / trunc((v_b ->> 'qty')::numeric)::int);
    end loop;
    if coalesce(v_sets, 0) > 0 then
      for v_b in select x from jsonb_array_elements(p -> 'bundle_items') x loop
        continue when nullif(v_b ->> 'product_id', '') is null or trunc(coalesce((v_b ->> 'qty')::numeric, 0)) < 1;
        v_need := v_sets * trunc((v_b ->> 'qty')::numeric)::int;
        for k in 1 .. cardinality(v_units) loop
          exit when v_need <= 0;
          continue when p_pid[v_units[k]] is distinct from (v_b ->> 'product_id');
          v_cnt[v_units[k]] := v_cnt[v_units[k]] + 1;
          v_need := v_need - 1;
        end loop;
      end loop;
      v_w := array_fill(0::numeric, array[n]);
      v_total := 0;
      for i in 1 .. n loop
        if v_ok[i] and v_cnt[i] > 0 then
          v_w[i] := least(p_rem[i], round(p_rem[i] * v_cnt[i] * 100 / (p_qty[i] * 100), 2));
          v_total := v_total + v_w[i];
        end if;
      end loop;
      v_out := _promo_distribute(greatest(round(round(v_total, 2) - v_sets * v_val, 2), 0), v_w);
    end if;
  end if;

  -- Tope por ticket.
  v_cap := nullif(p ->> 'max_discount', '')::numeric;
  select round(coalesce(sum(x), 0), 2) into v_total from unnest(v_out) x;
  if v_cap is not null and v_cap >= 0 and v_total > v_cap then
    v_out := _promo_distribute(round(v_cap, 2), v_out);
  end if;
  return v_out;
end;
$$;

-- Núcleo PURO: espejo de evaluatePromotions.
create or replace function _promo_eval_core(p_promos jsonb, p_lines jsonb, p_ctx jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  n          int := case when jsonb_typeof(p_lines) = 'array' then jsonb_array_length(p_lines) else 0 end;
  v_pid      text[] := '{}';
  v_cat      text[] := '{}';
  v_brand    text[] := '{}';
  v_qty      numeric[] := '{}';
  v_tot      numeric[] := '{}';
  v_elig     boolean[] := '{}';
  v_orig     numeric[] := '{}';
  v_rem      numeric[];
  v_alloc    numeric[];
  v_l        jsonb;
  v_p        jsonb;
  v_d        numeric;
  v_stack    jsonb := '[]'::jsonb;
  v_stack_t  numeric := 0;
  v_best     jsonb := '[]'::jsonb;
  v_best_t   numeric := 0;
  v_gifts    jsonb := '[]'::jsonb;
  v_promos   jsonb := case when jsonb_typeof(p_promos) = 'array' then p_promos else '[]'::jsonb end;
  i          int;
begin
  for i in 0 .. n - 1 loop
    v_l := p_lines -> i;
    v_pid   := v_pid || nullif(v_l ->> 'product_id', '');
    v_cat   := v_cat || nullif(v_l ->> 'category_id', '');
    v_brand := v_brand || nullif(v_l ->> 'brand_id', '');
    v_qty   := v_qty || coalesce((v_l ->> 'quantity')::numeric, 0);
    v_tot   := v_tot || coalesce((v_l ->> 'line_total')::numeric, 0);
    v_elig  := v_elig || (not coalesce((v_l ->> 'excluded')::boolean, false)
                          and nullif(v_l ->> 'product_id', '') is not null
                          and coalesce((v_l ->> 'line_total')::numeric, 0) > 0
                          and coalesce((v_l ->> 'quantity')::numeric, 0) > 0);
    v_orig  := v_orig || case when v_elig[i + 1] then v_tot[i + 1] else 0 end;
  end loop;
  v_rem := v_orig;

  for v_p in
    select x from jsonb_array_elements(v_promos) x
     order by coalesce((x ->> 'priority')::int, 0) desc, (x ->> 'id') collate "C"
  loop
    if v_p ->> 'action_type' = 'gift' then
      if nullif(v_p ->> 'gift_product_id', '') is not null
         and _promo_applies(v_p, p_ctx, v_pid, v_cat, v_brand, v_tot, v_elig) then
        v_gifts := v_gifts || jsonb_build_array(jsonb_build_object(
          'id', v_p ->> 'id', 'name', v_p ->> 'name', 'product_id', v_p ->> 'gift_product_id',
          'qty', greatest(1, trunc(coalesce((v_p ->> 'gift_qty')::numeric, 1)))::int));
      end if;
      continue;
    end if;
    continue when n = 0 or not _promo_applies(v_p, p_ctx, v_pid, v_cat, v_brand, v_tot, v_elig);

    if coalesce((v_p ->> 'stackable')::boolean, false) then
      v_alloc := _promo_alloc(v_p, v_rem, v_pid, v_cat, v_brand, v_qty, v_elig);
      select round(coalesce(sum(x), 0), 2) into v_d from unnest(v_alloc) x;
      continue when v_d <= 0;
      for i in 1 .. n loop
        v_rem[i] := round(v_rem[i] - v_alloc[i], 2);
      end loop;
      v_stack := v_stack || jsonb_build_array(jsonb_build_object(
        'id', v_p ->> 'id', 'name', v_p ->> 'name',
        'label', coalesce(nullif(btrim(coalesce(v_p ->> 'ticket_label', '')), ''), v_p ->> 'name'),
        'discount', v_d, 'stackable', true, 'lines', to_jsonb(v_alloc)));
      v_stack_t := round(v_stack_t + v_d, 2);
    else
      v_alloc := _promo_alloc(v_p, v_orig, v_pid, v_cat, v_brand, v_qty, v_elig);
      select round(coalesce(sum(x), 0), 2) into v_d from unnest(v_alloc) x;
      if v_d > v_best_t then
        v_best_t := v_d;
        v_best := jsonb_build_array(jsonb_build_object(
          'id', v_p ->> 'id', 'name', v_p ->> 'name',
          'label', coalesce(nullif(btrim(coalesce(v_p ->> 'ticket_label', '')), ''), v_p ->> 'name'),
          'discount', v_d, 'stackable', false, 'lines', to_jsonb(v_alloc)));
      end if;
    end if;
  end loop;

  if v_stack_t > v_best_t then
    v_best := v_stack;
    v_best_t := v_stack_t;
  end if;
  return jsonb_build_object('discount', round(v_best_t, 2), 'applied', v_best, 'gifts', v_gifts);
end;
$$;

-- Lista de precios con la que se vende (misma regla que _resolve_unit_price).
create or replace function _promo_sale_list(p_tenant uuid, p_customer uuid, p_store uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cand price_lists%rowtype;
  v_sel  uuid;
  v_id   uuid;
begin
  v_sel := _price_uuid(_price_header('x-ninja-price-list'));
  if v_sel is not null then
    select * into v_cand from price_lists l
     where l.id = v_sel and l.tenant_id = p_tenant and l.pos_selectable;
    if found and _price_list_valid(v_cand, now()) then return v_cand.id; end if;
  end if;
  foreach v_id in array coalesce(_price_assigned_lists(p_tenant, p_customer, p_store), '{}') loop
    continue when v_id is null;
    select * into v_cand from price_lists l where l.id = v_id and l.tenant_id = p_tenant;
    if found and _price_list_valid(v_cand, now()) then return v_cand.id; end if;
  end loop;
  select * into v_cand from price_lists l
   where l.tenant_id = p_tenant and l.channel = 'mostrador' and l.is_active and l.deleted_at is null
   order by l.created_at
   limit 1;
  if found and _price_list_valid(v_cand, now()) then return v_cand.id; end if;
  return null;
end;
$$;
revoke all on function _promo_sale_list(uuid, uuid, uuid) from public, anon, authenticated;

-- Usos por promo con tope (ventas no anuladas): {promo_id: {total, customer}}.
create or replace function _promo_usage(p_tenant uuid, p_customer uuid, p_ids uuid[] default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(x.promotion_id::text, jsonb_build_object('total', x.total, 'customer', x.customer)), '{}'::jsonb)
    from (
      select sp.promotion_id,
             count(*) as total,
             count(*) filter (where p_customer is not null and sp.customer_id = p_customer) as customer
        from sale_promotions sp
        join sales s on s.id = sp.sale_id and s.status <> 'voided'
       where sp.tenant_id = p_tenant
         and sp.promotion_id in (select pr.id from promotions pr
                                  where pr.tenant_id = p_tenant and pr.deleted_at is null
                                    and (pr.max_uses_total is not null or pr.max_uses_per_customer is not null)
                                    and (p_ids is null or pr.id = any (p_ids)))
       group by sp.promotion_id
    ) x;
$$;
revoke all on function _promo_usage(uuid, uuid, uuid[]) from public, anon, authenticated;

-- Promos activas del negocio en el formato del motor.
create or replace function _promo_active_json(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(pr) - 'tenant_id' - 'created_at' - 'updated_at' - 'deleted_at'), '[]'::jsonb)
    from promotions pr
   where pr.tenant_id = p_tenant and pr.deleted_at is null and pr.is_active;
$$;
revoke all on function _promo_active_json(uuid) from public, anon, authenticated;

-- Evaluación con los datos del negocio (la usa create_sale).
create or replace function _promo_evaluate(p_tenant uuid, p_lines jsonb, p_ctx jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_promos jsonb;
begin
  if p_tenant is null or not tenant_has_feature_for(p_tenant, 'promociones') then
    return jsonb_build_object('discount', 0, 'applied', '[]'::jsonb, 'gifts', '[]'::jsonb);
  end if;
  v_promos := _promo_active_json(p_tenant);
  if jsonb_array_length(v_promos) = 0 then
    return jsonb_build_object('discount', 0, 'applied', '[]'::jsonb, 'gifts', '[]'::jsonb);
  end if;
  return _promo_eval_core(
    v_promos, p_lines,
    coalesce(p_ctx, '{}'::jsonb) || jsonb_build_object(
      'usage', _promo_usage(p_tenant, nullif(p_ctx ->> 'customer_id', '')::uuid)));
end;
$$;
revoke all on function _promo_evaluate(uuid, jsonb, jsonb) from public, anon, authenticated;

-- Vista previa: con las promos del negocio (p_promos null) o con promos de
-- prueba (asistente del admin y matriz de paridad). Sólo cálculo: no escribe.
create or replace function promotion_preview(p_lines jsonb, p_ctx jsonb default '{}'::jsonb, p_promos jsonb default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_ctx    jsonb := coalesce(p_ctx, '{}'::jsonb);
  v_now    timestamp := now() at time zone 'America/Argentina/Buenos_Aires';
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not exists (select 1 from tenant_users me where me.tenant_id = v_tenant
                   and me.user_id = auth.uid() and me.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'promociones') then
    raise exception 'feature_not_in_plan: promociones';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > 500 then
    raise exception 'invalid_items';
  end if;
  if not (v_ctx ? 'weekday') then
    v_ctx := v_ctx || jsonb_build_object(
      'weekday', extract(dow from v_now)::int,
      'minutes', (extract(hour from v_now) * 60 + extract(minute from v_now))::int,
      'date', to_char(v_now, 'YYYY-MM-DD'));
  end if;
  if p_promos is not null then
    if jsonb_typeof(p_promos) <> 'array' or jsonb_array_length(p_promos) > 50 then
      raise exception 'invalid_promos';
    end if;
    return _promo_eval_core(p_promos, p_lines, v_ctx);
  end if;
  return _promo_evaluate(v_tenant, p_lines, v_ctx);
end;
$$;
revoke all on function promotion_preview(jsonb, jsonb, jsonb) from public, anon;
grant execute on function promotion_preview(jsonb, jsonb, jsonb) to authenticated;

-- Usos de las promos con tope, para la vista previa del POS.
create or replace function promotion_usage(p_customer uuid default null)
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
  if not exists (select 1 from tenant_users me where me.tenant_id = v_tenant
                   and me.user_id = auth.uid() and me.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'promociones') then
    return '{}'::jsonb;
  end if;
  return _promo_usage(v_tenant, p_customer);
end;
$$;
revoke all on function promotion_usage(uuid) from public, anon;
grant execute on function promotion_usage(uuid) to authenticated;

-- Rendimiento: una fila por promo con las ventas de sale_promotions y las
-- ventas viejas (antes de ADR-074) que sólo tienen sales.promo_id.
create or replace function public.promotion_performance(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with src as (
    select sp.promotion_id as promo_id, sp.name as promo_name, sp.kind, sp.discount, s.total, s.id as sale_id
      from sale_promotions sp
      join sales s on s.id = sp.sale_id
     where sp.tenant_id = current_tenant_id()
       and s.status = 'completed'
       and s.created_at >= p_from and s.created_at < p_to
    union all
    select s.promo_id, coalesce(s.promo_name, '(promo)'), 'discount', s.promo_discount, s.total, s.id
      from sales s
     where s.tenant_id = current_tenant_id()
       and s.status = 'completed'
       and s.promo_id is not null
       and s.created_at >= p_from and s.created_at < p_to
       and not exists (select 1 from sale_promotions x where x.sale_id = s.id)
  ),
  agg as (
    select promo_id,
           max(promo_name) as promo_name,
           max(kind) as kind,
           count(distinct sale_id)::int as count,
           coalesce(sum(discount), 0) as total_discount,
           coalesce(sum(total), 0) as total_sold
      from src
     group by promo_id
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'promo_id', promo_id, 'promo_name', promo_name, 'kind', kind, 'count', count,
        'total_discount', total_discount, 'total_sold', total_sold
      ) order by total_discount desc)
      from agg
    ), '[]'::jsonb),
    'count', coalesce((select count(distinct sale_id) from src), 0),
    'total_discount', coalesce((select sum(total_discount) from agg where kind = 'discount'), 0),
    'total_sold', coalesce((select sum(t.total) from (select distinct sale_id, total from src) t), 0)
  );
$function$;
revoke all on function public.promotion_performance(timestamptz, timestamptz) from public, anon;
grant execute on function public.promotion_performance(timestamptz, timestamptz) to authenticated;

-- Simulador: suma la marca de cada línea (alcance por marca).
create or replace function promotion_sim_data(
  p_from  timestamptz,
  p_to    timestamptz,
  p_limit int default 1000
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with s as (
    select
      sa.id,
      extract(dow  from (sa.created_at at time zone 'America/Argentina/Buenos_Aires'))::int as weekday,
      (extract(hour from (sa.created_at at time zone 'America/Argentina/Buenos_Aires')) * 60
        + extract(minute from (sa.created_at at time zone 'America/Argentina/Buenos_Aires')))::int as minutes,
      to_char((sa.created_at at time zone 'America/Argentina/Buenos_Aires'), 'YYYY-MM-DD') as date
    from sales sa
    where sa.tenant_id = current_tenant_id()
      and sa.status = 'completed'
      and sa.created_at >= p_from
      and sa.created_at <  p_to
    order by sa.created_at desc
    limit greatest(1, least(coalesce(p_limit, 1000), 5000))
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'weekday', s.weekday,
      'minutes', s.minutes,
      'date',    s.date,
      'lines', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'productId',  si.product_id,
          'categoryId', p.category_id,
          'brandId',    p.brand_id,
          'unitPrice',  si.unit_price,
          'quantity',   si.quantity,
          'lineTotal',  si.subtotal
        )), '[]'::jsonb)
        from sale_items si
        left join products p on p.id = si.product_id
        where si.sale_id = s.id and si.tenant_id = current_tenant_id()
      )
    )
  ), '[]'::jsonb)
  from s;
$$;
revoke all on function promotion_sim_data(timestamptz, timestamptz, int) from public, anon;
grant execute on function promotion_sim_data(timestamptz, timestamptz, int) to authenticated;
