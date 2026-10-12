-- =============================================================================
-- 20261013120000_venta_sucursal_del_turno  (F17 · H90 P0 · ADR-045)
--
-- Fix P0: create_sale, return_sale, return_sale_v2, exchange_sale y el cobro de
-- cuenta corriente (account_open_shift) elegían la sucursal DEFAULT
-- (order by is_default desc ... limit 1) y el último turno abierto de esa
-- sucursal. Con dos sucursales, la venta de la caja de Norte quedaba en Centro
-- (o fallaba con no_open_shift). Ahora la sucursal SALE DEL TURNO DE CAJA:
--
--   resolve_sale_shift(p_cash_shift_id, p_strict) → (o_shift_id, o_store_id)
--     1. p_cash_shift_id explícito (lo manda el POS): debe ser del negocio,
--        estar abierto y en una sucursal permitida para el usuario.
--     2. Negocio con una sola sucursal viva: EXACTAMENTE el criterio anterior
--        (sucursal default + su último turno abierto). Sin cambio de conducta
--        para los negocios actuales.
--     3. Varias sucursales sin turno explícito: el último turno abierto por el
--        propio usuario en una sucursal permitida; si no, el último turno
--        abierto si todos los abiertos están en una sola sucursal permitida;
--        si hay turnos abiertos en varias, 'shift_ambiguous' (el POS tiene
--        que mandar el turno). p_strict = false devuelve nulls en vez de error.
--
-- Las funciones se copian COMPLETAS desde su última definición (ver cada
-- sección) y sólo cambia el bloque de sucursal y turno. Firmas compatibles:
-- create_sale, return_sale_v2 y exchange_sale suman p_cash_shift_id opcional al
-- final (se dropea la firma vieja, como en 20260609320000). return_sale y
-- account_open_shift mantienen su firma.
--
-- open_cash_shift valida que la caja sea del negocio, esté activa y no
-- archivada, que la sucursal esté activa y que el usuario pueda operar en ella.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Resolución de turno y sucursal
-- -----------------------------------------------------------------------------
create or replace function resolve_sale_shift(
  p_cash_shift_id uuid default null,
  p_strict        boolean default true,
  out o_shift_id  uuid,
  out o_store_id  uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_live    int;
  v_allowed uuid[];
  v_status  text;
  v_nstores int;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;

  -- 1) Turno explícito.
  if p_cash_shift_id is not null then
    select cs.id, cs.store_id, cs.status into o_shift_id, o_store_id, v_status
      from cash_shifts cs
     where cs.id = p_cash_shift_id and cs.tenant_id = v_tenant;
    if o_shift_id is null then
      if p_strict then raise exception 'shift_not_found'; end if;
    elsif v_status <> 'open' then
      if p_strict then raise exception 'shift_not_open'; end if;
      o_shift_id := null; o_store_id := null;
    elsif not user_can_access_store(o_store_id) then
      if p_strict then raise exception 'store_not_allowed'; end if;
      o_shift_id := null; o_store_id := null;
    else
      return;
    end if;
  end if;

  select count(*) into v_live from stores where tenant_id = v_tenant and deleted_at is null;

  -- 2) Una sola sucursal viva: criterio histórico.
  if v_live <= 1 then
    select s.id into o_store_id
      from stores s
     where s.tenant_id = v_tenant and s.deleted_at is null
     order by s.is_default desc, s.created_at
     limit 1;
    if o_store_id is not null then
      select cs.id into o_shift_id
        from cash_shifts cs
       where cs.tenant_id = v_tenant and cs.status = 'open' and cs.store_id = o_store_id
       order by cs.opened_at desc
       limit 1;
    end if;
    return;
  end if;

  -- 3) Varias sucursales: inferencia segura.
  v_allowed := user_allowed_store_ids();

  select cs.id, cs.store_id into o_shift_id, o_store_id
    from cash_shifts cs
   where cs.tenant_id = v_tenant and cs.status = 'open'
     and cs.opened_by = auth.uid()
     and cs.store_id = any (v_allowed)
   order by cs.opened_at desc
   limit 1;
  if o_shift_id is not null then return; end if;

  select count(distinct cs.store_id) into v_nstores
    from cash_shifts cs
   where cs.tenant_id = v_tenant and cs.status = 'open' and cs.store_id = any (v_allowed);

  if v_nstores = 1 then
    select cs.id, cs.store_id into o_shift_id, o_store_id
      from cash_shifts cs
     where cs.tenant_id = v_tenant and cs.status = 'open' and cs.store_id = any (v_allowed)
     order by cs.opened_at desc
     limit 1;
    return;
  end if;

  if v_nstores > 1 and p_strict then
    raise exception 'shift_ambiguous';
  end if;

  -- Sin turno: si el usuario opera en una sola sucursal, esa es la sucursal.
  if cardinality(v_allowed) = 1 then
    o_store_id := v_allowed[1];
  end if;
