-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · Gastronomía — H48: Pedido de MOSTRADOR (cafetería/heladería)        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Cafetería/heladería/panadería de mostrador: el cliente pide en la barra, se le
-- toma el pedido con su NOMBRE / número de orden, va a la barra/cocina (KDS) para
-- prepararlo, y se marca "listo para retirar". Es un tercer tipo de pedido junto
-- a delivery y takeaway, SIN dirección ni cadete ni envío (como takeaway pero
-- con su propia etiqueta y flujo de barra).
--
-- Reusa TODA la infraestructura de delivery_orders: ítems → KDS (la etiqueta
-- "MOSTRADOR #XXXX" sale sola de _delivery_order_label porque usa upper(type)),
-- board, comanda y el cobro por el POS. Cambios mínimos: (1) permitir el tipo
-- 'mostrador' en el CHECK y en create_delivery_order (tratado como takeaway para
-- dirección/fee), (2) set_delivery_status acepta los estados de mostrador
-- (recibido→preparando→listo→entregado, como takeaway).
--
-- ALCANCE: esta entrega es el tipo de pedido + barra/KDS + cobro al final (por el
-- flujo de delivery existente). El "COBRAR ANTES" (mantener el pedido en el KDS
-- después de cobrar) requiere modificar create_sale (la función de cobro de TODA
-- venta) y queda como follow-up con su propio plan.

-- ── 1) Permitir order_type = 'mostrador' ──────────────────────────────────────
alter table delivery_orders drop constraint if exists delivery_orders_order_type_check;
alter table delivery_orders
  add constraint delivery_orders_order_type_check
  check (order_type in ('delivery','takeaway','mostrador'));

-- ── 2) create_delivery_order: + tipo 'mostrador' (recrea la versión con zona) ─
-- Idéntica a la versión H49+zonas; sólo: valida 'mostrador' y lo trata como
-- takeaway para dirección/fee (sin dirección, envío 0, sin zona).
create or replace function create_delivery_order(
  p_channel        text,
  p_order_type     text,
  p_customer_id    uuid    default null,
  p_customer_name  text    default null,
  p_customer_phone text    default null,
  p_address        text    default null,
  p_address_ref    text    default null,
  p_promised_at    timestamptz default null,
  p_courier_name   text    default null,
  p_delivery_fee   numeric default null,
  p_notes          text    default null,
  p_zone_id        uuid    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := _dining_assert_member();
  v_type     text := lower(coalesce(nullif(btrim(p_order_type), ''), 'delivery'));
  v_channel  text := lower(coalesce(nullif(btrim(p_channel), ''), 'telefono'));
  v_order_id uuid;
  v_zone_id  uuid := null;
  v_zone_fee numeric;
  v_fee      numeric;
  -- Tipos SIN dirección/envío (mostrador y takeaway: retira el cliente).
  v_no_addr  boolean := lower(coalesce(nullif(btrim(p_order_type), ''), 'delivery')) in ('takeaway','mostrador');
begin
  if v_type not in ('delivery','takeaway','mostrador') then
    raise exception 'invalid_order_type';
  end if;
  if v_channel not in ('mostrador','telefono','whatsapp','qr','delivery_propio') then
    raise exception 'invalid_channel';
  end if;
  if p_customer_id is not null
     and not exists (
       select 1 from customers
        where id = p_customer_id and tenant_id = v_tenant and deleted_at is null
     ) then
    raise exception 'customer_not_found';
  end if;

  -- Zona: sólo para delivery.
  if v_type = 'delivery' and p_zone_id is not null then
    select id, fee into v_zone_id, v_zone_fee
      from delivery_zones
     where id = p_zone_id and tenant_id = v_tenant and deleted_at is null;
    if v_zone_id is null then
      raise exception 'zone_not_found';
    end if;
  end if;

  -- Fee final: takeaway/mostrador = 0; delivery = fee explícito o de la zona.
  if v_no_addr then
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
    -- Mostrador/takeaway no llevan dirección.
    case when v_no_addr then null else nullif(btrim(p_address), '') end,
    case when v_no_addr then null else nullif(btrim(p_address_ref), '') end,
    p_promised_at, nullif(btrim(p_courier_name), ''),
    v_fee,
    'recibido', nullif(btrim(p_notes), ''), v_zone_id, auth.uid()
  )
  returning id into v_order_id;

  return jsonb_build_object('order_id', v_order_id, 'status', 'recibido',
                            'order_type', v_type);
end;
$$;

-- ── 3) set_delivery_status: estados de mostrador (como takeaway) ──────────────
-- Idéntica a la H49; sólo: mostrador usa el set de estados de takeaway
-- (recibido→preparando→listo→entregado, sin en_camino).
create or replace function set_delivery_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  delivery_orders%rowtype;
  v_allowed text[];
begin
  select * into v_order from delivery_orders
   where id = p_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status in ('entregado','cancelado') then
    raise exception 'order_closed';
  end if;

  -- Estados válidos por tipo. Mostrador y takeaway: retiro (listo); delivery: ruta.
  if v_order.order_type in ('takeaway','mostrador') then
    v_allowed := array['recibido','preparando','listo','entregado','cancelado'];
  else
    v_allowed := array['recibido','preparando','en_camino','entregado','cancelado'];
  end if;
  if not (p_status = any(v_allowed)) then
    raise exception 'invalid_status';
  end if;

  if p_status = 'entregado' and v_order.sale_id is null then
    raise exception 'deliver_needs_charge';
  end if;

  update delivery_orders set status = p_status, updated_at = now()
   where id = p_id and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'delivery_orders', p_id, 'delivery_status',
          jsonb_build_object('status', v_order.status),
          jsonb_build_object('status', p_status));

  return jsonb_build_object('order_id', p_id, 'status', p_status);
end;
$$;
