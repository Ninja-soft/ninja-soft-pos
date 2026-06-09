-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · H49 — Delivery y take away (pedidos, board por estado, cadete)       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- HERMANO de H44 (mesas) pero SIN mesa: pedidos de delivery / take away con
-- canal, cliente/teléfono, dirección + referencia, horario prometido, cadete y
-- costo de envío. Espeja EXACTO el patrón de mesas (table_orders /
-- table_order_items + RPCs SECURITY DEFINER tenant-scoped con guard de miembro
-- activo `_dining_assert_member()`), reusando el KDS/comanda y el cobro atómico
-- del POS (create_sale).
--
-- MODELO (espeja H44):
--   1) PEDIDO = `delivery_orders` (la "cuenta" del delivery/takeaway). Estados de
--      DELIVERY: recibido / preparando / en_camino / entregado / cancelado.
--      Estados de TAKEAWAY: recibido / preparando / listo / entregado / cancelado
--      (validamos por order_type en set_delivery_status). `sale_id` enlaza la
--      venta al cobrar; NULL mientras no se cobró.
--   2) LÍNEAS = `delivery_order_items` (ESPEJA table_order_items: name, qty,
--      unit_price, modifiers, notes, station, kds_status, kds_ready_at,
--      printed_at, course, fired_at).
--
-- COBRO: el POS arranca con los ítems del pedido + el costo de envío como línea
-- libre en el carrito (/pos?delivery=<id>) y cobra con el flujo normal; al
-- confirmar, create_sale (con p_delivery_order_id) toma el pedido FOR UPDATE,
-- valida que no esté cobrado y, en la MISMA transacción, lo enlaza (sale_id),
-- lo marca 'entregado' y registra audit. Espeja la rama de mesa de create_sale
-- (no hay close aparte → sin doble cobro por concurrencia).
--
-- DELIVERY FEE en la venta: lo más limpio y sin tocar los totales/redondeo de
-- create_sale → el POS carga el delivery_fee como una LÍNEA LIBRE ("Costo de
-- envío") en el carrito. Así el fee entra al subtotal/total por el camino normal
-- (igual que un ítem libre). create_sale NO calcula el fee: sólo enlaza el
-- pedido. Documentado también en el front (pos/page.tsx ?delivery=).
--
-- KDS / COMANDA: kds_tickets y comanda_items ahora UNEN mesa + delivery. Se
-- agrega una columna `source` ('mesa' | 'delivery') y `source_label` (etiqueta
-- de cabecera: "Mesa 5" / "DELIVERY #1234" / "TAKEAWAY #1234"). Se preserva
-- TODO: tenant guard, filtro de estación, excluir 'entregado', fired_at not null,
-- orden FIFO. La cocina ve los pedidos de delivery con su identificador.
--
-- GATING: pos_settings.delivery_enabled (bool default false). ADITIVO: con off,
-- nada de delivery se muestra (el nav y la vista /delivery se gatean con esta
-- key, igual que dining_enabled gatea /salon). Delivery NO requiere mesas.
--
-- FUERA DE ALCANCE (follow-up, NO en este PR): integración marketplace
-- (PedidosYa/Rappi), tracking GPS del cadete, mapa/geocoding de direcciones,
-- zonas de envío con tarifa automática, tiempos automáticos por estado,
-- notificación al cliente por WhatsApp del estado.
-- types/database.ts NO se regenera (el front castea; la DB + RLS validan).
-- =============================================================================

-- ── 0) Gating: toggle de delivery por tenant ─────────────────────────────────
-- Default false: el POS mostrador no cambia. El dueño lo activa en Configuración
-- → Operación. El nav (/delivery) y la vista se gatean con esta key.
alter table pos_settings add column if not exists delivery_enabled boolean not null default false;

