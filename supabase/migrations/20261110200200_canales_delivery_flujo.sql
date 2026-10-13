-- =============================================================================
-- 20261110200200_canales_delivery_flujo  (F13 · H49 integraciones, ADR-102)
-- -----------------------------------------------------------------------------
-- Flujo de los pedidos de apps de delivery sobre el modelo de 20261110200100:
--
--   Edge delivery_channel_webhook (pública, firma por adaptador)
--     -> delivery_channel_ingest_event(conexión, evento normalizado)
--        guarda el evento crudo (idempotente por conexión + id externo) y lo
--        procesa en una subtransacción: si falla queda 'error' para reintentar,
--        el evento nunca se pierde.
--          order.new        crea delivery_orders + líneas (comanda en el KDS si
--                           se auto-acepta o el flujo es indirecto; si no, la
--                           comanda queda en espera hasta Aceptar)
--          order.status     aceptado / listo / retirado / entregado
--          order.cancelled  anula la comanda (delivery_order_voids, ADR-097) y,
--                           si estaba facturado, anula la venta: la cola fiscal
--                           emite la nota de crédito (arca_on_void, ADR-072)
--          courier.update   repartidor, posición, ETA y link de seguimiento
--   Acciones del local (Aceptar con tiempo de preparación, Rechazar, Listo,
--   Retirado, Entregado) -> delivery_channel_outbox (reintentos con backoff)
--     -> Edge delivery_channel_worker (cron o al toque) -> adaptador.
--   Cocina: cuando todas las líneas quedan listas en el KDS, el pedido pasa a
--   listo y se avisa a la app.
--   Facturación: create_sale con p_delivery_order_id (el flujo existente de
--   cobro de delivery_orders) en el turno de quien factura, con el medio
--   'plataforma' (sin movimiento de caja) o efectivo si cobra el repartidor del
--   local. Automática al quedar retirado o entregado (conexión en 'auto') o
--   con el botón Facturar. No se recrea create_sale.
--
-- Gating real: tenant_has_feature_for(tenant, 'canales_delivery') en cada RPC
-- de usuario, en la ingesta (sin la feature el evento queda 'ignorado'), en la
-- toma de la cola y en la guarda de la Edge.
-- =============================================================================

-- ── 0) Utilidades ────────────────────────────────────────────────────────────
create or replace function _channel_ts(p text)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return nullif(btrim(coalesce(p, '')), '')::timestamptz;
exception when others then
  return null;
end;
$$;
revoke all on function _channel_ts(text) from public, anon, authenticated;

create or replace function _channel_num(p text)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  return nullif(btrim(coalesce(p, '')), '')::numeric;
exception when others then
  return null;
end;
$$;
revoke all on function _channel_num(text) from public, anon, authenticated;

