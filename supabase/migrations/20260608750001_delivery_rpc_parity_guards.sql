-- =============================================================================
-- 20260608750001_delivery_rpc_parity_guards  (FIX 🟡 — guards de paridad)
--
-- Dos guards de defensa en profundidad detectados en el review de delivery:
--   1. create_delivery_order: el delivery exige dirección de entrega también
--      server-side (antes solo lo validaba el modal). Takeaway no se afecta.
--   2. set_delivery_order_item_qty: aborta si el pedido padre no existe tras el
--      SELECT ... FOR UPDATE (como las otras RPC de delivery/mesa).
-- Re-aplican las funciones con la definición exacta del remoto.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_delivery_order(p_channel text, p_order_type text, p_customer_id uuid DEFAULT NULL::uuid, p_customer_name text DEFAULT NULL::text, p_customer_phone text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_address_ref text DEFAULT NULL::text, p_promised_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_courier_name text DEFAULT NULL::text, p_delivery_fee numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text, p_zone_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant   uuid := _dining_assert_member();
  v_type     text := lower(coalesce(nullif(btrim(p_order_type), ''), 'delivery'));
  v_channel  text := lower(coalesce(nullif(btrim(p_channel), ''), 'telefono'));
  v_order_id uuid;
  v_zone_id  uuid := null;
  v_zone_fee numeric;
  v_fee      numeric;
begin
  if v_type not in ('delivery','takeaway') then
    raise exception 'invalid_order_type';
  end if;
  if v_channel not in ('mostrador','telefono','whatsapp','qr','delivery_propio') then
    raise exception 'invalid_channel';
  end if;
  -- Paridad server-side (🟡): el delivery necesita dirección de entrega.
  if v_type = 'delivery' and nullif(btrim(coalesce(p_address, '')), '') is null then
    raise exception 'address_required';
  end if;
  if p_customer_id is not null
     and not exists (
       select 1 from customers
        where id = p_customer_id and tenant_id = v_tenant and deleted_at is null
     ) then
    raise exception 'customer_not_found';
  end if;

  if v_type = 'delivery' and p_zone_id is not null then
    select id, fee into v_zone_id, v_zone_fee
      from delivery_zones
     where id = p_zone_id and tenant_id = v_tenant and deleted_at is null;
    if v_zone_id is null then
      raise exception 'zone_not_found';
    end if;
  end if;

  if v_type = 'takeaway' then
    v_fee := 0;
  elsif p_delivery_fee is not null then
    v_fee := greatest(p_delivery_fee, 0);
  elsif v_zone_id is not null then
    v_fee := greatest(coalesce(v_zone_fee, 0), 0);
  else
    v_fee := 0;
  end if;

  insert into delivery_orders (
    tenant_id, channel, order_type, customer_id, customer_name, customer_phone,
    address, address_reference, promised_at, courier_name, delivery_fee,
    status, notes, zone_id, created_by
  )
  values (
    v_tenant, v_channel, v_type, p_customer_id,
    nullif(btrim(p_customer_name), ''), nullif(btrim(p_customer_phone), ''),
    case when v_type = 'takeaway' then null else nullif(btrim(p_address), '') end,
    case when v_type = 'takeaway' then null else nullif(btrim(p_address_ref), '') end,
    p_promised_at, nullif(btrim(p_courier_name), ''),
    v_fee,
    'recibido', nullif(btrim(p_notes), ''), v_zone_id, auth.uid()
  )
  returning id into v_order_id;

  return jsonb_build_object('order_id', v_order_id, 'status', 'recibido',
                            'order_type', v_type);
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_delivery_order_item_qty(p_item_id uuid, p_qty numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant uuid := _dining_assert_member();
  v_item   delivery_order_items%rowtype;
  v_order  delivery_orders%rowtype;
begin
  select i.* into v_item from delivery_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;
  select * into v_order from delivery_orders
   where id = v_item.order_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status = 'cancelado' or v_order.sale_id is not null then
    raise exception 'order_not_open';
  end if;

  if coalesce(p_qty, 0) <= 0 then
    delete from delivery_order_items where id = p_item_id and tenant_id = v_tenant;
    update delivery_orders set updated_at = now() where id = v_item.order_id;
    return jsonb_build_object('removed', true, 'item_id', p_item_id);
  end if;

  update delivery_order_items set qty = p_qty where id = p_item_id and tenant_id = v_tenant;
  update delivery_orders set updated_at = now() where id = v_item.order_id;
  return jsonb_build_object('removed', false, 'item_id', p_item_id, 'qty', p_qty);
end;
$function$;
