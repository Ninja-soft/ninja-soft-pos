-- =============================================================================
-- 20261108600000_perf_f4_create_sale_tenant.sql  (F4 · ADR-093, sigue a ADR-090)
--
-- A) create_sale y return_sale_v2 con tenant_id explícito.
--    Copia COMPLETA de la definición más nueva de cada una
--    (20261108200000_create_sale_deudas, verificado con grep sobre todas las
--    migraciones) con un único cambio: cada insert en una tabla con
--    DEFAULT current_tenant_id() pasa tenant_id = v_tenant explícito
--    (sales, sale_items, stock_movements, product_serials, payments,
--    cash_movements, store_credit_movements, customer_pack_credits,
--    sale_returns). v_tenant ya es current_tenant_id() de la misma
--    transacción: el valor guardado es el mismo, pero no se vuelve a buscar la
--    membresía en tenant_users por cada fila (ADR-083). Comportamiento idéntico.
--    Las líneas cambiadas llevan el comentario "ADR-093".
--    No se recrean _offline_run_sale ni sync_offline_sale (no insertan por fila
--    sin tenant_id: llaman a create_sale) ni close_cash_shift (un solo insert
--    por cierre, SECURITY INVOKER).
--
-- B) catalog_search: búsqueda en catalog_products (350k filas) por RPC que usa
--    el índice trigram catalog_products_titulo_trgm_idx.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A.1) create_sale
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
  -- ADR-077: venta offline que se sincroniza (GUC sólo de _offline_run_sale).
  v_offline     boolean := coalesce(current_setting('ninja.offline_sync', true), '') <> '';
  v_off_conf    jsonb := '[]'::jsonb;
  -- F9 (ADR-074): motor de promociones autoritativo.
  -- ADR-077: offline, las promos se evalúan a la hora real de la venta
  -- (ninja.offline_sold_at, sólo de _offline_run_sale), no a la de la sincronización.
  v_now_ar      timestamp := (case when v_offline
                                   then coalesce(nullif(current_setting('ninja.offline_sold_at', true), '')::timestamptz, now())
                                   else now() end) at time zone 'America/Argentina/Buenos_Aires';
  v_promo_lines jsonb := '[]'::jsonb;
  v_promo_ctx   jsonb;
  v_promo_eval  jsonb := jsonb_build_object('discount', 0, 'applied', '[]'::jsonb, 'gifts', '[]'::jsonb);
  v_promo_calc  numeric := 0;
  v_promo_label text;
  v_promo_first uuid;
  v_promo_left  numeric;
  v_ap          jsonb;
  v_gift        jsonb;
  -- ADR-088: depósitos (ADR-085), seña del turno (ADR-082) y promo por línea (ADR-074).
  v_wh_on       boolean := false;
  v_from_res    boolean := false;
  v_wr          jsonb;
  v_res_taken   jsonb := '[]'::jsonb;
  v_appt_id     uuid;
  v_appt        appointments%rowtype;
  v_sena_paid   numeric := 0;
  v_sena_avail  numeric := 0;
  v_sena_exp    numeric := 0;
  v_sena_left   numeric;
  v_dep         record;
  v_promo_line  numeric[] := '{}';
  v_pl          numeric;
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

  -- ADR-088 (ADR-082): cobro de un turno (extra {kind: 'appointment', id}). Se
  -- bloquea el turno y sus señas (dos cobros simultáneos no pasan) y se lee la
  -- seña disponible. Un pago 'sena' sólo vale con el turno.
  select nullif(e.id, '')::uuid into v_appt_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
   where lower(coalesce(e.kind, '')) = 'appointment'
     and e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   limit 1;
  if exists (select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(method text, amount numeric)
              where x.method = 'sena' and coalesce(x.amount, 0) < 0) then
    raise exception 'invalid_payment';
  end if;
  select coalesce(sum(coalesce(x.amount, 0)), 0) into v_sena_paid
    from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(method text, amount numeric)
   where x.method = 'sena';
  if v_appt_id is not null then
    select * into v_appt from appointments
     where id = v_appt_id and tenant_id = v_tenant
     for update;
    if not found then raise exception 'appointment_not_found'; end if;
    if v_appt.sale_id is not null then raise exception 'appointment_already_charged'; end if;
    if v_appt.status = 'cancelado' then raise exception 'appointment_not_active'; end if;
    perform 1 from appointment_deposits d
      where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held'
      for update;
    select coalesce(sum(d.amount - d.applied_amount - d.refunded_amount), 0) into v_sena_avail
      from appointment_deposits d
     where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held';
  elsif v_sena_paid <> 0 then
    raise exception 'deposit_needs_appointment';
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
  -- ADR-088 (ADR-085): con la feature y depósitos en la sucursal del turno, la
  -- venta mira el salón (principal). Sin depósitos, nada cambia.
  v_wh_on := tenant_has_feature_for(v_tenant, 'depositos')
             and exists (select 1 from warehouses w
                          where w.store_id = v_store and w.tenant_id = v_tenant
                            and w.deleted_at is null and w.kind <> 'principal');
  if v_wh_on then
    v_from_res := coalesce((select ps.sell_from_reserve from pos_settings ps where ps.tenant_id = v_tenant), false);
  end if;

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
    -- ADR-077: offline se respeta el precio cobrado y queda el conflicto.
    if jsonb_array_length(v_mismatch) > 0 then
      if v_offline then
        v_off_conf := v_off_conf || (select coalesce(jsonb_agg(m || jsonb_build_object('kind', 'price_changed')), '[]'::jsonb)
                                       from jsonb_array_elements(v_mismatch) as m);
      else
        raise exception using message = 'price_mismatch:' || jsonb_build_object('items', v_mismatch)::text,
                              errcode = 'P0001';
      end if;
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

  -- F9 (ADR-074): promociones calculadas en el servidor, ANTES del cupón, los
  -- impuestos y las percepciones (los recargos de cuotas llegan como ítem sin
  -- producto y no reciben promos). Mismo motor que el POS (lib/promotions/
  -- engine.ts): si el descuento que manda el POS no coincide, se rechaza con
  -- promo_mismatch y el POS vuelve a calcular. No pasa por el gating de
  -- 'descuentos' ni por el tope por rol (una promo no es descuento manual).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id',
           'category_id', p.category_id,
           'brand_id', p.brand_id,
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'line_total', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                               - coalesce((x.v ->> 'discount')::numeric, 0), 2),
           'excluded', (nullif(x.v ->> 'gift_promo_id', '') is not null
                        or nullif(x.v ->> 'pack_credit_id', '') is not null)) order by x.i), '[]'::jsonb)
    into v_promo_lines
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i)
    left join products p on p.id::text = x.v ->> 'product_id' and p.tenant_id = v_tenant;

  v_promo_ctx := jsonb_build_object(
    'weekday', extract(dow from v_now_ar)::int,
    'minutes', (extract(hour from v_now_ar) * 60 + extract(minute from v_now_ar))::int,
    'date', to_char(v_now_ar, 'YYYY-MM-DD'),
    'store_id', v_store,
    'price_list_id', _promo_sale_list(v_tenant, p_customer_id, v_store),
    'customer_id', p_customer_id,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                          'method', x.method,
                          'card_brand', x.card_voucher ->> 'marca',
                          'bank', x.card_voucher ->> 'banco',
                          'ineligible', coalesce(x.promo_ineligible, false))), '[]'::jsonb)
                   from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
                     as x(method text, amount numeric, card_voucher jsonb, promo_ineligible boolean)
                  where coalesce(x.amount, 0) > 0));

  -- Topes de uso: un cobro a la vez por promo con tope (sin pasarse).
  perform pg_advisory_xact_lock(hashtext('promo_use:' || pr.id::text))
     from promotions pr
    where pr.tenant_id = v_tenant and pr.deleted_at is null and pr.is_active
      and (pr.max_uses_total is not null or pr.max_uses_per_customer is not null)
    order by pr.id;

  v_promo_eval := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);
  -- El cupón es excluyente con las promos de descuento (los regalos conviven).
  if p_coupon_id is not null then
    v_promo_eval := v_promo_eval || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb);
  end if;
  v_promo_calc := least(coalesce((v_promo_eval ->> 'discount')::numeric, 0),
                        greatest(v_subtotal - coalesce(p_discount_total, 0), 0));

  if v_pc then
    -- Cobro en espera acreditado: vale el monto validado en el ensayo (como el
    -- precio). Si el motor ya no da lo mismo (cambió la hora), queda una sola
    -- fila con la promo que se mandó.
    v_promo_disc := least(greatest(coalesce(p_promo_discount, 0), 0),
                          greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
    if abs(v_promo_calc - v_promo_disc) > 0.01 then
      v_promo_eval := v_promo_eval || jsonb_build_object('applied',
        case when v_promo_disc > 0 then jsonb_build_array(jsonb_build_object(
               'id', p_promo_id, 'name', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'label', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'discount', v_promo_disc, 'lines', '[]'::jsonb))
             else '[]'::jsonb end);
    end if;
  else
    if coalesce(p_promo_discount, 0) > 0 and not tenant_has_feature_for(v_tenant, 'promociones') then
      raise exception 'feature_not_in_plan: promociones';
    end if;
    -- Borde de una franja (happy hour, cambio de día): el POS calculó con su
    -- reloj hasta 5 minutos antes (por ejemplo, un QR que tardó en pagarse).
    if abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      v_promo_ctx := v_promo_ctx || jsonb_build_object(
        'weekday', extract(dow from v_now_ar - interval '5 minutes')::int,
        'minutes', (extract(hour from v_now_ar - interval '5 minutes') * 60
                    + extract(minute from v_now_ar - interval '5 minutes'))::int,
        'date', to_char(v_now_ar - interval '5 minutes', 'YYYY-MM-DD'));
      v_gift := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);
      if p_coupon_id is not null then
        v_gift := v_gift || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb);
      end if;
      if abs(greatest(coalesce(p_promo_discount, 0), 0)
             - least(coalesce((v_gift ->> 'discount')::numeric, 0),
                     greatest(v_subtotal - coalesce(p_discount_total, 0), 0))) <= 0.01 then
        v_promo_eval := v_gift;
        v_promo_calc := least(coalesce((v_gift ->> 'discount')::numeric, 0),
                              greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
      end if;
    end if;
    if v_offline and abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      -- ADR-077: la promo se recalculó al sincronizar y no da lo mismo (venció,
      -- se editó, se agotó el tope...). Se respeta lo cobrado, como el precio,
      -- con una sola fila de la promo que mandó el POS, y queda el conflicto
      -- 'promo_changed' para revisión.
      v_promo_disc := least(greatest(coalesce(p_promo_discount, 0), 0),
                            greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
      v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
        'kind', 'promo_changed',
        'promo_id', p_promo_id,
        'promo_name', nullif(btrim(coalesce(p_promo_name, '')), ''),
        'charged', v_promo_disc,
        'expected', v_promo_calc,
        'expected_applied', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'label',
                                                                          'discount', (a ->> 'discount')::numeric))
                                        from jsonb_array_elements(v_promo_eval -> 'applied') a), '[]'::jsonb)));
      v_promo_eval := v_promo_eval || jsonb_build_object('applied',
        case when v_promo_disc > 0 then jsonb_build_array(jsonb_build_object(
               'id', p_promo_id, 'name', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'label', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'discount', v_promo_disc, 'lines', '[]'::jsonb))
             else '[]'::jsonb end);
      v_promo_calc := v_promo_disc;
    end if;
    if abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      raise exception using
        message = 'promo_mismatch:' || jsonb_build_object(
          'expected', v_promo_calc,
          'received', coalesce(p_promo_discount, 0),
          'applied', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'label',
                                                                  'discount', (a ->> 'discount')::numeric))
                                 from jsonb_array_elements(v_promo_eval -> 'applied') a), '[]'::jsonb))::text,
        errcode = 'P0001';
    end if;
    v_promo_disc := v_promo_calc;
    -- Regalos: cada línea a $0 con gift_promo_id tiene que salir del motor
    -- (misma promo, mismo producto, sin pasarse de la cantidad).
    for v_gift in
      select x.v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as x(v)
       where nullif(x.v ->> 'gift_promo_id', '') is not null
    loop
      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_promo_eval -> 'gifts', '[]'::jsonb)) g
         where g ->> 'id' = v_gift ->> 'gift_promo_id'
           and g ->> 'product_id' = v_gift ->> 'product_id'
           and coalesce((v_gift ->> 'quantity')::numeric, 0) <= coalesce((g ->> 'qty')::numeric, 0)
           and coalesce((v_gift ->> 'unit_price')::numeric, 0) = 0) then
        if v_offline and coalesce((v_gift ->> 'unit_price')::numeric, 0) = 0 then
          -- ADR-077: regalo entregado sin conexión que el motor ya no da: se
          -- respeta lo entregado y queda el conflicto 'promo_changed'.
          v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
            'kind', 'promo_changed', 'gift', true,
            'promo_id', v_gift ->> 'gift_promo_id', 'product_id', v_gift ->> 'product_id',
            'quantity', v_gift -> 'quantity'));
        else
          raise exception 'promo_gift_invalid';
        end if;
      end if;
    end loop;
  end if;

  select string_agg(coalesce(nullif(a ->> 'label', ''), a ->> 'name'), ' + ' order by o),
         (array_agg(nullif(a ->> 'id', '')::uuid order by o))[1]
    into v_promo_label, v_promo_first
    from jsonb_array_elements(coalesce(v_promo_eval -> 'applied', '[]'::jsonb)) with ordinality as t(a, o);

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

  -- ADR-088 (ADR-082): la seña cubre hasta el total. El POS la manda como pago
  -- 'sena' por exactamente eso: de menos se cobraría dos veces; de más, no hay.
  if v_appt_id is not null and (v_sena_avail > 0 or v_sena_paid > 0) then
    v_sena_exp := round(least(v_sena_avail, v_total), 2);
    if abs(v_sena_paid - v_sena_exp) > 0.01 then
      raise exception using
        message = 'deposit_mismatch:' || jsonb_build_object('expected', v_sena_exp, 'received', v_sena_paid)::text,
        errcode = 'P0001';
    end if;
  end if;

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

  -- ADR-093: tenant_id explícito (sin DEFAULT current_tenant_id() por fila).
  insert into sales (tenant_id, store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method,
                     promo_id, promo_name, promo_discount,
                     coupon_id, coupon_code, coupon_discount,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total)
  values (v_tenant, v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total_np,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0) + v_perc,
          v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end,
          case when v_promo_disc > 0 then v_promo_first else null end,
          case when v_promo_disc > 0 then left(v_promo_label, 200) else null end,
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

  -- F9 (ADR-074): cada promo aplicada, con su reparto por línea. Si el total
  -- quedó acotado por el descuento manual, se descuenta de las últimas.
  v_promo_left := v_promo_disc;
  for v_ap in
    select a from jsonb_array_elements(coalesce(v_promo_eval -> 'applied', '[]'::jsonb)) a
  loop
    v_amt := least(coalesce((v_ap ->> 'discount')::numeric, 0), v_promo_left);
    exit when v_amt <= 0;
    insert into sale_promotions (tenant_id, sale_id, promotion_id, name, label, kind, discount,
                                 customer_id, store_id, detail)
    values (v_tenant, v_sale_id,
            (select pr.id from promotions pr where pr.id::text = v_ap ->> 'id' and pr.tenant_id = v_tenant),
            coalesce(v_ap ->> 'name', 'Promoción'), coalesce(nullif(v_ap ->> 'label', ''), v_ap ->> 'name', 'Promoción'),
            'discount', v_amt, p_customer_id, v_store,
            jsonb_build_object('lines', coalesce(v_ap -> 'lines', '[]'::jsonb), 'stackable', v_ap -> 'stackable'));
    v_promo_left := v_promo_left - v_amt;
    -- ADR-088 (ADR-074): reparto por línea (índice de p_items), acotado como
    -- la fila si el descuento manual dejó menos. Lo usa la devolución parcial.
    if coalesce((v_ap ->> 'discount')::numeric, 0) > 0 and jsonb_typeof(v_ap -> 'lines') = 'array' then
      for v_i in 0 .. jsonb_array_length(v_ap -> 'lines') - 1 loop
        v_pl := round(coalesce((v_ap -> 'lines' ->> v_i)::numeric, 0) * v_amt / (v_ap ->> 'discount')::numeric, 2);
        if v_pl > 0 then
          v_promo_line[v_i + 1] := coalesce(v_promo_line[v_i + 1], 0) + v_pl;
        end if;
      end loop;
    end if;
  end loop;
  -- Regalos entregados (valor de lista de lo regalado, para el rendimiento).
  insert into sale_promotions (tenant_id, sale_id, promotion_id, name, label, kind, discount,
                               customer_id, store_id, detail)
  select v_tenant, v_sale_id, pr.id, pr.name, coalesce(nullif(btrim(coalesce(pr.ticket_label, '')), ''), pr.name),
         'gift',
         round(coalesce((v_prices -> (x.i - 1)::int ->> 'list_price')::numeric, 0)
               * coalesce((x.v ->> 'quantity')::numeric, 0), 2),
         p_customer_id, v_store,
         jsonb_build_object('product_id', x.v ->> 'product_id', 'quantity', x.v -> 'quantity')
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i)
    join promotions pr on pr.id::text = x.v ->> 'gift_promo_id' and pr.tenant_id = v_tenant
   where nullif(x.v ->> 'gift_promo_id', '') is not null;

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
    -- ADR-093: tenant_id explícito.
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            list_price, price_override_reason,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount,
                            promo_discount)
    values (v_tenant, v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb),
            (v_prices -> v_n ->> 'list_price')::numeric,
            v_prices -> v_n ->> 'reason',
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric,
            -- ADR-088 (ADR-074): parte de la promo de esta línea.
            coalesce(v_promo_line[v_n + 1], 0));
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
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_comp.comp_allow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_comp.component_product_id
                                and ps.variant_id is null), 0) < (v_item.quantity * v_comp.quantity) then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_comp.component_product_id, null,
                                       v_item.quantity * v_comp.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_comp.comp_allow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id = v_variant.id), 0) < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_item.product_id, v_variant.id, v_item.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_pallow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id is null), 0) < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_item.product_id, null, v_item.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_pallow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            -- ADR-093: tenant_id explícito.
            insert into product_serials (tenant_id, product_id, serial, status, sale_id)
            values (v_tenant, v_item.product_id, v_serial, 'sold', v_sale_id)
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

  -- ADR-088 (ADR-085): lo que se vendió de la reserva porque el salón no alcanzaba.
  if jsonb_array_length(v_res_taken) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'sale_from_reserve',
            jsonb_build_object('sale_number', v_number, 'items', v_res_taken), v_store);
  end if;

  if v_delivery_fee > 0 then
    v_tl := v_tax -> 'lines' -> v_n;
    -- ADR-093: tenant_id explícito.
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale_id, null, null, 'Costo de envío', null, null,
            1, v_delivery_fee, 0, v_delivery_fee, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    -- ADR-093: tenant_id explícito en pagos, caja y saldo a favor.
    insert into payments (tenant_id, sale_id, method, amount, reference, card_voucher)
    values (v_tenant, v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
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

    insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reference_id)
    values (v_tenant, v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (tenant_id, customer_id, delta, reason)
      values (v_tenant, p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  -- ADR-088 (ADR-082): la seña se aplica (la plata ya entró a la caja al
  -- cobrarla) y el turno queda enlazado a la venta en esta misma transacción.
  if v_appt_id is not null then
    v_sena_left := v_sena_exp;
    for v_dep in
      select d.id, d.amount, d.applied_amount, d.refunded_amount
        from appointment_deposits d
       where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held'
       order by d.created_at, d.id
    loop
      exit when v_sena_left <= 0;
      v_amt := least(v_dep.amount - v_dep.applied_amount - v_dep.refunded_amount, v_sena_left);
      continue when v_amt <= 0;
      update appointment_deposits
         set applied_amount = applied_amount + v_amt,
             sale_id = v_sale_id,
             status = _appointment_deposit_status(amount, applied_amount + v_amt, refunded_amount)
       where id = v_dep.id;
      v_sena_left := v_sena_left - v_amt;
    end loop;

    update appointments
       set sale_id = v_sale_id, status = 'realizado', updated_at = now()
     where id = v_appt_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'appointments', v_appt_id, 'appointment_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'deposit_applied', v_sena_exp, 'deposit_available', v_sena_avail),
            v_store);
  end if;

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
    -- ADR-093: tenant_id explícito.
    insert into customer_pack_credits (
      tenant_id, customer_id, pack_id, pack_name, product_id,
      sessions_total, sessions_used, expires_at, sale_id
    )
    values (
      v_tenant, p_customer_id, v_pk.id, v_pk.name, v_pk.product_id,
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
                            'promotions', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', sp.promotion_id, 'label', sp.label, 'kind', sp.kind, 'discount', sp.discount)
                                order by sp.kind desc, sp.created_at)
                              from sale_promotions sp where sp.sale_id = v_sale_id), '[]'::jsonb),
                            'coupon_discount', v_coupon_disc,
                            'perception_total', v_perc, 'cbte_letter', v_tax ->> 'letter',
                            -- ADR-077: diferencias de la venta offline (null fuera de ese modo).
                            'offline_conflicts', case when v_offline then v_off_conf else null end,
                            -- ADR-088: aviso de lo que salió de la reserva y seña aplicada.
                            'reserve_taken', v_res_taken,
                            'deposit_applied', v_sena_exp);