-- Máquina de estados del pedido externo (espejo de canTransition en
-- supabase/functions/_shared/deliveryChannels/stateMachine.ts). No retrocede:
-- un evento fuera de orden se ignora.
create or replace function _channel_can_transition(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_from
    when 'nuevo'     then p_to in ('aceptado', 'rechazado', 'cancelado')
    when 'aceptado'  then p_to in ('listo', 'retirado', 'entregado', 'cancelado')
    when 'listo'     then p_to in ('retirado', 'entregado', 'cancelado')
    when 'retirado'  then p_to in ('entregado', 'cancelado')
    when 'entregado' then p_to = 'cancelado'
    else false
  end;
$$;
revoke all on function _channel_can_transition(text, text) from public, anon;
grant execute on function _channel_can_transition(text, text) to authenticated, service_role;

-- Guarda de las RPC de usuario: miembro activo y operativo, no solo lectura,
-- dueño o encargado si p_manage, y la feature en el plan.
create or replace function _channel_assert(p_manage boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant';
  end if;
  v_role := member_role_in(v_tenant);
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_role = 'viewer' then
    raise exception 'forbidden_read_only' using errcode = '42501';
  end if;
  if p_manage and not is_tenant_manager() then
    raise exception 'forbidden_role' using errcode = '42501';
  end if;
  perform assert_staff_operational();
  if not tenant_has_feature_for(v_tenant, 'canales_delivery') then
    raise exception 'feature_not_in_plan: canales_delivery' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _channel_assert(boolean) from public, anon, authenticated;

-- Estado de delivery_orders que corresponde a un estado externo. Mientras el
-- pedido no se facturó no pasa a 'entregado' (create_sale lo cierra al cobrar).
create or replace function _channel_board_status(p_external text, p_order_type text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_external
    when 'nuevo'     then 'recibido'
    when 'aceptado'  then 'preparando'
    when 'listo'     then 'listo'
    when 'retirado'  then case when p_order_type = 'delivery' then 'en_camino' else 'listo' end
    when 'entregado' then case when p_order_type = 'delivery' then 'en_camino' else 'listo' end
    else 'cancelado'
  end;
$$;
revoke all on function _channel_board_status(text, text) from public, anon, authenticated;

-- Encola una llamada saliente. En el flujo indirecto la app se maneja desde su
-- tablet: no se le avisa nada.
create or replace function _channel_enqueue(p_order uuid, p_action text, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co   delivery_channel_orders%rowtype;
  v_conn delivery_channel_connections%rowtype;
  v_id   uuid;
begin
  select * into v_co from delivery_channel_orders where id = p_order;
  select * into v_conn from delivery_channel_connections where id = v_co.connection_id;
  if v_conn.flow = 'indirecto' then
    return null;
  end if;
  insert into delivery_channel_outbox (tenant_id, connection_id, channel_order_id, action, payload, created_by)
  values (v_co.tenant_id, v_co.connection_id, v_co.id, p_action, coalesce(p_payload, '{}'::jsonb), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function _channel_enqueue(uuid, text, jsonb) from public, anon, authenticated;

-- Aplica un estado externo (aceptado, listo, retirado, entregado) al pedido y
-- al tablero. No encola nada: lo hacen las RPC del local.
create or replace function _channel_apply_status(p_order uuid, p_to text, p_prep integer default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co delivery_channel_orders%rowtype;
  v_do delivery_orders%rowtype;
begin
  select * into v_co from delivery_channel_orders where id = p_order for update;
  select * into v_do from delivery_orders where id = v_co.delivery_order_id for update;

  if p_to = 'aceptado' then
    update delivery_channel_orders
       set external_status = 'aceptado', accepted_at = coalesce(accepted_at, now()),
           prep_minutes = coalesce(p_prep, prep_minutes)
     where id = v_co.id;
    -- La comanda en espera sale a cocina.
    update delivery_order_items set fired_at = now()
     where order_id = v_co.delivery_order_id and tenant_id = v_co.tenant_id and fired_at is null;
  elsif p_to = 'listo' then
    update delivery_channel_orders
       set external_status = 'listo', ready_at = coalesce(ready_at, now())
     where id = v_co.id;
  elsif p_to = 'retirado' then
    update delivery_channel_orders
       set external_status = 'retirado', ready_at = coalesce(ready_at, now()),
           picked_up_at = coalesce(picked_up_at, now())
     where id = v_co.id;
  elsif p_to = 'entregado' then
    update delivery_channel_orders
       set external_status = 'entregado', picked_up_at = coalesce(picked_up_at, now()),
           delivered_at = coalesce(delivered_at, now())
     where id = v_co.id;
  else
    raise exception 'invalid_status';
  end if;

  -- Retirado o entregado: la cocina ya no lo tiene.
  if p_to in ('retirado', 'entregado') then
    update delivery_order_items
       set kds_status = 'entregado', kds_ready_at = coalesce(kds_ready_at, now()),
           fired_at = coalesce(fired_at, now())
     where order_id = v_co.delivery_order_id and tenant_id = v_co.tenant_id and kds_status <> 'entregado';
  end if;

  if v_do.sale_id is null and v_do.status not in ('entregado', 'cancelado') then
    update delivery_orders
       set status = _channel_board_status(p_to, v_do.order_type), updated_at = now()
     where id = v_do.id and tenant_id = v_co.tenant_id;
  end if;
end;
$$;
revoke all on function _channel_apply_status(uuid, text, integer) from public, anon, authenticated;

-- Anula una venta facturada de un pedido de app (cancelación de la plataforma
-- después de facturar). Mismos efectos que void_sale (20261031200000): venta
-- anulada, stock devuelto y contramovimiento de caja por cada pago (el medio
-- 'plataforma' no genera movimiento). Al pasar a 'voided', arca_sales_trg
-- encola la nota de crédito si la factura ya estaba aprobada (o cancela la
-- factura que nunca llegó a ARCA). Sin PIN: lo pide la plataforma, no una
-- persona (require_supervisor no aplica sin sesión).
create or replace function _channel_void_sale(p_tenant uuid, p_sale_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store uuid;
  v_shift uuid;
  v_item  record;
  v_pay   record;
begin
  select store_id, cash_shift_id into v_store, v_shift
    from sales
   where id = p_sale_id and tenant_id = p_tenant and status = 'completed'
   for update;
  if v_store is null then
    return false;
  end if;

  update sales
     set status = 'voided', voided_at = now(), voided_by = auth.uid(),
         void_reason = left(p_reason, 200), updated_at = now()
   where id = p_sale_id and tenant_id = p_tenant;

  for v_item in
    select product_id, quantity from sale_items
     where sale_id = p_sale_id and tenant_id = p_tenant and product_id is not null
  loop
    update products
       set stock = stock + v_item.quantity, updated_at = now()
     where id = v_item.product_id and tenant_id = p_tenant;
    insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
    values (p_tenant, v_item.product_id, v_store, v_item.quantity, 'sale_void', p_sale_id);
  end loop;

  if v_shift is not null then
    for v_pay in
      select method, amount from payments where sale_id = p_sale_id and tenant_id = p_tenant
    loop
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reference_id)
      values (p_tenant, v_shift, 'sale_void', v_pay.amount, v_pay.method, p_sale_id);
    end loop;
  end if;
  return true;
end;
$$;
revoke all on function _channel_void_sale(uuid, uuid, text) from public, anon, authenticated;

-- Cancelación o rechazo: anula la comanda con el patrón de ADR-097 (registro
-- en delivery_order_voids con el motivo, aviso en el KDS) y, si ya estaba
-- facturado, anula la venta (nota de crédito por la cola fiscal).
create or replace function _channel_cancel(p_order uuid, p_kind text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co     delivery_channel_orders%rowtype;
  v_do     delivery_orders%rowtype;
  v_reason text;
  v_label  text;
  v_voids  int := 0;
  v_voided boolean := false;
  v_brand  text;
begin
  select * into v_co from delivery_channel_orders where id = p_order for update;
  if v_co.external_status in ('cancelado', 'rechazado') then
    return jsonb_build_object('status', 'ignorado', 'reason', 'already_closed');
  end if;
  select * into v_do from delivery_orders where id = v_co.delivery_order_id for update;
  select name into v_brand from delivery_channel_providers where key = v_co.brand;
  v_reason := left(coalesce(nullif(btrim(p_reason), ''),
                            case when p_kind = 'rechazado' then 'Rechazado por el local'
                                 else 'Cancelado por ' || coalesce(v_brand, 'la plataforma') end), 200);
  if char_length(v_reason) < 3 then
    v_reason := 'Cancelado';
  end if;
  v_label := _delivery_order_label(v_do.id, v_do.order_type);

  -- Lo que ya estaba en cocina queda anulado con motivo (aviso en el KDS).
  with ins as (
    insert into delivery_order_voids (tenant_id, order_id, item_id, product_id, name, qty, unit_price,
                                      station, course, order_label, reason, voided_by)
    select v_co.tenant_id, i.order_id, i.id, i.product_id, i.name, i.qty, i.unit_price,
           i.station, coalesce(i.course, 1), v_label, v_reason, auth.uid()
      from delivery_order_items i
     where i.order_id = v_co.delivery_order_id and i.tenant_id = v_co.tenant_id
       and i.fired_at is not null and i.kds_status <> 'entregado'
    returning 1
  )
  select count(*) into v_voids from ins;

  if v_co.billing_status = 'facturado' and v_co.sale_id is not null then
    v_voided := _channel_void_sale(v_co.tenant_id, v_co.sale_id, v_reason);
  end if;

  update delivery_orders set status = 'cancelado', updated_at = now()
   where id = v_do.id and tenant_id = v_co.tenant_id;

  update delivery_channel_orders
     set external_status = p_kind,
         cancelled_at = case when p_kind = 'cancelado' then now() else cancelled_at end,
         cancel_reason = case when p_kind = 'cancelado' then v_reason else cancel_reason end,
         reject_reason = case when p_kind = 'rechazado' then v_reason else reject_reason end,
         billing_status = case when billing_status = 'facturado' then 'anulado' else 'no_facturar' end
   where id = v_co.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, before_data, after_data)
  values (v_co.tenant_id, auth.uid(), 'delivery_channel_orders', v_co.id,
          case when p_kind = 'rechazado' then 'channel_order_rejected' else 'channel_order_cancelled' end,
          v_reason,
          jsonb_build_object('external_status', v_co.external_status, 'billing_status', v_co.billing_status,
                             'sale_id', v_co.sale_id),
          jsonb_build_object('external_status', p_kind, 'voided_items', v_voids, 'sale_voided', v_voided,
                             'delivery_order_id', v_do.id, 'external_order_id', v_co.external_order_id));

  return jsonb_build_object('status', 'procesado', 'voided_items', v_voids, 'sale_voided', v_voided);
end;
$$;
revoke all on function _channel_cancel(uuid, text, text) from public, anon, authenticated;

-- ── 1) Ingesta de un pedido nuevo ────────────────────────────────────────────
create or replace function _channel_order_new(p_connection uuid, o jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conn     delivery_channel_connections%rowtype;
  v_ext      text := left(nullif(btrim(coalesce(o ->> 'external_order_id', '')), ''), 120);
  v_existing uuid;
  v_type     text := case when lower(coalesce(o ->> 'order_type', '')) = 'takeaway' then 'takeaway' else 'delivery' end;
  v_logi     text := case when lower(coalesce(o ->> 'logistics', '')) = 'propia' then 'propia' else 'plataforma' end;
  v_pay      text := case when lower(coalesce(o ->> 'payment_mode', '')) = 'efectivo' then 'efectivo' else 'prepago' end;
  v_brand    text := lower(coalesce(nullif(o ->> 'brand', ''), ''));
  v_accepted boolean;
  v_prep     integer;
  v_fee      numeric := 0;
  v_do       uuid;
  v_co       uuid;
  v_it       jsonb;
  v_m        jsonb;
  v_ext_item text;
  v_qty      numeric;
  v_price    numeric;
  v_pid      uuid;
  v_station  text;
  v_review   boolean := false;
  v_mg       text[];
  v_mn       text[];
  v_md       numeric[];
  v_gname    text;
  v_oname    text;
  v_odelta   numeric;
  v_extra    text;
  v_mods     jsonb;
  v_sub      numeric := 0;
  v_total    numeric;
  v_n        int := 0;
begin
  select * into v_conn from delivery_channel_connections where id = p_connection;
  if v_ext is null then
    raise exception 'invalid_order: external_order_id';
  end if;
  if coalesce(jsonb_typeof(o -> 'items'), '') <> 'array' or jsonb_array_length(o -> 'items') = 0 then
    raise exception 'invalid_order: items';
  end if;

  -- Idempotencia a nivel pedido: el mismo pedido (otro evento, la
  -- reconciliación o un reintento de la plataforma) no crea otro ni otra comanda.
  select id into v_existing from delivery_channel_orders
   where connection_id = v_conn.id and external_order_id = v_ext;
  if v_existing is not null then
    return jsonb_build_object('status', 'procesado', 'channel_order_id', v_existing, 'duplicate_order', true);
  end if;

  if v_brand not in ('pedidosya', 'rappi', 'ubereats', 'mp_delivery', 'simulador') then
    v_brand := v_conn.provider;
  end if;
  v_accepted := v_conn.flow = 'indirecto' or v_conn.auto_accept;
  v_prep := greatest(least(coalesce(_channel_num(o ->> 'prep_minutes')::integer, v_conn.default_prep_minutes), 180), 1);
  -- Con reparto de la plataforma el envío es de la app, no del local.
  if v_logi = 'propia' and v_type = 'delivery' then
    v_fee := greatest(coalesce(_channel_num(o ->> 'delivery_fee'), 0), 0);
  end if;

  insert into delivery_orders (tenant_id, channel, order_type, customer_name, customer_phone, address,
                               address_reference, promised_at, delivery_fee, status, notes, created_by)
  values (v_conn.tenant_id, 'app', v_type,
          left(nullif(btrim(coalesce(o ->> 'customer_name', '')), ''), 120),
          left(nullif(btrim(coalesce(o ->> 'customer_phone', '')), ''), 40),
          case when v_type = 'delivery' then left(nullif(btrim(coalesce(o ->> 'address', '')), ''), 300) end,
          case when v_type = 'delivery' then left(nullif(btrim(coalesce(o ->> 'address_reference', '')), ''), 200) end,
          _channel_ts(o ->> 'promised_at'), v_fee,
          case when v_accepted then 'preparando' else 'recibido' end,
          left(nullif(btrim(coalesce(o ->> 'notes', '')), ''), 500), null)
  returning id into v_do;

  -- El precio de cada línea es el de la app (permiso de sesión que acepta
  -- trg_order_item_price sólo en este INSERT).
  perform set_config('ninja.channel_ingest', 'on', true);
  for v_it in select * from jsonb_array_elements(o -> 'items') loop
    v_ext_item := left(nullif(btrim(coalesce(v_it ->> 'external_id', '')), ''), 120);
    v_qty := round(greatest(coalesce(_channel_num(v_it ->> 'quantity'), 1), 0.001), 3);
    v_price := round(greatest(coalesce(_channel_num(v_it ->> 'unit_price'), 0), 0), 2);
    v_pid := null;
    v_station := null;
    if v_ext_item is not null then
      select m.product_id into v_pid
        from delivery_channel_product_map m
        join products p on p.id = m.product_id and p.tenant_id = v_conn.tenant_id
       where m.connection_id = v_conn.id and m.kind = 'product' and m.external_id = v_ext_item
         and m.deleted_at is null
       limit 1;
    end if;
    if v_pid is not null then
      select nullif(btrim(station), '') into v_station from products
       where id = v_pid and tenant_id = v_conn.tenant_id;
    else
      v_review := true;
    end if;

    -- Modificadores: los mapeados viajan como modificadores del POS; el resto
    -- va a la nota de la línea (la cocina los ve igual).
    v_mg := '{}'; v_mn := '{}'; v_md := '{}'; v_extra := null;
    if jsonb_typeof(v_it -> 'modifiers') = 'array' then
      for v_m in select * from jsonb_array_elements(v_it -> 'modifiers') loop
        v_gname := null; v_oname := null; v_odelta := null;
        if v_pid is not null and nullif(v_m ->> 'external_id', '') is not null then
          select mg.name, mo.name, mo.price_delta into v_gname, v_oname, v_odelta
            from delivery_channel_product_map m
            join product_modifier_options mo on mo.id = m.modifier_option_id
                                            and mo.tenant_id = v_conn.tenant_id and mo.is_active
            join product_modifier_groups mg on mg.id = mo.group_id and mg.product_id = v_pid
                                           and mg.tenant_id = v_conn.tenant_id
           where m.connection_id = v_conn.id and m.kind = 'modifier'
             and m.external_id = left(v_m ->> 'external_id', 120) and m.deleted_at is null
           limit 1;
        end if;
        if v_oname is not null then
          v_mg := v_mg || v_gname;
          v_mn := v_mn || v_oname;
          v_md := v_md || coalesce(v_odelta, 0);
        else
          v_extra := concat_ws(', ', v_extra,
                               left(coalesce(nullif(btrim(coalesce(v_m ->> 'name', '')), ''), 'Extra'), 80)
                               || case when coalesce(_channel_num(v_m ->> 'quantity'), 1) > 1
                                       then ' x' || (_channel_num(v_m ->> 'quantity'))::text else '' end);
        end if;
        if nullif(v_m ->> 'external_id', '') is not null then
          insert into delivery_channel_external_items (tenant_id, connection_id, kind, external_id, name, last_price)
          values (v_conn.tenant_id, v_conn.id, 'modifier', left(v_m ->> 'external_id', 120),
                  left(coalesce(nullif(btrim(coalesce(v_m ->> 'name', '')), ''), 'Extra'), 200),
                  _channel_num(v_m ->> 'unit_price'))
          on conflict (connection_id, kind, external_id) do update
            set name = excluded.name, last_price = excluded.last_price,
                seen_count = delivery_channel_external_items.seen_count + 1, last_seen_at = now();
        end if;
      end loop;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('group', x.g, 'options', x.opts)), '[]'::jsonb) into v_mods
      from (select t.g, jsonb_agg(jsonb_build_object('name', t.n, 'price_delta', t.d)) as opts
              from unnest(v_mg, v_mn, v_md) as t(g, n, d)
             group by t.g) x;

    insert into delivery_order_items (tenant_id, order_id, product_id, name, qty, unit_price, modifiers,
                                      notes, station, kds_status, course, fired_at)
    values (v_conn.tenant_id, v_do, v_pid,
            left(coalesce(nullif(btrim(coalesce(v_it ->> 'name', '')), ''), 'Ítem'), 200),
            v_qty, v_price, v_mods,
            left(nullif(concat_ws(' · ', nullif(btrim(coalesce(v_it ->> 'notes', '')), ''),
                                  case when v_extra is not null then '+ ' || v_extra end), ''), 500),
            v_station, 'pendiente', 1,
            case when v_accepted then now() end);
    v_sub := v_sub + round(v_qty * v_price, 2);
    v_n := v_n + 1;

    if v_ext_item is not null then
      insert into delivery_channel_external_items (tenant_id, connection_id, kind, external_id, name, sku, last_price)
      values (v_conn.tenant_id, v_conn.id, 'product', v_ext_item,
              left(coalesce(nullif(btrim(coalesce(v_it ->> 'name', '')), ''), 'Ítem'), 200),
              left(nullif(btrim(coalesce(v_it ->> 'sku', '')), ''), 80), v_price)
      on conflict (connection_id, kind, external_id) do update
        set name = excluded.name, sku = coalesce(excluded.sku, delivery_channel_external_items.sku),
            last_price = excluded.last_price,
            seen_count = delivery_channel_external_items.seen_count + 1, last_seen_at = now();
    end if;
  end loop;
  perform set_config('ninja.channel_ingest', '', true);

  v_total := coalesce(_channel_num(o ->> 'total'), v_sub + v_fee);

  insert into delivery_channel_orders (
    tenant_id, delivery_order_id, connection_id, store_id, provider, brand, external_order_id,
    external_display_code, external_status, logistics, payment_mode, currency, subtotal,
    platform_discount, store_discount, delivery_fee, total, placed_at, accept_deadline_at,
    accepted_at, prep_minutes, needs_review)
  values (
    v_conn.tenant_id, v_do, v_conn.id, v_conn.store_id, v_conn.provider, v_brand, v_ext,
    left(nullif(btrim(coalesce(o ->> 'display_code', '')), ''), 40),
    case when v_accepted then 'aceptado' else 'nuevo' end,
    v_logi, v_pay, left(coalesce(nullif(o ->> 'currency', ''), 'ARS'), 3), v_sub,
    greatest(coalesce(_channel_num(o ->> 'platform_discount'), 0), 0),
    greatest(coalesce(_channel_num(o ->> 'store_discount'), 0), 0),
    greatest(coalesce(_channel_num(o ->> 'delivery_fee'), 0), 0),
    v_total,
    coalesce(_channel_ts(o ->> 'placed_at'), now()),
    case when not v_accepted then coalesce(_channel_ts(o ->> 'accept_deadline_at'), now() + interval '6 minutes') end,
    case when v_accepted then now() end,
    case when v_accepted then v_prep end,
    v_review)
  returning id into v_co;

  -- Auto-aceptar en flujo directo: se le avisa a la app con el tiempo de prep.
  if v_conn.flow = 'directo' and v_conn.auto_accept then
    perform _channel_enqueue(v_co, 'accept', jsonb_build_object('prep_minutes', v_prep, 'auto', true));
  end if;

  -- Comisión estimada (la real llega con la liquidación).
  if v_conn.commission_pct > 0 then
    insert into delivery_channel_settlements (tenant_id, connection_id, channel_order_id, kind, gross,
                                              commission, net)
    values (v_conn.tenant_id, v_conn.id, v_co, 'estimado', v_total,
            round(v_total * v_conn.commission_pct / 100, 2),
            v_total - round(v_total * v_conn.commission_pct / 100, 2));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_conn.tenant_id, null, 'delivery_channel_orders', v_co, 'channel_order_received',
          jsonb_build_object('delivery_order_id', v_do, 'provider', v_conn.provider, 'brand', v_brand,
                             'external_order_id', v_ext, 'items', v_n, 'total', v_total,
                             'accepted', v_accepted, 'needs_review', v_review));

  -- Una cancelación que llegó antes que el pedido (eventos fuera de orden).
  if exists (select 1 from delivery_channel_events e
              where e.connection_id = v_conn.id and e.external_order_id = v_ext
                and e.event_type = 'order.cancelled' and e.status = 'ignorado') then
    perform _channel_cancel(v_co, 'cancelado', null);
  end if;

  return jsonb_build_object('status', 'procesado', 'channel_order_id', v_co, 'delivery_order_id', v_do,
                            'accepted', v_accepted, 'needs_review', v_review);
end;
$$;
revoke all on function _channel_order_new(uuid, jsonb) from public, anon, authenticated;

-- ── 2) Procesar un evento guardado ───────────────────────────────────────────
create or replace function _channel_apply_event(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ev  delivery_channel_events%rowtype;
  v_co  delivery_channel_orders%rowtype;
  v_to  text;
  v_c   jsonb;
begin
  select * into v_ev from delivery_channel_events where id = p_event;

  if v_ev.event_type = 'order.new' then
    return _channel_order_new(v_ev.connection_id, coalesce(v_ev.payload -> 'order', '{}'::jsonb)
                                                  || jsonb_build_object('external_order_id',
                                                       coalesce(v_ev.payload #>> '{order,external_order_id}',
                                                                v_ev.external_order_id)));
  end if;

  select * into v_co from delivery_channel_orders
   where connection_id = v_ev.connection_id and external_order_id = v_ev.external_order_id;
  if not found then
    -- Llegó antes que el pedido: queda ignorado; si es una cancelación se
    -- aplica cuando el pedido entre (_channel_order_new).
    return jsonb_build_object('status', 'ignorado', 'reason', 'order_not_found');
  end if;

  if v_ev.event_type = 'order.cancelled' then
    return _channel_cancel(v_co.id, 'cancelado', v_ev.payload ->> 'reason')
           || jsonb_build_object('channel_order_id', v_co.id);
  end if;

  if v_ev.event_type = 'order.status' then
    v_to := lower(coalesce(v_ev.payload ->> 'status', ''));
    if v_to in ('cancelado', 'rechazado') then
      return _channel_cancel(v_co.id, v_to, v_ev.payload ->> 'reason')
             || jsonb_build_object('channel_order_id', v_co.id);
    end if;
    if v_to = v_co.external_status or not _channel_can_transition(v_co.external_status, v_to) then
      return jsonb_build_object('status', 'ignorado', 'reason', 'transition', 'channel_order_id', v_co.id,
                                'from', v_co.external_status, 'to', v_to);
    end if;
    perform _channel_apply_status(v_co.id, v_to, _channel_num(v_ev.payload ->> 'prep_minutes')::integer);
    return jsonb_build_object('status', 'procesado', 'channel_order_id', v_co.id, 'to', v_to);
  end if;

  if v_ev.event_type = 'courier.update' then
    v_c := coalesce(v_ev.payload -> 'courier', '{}'::jsonb);
    update delivery_channel_orders
       set courier_name   = coalesce(left(nullif(btrim(coalesce(v_c ->> 'name', '')), ''), 120), courier_name),
           courier_phone  = coalesce(left(nullif(btrim(coalesce(v_c ->> 'phone', '')), ''), 40), courier_phone),
           courier_status = coalesce(left(nullif(btrim(coalesce(v_c ->> 'status', '')), ''), 40), courier_status),
           courier_lat    = case when _channel_num(v_c ->> 'lat') between -90 and 90
                                 then round(_channel_num(v_c ->> 'lat'), 6) else courier_lat end,
           courier_lng    = case when _channel_num(v_c ->> 'lng') between -180 and 180
                                 then round(_channel_num(v_c ->> 'lng'), 6) else courier_lng end,
           courier_eta_at = coalesce(_channel_ts(v_c ->> 'eta_at'),
                                     case when _channel_num(v_c ->> 'eta_minutes') between 0 and 600
                                          then now() + make_interval(mins => _channel_num(v_c ->> 'eta_minutes')::integer) end,
                                     courier_eta_at),
           tracking_url   = case when coalesce(v_c ->> 'tracking_url', '') ~* '^https://'
                                 then left(v_c ->> 'tracking_url', 500) else tracking_url end,
           courier_updated_at = now()
     where id = v_co.id;
    -- El nombre del repartidor también queda en el pedido (lo ve el tablero y la comanda).
    if nullif(btrim(coalesce(v_c ->> 'name', '')), '') is not null then
      update delivery_orders set courier_name = left(btrim(v_c ->> 'name'), 120), updated_at = now()
       where id = v_co.delivery_order_id and tenant_id = v_co.tenant_id and status not in ('cancelado');
    end if;
    return jsonb_build_object('status', 'procesado', 'channel_order_id', v_co.id);
  end if;

  return jsonb_build_object('status', 'ignorado', 'reason', 'unknown_event');
end;
$$;
revoke all on function _channel_apply_event(uuid) from public, anon, authenticated;

-- Procesa un evento guardado en una subtransacción: si falla queda 'error' con
-- el mensaje y el evento crudo sigue ahí para reintentar.
create or replace function delivery_channel_process_event(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ev  delivery_channel_events%rowtype;
  v_out jsonb;
begin
  select * into v_ev from delivery_channel_events where id = p_event for update;
  if not found then
    raise exception 'event_not_found';
  end if;
  if v_ev.status in ('procesado', 'ignorado') then
    return jsonb_build_object('event_id', v_ev.id, 'status', v_ev.status,
                              'channel_order_id', v_ev.channel_order_id, 'duplicate', true);
  end if;
  begin
    v_out := _channel_apply_event(v_ev.id);
    update delivery_channel_events
       set status = coalesce(v_out ->> 'status', 'procesado'),
           channel_order_id = coalesce(nullif(v_out ->> 'channel_order_id', '')::uuid, channel_order_id),
           processed_at = now(), attempts = attempts + 1, error = null
     where id = v_ev.id;
  exception when others then
    update delivery_channel_events
       set status = 'error', attempts = attempts + 1, error = left(sqlerrm, 500)
     where id = v_ev.id;
    v_out := jsonb_build_object('status', 'error', 'error', left(sqlerrm, 500));
  end;
  return v_out || jsonb_build_object('event_id', v_ev.id);
end;
$$;
revoke all on function delivery_channel_process_event(uuid) from public, anon, authenticated;
grant execute on function delivery_channel_process_event(uuid) to service_role;

-- Entrada única de la Edge (webhook, reconciliación y simulador). p_event:
--   { external_event_id, type: order.new | order.status | order.cancelled |
--     courier.update, external_order_id, order?, status?, reason?, courier? }
create or replace function delivery_channel_ingest_event(p_connection uuid, p_event jsonb,
                                                         p_source text default 'webhook')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conn   delivery_channel_connections%rowtype;
  v_ext_ev text := left(nullif(btrim(coalesce(p_event ->> 'external_event_id', '')), ''), 200);
  v_type   text := lower(coalesce(p_event ->> 'type', ''));
  v_order  text := left(nullif(btrim(coalesce(p_event ->> 'external_order_id',
                                              p_event #>> '{order,external_order_id}', '')), ''), 120);
  v_id     uuid;
  v_prev   delivery_channel_events%rowtype;
begin
  if v_ext_ev is null or v_type = '' or coalesce(jsonb_typeof(p_event), '') <> 'object' then
    raise exception 'invalid_event';
  end if;
  select * into v_conn from delivery_channel_connections where id = p_connection and deleted_at is null;
  if not found then
    raise exception 'connection_not_found';
  end if;

  insert into delivery_channel_events (tenant_id, connection_id, external_event_id, event_type,
                                       external_order_id, source, payload)
  values (v_conn.tenant_id, v_conn.id, v_ext_ev, v_type, v_order,
          case when p_source in ('webhook', 'reconciliacion', 'simulador') then p_source else 'webhook' end,
          p_event)
  on conflict (connection_id, external_event_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- Evento repetido (la plataforma reintenta): no se vuelve a aplicar.
    select * into v_prev from delivery_channel_events
     where connection_id = v_conn.id and external_event_id = v_ext_ev;
    return jsonb_build_object('event_id', v_prev.id, 'status', v_prev.status, 'duplicate', true,
                              'channel_order_id', v_prev.channel_order_id);
  end if;

  update delivery_channel_connections set last_event_at = now() where id = v_conn.id;

  if not tenant_has_feature_for(v_conn.tenant_id, 'canales_delivery') then
    update delivery_channel_events
       set status = 'ignorado', error = 'feature_not_in_plan', processed_at = now()
     where id = v_id;
    return jsonb_build_object('event_id', v_id, 'status', 'ignorado', 'error', 'feature_not_in_plan');
  end if;

  return delivery_channel_process_event(v_id);
end;
$$;
revoke all on function delivery_channel_ingest_event(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function delivery_channel_ingest_event(uuid, jsonb, text) to service_role;

-- Eventos con error para reintentar (cron): hasta 5 intentos en 24 h.
create or replace function delivery_channel_events_retry_due(p_limit integer default 20)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(x.id), '{}')
    from (select e.id from delivery_channel_events e
           where e.status = 'error' and e.attempts < 5 and e.received_at > now() - interval '1 day'
           order by e.received_at
           limit greatest(least(coalesce(p_limit, 20), 100), 1)) x;
$$;
revoke all on function delivery_channel_events_retry_due(integer) from public, anon, authenticated;
grant execute on function delivery_channel_events_retry_due(integer) to service_role;

-- ── 3) Contexto para la Edge (service_role) ──────────────────────────────────
create or replace function delivery_channel_webhook_context(p_connection uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'connection_id', c.id, 'tenant_id', c.tenant_id, 'store_id', c.store_id,
           'provider', c.provider, 'status', c.status, 'flow', c.flow,
           'external_store_id', c.external_store_id,
           'has_feature', tenant_has_feature_for(c.tenant_id, 'canales_delivery'),
           'webhook_secret', s.webhook_secret, 'credentials', coalesce(s.credentials, '{}'::jsonb))
    from delivery_channel_connections c
    left join delivery_channel_secrets s on s.connection_id = c.id
   where c.id = p_connection and c.deleted_at is null;
$$;
revoke all on function delivery_channel_webhook_context(uuid) from public, anon, authenticated;
grant execute on function delivery_channel_webhook_context(uuid) to service_role;

-- Guarda de la Edge para acciones de usuario (simular, probar, enviar ya).
create or replace function delivery_channel_edge_guard(p_tenant uuid, p_user uuid, p_connection uuid default null)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from tenant_users tu
                      where tu.tenant_id = p_tenant and tu.user_id = p_user
                        and tu.status = 'active' and tu.role in ('owner', 'manager')) then 'forbidden'
    when not tenant_has_feature_for(p_tenant, 'canales_delivery') then 'feature_not_in_plan'
    when p_connection is not null
         and not exists (select 1 from delivery_channel_connections c
                          where c.id = p_connection and c.tenant_id = p_tenant
                            and c.deleted_at is null) then 'connection_not_found'
    else null
  end;
$$;
revoke all on function delivery_channel_edge_guard(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function delivery_channel_edge_guard(uuid, uuid, uuid) to service_role;

-- ── 4) Cola saliente (service_role) ──────────────────────────────────────────
-- Toma con lease: pendientes vencidas o "enviando" colgadas más de 2 minutos.
-- Sólo negocios con la feature.
create or replace function delivery_channel_outbox_claim(p_limit integer default 20, p_tenant uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_out jsonb;
begin
  select coalesce(array_agg(x.id), '{}') into v_ids
    from (select o.id from delivery_channel_outbox o
           where ((o.status = 'pendiente' and o.next_attempt_at <= now())
                  or (o.status = 'enviando' and o.claimed_at < now() - interval '2 minutes'))
             and (p_tenant is null or o.tenant_id = p_tenant)
             and tenant_has_feature_for(o.tenant_id, 'canales_delivery')
           order by o.next_attempt_at
           limit greatest(least(coalesce(p_limit, 20), 100), 1)
           for update skip locked) x;

  update delivery_channel_outbox
     set status = 'enviando', claimed_at = now(), attempts = attempts + 1
   where id = any (v_ids);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'tenant_id', o.tenant_id, 'connection_id', o.connection_id,
           'provider', c.provider, 'external_store_id', c.external_store_id,
           'action', o.action, 'payload', o.payload, 'attempts', o.attempts,
           'channel_order_id', o.channel_order_id, 'external_order_id', co.external_order_id,
           'brand', co.brand) order by o.next_attempt_at), '[]'::jsonb)
    into v_out
    from delivery_channel_outbox o
    join delivery_channel_connections c on c.id = o.connection_id
    left join delivery_channel_orders co on co.id = o.channel_order_id
   where o.id = any (v_ids);
  return v_out;
end;
$$;
revoke all on function delivery_channel_outbox_claim(integer, uuid) from public, anon, authenticated;
grant execute on function delivery_channel_outbox_claim(integer, uuid) to service_role;

-- Backoff (espejo de outboxBackoffSeconds): 15 s, 30 s, 1, 2, 4, 8 min... tope 15 min.
create or replace function delivery_channel_backoff_seconds(p_attempt integer)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select least(15 * power(2, greatest(coalesce(p_attempt, 1), 1) - 1), 900)::integer;
$$;
revoke all on function delivery_channel_backoff_seconds(integer) from public, anon;
grant execute on function delivery_channel_backoff_seconds(integer) to authenticated, service_role;

create or replace function delivery_channel_outbox_result(p_id uuid, p_ok boolean, p_error text default null,
                                                          p_response jsonb default null,
                                                          p_retryable boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v      delivery_channel_outbox%rowtype;
  v_next text;
  v_label text;
begin
  select * into v from delivery_channel_outbox where id = p_id for update;
  if not found then
    raise exception 'outbox_not_found';
  end if;
  if v.status <> 'enviando' then
    return jsonb_build_object('id', v.id, 'status', v.status, 'stale', true);
  end if;

  if p_ok then
    update delivery_channel_outbox
       set status = 'ok', done_at = now(), last_error = null, response = p_response, claimed_at = null
     where id = v.id;
    if v.channel_order_id is not null then
      update delivery_channel_orders set sync_error = null where id = v.channel_order_id;
    end if;
    return jsonb_build_object('id', v.id, 'status', 'ok');
  end if;

  v_label := case v.action
               when 'accept' then 'Aceptar'
               when 'reject' then 'Rechazar'
               when 'mark_ready' then 'Listo'
               when 'mark_picked_up' then 'Retirado'
               else v.action
             end;
  if coalesce(p_retryable, true) and v.attempts < v.max_attempts then
    v_next := 'pendiente';
    update delivery_channel_outbox
       set status = 'pendiente', claimed_at = null,
           next_attempt_at = now() + make_interval(secs => delivery_channel_backoff_seconds(v.attempts)),
           last_error = left(coalesce(p_error, 'error'), 500), response = p_response
     where id = v.id;
  else
    v_next := 'error';
    update delivery_channel_outbox
       set status = 'error', claimed_at = null, done_at = now(),
           last_error = left(coalesce(p_error, 'error'), 500), response = p_response
     where id = v.id;
  end if;
  if v.channel_order_id is not null then
    update delivery_channel_orders
       set sync_error = left(v_label || ': ' || coalesce(p_error, 'error')
                             || case when v_next = 'pendiente' then ' (reintentando)' else '' end, 300)
     where id = v.channel_order_id;
  end if;
  update delivery_channel_connections
     set last_error = left(v_label || ': ' || coalesce(p_error, 'error'), 300), last_error_at = now()
   where id = v.connection_id;
  return jsonb_build_object('id', v.id, 'status', v_next);
end;
$$;
revoke all on function delivery_channel_outbox_result(uuid, boolean, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function delivery_channel_outbox_result(uuid, boolean, text, jsonb, boolean) to service_role;

-- ── 5) Reconciliación (service_role) ─────────────────────────────────────────
-- Conexiones activas cuyo adaptador sabe listar pedidos recientes y que no se
-- revisaron en los últimos 2 minutos. En el simulador, sólo si su plataforma
-- tiene pedidos cuyo webhook no salió (el caso que la reconciliación recupera).
create or replace function delivery_channel_reconcile_due(p_limit integer default 20)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'connection_id', x.id, 'tenant_id', x.tenant_id, 'provider', x.provider,
           'external_store_id', x.external_store_id, 'since', x.since)), '[]'::jsonb)
    from (select c.id, c.tenant_id, c.provider, c.external_store_id,
                 coalesce(c.last_reconciled_at, now() - interval '1 day') as since
            from delivery_channel_connections c
            join delivery_channel_providers p on p.key = c.provider
           where c.deleted_at is null and c.status = 'activa'
             and p.supports_reconcile and p.is_available
             and coalesce(c.last_reconciled_at, 'epoch'::timestamptz) < now() - interval '2 minutes'
             and tenant_has_feature_for(c.tenant_id, 'canales_delivery')
             and (c.provider <> 'simulador'
                  or exists (select 1 from delivery_channel_sim_orders s
                              where s.connection_id = c.id and not s.webhook_sent))
           order by c.last_reconciled_at nulls first
           limit greatest(least(coalesce(p_limit, 20), 100), 1)) x;
$$;
revoke all on function delivery_channel_reconcile_due(integer) from public, anon, authenticated;
grant execute on function delivery_channel_reconcile_due(integer) to service_role;

create or replace function delivery_channel_reconciled(p_connection uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update delivery_channel_connections
     set last_reconciled_at = now(),
         last_error = case when p_ok then last_error else left('Reconciliación: ' || coalesce(p_error, 'error'), 300) end,
         last_error_at = case when p_ok then last_error_at else now() end
   where id = p_connection;
end;
$$;
revoke all on function delivery_channel_reconciled(uuid, boolean, text) from public, anon, authenticated;
grant execute on function delivery_channel_reconciled(uuid, boolean, text) to service_role;

create or replace function delivery_channel_any_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from delivery_channel_outbox o
                  where (o.status = 'pendiente' and o.next_attempt_at <= now())
                     or (o.status = 'enviando' and o.claimed_at < now() - interval '2 minutes'))
      or exists (select 1 from delivery_channel_events e
                  where e.status = 'error' and e.attempts < 5 and e.received_at > now() - interval '1 day')
      or jsonb_array_length(delivery_channel_reconcile_due(1)) > 0;
$$;
revoke all on function delivery_channel_any_due() from public, anon, authenticated;
grant execute on function delivery_channel_any_due() to service_role;

-- ── 6) Plataforma del simulador (service_role) ───────────────────────────────
create or replace function delivery_channel_sim_put(p_connection uuid, p_external_order_id text,
                                                    p_payload jsonb, p_status text default 'nuevo',
                                                    p_webhook_sent boolean default true)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from delivery_channel_connections
   where id = p_connection and provider = 'simulador' and deleted_at is null;
  if v_tenant is null then
    raise exception 'connection_not_found';
  end if;
  insert into delivery_channel_sim_orders (tenant_id, connection_id, external_order_id, payload,
                                           platform_status, webhook_sent)
  values (v_tenant, p_connection, left(p_external_order_id, 120), coalesce(p_payload, '{}'::jsonb),
          left(coalesce(p_status, 'nuevo'), 20), coalesce(p_webhook_sent, true))
  on conflict (connection_id, external_order_id) do update
    set payload = case when p_payload is null or p_payload = '{}'::jsonb
                       then delivery_channel_sim_orders.payload else excluded.payload end,
        platform_status = excluded.platform_status,
        webhook_sent = delivery_channel_sim_orders.webhook_sent or excluded.webhook_sent,
        updated_at = now();
end;
$$;
revoke all on function delivery_channel_sim_put(uuid, text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function delivery_channel_sim_put(uuid, text, jsonb, text, boolean) to service_role;

create or replace function delivery_channel_sim_recent(p_connection uuid, p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('external_order_id', s.external_order_id,
                                               'payload', s.payload, 'platform_status', s.platform_status,
                                               'webhook_sent', s.webhook_sent)
                            order by s.created_at), '[]'::jsonb)
    from delivery_channel_sim_orders s
   where s.connection_id = p_connection
     and s.created_at >= coalesce(p_since, now() - interval '1 day') - interval '10 minutes';
$$;
revoke all on function delivery_channel_sim_recent(uuid, timestamptz) from public, anon, authenticated;
grant execute on function delivery_channel_sim_recent(uuid, timestamptz) to service_role;

-- Productos para armar un pedido simulado: los activos con precio, con el id
-- externo mapeado si lo tienen (si no, SIM- + SKU o id corto).
create or replace function delivery_channel_sim_products(p_connection uuid, p_limit integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'sku', p.sku, 'price', p.price,
           'external_id', coalesce(m.external_id,
                                   'SIM-' || upper(coalesce(nullif(regexp_replace(coalesce(p.sku, ''), '[^A-Za-z0-9]', '', 'g'), ''),
                                                            left(replace(p.id::text, '-', ''), 8)))))), '[]'::jsonb)
    from delivery_channel_connections c
    join lateral (
      select pr.* from products pr
       where pr.tenant_id = c.tenant_id and pr.deleted_at is null and coalesce(pr.is_active, true)
         and coalesce(pr.price, 0) > 0 and not coalesce(pr.has_variants, false)
       order by pr.created_at desc
       limit greatest(least(coalesce(p_limit, 30), 100), 1)
    ) p on true
    left join delivery_channel_product_map m
           on m.connection_id = c.id and m.kind = 'product' and m.product_id = p.id and m.deleted_at is null
   where c.id = p_connection;
