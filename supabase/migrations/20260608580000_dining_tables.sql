-- =============================================================================
-- 20260608580000_dining_tables  (F13 · H44 — mesas, salones y pedidos de mesa)
--                               (+ H43 modo gastronómico: pos_settings.dining_enabled)
-- -----------------------------------------------------------------------------
-- Operación gastronómica básica: salones (sectores), mesas con estado/mozo y un
-- pedido por mesa que se va cargando y se COBRA reusando el flujo del POS.
--
-- MODO GASTRONÓMICO (H43, núcleo): pos_settings.dining_enabled (bool default
-- false). ADITIVO: con off, el POS mostrador queda idéntico (nada de esto se
-- muestra). Con on, se habilita la vista de Salón y la gestión de salones/mesas.
--
-- MODELO (reusa lo existente; NO se toca create_sale):
--
--  1) SALONES = `dining_areas` (sector visual: salón principal, terraza, barra…).
--  2) MESAS   = `dining_tables` (etiqueta, capacidad, estado, mozo, pedido vivo).
--     Estados: libre / ocupada / cuenta_pedida / bloqueada. `current_order_id`
--     apunta al pedido abierto (si la mesa está ocupada). `waiter_user_id` es el
--     mozo que la atiende (miembro del tenant; opcional).
--  3) PEDIDO  = `table_orders` (cuenta de la mesa) + `table_order_items` (líneas).
--     status: abierta / cobrada / cancelada. Al cobrar, los ítems se cargan al
--     carrito del POS y create_sale emite la venta; close_dining_table enlaza
--     sale_id, cierra el pedido y libera la mesa.
--
-- RLS: aislamiento por tenant en todo (igual que professionals/appointments).
-- Las acciones de mesa son RPCs SECURITY DEFINER tenant-scoped con guard de
-- miembro ACTIVO (un mozo/cajero puede operar la mesa; no exige owner/manager).
-- El CRUD de salones/mesas va por la tabla directa con RLS (lo usa el dueño en
-- Configuración → Salones y mesas).
--
-- COBRO DESDE LA MESA: NO se toca create_sale. El POS arranca con los ítems del
-- pedido en el carrito (/pos?table=<order_id>) y cobra con el flujo normal; al
-- confirmar, close_dining_table() enlaza la venta, marca el pedido 'cobrada' y
-- libera la mesa (→ libre). Espeja link_appointment_sale (H38).
--
-- FUERA DE ALCANCE (follow-up, NO en este PR): división de cuenta, unir/mover
-- mesas, comanda impresa + ruteo por estación (H45), KDS (H46), reservas (H51).
-- types/database.ts NO se regenera en este PR (el front castea; la DB + RLS validan).
-- =============================================================================

-- ── 0) Modo gastronómico (H43): toggle por tenant ────────────────────────────
-- Default false: el POS mostrador no cambia. El dueño lo activa en Configuración
-- → Operación. El nav del POS y la gestión de salones se gatean con esta key.
alter table pos_settings add column if not exists dining_enabled boolean not null default false;

-- ── 1) Salones / sectores ─────────────────────────────────────────────────────
create table if not exists dining_areas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name        text not null,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists dining_areas_tenant_idx
  on dining_areas(tenant_id) where deleted_at is null;

create trigger set_updated_at_dining_areas
  before update on dining_areas
  for each row execute function set_updated_at();