end;
$$;
revoke all on function resolve_sale_shift(uuid, boolean) from public, anon;
grant execute on function resolve_sale_shift(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- B) open_cash_shift: copia de 20260608690000_account_enforcement_qr_validate +
--    validación de caja, sucursal y acceso del usuario.
-- -----------------------------------------------------------------------------
create or replace function open_cash_shift(
  p_register_id uuid,
  p_opening_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_shift_id uuid;
  v_reg      record;
begin
  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);

  -- F17 · H89/H91: la caja tiene que ser del negocio, estar activa, en una
  -- sucursal activa y en la que el usuario pueda operar.
  select cr.id, cr.is_active, cr.deleted_at, s.id as store_id,
         s.is_active as store_active, s.deleted_at as store_deleted
    into v_reg
    from cash_registers cr
    join stores s on s.id = cr.store_id
   where cr.id = p_register_id and cr.tenant_id = v_tenant;
  if not found or v_reg.deleted_at is not null or v_reg.store_deleted is not null then
    raise exception 'register_not_found';
  end if;
  if not v_reg.is_active then raise exception 'register_inactive'; end if;
  if not v_reg.store_active then raise exception 'store_paused'; end if;
  if not user_can_access_store(v_reg.store_id) then raise exception 'store_not_allowed'; end if;

  -- Un turno abierto por caja (lock para dos aperturas simultáneas).
  perform pg_advisory_xact_lock(hashtext('open_shift:' || p_register_id::text));
  if exists (
    select 1 from cash_shifts
    where cash_register_id = p_register_id
      and tenant_id = v_tenant
      and status = 'open'
  ) then
    raise exception 'shift_already_open';
  end if;

  insert into cash_shifts (cash_register_id, opening_amount, status)
  values (p_register_id, p_opening_amount, 'open')
  returning id into v_shift_id;

  return v_shift_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) create_sale: copia exacta de 20260609320000_create_sale_coupon.sql + param
--    p_cash_shift_id (opcional) + sucursal y turno por resolve_sale_shift + rol
--    por sucursal. Se dropea la firma de 12 args para que PostgREST no tenga
--    ambigüedad (los callers sin el param resuelven a la de 13).
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
  if v_store is null then
    raise exception 'no_store';
  end if;
  if v_shift is null then
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;
  -- F17 · H91: el rol puede estar pisado en esta sucursal (tope de descuento).
  v_role := coalesce(user_store_role(v_store), v_role);

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
                            'tip', v_tip_amount, 'promo_discount', v_promo_disc,
                            'coupon_discount', v_coupon_disc);
end;
$function$;

