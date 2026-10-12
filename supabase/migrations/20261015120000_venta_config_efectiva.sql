-- =============================================================================
-- 20261015120000_venta_config_efectiva  (F17 · H92 y H94 · ADR-049)
--
-- create_sale: copia exacta de 20261013120000_venta_sucursal_del_turno.sql
-- (misma firma de 13 args) con dos cambios:
--   1) Descuento máximo por rol, redondeo y venta sin stock salen de la
--      configuración efectiva de la sucursal y la caja del turno
--      (_effective_config 'pos_settings'): el servidor resuelve con la caja
--      del turno, la UI sólo lo muestra.
--   2) Venta sin stock por sucursal: con stock_sucursales y 2+ sucursales,
--      si no se permite vender en negativo también se controla el saldo de la
--      sucursal del turno (product_stock) → 'insufficient_stock_branch'.
--      El control del total queda igual.
-- Las RPC de stock por sucursal y traslados (20261013200100/200200) no se
-- tocan: el movimiento con store_id ya descuenta la sucursal correcta.
-- =============================================================================

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
                     coupon_id, coupon_code, coupon_discount)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end,
          case when v_promo_disc > 0 then p_promo_id else null end,
          case when v_promo_disc > 0 then nullif(btrim(coalesce(p_promo_name, '')), '') else null end,
          v_promo_disc,
          case when v_coupon_disc > 0 then p_coupon_id else null end,
          case when v_coupon_disc > 0 then v_coupon.code else null end,
          v_coupon_disc)
  returning id into v_sale_id;

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

    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb));

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

  if v_delivery_fee > 0 then
    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers)
    values (v_sale_id, null, null, 'Costo de envío', null, null,
            1, v_delivery_fee, 0, v_delivery_fee, '[]'::jsonb);
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
                            'coupon_discount', v_coupon_disc);
end;
$function$;

revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) to authenticated;

-- =============================================================================
-- close_cash_shift: copia exacta de 20261011200200_cuenta_corriente_v2_reversas
-- (misma firma, SECURITY INVOKER como siempre) con el motivo obligatorio y la
-- tolerancia efectivos de la sucursal y la caja del turno. Como corre con los
-- permisos del usuario, lee la configuración por _pos_close_config (SECURITY
-- DEFINER, sólo para el turno abierto del negocio del JWT).
-- =============================================================================
create or replace function _pos_close_config(p_shift_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid;
  v_reg    uuid;
begin
  select cs.store_id, cs.cash_register_id into v_store, v_reg
    from cash_shifts cs where cs.id = p_shift_id and cs.tenant_id = v_tenant;
  if v_tenant is null or v_reg is null then return '{}'::jsonb; end if;
  return _effective_config(v_tenant, 'pos_settings', '', v_store, v_reg) -> 'value';
end;
$$;
revoke all on function _pos_close_config(uuid) from public, anon;
grant execute on function _pos_close_config(uuid) to authenticated;

create or replace function close_cash_shift(
  p_shift_id       uuid,
  p_closing_amount numeric,
  p_notes          text default null
)
returns numeric
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening    numeric;
  v_expected   numeric;
  v_diff       numeric;
  v_store      uuid;
  v_opened_at  timestamptz;
  v_opened_by  uuid;
  v_znum       bigint;
  v_sales_count   integer;
  v_sales_total   numeric;
  v_disc_total    numeric;
  v_voids_count   integer;
  v_voids_total   numeric;
  v_cash_in    numeric;
  v_cash_out   numeric;
  v_breakdown  jsonb;
  v_req        boolean;
  v_tol        numeric;
  v_account    jsonb;
  v_register   uuid;
  v_eff        jsonb;
begin
  select cs.opening_amount, cs.opened_at, cs.opened_by, cr.store_id, cs.cash_register_id
    into v_opening, v_opened_at, v_opened_by, v_store, v_register
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.id = p_shift_id and cs.tenant_id = current_tenant_id() and cs.status = 'open';
  if v_opening is null then
    raise exception 'shift_not_open';
  end if;

  select v_opening
       + coalesce(sum(case when type = 'income' then amount
                           when type = 'expense' then -amount
                           when type = 'sale' and payment_method = 'cash' then amount
                           when type = 'sale_void' and payment_method = 'cash' then -amount
                           else 0 end), 0)
    into v_expected
  from cash_movements
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  v_diff := p_closing_amount - v_expected;

  -- Motivo obligatorio si la diferencia supera la tolerancia (si está activado).
  -- F17 · H92 (ADR-049): motivo y tolerancia efectivos de la sucursal y la
  -- caja del turno (negocio ← grupo ← sucursal ← caja).
  v_eff := _pos_close_config(p_shift_id);
  v_req := (v_eff ->> 'require_close_reason')::boolean;
  v_tol := (v_eff ->> 'close_tolerance')::numeric;
  if coalesce(v_req, false)
     and abs(v_diff) > coalesce(v_tol, 0)
     and (p_notes is null or btrim(p_notes) = '') then
    raise exception 'close_needs_reason';
  end if;

  update cash_shifts
     set status = 'closed',
         closed_at = now(),
         closed_by = auth.uid(),
         expected_amount = v_expected,
         closing_amount = p_closing_amount,
         notes = p_notes
   where id = p_shift_id and tenant_id = current_tenant_id();

  select count(*) filter (where status = 'completed'),
         coalesce(sum(total) filter (where status = 'completed'), 0),
         coalesce(sum(discount_total) filter (where status = 'completed'), 0),
         count(*) filter (where status = 'voided'),
         coalesce(sum(total) filter (where status = 'voided'), 0)
    into v_sales_count, v_sales_total, v_disc_total, v_voids_count, v_voids_total
  from sales
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  select coalesce(sum(amount) filter (where type = 'income'), 0),
         coalesce(sum(amount) filter (where type = 'expense'), 0)
    into v_cash_in, v_cash_out
  from cash_movements
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  select coalesce(jsonb_object_agg(payment_method, t), '{}'::jsonb)
    into v_breakdown
  from (
    select payment_method, sum(amount) as t
    from cash_movements
    where cash_shift_id = p_shift_id and tenant_id = current_tenant_id()
      and type = 'sale' and payment_method is not null
    group by payment_method
  ) s;

  -- CC v2: cobros de cuenta corriente del turno por medio (los de efectivo ya
  -- están en cash_in y en el esperado; acá se informan todos).
  select coalesce(jsonb_object_agg(method, t), '{}'::jsonb)
    into v_account
  from (
    select m.method, round(sum(-m.delta), 2) as t
    from customer_account_movements m
    where m.cash_shift_id = p_shift_id and m.tenant_id = current_tenant_id()
      and m.kind = 'payment' and m.voided_at is null and m.method is not null
    group by m.method
  ) a;

  select coalesce(max(z_number), 0) + 1 into v_znum
  from cash_z_closures where tenant_id = current_tenant_id();

  insert into cash_z_closures (
    store_id, cash_shift_id, z_number, opened_at, closed_at, opened_by, closed_by,
    opening_amount, closing_amount, expected_amount, difference,
    sales_count, sales_total, discounts_total, voids_count, voids_total,
    cash_in, cash_out, payment_breakdown, account_collected
  ) values (
    v_store, p_shift_id, v_znum, v_opened_at, now(), v_opened_by, auth.uid(),
    v_opening, p_closing_amount, v_expected, v_diff,
    v_sales_count, v_sales_total, v_disc_total, v_voids_count, v_voids_total,
    v_cash_in, v_cash_out, v_breakdown, v_account
  )
  on conflict (cash_shift_id) do nothing;

  return v_diff;
end;
$$;