alter table dining_areas enable row level security;
create policy dining_areas_tenant_isolation on dining_areas
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- ── 2) Mesas ──────────────────────────────────────────────────────────────────
create table if not exists dining_tables (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  area_id          uuid references dining_areas(id) on delete set null,
  label            text not null,
  capacity         int not null default 2 check (capacity >= 0),
  sort             int not null default 0,
  -- Estado de la mesa. current_order_id apunta al pedido vivo (cuando 'ocupada'
  -- o 'cuenta_pedida'). La FK se agrega más abajo (referencia adelantada).
  status           text not null default 'libre'
                     check (status in ('libre','ocupada','cuenta_pedida','bloqueada')),
  current_order_id uuid,
  -- Mozo que atiende la mesa (miembro del tenant; opcional). on delete set null.
  waiter_user_id   uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists dining_tables_tenant_idx
  on dining_tables(tenant_id) where deleted_at is null;
create index if not exists dining_tables_area_idx on dining_tables(area_id);

create trigger set_updated_at_dining_tables
  before update on dining_tables
  for each row execute function set_updated_at();

alter table dining_tables enable row level security;
create policy dining_tables_tenant_isolation on dining_tables
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- ── 3) Pedido de mesa (cuenta) ────────────────────────────────────────────────
create table if not exists table_orders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  table_id    uuid not null references dining_tables(id) on delete cascade,
  status      text not null default 'abierta'
                check (status in ('abierta','cobrada','cancelada')),
  opened_by   uuid references public.users(id) default auth.uid(),
  opened_at   timestamptz not null default now(),
  -- Venta enlazada al cobrar (close_dining_table). NULL mientras está abierta.
  sale_id     uuid references sales(id) on delete set null,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists table_orders_tenant_idx on table_orders(tenant_id);
create index if not exists table_orders_table_idx on table_orders(table_id);
create index if not exists table_orders_sale_idx on table_orders(sale_id);
-- Una mesa no puede tener dos pedidos abiertos a la vez.
create unique index if not exists table_orders_one_open_per_table
  on table_orders(table_id) where status = 'abierta';

create trigger set_updated_at_table_orders
  before update on table_orders
  for each row execute function set_updated_at();

alter table table_orders enable row level security;
create policy table_orders_tenant_isolation on table_orders
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create trigger audit_table_orders
  after insert or update or delete on table_orders
  for each row execute function write_audit_log();

-- FK adelantada: current_order_id → table_orders(id). on delete set null (si se
-- borrara el pedido, la mesa queda sin pedido vivo).
alter table dining_tables
  add constraint dining_tables_current_order_fk
  foreign key (current_order_id) references table_orders(id) on delete set null;

-- ── 4) Líneas del pedido de mesa ──────────────────────────────────────────────
create table if not exists table_order_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  order_id    uuid not null references table_orders(id) on delete cascade,
  -- Producto del catálogo (null = ítem libre con nombre propio).
  product_id  uuid references products(id) on delete set null,
  name        text not null,
  qty         numeric(12,3) not null default 1 check (qty > 0),
  unit_price  numeric(12,2) not null default 0 check (unit_price >= 0),
  -- Snapshot de modificadores elegidos (H37), mismo shape que sale_items.modifiers.
  modifiers   jsonb not null default '[]'::jsonb,
  notes       text,
  created_at  timestamptz not null default now()
);
create index if not exists table_order_items_order_idx on table_order_items(order_id);
create index if not exists table_order_items_tenant_idx on table_order_items(tenant_id);

alter table table_order_items enable row level security;
create policy table_order_items_tenant_isolation on table_order_items
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- ── 5) Guard común: miembro activo del tenant ─────────────────────────────────
-- Las RPCs de mesa las puede ejecutar cualquier miembro activo (mozo/cajero),
-- igual que el cobro de turno (link_appointment_sale · H38).
create or replace function _dining_assert_member()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'forbidden';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _dining_assert_member() from public, anon;
grant execute on function _dining_assert_member() to authenticated;