end;
$function$;

revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- A.2) return_sale_v2
-- -----------------------------------------------------------------------------
create or replace function return_sale_v2(
  p_sale_id uuid,
  p_items jsonb,
  p_reason_id uuid default null,
  p_refund text default 'cash',
  p_customer_id uuid default null,
  p_allowed_branch_ids uuid[] default null,
  p_cash_shift_id uuid default null,
  p_mp_payment_id uuid default null,
  p_mp_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_sale     record;
  v_reason   record;
  v_dest     text := 'resale';
  v_reason_label text;
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_total    numeric := 0;
  v_ret      uuid;
  v_it       record;
  v_si       record;
  v_unit     numeric;
  v_qty      numeric;
  v_line     numeric;
  v_ratio    numeric := 1;
  v_policy   text := 'cashier_choice';
  v_validity int;
  v_refund   text;
  v_customer uuid;
  v_voucher_id uuid;
  v_voucher_code text;
  v_expires  timestamptz;
  v_restock  text;
  -- CC v2: parte acreditada en la cuenta corriente.
  v_acc      numeric := 0;
  -- H21h: parte por Mercado Pago y resto por el medio elegido.
  v_mp_req   boolean := coalesce(p_mp_amount, 0) > 0;
  v_mp       numeric := 0;
  v_rest     numeric := 0;
  v_mpi      record;
  v_mp_id    uuid;
  v_sup      uuid;
  -- ADR-088 (ADR-074): promo repartida por línea en la venta.
  v_promo_alloc numeric := 0;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- BUG A: no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  -- CC v2: se acepta el reintegro a la cuenta corriente.
  if p_refund not in ('cash','store_credit','account') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;

  -- H21h: validaciones de la pata Mercado Pago antes de tocar nada.
  if v_mp_req then
    if not tenant_has_feature_for(v_tenant, 'reintegro_mp') then
      raise exception 'feature_not_in_plan: reintegro_mp' using errcode = '42501';
    end if;
    if not coalesce((select (config ->> 'mp_refunds_enabled')::boolean from tenant_payment_methods
                      where tenant_id = v_tenant and provider_key = 'mercadopago'), false) then
      raise exception 'mp_refunds_disabled';
    end if;
    if p_reason_id is null then raise exception 'mp_refund_reason_required'; end if;
    if p_mp_payment_id is null then raise exception 'mp_payment_required'; end if;
    -- Un reintegro a la vez por cobro (lo que se resta lo leen las filas).
    perform 1 from payments where id = p_mp_payment_id and tenant_id = v_tenant for update;
    select * into v_mpi from _mp_refundable(v_tenant, p_mp_payment_id);
    if v_mpi.payment_id is null or v_mpi.sale_id is distinct from p_sale_id then
      raise exception 'mp_payment_not_refundable';
    end if;
    if v_mpi.expired then raise exception 'mp_refund_period_expired'; end if;
    v_mp := round(p_mp_amount, 2);
    if v_mp > v_mpi.refundable + 0.001 then raise exception 'mp_amount_exceeds_refundable'; end if;
  end if;

  select coalesce(return_policy, 'cashier_choice'), voucher_validity_months
    into v_policy, v_validity
  from pos_settings where tenant_id = v_tenant;
  if not found then v_policy := 'cashier_choice'; end if;

  v_refund := p_refund;
  -- CC v2: el reintegro a la cuenta corriente (cancelar deuda) no lo pisa la
  -- política de devoluciones (que rige efectivo vs vale).
  if v_refund <> 'account' then
    if v_policy = 'always_credit' then v_refund := 'store_credit';
    elsif v_policy = 'always_cash' then v_refund := 'cash';
    end if;
  end if;

  v_customer := coalesce(v_sale.customer_id, p_customer_id);
  -- H21h: con pata MP el cliente del vale se exige después, si queda resto.
  if v_refund = 'store_credit' and v_customer is null and not v_mp_req then
    raise exception 'store_credit_needs_customer';
  end if;
  if v_refund = 'account' and v_sale.customer_id is null then
    raise exception 'account_needs_customer';
  end if;

  if p_reason_id is not null then
    select * into v_reason from return_reasons
      where id = p_reason_id and tenant_id = v_tenant and deleted_at is null;
    if found then
      v_dest := coalesce(v_reason.stock_destination, 'resale');
      v_reason_label := v_reason.label;
    end if;
  end if;
  v_restock := case v_dest
                 when 'resale' then 'stock'
                 when 'warehouse' then 'review'
                 when 'review' then 'review'
                 else 'discard'
               end;

  if v_sale.subtotal is not null and v_sale.subtotal > 0 then
    v_ratio := v_sale.total / v_sale.subtotal;
  end if;
  -- ADR-088 (ADR-074): con la promo repartida por línea, cada línea se toma neta
  -- de su promo y el resto de los ajustes (descuento manual, cupón, redondeo,
  -- percepciones, envío) se prorratea sobre lo que queda. Así la suma de todas
  -- las devoluciones sigue dando el total de la venta. Sin reparto, como antes.
  select coalesce(sum(si.promo_discount), 0) into v_promo_alloc
    from sale_items si where si.sale_id = p_sale_id;
  if v_promo_alloc > 0 and coalesce(v_sale.subtotal, 0) - v_promo_alloc > 0 then
    v_ratio := v_sale.total / (v_sale.subtotal - v_promo_alloc);
  else
    v_promo_alloc := 0;
  end if;

  -- F17 · H90: turno y sucursal de la caja en uso; el reingreso de stock va a
  -- esa sucursal (o a la de la venta si no hay turno y no hace falta).
  -- H21h: con pata MP el turno se exige después, sólo si queda resto en efectivo.
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, v_refund = 'cash' and not v_mp_req) r;
  v_store := coalesce(v_store, v_sale.store_id);

  if v_refund = 'cash' and not v_mp_req then
    if v_shift is null then raise exception 'no_open_shift'; end if;
  end if;

  -- Correlativo de devolución con advisory lock por tenant.
  perform pg_advisory_xact_lock(hashtext('sale_return_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  -- ADR-093: tenant_id explícito.
  insert into sale_returns (tenant_id, sale_id, customer_id, number, reason, refund_method, total)
  values (v_tenant, p_sale_id, v_customer, v_number, v_reason_label, v_refund, 0)
  returning id into v_ret;

  for v_it in
    select * from jsonb_to_recordset(p_items) as x(sale_item_id uuid, quantity numeric)
  loop
    v_qty := coalesce(v_it.quantity, 0);
    if v_qty <= 0 then continue; end if;

    select * into v_si from sale_items
      where id = v_it.sale_item_id and sale_id = p_sale_id for update;
    if not found then raise exception 'item_not_found'; end if;
    if v_qty > (v_si.quantity - coalesce(v_si.returned_qty, 0)) then
      raise exception 'qty_exceeds';
    end if;

    v_unit := case when v_si.quantity > 0 then v_si.subtotal / v_si.quantity else v_si.unit_price end;
    -- ADR-088 (ADR-074): neto de la promo de la línea.
    if v_promo_alloc > 0 and v_si.quantity > 0 then
      v_unit := (v_si.subtotal - coalesce(v_si.promo_discount, 0)) / v_si.quantity;
    end if;
    v_line := round(v_unit * v_qty * v_ratio, 2);
    v_total := v_total + v_line;

    insert into sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, subtotal, restock)
    values (v_ret, v_si.id, v_si.product_id, v_qty, v_unit, v_line, v_restock);

    update sale_items set returned_qty = coalesce(returned_qty, 0) + v_qty where id = v_si.id;

    if v_dest = 'resale' and v_si.product_id is not null then
      update products set stock = stock + v_qty, updated_at = now()
        where id = v_si.product_id and tenant_id = v_tenant and track_stock;
      if found then
        insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
        values (v_tenant, v_si.product_id, v_store, v_qty, 'return', v_ret);
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
        values (v_tenant, auth.uid(), 'stock_movements', v_si.product_id, 'return_restock',
          jsonb_build_object('return_id', v_ret, 'product_id', v_si.product_id,
            'qty', v_qty, 'destination', v_dest));
      end if;
    end if;
  end loop;

  if v_total <= 0 then raise exception 'empty_return'; end if;
  update sale_returns set total = v_total where id = v_ret;

  -- H21h: parte por Mercado Pago (nunca más que lo devuelto) y resto.
  if v_mp_req then
    if v_mp > v_total + 0.001 then raise exception 'mp_amount_exceeds_return'; end if;
    v_mp := least(v_mp, v_total);
    v_rest := round(v_total - v_mp, 2);
    if v_rest > 0 and v_refund = 'store_credit' and v_customer is null then
      raise exception 'store_credit_needs_customer';
    end if;
    if v_rest > 0 and v_refund = 'cash' and v_shift is null then
      raise exception 'no_open_shift';
    end if;
    -- Rol supervisor o PIN 'reintegro_mp' (token en el header).
    v_sup := require_supervisor('reintegro_mp', v_mp, p_sale_id);

    insert into mp_refunds (tenant_id, sale_id, sale_return_id, payment_id, intent_id, store_id, provider_key,
                            amount, requested_by, authorized_by, mp_env, secret_store_id)
    select v_tenant, p_sale_id, v_ret, v_mpi.payment_id, v_mpi.intent_id, v_sale.store_id, v_mpi.provider_key,
           v_mp, auth.uid(), coalesce(v_sup, auth.uid()), it.mp_env, it.secret_store_id
      from mp_payment_intents it where it.id = v_mpi.intent_id
    returning id into v_mp_id;

    update sale_returns
       set mp_refund_amount = v_mp,
           refund_method = case when v_rest <= 0 then 'mercadopago' else refund_method end
     where id = v_ret;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'mp_refunds', v_mp_id, 'mp_refund_requested',
      jsonb_build_object('return_id', v_ret, 'sale_id', p_sale_id, 'payment_id', v_mpi.payment_id,
        'amount', v_mp, 'refundable_before', v_mpi.refundable, 'authorized_by', v_sup));
  else
    v_rest := v_total;
  end if;

  -- CC v2: lo pagado con cuenta corriente vuelve a la cuenta (no en efectivo);
  -- con reintegro 'account' vuelve todo a la cuenta. El vale no cambia (el
  -- cambio de mercadería lo usa y la deuda original sigue correspondiendo).
  -- H21h: sobre el resto (lo que no va por Mercado Pago).
  if v_rest > 0 and v_refund in ('cash', 'account') then
    v_acc := account_return_credit(p_sale_id, v_rest, v_refund = 'account',
                                   'Devolución #' || v_number || ' venta #' || v_sale.number);
    update sale_returns
       set account_credited = v_acc,
           refund_method = case when v_mp <= 0 and (v_refund = 'account' or v_acc >= v_total) then 'account'
                                else refund_method end
     where id = v_ret;
  end if;

  if v_rest > 0 and v_refund = 'cash' then
    if v_rest - v_acc > 0 then
      -- ADR-093: tenant_id explícito.
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id)
      values (v_tenant, v_shift, 'expense', v_rest - v_acc, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
    end if;
  elsif v_rest > 0 and v_refund = 'store_credit' then
    v_expires := case when v_validity is not null
                      then now() + make_interval(months => v_validity)
                      else null end;
    v_voucher_code := gen_voucher_code();
    insert into store_credit_vouchers
      (tenant_id, code, amount, customer_id, status, expires_at, allowed_branch_ids, sale_return_id)
    values
      (v_tenant, v_voucher_code, v_rest, v_customer, 'active', v_expires, p_allowed_branch_ids, v_ret)
    returning id into v_voucher_id;

    -- ADR-093: tenant_id explícito.
    insert into store_credit_movements (tenant_id, customer_id, delta, reason, sale_return_id, voucher_id)
    values (v_tenant, v_customer, v_rest, 'Vale ' || v_voucher_code || ' (dev #' || v_number || ')', v_ret, v_voucher_id);

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'store_credit_vouchers', v_voucher_id, 'voucher_issued',
      jsonb_build_object('code', v_voucher_code, 'amount', v_rest, 'customer_id', v_customer,
        'expires_at', v_expires, 'allowed_branch_ids', p_allowed_branch_ids, 'return_id', v_ret));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'sale_returns', v_ret, 'return_created',
    jsonb_build_object('number', v_number, 'sale_id', p_sale_id, 'total', v_total,
      'refund', v_refund, 'reason_id', p_reason_id, 'stock_destination', v_dest,
      'mp_amount', v_mp, 'mp_refund_id', v_mp_id));

  return jsonb_build_object(
    'return_id', v_ret, 'number', v_number, 'total', v_total,
    'refund', v_refund, 'stock_destination', v_dest,
    'voucher_code', v_voucher_code, 'voucher_expires_at', v_expires,
    'account_credited', v_acc,
    'cash_refund', case when v_refund = 'cash' and v_rest > 0 then v_rest - v_acc else 0 end,
    'mp_amount', v_mp,
    'mp_refund_id', v_mp_id,
    'rest_amount', v_rest
  );