$$;
revoke all on function delivery_channel_sim_products(uuid, integer) from public, anon, authenticated;
grant execute on function delivery_channel_sim_products(uuid, integer) to service_role;

-- ── 7) RPC del dueño o encargado: conexiones, credenciales y mapeo ───────────
create or replace function delivery_channel_connect(
  p_provider          text,
  p_store_id          uuid,
  p_label             text default null,
  p_external_store_id text default null,
  p_settings          jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(true);
  v_prov   delivery_channel_providers%rowtype;
  v_id     uuid := gen_random_uuid();
  v_ext    text := nullif(btrim(coalesce(p_external_store_id, '')), '');
  v_set    jsonb := coalesce(p_settings, '{}'::jsonb);
begin
  select * into v_prov from delivery_channel_providers where key = lower(coalesce(p_provider, ''));
  if not found then
    raise exception 'invalid_provider';
  end if;
  if not exists (select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null) then
    raise exception 'store_not_found';
  end if;
  if not coalesce(user_can_access_store(p_store_id), false) then
    raise exception 'store_not_allowed' using errcode = '42501';
  end if;
  if v_prov.key = 'simulador' then
    v_ext := coalesce(v_ext, 'SIM-' || upper(left(replace(v_id::text, '-', ''), 10)));
  elsif v_ext is null then
    raise exception 'external_store_required';
  end if;
  if exists (select 1 from delivery_channel_connections
              where provider = v_prov.key and external_store_id = left(v_ext, 120) and deleted_at is null) then
    raise exception 'external_store_taken';
  end if;

  insert into delivery_channel_connections (id, tenant_id, store_id, provider, label, external_store_id,
                                            status, flow, auto_accept, default_prep_minutes, billing_mode,
                                            commission_pct, created_by)
  values (v_id, v_tenant, p_store_id, v_prov.key,
          left(coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_prov.name), 80), left(v_ext, 120),
          case when v_prov.key = 'simulador' then 'activa' else 'pendiente' end,
          coalesce(nullif(v_set ->> 'flow', ''), v_prov.default_flow),
          coalesce((v_set ->> 'auto_accept')::boolean, false),
          coalesce((v_set ->> 'default_prep_minutes')::smallint, 20),
          coalesce(nullif(v_set ->> 'billing_mode', ''), 'manual'),
          coalesce((v_set ->> 'commission_pct')::numeric, 0),
          auth.uid());

  -- Secreto del webhook: lo genera el servidor y no vuelve al navegador.
  insert into delivery_channel_secrets (connection_id, tenant_id, webhook_secret)
  values (v_id, v_tenant, encode(gen_random_bytes(32), 'hex'));

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_connections', v_id, 'delivery_channel_connected',
          jsonb_build_object('provider', v_prov.key, 'store_id', p_store_id, 'external_store_id', left(v_ext, 120),
                             'settings', v_set),
          p_store_id);
  return v_id;
