-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H53 — Aplicar promociones en el cobro (create_sale + descuento promo) ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- El POS calcula la mejor promoción aplicable al carrito (motor lib/promotions)
-- y la pasa a create_sale en un CANAL SEPARADO del descuento manual:
--   p_promo_discount / p_promo_id / p_promo_name.
-- Una promo NO es un descuento manual: por eso su monto NO pasa por el gating de
-- la feature 'descuentos' ni por el TOPE de descuento por rol (max_discount).
-- Se confía en el monto calculado por el cliente (igual que con precios y
-- modificadores: create_sale no los recalcula), acotándolo server-side a lo que
-- queda del subtotal tras el descuento manual (el total nunca queda < 0). La
-- venta persiste la promo (id + nombre + monto) para reporte/auditoría.
--
-- create_sale se RECREA desde su definición VIVA EXACTA (firma de 8 args con
-- p_table_order_id/p_delivery_order_id) agregando SÓLO: los 3 params nuevos, la
-- cota del descuento de promo, su resta del total y su persistencia. Todo lo
-- demás (gating real medios/garantías/cuenta corriente, advisory lock del
-- correlativo, stock/kits/variantes/serial, tips, packs, ramas mesa/delivery,
-- validación QR) queda IDÉNTICO. Cambia la aridad (8→11) → se elimina la firma
-- vieja para que exista una sola definición autoritativa.

-- ── 1) Columnas de promo en la venta ──────────────────────────────────────────
alter table sales add column if not exists promo_id uuid references promotions(id) on delete set null;
alter table sales add column if not exists promo_name text;
alter table sales add column if not exists promo_discount numeric(12,2) not null default 0;
comment on column sales.promo_discount is 'Descuento de promoción (F9) aplicado a la venta. Va incluido en discount_total; el detalle queda en promo_id/promo_name.';

-- ── 2) create_sale + canal de promo ───────────────────────────────────────────
create or replace function public.create_sale(
  p_items jsonb,
  p_payments jsonb,
  p_discount_total numeric default 0,
  p_customer_id uuid default null,
  p_notes text default null,
  p_extras jsonb default '[]'::jsonb,
  p_table_order_id uuid default null,
  p_delivery_order_id uuid default null,
  p_promo_discount numeric default 0,
  p_promo_id uuid default null,
  p_promo_name text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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

  select id into v_store
  from stores
  where tenant_id = v_tenant and deleted_at is null
  order by is_default desc, created_at
  limit 1;
  if v_store is null then
    raise exception 'no_store';
  end if;

  select cs.id into v_shift
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
  order by cs.opened_at desc
  limit 1;
  if v_shift is null then
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;

  select coalesce((ps.max_discount ->> coalesce(v_role, 'cashier'))::numeric, 100),
         coalesce(ps.rounding_multiple, 0),
         coalesce(ps.allow_negative_stock, true)
    into v_max_disc, v_round, v_allow_neg
  from pos_settings ps
  where ps.tenant_id = v_tenant;
  if not found then
    v_max_disc := 100; v_round := 0; v_allow_neg := true;
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

  -- Descuento de PROMOCIÓN (F9): canal aparte del descuento manual. NO pasa por
  -- el gating de 'descuentos' ni por el tope de descuento por rol (la promo tiene
  -- su propia lógica/validación en el motor). Se confía en el monto del cliente
  -- (como con precios/modificadores) y se acota a lo que queda del subtotal tras
  -- el descuento manual, para que el total nunca quede negativo.
  v_promo_disc := least(
    greatest(coalesce(p_promo_discount, 0), 0),
    greatest(v_subtotal - coalesce(p_discount_total, 0), 0)
  );

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc;

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
                     promo_id, promo_name, promo_discount)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end,
          case when v_promo_disc > 0 then p_promo_id else null end,
          case when v_promo_disc > 0 then nullif(btrim(coalesce(p_promo_name, '')), '') else null end,
          v_promo_disc)
  returning id into v_sale_id;

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
        v_pname := v_pname || ' — ' || v_variant.option1
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
                            'tip', v_tip_amount, 'promo_discount', v_promo_disc);
end;
$function$;

-- ── 3) Eliminar la firma vieja de 8 args (sin promo) y reafirmar grants ────────
drop function if exists public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid);
revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text) to authenticated;