-- ── 1) Pedido de delivery / takeaway (la "cuenta") ───────────────────────────
create table if not exists delivery_orders (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  -- Canal de entrada del pedido (lista fija razonable).
  channel           text not null default 'telefono'
                      check (channel in ('mostrador','telefono','whatsapp','qr','delivery_propio')),
  -- Tipo: delivery (con dirección + cadete) o takeaway (retira el cliente).
  order_type        text not null default 'delivery'
                      check (order_type in ('delivery','takeaway')),
  -- Cliente del catálogo (opcional) + snapshot de nombre/teléfono para el pedido.
  customer_id       uuid references customers(id) on delete set null,
  customer_name     text,
  customer_phone    text,
  -- Dirección de entrega (null para takeaway) + referencia (timbre, piso, etc.).
  address           text,
  address_reference text,
  -- Horario prometido de entrega/retiro (opcional).
  promised_at       timestamptz,
  -- Cadete / repartidor asignado (texto libre; no es un usuario del tenant).
  courier_name      text,
  -- Costo de envío. Lo cobra el POS como línea libre; acá queda como dato del
  -- pedido para mostrarlo en el board y precargarlo al cobrar.
  delivery_fee      numeric(12,2) not null default 0 check (delivery_fee >= 0),
  -- Estado del pedido (transiciones validadas en set_delivery_status según tipo).
  status            text not null default 'recibido'
                      check (status in ('recibido','preparando','en_camino','listo','entregado','cancelado')),
  -- Venta enlazada al cobrar (create_sale con p_delivery_order_id). NULL mientras.
  sale_id           uuid references sales(id) on delete set null,
  notes             text,
  created_by        uuid references public.users(id) default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index if not exists delivery_orders_tenant_idx
  on delivery_orders(tenant_id) where deleted_at is null;
create index if not exists delivery_orders_status_idx
  on delivery_orders(tenant_id, status) where deleted_at is null;
create index if not exists delivery_orders_sale_idx on delivery_orders(sale_id);

create trigger set_updated_at_delivery_orders
  before update on delivery_orders
  for each row execute function set_updated_at();

alter table delivery_orders enable row level security;
create policy delivery_orders_tenant_isolation on delivery_orders
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create trigger audit_delivery_orders
  after insert or update or delete on delivery_orders
  for each row execute function write_audit_log();

-- ── 2) Líneas del pedido de delivery (ESPEJA table_order_items) ──────────────
create table if not exists delivery_order_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  order_id     uuid not null references delivery_orders(id) on delete cascade,
  product_id   uuid references products(id) on delete set null,
  name         text not null,
  qty          numeric(12,3) not null default 1 check (qty > 0),
  unit_price   numeric(12,2) not null default 0 check (unit_price >= 0),
  modifiers    jsonb not null default '[]'::jsonb,
  notes        text,
  -- Ruteo a estación (snapshot del producto, igual que mesas · H45).
  station      text,
  -- Estado de preparación en el KDS (H46).
  kds_status   text not null default 'pendiente'
                 check (kds_status in ('pendiente','preparando','listo','entregado')),
  kds_ready_at timestamptz,
  -- Comanda impresa (H45).
  printed_at   timestamptz,
  -- Cursos / despacho por tiempos (H47). fired_at null = "en espera".
  course       smallint not null default 1,
  fired_at     timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists delivery_order_items_order_idx on delivery_order_items(order_id);
create index if not exists delivery_order_items_tenant_idx on delivery_order_items(tenant_id);