end;
$$;
revoke all on function delivery_channel_connect(text, uuid, text, text, jsonb) from public, anon;
grant execute on function delivery_channel_connect(text, uuid, text, text, jsonb) to authenticated;

create or replace function delivery_channel_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(true);
  v_old    delivery_channel_connections%rowtype;
  v_new    delivery_channel_connections%rowtype;
begin
  select * into v_old from delivery_channel_connections
   where id = p_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'connection_not_found';
  end if;
  if p ? 'status' and p ->> 'status' not in ('activa', 'pausada') then
    raise exception 'invalid_status';
  end if;
  if p ? 'store_id' and not exists (select 1 from stores where id = (p ->> 'store_id')::uuid
                                       and tenant_id = v_tenant and deleted_at is null) then
    raise exception 'store_not_found';
  end if;

  update delivery_channel_connections set
    label = case when p ? 'label' then left(coalesce(nullif(btrim(coalesce(p ->> 'label', '')), ''), label), 80) else label end,
    status = case when p ? 'status' then p ->> 'status' else status end,
    store_id = case when p ? 'store_id' then (p ->> 'store_id')::uuid else store_id end,
    flow = case when p ? 'flow' then p ->> 'flow' else flow end,
    auto_accept = case when p ? 'auto_accept' then (p ->> 'auto_accept')::boolean else auto_accept end,
    default_prep_minutes = case when p ? 'default_prep_minutes' then (p ->> 'default_prep_minutes')::smallint else default_prep_minutes end,
    billing_mode = case when p ? 'billing_mode' then p ->> 'billing_mode' else billing_mode end,
    commission_pct = case when p ? 'commission_pct' then (p ->> 'commission_pct')::numeric else commission_pct end,
    external_store_id = case when p ? 'external_store_id' and provider <> 'simulador'
                             then left(coalesce(nullif(btrim(coalesce(p ->> 'external_store_id', '')), ''), external_store_id), 120)
                             else external_store_id end,
    last_error = case when p ? 'status' and p ->> 'status' = 'activa' then null else last_error end
  where id = p_id
  returning * into v_new;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_connections', p_id, 'delivery_channel_updated',
          jsonb_build_object('status', v_old.status, 'flow', v_old.flow, 'auto_accept', v_old.auto_accept,
                             'default_prep_minutes', v_old.default_prep_minutes, 'billing_mode', v_old.billing_mode,
                             'commission_pct', v_old.commission_pct, 'store_id', v_old.store_id,
                             'external_store_id', v_old.external_store_id),
          jsonb_build_object('status', v_new.status, 'flow', v_new.flow, 'auto_accept', v_new.auto_accept,
                             'default_prep_minutes', v_new.default_prep_minutes, 'billing_mode', v_new.billing_mode,
                             'commission_pct', v_new.commission_pct, 'store_id', v_new.store_id,
                             'external_store_id', v_new.external_store_id),
          v_new.store_id);
  return jsonb_build_object('id', p_id, 'status', v_new.status);
