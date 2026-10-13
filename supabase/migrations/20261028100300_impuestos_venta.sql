-- =============================================================================
-- 20261028100300_impuestos_venta  (F18 · H103-H105, ADR-068)
--
-- La venta con impuestos. Recrea, copiando la ÚLTIMA definición de cada una:
--
--   A) _resolve_unit_price (copia de 20261021100200_resolver_listas_pro): al
--      final pasa el precio por _tax_price_to_final. Una lista neta (sin IVA)
--      suma el IVA del producto o de la variante y los internos "adicionales"
--      se suman al precio. El caso común (lista con IVA, sin internos
--      adicionales) devuelve lo mismo que antes. Espejo en
--      lib/prices/resolve.ts (resolveUnitPrice → priceToFinal).
--   B) price_context_snapshot (misma copia): suma prices_include_tax de cada
--      lista y `tax` (si el emisor discrimina, si hay internos y, sólo cuando
--      algún precio cambia, los datos fiscales de los productos) para que el
--      POS resuelva igual que el servidor.
--   C) create_sale (copia de 20261019100000_precio_servidor, la última: las
--      migraciones posteriores no la recrean; el consumo por lote sigue por el
--      trigger de stock_movements de 20261022100100). Mantiene la validación de
--      precio, el cobro en espera acreditado, mesas, delivery, cupón, promo,
--      packs y stock por sucursal. Agrega:
--        · _sale_tax_compute sobre las líneas (mismo orden que sale_items, más
--          el envío) y el total sin percepciones;
--        · percepciones sumadas al total ANTES del control de pago (el POS las
--          cobra con sale_tax_preview); en el cobro en espera acreditado una
--          percepción no cubierta no se percibe y queda el aviso;
--        · sales: letra, foto fiscal, netos, IVA, internos, percepciones,
--          tax_total = IVA + internos + percepciones; discount_total sigue
--          siendo subtotal − total sin percepciones;
--        · sale_items: alícuota, precio final repartido, neto, IVA e internos;
--        · sale_tax_lines: AlicIva, internos y percepciones;
--        · el resultado suma perception_total y cbte_letter.
-- =============================================================================

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

  -- ADR-068: lista neta (sin IVA) o internos adicionales → precio final.
  -- Caso común (lista con IVA, sin internos adicionales): no cambia nada.
  v_price := _tax_price_to_final(p_tenant, p_product, p_variant, greatest(0, round(v_price, 2)),
                                 coalesce(v_list.prices_include_tax, true));
  return greatest(0, round(v_price, 2));