alter table delivery_order_items enable row level security;
create policy delivery_order_items_tenant_isolation on delivery_order_items
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- ── 3) Etiqueta de cabecera para KDS/comanda ─────────────────────────────────
-- "DELIVERY #1234" / "TAKEAWAY #1234" (los 4 últimos del uuid del pedido). La
-- cocina identifica el pedido sin mesa. Estable (depende sólo del id).
create or replace function _delivery_order_label(p_order_id uuid, p_order_type text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select upper(coalesce(nullif(p_order_type, ''), 'delivery'))
         || ' #' || upper(right(replace(p_order_id::text, '-', ''), 4));
$$;

-- ── 4) create_delivery_order: alta de un pedido de delivery / takeaway ────────
-- Crea el pedido (status 'recibido'). Espeja open_dining_table en estilo (guard
-- de miembro activo, tenant-scoped). Devuelve el id del pedido.
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
  p_delivery_fee   numeric default 0,
  p_notes          text    default null
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
begin
  if v_type not in ('delivery','takeaway') then
    raise exception 'invalid_order_type';
  end if;
  if v_channel not in ('mostrador','telefono','whatsapp','qr','delivery_propio') then
    raise exception 'invalid_channel';
  end if;
  -- El cliente del catálogo (si viene) debe ser del tenant.
  if p_customer_id is not null
     and not exists (
       select 1 from customers
        where id = p_customer_id and tenant_id = v_tenant and deleted_at is null
     ) then
    raise exception 'customer_not_found';
  end if;

  insert into delivery_orders (
    tenant_id, channel, order_type, customer_id, customer_name, customer_phone,
    address, address_reference, promised_at, courier_name, delivery_fee,
    status, notes, created_by
  )
  values (
    v_tenant, v_channel, v_type, p_customer_id,
    nullif(btrim(p_customer_name), ''), nullif(btrim(p_customer_phone), ''),
    -- Takeaway no lleva dirección.
    case when v_type = 'takeaway' then null else nullif(btrim(p_address), '') end,
    case when v_type = 'takeaway' then null else nullif(btrim(p_address_ref), '') end,
    p_promised_at, nullif(btrim(p_courier_name), ''),
    greatest(coalesce(p_delivery_fee, 0), 0),
    'recibido', nullif(btrim(p_notes), ''), auth.uid()
  )
  returning id into v_order_id;

  return jsonb_build_object('order_id', v_order_id, 'status', 'recibido',
                            'order_type', v_type);
end;
$$;
revoke all on function create_delivery_order(text, text, uuid, text, text, text, text, timestamptz, text, numeric, text) from public, anon;
grant execute on function create_delivery_order(text, text, uuid, text, text, text, text, timestamptz, text, numeric, text) to authenticated;