drop function if exists public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid);
revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) return_sale (v1): copia exacta de 20261011200200_cuenta_corriente_v2_reversas
--    con la sucursal y el turno de la caja en uso. Misma firma.
-- -----------------------------------------------------------------------------
create or replace function return_sale(
  p_sale_id uuid,
  p_items jsonb,
  p_reason text default null,
  p_refund text default 'cash'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_sale   record;
  v_store  uuid;
  v_shift  uuid;
  v_number bigint;
  v_total  numeric := 0;
  v_ret    uuid;
  v_it     record;
  v_si     record;
  v_unit   numeric;
  v_qty    numeric;
  v_line   numeric;
  v_restock text;
  v_ratio  numeric := 1;
  -- CC v2: parte acreditada en la cuenta corriente.
  v_acc    numeric := 0;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  -- CC v2: se acepta el reintegro a la cuenta corriente.
  if p_refund not in ('cash','store_credit','account') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;
  if p_refund = 'store_credit' and v_sale.customer_id is null then
    raise exception 'store_credit_needs_customer';
  end if;
  if p_refund = 'account' and v_sale.customer_id is null then
    raise exception 'account_needs_customer';
  end if;

  if v_sale.subtotal is not null and v_sale.subtotal > 0 then
    v_ratio := v_sale.total / v_sale.subtotal;
  end if;

  -- F17 · H90: turno y sucursal de la caja en uso; el reingreso de stock va a
  -- esa sucursal (o a la de la venta si no hay turno y no hace falta).
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(null, p_refund = 'cash') r;
  v_store := coalesce(v_store, v_sale.store_id);

  if p_refund = 'cash' then
    if v_shift is null then raise exception 'no_open_shift'; end if;
  end if;

  -- Correlativo de devolución con advisory lock por tenant.
  perform pg_advisory_xact_lock(hashtext('sale_return_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  insert into sale_returns (sale_id, customer_id, number, reason, refund_method, total)
  values (p_sale_id, v_sale.customer_id, v_number, p_reason, p_refund, 0)
  returning id into v_ret;

  for v_it in
    select * from jsonb_to_recordset(p_items)
      as x(sale_item_id uuid, quantity numeric, restock text)
  loop
    v_qty := coalesce(v_it.quantity, 0);
    if v_qty <= 0 then continue; end if;

    select * into v_si from sale_items
      where id = v_it.sale_item_id and sale_id = p_sale_id
      for update;
    if not found then raise exception 'item_not_found'; end if;
    if v_qty > (v_si.quantity - coalesce(v_si.returned_qty, 0)) then
      raise exception 'qty_exceeds';
    end if;

    v_unit := case when v_si.quantity > 0 then v_si.subtotal / v_si.quantity else v_si.unit_price end;
    v_line := round(v_unit * v_qty * v_ratio, 2);
    v_total := v_total + v_line;
    v_restock := coalesce(v_it.restock, 'stock');
    if v_restock not in ('stock','review','discard') then v_restock := 'stock'; end if;

    insert into sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, subtotal, restock)
    values (v_ret, v_si.id, v_si.product_id, v_qty, v_unit, v_line, v_restock);

    update sale_items set returned_qty = coalesce(returned_qty, 0) + v_qty where id = v_si.id;

    if v_restock = 'stock' and v_si.product_id is not null then
      if v_si.variant_id is not null then
        update product_variants pv set stock = pv.stock + v_qty, updated_at = now()
          where pv.id = v_si.variant_id and pv.tenant_id = v_tenant
            and exists (select 1 from products p where p.id = v_si.product_id and p.tenant_id = v_tenant and p.track_stock);
        insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id)
        select v_tenant, v_si.product_id, v_si.variant_id, v_store, v_qty, 'return', v_ret
        where exists (select 1 from products p where p.id = v_si.product_id and p.tenant_id = v_tenant and p.track_stock);
      else
        update products set stock = stock + v_qty, updated_at = now()
          where id = v_si.product_id and tenant_id = v_tenant and track_stock;
        insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
        select v_tenant, v_si.product_id, v_store, v_qty, 'return', v_ret
        where exists (select 1 from products where id = v_si.product_id and tenant_id = v_tenant and track_stock);
      end if;
    end if;
  end loop;

  if v_total <= 0 then raise exception 'empty_return'; end if;
  update sale_returns set total = v_total where id = v_ret;

  -- CC v2: lo pagado con cuenta corriente vuelve a la cuenta (no en efectivo);
  -- con reintegro 'account' vuelve todo a la cuenta.
  if p_refund in ('cash', 'account') then
    v_acc := account_return_credit(p_sale_id, v_total, p_refund = 'account',
                                   'Devolución #' || v_number || ' venta #' || v_sale.number);
    update sale_returns
       set account_credited = v_acc,
           refund_method = case when p_refund = 'account' or v_acc >= v_total then 'account' else refund_method end
     where id = v_ret;
  end if;

  if p_refund = 'cash' then
    if v_total - v_acc > 0 then
      insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
      values (v_shift, 'expense', v_total - v_acc, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
    end if;
  elsif p_refund = 'store_credit' then
    insert into store_credit_movements (customer_id, delta, reason, sale_return_id)
    values (v_sale.customer_id, v_total, 'Devolución venta #' || v_sale.number, v_ret);
  end if;

  return jsonb_build_object('return_id', v_ret, 'number', v_number, 'total', v_total,
                            'account_credited', v_acc,
                            'cash_refund', case when p_refund = 'cash' then v_total - v_acc else 0 end);
end;
$$;

-- -----------------------------------------------------------------------------
-- E) return_sale_v2: copia exacta de 20261011200200_cuenta_corriente_v2_reversas
--    + param p_cash_shift_id (opcional). Se dropea la firma de 6 args.
-- -----------------------------------------------------------------------------
create or replace function return_sale_v2(
  p_sale_id uuid,
  p_items jsonb,
  p_reason_id uuid default null,
  p_refund text default 'cash',
  p_customer_id uuid default null,
  p_allowed_branch_ids uuid[] default null,
  p_cash_shift_id uuid default null
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
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  -- CC v2: se acepta el reintegro a la cuenta corriente.
  if p_refund not in ('cash','store_credit','account') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;

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
  if v_refund = 'store_credit' and v_customer is null then
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

  -- F17 · H90: turno y sucursal de la caja en uso; el reingreso de stock va a
  -- esa sucursal (o a la de la venta si no hay turno y no hace falta).
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, v_refund = 'cash') r;
  v_store := coalesce(v_store, v_sale.store_id);

  if v_refund = 'cash' then
    if v_shift is null then raise exception 'no_open_shift'; end if;
  end if;

  -- Correlativo de devolución con advisory lock por tenant.
  perform pg_advisory_xact_lock(hashtext('sale_return_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  insert into sale_returns (sale_id, customer_id, number, reason, refund_method, total)
  values (p_sale_id, v_customer, v_number, v_reason_label, v_refund, 0)
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

  -- CC v2: lo pagado con cuenta corriente vuelve a la cuenta (no en efectivo);
  -- con reintegro 'account' vuelve todo a la cuenta. El vale no cambia (el
  -- cambio de mercadería lo usa y la deuda original sigue correspondiendo).
  if v_refund in ('cash', 'account') then
    v_acc := account_return_credit(p_sale_id, v_total, v_refund = 'account',
                                   'Devolución #' || v_number || ' venta #' || v_sale.number);
    update sale_returns
       set account_credited = v_acc,
           refund_method = case when v_refund = 'account' or v_acc >= v_total then 'account' else refund_method end
     where id = v_ret;
  end if;

  if v_refund = 'cash' then
    if v_total - v_acc > 0 then
      insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
      values (v_shift, 'expense', v_total - v_acc, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
    end if;
  elsif v_refund = 'store_credit' then
    v_expires := case when v_validity is not null
                      then now() + make_interval(months => v_validity)
                      else null end;
    v_voucher_code := gen_voucher_code();
    insert into store_credit_vouchers
      (tenant_id, code, amount, customer_id, status, expires_at, allowed_branch_ids, sale_return_id)
    values
      (v_tenant, v_voucher_code, v_total, v_customer, 'active', v_expires, p_allowed_branch_ids, v_ret)
    returning id into v_voucher_id;

    insert into store_credit_movements (customer_id, delta, reason, sale_return_id, voucher_id)
    values (v_customer, v_total, 'Vale ' || v_voucher_code || ' (dev #' || v_number || ')', v_ret, v_voucher_id);

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'store_credit_vouchers', v_voucher_id, 'voucher_issued',
      jsonb_build_object('code', v_voucher_code, 'amount', v_total, 'customer_id', v_customer,
        'expires_at', v_expires, 'allowed_branch_ids', p_allowed_branch_ids, 'return_id', v_ret));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'sale_returns', v_ret, 'return_created',
    jsonb_build_object('number', v_number, 'sale_id', p_sale_id, 'total', v_total,
      'refund', v_refund, 'reason_id', p_reason_id, 'stock_destination', v_dest));

  return jsonb_build_object(
    'return_id', v_ret, 'number', v_number, 'total', v_total,
    'refund', v_refund, 'stock_destination', v_dest,
    'voucher_code', v_voucher_code, 'voucher_expires_at', v_expires,
    'account_credited', v_acc,
    'cash_refund', case when v_refund = 'cash' then v_total - v_acc else 0 end
  );
end;
$$;

drop function if exists public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[]);
revoke all on function public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[], uuid) from public, anon;
grant execute on function public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[], uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) exchange_sale: copia exacta de 20260608490000_exchange_sale + param
--    p_cash_shift_id que se pasa a las dos patas y al sobrante en efectivo.
--    Se dropea la firma de 11 args.
-- -----------------------------------------------------------------------------
create or replace function public.exchange_sale(
  p_sale_id             uuid,
  p_return_items        jsonb,                       -- [{sale_item_id, quantity}]
  p_new_items           jsonb,                       -- ítems de la venta nueva (formato create_sale)
  p_difference_payments jsonb   default '[]'::jsonb, -- medios para la diferencia (>0): [{method, amount, reference}]
  p_reason_id           uuid    default null,        -- motivo (fija destino de stock de lo devuelto)
  p_new_discount        numeric default 0,           -- descuento global de la venta nueva
  p_customer_id         uuid    default null,        -- cliente (si la venta no tenía)
  p_allowed_branch_ids  uuid[]  default null,        -- scoping de sucursales del vale de devolución
  p_surplus_to          text    default null,        -- 'cash' | 'store_credit' (sobrante si diff<0); null = política
  p_notes               text    default null,        -- nota de la venta nueva
  p_extras              jsonb   default '[]'::jsonb,  -- señal de gating de la venta nueva (garantía/recargo)
  p_cash_shift_id       uuid    default null          -- F17 · H90: turno de la caja en uso
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_tenant    uuid := current_tenant_id();
  v_sale      record;
  v_customer  uuid;
  v_policy    text := 'cashier_choice';
  v_round     numeric := 0;
  v_role      text;
  v_max_disc  numeric := 100;
  -- Devolución (pata 1)
  v_ret_res   jsonb;
  v_returned  numeric := 0;
  v_ret_id    uuid;
  v_ret_num   bigint;
  v_voucher   text;
  -- Venta nueva (pata 2)
  v_new_subtotal numeric := 0;
  v_line_disc    numeric := 0;
  v_new_total    numeric := 0;
  v_credit_applied numeric := 0;
  v_diff_paid    numeric := 0;
  v_payments     jsonb;
  v_sale_res     jsonb;
  v_new_sale_id  uuid;
  v_new_number   bigint;
  -- Diferencia / sobrante
  v_difference numeric := 0;
  v_surplus    numeric := 0;
  v_surplus_to text;
  v_store      uuid;
  v_shift      uuid;
  v_it         record;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;

  -- La venta de origen debe existir y ser devolvible (mismo criterio que return_sale_v2).
  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;

  -- Un cambio necesita cliente: el crédito de lo devuelto se aplica a la compra
  -- nueva (y un sobrante eventual queda como saldo a favor del cliente).
  v_customer := coalesce(v_sale.customer_id, p_customer_id);
  if v_customer is null then raise exception 'exchange_needs_customer'; end if;

  -- Debe haber ítems nuevos: si no, es una devolución pura (usar return_sale_v2).
  if p_new_items is null or jsonb_array_length(p_new_items) = 0 then
    raise exception 'exchange_needs_new_items';
  end if;

  -- Política + redondeo del tenant (para dimensionar el split y el sobrante).
  select coalesce(return_policy, 'cashier_choice'), coalesce(rounding_multiple, 0)
    into v_policy, v_round
  from pos_settings where tenant_id = v_tenant;
  if not found then v_policy := 'cashier_choice'; v_round := 0; end if;

  -- Tope de descuento del rol (espeja create_sale: se valida igual adentro, pero
  -- damos un error claro y temprano si la venta nueva excede el tope).
  select role into v_role from tenant_users
   where tenant_id = v_tenant and user_id = auth.uid() and status = 'active' limit 1;
  select coalesce((max_discount ->> coalesce(v_role, 'cashier'))::numeric, 100)
    into v_max_disc from pos_settings where tenant_id = v_tenant;
  if v_max_disc is null then v_max_disc := 100; end if;

  -- ── Total de la venta NUEVA (idéntica fórmula que create_sale) ──────────────
  -- Solo para DIMENSIONAR el pago con crédito; create_sale recalcula de forma
  -- autoritativa y rechaza si los números no cierran. No se duplica validación.
  for v_it in
    select * from jsonb_to_recordset(p_new_items)
      as x(unit_price numeric, quantity numeric, discount numeric)
  loop
    v_new_subtotal := v_new_subtotal
      + (coalesce(v_it.unit_price, 0) * coalesce(v_it.quantity, 0))
      - coalesce(v_it.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_it.discount, 0);
  end loop;
  if v_new_subtotal <= 0 then raise exception 'empty_sale'; end if;
  if coalesce(p_new_discount, 0) < 0 then raise exception 'invalid_discount'; end if;
  if coalesce(p_new_discount, 0) > 0
     and (p_new_discount / v_new_subtotal * 100) > v_max_disc + 0.001 then
    raise exception 'discount_exceeds_limit';
  end if;

  v_new_total := v_new_subtotal - coalesce(p_new_discount, 0);
  if v_round > 0 then
    v_new_total := round(v_new_total / v_round) * v_round;
  end if;
  -- ────────────────────────────────────────────────────────────────────────────

  -- ── PATA 1: DEVOLUCIÓN → crédito al cliente (reuso total de return_sale_v2) ──
  -- Se fuerza 'store_credit': el valor devuelto debe quedar como crédito para
  -- aplicarlo a la compra nueva. return_sale_v2 valida cantidades/destino de
  -- stock/reingreso/auditoría y emite el vale-comprobante de la devolución.
  v_ret_res := public.return_sale_v2(
    p_sale_id            => p_sale_id,
    p_items              => p_return_items,
    p_reason_id          => p_reason_id,
    p_refund             => 'store_credit',
    p_customer_id        => v_customer,
    p_allowed_branch_ids => p_allowed_branch_ids,
    p_cash_shift_id      => p_cash_shift_id
  );
  v_returned := coalesce((v_ret_res ->> 'total')::numeric, 0);
  v_ret_id   := (v_ret_res ->> 'return_id')::uuid;
  v_ret_num  := (v_ret_res ->> 'number')::bigint;
  v_voucher  := v_ret_res ->> 'voucher_code';
  if v_returned <= 0 then raise exception 'empty_return'; end if;

  -- Crédito aplicable a la venta nueva: nunca más que su total.
  v_credit_applied := least(v_returned, v_new_total);
  v_difference := round(v_new_total - v_returned, 2);  -- >0 cobra, <0 sobra, =0 par

  -- ── PATA 2: VENTA NUEVA (reuso total de create_sale) ────────────────────────
  -- Pagos = crédito recién acreditado (medio 'store_credit', tope = total nuevo)
  -- + los medios que el cajero eligió para la diferencia. create_sale valida el
  -- saldo del ledger (que ahora incluye el crédito), lo descuenta, cobra el resto
  -- y rechaza si paid<total. NO se duplica nada del cálculo de la venta.
  v_payments := '[]'::jsonb;
  if v_credit_applied > 0 then
    v_payments := v_payments || jsonb_build_array(
      jsonb_build_object('method', 'store_credit', 'amount', v_credit_applied)
    );
  end if;
  -- Diferencia: solo se exige cobrar si la venta nueva es más cara que lo devuelto.
  if v_difference > 0.001 then
    -- Anexa los medios de la diferencia (efectivo/QR/tarjeta/…) tal cual.
    v_payments := v_payments || coalesce(p_difference_payments, '[]'::jsonb);
    select coalesce(sum((p ->> 'amount')::numeric), 0) into v_diff_paid
      from jsonb_array_elements(coalesce(p_difference_payments, '[]'::jsonb)) p;
    if v_diff_paid + v_credit_applied < v_new_total - 0.001 then
      raise exception 'insufficient_difference';
    end if;
  end if;

  v_sale_res := public.create_sale(
    p_items          => p_new_items,
    p_payments       => v_payments,
    p_discount_total => coalesce(p_new_discount, 0),
    p_customer_id    => v_customer,
    p_notes          => coalesce(p_notes, 'Cambio s/ venta #' || v_sale.number),
    p_extras         => coalesce(p_extras, '[]'::jsonb),
    p_cash_shift_id  => p_cash_shift_id
  );
  v_new_sale_id := (v_sale_res ->> 'sale_id')::uuid;
  v_new_number  := (v_sale_res ->> 'number')::bigint;
  v_new_total   := coalesce((v_sale_res ->> 'total')::numeric, v_new_total);
  -- Recalcula crédito/diferencia con el total AUTORITATIVO de create_sale.
  v_credit_applied := least(v_returned, v_new_total);
  v_difference := round(v_new_total - v_returned, 2);

  -- ── SOBRANTE (diferencia < 0): el cliente se lleva algo más barato ──────────
  -- Queda crédito sin usar = v_returned − v_new_total. Destino: efectivo (sale de
  -- caja y se debita el ledger) o vale (queda como saldo a favor, ya en el ledger
  -- desde la devolución). El caller manda p_surplus_to; si no, lo decide la política.
  v_surplus := round(v_returned - v_new_total, 2);
  if v_surplus > 0.001 then
    v_surplus_to := lower(coalesce(nullif(btrim(p_surplus_to), ''),
      case v_policy when 'always_cash' then 'cash'
                    when 'always_credit' then 'store_credit'
                    else 'store_credit' end));
    if v_surplus_to not in ('cash', 'store_credit') then
      v_surplus_to := 'store_credit';
    end if;
    -- La política manda sobre la elección del caller cuando la fija.
    if v_policy = 'always_cash' then v_surplus_to := 'cash';
    elsif v_policy = 'always_credit' then v_surplus_to := 'store_credit';
    end if;

    if v_surplus_to = 'cash' then
      -- Reintegro en efectivo del sobrante: exige caja abierta. Debita el ledger
      -- (el crédito de la devolución ya no queda como saldo, se paga en mano).
      -- F17 · H90: el efectivo sale de la caja en uso, no de la sucursal default.
      select r.o_shift_id, r.o_store_id into v_shift, v_store
        from resolve_sale_shift(p_cash_shift_id, true) r;
      if v_shift is null then raise exception 'no_open_shift'; end if;

      insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
      values (v_shift, 'expense', v_surplus, 'cash',
              'Sobrante cambio (dev #' || v_ret_num || ' → venta #' || v_new_number || ')', v_ret_id);

      insert into store_credit_movements (customer_id, delta, reason, sale_return_id)
      values (v_customer, -v_surplus,
              'Sobrante cambio devuelto en efectivo (venta #' || v_new_number || ')', v_ret_id);
    end if;
    -- Si es 'store_credit', no se hace nada: el sobrante ya vive como saldo a
    -- favor en el ledger (acreditado por la devolución), respaldado por su vale.
  end if;

  -- ── Auditoría del CAMBIO: enlaza devolución + venta nueva + diferencia ──────
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'sales', v_new_sale_id, 'exchange_created',
    jsonb_build_object(
      'origin_sale_id', p_sale_id, 'origin_sale_number', v_sale.number,
      'return_id', v_ret_id, 'return_number', v_ret_num, 'voucher_code', v_voucher,
      'new_sale_id', v_new_sale_id, 'new_sale_number', v_new_number,
      'returned', v_returned, 'new_total', v_new_total,
      'credit_applied', v_credit_applied, 'difference', v_difference,
      'difference_charged', case when v_difference > 0 then v_difference else 0 end,
      'surplus', case when v_surplus > 0 then v_surplus else 0 end,
      'surplus_to', case when v_surplus > 0.001 then v_surplus_to else null end,
      'customer_id', v_customer));

  return jsonb_build_object(
    'return_id', v_ret_id,
    'return_number', v_ret_num,
    'voucher_code', v_voucher,
    'sale_id', v_new_sale_id,
    'sale_number', v_new_number,
    'returned', v_returned,
    'new_total', v_new_total,
    'credit_applied', v_credit_applied,
    'difference', v_difference,
    'surplus', case when v_surplus > 0 then v_surplus else 0 end,
    'surplus_to', case when v_surplus > 0.001 then v_surplus_to else null end
  );