-- ── 6) open_dining_table: abre una mesa (crea el pedido, mesa → ocupada) ───────
-- Idempotente: si la mesa ya tiene un pedido abierto, lo devuelve (no crea otro).
-- Permite asignar el mozo (p_waiter_user_id; default = quien abre).
create or replace function open_dining_table(
  p_table_id uuid,
  p_waiter_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_table  dining_tables%rowtype;
  v_order_id uuid;
begin
  select * into v_table from dining_tables
   where id = p_table_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'table_not_found';
  end if;
  if v_table.status = 'bloqueada' then
    raise exception 'table_blocked';
  end if;

  -- ¿Ya hay un pedido abierto? (idempotencia + unique index lo respalda)
  select id into v_order_id from table_orders
   where table_id = p_table_id and tenant_id = v_tenant and status = 'abierta'
   limit 1;

  if v_order_id is null then
    insert into table_orders (tenant_id, table_id, status, opened_by)
    values (v_tenant, p_table_id, 'abierta', auth.uid())
    returning id into v_order_id;
  end if;

  update dining_tables
     set status = 'ocupada',
         current_order_id = v_order_id,
         waiter_user_id = coalesce(p_waiter_user_id, waiter_user_id, auth.uid())
   where id = p_table_id and tenant_id = v_tenant;

  return jsonb_build_object('order_id', v_order_id, 'table_id', p_table_id, 'status', 'ocupada');
end;
$$;
revoke all on function open_dining_table(uuid, uuid) from public, anon;
grant execute on function open_dining_table(uuid, uuid) to authenticated;

-- ── 7) add_table_order_item: agrega una línea al pedido de la mesa ─────────────
create or replace function add_table_order_item(
  p_order_id   uuid,
  p_product_id uuid,
  p_name       text,
  p_qty        numeric,
  p_unit_price numeric,
  p_modifiers  jsonb default '[]'::jsonb,
  p_notes      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  table_orders%rowtype;
  v_item_id uuid;
begin
  select * into v_order from table_orders
   where id = p_order_id and tenant_id = v_tenant;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status <> 'abierta' then
    raise exception 'order_not_open';
  end if;
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'invalid_qty';
  end if;

  insert into table_order_items (tenant_id, order_id, product_id, name, qty, unit_price, modifiers, notes)
  values (
    v_tenant, p_order_id, p_product_id,
    coalesce(nullif(btrim(p_name), ''), 'Ítem'),
    p_qty, greatest(coalesce(p_unit_price, 0), 0),
    coalesce(p_modifiers, '[]'::jsonb), nullif(btrim(p_notes), '')
  )
  returning id into v_item_id;

  -- Tocar el pedido (updated_at) para refrescar el total acumulado.
  update table_orders set updated_at = now() where id = p_order_id;

  return v_item_id;
end;
$$;
revoke all on function add_table_order_item(uuid, uuid, text, numeric, numeric, jsonb, text) from public, anon;
grant execute on function add_table_order_item(uuid, uuid, text, numeric, numeric, jsonb, text) to authenticated;

-- ── 8) set_table_order_item_qty: cambia la cantidad (0 = quitar la línea) ──────
create or replace function set_table_order_item_qty(p_item_id uuid, p_qty numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_item   table_order_items%rowtype;
  v_status text;
begin
  select i.* into v_item from table_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;
  -- El pedido debe estar abierto para editar.
  select status into v_status from table_orders where id = v_item.order_id;
  if v_status <> 'abierta' then
    raise exception 'order_not_open';
  end if;

  if coalesce(p_qty, 0) <= 0 then
    delete from table_order_items where id = p_item_id and tenant_id = v_tenant;
    update table_orders set updated_at = now() where id = v_item.order_id;
    return jsonb_build_object('removed', true, 'item_id', p_item_id);
  end if;

  update table_order_items set qty = p_qty where id = p_item_id and tenant_id = v_tenant;
  update table_orders set updated_at = now() where id = v_item.order_id;
  return jsonb_build_object('removed', false, 'item_id', p_item_id, 'qty', p_qty);
end;
$$;
revoke all on function set_table_order_item_qty(uuid, numeric) from public, anon;
grant execute on function set_table_order_item_qty(uuid, numeric) to authenticated;

-- ── 9) cancel_table_order: anula el pedido y libera la mesa ────────────────────
create or replace function cancel_table_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  table_orders%rowtype;
begin
  select * into v_order from table_orders
   where id = p_order_id and tenant_id = v_tenant;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status <> 'abierta' then
    raise exception 'order_not_open';
  end if;

  update table_orders set status = 'cancelada', updated_at = now()
   where id = p_order_id and tenant_id = v_tenant;

  update dining_tables
     set status = 'libre', current_order_id = null, waiter_user_id = null
   where id = v_order.table_id and tenant_id = v_tenant
     and current_order_id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'status', 'cancelada');