-- ── 5) add_delivery_order_item: agrega una línea (ESPEJA add_table_order_item) ─
-- FOR UPDATE del pedido (TOCTOU), snapshot de station del producto, p_course /
-- p_hold opcionales (default: Tiempo 1, se manda a cocina al toque).
create or replace function add_delivery_order_item(
  p_order_id   uuid,
  p_product_id uuid,
  p_name       text,
  p_qty        numeric,
  p_unit_price numeric,
  p_modifiers  jsonb default '[]'::jsonb,
  p_notes      text default null,
  p_course     smallint default 1,
  p_hold       boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _dining_assert_member();
  v_order   delivery_orders%rowtype;
  v_item_id uuid;
  v_station text;
  v_course  smallint := greatest(coalesce(p_course, 1), 1);
begin
  select * into v_order from delivery_orders
   where id = p_order_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status = 'cancelado' or v_order.sale_id is not null then
    raise exception 'order_not_open';
  end if;
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'invalid_qty';
  end if;

  if p_product_id is not null then
    select nullif(btrim(station), '') into v_station
      from products
     where id = p_product_id and tenant_id = v_tenant;
  end if;

  insert into delivery_order_items
    (tenant_id, order_id, product_id, name, qty, unit_price, modifiers, notes,
     station, kds_status, course, fired_at)
  values (
    v_tenant, p_order_id, p_product_id,
    coalesce(nullif(btrim(p_name), ''), 'Ítem'),
    p_qty, greatest(coalesce(p_unit_price, 0), 0),
    coalesce(p_modifiers, '[]'::jsonb), nullif(btrim(p_notes), ''),
    v_station, 'pendiente', v_course,
    case when coalesce(p_hold, false) then null else now() end
  )
  returning id into v_item_id;

  update delivery_orders set updated_at = now() where id = p_order_id;

  return v_item_id;
end;
$$;
revoke all on function add_delivery_order_item(uuid, uuid, text, numeric, numeric, jsonb, text, smallint, boolean) from public, anon;
grant execute on function add_delivery_order_item(uuid, uuid, text, numeric, numeric, jsonb, text, smallint, boolean) to authenticated;

-- ── 6) set_delivery_order_item_qty: cambia la cantidad (0 = quitar) ───────────
-- ESPEJA set_table_order_item_qty: FOR UPDATE del pedido (serializa contra cobro).
create or replace function set_delivery_order_item_qty(p_item_id uuid, p_qty numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;
revoke all on function set_delivery_order_item_qty(uuid, numeric) from public, anon;
grant execute on function set_delivery_order_item_qty(uuid, numeric) to authenticated;

-- ── 7) set_delivery_status: transición de estado del pedido + audit ──────────
-- Valida transiciones según order_type. Delivery: recibido → preparando →
-- en_camino → entregado. Takeaway: recibido → preparando → listo → entregado.
-- 'cancelado' permitido desde cualquier estado no terminal. No permite mover un
-- pedido ya cobrado a un estado distinto de 'entregado' (queda 'entregado' al
-- cobrar). Audita en audit_logs.
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

  -- Estados válidos por tipo (incluye cancelado y entregado como destinos).
  if v_order.order_type = 'takeaway' then
    v_allowed := array['recibido','preparando','listo','entregado','cancelado'];
  else
    v_allowed := array['recibido','preparando','en_camino','entregado','cancelado'];
  end if;
  if not (p_status = any(v_allowed)) then
    raise exception 'invalid_status';
  end if;

  -- 'entregado' por este camino exige que ya esté cobrado (la entrega se confirma
  -- normalmente al cobrar). Si el dueño quiere marcar entregado sin cobrar, igual
  -- lo permitimos sólo cuando NO hay venta pendiente de cobro distinta. Mantener
  -- simple: bloqueamos pasar a 'entregado' manualmente si no hay sale_id, para no
  -- "perder" el cobro. El cobro atómico (create_sale) sí lo marca entregado.
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
revoke all on function set_delivery_status(uuid, text) from public, anon;
grant execute on function set_delivery_status(uuid, text) to authenticated;

-- ── 8) assign_courier: asigna/cambia el cadete/repartidor ────────────────────
create or replace function assign_courier(p_id uuid, p_courier_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  delivery_orders%rowtype;
begin
  select * into v_order from delivery_orders
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status in ('entregado','cancelado') then
    raise exception 'order_closed';
  end if;

  update delivery_orders
     set courier_name = nullif(btrim(p_courier_name), ''), updated_at = now()
   where id = p_id and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          after_data)
  values (v_tenant, auth.uid(), 'delivery_orders', p_id, 'assign_courier',
          jsonb_build_object('courier_name', nullif(btrim(p_courier_name), '')));

  return jsonb_build_object('order_id', p_id,
                            'courier_name', nullif(btrim(p_courier_name), ''));
end;
$$;
revoke all on function assign_courier(uuid, text) from public, anon;
grant execute on function assign_courier(uuid, text) to authenticated;

-- ── 9) cancel_delivery_order: anula el pedido ────────────────────────────────
create or replace function cancel_delivery_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  delivery_orders%rowtype;
begin
  select * into v_order from delivery_orders
   where id = p_order_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status in ('entregado','cancelado') or v_order.sale_id is not null then
    raise exception 'order_not_open';
  end if;

  update delivery_orders set status = 'cancelado', updated_at = now()
   where id = p_order_id and tenant_id = v_tenant;

  return jsonb_build_object('order_id', p_order_id, 'status', 'cancelado');
end;
$$;
revoke all on function cancel_delivery_order(uuid) from public, anon;
grant execute on function cancel_delivery_order(uuid) to authenticated;

