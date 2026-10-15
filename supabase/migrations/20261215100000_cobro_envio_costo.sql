-- =============================================================================
-- ADR-146 · Cliente y entrega desde la hoja de cobro.
--
-- pos_sale_create_fulfilled (ADR-136) acepta en el plan un costo de envío
-- opcional (p_plan.shipping_fee). Con al menos una entrega por envío, el
-- servidor agrega a la venta el renglón "Envío" (sin producto, cantidad 1) y
-- lo declara como recargo para create_sale, así no pasa por el permiso ni el
-- tope de la venta libre. Sin shipping_fee (o en 0) la función hace
-- exactamente lo mismo que antes. El costo queda en la auditoría
-- sale_delivery_split.
--
-- Parte de la definición vigente en producción (pg_get_functiondef al
-- 2026-10-15). create_sale no cambia. Gating igual que antes
-- (entregas_remitos, pedidos_despacho para envío, stock_sucursales y
-- depositos según el origen).
-- =============================================================================

create or replace function public.pos_sale_create_fulfilled(p_sale jsonb, p_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
declare
  v_tenant   uuid := current_tenant_id();
  v_role     text := stock_my_role();
  v_shift    uuid;
  v_store    uuid;
  v_cfg      jsonb;
  v_dels     jsonb := coalesce(p_plan -> 'deliveries', '[]'::jsonb);
  v_d        jsonb;
  v_i        jsonb;
  v_n        int;
  v_idx      int;
  v_mode     text;
  v_origin   uuid;
  v_ful      uuid;
  v_src      uuid;
  v_vid      uuid;
  v_vlabel   text;
  v_vsku     text;
  v_wh       warehouses;
  v_whid     uuid;
  v_prod     record;
  v_qty      numeric;
  v_avail    numeric;
  v_ref      uuid := gen_random_uuid();
  v_sold     jsonb;
  v_rows     jsonb := '[]'::jsonb;
  v_drows    jsonb;
  v_res      jsonb;
  v_sale     uuid;
  v_sale_no  bigint;
  v_cname    text;
  v_pickup   text;
  v_addr     text;
  v_disp     uuid;
  v_number   int;
  v_code     text;
  v_out      jsonb := '[]'::jsonb;
  v_cross    jsonb := '[]'::jsonb;
  v_local    jsonb := '[]'::jsonb;
  v_parts    int;
  v_part     int := 0;
  v_now_idx  int;
  r          record;
  -- ADR-146: costo de envío como renglón "Envío" de la venta.
  v_fee      numeric := 0;
  v_items    jsonb;
  v_extras   jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'entregas_remitos') then
    raise exception 'feature_not_in_plan: entregas_remitos' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_sale) is distinct from 'object' or jsonb_typeof(v_dels) is distinct from 'array' then
    raise exception 'invalid_plan';
  end if;
  v_n := jsonb_array_length(v_dels);
  if v_n < 1 or v_n > 10 then
    raise exception 'invalid_plan';
  end if;
  -- ADR-146: costo de envío opcional. Sólo con una entrega por envío; el
  -- renglón lo arma el servidor (el POS no lo manda como ítem).
  if nullif(btrim(coalesce(p_plan ->> 'shipping_fee', '')), '') is not null then
    begin
      v_fee := round((p_plan ->> 'shipping_fee')::numeric, 2);
    exception when others then
      raise exception 'invalid_shipping_fee';
    end;
    if v_fee is null or v_fee < 0 or v_fee > 100000000 then
      raise exception 'invalid_shipping_fee';
    end if;
    if v_fee > 0 and not exists (
      select 1 from jsonb_array_elements(v_dels) d where d ->> 'mode' = 'envio'
    ) then
      raise exception 'shipping_fee_requires_envio';
    end if;
  end if;
  if nullif(p_sale ->> 'p_table_order_id', '') is not null or nullif(p_sale ->> 'p_delivery_order_id', '') is not null
     or exists (select 1 from jsonb_array_elements(coalesce(p_sale -> 'p_extras', '[]'::jsonb)) e
                 where lower(coalesce(e ->> 'kind', '')) = 'reservation') then
    raise exception 'fulfillment_not_for_orders';
  end if;

  select r2.o_shift_id, r2.o_store_id into v_shift, v_store
    from resolve_sale_shift(nullif(p_sale ->> 'p_cash_shift_id', '')::uuid, true) r2;
  if v_store is null then
    raise exception 'no_open_shift';
  end if;
  v_cfg := pos_order_config(v_tenant);

  -- Lo vendido por producto y variante (sin servicios ni ítems libres).
  select coalesce(jsonb_agg(jsonb_build_object('product_id', s.product_id, 'variant_id', s.variant_id, 'qty', s.qty)), '[]'::jsonb)
    into v_sold
    from (
      select x.product_id, x.variant_id, sum(x.quantity) as qty
        from jsonb_to_recordset(coalesce(p_sale -> 'p_items', '[]'::jsonb)) as x(product_id uuid, variant_id uuid, quantity numeric)
        join products p on p.id = x.product_id and p.tenant_id = v_tenant and p.deleted_at is null
       where x.product_id is not null and not coalesce(p.is_service, false) and coalesce(x.quantity, 0) > 0
       group by x.product_id, x.variant_id
    ) s;

  -- Validación del plan.
  for v_idx in 0 .. v_n - 1 loop
    v_d := v_dels -> v_idx;
    v_mode := v_d ->> 'mode';
    if v_mode is null or v_mode not in ('ahora', 'retiro', 'envio') then
      raise exception 'invalid_delivery_mode';
    end if;
    if jsonb_typeof(v_d -> 'items') is distinct from 'array' or jsonb_array_length(v_d -> 'items') = 0 then
      raise exception 'delivery_empty';
    end if;
    v_origin := null;
    v_drows := '[]'::jsonb;
    for v_i in select * from jsonb_array_elements(v_d -> 'items') loop
      v_qty := nullif(v_i ->> 'qty', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'invalid_qty';
      end if;
      v_vid := nullif(v_i ->> 'variant_id', '')::uuid;
      select p.id, p.name, p.sku, coalesce(p.unit, 'un') as unit, coalesce(p.is_kit, false) as is_kit,
             coalesce(p.track_stock, true) as track, coalesce(p.is_service, false) as is_service,
             coalesce(p.has_variants, false) as has_variants
        into v_prod
        from products p
       where p.id = nullif(v_i ->> 'product_id', '')::uuid and p.tenant_id = v_tenant and p.deleted_at is null;
      if v_prod.id is null or v_prod.is_service or not exists (
        select 1 from jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid)
         where s.product_id = v_prod.id and s.variant_id is not distinct from v_vid
      ) then
        raise exception 'delivery_item_not_in_sale';
      end if;
      if v_prod.has_variants and v_vid is null then
        raise exception 'variant_required';
      end if;
      v_src := coalesce(nullif(v_i ->> 'source_store_id', '')::uuid, v_store);
      if v_origin is null then
        v_origin := v_src;
      elsif v_origin <> v_src then
        raise exception 'delivery_mixed_origin';
      end if;

      v_whid := null;
      if nullif(v_i ->> 'source_warehouse_id', '') is not null then
        select * into v_wh from warehouses w
         where w.id = (v_i ->> 'source_warehouse_id')::uuid and w.tenant_id = v_tenant and w.deleted_at is null;
        if v_wh.id is null or v_wh.store_id <> v_src then
          raise exception 'source_not_available';
        end if;
        if not v_wh.sellable then
          raise exception 'source_not_sellable';
        end if;
        -- El salón propio no se mueve: lo descuenta create_sale.
        if not (v_wh.kind = 'principal' and v_src = v_store) then
          v_whid := v_wh.id;
        end if;
      end if;

      if v_src <> v_store then
        if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
          raise exception 'feature_not_in_plan: stock_sucursales' using errcode = 'check_violation';
        end if;
        if not tenant_has_feature_for(v_tenant, 'depositos') then
          raise exception 'feature_not_in_plan: depositos' using errcode = 'check_violation';
        end if;
        if v_prod.is_kit or not v_prod.track then
          raise exception 'kit_cross_store';
        end if;
        if v_whid is null then
          select w.id into v_whid from warehouses w
           where w.store_id = v_src and w.kind = 'principal' and w.deleted_at is null;
        end if;
        if v_whid is null or not exists (
          select 1 from warehouse_store_links l
           where l.warehouse_id = v_whid and l.store_id = v_store and l.deleted_at is null
        ) or not exists (select 1 from warehouses w where w.id = v_whid and w.sellable) then
          raise exception 'source_not_available';
        end if;
      elsif v_whid is not null then
        if not tenant_has_feature_for(v_tenant, 'depositos') then
          raise exception 'feature_not_in_plan: depositos' using errcode = 'check_violation';
        end if;
        if v_prod.is_kit or not v_prod.track then
          raise exception 'kit_cross_store';
        end if;
      end if;

      v_vlabel := null;
      v_vsku := null;
      if v_vid is not null then
        select v.option1 || coalesce(' / ' || v.option2, ''), v.sku into v_vlabel, v_vsku
          from product_variants v where v.id = v_vid and v.product_id = v_prod.id;
      end if;
      v_drows := v_drows || jsonb_build_array(jsonb_build_object(
        'd', v_idx, 'mode', v_mode, 'origin', v_src, 'product_id', v_prod.id, 'variant_id', v_vid,
        'qty', v_qty, 'src_store', v_src, 'src_wh', v_whid, 'name', v_prod.name,
        'variant_label', v_vlabel, 'sku', coalesce(v_vsku, v_prod.sku), 'unit', v_prod.unit));
    end loop;

    -- Modalidad y lugar de entrega.
    if v_mode = 'ahora' then
      if v_origin <> v_store then
        raise exception 'ahora_requires_local';
      end if;
      v_ful := v_store;
      v_now_idx := v_idx;
    else
      if not tenant_has_feature_for(v_tenant, 'pedidos_despacho') then
        raise exception 'feature_not_in_plan: pedidos_despacho' using errcode = 'check_violation';
      end if;
      if not coalesce((v_cfg -> 'delivery_types' -> v_mode ->> 'enabled')::boolean, false) then
        raise exception 'delivery_type_disabled: %', v_mode;
      end if;
      if v_mode = 'envio' then
        v_ful := v_origin;
        if char_length(btrim(coalesce(v_d ->> 'ship_address', ''))) < 5 then
          raise exception 'ship_address_required';
        end if;
      else
        v_ful := coalesce(nullif(v_d ->> 'fulfillment_store_id', '')::uuid, v_origin);
        if not exists (select 1 from stores s where s.id = v_ful and s.tenant_id = v_tenant and s.deleted_at is null) then
          raise exception 'store_not_found';
        end if;
        if v_ful <> v_origin and not coalesce((v_cfg -> 'delivery_types' -> 'retiro' ->> 'cross_branch')::boolean, false) then
          raise exception 'cross_branch_not_allowed: retiro';
        end if;
      end if;
    end if;
    v_rows := v_rows || (select jsonb_agg(x || jsonb_build_object('ful', v_ful)) from jsonb_array_elements(v_drows) x);
  end loop;

  -- La suma por producto no supera lo vendido.
  if exists (
    select 1
      from (select fp.product_id, fp.variant_id, sum(fp.qty) as q
              from jsonb_to_recordset(v_rows) as fp(product_id uuid, variant_id uuid, qty numeric)
             group by 1, 2) p
      left join jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid, qty numeric)
        on s.product_id = p.product_id and s.variant_id is not distinct from p.variant_id
     where p.q > coalesce(s.qty, 0)
  ) then
    raise exception 'delivery_qty_mismatch';
  end if;

  -- Lo no asignado: parte "retira ahora" desde la sucursal de la venta.
  select coalesce(jsonb_agg(jsonb_build_object(
           'mode', 'ahora', 'origin', v_store, 'ful', v_store, 'product_id', s.product_id, 'variant_id', s.variant_id,
           'qty', s.qty - coalesce(a.q, 0), 'src_store', v_store, 'src_wh', null, 'name', pr.name,
           'variant_label', v.option1 || coalesce(' / ' || v.option2, ''), 'sku', coalesce(v.sku, pr.sku),
           'unit', coalesce(pr.unit, 'un'))), '[]'::jsonb)
    into v_drows
    from jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid, qty numeric)
    join products pr on pr.id = s.product_id
    left join product_variants v on v.id = s.variant_id
    left join (select fp.product_id, fp.variant_id, sum(fp.qty) as q
                 from jsonb_to_recordset(v_rows) as fp(product_id uuid, variant_id uuid, qty numeric)
                group by 1, 2) a on a.product_id = s.product_id and a.variant_id is not distinct from s.variant_id
   where s.qty > coalesce(a.q, 0);
  if jsonb_array_length(v_drows) > 0 then
    if v_now_idx is null then
      v_now_idx := v_n;
    end if;
    v_rows := v_rows || (select jsonb_agg(x || jsonb_build_object('d', v_now_idx)) from jsonb_array_elements(v_drows) x);
  end if;

  -- Mover el stock de los orígenes al salón de la sucursal de la venta. Orden
  -- fijo (sucursal, depósito, producto) para no cruzar locks con otra venta.
  for r in
    select fp.src_store, fp.src_wh, fp.product_id, fp.variant_id, sum(fp.qty) as qty, min(fp.name) as name
      from jsonb_to_recordset(v_rows) as fp(src_store uuid, src_wh uuid, product_id uuid, variant_id uuid, qty numeric, name text)
     where fp.src_store <> v_store or fp.src_wh is not null
     group by fp.src_store, fp.src_wh, fp.product_id, fp.variant_id
     order by fp.src_store, fp.src_wh nulls first, fp.product_id, fp.variant_id nulls first
  loop
    perform pg_advisory_xact_lock(hashtext('stock_reservation:' || r.src_store::text));
    if exists (select 1 from warehouses w where w.id = r.src_wh and w.kind <> 'principal') then
      select ws.qty into v_avail from warehouse_stock ws
       where ws.warehouse_id = r.src_wh and ws.product_id = r.product_id
         and ws.variant_id is not distinct from r.variant_id
       for update;
      if coalesce(v_avail, 0) < r.qty then
        raise exception 'insufficient_source_stock: %', r.name;
      end if;
      update warehouse_stock set qty = qty - r.qty
       where warehouse_id = r.src_wh and product_id = r.product_id and variant_id is not distinct from r.variant_id;
    else
      -- Salón de otra sucursal: sin lo reservado.
      perform 1 from product_stock ps
        where ps.store_id = r.src_store and ps.product_id = r.product_id and ps.variant_id is not distinct from r.variant_id
        for update;
      v_avail := warehouse_principal_qty(r.src_store, r.product_id, r.variant_id)
                 - stock_reserved_qty(r.src_store, r.product_id, r.variant_id, null);
      if v_avail < r.qty then
        raise exception 'insufficient_source_stock: %', r.name;
      end if;
    end if;
    if r.src_store <> v_store then
      perform transfer_move_stock(v_tenant, r.src_store, r.product_id, r.variant_id, -r.qty, 'transfer_out', v_ref,
                                  'Venta en otra sucursal (ADR-136)');
      perform transfer_move_stock(v_tenant, v_store, r.product_id, r.variant_id, r.qty, 'transfer_in', v_ref,
                                  'Venta de stock de otra sucursal (ADR-136)');
      v_cross := v_cross || jsonb_build_array(jsonb_build_object(
        'product_id', r.product_id, 'variant_id', r.variant_id, 'qty', r.qty,
        'store_id', r.src_store, 'warehouse_id', r.src_wh));
    else
      v_local := v_local || jsonb_build_array(jsonb_build_object(
        'product_id', r.product_id, 'variant_id', r.variant_id, 'qty', r.qty, 'warehouse_id', r.src_wh));
    end if;
  end loop;

  -- ADR-146: el envío entra como renglón sin producto al final. Para
  -- create_sale es un monto con explicación (recargo), no una venta libre:
  -- no pide el permiso de venta libre ni su tope.
  v_items  := coalesce(p_sale -> 'p_items', '[]'::jsonb);
  v_extras := coalesce(p_sale -> 'p_extras', '[]'::jsonb);
  if v_fee > 0 then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', null, 'name', 'Envío', 'quantity', 1, 'unit_price', v_fee, 'discount', 0));
    v_extras := v_extras || jsonb_build_array(jsonb_build_object('kind', 'surcharge', 'amount', v_fee));
  end if;

  -- La venta, igual que siempre.
  v_res := create_sale(
    p_items           => v_items,
    p_payments        => coalesce(p_sale -> 'p_payments', '[]'::jsonb),
    p_discount_total  => coalesce(nullif(p_sale ->> 'p_discount_total', '')::numeric, 0),
    p_customer_id     => nullif(p_sale ->> 'p_customer_id', '')::uuid,
    p_notes           => p_sale ->> 'p_notes',
    p_extras          => v_extras,
    p_promo_discount  => coalesce(nullif(p_sale ->> 'p_promo_discount', '')::numeric, 0),
    p_promo_id        => nullif(p_sale ->> 'p_promo_id', '')::uuid,
    p_promo_name      => p_sale ->> 'p_promo_name',
    p_coupon_id       => nullif(p_sale ->> 'p_coupon_id', '')::uuid,
    p_cash_shift_id   => v_shift,
    p_service         => case when jsonb_typeof(p_sale -> 'p_service') = 'object' then p_sale -> 'p_service' end
  );
  v_sale := (v_res ->> 'sale_id')::uuid;
  select s.number, c.name into v_sale_no, v_cname
    from sales s left join customers c on c.id = s.customer_id
   where s.id = v_sale;

  -- Una entrega por parte; la de "ahora" primero.
  select count(distinct fp.d) into v_parts from jsonb_to_recordset(v_rows) as fp(d int);
  for r in
    select fp.d, min(fp.mode) as mode, min(fp.origin::text)::uuid as origin, min(fp.ful::text)::uuid as ful
      from jsonb_to_recordset(v_rows) as fp(d int, mode text, origin uuid, ful uuid)
     group by fp.d
     order by (min(fp.mode) = 'ahora') desc, fp.d
  loop
    v_part := v_part + 1;
    v_d := case when r.d < jsonb_array_length(v_dels) then v_dels -> r.d else '{}'::jsonb end;
    v_pickup := left(nullif(btrim(coalesce(v_d ->> 'pickup_name', '')), ''), 120);
    v_addr := left(nullif(btrim(coalesce(v_d ->> 'ship_address', '')), ''), 300);
    if r.mode = 'retiro' then
      v_pickup := coalesce(v_pickup, v_cname);
      if v_pickup is null then
        raise exception 'pickup_name_required';
      end if;
    end if;
    perform pg_advisory_xact_lock(hashtext('dispatch_number:' || v_tenant::text));
    select coalesce(max(number), 0) + 1 into v_number from dispatches where tenant_id = v_tenant;
    insert into dispatches (
      tenant_id, number, sale_id, store_id, fulfillment_store_id, sale_store_id, delivery_type, status,
      customer_name, pickup_name, ship_address, notes, part, parts_total, fulfillment_id, created_by,
      delivered_by, delivered_at, delivered_to
    ) values (
      v_tenant, v_number, v_sale, r.origin, r.ful, v_store,
      case r.mode when 'ahora' then 'inmediato' else r.mode end,
      case when r.mode = 'ahora' then 'entregado' else 'pendiente' end,
      left(coalesce(v_cname, v_pickup), 120), v_pickup, case when r.mode = 'envio' then v_addr end,
      left(nullif(btrim(coalesce(v_d ->> 'notes', '')), ''), 500), v_part, v_parts, v_ref, auth.uid(),
      case when r.mode = 'ahora' then auth.uid() end,
      case when r.mode = 'ahora' then now() end,
      case when r.mode = 'ahora' then left(coalesce(v_cname, 'Cliente en el mostrador'), 120) end
    )
    returning id into v_disp;

    insert into dispatch_items (
      tenant_id, dispatch_id, sale_id, store_id, fulfillment_store_id, sale_store_id, product_id, variant_id,
      product_name, variant_label, sku, unit, qty, source_store_id, source_warehouse_id, sort
    )
    select v_tenant, v_disp, v_sale, r.origin, r.ful, v_store, fp.product_id, fp.variant_id,
           fp.name, fp.variant_label, fp.sku, fp.unit, sum(fp.qty), fp.src_store, fp.src_wh,
           (row_number() over (order by fp.name, fp.variant_label))::int
      from jsonb_to_recordset(v_rows) as fp(d int, product_id uuid, variant_id uuid, name text, variant_label text,
                                            sku text, unit text, qty numeric, src_store uuid, src_wh uuid)
     where fp.d = r.d
     group by fp.product_id, fp.variant_id, fp.name, fp.variant_label, fp.sku, fp.unit, fp.src_store, fp.src_wh;

    v_code := null;
    if r.mode = 'retiro' and coalesce((v_cfg -> 'delivery_types' -> 'retiro' ->> 'pickup_code')::boolean, false) then
      v_code := otp_random_digits(6);
      update dispatches set pickup_code_hash = stock_reservation_code_hash(v_disp, v_code) where id = v_disp;
    end if;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'dispatches', v_disp, 'dispatch_created',
            jsonb_build_object('number', v_number, 'sale_id', v_sale, 'delivery_type', r.mode,
                               'part', v_part, 'parts_total', v_parts, 'origin_store_id', r.origin,
                               'fulfillment_store_id', r.ful, 'fulfillment_id', v_ref),
            r.origin);

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_disp, 'number', v_number, 'part', v_part, 'mode', r.mode,
      'origin_store_id', r.origin, 'fulfillment_store_id', r.ful, 'pickup_code', v_code));
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_delivery_split',
          jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'parts', v_parts, 'shipping_fee', v_fee,
                             'deliveries', (select jsonb_agg(x - 'pickup_code') from jsonb_array_elements(v_out) x)),
          v_store);
  if jsonb_array_length(v_cross) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_cross_store',
            jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'lines', v_cross), v_store);
  end if;
  if jsonb_array_length(v_local) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_from_warehouse',
            jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'lines', v_local), v_store);
  end if;

  return v_res || jsonb_build_object('deliveries', v_out, 'fulfillment_id', v_ref);
end;
$$;

revoke all on function public.pos_sale_create_fulfilled(jsonb, jsonb) from public, anon;
grant execute on function public.pos_sale_create_fulfilled(jsonb, jsonb) to authenticated;

comment on function public.pos_sale_create_fulfilled(jsonb, jsonb) is
  'Venta con reparto de entregas (ADR-136) y costo de envío opcional como renglón (ADR-146), en una transacción.';