exception when unique_violation then
  raise exception 'external_store_taken';
end;
$$;
revoke all on function delivery_channel_update(uuid, jsonb) from public, anon;
grant execute on function delivery_channel_update(uuid, jsonb) to authenticated;

create or replace function delivery_channel_disconnect(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(true);
  v_conn   delivery_channel_connections%rowtype;
begin
  select * into v_conn from delivery_channel_connections
   where id = p_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'connection_not_found';
  end if;
  update delivery_channel_connections set status = 'pausada', deleted_at = now() where id = p_id;
  -- Lo que estaba por enviar ya no sale.
  update delivery_channel_outbox set status = 'descartado', done_at = now(), last_error = 'Conexión desconectada'
   where connection_id = p_id and status in ('pendiente', 'enviando');
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_connections', p_id, 'delivery_channel_disconnected',
          left(nullif(btrim(coalesce(p_reason, '')), ''), 300),
          jsonb_build_object('provider', v_conn.provider, 'external_store_id', v_conn.external_store_id),
          v_conn.store_id);
end;
$$;
revoke all on function delivery_channel_disconnect(uuid, text) from public, anon;
grant execute on function delivery_channel_disconnect(uuid, text) to authenticated;

-- Credenciales: sólo escritura (nunca se devuelven los valores). Una clave
-- 'webhook_secret' reemplaza el secreto con el que la plataforma firma.
create or replace function delivery_channel_set_credentials(p_id uuid, p_credentials jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(true);
  v_conn   delivery_channel_connections%rowtype;
  v_creds  jsonb;
  v_keys   text[];
begin
  select * into v_conn from delivery_channel_connections
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'connection_not_found';
  end if;
  if coalesce(jsonb_typeof(p_credentials), '') <> 'object' or octet_length(p_credentials::text) > 8192 then
    raise exception 'invalid_credentials';
  end if;
  if p_credentials ? 'webhook_secret'
     and char_length(coalesce(p_credentials ->> 'webhook_secret', '')) < 16 then
    raise exception 'webhook_secret_too_short';
  end if;
  -- Valores vacíos borran la clave.
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_creds
    from jsonb_each(p_credentials) as e(k, v)
   where k <> 'webhook_secret' and v <> 'null'::jsonb and v <> '""'::jsonb;
  select coalesce(array_agg(k order by k), '{}') into v_keys from jsonb_object_keys(p_credentials) as k;

  update delivery_channel_secrets
     set credentials = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                          from jsonb_each(credentials || v_creds) as e(k, v)
                         where not (p_credentials ? k and (p_credentials -> k = 'null'::jsonb or p_credentials -> k = '""'::jsonb))),
         webhook_secret = case when p_credentials ? 'webhook_secret' then p_credentials ->> 'webhook_secret'
                               else webhook_secret end,
         updated_at = now()
   where connection_id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_connections', p_id, 'delivery_channel_credentials_set',
          jsonb_build_object('keys', v_keys), v_conn.store_id);
  return delivery_channel_credential_keys(p_id);