-- ── 10) fire_delivery_order_course: disparar un tiempo a cocina ──────────────
-- ESPEJA fire_table_order_course (para los ítems en espera del pedido delivery).
create or replace function fire_delivery_order_course(
  p_order_id uuid,
  p_course   smallint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  delivery_orders%rowtype;
  v_fired  int;
begin
  select * into v_order from delivery_orders
   where id = p_order_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status = 'cancelado' or v_order.sale_id is not null then
    raise exception 'order_not_open';
  end if;

  with upd as (
    update delivery_order_items
       set fired_at = now()
     where order_id = p_order_id
       and tenant_id = v_tenant
       and fired_at is null
       and (p_course is null or course = p_course)
    returning 1
  )
  select count(*) into v_fired from upd;

  if v_fired > 0 then
    update delivery_orders set updated_at = now() where id = p_order_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                            action, after_data)
    values (v_tenant, auth.uid(), 'delivery_orders', p_order_id, 'fire_course',
            jsonb_build_object('course', p_course, 'fired', v_fired));
  end if;

  return jsonb_build_object('order_id', p_order_id, 'course', p_course,
                            'fired', v_fired);
end;
$$;
revoke all on function fire_delivery_order_course(uuid, smallint) from public, anon;
grant execute on function fire_delivery_order_course(uuid, smallint) to authenticated;

