-- =============================================================================
-- ADR-141 sobre ADR-142: ml_ingest_pack con el plan de factura y con Full
-- =============================================================================
-- 20261208100200_ml_facturacion recreaba ml_ingest_pack desde la definición
-- de 20261110400200; entre medio, ADR-142 (20261209100100_mercadolibre_full,
-- ya aplicada) la recreó con el bloque de Full. Aplicar la de facturación
-- tal cual borraba ese bloque. Esta migración recrea la función una sola vez
-- con los dos bloques, sobre la versión vigente (la de Full):
--   * ADR-142: las líneas despachadas por Full no descuentan el stock propio
--     (applied = false) y descuentan el depósito Full si el negocio tiene la
--     feature (_ml_full_sale_apply); las líneas guardan full y
--     full_inventory_id; el audit suma full_lines.
--   * ADR-141: con la facturación pro y p.invoice (MlInvoicePlan), renglones
--     a su precio (cupón prorrateado si es la regla), renglón de envío si lo
--     pagó el comprador, descuento del cupón, receptor del plan, plan guardado
--     (_ml_plan_store) y facturación automática (_ml_invoice_auto); sin plan,
--     igual que ADR-104. Pagos, cupón y envío pagado en ml_orders.
-- Requiere 20261208100200_ml_facturacion (tablas, columnas y helpers) y
-- 20261209100100_mercadolibre_full (_ml_full_sale_apply).
-- =============================================================================