end;
$function$;

drop function if exists public.exchange_sale(uuid, jsonb, jsonb, jsonb, uuid, numeric, uuid, uuid[], text, text, jsonb);
revoke all on function public.exchange_sale(uuid, jsonb, jsonb, jsonb, uuid, numeric, uuid, uuid[], text, text, jsonb, uuid) from public, anon;
grant execute on function public.exchange_sale(uuid, jsonb, jsonb, jsonb, uuid, numeric, uuid, uuid[], text, text, jsonb, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- G) account_open_shift: turno para cobros de cuenta corriente. Para el tenant
--    del JWT usa resolve_sale_shift (no estricto); para otro tenant (llamado
--    server-side) conserva el criterio histórico. Misma firma.
-- -----------------------------------------------------------------------------
create or replace function account_open_shift(p_tenant uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift uuid;
begin
  if p_tenant is not null and p_tenant = current_tenant_id() then
    select r.o_shift_id into v_shift from resolve_sale_shift(null, false) r;
    return v_shift;
  end if;
  select cs.id into v_shift
    from cash_shifts cs
   where cs.tenant_id = p_tenant and cs.status = 'open'
     and cs.store_id = (select s.id from stores s
                         where s.tenant_id = p_tenant and s.deleted_at is null
                         order by s.is_default desc, s.created_at limit 1)
   order by cs.opened_at desc
   limit 1;
  return v_shift;
end;
$$;
revoke all on function account_open_shift(uuid) from public, anon, authenticated;
grant execute on function account_open_shift(uuid) to service_role;