end;
$$;

revoke all on function public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[], uuid, uuid, numeric) from public, anon;
grant execute on function public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[], uuid, uuid, numeric) to authenticated;

-- -----------------------------------------------------------------------------
-- B) catalog_search con el índice trigram (ADR-093)
--
-- Misma firma, mismo tipo de retorno y mismas columnas que la definición más
-- nueva (20261011210000_tiendita_productos_completos, verificado con grep). La
-- app ya busca el catálogo sólo por esta RPC (modules/tiendita/storefront.ts):
-- no hay lecturas de catalog_products por REST con ilike en el front.
--
-- Cambios:
--   * Permisos iguales a la policy catalog_products_read vigente: staff
--     interno sólo en el contexto del panel interno ((select internal_scope()),
--     ADR-052; antes alcanzaba is_internal() suelto) o el negocio actual
--     compró o recibió el catálogo y está activo. Si no, 'forbidden'.
--   * Con texto: la consulta va por EXECUTE ... USING, que se planifica con
--     los valores reales en cada llamada. Así "titulo ilike '%texto%'" usa
--     catalog_products_titulo_trgm_idx y "ean = texto" catalog_products_ean_idx
--     (BitmapOr), en vez de un plan genérico con "texto = '' or ..." que no
--     puede usar ninguno de los dos. Las tiendas del catálogo se resuelven
--     antes (store_key = any(...)) en lugar del join: catalog_store_map tiene
--     PK (catalog_id, store_key), así que el resultado es el mismo.
--   * Orden estable para paginar: se agrega id como desempate al final
--     (antes dos filas con el mismo título podían repetirse entre páginas).
--   * Límite 1 a 100 y offset >= 0, como antes. SECURITY DEFINER: no pasa por
--     la RLS de catalog_products (que con ilike no leakproof impedía el índice).
-- -----------------------------------------------------------------------------
create or replace function public.catalog_search(
  p_catalog_id uuid,
  p_query text default '',
  p_limit integer default 30,
  p_offset integer default 0
)
returns table (
  catalog_product_id bigint,
  store_key text,
  ean text,
  titulo text,
  precio numeric,
  precio_lista numeric,
  marca text,
  categoria_path text,
  foto_url text,
  disponible boolean,
  descripcion text,
  atributos jsonb
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_limit  integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_q      text := btrim(coalesce(p_query, ''));
  v_like   text;
  v_stores text[];
begin
  -- Mismo criterio que la policy catalog_products_read.
  if not (select internal_scope()) then
    if not exists (
      select 1 from tenant_catalog_purchases tcp
        join catalogs c on c.id = tcp.catalog_id
       where tcp.catalog_id = p_catalog_id
         and tcp.tenant_id = (select current_tenant_id())
         and c.is_active
    ) then
      raise exception 'forbidden';
    end if;
  end if;

  select c.dedupe_by_ean into v_dedupe from catalogs c where c.id = p_catalog_id;
  if v_dedupe is null then
    raise exception 'catalog_not_found';
  end if;

  select coalesce(array_agg(csm.store_key), '{}'::text[]) into v_stores
    from catalog_store_map csm
   where csm.catalog_id = p_catalog_id;

  -- Sin texto: los primeros productos del catálogo (como antes).
  if v_q = '' then
    if v_dedupe then
      return query
      with deduped as (
        select distinct on (cp.ean) cp.*
          from catalog_products cp
         where cp.store_key = any(v_stores)
         order by cp.ean, cp.disponible desc, cp.updated_at desc, cp.id desc
      )
      select d.id, d.store_key, d.ean, d.titulo, d.precio, d.precio_lista,
             d.marca, d.categoria_path, d.foto_url, d.disponible,
             d.descripcion, d.atributos
        from deduped d
       order by d.disponible desc, d.titulo, d.id
       limit v_limit offset v_offset;
    else
      return query
      select cp.id, cp.store_key, cp.ean, cp.titulo, cp.precio, cp.precio_lista,
             cp.marca, cp.categoria_path, cp.foto_url, cp.disponible,
             cp.descripcion, cp.atributos
        from catalog_products cp
       where cp.store_key = any(v_stores)
       order by cp.disponible desc, cp.titulo, cp.id
       limit v_limit offset v_offset;
    end if;
    return;
  end if;

  v_like := '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%';

  if v_dedupe then
    return query execute
      $q$
      with scoped as (
        select cp.*
          from catalog_products cp
         where (cp.titulo ilike $2 or cp.ean = $3)
           and cp.store_key = any($1)
      ),
      deduped as (
        select distinct on (s.ean) s.*
          from scoped s
         order by s.ean, s.disponible desc, s.updated_at desc, s.id desc
      )
      select d.id, d.store_key, d.ean, d.titulo, d.precio, d.precio_lista,
             d.marca, d.categoria_path, d.foto_url, d.disponible,
             d.descripcion, d.atributos
        from deduped d
       order by d.disponible desc, d.titulo, d.id
       limit $4 offset $5
      $q$
      using v_stores, v_like, v_q, v_limit, v_offset;
  else
    return query execute
      $q$
      select cp.id, cp.store_key, cp.ean, cp.titulo, cp.precio, cp.precio_lista,
             cp.marca, cp.categoria_path, cp.foto_url, cp.disponible,
             cp.descripcion, cp.atributos
        from catalog_products cp
       where (cp.titulo ilike $2 or cp.ean = $3)
         and cp.store_key = any($1)
       order by cp.disponible desc, cp.titulo, cp.id
       limit $4 offset $5
      $q$
      using v_stores, v_like, v_q, v_limit, v_offset;
  end if;
end;
$function$;

revoke all on function public.catalog_search(uuid, text, integer, integer) from public, anon;
grant execute on function public.catalog_search(uuid, text, integer, integer) to authenticated;