end;
$$;
revoke all on function cancel_table_order(uuid) from public, anon;
grant execute on function cancel_table_order(uuid) to authenticated;

-- ── 10) set_table_status: marca cuenta pedida / bloquea / libera la mesa ───────
-- Transiciones simples de estado de la mesa (sin tocar el pedido). 'cuenta_pedida'
-- exige una mesa ocupada; 'bloqueada'/'libre' sólo se permiten sin pedido abierto.
create or replace function set_table_status(p_table_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_table  dining_tables%rowtype;
begin
  if p_status not in ('libre','ocupada','cuenta_pedida','bloqueada') then
    raise exception 'invalid_status';
  end if;
  select * into v_table from dining_tables
   where id = p_table_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'table_not_found';
  end if;

  -- No liberar/bloquear una mesa con pedido abierto (primero cobrar o cancelar).
  if p_status in ('libre','bloqueada') and v_table.current_order_id is not null then
    raise exception 'table_has_open_order';
  end if;
  -- 'cuenta_pedida'/'ocupada' exigen pedido abierto.
  if p_status in ('cuenta_pedida','ocupada') and v_table.current_order_id is null then
    raise exception 'table_not_open';
  end if;

  update dining_tables
     set status = p_status,
         current_order_id = case when p_status = 'libre' then null else current_order_id end,
         waiter_user_id   = case when p_status = 'libre' then null else waiter_user_id end
   where id = p_table_id and tenant_id = v_tenant;

  return jsonb_build_object('table_id', p_table_id, 'status', p_status);
end;
$$;
revoke all on function set_table_status(uuid, text) from public, anon;
grant execute on function set_table_status(uuid, text) to authenticated;

-- ── 11) close_dining_table: enlaza la venta cobrada y libera la mesa ───────────
-- El POS cobra el pedido con el flujo normal (create_sale, intacto) y, al obtener
-- el sale_id, llama a esta RPC: enlaza sale_id, marca el pedido 'cobrada' y libera
-- la mesa (→ libre). Idempotente: si el pedido ya tenía venta, no la pisa. Espeja
-- link_appointment_sale (H38). tenant-scoped + guard de miembro activo.
create or replace function close_dining_table(p_order_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  table_orders%rowtype;
begin
  select * into v_order from table_orders
   where id = p_order_id and tenant_id = v_tenant;
  if not found then
    raise exception 'order_not_found';
  end if;

  -- La venta debe ser del tenant (RLS ya acota; chequeo defensivo).
  if not exists (select 1 from sales where id = p_sale_id and tenant_id = v_tenant) then
    raise exception 'sale_not_found';
  end if;

  -- Idempotencia: si ya estaba enlazado a otra venta, no la pisa.
  if v_order.sale_id is not null and v_order.sale_id <> p_sale_id then
    return jsonb_build_object('order_id', v_order.id, 'sale_id', v_order.sale_id,
                              'status', v_order.status, 'already_linked', true);
  end if;

  update table_orders
     set sale_id = p_sale_id, status = 'cobrada', updated_at = now()
   where id = p_order_id and tenant_id = v_tenant;

  -- Libera la mesa (sólo si este pedido era el vivo en la mesa).
  update dining_tables
     set status = 'libre', current_order_id = null, waiter_user_id = null
   where id = v_order.table_id and tenant_id = v_tenant
     and current_order_id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'sale_id', p_sale_id,
                            'status', 'cobrada', 'already_linked', false);
end;
$$;
revoke all on function close_dining_table(uuid, uuid) from public, anon;
grant execute on function close_dining_table(uuid, uuid) to authenticated;