end;
$$;
revoke all on function _resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz, text, uuid) from public, anon, authenticated;

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
-- create_sale: copia EXACTA de 20261019100000_precio_servidor (la última
-- definición; 20261021*, 20261022* y posteriores no la recrean) con el
-- desglose fiscal y las percepciones (bloques marcados ADR-068).
-- -----------------------------------------------------------------------------
create or replace function public.create_sale(p_items jsonb, p_payments jsonb, p_discount_total numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_extras jsonb DEFAULT '[]'::jsonb, p_table_order_id uuid DEFAULT NULL::uuid, p_delivery_order_id uuid DEFAULT NULL::uuid, p_promo_discount numeric DEFAULT 0, p_promo_id uuid DEFAULT NULL::uuid, p_promo_name text DEFAULT NULL::text, p_coupon_id uuid DEFAULT NULL::uuid, p_cash_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_subtotal numeric := 0;
  v_total    numeric;
  v_total_pre numeric;
  v_paid     numeric := 0;
  v_sale_id  uuid;
  v_item     record;
  v_pay      record;
  v_comp     record;
  v_pname    text;
  v_psku     text;
  v_is_kit   boolean;
  v_track    boolean;
  v_has_variants boolean;
  v_variant  record;
  v_serial   text;
  v_role     text;
  v_max_disc numeric := 100;
  v_round    numeric := 0;
  v_allow_neg boolean := true;
  -- F17 · H92/H94 (ADR-049): settings efectivos y stock por sucursal.
  v_reg        uuid;
  v_eff        jsonb;
  v_branch_stk boolean := false;
  v_disc_pct numeric;
  v_pallow   boolean;
  v_stock    numeric;
  v_sc_total numeric := 0;
  v_sc_bal   numeric;
  v_pay_feat text;
  v_line_disc numeric := 0;
  v_warranty_prima numeric := 0;
  v_tip_amount numeric := 0;
  v_tip_method text;
  v_professional uuid;
  v_pack     record;
  v_pcredit  record;
  v_pk       service_packs%rowtype;
  v_has_pack_session boolean := false;
  v_table_order table_orders%rowtype;
  v_delivery_order delivery_orders%rowtype;
  v_delivery_fee numeric := 0;
  v_intent   record;
  v_qr_ref   uuid;
  v_qr_sum   numeric;
  v_qr_plain boolean := false;
  v_promo_disc numeric := 0;
  v_coupon_disc numeric := 0;
  v_coupon   coupons%rowtype;
  -- F18 · H100 (ADR-056): precio autoritativo.
  v_pc          boolean := coalesce(current_setting('ninja.pc_complete', true), '') <> '';
  v_i           int;
  v_j           jsonb;
  v_pid         uuid;
  v_vid         uuid;
  v_qty         numeric;
  v_up          numeric;
  v_ldisc       numeric;
  v_exp         numeric;
  v_ok          boolean;
  v_amt         numeric;
  v_k           int;
  v_reason      text;
  v_dev         numeric;
  v_max_dev     numeric := 0;
  v_pool_extra  numeric[] := '{}';
  v_pool_pack   numeric[] := '{}';
  v_pool_order  numeric[] := '{}';
  v_pack_creds  text[] := '{}';
  v_prices      jsonb := '[]'::jsonb;
  v_mismatch    jsonb := '[]'::jsonb;
  v_overrides   jsonb := '[]'::jsonb;
  v_free_total  numeric := 0;
  v_free_any    boolean := false;
  v_free_cap    numeric;
  v_price_sup   uuid;
  v_n           int := 0;
  -- F18 · H103-H105 (ADR-068): desglose fiscal y percepciones.
  v_tax_in      jsonb := '[]'::jsonb;
  v_tax         jsonb;
  v_tl          jsonb;
  v_perc        numeric := 0;
  v_total_np    numeric;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  perform assert_account_active(v_tenant);

  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
  end if;

  if p_table_order_id is not null then
    select * into v_table_order from table_orders
     where id = p_table_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'table_order_not_open';
    end if;
    if v_table_order.status <> 'abierta' or v_table_order.sale_id is not null then
      raise exception 'table_order_not_open';
    end if;
  end if;

  if p_delivery_order_id is not null then
    select * into v_delivery_order from delivery_orders
     where id = p_delivery_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'delivery_order_not_open';
    end if;
    if v_delivery_order.sale_id is not null
       or v_delivery_order.status in ('entregado','cancelado')
       or v_delivery_order.deleted_at is not null then
      raise exception 'delivery_order_not_open';
    end if;
    v_delivery_fee := greatest(coalesce(v_delivery_order.delivery_fee, 0), 0);
  end if;

  -- F17 · H90: la sucursal sale del turno de caja (el que manda el POS o el
  -- inferido), no de la sucursal default. Con una sola sucursal es lo de siempre.
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, true) r;
  if v_shift is null then
    if not exists (select 1 from stores where tenant_id = v_tenant and deleted_at is null) then
      raise exception 'no_store';
    end if;
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;
  -- F17 · H91: el rol puede estar pisado en esta sucursal (tope de descuento).
  v_role := coalesce(user_store_role(v_store), v_role);

  -- F17 · H92 (ADR-049): descuento máximo, redondeo y venta sin stock salen
  -- de la configuración EFECTIVA de la sucursal y la caja del turno
  -- (negocio ← grupo ← sucursal ← caja). Sin overrides es pos_settings.
  select cs.cash_register_id into v_reg from cash_shifts cs where cs.id = v_shift;
  v_eff := _effective_config(v_tenant, 'pos_settings', '', v_store, v_reg) -> 'value';
  v_max_disc  := coalesce((v_eff -> 'max_discount' ->> coalesce(v_role, 'cashier'))::numeric, 100);
  v_round     := coalesce((v_eff ->> 'rounding_multiple')::numeric, 0);
  v_allow_neg := coalesce((v_eff ->> 'allow_negative_stock')::boolean, true);
  -- Stock por sucursal (ADR-046): con la feature y 2+ sucursales, sin venta en
  -- negativo también se controla el saldo de ESTA sucursal, no sólo el total.
  v_branch_stk := tenant_has_feature_for(v_tenant, 'stock_sucursales')
                  and (select count(*) from stores st
                        where st.tenant_id = v_tenant and st.deleted_at is null) > 1;

  -- F18 · H100 (ADR-056): el servidor manda en el precio. El cobro en espera que
  -- se acredita (ninja.pc_complete) usa el snapshot ya validado al estacionar.
  if not v_pc then
    if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
      raise exception 'invalid_items';
    end if;

    -- Montos sin producto que ya tienen explicación: recargo y garantía (van como
    -- ítem y como extra), packs vendidos (precio del pack) e ítems libres de la
    -- mesa o el delivery que se cobra (los valida el trigger al cargarlos).
    select coalesce(array_agg(round(e.amount, 2)), '{}') into v_pool_extra
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, amount numeric)
     where lower(coalesce(e.kind, '')) in ('warranty', 'surcharge') and coalesce(e.amount, 0) > 0;
    select coalesce(array_agg(sp.price), '{}') into v_pool_pack
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
      join service_packs sp on sp.id::text = e.id and sp.tenant_id = v_tenant and sp.deleted_at is null
     where lower(coalesce(e.kind, '')) = 'pack';
    select coalesce(array_agg(e.id), '{}') into v_pack_creds
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
     where lower(coalesce(e.kind, '')) = 'pack_session' and e.id is not null;
    if p_table_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from table_order_items i
       where i.order_id = p_table_order_id and i.tenant_id = v_tenant and i.product_id is null;
    elsif p_delivery_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from delivery_order_items i
       where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant and i.product_id is null;
    end if;

    for v_i in 0 .. coalesce(jsonb_array_length(p_items), 0) - 1 loop
      v_j     := p_items -> v_i;
      v_qty   := coalesce((v_j ->> 'quantity')::numeric, 0);
      v_up    := coalesce((v_j ->> 'unit_price')::numeric, 0);
      v_ldisc := coalesce((v_j ->> 'discount')::numeric, 0);
      if v_qty <= 0 then raise exception 'invalid_quantity'; end if;
      if v_up < 0 or v_ldisc < 0 then raise exception 'invalid_price'; end if;
      v_pid := nullif(v_j ->> 'product_id', '')::uuid;

      if v_pid is null then
        v_amt := round(v_up * v_qty, 2);
        v_k := _amount_index(v_pool_extra, v_amt);
        if v_k > 0 then
          v_pool_extra := v_pool_extra[1:v_k - 1] || v_pool_extra[v_k + 1:];
        else
          v_k := _amount_index(v_pool_pack, v_amt);
          if v_k > 0 then
            v_pool_pack := v_pool_pack[1:v_k - 1] || v_pool_pack[v_k + 1:];
          else
            v_k := _amount_index(v_pool_order, v_amt);
            if v_k > 0 then
              v_pool_order := v_pool_order[1:v_k - 1] || v_pool_order[v_k + 1:];
            else
              v_free_any := true;
              v_free_total := v_free_total + greatest(v_amt - v_ldisc, 0);
            end if;
          end if;
        end if;
        v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', null));
        continue;
      end if;

      v_vid := nullif(v_j ->> 'variant_id', '')::uuid;
      v_exp := _resolve_unit_price(v_tenant, v_pid, v_vid, v_qty, p_customer_id, v_store, null, now());
      if v_exp is null then raise exception 'product_not_found'; end if;
      v_exp := round(v_exp + _sale_modifier_delta(v_tenant, v_pid, v_j -> 'modifiers'), 2);
      v_ok := abs(v_up - v_exp) <= 0.01;
      v_reason := null;

      -- Regalo de una promo y línea cubierta por una sesión de pack: van a $0.
      if not v_ok and v_up = 0 and nullif(v_j ->> 'gift_promo_id', '') is not null then
        v_ok := exists (select 1 from promotions pr
                         where pr.id::text = v_j ->> 'gift_promo_id' and pr.tenant_id = v_tenant
                           and pr.deleted_at is null);
      end if;
      if not v_ok and v_up = 0 and nullif(v_j ->> 'pack_credit_id', '') is not null then
        v_ok := (v_j ->> 'pack_credit_id') = any (v_pack_creds);
      end if;
      -- Mesa o delivery que se cobra: vale el precio guardado al cargar el ítem.
      if not v_ok and p_table_order_id is not null then
        v_ok := exists (select 1 from table_order_items i
                         where i.order_id = p_table_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;
      if not v_ok and p_delivery_order_id is not null then
        v_ok := exists (select 1 from delivery_order_items i
                         where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;

      if not v_ok then
        if coalesce((v_j ->> 'price_override')::boolean, false) then
          v_reason := nullif(btrim(coalesce(v_j ->> 'override_reason', '')), '');
          if v_reason is null or char_length(v_reason) < 3 then
            raise exception 'price_override_reason_required';
          end if;
          v_reason := left(v_reason, 200);
          v_dev := case when v_exp > 0 then round(abs(v_up - v_exp) / v_exp * 100, 2) else 100 end;
          v_max_dev := greatest(v_max_dev, v_dev);
          v_overrides := v_overrides || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'price', v_up,
            'quantity', v_qty, 'deviation_pct', v_dev, 'reason', v_reason));
        else
          v_mismatch := v_mismatch || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'received', v_up));
        end if;
      end if;
      v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', v_exp, 'reason', v_reason));
    end loop;

    -- Primero el precio: el POS refresca y el cajero vuelve a cobrar.
    if jsonb_array_length(v_mismatch) > 0 then
      raise exception using message = 'price_mismatch:' || jsonb_build_object('items', v_mismatch)::text,
                            errcode = 'P0001';
    end if;

    -- Venta libre (monto manual sin producto): flag efectivo y tope por rol.
    if v_free_any then
      if not coalesce((v_eff ->> 'allow_free_sale')::boolean, true) then
        raise exception 'free_sale_not_allowed';
      end if;
      v_free_cap := (v_eff -> 'max_free_sale' ->> coalesce(v_role, 'cashier'))::numeric;
      if v_free_cap is not null and v_free_total > v_free_cap + 0.01 then
        raise exception 'free_sale_exceeds_limit';
      end if;
    end if;

    -- Cambio manual de precio: supervisor, o PIN si la política lo pide.
    if jsonb_array_length(v_overrides) > 0 then
      if is_supervisor(v_tenant, auth.uid()) then
        v_price_sup := auth.uid();
      elsif pin_action_required(v_tenant, 'cambio_precio', v_max_dev) then
        v_price_sup := require_supervisor('cambio_precio', v_max_dev, null);
      end if;
    end if;
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    v_subtotal := v_subtotal
      + (coalesce(v_item.unit_price, 0) * coalesce(v_item.quantity, 0))
      - coalesce(v_item.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_item.discount, 0);
  end loop;

  select exists (
    select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text)
    where lower(coalesce(e.kind,'')) = 'pack_session'
  ) into v_has_pack_session;

  if v_subtotal < 0 or (v_subtotal = 0 and not v_has_pack_session) then
    raise exception 'empty_sale';
  end if;

  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'tip'
                           then coalesce(e.amount, 0) else 0 end), 0),
         max(case when lower(coalesce(e.kind,'')) = 'tip' then e.method end)
    into v_tip_amount, v_tip_method
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric, method text);
  if v_tip_amount < 0 then
    raise exception 'invalid_tip';
  end if;
  if v_tip_amount > 0 and v_tip_method is null then
    v_tip_method := 'cash';
  end if;

  select (e.id)::uuid into v_professional
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, id text)
  where lower(coalesce(e.kind,'')) = 'professional'
    and e.id is not null
  order by (e.id)::uuid
  limit 1;
  if v_professional is not null then
    if not exists (
      select 1 from professionals
      where id = v_professional and tenant_id = v_tenant
        and deleted_at is null and is_active
    ) then
      v_professional := null;
    end if;
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
         as e(kind text)
       where lower(coalesce(e.kind,'')) in ('pack','pack_session')
     )
     and p_customer_id is null then
    raise exception 'pack_needs_customer';
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
         as p(method text, amount numeric)
       where p.method = 'account' and coalesce(p.amount, 0) > 0
     )
     and not tenant_has_feature('cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;

  if coalesce(p_discount_total, 0) > 0 and v_subtotal > 0 then
    v_disc_pct := coalesce(p_discount_total, 0) / v_subtotal * 100;
    if v_disc_pct > v_max_disc + 0.001 then
      raise exception 'discount_exceeds_limit';
    end if;
  end if;

  v_promo_disc := least(
    greatest(coalesce(p_promo_discount, 0), 0),
    greatest(v_subtotal - coalesce(p_discount_total, 0), 0)
  );

  -- Cupón (F9 · H54): lock de la fila + validación + cómputo AUTORITATIVO. Bypass
  -- del gating de 'descuentos' y del tope por rol (un cupón no es descuento manual),
  -- igual que la promo. El registro del canje se hace tras insertar la venta.
  if p_coupon_id is not null then
    select * into v_coupon from coupons
      where id = p_coupon_id and tenant_id = v_tenant and deleted_at is null
      for update;
    if not found then raise exception 'coupon_not_found'; end if;
    if not v_coupon.is_active then raise exception 'coupon_inactive'; end if;
    if v_coupon.valid_from is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date < v_coupon.valid_from then
      raise exception 'coupon_not_yet_valid';
    end if;
    if v_coupon.valid_to is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date > v_coupon.valid_to then
      raise exception 'coupon_expired';
    end if;
    if v_subtotal < coalesce(v_coupon.min_amount, 0) then
      raise exception 'coupon_min_amount';
    end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
      raise exception 'coupon_usage_exceeded';
    end if;
    if v_coupon.max_per_customer is not null then
      if p_customer_id is null then raise exception 'coupon_needs_customer'; end if;
      if (select count(*) from coupon_redemptions
            where coupon_id = v_coupon.id and customer_id = p_customer_id)
         >= v_coupon.max_per_customer then
        raise exception 'coupon_customer_exceeded';
      end if;
    end if;
    v_coupon_disc := case when v_coupon.discount_type = 'percent'
                          then v_subtotal * coalesce(v_coupon.discount_value, 0) / 100
                          else coalesce(v_coupon.discount_value, 0) end;
    v_coupon_disc := least(
      greatest(v_coupon_disc, 0),
      greatest(v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc, 0)
    );
  end if;

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc - v_coupon_disc;

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  if v_delivery_fee > 0 then
    v_subtotal := v_subtotal + v_delivery_fee;
    v_total    := v_total + v_delivery_fee;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
    if v_pay.method = 'store_credit' then
      v_sc_total := v_sc_total + coalesce(v_pay.amount, 0);
    end if;
  end loop;

  -- F18 · H103-H105 (ADR-068): desglose fiscal. Una línea por ítem en el orden
  -- de p_items (el mismo índice que sale_items) y el envío al final; el total
  -- sin percepciones se reparte entre ellas (descuentos, promo, cupón y
  -- redondeo quedan dentro de cada ítem). Las percepciones se suman al total
  -- y el pago tiene que cubrirlas (el POS las muestra con sale_tax_preview).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id', 'variant_id', x.v ->> 'variant_id',
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'gross', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                          - coalesce((x.v ->> 'discount')::numeric, 0), 2)) order by x.i), '[]'::jsonb)
    into v_tax_in
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i);
  if v_delivery_fee > 0 then
    v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object('product_id', null, 'quantity', 1, 'gross', v_delivery_fee));
  end if;
  v_total_np := v_total;
  v_tax := _sale_tax_compute(v_tenant, p_customer_id, v_tax_in, v_total_np, now());
  v_perc := coalesce((v_tax ->> 'perception_total')::numeric, 0);
  -- Cobro en espera que se acredita: la plata ya entró por el monto del ensayo.
  -- Si una percepción nueva (padrón cambiado en el medio) no está cubierta, no
  -- se percibe y queda el aviso en la venta.
  if v_perc > 0 and v_pc and v_paid < v_total_np + v_perc + v_tip_amount - 0.001 then
    v_tax := v_tax || jsonb_build_object(
      'perceptions', '[]'::jsonb, 'perception_total', 0,
      'warnings', coalesce(v_tax -> 'warnings', '[]'::jsonb) || jsonb_build_array('perception_skipped_pending_charge'));
    v_perc := 0;
  end if;
  v_total := v_total_np + v_perc;

  if v_paid < v_total + v_tip_amount then
    raise exception 'insufficient_payment';
  end if;
  if v_sc_total > v_total + 0.001 then
    raise exception 'store_credit_exceeds_total';
  end if;

  if v_sc_total > 0 then
    if p_customer_id is null then
      raise exception 'store_credit_needs_customer';
    end if;
    select coalesce(sum(delta), 0) into v_sc_bal
    from store_credit_movements
    where tenant_id = v_tenant and customer_id = p_customer_id;
    if v_sc_bal < v_sc_total - 0.001 then
      raise exception 'insufficient_store_credit';
    end if;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text)
  loop
    if v_pay.method = 'qr' then
      v_qr_ref := null;
      if v_pay.reference is not null
         and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
        select pi.id, pi.provider_key, pi.sale_id, pi.status, pi.amount
          into v_intent
        from mp_payment_intents pi
        where pi.id = v_pay.reference::uuid
          and pi.tenant_id = v_tenant
        limit 1;
        if found then
          v_qr_ref := v_intent.id;
        end if;
      end if;

      if v_qr_ref is not null then
        if v_intent.status <> 'approved' then
          raise exception 'qr_not_approved';
        end if;
        if v_intent.sale_id is not null then
          raise exception 'qr_already_charged';
        end if;
        if exists (
          select 1 from payments pmt
          join sales s on s.id = pmt.sale_id and s.tenant_id = v_tenant
          where pmt.method = 'qr' and pmt.reference = v_qr_ref::text
        ) then
          raise exception 'qr_already_charged';
        end if;
        select coalesce(sum(coalesce(q.amount, 0)), 0) into v_qr_sum
        from jsonb_to_recordset(p_payments)
          as q(method text, amount numeric, reference text)
        where q.method = 'qr'
          and q.reference is not null
          and q.reference ~ '^[0-9a-fA-F-]{36}$'
          and q.reference::uuid = v_qr_ref;
        if v_qr_sum > coalesce(v_intent.amount, 0) + 0.01 then
          raise exception 'qr_amount_mismatch';
        end if;
        v_pay_feat := case v_intent.provider_key
                        when 'mercadopago' then 'mercado_pago'
                        when 'mobbex'      then 'mobbex'
                        when 'modo'        then 'modo'
                        when 'pagos360'    then 'pagos360'
                        else null
                      end;
        if v_pay_feat is not null and not tenant_has_feature(v_pay_feat) then
          raise exception 'method_not_in_plan';
        end if;
      else
        v_qr_plain := true;
      end if;
    end if;
  end loop;

  if v_qr_plain
     and not (
       tenant_has_feature('mercado_pago')
       or tenant_has_feature('mobbex')
       or tenant_has_feature('modo')
       or tenant_has_feature('pagos360')
     ) then
    raise exception 'qr_not_allowed';
  end if;

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method,
                     promo_id, promo_name, promo_discount,
                     coupon_id, coupon_code, coupon_discount,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total_np,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0) + v_perc,
          v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end,
          case when v_promo_disc > 0 then p_promo_id else null end,
          case when v_promo_disc > 0 then nullif(btrim(coalesce(p_promo_name, '')), '') else null end,
          v_promo_disc,
          case when v_coupon_disc > 0 then p_coupon_id else null end,
          case when v_coupon_disc > 0 then v_coupon.code else null end,
          v_coupon_disc,
          v_tax ->> 'letter',
          jsonb_build_object('emitter', v_tax -> 'emitter', 'receptor', v_tax -> 'receptor',
                             'requires_identification', v_tax -> 'requires_identification',
                             'warnings', v_tax -> 'warnings'),
          coalesce((v_tax ->> 'net_taxed')::numeric, 0), coalesce((v_tax ->> 'net_exempt')::numeric, 0),
          coalesce((v_tax ->> 'net_untaxed')::numeric, 0), coalesce((v_tax ->> 'iva_total')::numeric, 0),
          coalesce((v_tax ->> 'internal_total')::numeric, 0), v_perc)
  returning id into v_sale_id;

  -- ADR-068: AlicIva, tributo de internos y percepciones de la venta.
  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, rate_code, rate, base, amount, arca_id, source)
  select v_tenant, v_sale_id, 'iva', 'iva', x.code, x.rate, x.base, x.amount, x.arca_id, 'product'
    from jsonb_to_recordset(coalesce(v_tax -> 'iva', '[]'::jsonb))
      as x(code text, rate numeric, base numeric, amount numeric, arca_id int);
  if coalesce((v_tax ->> 'internal_total')::numeric, 0) > 0 then
    insert into sale_tax_lines (tenant_id, sale_id, kind, tax, base, amount, arca_id, source, name)
    values (v_tenant, v_sale_id, 'internos', 'internos', coalesce((v_tax ->> 'internal_base')::numeric, 0),
            (v_tax ->> 'internal_total')::numeric, 4, 'product', 'Impuestos internos');
  end if;
  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, jurisdiction, rate, base, amount, arca_id,
                              regime_id, source, name)
  select v_tenant, v_sale_id, 'perception', x.tax, x.jurisdiction, x.rate, x.base, x.amount, x.arca_tributo_id,
         x.regime_id, x.source, x.name
    from jsonb_to_recordset(coalesce(v_tax -> 'perceptions', '[]'::jsonb))
      as x(tax text, jurisdiction text, rate numeric, base numeric, amount numeric, arca_tributo_id int,
           regime_id uuid, source text, name text);

  -- Registro del canje del cupón (F9 · H54): consume un uso + traza. Atómico:
  -- la fila ya está bloqueada (FOR UPDATE arriba), así que dos cobros simultáneos
  -- no pueden pasar el tope.
  if p_coupon_id is not null and v_coupon_disc > 0 then
    update coupons set used_count = used_count + 1, updated_at = now()
     where id = p_coupon_id and tenant_id = v_tenant;
    insert into coupon_redemptions (tenant_id, coupon_id, sale_id, customer_id, discount)
    values (v_tenant, p_coupon_id, v_sale_id, p_customer_id, v_coupon_disc);
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, modifiers jsonb,
           quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      if coalesce(v_has_variants, false) then
        if v_item.variant_id is null then
          raise exception 'variant_required';
        end if;
        select * into v_variant from product_variants
         where id = v_item.variant_id and product_id = v_item.product_id
           and tenant_id = v_tenant and deleted_at is null;
        if not found then
          raise exception 'variant_not_found';
        end if;
        v_pname := v_pname || ' · ' || v_variant.option1
                   || coalesce(' / ' || v_variant.option2, '');
      elsif v_item.variant_id is not null then
        raise exception 'variant_not_allowed';
      end if;
    else
      v_pname  := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku   := null;
      v_is_kit := false;
      v_track  := false;
      v_has_variants := false;
    end if;

    v_serial := nullif(btrim(coalesce(v_item.serial, '')), '');

    -- ADR-056: precio de lista calculado y motivo del cambio manual (mismo orden
    -- que p_items; vacío en el cobro en espera acreditado).
    -- ADR-068: alícuota, precio final repartido, neto, IVA e internos.
    v_tl := v_tax -> 'lines' -> v_n;
    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            list_price, price_override_reason,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb),
            (v_prices -> v_n ->> 'list_price')::numeric,
            v_prices -> v_n ->> 'reason',
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
    v_n := v_n + 1;

    if v_item.product_id is not null then
      if v_is_kit then
        for v_comp in
          select pkc.component_product_id, pkc.quantity,
                 pr.stock as comp_stock, pr.allow_negative as comp_allow, pr.track_stock as comp_track
          from product_kit_components pkc
          join products pr on pr.id = pkc.component_product_id and pr.tenant_id = v_tenant
          where pkc.kit_product_id = v_item.product_id and pkc.tenant_id = v_tenant
        loop
          if v_comp.comp_track then
            if not coalesce(v_comp.comp_allow, v_allow_neg)
               and v_comp.comp_stock < (v_item.quantity * v_comp.quantity) then
              raise exception 'insufficient_stock';
            end if;
            if v_branch_stk and not coalesce(v_comp.comp_allow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_comp.component_product_id
                                and ps.variant_id is null), 0) < (v_item.quantity * v_comp.quantity) then
              raise exception 'insufficient_stock_branch';
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id = v_variant.id), 0) < v_item.quantity then
              raise exception 'insufficient_stock_branch';
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            insert into stock_movements (product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id is null), 0) < v_item.quantity then
              raise exception 'insufficient_stock_branch';
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            insert into product_serials (product_id, serial, status, sale_id)
            values (v_item.product_id, v_serial, 'sold', v_sale_id)
            on conflict (product_id, serial) do update
              set status = 'sold', sale_id = v_sale_id;
          end if;
        end if;
      end if;
    end if;
  end loop;

  -- ADR-056: cambio manual de precio, con quién lo autorizó.
  if jsonb_array_length(v_overrides) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            reason, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'price_override',
            v_overrides -> 0 ->> 'reason',
            jsonb_build_object('sale_number', v_number, 'items', v_overrides,
                               'max_deviation_pct', v_max_dev, 'supervisor_id', v_price_sup),
            v_store);
  end if;

  if v_delivery_fee > 0 then
    v_tl := v_tax -> 'lines' -> v_n;
    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_sale_id, null, null, 'Costo de envío', null, null,
            1, v_delivery_fee, 0, v_delivery_fee, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    insert into payments (sale_id, method, amount, reference, card_voucher)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
            coalesce(v_pay.card_voucher, '{}'::jsonb));

    if v_pay.method = 'qr'
       and v_pay.reference is not null
       and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
      update mp_payment_intents
         set sale_id = v_sale_id, updated_at = now()
       where id = v_pay.reference::uuid
         and tenant_id = v_tenant
         and sale_id is null;
    end if;

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (customer_id, delta, reason)
      values (p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  for v_pack in
    select (e.id)::uuid as pack_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack' and e.id is not null
  loop
    select * into v_pk from service_packs
     where id = v_pack.pack_id and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'pack_not_found';
    end if;
    insert into customer_pack_credits (
      customer_id, pack_id, pack_name, product_id,
      sessions_total, sessions_used, expires_at, sale_id
    )
    values (
      p_customer_id, v_pk.id, v_pk.name, v_pk.product_id,
      v_pk.sessions, 0,
      case when v_pk.validity_days is not null
           then now() + make_interval(days => v_pk.validity_days) else null end,
      v_sale_id
    );
  end loop;

  for v_pack in
    select (e.id)::uuid as credit_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack_session' and e.id is not null
  loop
    select * into v_pcredit from customer_pack_credits
     where id = v_pack.credit_id and tenant_id = v_tenant
       and customer_id = p_customer_id
     for update;
    if not found then
      raise exception 'pack_credit_not_found';
    end if;
    if v_pcredit.sessions_used >= v_pcredit.sessions_total then
      raise exception 'pack_no_sessions_left';
    end if;
    if v_pcredit.expires_at is not null and v_pcredit.expires_at < now() then
      raise exception 'pack_expired';
    end if;

    update customer_pack_credits
       set sessions_used = sessions_used + 1
     where id = v_pcredit.id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_tenant, auth.uid(), 'customer_pack_credits', v_pcredit.id, 'pack_session_used',
            jsonb_build_object('sessions_used', v_pcredit.sessions_used,
                               'sessions_total', v_pcredit.sessions_total),
            jsonb_build_object('sessions_used', v_pcredit.sessions_used + 1,
                               'sessions_total', v_pcredit.sessions_total,
                               'sale_id', v_sale_id, 'sale_number', v_number));
  end loop;

  if p_table_order_id is not null then
    update table_orders
       set sale_id = v_sale_id, status = 'cobrada', updated_at = now()
     where id = p_table_order_id and tenant_id = v_tenant;

    update dining_tables
       set status = 'libre', current_order_id = null, waiter_user_id = null
     where id = v_table_order.table_id and tenant_id = v_tenant
       and current_order_id = p_table_order_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'table_orders', p_table_order_id, 'table_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'table_id', v_table_order.table_id));
  end if;

  if p_delivery_order_id is not null then
    update delivery_orders
       set sale_id = v_sale_id, status = 'entregado', updated_at = now()
     where id = p_delivery_order_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'delivery_orders', p_delivery_order_id, 'delivery_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'order_type', v_delivery_order.order_type,
                               'delivery_fee', v_delivery_fee));
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount, 'promo_discount', v_promo_disc,
                            'coupon_discount', v_coupon_disc,
                            'perception_total', v_perc, 'cbte_letter', v_tax ->> 'letter');
end;
$function$;

revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) to authenticated;