end;
$$;

-- Qué claves tiene guardadas (sin valores).
create or replace function delivery_channel_credential_keys(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_out    jsonb;
begin
  if v_tenant is null or not is_tenant_manager() then
    raise exception 'forbidden_role' using errcode = '42501';
  end if;
  select jsonb_build_object(
           'keys', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(s.credentials) as k), '[]'::jsonb),
           'has_webhook_secret', s.webhook_secret is not null,
           'updated_at', s.updated_at)
    into v_out
    from delivery_channel_secrets s
    join delivery_channel_connections c on c.id = s.connection_id
   where s.connection_id = p_id and c.tenant_id = v_tenant;
  if v_out is null then
    raise exception 'connection_not_found';
  end if;
  return v_out;
end;
$$;
revoke all on function delivery_channel_credential_keys(uuid) from public, anon;
grant execute on function delivery_channel_credential_keys(uuid) to authenticated;
revoke all on function delivery_channel_set_credentials(uuid, jsonb) from public, anon;
grant execute on function delivery_channel_set_credentials(uuid, jsonb) to authenticated;

-- Mapeo en lote: [{ kind, external_id, external_name, product_id,
-- modifier_option_id }]. Sin destino (product_id y modifier_option_id nulos)
-- se desmapea (baja lógica).
create or replace function delivery_channel_map_set(p_connection uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(true);
  v_r      jsonb;
  v_kind   text;
  v_ext    text;
  v_pid    uuid;
  v_opt    uuid;
  v_set    int := 0;
  v_del    int := 0;
begin
  if not exists (select 1 from delivery_channel_connections
                  where id = p_connection and tenant_id = v_tenant and deleted_at is null) then
    raise exception 'connection_not_found';
  end if;
  if coalesce(jsonb_typeof(p_rows), '') <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'invalid_rows';
  end if;

  for v_r in select * from jsonb_array_elements(p_rows) loop
    v_kind := case when v_r ->> 'kind' = 'modifier' then 'modifier' else 'product' end;
    v_ext := left(nullif(btrim(coalesce(v_r ->> 'external_id', '')), ''), 120);
    if v_ext is null then
      raise exception 'external_id_required';
    end if;
    v_pid := nullif(v_r ->> 'product_id', '')::uuid;
    v_opt := nullif(v_r ->> 'modifier_option_id', '')::uuid;

    if v_pid is null and v_opt is null then
      update delivery_channel_product_map set deleted_at = now()
       where connection_id = p_connection and kind = v_kind and external_id = v_ext and deleted_at is null;
      v_del := v_del + 1;
      continue;
    end if;
    if v_kind = 'product' then
      if not exists (select 1 from products where id = v_pid and tenant_id = v_tenant and deleted_at is null) then
        raise exception 'product_not_found';
      end if;
      if exists (select 1 from products where id = v_pid and tenant_id = v_tenant and coalesce(has_variants, false)) then
        raise exception 'variant_product_not_supported';
      end if;
      v_opt := null;
    else
      if not exists (select 1 from product_modifier_options where id = v_opt and tenant_id = v_tenant) then
        raise exception 'modifier_not_found';
      end if;
      v_pid := null;
    end if;

    insert into delivery_channel_product_map (tenant_id, connection_id, kind, external_id, external_name,
                                              product_id, modifier_option_id, created_by)
    values (v_tenant, p_connection, v_kind, v_ext,
            left(nullif(btrim(coalesce(v_r ->> 'external_name', '')), ''), 200), v_pid, v_opt, auth.uid())
    on conflict (connection_id, kind, external_id) where deleted_at is null do update
      set product_id = excluded.product_id, modifier_option_id = excluded.modifier_option_id,
          external_name = coalesce(excluded.external_name, delivery_channel_product_map.external_name);
    v_set := v_set + 1;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'delivery_channel_connections', p_connection, 'delivery_channel_mapping_set',
          jsonb_build_object('mapped', v_set, 'unmapped', v_del));
  return jsonb_build_object('mapped', v_set, 'unmapped', v_del);