-- p: PackPayload (orders.ts) + invoice (MlInvoicePlan, invoicePlan.ts) cuando
-- la cuenta tiene la facturación pro. Devuelve {ok, decision, sale_id, number}.
create or replace function ml_ingest_pack(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc        ml_accounts%rowtype;
  v_tenant     uuid;
  v_pack       text := nullif(btrim(coalesce(p ->> 'pack_key', '')), '');
  v_o          jsonb;
  v_l          jsonb;
  v_all_paid   boolean;
  v_all_cancel boolean;
  v_any_cancel boolean;
  v_fraud      boolean;
  v_sale       uuid;
  v_sale_row   sales%rowtype;
  v_map        ml_location_map%rowtype;
  v_store      uuid;
  v_bill       jsonb := case when jsonb_typeof(p -> 'billing') = 'object' then p -> 'billing' end;
  v_doc        text;
  v_customer   uuid;
  v_lines      jsonb := '[]'::jsonb;
  v_lp         uuid;
  v_lv         uuid;
  v_tax_in     jsonb := '[]'::jsonb;
  v_tax        jsonb;
  v_tl         jsonb;
  v_total      numeric := 0;
  v_gross      numeric;
  v_number     bigint;
  v_i          int := 0;
  v_pname      text;
  v_psku       text;
  v_track      boolean;
  v_taken      numeric;
  v_fiscal     uuid;
  v_decision   text;
  v_ord        record;
  v_reverted   int := 0;
  v_unlinked   int;
  -- ADR-141
  v_plan       jsonb := case when jsonb_typeof(p -> 'invoice') = 'object'
                              and tenant_has_feature_for((select a.tenant_id from ml_accounts a where a.id = p_account),
                                                         'mercadolibre_facturacion')
                             then p -> 'invoice' end;
  v_items      jsonb := '[]'::jsonb;
  v_used       boolean[] := '{}';
  v_k          int;
  v_ship       numeric := 0;
  v_ship_label text;
  v_discount   numeric := 0;
  v_subtotal   numeric := 0;
  v_prow       ml_invoice_plans%rowtype;
  v_auto       jsonb;
  -- ADR-142: ventas por Full (las despacha ML desde su centro).
  v_full_pack  boolean := coalesce(p -> 'shipment' ->> 'logistic_type', '') = 'fulfillment';
  v_has_ship   boolean := jsonb_typeof(p -> 'shipment') = 'object';
  v_line_full  boolean;
  v_full_inv   text;
  v_full_lines int := 0;
  v_full_feat  boolean;
begin
  if v_pack is null or jsonb_typeof(p -> 'orders') <> 'array' or jsonb_array_length(p -> 'orders') = 0 then
    raise exception 'invalid_payload';
  end if;
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  v_tenant := v_acc.tenant_id;
  if not tenant_has_feature_for(v_tenant, 'mercadolibre') then
    return jsonb_build_object('ok', false, 'error', 'feature_not_in_plan');
  end if;
  -- Dos notificaciones del mismo carrito no crean dos ventas.
  perform pg_advisory_xact_lock(hashtext('ml_pack:' || p_account::text || ':' || v_pack));

  -- 1) Espejo de cada orden (no pisa con un estado más viejo).
  for v_o in select value from jsonb_array_elements(p -> 'orders') loop
    insert into ml_orders (tenant_id, account_id, ml_order_id, pack_key, pack_id, status, status_detail, tags,
                           date_created, date_closed, ml_last_updated, total_amount, paid_amount, currency,
                           sale_fee_total, buyer_id, buyer_nickname, shipment_id, fraud_risk, cancel_detail, lines,
                           payments, coupon_amount, shipping_paid)
    values (v_tenant, p_account, (v_o ->> 'ml_order_id')::bigint, v_pack, nullif(p ->> 'pack_id', '')::bigint,
            left(coalesce(v_o ->> 'status', 'unknown'), 40), left(v_o ->> 'status_detail', 200),
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_o -> 'tags', '[]'::jsonb)) x), '{}'),
            nullif(v_o ->> 'date_created', '')::timestamptz, nullif(v_o ->> 'date_closed', '')::timestamptz,
            nullif(v_o ->> 'last_updated', '')::timestamptz,
            coalesce((v_o ->> 'total_amount')::numeric, 0), coalesce((v_o ->> 'paid_amount')::numeric, 0),
            coalesce(nullif(v_o ->> 'currency', ''), 'ARS'), coalesce((v_o ->> 'sale_fee_total')::numeric, 0),
            nullif(v_o -> 'buyer' ->> 'id', '')::bigint, left(v_o -> 'buyer' ->> 'nickname', 120),
            nullif(v_o ->> 'shipment_id', '')::bigint, coalesce((v_o ->> 'fraud_risk')::boolean, false),
            case when jsonb_typeof(v_o -> 'cancel_detail') = 'object' then v_o -> 'cancel_detail' end,
            coalesce(v_o -> 'lines', '[]'::jsonb),
            case when jsonb_typeof(v_o -> 'payments') = 'array' then v_o -> 'payments' else '[]'::jsonb end,
            coalesce((v_o ->> 'coupon_amount')::numeric, 0), coalesce((v_o ->> 'shipping_paid')::numeric, 0))
    on conflict (account_id, ml_order_id) do update
      set status = excluded.status, status_detail = excluded.status_detail, tags = excluded.tags,
          date_closed = excluded.date_closed, ml_last_updated = excluded.ml_last_updated,
          total_amount = excluded.total_amount, paid_amount = excluded.paid_amount,
          sale_fee_total = excluded.sale_fee_total, shipment_id = coalesce(excluded.shipment_id, ml_orders.shipment_id),
          fraud_risk = excluded.fraud_risk, cancel_detail = excluded.cancel_detail,
          pack_key = excluded.pack_key, pack_id = excluded.pack_id,
          payments = excluded.payments, coupon_amount = excluded.coupon_amount, shipping_paid = excluded.shipping_paid,
          -- Las líneas resueltas (producto, stock aplicado) no se pisan después de la venta.
          lines = case when ml_orders.sale_id is null then excluded.lines else ml_orders.lines end
      where ml_orders.ml_last_updated is null or excluded.ml_last_updated is null
         or excluded.ml_last_updated >= ml_orders.ml_last_updated;
  end loop;

  -- Costo de envío (si vino el envío normalizado).
  if jsonb_typeof(p -> 'shipment') = 'object' and nullif(p -> 'shipment' ->> 'cost', '') is not null then
    update ml_orders set shipping_cost = (p -> 'shipment' ->> 'cost')::numeric
     where account_id = p_account and pack_key = v_pack;
  end if;

  -- 2) Estado del carrito completo.
  select bool_and(o.status = 'paid'), bool_and(o.status in ('cancelled', 'invalid')),
         bool_or(o.status in ('cancelled', 'invalid')), bool_or(o.fraud_risk), max(o.sale_id::text)::uuid
    into v_all_paid, v_all_cancel, v_any_cancel, v_fraud, v_sale
    from ml_orders o
   where o.account_id = p_account and o.pack_key = v_pack;

  -- 2.a) Fraude sin venta: no se crea (ML la cancela; no despachar).
  if v_fraud and v_sale is null then
    update ml_orders set needs_review = 'Mercado Libre detectó riesgo de fraude: no despachar.'
     where account_id = p_account and pack_key = v_pack;
    return jsonb_build_object('ok', true, 'decision', 'fraud');
  end if;
  if v_fraud then
    update ml_orders set needs_review = 'Mercado Libre detectó riesgo de fraude después del pago: no despachar; se anula si ML la cancela.'
     where account_id = p_account and pack_key = v_pack and needs_review is null;
  end if;

  -- 2.b) Cancelaciones: revierte el stock de cada orden cancelada.
  if v_any_cancel then
    for v_ord in
      select o.id from ml_orders o
       where o.account_id = p_account and o.pack_key = v_pack and o.status in ('cancelled', 'invalid')
    loop
      if _ml_order_revert(v_ord.id) then v_reverted := v_reverted + 1; end if;
    end loop;
    if v_all_cancel then
      if v_sale is not null then
        -- Anular la venta: si estaba facturada, ARCA emite la nota de crédito
        -- por el total (arca_on_void); si no, el comprobante se cancela.
        update sales
           set status = 'voided', voided_at = now(), void_reason = 'Cancelada en Mercado Libre'
         where id = v_sale and tenant_id = v_tenant and status = 'completed';
        if found then
          insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
          values (v_tenant, null, 'sales', v_sale, 'ml_sale_cancelled',
                  jsonb_build_object('pack_key', v_pack, 'reverted_orders', v_reverted));
        end if;
      end if;
      -- ADR-141: el plan sin emitir se cancela y el link de percepción también.
      update ml_invoice_plans set status = 'cancelled'
       where account_id = p_account and pack_key = v_pack and fiscal_document_id is null
         and status in ('ready', 'hold_perception', 'needs_review', 'blocked', 'error');
      update ml_perception_charges set status = 'cancelled'
       where account_id = p_account and pack_key = v_pack and status = 'link_sent';
      update ml_orders set needs_review = null
       where account_id = p_account and pack_key = v_pack and needs_review like 'Carrito%';
      return jsonb_build_object('ok', true, 'decision', 'cancel', 'sale_id', v_sale, 'reverted', v_reverted);
    end if;
    update ml_orders set needs_review = 'Carrito con órdenes canceladas y otras no: revisá la venta (devolución parcial).'
     where account_id = p_account and pack_key = v_pack and needs_review is null;
    if v_reverted > 0 then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, null, 'sales', v_sale, 'ml_order_partial_cancel',
              jsonb_build_object('pack_key', v_pack, 'reverted_orders', v_reverted));
    end if;
    return jsonb_build_object('ok', true, 'decision', 'partial_cancel', 'sale_id', v_sale, 'reverted', v_reverted);
  end if;

  if v_sale is not null then
    -- ADR-141: venta existente sin plan (o con plan sin emitir): se guarda el plan nuevo.
    if v_plan is not null then
      v_prow := _ml_plan_store(p_account, v_pack, v_sale, v_plan, null);
      perform _ml_orders_status_from_plan(v_prow.id);
    end if;
    return jsonb_build_object('ok', true, 'decision', 'noop', 'sale_id', v_sale);
  end if;
  if not coalesce(v_all_paid, false) then
    return jsonb_build_object('ok', true, 'decision', 'wait_payment');
  end if;

  -- 3) Crear la venta.
  perform assert_account_active(v_tenant);
  select * into v_map from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  v_store := coalesce(v_map.store_id, stock_default_store(v_tenant));
  if v_store is null then raise exception 'no_store'; end if;
  if v_map.warehouse_id is not null and not exists (
       select 1 from warehouses w where w.id = v_map.warehouse_id and w.store_id = v_store and w.deleted_at is null) then
    v_map.warehouse_id := null;
  end if;

  -- Cliente desde los datos de facturación (o consumidor final).
  if v_bill is not null then
    v_doc := nullif(regexp_replace(coalesce(v_bill ->> 'docNumber', ''), '\D', '', 'g'), '');
    if v_doc is not null then
      select c.id into v_customer from customers c
       where c.tenant_id = v_tenant and c.deleted_at is null
         and regexp_replace(coalesce(c.document_number, ''), '\D', '', 'g') = v_doc
       order by c.created_at limit 1;
      if v_customer is null then
        insert into customers (tenant_id, name, document_type, document_number, iva_condition, address, metadata)
        values (v_tenant,
                left(coalesce(nullif(v_plan -> 'receptors' -> 'billing' ->> 'name', ''), nullif(v_bill ->> 'name', ''),
                              'Comprador de Mercado Libre'), 200),
                case when v_bill ->> 'docType' in ('cuit', 'cuil', 'dni', 'passport', 'other') then v_bill ->> 'docType' else 'other' end,
                v_doc,
                case when coalesce(v_plan -> 'receptors' -> 'billing' ->> 'iva_condition', v_bill ->> 'ivaCondition')
                          in ('consumidor_final', 'responsable_inscripto', 'monotributo',
                              'monotributo_social', 'exento', 'no_alcanzado', 'no_categorizado')
                     then coalesce(v_plan -> 'receptors' -> 'billing' ->> 'iva_condition', v_bill ->> 'ivaCondition')
                     else 'consumidor_final' end,
                left(coalesce(nullif(v_plan -> 'receptors' -> 'billing' ->> 'address', ''), v_bill ->> 'address'), 300),
                jsonb_build_object('source', 'mercadolibre', 'ml_account_id', p_account,
                                   'taxpayer_type', v_bill ->> 'taxpayerRaw'))
        returning id into v_customer;
      end if;
    end if;
  end if;

  -- ADR-141: renglones del plan (precio con el cupón prorrateado si es la regla).
  if v_plan is not null and jsonb_typeof(v_plan -> 'items') = 'array' then
    v_items := v_plan -> 'items';
    for v_k in 0 .. jsonb_array_length(v_items) - 1 loop v_used[v_k + 1] := false; end loop;
  end if;

  -- Líneas: publicación (y variación) vinculada -> producto/variante del POS.
  for v_ord in
    select o.id, o.ml_order_id, o.lines from ml_orders o
     where o.account_id = p_account and o.pack_key = v_pack order by o.ml_order_id
  loop
    for v_l in select value from jsonb_array_elements(v_ord.lines) loop
      v_lp := null; v_lv := null;
      select l.product_id, l.variant_id into v_lp, v_lv
        from ml_item_links l
        join ml_items i on i.id = l.item_id
       where i.account_id = p_account and i.ml_item_id = v_l ->> 'ml_item_id'
         and (l.ml_variation_id is null or l.ml_variation_id::text = coalesce(v_l ->> 'ml_variation_id', ''))
       order by (l.ml_variation_id is null)
       limit 1;
      v_gross := round(coalesce((v_l ->> 'unit_price')::numeric, 0) * coalesce((v_l ->> 'quantity')::numeric, 0), 2);
      if jsonb_array_length(v_items) > 0 then
        -- El renglón del plan de la misma orden, publicación y variación.
        for v_k in 0 .. jsonb_array_length(v_items) - 1 loop
          if not v_used[v_k + 1]
             and v_items -> v_k ->> 'ml_order_id' = v_ord.ml_order_id::text
             and v_items -> v_k ->> 'ml_item_id' = v_l ->> 'ml_item_id'
             and coalesce(v_items -> v_k ->> 'ml_variation_id', '') = coalesce(v_l ->> 'ml_variation_id', '') then
            v_used[v_k + 1] := true;
            v_gross := (v_items -> v_k ->> 'gross')::numeric;
            v_l := v_l || jsonb_build_object('unit_price', (v_items -> v_k ->> 'unit_price')::numeric,
                                             'list_unit_price', (v_items -> v_k ->> 'list_unit_price')::numeric);
            exit;
          end if;
        end loop;
      end if;
      v_total := v_total + v_gross;
      v_lines := v_lines || jsonb_build_array(v_l || jsonb_build_object(
        'order_row', v_ord.id, 'product_id', v_lp, 'variant_id', v_lv, 'gross', v_gross));
      v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object(
        'product_id', v_lp, 'variant_id', v_lv,
        'quantity', coalesce((v_l ->> 'quantity')::numeric, 0), 'gross', v_gross));
    end loop;
  end loop;
  if v_total <= 0 then raise exception 'empty_sale'; end if;

  -- ADR-141: envío que pagó el comprador (renglón) y cupón (descuento).
  v_subtotal := v_total;
  if v_plan is not null then
    if coalesce((v_plan -> 'shipping' ->> 'line')::boolean, false) and coalesce((v_plan -> 'shipping' ->> 'amount')::numeric, 0) > 0 then
      v_ship := round((v_plan -> 'shipping' ->> 'amount')::numeric, 2);
      v_ship_label := left(coalesce(nullif(v_plan -> 'shipping' ->> 'label', ''), 'Envío'), 120);
      v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object(
        'product_id', null, 'variant_id', null, 'quantity', 1, 'gross', v_ship));
      v_subtotal := v_subtotal + v_ship;
    end if;
    v_discount := least(greatest(coalesce((v_plan -> 'coupon' ->> 'discount')::numeric, 0), 0), v_total);
    v_total := round(v_subtotal - v_discount, 2);
  end if;

  -- Desglose fiscal (letra según emisor y receptor). La venta de ML no lleva
  -- percepciones al crearse: el precio lo fijó ML y ya está cobrado (ADR-141:
  -- si corresponden, se cobran por link y se suman al emitir).
  v_tax := _sale_tax_compute(v_tenant, v_customer, v_tax_in, v_total, now());

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from sales where tenant_id = v_tenant;

  insert into sales (tenant_id, store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes, channel, channel_ref,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total, created_by)
  values (v_tenant, v_store, null, v_customer, v_number, 'completed',
          v_subtotal, v_discount,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0),
          v_total, left('Mercado Libre ' || case when nullif(p ->> 'pack_id', '') is not null then 'carrito ' else 'orden ' end || v_pack, 200),
          'mercadolibre', v_pack,
          v_tax ->> 'letter',
          jsonb_build_object('emitter', v_tax -> 'emitter', 'receptor', v_tax -> 'receptor',
                             'requires_identification', v_tax -> 'requires_identification',
                             'warnings', v_tax -> 'warnings'),
          coalesce((v_tax ->> 'net_taxed')::numeric, 0), coalesce((v_tax ->> 'net_exempt')::numeric, 0),
          coalesce((v_tax ->> 'net_untaxed')::numeric, 0), coalesce((v_tax ->> 'iva_total')::numeric, 0),
          coalesce((v_tax ->> 'internal_total')::numeric, 0), 0, null)
  returning * into v_sale_row;
  v_sale := v_sale_row.id;

  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, rate_code, rate, base, amount, arca_id, source)
  select v_tenant, v_sale, 'iva', 'iva', x.code, x.rate, x.base, x.amount, x.arca_id, 'product'
    from jsonb_to_recordset(coalesce(v_tax -> 'iva', '[]'::jsonb))
      as x(code text, rate numeric, base numeric, amount numeric, arca_id int);
  if coalesce((v_tax ->> 'internal_total')::numeric, 0) > 0 then
    insert into sale_tax_lines (tenant_id, sale_id, kind, tax, base, amount, arca_id, source, name)
    values (v_tenant, v_sale, 'internos', 'internos', coalesce((v_tax ->> 'internal_base')::numeric, 0),
            (v_tax ->> 'internal_total')::numeric, 4, 'product', 'Impuestos internos');
  end if;

  -- Renglones y stock (una sola vez; la cancelación revierte lo mismo).
  for v_i in 0 .. jsonb_array_length(v_lines) - 1 loop
    v_l := v_lines -> v_i;
    v_tl := v_tax -> 'lines' -> v_i;
    v_pname := null; v_psku := null; v_track := false; v_taken := 0; v_full_inv := null;
    if nullif(v_l ->> 'product_id', '') is not null then
      select p2.name, p2.sku, coalesce(p2.track_stock, true) and not coalesce(p2.is_kit, false)
        into v_pname, v_psku, v_track
        from products p2 where p2.id = (v_l ->> 'product_id')::uuid and p2.tenant_id = v_tenant;
      if nullif(v_l ->> 'variant_id', '') is not null then
        select v_pname || ' · ' || v.option1 || coalesce(' / ' || v.option2, ''), coalesce(v.sku, v_psku)
          into v_pname, v_psku
          from product_variants v where v.id = (v_l ->> 'variant_id')::uuid and v.tenant_id = v_tenant;
      end if;
    end if;
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale, nullif(v_l ->> 'product_id', '')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
            left(coalesce(v_pname, v_l ->> 'title', 'Publicación de Mercado Libre'), 250),
            coalesce(v_psku, nullif(v_l ->> 'seller_sku', '')), null,
            (v_l ->> 'quantity')::numeric, (v_l ->> 'unit_price')::numeric, 0, (v_l ->> 'gross')::numeric, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
    -- ADR-142: una línea despachada por Full no sale del stock propio (nunca
    -- estuvo en el mostrador); descuenta el depósito Full hasta la próxima
    -- sincronización. Sin el envío normalizado, decide la publicación.
    v_line_full := v_full_pack or (not v_has_ship and exists (
      select 1 from ml_items mi
       where mi.account_id = p_account and mi.ml_item_id = v_l ->> 'ml_item_id'
         and mi.logistic_type = 'fulfillment'));
    if v_line_full then
      v_track := false;
      v_full_lines := v_full_lines + 1;
      if v_full_feat is null then
        v_full_feat := tenant_has_feature_for(v_tenant, 'mercadolibre_full');
      end if;
      if v_full_feat then
        v_full_inv := _ml_full_sale_apply(p_account, v_l ->> 'ml_item_id', v_l ->> 'ml_variation_id',
                                          (v_l ->> 'quantity')::numeric);
      end if;
    end if;
    if v_track then
      v_taken := _ml_stock_apply(v_tenant, v_sale, v_store, v_map.warehouse_id,
                                 (v_l ->> 'product_id')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
                                 (v_l ->> 'quantity')::numeric, 0, 'sale');
    end if;
    v_lines := jsonb_set(v_lines, array[v_i::text],
                         v_l || jsonb_build_object('applied', v_track, 'store_id', v_store,
                                                   'warehouse_id', v_map.warehouse_id, 'wh_taken', v_taken,
                                                   'full', v_line_full, 'full_inventory_id', v_full_inv));
  end loop;

  -- ADR-141: renglón del envío cobrado al comprador (sin producto ni stock).
  if v_ship > 0 then
    v_tl := v_tax -> 'lines' -> jsonb_array_length(v_lines);
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale, null, null, v_ship_label, null, null, 1, v_ship, 0, v_ship, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
  end if;

  -- Cobro del canal: sin caja (lo liquida Mercado Pago).
  insert into payments (tenant_id, sale_id, method, amount, reference, card_voucher)
  values (v_tenant, v_sale, 'mercadolibre', v_total, left('ML ' || v_pack, 120), '{}'::jsonb);

  -- Cada orden guarda sus líneas resueltas (para revertir exacto).
  for v_ord in
    select o.id from ml_orders o where o.account_id = p_account and o.pack_key = v_pack
  loop
    select count(*) filter (where nullif(x ->> 'product_id', '') is null) into v_unlinked
      from jsonb_array_elements(v_lines) x where (x ->> 'order_row')::uuid = v_ord.id;
    update ml_orders
       set sale_id = v_sale, stock_applied_at = now(),
           lines = coalesce((select jsonb_agg(x - 'order_row') from jsonb_array_elements(v_lines) x
                              where (x ->> 'order_row')::uuid = v_ord.id), '[]'::jsonb),
           unlinked_lines = coalesce(v_unlinked, 0),
           needs_review = case when coalesce(v_unlinked, 0) > 0
                               then 'Hay publicaciones sin vincular: la venta se registró sin descontar su stock.'
                               else needs_review end,
           invoice_status = case v_acc.invoice_mode when 'none' then 'not_applicable'
                                                    when 'ml_billing' then 'not_applicable'
                                                    else 'pending' end
     where id = v_ord.id;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, null, 'sales', v_sale, 'ml_sale_ingested',
          jsonb_build_object('pack_key', v_pack, 'sale_number', v_number, 'total', v_total,
                             'orders', (select jsonb_agg(o.ml_order_id) from ml_orders o
                                         where o.account_id = p_account and o.pack_key = v_pack),
                             'account_id', p_account, 'shipping_line', v_ship, 'coupon_discount', v_discount,
                             'plan', v_plan is not null, 'full_lines', v_full_lines),
          v_store);

  if v_plan is not null then
    -- ADR-141: plan guardado; factura sola si el modo y el plan lo permiten.
    v_prow := _ml_plan_store(p_account, v_pack, v_sale, v_plan, null);
    if v_acc.invoice_mode in ('none', 'ml_billing') then
      update ml_invoice_plans set status = 'skipped', skip_reason = 'La cuenta no factura las ventas de Mercado Libre.'
       where id = v_prow.id and fiscal_document_id is null;
    else
      v_auto := _ml_invoice_auto(v_prow.id);
      perform _ml_orders_status_from_plan(v_prow.id);
    end if;
  elsif v_acc.invoice_mode = 'on_paid' then
    -- Facturación al pagar (cola ARCA existente; nunca frena la venta).
    begin
      v_fiscal := arca_enqueue_sale(v_sale, false);
      if v_fiscal is not null then
        update ml_orders set invoice_status = 'queued', fiscal_document_id = v_fiscal
         where account_id = p_account and pack_key = v_pack;
      end if;
    exception when others then
      raise warning 'ml_ingest_pack arca: %', sqlerrm;
    end;
  end if;

  return jsonb_build_object('ok', true, 'decision', 'create_sale', 'sale_id', v_sale, 'number', v_number,
                            'total', v_total, 'invoice', coalesce(v_auto, 'null'::jsonb));
end;
$$;
revoke all on function ml_ingest_pack(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_ingest_pack(uuid, jsonb) to service_role;