-- ── 11) set_delivery_order_item_course: cambiar el tiempo de una línea ───────
create or replace function set_delivery_order_item_course(p_item_id uuid, p_course smallint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_item   delivery_order_items%rowtype;
  v_order  delivery_orders%rowtype;
  v_course smallint := greatest(coalesce(p_course, 1), 1);
begin
  select i.* into v_item from delivery_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;
  select * into v_order from delivery_orders
   where id = v_item.order_id and tenant_id = v_tenant
   for update;
  if v_order.status = 'cancelado' or v_order.sale_id is not null then
    raise exception 'order_not_open';
  end if;

  update delivery_order_items set course = v_course
   where id = p_item_id and tenant_id = v_tenant;
  update delivery_orders set updated_at = now() where id = v_item.order_id;

  return jsonb_build_object('item_id', p_item_id, 'course', v_course);
end;
$$;
revoke all on function set_delivery_order_item_course(uuid, smallint) from public, anon;
grant execute on function set_delivery_order_item_course(uuid, smallint) to authenticated;

-- ── 12) kds_tickets: UNE mesa + delivery (+ source / source_label) ───────────
-- Recreada preservando TODO de la versión H47 (tenant guard, joins, filtro de
-- estación, excluir 'entregado', fired_at not null, orden FIFO) y agregando la
-- fuente DELIVERY. Nuevas columnas al FINAL: `source` ('mesa'|'delivery') y
-- `source_label` (cabecera: "Mesa 5" / "DELIVERY #1234"). El front lee por
-- nombre (cast del array) → agregar columnas al final es retro-compatible.
drop function if exists kds_tickets(text);
create or replace function kds_tickets(p_station text default null)
returns table(
  item_id uuid, order_id uuid, table_id uuid, table_label text, area_name text,
  product_id uuid, name text, qty numeric, modifiers jsonb, notes text,
  station text, kds_status text, course smallint,
  created_at timestamptz, ready_at timestamptz,
  source text, source_label text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_filter text := nullif(btrim(coalesce(p_station, '')), '');
begin
  return query
    -- Fuente MESA (idéntica a H47).
    select
      i.id, i.order_id, t.id, t.label, a.name,
      i.product_id, i.name, i.qty, i.modifiers, i.notes,
      i.station, i.kds_status, i.course, i.created_at, i.kds_ready_at,
      'mesa'::text, ('Mesa ' || t.label)::text
    from table_order_items i
    join table_orders o   on o.id = i.order_id and o.tenant_id = v_tenant
    join dining_tables t  on t.id = o.table_id  and t.tenant_id = v_tenant
    left join dining_areas a on a.id = t.area_id and a.tenant_id = v_tenant
    where i.tenant_id = v_tenant
      and o.status = 'abierta'
      and i.kds_status <> 'entregado'
      and i.fired_at is not null
      and (v_filter is null or i.station = v_filter)

    union all

    -- Fuente DELIVERY / TAKEAWAY: pedidos activos (no entregado/cancelado, sin
    -- cobrar) con ítems disparados. table_id/area_name = null (no hay mesa).
    select
      di.id, di.order_id, null::uuid, _delivery_order_label(d.id, d.order_type), null::text,
      di.product_id, di.name, di.qty, di.modifiers, di.notes,
      di.station, di.kds_status, di.course, di.created_at, di.kds_ready_at,
      'delivery'::text, _delivery_order_label(d.id, d.order_type)
    from delivery_order_items di
    join delivery_orders d on d.id = di.order_id and d.tenant_id = v_tenant
    where di.tenant_id = v_tenant
      and d.deleted_at is null
      and d.status not in ('entregado','cancelado')
      and d.sale_id is null
      and di.kds_status <> 'entregado'
      and di.fired_at is not null
      and (v_filter is null or di.station = v_filter)

    order by created_at asc;
end;
$$;
revoke all on function kds_tickets(text) from public, anon;
grant execute on function kds_tickets(text) to authenticated;

-- ── 13) set_item_kds_status: ahora también acepta ítems de delivery ──────────
-- Recreada: busca el ítem primero en mesa; si no está, en delivery. Misma firma,
-- mismo contrato (sella ready_at en 'listo'). Preserva el comportamiento mesa.
create or replace function set_item_kds_status(p_item_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
begin
  if p_status not in ('pendiente','preparando','listo','entregado') then
    raise exception 'invalid_status';
  end if;

  -- Mesa (camino original).
  if exists (select 1 from table_order_items where id = p_item_id and tenant_id = v_tenant) then
    update table_order_items
       set kds_status   = p_status,
           kds_ready_at = case
                            when p_status = 'listo' then coalesce(kds_ready_at, now())
                            when p_status = 'entregado' then kds_ready_at
                            else null
                          end
     where id = p_item_id and tenant_id = v_tenant;
    return jsonb_build_object('item_id', p_item_id, 'kds_status', p_status, 'source', 'mesa');
  end if;

  -- Delivery / takeaway.
  if exists (select 1 from delivery_order_items where id = p_item_id and tenant_id = v_tenant) then
    update delivery_order_items
       set kds_status   = p_status,
           kds_ready_at = case
                            when p_status = 'listo' then coalesce(kds_ready_at, now())
                            when p_status = 'entregado' then kds_ready_at
                            else null
                          end
     where id = p_item_id and tenant_id = v_tenant;
    return jsonb_build_object('item_id', p_item_id, 'kds_status', p_status, 'source', 'delivery');
  end if;

  raise exception 'item_not_found';
end;
$$;
revoke all on function set_item_kds_status(uuid, text) from public, anon;
grant execute on function set_item_kds_status(uuid, text) to authenticated;

-- ── 14) comanda_items: comanda de un pedido de delivery ──────────────────────
-- Para mesas sigue existiendo comanda_items(uuid, boolean). Para delivery se
-- expone una RPC hermana (mismo shape menos waiter; usa source_label como
-- cabecera). Preserva fired_at not null y p_only_new.
create or replace function delivery_comanda_items(p_order_id uuid, p_only_new boolean default false)
returns table(
  item_id uuid, product_id uuid, name text, qty numeric, modifiers jsonb,
  notes text, station text, course smallint, printed_at timestamptz,
  source_label text, channel text, order_type text, courier_name text,
  customer_name text, address text, opened_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
begin
  return query
    select
      di.id, di.product_id, di.name, di.qty, di.modifiers, di.notes,
      di.station, di.course, di.printed_at,
      _delivery_order_label(d.id, d.order_type), d.channel, d.order_type,
      d.courier_name, d.customer_name, d.address, d.created_at
    from delivery_order_items di
    join delivery_orders d on d.id = di.order_id and d.tenant_id = v_tenant
    where di.order_id = p_order_id
      and di.tenant_id = v_tenant
      and di.fired_at is not null
      and (p_only_new is not true or di.printed_at is null)
    order by di.created_at asc;
end;
$$;
revoke all on function delivery_comanda_items(uuid, boolean) from public, anon;
grant execute on function delivery_comanda_items(uuid, boolean) to authenticated;

-- mark_comanda_printed (mesa) ya existe; para delivery, una hermana tenant-scoped.
create or replace function mark_delivery_comanda_printed(p_order_id uuid, p_item_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_count  int;
begin
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    return jsonb_build_object('marked', 0);
  end if;

  with upd as (
    update delivery_order_items
       set printed_at = coalesce(printed_at, now())
     where order_id = p_order_id
       and tenant_id = v_tenant
       and id = any(p_item_ids)
       and printed_at is null
    returning 1
  )
  select count(*) into v_count from upd;

  return jsonb_build_object('marked', coalesce(v_count, 0));
end;
$$;
revoke all on function mark_delivery_comanda_printed(uuid, uuid[]) from public, anon;
grant execute on function mark_delivery_comanda_printed(uuid, uuid[]) to authenticated;

-- ── 15) create_sale: + p_delivery_order_id (ESPEJA la rama de mesa) ──────────
-- Se agrega un parámetro OPCIONAL al final (p_delivery_order_id uuid default
-- null) que ESPEJA EXACTAMENTE la rama de p_table_order_id: FOR UPDATE del
-- delivery_order al inicio (abortar si ya cobrado/cancelado), y al final
-- enlazar sale_id + marcar 'entregado' + audit. Todo lo demás (assert_account_
-- active, validación QR, rama de mesa, extras, redondeo, stock) queda INTACTO.
-- El delivery_fee NO se calcula acá: el POS lo carga como línea libre (ver
-- header). Mostrador (ambos null) = idéntico.
--
-- Cambio de aridad → "create or replace" crearía una sobrecarga: se elimina la
-- firma vieja de 7 args al final (igual criterio que el cobro atómico de mesa).
create or replace function create_sale(
  p_items jsonb,
  p_payments jsonb,
  p_discount_total numeric default 0,
  p_customer_id uuid default null,
  p_notes text default null,
  p_extras jsonb default '[]'::jsonb,
  p_table_order_id uuid default null,
  p_delivery_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  v_intent   record;
  v_qr_ref   uuid;
  v_qr_sum   numeric;
  v_qr_plain boolean := false;
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

  -- Rama DELIVERY (espeja la de mesa): toma el pedido FOR UPDATE y aborta si ya
  -- fue cobrado o cancelado. El enlace/cierre va al final, dentro de la misma TX.
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

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0);

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
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
                     professional_id, tip_amount, tip_method)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end)
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

  -- Cierre del pedido de delivery (ESPEJA la rama de mesa): enlaza la venta,
  -- marca 'entregado' y audita. Atómico (FOR UPDATE tomado arriba → sin doble
  -- cobro por dos pestañas).
  if p_delivery_order_id is not null then
    update delivery_orders
       set sale_id = v_sale_id, status = 'entregado', updated_at = now()
     where id = p_delivery_order_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'delivery_orders', p_delivery_order_id, 'delivery_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'order_type', v_delivery_order.order_type,
                               'delivery_fee', v_delivery_order.delivery_fee));
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount);
end;
$$;

-- Eliminar la firma anterior de 7 args (sin p_delivery_order_id) para que exista
-- una sola definición autoritativa. La nueva de 8 args con default cubre todas
-- las llamadas de 7 nombres (PostgREST incluido).
drop function if exists create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid);

revoke all on function create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid) from public, anon;
grant execute on function create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid) to authenticated;