end;
$$;
revoke all on function delivery_channel_map_set(uuid, jsonb) from public, anon;
grant execute on function delivery_channel_map_set(uuid, jsonb) to authenticated;

create or replace function delivery_channel_outbox_retry(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(true);
begin
  update delivery_channel_outbox
     set status = 'pendiente', attempts = 0, next_attempt_at = now(), done_at = null, claimed_at = null
   where id = p_id and tenant_id = v_tenant and status in ('error', 'descartado');
  if not found then
    raise exception 'outbox_not_retryable';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action)
  values (v_tenant, auth.uid(), 'delivery_channel_outbox', p_id, 'delivery_channel_outbox_retry');
end;
$$;
revoke all on function delivery_channel_outbox_retry(uuid) from public, anon;
grant execute on function delivery_channel_outbox_retry(uuid) to authenticated;

-- ── 8) Acciones del local sobre el pedido ────────────────────────────────────
create or replace function _channel_order_for_user(p_id uuid, p_tenant uuid)
returns delivery_channel_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co delivery_channel_orders%rowtype;
begin
  select * into v_co from delivery_channel_orders where id = p_id and tenant_id = p_tenant for update;
  if not found then
    raise exception 'channel_order_not_found';
  end if;
  return v_co;
end;
$$;
revoke all on function _channel_order_for_user(uuid, uuid) from public, anon, authenticated;

create or replace function delivery_channel_order_accept(p_id uuid, p_prep_minutes integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(false);
  v_co     delivery_channel_orders%rowtype := _channel_order_for_user(p_id, v_tenant);
  v_prep   integer;
begin
  if not _channel_can_transition(v_co.external_status, 'aceptado') then
    raise exception 'invalid_transition: % -> aceptado', v_co.external_status;
  end if;
  select greatest(least(coalesce(p_prep_minutes, c.default_prep_minutes), 180), 1) into v_prep
    from delivery_channel_connections c where c.id = v_co.connection_id;
  perform _channel_apply_status(v_co.id, 'aceptado', v_prep);
  perform _channel_enqueue(v_co.id, 'accept', jsonb_build_object('prep_minutes', v_prep));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_orders', v_co.id, 'channel_order_accepted',
          jsonb_build_object('prep_minutes', v_prep, 'external_order_id', v_co.external_order_id),
          v_co.store_id);
  return jsonb_build_object('id', v_co.id, 'external_status', 'aceptado', 'prep_minutes', v_prep);
end;
$$;
revoke all on function delivery_channel_order_accept(uuid, integer) from public, anon;
grant execute on function delivery_channel_order_accept(uuid, integer) to authenticated;

create or replace function delivery_channel_order_reject(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(false);
  v_co     delivery_channel_orders%rowtype := _channel_order_for_user(p_id, v_tenant);
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v_reason) < 3 then
    raise exception 'reject_reason_required';
  end if;
  if v_co.external_status <> 'nuevo' then
    raise exception 'invalid_transition: % -> rechazado', v_co.external_status;
  end if;
  perform _channel_cancel(v_co.id, 'rechazado', v_reason);
  perform _channel_enqueue(v_co.id, 'reject', jsonb_build_object('reason', left(v_reason, 200)));
  return jsonb_build_object('id', v_co.id, 'external_status', 'rechazado');
end;
$$;
revoke all on function delivery_channel_order_reject(uuid, text) from public, anon;
grant execute on function delivery_channel_order_reject(uuid, text) to authenticated;

-- Factura el pedido en el turno de quien lo hace (create_sale con
-- p_delivery_order_id, el flujo de cobro de delivery_orders). Prepago: medio
-- 'plataforma' por el total, sin movimiento de caja. Efectivo (cobra el
-- repartidor del local): medio efectivo, entra a la caja del turno.
create or replace function _channel_bill(p_id uuid, p_cash_shift_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_co     delivery_channel_orders%rowtype;
  v_do     delivery_orders%rowtype;
  v_shift  uuid;
  v_store  uuid;
  v_reg    uuid;
  v_round  numeric;
  v_items  jsonb;
  v_sum    numeric;
  v_amount numeric;
  v_brand  text;
  v_res    jsonb;
  v_sale   uuid;
begin
  select * into v_co from delivery_channel_orders where id = p_id and tenant_id = v_tenant for update;
  if not found then
    raise exception 'channel_order_not_found';
  end if;
  if v_co.billing_status = 'facturado' or v_co.sale_id is not null then
    raise exception 'channel_order_already_billed';
  end if;
  if v_co.external_status in ('nuevo', 'rechazado', 'cancelado') then
    raise exception 'channel_order_not_billable';
  end if;
  select * into v_do from delivery_orders where id = v_co.delivery_order_id and tenant_id = v_tenant;
  if v_do.sale_id is not null then
    raise exception 'channel_order_already_billed';
  end if;

  -- El turno de quien factura (H114: nadie vende en el turno de otro) y de la
  -- sucursal de la conexión.
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, true) r;
  if v_shift is null then
    raise exception 'no_open_shift';
  end if;
  if v_store is distinct from v_co.store_id then
    raise exception 'channel_wrong_store';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', i.product_id, 'name', i.name, 'quantity', i.qty,
           'unit_price', i.unit_price, 'discount', 0, 'modifiers', i.modifiers)
           order by i.created_at), '[]'::jsonb),
         coalesce(sum(round(i.qty * i.unit_price, 2)), 0)
    into v_items, v_sum
    from delivery_order_items i
   where i.order_id = v_do.id and i.tenant_id = v_tenant and i.qty > 0;
  if jsonb_array_length(v_items) = 0 then
    raise exception 'empty_sale';
  end if;

  -- Mismo total que calcula create_sale: redondeo de la configuración efectiva
  -- de la sucursal y la caja, y después el envío del pedido.
  select cs.cash_register_id into v_reg from cash_shifts cs where cs.id = v_shift;
  v_round := coalesce((_effective_config(v_tenant, 'pos_settings', '', v_store, v_reg) -> 'value'
                       ->> 'rounding_multiple')::numeric, 0);
  v_amount := case when v_round > 0 then round(v_sum / v_round) * v_round else v_sum end
              + greatest(coalesce(v_do.delivery_fee, 0), 0);

  select name into v_brand from delivery_channel_providers where key = v_co.brand;

  v_res := create_sale(
    p_items => v_items,
    p_payments => jsonb_build_array(jsonb_build_object(
      'method', case when v_co.payment_mode = 'efectivo' then 'cash' else 'plataforma' end,
      'amount', v_amount,
      'reference', left(v_co.brand || ':' || v_co.external_order_id, 120))),
    p_notes => left(coalesce(v_brand, 'App') || ' #'
                    || coalesce(v_co.external_display_code, v_co.external_order_id), 200),
    p_delivery_order_id => v_do.id,
    p_cash_shift_id => v_shift);
  v_sale := (v_res ->> 'sale_id')::uuid;

  update delivery_channel_orders
     set billing_status = 'facturado', billing_error = null, billed_at = now(), sale_id = v_sale
   where id = v_co.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_orders', v_co.id, 'channel_order_billed',
          jsonb_build_object('sale_id', v_sale, 'amount', v_amount, 'cash_shift_id', v_shift,
                             'payment_mode', v_co.payment_mode, 'external_order_id', v_co.external_order_id),
          v_store);
  return jsonb_build_object('id', v_co.id, 'sale_id', v_sale, 'number', v_res -> 'number', 'total', v_res -> 'total');
end;
$$;
revoke all on function _channel_bill(uuid, uuid) from public, anon, authenticated;

-- Retirado / entregado: avisa a la app y, con facturación automática, factura
-- en el turno de quien lo marca. Si no puede (sin turno, otra sucursal, sin
-- stock) queda "a facturar" con el motivo y el retiro no se pierde.
create or replace function _channel_finish(p_id uuid, p_to text, p_cash_shift_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(false);
  v_co     delivery_channel_orders%rowtype := _channel_order_for_user(p_id, v_tenant);
  v_mode   text;
  v_bill   jsonb;
  v_err    text;
begin
  if not _channel_can_transition(v_co.external_status, p_to) then
    raise exception 'invalid_transition: % -> %', v_co.external_status, p_to;
  end if;
  perform _channel_apply_status(v_co.id, p_to, null);
  if p_to = 'retirado' then
    perform _channel_enqueue(v_co.id, 'mark_picked_up', '{}'::jsonb);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_orders', v_co.id,
          case when p_to = 'retirado' then 'channel_order_picked_up' else 'channel_order_delivered' end,
          jsonb_build_object('external_order_id', v_co.external_order_id), v_co.store_id);

  select billing_mode into v_mode from delivery_channel_connections where id = v_co.connection_id;
  if v_mode = 'auto' and v_co.billing_status in ('pendiente', 'error') and v_co.sale_id is null then
    begin
      v_bill := _channel_bill(v_co.id, p_cash_shift_id);
    exception when others then
      v_err := left(sqlerrm, 300);
      update delivery_channel_orders set billing_status = 'error', billing_error = v_err where id = v_co.id;
    end;
  end if;
  return jsonb_build_object('id', v_co.id, 'external_status', p_to, 'billing', v_bill, 'billing_error', v_err);
end;
$$;
revoke all on function _channel_finish(uuid, text, uuid) from public, anon, authenticated;

create or replace function delivery_channel_order_ready(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(false);
  v_co     delivery_channel_orders%rowtype := _channel_order_for_user(p_id, v_tenant);
begin
  if not _channel_can_transition(v_co.external_status, 'listo') then
    raise exception 'invalid_transition: % -> listo', v_co.external_status;
  end if;
  perform _channel_apply_status(v_co.id, 'listo', null);
  perform _channel_enqueue(v_co.id, 'mark_ready', '{}'::jsonb);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_orders', v_co.id, 'channel_order_ready',
          jsonb_build_object('external_order_id', v_co.external_order_id), v_co.store_id);
  return jsonb_build_object('id', v_co.id, 'external_status', 'listo');
end;
$$;
revoke all on function delivery_channel_order_ready(uuid) from public, anon;
grant execute on function delivery_channel_order_ready(uuid) to authenticated;

create or replace function delivery_channel_order_picked_up(p_id uuid, p_cash_shift_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return _channel_finish(p_id, 'retirado', p_cash_shift_id);
end;
$$;
revoke all on function delivery_channel_order_picked_up(uuid, uuid) from public, anon;
grant execute on function delivery_channel_order_picked_up(uuid, uuid) to authenticated;

create or replace function delivery_channel_order_delivered(p_id uuid, p_cash_shift_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return _channel_finish(p_id, 'entregado', p_cash_shift_id);
end;
$$;
revoke all on function delivery_channel_order_delivered(uuid, uuid) from public, anon;
grant execute on function delivery_channel_order_delivered(uuid, uuid) to authenticated;

-- Facturar a mano (o reintentar una facturación que falló).
create or replace function delivery_channel_order_bill(p_id uuid, p_cash_shift_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(false);
begin
  perform _channel_order_for_user(p_id, v_tenant);
  return _channel_bill(p_id, p_cash_shift_id);
end;
$$;
revoke all on function delivery_channel_order_bill(uuid, uuid) from public, anon;
grant execute on function delivery_channel_order_bill(uuid, uuid) to authenticated;

-- Facturación automática pendiente: lo retirado o entregado por la app (sin
-- sesión, no tiene turno) se factura cuando el tablero lo ve abierto en el
-- turno de alguien de esa sucursal. Devuelve cuántos facturó y cuántos fallaron.
create or replace function delivery_channel_bill_pending(p_cash_shift_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(false);
  v_shift  uuid;
  v_store  uuid;
  v_id     uuid;
  v_ok     int := 0;
  v_fail   int := 0;
begin
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, false) r;
  if v_shift is null then
    return jsonb_build_object('billed', 0, 'failed', 0, 'reason', 'no_open_shift');
  end if;
  for v_id in
    select co.id
      from delivery_channel_orders co
      join delivery_channel_connections c on c.id = co.connection_id
     where co.tenant_id = v_tenant and co.store_id = v_store
       and co.billing_status = 'pendiente' and co.sale_id is null
       and co.external_status in ('retirado', 'entregado')
       and c.billing_mode = 'auto'
     order by co.created_at
     limit 20
  loop
    begin
      perform _channel_bill(v_id, v_shift);
      v_ok := v_ok + 1;
    exception when others then
      update delivery_channel_orders set billing_status = 'error', billing_error = left(sqlerrm, 300)
       where id = v_id;
      v_fail := v_fail + 1;
    end;
  end loop;
  return jsonb_build_object('billed', v_ok, 'failed', v_fail);
end;
$$;
revoke all on function delivery_channel_bill_pending(uuid) from public, anon;
grant execute on function delivery_channel_bill_pending(uuid) to authenticated;

-- Cerrar sin facturar (dueño o encargado, con motivo): p. ej. la app emite el
-- comprobante o el pedido se regaló. Auditado.
create or replace function delivery_channel_order_close_unbilled(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _channel_assert(true);
  v_co     delivery_channel_orders%rowtype := _channel_order_for_user(p_id, v_tenant);
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  if v_co.billing_status not in ('pendiente', 'error') or v_co.sale_id is not null then
    raise exception 'channel_order_not_billable';
  end if;
  if v_co.external_status not in ('retirado', 'entregado') then
    raise exception 'channel_order_not_finished';
  end if;
  update delivery_channel_orders set billing_status = 'no_facturar', billing_error = null where id = v_co.id;
  update delivery_orders set status = 'entregado', updated_at = now()
   where id = v_co.delivery_order_id and tenant_id = v_tenant and sale_id is null;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data, store_id)
  values (v_tenant, auth.uid(), 'delivery_channel_orders', v_co.id, 'channel_order_closed_unbilled', v_reason,
          jsonb_build_object('external_order_id', v_co.external_order_id, 'total', v_co.total), v_co.store_id);
  return jsonb_build_object('id', v_co.id, 'billing_status', 'no_facturar');
end;
$$;
revoke all on function delivery_channel_order_close_unbilled(uuid, text) from public, anon;
grant execute on function delivery_channel_order_close_unbilled(uuid, text) to authenticated;

-- ── 9) Cocina: todo listo en el KDS -> pedido listo y aviso a la app ─────────
create or replace function _channel_kds_ready()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co delivery_channel_orders%rowtype;
begin
  select * into v_co from delivery_channel_orders
   where delivery_order_id = new.order_id and tenant_id = new.tenant_id;
  if not found or v_co.external_status <> 'aceptado' then
    return null;
  end if;
  if exists (select 1 from delivery_order_items i
              where i.order_id = new.order_id and i.tenant_id = new.tenant_id
                and i.qty > 0 and i.kds_status not in ('listo', 'entregado')) then
    return null;
  end if;
  perform _channel_apply_status(v_co.id, 'listo', null);
  perform _channel_enqueue(v_co.id, 'mark_ready', jsonb_build_object('from_kds', true));
  return null;
end;
$$;
revoke all on function _channel_kds_ready() from public, anon, authenticated;

drop trigger if exists delivery_order_items_channel_ready on delivery_order_items;
create trigger delivery_order_items_channel_ready
  after update of kds_status on delivery_order_items
  for each row
  when (new.kds_status = 'listo' and old.kds_status is distinct from 'listo')
  execute function _channel_kds_ready();

-- ── 10) Cobro por el camino de siempre (/pos?delivery=<id>) ──────────────────
-- Si alguien cobra el pedido de app desde el POS (create_sale con
-- p_delivery_order_id), el pedido externo queda facturado igual: nunca dos
-- ventas por un pedido (create_sale ya rechaza un pedido cobrado).
create or replace function _channel_delivery_charged()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update delivery_channel_orders
     set billing_status = 'facturado', billing_error = null, billed_at = coalesce(billed_at, now()),
         sale_id = new.sale_id
   where delivery_order_id = new.id and tenant_id = new.tenant_id
     and sale_id is null and billing_status in ('pendiente', 'error');
  return null;
end;
$$;
revoke all on function _channel_delivery_charged() from public, anon, authenticated;

drop trigger if exists delivery_orders_channel_charged on delivery_orders;
create trigger delivery_orders_channel_charged
  after update of sale_id on delivery_orders
  for each row
  when (new.sale_id is not null and old.sale_id is null and new.channel = 'app')
  execute function _channel_delivery_charged();
