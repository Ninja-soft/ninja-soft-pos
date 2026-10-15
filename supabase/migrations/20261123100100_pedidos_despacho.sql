-- =============================================================================
-- 20261123100100_pedidos_despacho  (F11 · H32, ADR-129)
--
-- Pedidos de salón (retail), reserva de stock por minutos y expedición.
-- Sin recrear create_sale: se apoya en las reservas de stock (ADR-091) y en el
-- extra {kind: 'reservation', id} que create_sale ya entiende (ADR-096).
--
-- Flujo:
--   1. El vendedor arma el carrito en el POS y toca "Pedido": sale_order_create
--      guarda el carrito (mismo formato que una venta pausada, ADR-106), el
--      vendedor (comisiones), el tipo de entrega y crea una reserva de stock
--      (canal 'pedido') que vence en N minutos (pos_settings.order_config).
--   2. La cajera lo levanta (sale_order_take): queda tomado por ella, la
--      reserva queda validada para cobrar (pickup_verified_via = 'pedido') y
--      se estira unos minutos para que no venza a mitad del cobro.
--   3. Cobra con create_sale + extra reservation. create_sale entrega la
--      reserva con la venta en la misma transacción y el trigger
--      stock_reservations_sale_order_sync pasa el pedido a cobrado (cajera =
--      quien cobró) y abre su entrega en la cola de expedición. Si la reserva
--      ya se había liberado, el POS cobra sin el extra y enlaza con
--      sale_order_complete (idempotente).
--   4. Expedición: pendiente → armando → listo (→ en tránsito → listo en la
--      sucursal de retiro) → entregado (retiro, con código o nombre) o
--      despachado (envío, enganchado a shipments de ADR-103).
--   5. Vencimiento: pg_cron cada minuto (sale_orders_expire_due). Según
--      order_config.expiry_action: 'release' libera la reserva y el pedido
--      sigue abierto (se cobra si hay stock) o 'cancel' lo da por vencido.
--
-- Seguridad:
--   • Lectura: tenant_id = (select current_tenant_id()) or (select
--     internal_scope()) + RESTRICTIVE por sucursal (la del pedido o la de
--     entrega dentro de user_allowed_store_ids()). Nunca is_internal().
--   • El hash del código de retiro no se lee por REST (grants por columna).
--   • Escritura sólo por RPC SECURITY DEFINER + role_write_guard 'operate'.
--   • Gating: tenant_has_feature_for(tenant, 'pedidos_despacho') en cada RPC
--     de escritura. La reserva además pide reservas_stock (si no está, el
--     pedido se guarda sin reservar).
--   • audit_logs en crear, levantar, soltar, anular, cobrar, liberar reserva,
--     vencer, abrir entrega, cambiar estado, entregar, despachar y cancelar.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración: pos_settings.order_config (defaults en pos_order_config;
--    espejo en lib/orders/logic.ts → orderConfig, con test que los compara).
-- -----------------------------------------------------------------------------
alter table pos_settings add column if not exists order_config jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pos_settings_order_config_check') then
    alter table pos_settings add constraint pos_settings_order_config_check
      check (order_config is null or jsonb_typeof(order_config) = 'object');
  end if;
end;
$$;

-- Booleano tolerante de un jsonb (texto distinto de true/false = default).
create or replace function _jbool(p jsonb, p_key text, p_default boolean)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p ->> p_key in ('true', 'false') then (p ->> p_key)::boolean else p_default end;
$$;
revoke all on function _jbool(jsonb, text, boolean) from public, anon, authenticated;

create or replace function pos_order_config(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r   jsonb;
  dt  jsonb;
  v_m int;
begin
  select ps.order_config into r from pos_settings ps where ps.tenant_id = p_tenant;
  r := coalesce(r, '{}'::jsonb);
  dt := case when jsonb_typeof(r -> 'delivery_types') = 'object' then r -> 'delivery_types' else '{}'::jsonb end;
  v_m := case when (r ->> 'reservation_minutes') ~ '^[0-9]{1,5}$' then (r ->> 'reservation_minutes')::int else 30 end;
  v_m := least(greatest(v_m, 5), 1440);
  return jsonb_build_object(
    'reservation_minutes', v_m,
    'expiry_action', case when r ->> 'expiry_action' = 'cancel' then 'cancel' else 'release' end,
    'immediate_via_dispatch', _jbool(r, 'immediate_via_dispatch', true),
    'delivery_types', jsonb_build_object(
      'inmediato', jsonb_build_object(
        'enabled', _jbool(coalesce(dt -> 'inmediato', '{}'::jsonb), 'enabled', true),
        'cross_branch', false),
      'retiro', jsonb_build_object(
        'enabled', _jbool(coalesce(dt -> 'retiro', '{}'::jsonb), 'enabled', true),
        'cross_branch', _jbool(coalesce(dt -> 'retiro', '{}'::jsonb), 'cross_branch', false),
        'pickup_code', _jbool(coalesce(dt -> 'retiro', '{}'::jsonb), 'pickup_code', true)),
      'envio', jsonb_build_object(
        'enabled', _jbool(coalesce(dt -> 'envio', '{}'::jsonb), 'enabled', true),
        'cross_branch', _jbool(coalesce(dt -> 'envio', '{}'::jsonb), 'cross_branch', false))
    )
  );
end;
$$;
revoke all on function pos_order_config(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Reservas de stock: canal 'pedido' y validación 'pedido' al levantar.
-- -----------------------------------------------------------------------------
alter table stock_reservations drop constraint if exists stock_reservations_channel_check;
alter table stock_reservations add constraint stock_reservations_channel_check
  check (channel in ('mostrador', 'telefono', 'whatsapp', 'web', 'otra_sucursal', 'pedido'));
alter table stock_reservations drop constraint if exists stock_reservations_pickup_verified_via_check;
alter table stock_reservations add constraint stock_reservations_pickup_verified_via_check
  check (pickup_verified_via is null or pickup_verified_via in ('code', 'doc', 'override', 'pedido'));
alter table stock_reservations add column if not exists sale_order_id uuid;

-- -----------------------------------------------------------------------------
-- C) Tablas
-- -----------------------------------------------------------------------------
create table if not exists sale_orders (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,
  number                  int not null,
  -- Donde se arma y se cobra (la reserva compromete el stock de acá).
  store_id                uuid not null references stores(id),
  -- Donde se entrega o desde donde se despacha (otra sucursal = cross-branch).
  fulfillment_store_id    uuid not null references stores(id),
  delivery_type           text not null default 'inmediato'
                            check (delivery_type in ('inmediato', 'retiro', 'envio')),
  status                  text not null default 'abierto'
                            check (status in ('abierto', 'tomado', 'cobrado', 'anulado', 'vencido')),
  customer_id             uuid references customers(id) on delete set null,
  customer_name           text check (customer_name is null or char_length(customer_name) <= 120),
  customer_phone          text check (customer_phone is null or char_length(customer_phone) <= 40),
  pickup_name             text check (pickup_name is null or char_length(pickup_name) <= 120),
  pickup_code_hash        text,
  ship_address            text check (ship_address is null or char_length(ship_address) <= 300),
  notes                   text check (notes is null or char_length(notes) <= 500),
  seller_user_id          uuid references public.users(id),
  seller_professional_id  uuid references professionals(id) on delete set null,
  seller_name             text check (seller_name is null or char_length(seller_name) <= 120),
  cart                    jsonb not null check (jsonb_typeof(cart) = 'object'),
  checkout                jsonb,
  total                   numeric(14,2) not null default 0 check (total >= 0),
  item_count              numeric(14,3) not null default 0,
  reservation_id          uuid references stock_reservations(id) on delete set null,
  reserved_until          timestamptz,
  reservation_released_at timestamptz,
  taken_by                uuid references public.users(id),
  taken_at                timestamptz,
  sale_id                 uuid references sales(id) on delete set null,
  paid_at                 timestamptz,
  cashier_user_id         uuid references public.users(id),
  cancel_reason           text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  cancelled_by            uuid references public.users(id),
  cancelled_at            timestamptz,
  expired_at              timestamptz,
  created_by              uuid references public.users(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  constraint sale_orders_tenant_number_key unique (tenant_id, number)
);

comment on table sale_orders is
  'Pedidos de salón (F11/H32, ADR-129): el vendedor arma, la caja levanta y cobra. El carrito tiene el formato de paused_sales.cart (ADR-106). El stock se compromete con una reserva (stock_reservations, canal pedido).';

create index if not exists sale_orders_tenant_status_idx on sale_orders(tenant_id, status, created_at);
create index if not exists sale_orders_store_status_idx on sale_orders(store_id, status);
create index if not exists sale_orders_fulfillment_idx on sale_orders(fulfillment_store_id);
create unique index if not exists sale_orders_sale_key on sale_orders(sale_id) where sale_id is not null;
-- Índices de las FK (guard de rendimiento F4).
create index if not exists sale_orders_customer_idx on sale_orders(customer_id) where customer_id is not null;
create index if not exists sale_orders_seller_user_idx on sale_orders(seller_user_id) where seller_user_id is not null;
create index if not exists sale_orders_seller_prof_idx on sale_orders(seller_professional_id)
  where seller_professional_id is not null;
create index if not exists sale_orders_reservation_idx on sale_orders(reservation_id) where reservation_id is not null;
create index if not exists sale_orders_taken_by_idx on sale_orders(taken_by) where taken_by is not null;
create index if not exists sale_orders_cashier_idx on sale_orders(cashier_user_id) where cashier_user_id is not null;
create index if not exists sale_orders_cancelled_by_idx on sale_orders(cancelled_by) where cancelled_by is not null;
create index if not exists sale_orders_created_by_idx on sale_orders(created_by) where created_by is not null;

drop trigger if exists set_updated_at_sale_orders on sale_orders;
create trigger set_updated_at_sale_orders
  before update on sale_orders
  for each row execute function set_updated_at();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_reservations_sale_order_fk') then
    alter table stock_reservations add constraint stock_reservations_sale_order_fk
      foreign key (sale_order_id) references sale_orders(id) on delete set null;
  end if;
end;
$$;
create unique index if not exists stock_reservations_sale_order_key on stock_reservations(sale_order_id)
  where sale_order_id is not null;

create table if not exists dispatches (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  number               int not null,
  sale_id              uuid not null references sales(id),
  sale_order_id        uuid references sale_orders(id) on delete set null,
  -- Sucursal donde se vendió (y se arma). La de entrega puede ser otra.
  store_id             uuid not null references stores(id),
  fulfillment_store_id uuid not null references stores(id),
  delivery_type        text not null check (delivery_type in ('inmediato', 'retiro', 'envio')),
  status               text not null default 'pendiente'
                         check (status in ('pendiente', 'armando', 'listo', 'en_transito',
                                           'entregado', 'despachado', 'cancelado')),
  customer_name        text check (customer_name is null or char_length(customer_name) <= 120),
  pickup_name          text check (pickup_name is null or char_length(pickup_name) <= 120),
  pickup_code_hash     text,
  -- Para la UI (el hash no se lee por REST): ¿pide código al entregar?
  has_pickup_code      boolean generated always as (pickup_code_hash is not null) stored,
  failed_attempts      int not null default 0 check (failed_attempts >= 0),
  ship_address         text check (ship_address is null or char_length(ship_address) <= 300),
  shipment_id          uuid references shipments(id) on delete set null,
  tracking             text check (tracking is null or char_length(tracking) <= 120),
  notes                text check (notes is null or char_length(notes) <= 500),
  prepared_by          uuid references public.users(id),
  prepared_at          timestamptz,
  ready_by             uuid references public.users(id),
  ready_at             timestamptz,
  sent_by              uuid references public.users(id),
  sent_at              timestamptz,
  arrived_by           uuid references public.users(id),
  arrived_at           timestamptz,
  delivered_by         uuid references public.users(id),
  delivered_at         timestamptz,
  delivered_to         text check (delivered_to is null or char_length(delivered_to) <= 120),
  override_reason      text check (override_reason is null or char_length(override_reason) <= 300),
  cancel_reason        text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  cancelled_by         uuid references public.users(id),
  cancelled_at         timestamptz,
  created_by           uuid references public.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint dispatches_tenant_number_key unique (tenant_id, number)
);

comment on table dispatches is
  'Cola de expedición (F11/H32, ADR-129): ventas pagadas con entrega pendiente. Estados pendiente, armando, listo, en_transito (a otra sucursal), entregado, despachado o cancelado, con quién y cuándo.';

create index if not exists dispatches_tenant_status_idx on dispatches(tenant_id, status, created_at);
create index if not exists dispatches_store_status_idx on dispatches(store_id, status);
create index if not exists dispatches_fulfillment_status_idx on dispatches(fulfillment_store_id, status);
create unique index if not exists dispatches_sale_open_key on dispatches(sale_id)
  where status <> 'cancelado' and deleted_at is null;
create index if not exists dispatches_sale_idx on dispatches(sale_id);
create index if not exists dispatches_order_idx on dispatches(sale_order_id) where sale_order_id is not null;
create index if not exists dispatches_shipment_idx on dispatches(shipment_id) where shipment_id is not null;
create index if not exists dispatches_prepared_by_idx on dispatches(prepared_by) where prepared_by is not null;
create index if not exists dispatches_ready_by_idx on dispatches(ready_by) where ready_by is not null;
create index if not exists dispatches_sent_by_idx on dispatches(sent_by) where sent_by is not null;
create index if not exists dispatches_arrived_by_idx on dispatches(arrived_by) where arrived_by is not null;
create index if not exists dispatches_delivered_by_idx on dispatches(delivered_by) where delivered_by is not null;
create index if not exists dispatches_cancelled_by_idx on dispatches(cancelled_by) where cancelled_by is not null;
create index if not exists dispatches_created_by_idx on dispatches(created_by) where created_by is not null;

drop trigger if exists set_updated_at_dispatches on dispatches;
create trigger set_updated_at_dispatches
  before update on dispatches
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- D) RLS: lectura por negocio + alcance de sucursal. Sin policies de escritura.
-- -----------------------------------------------------------------------------
alter table sale_orders enable row level security;
alter table dispatches enable row level security;

drop policy if exists sale_orders_select on sale_orders;
create policy sale_orders_select on sale_orders
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists sale_orders_branch_scope on sale_orders;
create policy sale_orders_branch_scope on sale_orders
  as restrictive for select
  using (
    (select internal_scope())
    or store_id = any ((select user_allowed_store_ids())::uuid[])
    or fulfillment_store_id = any ((select user_allowed_store_ids())::uuid[])
  );

drop policy if exists dispatches_select on dispatches;
create policy dispatches_select on dispatches
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists dispatches_branch_scope on dispatches;
create policy dispatches_branch_scope on dispatches
  as restrictive for select
  using (
    (select internal_scope())
    or store_id = any ((select user_allowed_store_ids())::uuid[])
    or fulfillment_store_id = any ((select user_allowed_store_ids())::uuid[])
  );

-- Sin escritura por REST y sin leer el hash del código de retiro.
revoke all on sale_orders from anon, authenticated;
revoke all on dispatches from anon, authenticated;
grant select (
  id, tenant_id, number, store_id, fulfillment_store_id, delivery_type, status, customer_id, customer_name,
  customer_phone, pickup_name, ship_address, notes, seller_user_id, seller_professional_id, seller_name, cart,
  checkout, total, item_count, reservation_id, reserved_until, reservation_released_at, taken_by, taken_at,
  sale_id, paid_at, cashier_user_id, cancel_reason, cancelled_by, cancelled_at, expired_at, created_by,
  created_at, updated_at, deleted_at
) on sale_orders to authenticated;
grant select (
  id, tenant_id, number, sale_id, sale_order_id, store_id, fulfillment_store_id, delivery_type, status,
  customer_name, pickup_name, has_pickup_code, failed_attempts, ship_address, shipment_id, tracking, notes, prepared_by,
  prepared_at, ready_by, ready_at, sent_by, sent_at, arrived_by, arrived_at, delivered_by, delivered_at,
  delivered_to, override_reason, cancel_reason, cancelled_by, cancelled_at, created_by, created_at,
  updated_at, deleted_at
) on dispatches to authenticated;

-- Permisos por rol (ADR-071): operación de mostrador, modo 'operate'.
do $$
declare
  t text;
begin
  foreach t in array array['sale_orders', 'dispatches'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- E) Helpers
-- -----------------------------------------------------------------------------
-- Negocio, miembro operativo (no solo lectura), plan y acceso a la sucursal.
create or replace function _order_assert(p_store_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'pedidos_despacho') then
    raise exception 'feature_not_in_plan: pedidos_despacho' using errcode = 'check_violation';
  end if;
  if p_store_id is null or not exists (
    select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;
  if not coalesce(user_can_access_store(p_store_id), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _order_assert(uuid) from public, anon, authenticated;

-- Reglas del tipo de entrega y de la sucursal de entrega (cross-branch).
-- Devuelve la sucursal de entrega efectiva.
create or replace function _order_delivery_check(
  p_tenant uuid, p_store uuid, p_type text, p_fulfillment uuid, p_address text
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg  jsonb := pos_order_config(p_tenant);
  v_ful  uuid := coalesce(p_fulfillment, p_store);
begin
  if p_type is null or p_type not in ('inmediato', 'retiro', 'envio') then
    raise exception 'invalid_delivery_type';
  end if;
  if not (v_cfg -> 'delivery_types' -> p_type ->> 'enabled')::boolean then
    raise exception 'delivery_type_disabled: %', p_type;
  end if;
  if v_ful <> p_store then
    if not (v_cfg -> 'delivery_types' -> p_type ->> 'cross_branch')::boolean then
      raise exception 'cross_branch_not_allowed: %', p_type;
    end if;
    if not exists (select 1 from stores where id = v_ful and tenant_id = p_tenant and deleted_at is null) then
      raise exception 'store_not_found';
    end if;
  end if;
  if p_type = 'envio' and char_length(btrim(coalesce(p_address, ''))) < 5 then
    raise exception 'ship_address_required';
  end if;
  return v_ful;
end;
$$;
revoke all on function _order_delivery_check(uuid, uuid, text, uuid, text) from public, anon, authenticated;

-- Transiciones de la expedición. Espejo en lib/orders/logic.ts
-- (dispatchCanMove), con test que los compara.
create or replace function _dispatch_can(
  p_from text, p_to text, p_type text, p_cross boolean, p_arrived boolean
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_from in ('entregado', 'despachado', 'cancelado') then false
    when p_to = 'cancelado' then true
    when p_from = 'pendiente' then p_to in ('armando', 'listo')
    when p_from = 'armando' then p_to in ('pendiente', 'listo')
    when p_from = 'en_transito' then p_to = 'listo'
    when p_from = 'listo' then
      case
        when p_to = 'armando' then not (p_cross and p_arrived)
        when p_to = 'en_transito' then p_cross and not p_arrived
        when p_to = 'entregado' then p_type in ('inmediato', 'retiro') and (not p_cross or p_arrived)
        when p_to = 'despachado' then p_type = 'envio' and (not p_cross or p_arrived)
        else false
      end
    else false
  end;
$$;

-- Abre la entrega de una venta (idempotente: una abierta por venta).
create or replace function _dispatch_open(
  p_tenant      uuid,
  p_sale        uuid,
  p_order       uuid,
  p_store       uuid,
  p_fulfillment uuid,
  p_type        text,
  p_customer    text,
  p_pickup      text,
  p_code_hash   text,
  p_address     text,
  p_notes       text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id     uuid;
  v_number int;
begin
  select id into v_id from dispatches
   where sale_id = p_sale and status <> 'cancelado' and deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  perform pg_advisory_xact_lock(hashtext('dispatch_number:' || p_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from dispatches where tenant_id = p_tenant;
  insert into dispatches (
    tenant_id, number, sale_id, sale_order_id, store_id, fulfillment_store_id, delivery_type,
    customer_name, pickup_name, pickup_code_hash, ship_address, notes, created_by
  ) values (
    p_tenant, v_number, p_sale, p_order, p_store, coalesce(p_fulfillment, p_store), p_type,
    left(nullif(btrim(coalesce(p_customer, '')), ''), 120), left(nullif(btrim(coalesce(p_pickup, '')), ''), 120),
    p_code_hash, left(nullif(btrim(coalesce(p_address, '')), ''), 300), left(nullif(btrim(coalesce(p_notes, '')), ''), 500),
    auth.uid()
  )
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (p_tenant, auth.uid(), 'dispatches', v_id, 'dispatch_created',
          jsonb_build_object('number', v_number, 'sale_id', p_sale, 'sale_order_id', p_order,
                             'delivery_type', p_type, 'fulfillment_store_id', coalesce(p_fulfillment, p_store)),
          p_store);
  return v_id;
end;
$$;
revoke all on function _dispatch_open(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;

-- Pedido cobrado: cajera, venta y entrega en la cola de expedición.
create or replace function _sale_order_mark_paid(p_order uuid, p_sale uuid, p_source text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o    sale_orders;
  v_sale record;
  v_cfg  jsonb;
  v_disp uuid;
begin
  select * into v_o from sale_orders where id = p_order;
  select s.id, s.store_id, s.created_by, s.number into v_sale
    from sales s where s.id = p_sale and s.tenant_id = v_o.tenant_id;
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  update sale_orders
     set status = 'cobrado', sale_id = p_sale, paid_at = now(),
         cashier_user_id = coalesce(auth.uid(), v_sale.created_by)
   where id = p_order;
  v_cfg := pos_order_config(v_o.tenant_id);
  if v_o.delivery_type <> 'inmediato' or (v_cfg ->> 'immediate_via_dispatch')::boolean then
    v_disp := _dispatch_open(
      v_o.tenant_id, p_sale, p_order, v_sale.store_id,
      case when v_o.fulfillment_store_id = v_o.store_id then v_sale.store_id else v_o.fulfillment_store_id end,
      v_o.delivery_type, coalesce(v_o.customer_name, v_o.pickup_name), v_o.pickup_name, v_o.pickup_code_hash,
      v_o.ship_address, v_o.notes);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_o.tenant_id, auth.uid(), 'sale_orders', p_order, 'sale_order_paid',
          jsonb_build_object('status', v_o.status),
          jsonb_build_object('status', 'cobrado', 'sale_id', p_sale, 'sale_number', v_sale.number,
                             'seller_user_id', v_o.seller_user_id,
                             'seller_professional_id', v_o.seller_professional_id,
                             'cashier_user_id', coalesce(auth.uid(), v_sale.created_by),
                             'dispatch_id', v_disp, 'source', p_source),
          v_sale.store_id);
  return v_disp;
end;
$$;
revoke all on function _sale_order_mark_paid(uuid, uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) Crear pedido
-- -----------------------------------------------------------------------------
-- p_order: {cart, checkout, items: [{product_id, variant_id, qty}], total,
--   item_count, customer_id, customer_name, customer_phone, delivery_type,
--   fulfillment_store_id, pickup_name, ship_address, notes,
--   seller_professional_id}
-- Devuelve {id, number, reservation_id, reserved_until, pickup_code}. El
-- código de retiro se muestra UNA vez (se guarda sólo el hash).
-- Idempotente por p_id (un reintento devuelve el pedido sin el código).
create or replace function sale_order_create(p_id uuid, p_store_id uuid, p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant  uuid;
  v_cfg     jsonb;
  v_type    text := coalesce(nullif(btrim(p_order ->> 'delivery_type'), ''), 'inmediato');
  v_ful     uuid;
  v_number  int;
  v_existing sale_orders;
  v_cust    uuid;
  v_cname   text := nullif(btrim(coalesce(p_order ->> 'customer_name', '')), '');
  v_pickup  text := nullif(btrim(coalesce(p_order ->> 'pickup_name', '')), '');
  v_code    text;
  v_hash    text;
  v_prof    uuid;
  v_pname   text;
  v_minutes int;
  v_until   timestamptz;
  v_resv    uuid;
  v_it      record;
  v_info    record;
  v_allow   boolean;
  v_avail   numeric;
  v_units   numeric := 0;
  v_value   numeric := 0;
  v_sort    int := 0;
  v_rnum    int;
  v_label   text;
begin
  if p_id is null then
    raise exception 'id_required';
  end if;
  v_tenant := _order_assert(p_store_id);

  select * into v_existing from sale_orders where id = p_id and tenant_id = v_tenant;
  if v_existing.id is not null then
    return jsonb_build_object('id', v_existing.id, 'number', v_existing.number,
                              'reservation_id', v_existing.reservation_id,
                              'reserved_until', v_existing.reserved_until, 'pickup_code', null);
  end if;

  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception 'invalid_order';
  end if;
  if jsonb_typeof(p_order -> 'cart') <> 'object'
     or jsonb_typeof(p_order -> 'cart' -> 'lines') <> 'array'
     or jsonb_array_length(p_order -> 'cart' -> 'lines') = 0 then
    raise exception 'cart_required';
  end if;
  if jsonb_typeof(coalesce(p_order -> 'items', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_order -> 'items', '[]'::jsonb)) > 100 then
    raise exception 'too_many_items';
  end if;
  if coalesce((p_order ->> 'total')::numeric, -1) < 0 then
    raise exception 'invalid_total';
  end if;

  v_ful := _order_delivery_check(v_tenant, p_store_id, v_type,
                                 nullif(p_order ->> 'fulfillment_store_id', '')::uuid,
                                 p_order ->> 'ship_address');
  v_cfg := pos_order_config(v_tenant);

  v_cust := nullif(p_order ->> 'customer_id', '')::uuid;
  if v_cust is not null then
    select c.name into v_label from customers c where c.id = v_cust and c.tenant_id = v_tenant;
    if not found then
      raise exception 'customer_not_found';
    end if;
    v_cname := coalesce(v_cname, v_label);
  end if;
  if v_type = 'retiro' then
    v_pickup := coalesce(v_pickup, v_cname);
    if v_pickup is null then
      raise exception 'pickup_name_required';
    end if;
  end if;

  -- Vendedor: el elegido o el perfil vinculado a quien arma el pedido.
  v_prof := nullif(p_order ->> 'seller_professional_id', '')::uuid;
  if v_prof is not null then
    select pr.name into v_pname from professionals pr
     where pr.id = v_prof and pr.tenant_id = v_tenant and pr.deleted_at is null;
    if not found then
      raise exception 'seller_not_found';
    end if;
  else
    select pr.id, pr.name into v_prof, v_pname from professionals pr
     where pr.tenant_id = v_tenant and pr.user_id = auth.uid() and pr.deleted_at is null and pr.is_active
     order by pr.sort, pr.name
     limit 1;
  end if;
  if v_pname is null then
    select nullif(btrim(u.full_name), '') into v_pname from users u where u.id = auth.uid();
  end if;

  perform pg_advisory_xact_lock(hashtext('sale_order_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from sale_orders where tenant_id = v_tenant;

  if v_type = 'retiro' and (v_cfg -> 'delivery_types' -> 'retiro' ->> 'pickup_code')::boolean then
    v_code := otp_random_digits(6);
    v_hash := stock_reservation_code_hash(p_id, v_code);
  end if;

  v_minutes := (v_cfg ->> 'reservation_minutes')::int;
  v_until := now() + make_interval(mins => v_minutes);

  insert into sale_orders (
    id, tenant_id, number, store_id, fulfillment_store_id, delivery_type, customer_id, customer_name,
    customer_phone, pickup_name, pickup_code_hash, ship_address, notes, seller_user_id,
    seller_professional_id, seller_name, cart, checkout, total, item_count, reserved_until, created_by
  ) values (
    p_id, v_tenant, v_number, p_store_id, v_ful, v_type, v_cust, left(v_cname, 120),
    left(nullif(btrim(coalesce(p_order ->> 'customer_phone', '')), ''), 40), left(v_pickup, 120), v_hash,
    case when v_type = 'envio' then left(btrim(p_order ->> 'ship_address'), 300) end,
    left(nullif(btrim(coalesce(p_order ->> 'notes', '')), ''), 500), auth.uid(), v_prof, left(v_pname, 120),
    p_order -> 'cart', case when jsonb_typeof(p_order -> 'checkout') = 'object' then p_order -> 'checkout' end,
    round(coalesce((p_order ->> 'total')::numeric, 0), 2), coalesce((p_order ->> 'item_count')::numeric, 0),
    v_until, auth.uid()
  );

  -- Reserva del stock (ADR-091) con la feature: sólo productos con stock
  -- propio (sin kits, servicios ni productos que no controlan stock).
  if tenant_has_feature_for(v_tenant, 'reservas_stock') then
    perform stock_reservations_expire_due(v_tenant);
    perform pg_advisory_xact_lock(hashtext('stock_reservation:' || p_store_id::text));
    v_allow := coalesce((_effective_config(v_tenant, 'pos_settings', '', p_store_id, null)
                         -> 'value' ->> 'allow_negative_stock')::boolean, true);
    for v_it in
      select x.product_id, x.variant_id, sum(x.qty) as qty, max(p.name) as name,
             bool_or(coalesce(p.allow_negative, v_allow)) as allow_neg,
             max(coalesce(v.price_override, p.price, 0)) as price
        from jsonb_to_recordset(coalesce(p_order -> 'items', '[]'::jsonb))
               as x(product_id uuid, variant_id uuid, qty numeric)
        join products p on p.id = x.product_id and p.tenant_id = v_tenant and p.deleted_at is null
        left join product_variants v on v.id = x.variant_id
       where coalesce(x.qty, 0) > 0
         and coalesce(p.track_stock, true)
         and not coalesce(p.is_kit, false)
         and not coalesce(p.is_service, false)
       group by x.product_id, x.variant_id
    loop
      if v_resv is null then
        perform pg_advisory_xact_lock(hashtext('stock_reservation_number:' || v_tenant::text));
        select coalesce(max(number), 0) + 1 into v_rnum from stock_reservations where tenant_id = v_tenant;
        v_resv := gen_random_uuid();
        insert into stock_reservations (
          id, tenant_id, number, store_id, channel, customer_id, customer_name, customer_phone,
          pickup_code_hash, expires_at, notes, sale_order_id
        ) values (
          v_resv, v_tenant, v_rnum, p_store_id, 'pedido', v_cust,
          left(coalesce(v_cname, v_pickup, 'Pedido N° ' || v_number), 120),
          left(nullif(btrim(coalesce(p_order ->> 'customer_phone', '')), ''), 40),
          -- El retiro de un pedido se valida al levantarlo: este código no se usa.
          stock_reservation_code_hash(v_resv, gen_random_uuid()::text),
          v_until, 'Pedido de salón N° ' || v_number, p_id
        );
      end if;
      select * into v_info from warehouse_item_info(v_tenant, v_it.product_id, v_it.variant_id);
      v_avail := coalesce((select ps.qty from product_stock ps
                            where ps.store_id = p_store_id and ps.product_id = v_it.product_id
                              and ps.variant_id is not distinct from v_it.variant_id), 0)
               - stock_reserved_qty(p_store_id, v_it.product_id, v_it.variant_id, v_resv);
      if v_avail < v_it.qty and not v_it.allow_neg then
        raise exception 'insufficient_available_stock: %', v_info.product_name;
      end if;
      insert into stock_reservation_items (
        tenant_id, reservation_id, store_id, product_id, variant_id, product_name, variant_label,
        sku, unit, qty, unit_price, sort
      ) values (
        v_tenant, v_resv, p_store_id, v_it.product_id, v_it.variant_id, v_info.product_name,
        v_info.variant_label, v_info.sku, v_info.unit, v_it.qty, coalesce(v_it.price, 0), v_sort
      );
      v_sort := v_sort + 1;
      v_units := v_units + v_it.qty;
      v_value := v_value + v_it.qty * coalesce(v_it.price, 0);
    end loop;

    if v_resv is not null then
      update stock_reservations set total_units = v_units, total_value = round(v_value, 2) where id = v_resv;
      update sale_orders set reservation_id = v_resv where id = p_id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
      values (v_tenant, auth.uid(), 'stock_reservations', v_resv, 'stock_reservation_created',
              jsonb_build_object('number', v_rnum, 'store_id', p_store_id, 'channel', 'pedido',
                                 'sale_order_id', p_id, 'total_units', v_units, 'expires_at', v_until),
              p_store_id);
    end if;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'sale_orders', p_id, 'sale_order_created',
          jsonb_build_object('number', v_number, 'store_id', p_store_id, 'fulfillment_store_id', v_ful,
                             'delivery_type', v_type, 'total', round(coalesce((p_order ->> 'total')::numeric, 0), 2),
                             'seller_professional_id', v_prof, 'reservation_id', v_resv,
                             'reserved_until', v_until, 'customer_name', v_cname),
          p_store_id);

  return jsonb_build_object('id', p_id, 'number', v_number, 'reservation_id', v_resv,
                            'reserved_until', v_until, 'pickup_code', v_code);
end;
$$;
revoke all on function sale_order_create(uuid, uuid, jsonb) from public, anon;
grant execute on function sale_order_create(uuid, uuid, jsonb) to authenticated;

-- ¿La reserva del pedido sigue comprometiendo stock?
create or replace function _sale_order_resv_active(p_resv uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select r.status in ('reservada', 'preparada') and r.expires_at > now()
                     from stock_reservations r where r.id = p_resv), false);
$$;
revoke all on function _sale_order_resv_active(uuid) from public, anon, authenticated;

-- Fila del pedido para el POS (sin el hash del código).
create or replace function _sale_order_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (to_jsonb(o) - 'pickup_code_hash')
         || jsonb_build_object('reservation_active', _sale_order_resv_active(o.reservation_id),
                               'has_pickup_code', o.pickup_code_hash is not null)
    from sale_orders o where o.id = p_id;
$$;
revoke all on function _sale_order_json(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) Levantar (la caja lo toma para cobrar), soltar y anular
-- -----------------------------------------------------------------------------
create or replace function sale_order_take(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o      sale_orders;
  v_tenant uuid;
  v_role   text := stock_my_role();
  v_r      stock_reservations;
  v_until  timestamptz;
begin
  select * into v_o from sale_orders
   where id = p_id and tenant_id = current_tenant_id() and deleted_at is null
   for update;
  if v_o.id is null then
    raise exception 'order_not_found';
  end if;
  -- Se cobra en la sucursal del pedido (ahí está reservado el stock).
  v_tenant := _order_assert(v_o.store_id);
  -- Reservas vencidas por reloj pasan a 'vencida' (el trigger marca el pedido).
  perform stock_reservations_expire_due(v_tenant);
  select * into v_o from sale_orders where id = p_id;
  if v_o.status = 'cobrado' then
    raise exception 'order_already_paid';
  end if;
  if v_o.status in ('anulado', 'vencido') then
    raise exception 'order_closed: %', v_o.status;
  end if;
  if v_o.status = 'tomado' and v_o.taken_by is distinct from auth.uid()
     and coalesce(v_role, '') not in ('owner', 'manager') then
    raise exception 'order_taken_by_other';
  end if;

  if v_o.reservation_id is not null then
    select * into v_r from stock_reservations where id = v_o.reservation_id for update;
    if v_r.status in ('reservada', 'preparada') and v_r.expires_at > now() then
      -- La caja valida el pedido (no hay código): create_sale la acepta y se
      -- estira 15 minutos para que no venza a mitad del cobro.
      v_until := greatest(v_r.expires_at, now() + interval '15 minutes');
      update stock_reservations
         set pickup_verified_at = now(), pickup_verified_by = auth.uid(), pickup_verified_via = 'pedido',
             expires_at = v_until
       where id = v_r.id;
      v_o.reserved_until := v_until;
    elsif v_o.reservation_released_at is null then
      v_o.reservation_released_at := now();
    end if;
  end if;

  update sale_orders
     set status = 'tomado', taken_by = auth.uid(), taken_at = now(),
         reserved_until = v_o.reserved_until, reservation_released_at = v_o.reservation_released_at
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'sale_orders', p_id, 'sale_order_taken',
          jsonb_build_object('status', v_o.status, 'taken_by', v_o.taken_by),
          jsonb_build_object('status', 'tomado', 'reservation_active', _sale_order_resv_active(v_o.reservation_id)),
          v_o.store_id);

  return _sale_order_json(p_id);
end;
$$;
revoke all on function sale_order_take(uuid) from public, anon;
grant execute on function sale_order_take(uuid) to authenticated;

-- La caja sale del cobro sin cobrar: el pedido vuelve a la lista.
create or replace function sale_order_leave(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o      sale_orders;
  v_tenant uuid;
  v_role   text := stock_my_role();
begin
  select * into v_o from sale_orders
   where id = p_id and tenant_id = current_tenant_id() and deleted_at is null
   for update;
  if v_o.id is null then
    raise exception 'order_not_found';
  end if;
  v_tenant := _order_assert(v_o.store_id);
  if v_o.status <> 'tomado' then
    return;
  end if;
  if v_o.taken_by is distinct from auth.uid() and coalesce(v_role, '') not in ('owner', 'manager') then
    raise exception 'order_taken_by_other';
  end if;
  update sale_orders set status = 'abierto', taken_by = null, taken_at = null where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'sale_orders', p_id, 'sale_order_left',
          jsonb_build_object('status', 'tomado', 'taken_by', v_o.taken_by),
          jsonb_build_object('status', 'abierto'), v_o.store_id);
end;
$$;
revoke all on function sale_order_leave(uuid) from public, anon;
grant execute on function sale_order_leave(uuid) to authenticated;

create or replace function sale_order_cancel(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o      sale_orders;
  v_tenant uuid;
  v_role   text := stock_my_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_r      stock_reservations;
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  select * into v_o from sale_orders
   where id = p_id and tenant_id = current_tenant_id() and deleted_at is null
   for update;
  if v_o.id is null then
    raise exception 'order_not_found';
  end if;
  v_tenant := _order_assert(v_o.store_id);
  if v_o.status not in ('abierto', 'tomado') then
    raise exception 'order_closed: %', v_o.status;
  end if;
  if v_o.status = 'tomado' and v_o.taken_by is distinct from auth.uid()
     and coalesce(v_role, '') not in ('owner', 'manager') then
    raise exception 'order_taken_by_other';
  end if;

  update sale_orders
     set status = 'anulado', cancel_reason = left(v_reason, 300), cancelled_by = auth.uid(), cancelled_at = now(),
         reservation_released_at = coalesce(reservation_released_at, case when reservation_id is not null then now() end)
   where id = p_id;

  if v_o.reservation_id is not null then
    select * into v_r from stock_reservations where id = v_o.reservation_id for update;
    if v_r.status in ('reservada', 'preparada') then
      update stock_reservations
         set status = 'cancelada', cancel_reason = left('Pedido anulado: ' || v_reason, 300),
             cancelled_by = auth.uid(), cancelled_at = now()
       where id = v_r.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
      values (v_tenant, auth.uid(), 'stock_reservations', v_r.id, 'stock_reservation_cancelled',
              jsonb_build_object('status', v_r.status),
              jsonb_build_object('status', 'cancelada', 'sale_order_id', p_id), v_reason, v_o.store_id);
    end if;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_tenant, auth.uid(), 'sale_orders', p_id, 'sale_order_cancelled',
          jsonb_build_object('status', v_o.status), jsonb_build_object('status', 'anulado'), v_reason, v_o.store_id);
end;
$$;
revoke all on function sale_order_cancel(uuid, text) from public, anon;
grant execute on function sale_order_cancel(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Cobrado: por la reserva (trigger, atómico con create_sale) o enlace
-- -----------------------------------------------------------------------------
create or replace function stock_reservations_sale_order_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o sale_orders;
begin
  select * into v_o from sale_orders where id = new.sale_order_id for update;
  if v_o.id is null or v_o.status not in ('abierto', 'tomado') then
    return null;
  end if;
  if new.status = 'entregada' and new.sale_id is not null then
    -- create_sale (o la entrega con número de venta) consumió la reserva.
    -- Nunca hace fallar la venta: si algo falla, el pedido queda tomado y el
    -- POS lo enlaza después con sale_order_complete (que sí avisa el error).
    begin
      perform _sale_order_mark_paid(v_o.id, new.sale_id, 'reserva');
    exception when others then
      raise warning 'sale_order % no se pudo marcar cobrado: %', v_o.id, sqlerrm;
    end;
  elsif new.status in ('cancelada', 'vencida') and v_o.reservation_released_at is null then
    update sale_orders set reservation_released_at = now() where id = v_o.id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_o.tenant_id, auth.uid(), 'sale_orders', v_o.id, 'sale_order_reservation_released',
            jsonb_build_object('reservation_id', new.id, 'reservation_status', new.status), v_o.store_id);
  end if;
  return null;
end;
$$;
revoke all on function stock_reservations_sale_order_sync() from public, anon, authenticated;

drop trigger if exists stock_reservations_sale_order_sync on stock_reservations;
create trigger stock_reservations_sale_order_sync
  after update of status on stock_reservations
  for each row
  when (new.sale_order_id is not null and old.status is distinct from new.status)
  execute function stock_reservations_sale_order_sync();

-- Enlace después de cobrar sin la reserva (liberada o sin reservas_stock).
-- Idempotente: con la misma venta devuelve ok aunque ya esté cobrado.
create or replace function sale_order_complete(p_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o      sale_orders;
  v_tenant uuid;
  v_sale   record;
  v_r      stock_reservations;
begin
  select * into v_o from sale_orders
   where id = p_id and tenant_id = current_tenant_id() and deleted_at is null
   for update;
  if v_o.id is null then
    raise exception 'order_not_found';
  end if;
  v_tenant := _order_assert(v_o.store_id);
  if v_o.status = 'cobrado' then
    if v_o.sale_id = p_sale_id then
      return jsonb_build_object('ok', true, 'already', true);
    end if;
    raise exception 'order_already_paid';
  end if;
  if v_o.status not in ('abierto', 'tomado') then
    raise exception 'order_closed: %', v_o.status;
  end if;
  select s.id, s.store_id, s.status into v_sale
    from sales s where s.id = p_sale_id and s.tenant_id = v_tenant;
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'sale_not_completed';
  end if;
  if v_sale.store_id <> v_o.store_id then
    raise exception 'sale_wrong_store';
  end if;
  if exists (select 1 from sale_orders where sale_id = p_sale_id and id <> p_id) then
    raise exception 'sale_already_used';
  end if;

  if v_o.reservation_id is not null then
    select * into v_r from stock_reservations where id = v_o.reservation_id for update;
    if v_r.status in ('reservada', 'preparada') and v_r.expires_at > now()
       and not exists (select 1 from stock_reservations x where x.sale_id = p_sale_id and x.id <> v_r.id) then
      -- La venta ya descontó el stock: la reserva se da por entregada con ella
      -- (sin doble compromiso). El trigger marca el pedido cobrado.
      update stock_reservations
         set status = 'entregada', sale_id = p_sale_id, delivered_by = auth.uid(), delivered_at = now()
       where id = v_r.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
      values (v_tenant, auth.uid(), 'stock_reservations', v_r.id, 'stock_reservation_delivered',
              jsonb_build_object('status', v_r.status),
              jsonb_build_object('status', 'entregada', 'sale_id', p_sale_id, 'source', 'pedido'), v_o.store_id);
      return jsonb_build_object('ok', true);
    end if;
  end if;

  perform _sale_order_mark_paid(p_id, p_sale_id, 'enlace');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function sale_order_complete(uuid, uuid) from public, anon;
grant execute on function sale_order_complete(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- I) Vencimiento (pg_cron cada minuto, sólo service_role)
-- -----------------------------------------------------------------------------
-- Pedidos abiertos cuya reserva venció (por reloj, por el vencimiento perezoso
-- de ADR-091 o porque la cancelaron) o, sin reserva, con el plazo cumplido.
--   expiry_action 'release': se libera la reserva y el pedido sigue abierto.
--   expiry_action 'cancel' : el pedido queda vencido (uno tomado por la caja
--                            no se toca: se está cobrando).
create or replace function sale_orders_expire_due(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o   record;
  v_act text;
  v_n   int := 0;
begin
  for v_o in
    select o.id, o.tenant_id, o.status, o.store_id, o.reservation_id, o.reserved_until,
           r.status as r_status, r.expires_at as r_expires
      from sale_orders o
      left join stock_reservations r on r.id = o.reservation_id
     where o.status in ('abierto', 'tomado')
       and o.deleted_at is null
       and o.reservation_released_at is null
       and (
         (o.reservation_id is not null
          and (r.status in ('vencida', 'cancelada') or r.expires_at <= now()))
         or (o.reservation_id is null and o.reserved_until <= now())
       )
     order by o.reserved_until
     limit greatest(coalesce(p_limit, 500), 1)
     for update of o skip locked
  loop
    v_act := pos_order_config(v_o.tenant_id) ->> 'expiry_action';
    if v_o.reservation_id is not null and v_o.r_status in ('reservada', 'preparada') then
      update stock_reservations set status = 'vencida' where id = v_o.reservation_id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
      values (v_o.tenant_id, null, 'stock_reservations', v_o.reservation_id, 'stock_reservation_expired',
              jsonb_build_object('store_id', v_o.store_id, 'sale_order_id', v_o.id), v_o.store_id);
    end if;
    if v_act = 'cancel' and v_o.status = 'abierto' then
      update sale_orders
         set status = 'vencido', expired_at = now(),
             reservation_released_at = coalesce(reservation_released_at, case when reservation_id is not null then now() end)
       where id = v_o.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
      values (v_o.tenant_id, null, 'sale_orders', v_o.id, 'sale_order_expired',
              jsonb_build_object('status', v_o.status), jsonb_build_object('status', 'vencido'), v_o.store_id);
    else
      -- Liberada (o sin reserva: el plazo se cumplió). El trigger de la
      -- reserva ya pudo marcarla; si no, se marca acá y no se vuelve a tomar.
      update sale_orders set reservation_released_at = now()
       where id = v_o.id and reservation_released_at is null;
      if found and v_o.reservation_id is not null then
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
        values (v_o.tenant_id, null, 'sale_orders', v_o.id, 'sale_order_reservation_released',
                jsonb_build_object('reservation_id', v_o.reservation_id, 'reservation_status', 'vencida'), v_o.store_id);
      end if;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function sale_orders_expire_due(int) from public, anon, authenticated;
grant execute on function sale_orders_expire_due(int) to service_role;

-- -----------------------------------------------------------------------------
-- J) Expedición
-- -----------------------------------------------------------------------------
-- Entrega para una venta ya cobrada que no vino de un pedido (desde Ventas o
-- desde Expedición con el número de venta). p_delivery: {delivery_type,
-- fulfillment_store_id, pickup_name, ship_address, notes}.
create or replace function dispatch_create_for_sale(p_sale_id uuid, p_delivery jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid;
  v_sale   record;
  v_type   text := coalesce(nullif(btrim(p_delivery ->> 'delivery_type'), ''), 'retiro');
  v_ful    uuid;
  v_cfg    jsonb;
  v_pickup text := nullif(btrim(coalesce(p_delivery ->> 'pickup_name', '')), '');
  v_cname  text;
  v_id     uuid;
  v_code   text;
begin
  select s.id, s.store_id, s.status, s.customer_id into v_sale
    from sales s where s.id = p_sale_id and s.tenant_id = current_tenant_id();
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  v_tenant := _order_assert(v_sale.store_id);
  if v_sale.status <> 'completed' then
    raise exception 'sale_not_completed';
  end if;
  if exists (select 1 from dispatches where sale_id = p_sale_id and status <> 'cancelado' and deleted_at is null) then
    raise exception 'sale_already_dispatched';
  end if;
  v_ful := _order_delivery_check(v_tenant, v_sale.store_id, v_type,
                                 nullif(p_delivery ->> 'fulfillment_store_id', '')::uuid,
                                 p_delivery ->> 'ship_address');
  v_cfg := pos_order_config(v_tenant);
  select c.name into v_cname from customers c where c.id = v_sale.customer_id;
  if v_type = 'retiro' then
    v_pickup := coalesce(v_pickup, v_cname);
    if v_pickup is null then
      raise exception 'pickup_name_required';
    end if;
  end if;
  v_id := _dispatch_open(v_tenant, p_sale_id, null, v_sale.store_id, v_ful, v_type, coalesce(v_cname, v_pickup),
                         v_pickup, null, case when v_type = 'envio' then p_delivery ->> 'ship_address' end,
                         p_delivery ->> 'notes');
  if v_type = 'retiro' and (v_cfg -> 'delivery_types' -> 'retiro' ->> 'pickup_code')::boolean then
    v_code := otp_random_digits(6);
    update dispatches set pickup_code_hash = stock_reservation_code_hash(v_id, v_code) where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'number', (select number from dispatches where id = v_id),
                            'pickup_code', v_code);
end;
$$;
revoke all on function dispatch_create_for_sale(uuid, jsonb) from public, anon;
grant execute on function dispatch_create_for_sale(uuid, jsonb) to authenticated;

-- Guard de una entrega: plan, rol y acceso a la sucursal que vende o entrega.
create or replace function _dispatch_lock(p_id uuid)
returns dispatches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d dispatches;
begin
  select * into v_d from dispatches
   where id = p_id and tenant_id = current_tenant_id() and deleted_at is null
   for update;
  if v_d.id is null then
    raise exception 'dispatch_not_found';
  end if;
  if stock_my_role() is null or stock_my_role() = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_d.tenant_id, 'pedidos_despacho') then
    raise exception 'feature_not_in_plan: pedidos_despacho' using errcode = 'check_violation';
  end if;
  if not (coalesce(user_can_access_store(v_d.store_id), false)
          or coalesce(user_can_access_store(v_d.fulfillment_store_id), false)) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  return v_d;
end;
$$;
revoke all on function _dispatch_lock(uuid) from public, anon, authenticated;

-- Armando, listo, en tránsito o de vuelta a pendiente.
create or replace function dispatch_advance(p_id uuid, p_to text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d     dispatches;
  v_cross boolean;
  v_arr   boolean;
begin
  v_d := _dispatch_lock(p_id);
  if p_to not in ('pendiente', 'armando', 'listo', 'en_transito') then
    raise exception 'invalid_status: %', p_to;
  end if;
  v_cross := v_d.fulfillment_store_id <> v_d.store_id;
  v_arr := v_d.arrived_at is not null;
  if not _dispatch_can(v_d.status, p_to, v_d.delivery_type, v_cross, v_arr) then
    raise exception 'invalid_transition: % -> %', v_d.status, p_to;
  end if;
  -- El envío a otra sucursal sale de la que vende; la recepción la hace la de entrega.
  if p_to = 'en_transito' and not coalesce(user_can_access_store(v_d.store_id), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_d.status = 'en_transito' and not coalesce(user_can_access_store(v_d.fulfillment_store_id), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;

  update dispatches
     set status = p_to,
         prepared_by = case when p_to = 'armando' then auth.uid() else prepared_by end,
         prepared_at = case when p_to = 'armando' then now() else prepared_at end,
         ready_by = case when p_to = 'listo' and v_d.status <> 'en_transito' then auth.uid() else ready_by end,
         ready_at = case when p_to = 'listo' and v_d.status <> 'en_transito' then now() else ready_at end,
         sent_by = case when p_to = 'en_transito' then auth.uid() else sent_by end,
         sent_at = case when p_to = 'en_transito' then now() else sent_at end,
         arrived_by = case when v_d.status = 'en_transito' then auth.uid() else arrived_by end,
         arrived_at = case when v_d.status = 'en_transito' then now() else arrived_at end,
         notes = coalesce(left(nullif(btrim(coalesce(p_note, '')), ''), 500), notes)
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', p_id, 'dispatch_status_changed',
          jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', p_to, 'arrived', v_d.status = 'en_transito'),
          case when v_d.status = 'en_transito' then v_d.fulfillment_store_id else v_d.store_id end);
end;
$$;
revoke all on function dispatch_advance(uuid, text, text) from public, anon;
grant execute on function dispatch_advance(uuid, text, text) to authenticated;

-- Entregar al cliente (retiro inmediato o en sucursal). Con código de retiro:
-- el código o, sin él, dueño o encargado con motivo. Un código mal tipeado
-- NO lanza excepción para que el intento quede contado (5 bloquean).
create or replace function dispatch_deliver(
  p_id              uuid,
  p_code            text default null,
  p_delivered_to    text default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_d        dispatches;
  v_role     text := stock_my_role();
  v_to       text := nullif(btrim(coalesce(p_delivered_to, '')), '');
  v_override text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_ok_code  boolean := false;
  v_cross    boolean;
begin
  v_d := _dispatch_lock(p_id);
  v_cross := v_d.fulfillment_store_id <> v_d.store_id;
  if not _dispatch_can(v_d.status, 'entregado', v_d.delivery_type, v_cross, v_d.arrived_at is not null) then
    raise exception 'invalid_transition: % -> entregado', v_d.status;
  end if;
  if not coalesce(user_can_access_store(v_d.fulfillment_store_id), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_d.delivery_type = 'retiro' and (v_to is null or char_length(v_to) < 2) then
    raise exception 'delivered_to_required';
  end if;

  if v_d.pickup_code_hash is not null then
    if v_d.failed_attempts < 5 and nullif(btrim(coalesce(p_code, '')), '') is not null then
      v_ok_code := stock_reservation_code_hash(coalesce(v_d.sale_order_id, v_d.id), p_code) = v_d.pickup_code_hash;
    end if;
    if not v_ok_code then
      if v_override is not null then
        if coalesce(v_role, '') not in ('owner', 'manager') then
          raise exception 'override_requires_manager' using errcode = '42501';
        end if;
      else
        update dispatches set failed_attempts = failed_attempts + 1 where id = p_id;
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
        values (v_d.tenant_id, auth.uid(), 'dispatches', p_id, 'dispatch_pickup_failed',
                jsonb_build_object('failed_attempts', v_d.failed_attempts + 1), v_d.fulfillment_store_id);
        return jsonb_build_object(
          'ok', false,
          'error', case when v_d.failed_attempts + 1 >= 5 then 'pickup_code_locked' else 'pickup_code_invalid' end,
          'attempts_left', greatest(5 - (v_d.failed_attempts + 1), 0));
      end if;
    end if;
  end if;

  update dispatches
     set status = 'entregado', delivered_by = auth.uid(), delivered_at = now(),
         delivered_to = left(coalesce(v_to, customer_name, pickup_name), 120),
         override_reason = case when v_d.pickup_code_hash is not null and not v_ok_code then left(v_override, 300) end
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', p_id, 'dispatch_delivered',
          jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', 'entregado', 'delivered_to', coalesce(v_to, v_d.customer_name, v_d.pickup_name),
                             'verified_by', case when v_d.pickup_code_hash is null then 'none'
                                                 when v_ok_code then 'code' else 'override' end),
          case when v_d.pickup_code_hash is not null and not v_ok_code then v_override end,
          v_d.fulfillment_store_id);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function dispatch_deliver(uuid, text, text, text) from public, anon;
grant execute on function dispatch_deliver(uuid, text, text, text) to authenticated;

-- Envío a domicilio despachado. Engancha el envío de la venta (ADR-103): el
-- indicado o el último de esa venta.
create or replace function dispatch_ship(p_id uuid, p_tracking text default null, p_shipment_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d     dispatches;
  v_ship  uuid;
  v_track text := left(nullif(btrim(coalesce(p_tracking, '')), ''), 120);
begin
  v_d := _dispatch_lock(p_id);
  if not _dispatch_can(v_d.status, 'despachado', v_d.delivery_type, v_d.fulfillment_store_id <> v_d.store_id,
                       v_d.arrived_at is not null) then
    raise exception 'invalid_transition: % -> despachado', v_d.status;
  end if;
  if p_shipment_id is not null then
    select sh.id into v_ship from shipments sh
     where sh.id = p_shipment_id and sh.tenant_id = v_d.tenant_id and sh.sale_id = v_d.sale_id
       and sh.deleted_at is null;
    if v_ship is null then
      raise exception 'shipment_not_found';
    end if;
  else
    select sh.id, coalesce(v_track, sh.tracking_number) into v_ship, v_track from shipments sh
     where sh.tenant_id = v_d.tenant_id and sh.sale_id = v_d.sale_id and sh.deleted_at is null
     order by sh.created_at desc
     limit 1;
  end if;
  update dispatches
     set status = 'despachado', delivered_by = auth.uid(), delivered_at = now(),
         shipment_id = v_ship, tracking = v_track
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', p_id, 'dispatch_shipped',
          jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', 'despachado', 'shipment_id', v_ship, 'tracking', v_track),
          v_d.fulfillment_store_id);
end;
$$;
revoke all on function dispatch_ship(uuid, text, uuid) from public, anon;
grant execute on function dispatch_ship(uuid, text, uuid) to authenticated;

-- Cancelar una entrega (la venta no cambia: para devolver, Devoluciones).
create or replace function dispatch_cancel(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d      dispatches;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  v_d := _dispatch_lock(p_id);
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'cancel_requires_manager' using errcode = '42501';
  end if;
  if v_d.status in ('entregado', 'despachado', 'cancelado') then
    raise exception 'invalid_transition: % -> cancelado', v_d.status;
  end if;
  update dispatches
     set status = 'cancelado', cancel_reason = left(v_reason, 300), cancelled_by = auth.uid(), cancelled_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', p_id, 'dispatch_cancelled',
          jsonb_build_object('status', v_d.status), jsonb_build_object('status', 'cancelado'), v_reason, v_d.store_id);
end;
$$;
revoke all on function dispatch_cancel(uuid, text) from public, anon;
grant execute on function dispatch_cancel(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- K) Stock reservado vigente para mostrar el disponible (POS)
-- -----------------------------------------------------------------------------
-- Con p_store_id null, todas las sucursales del negocio. Sin reservas_stock
-- devuelve vacío (no hay reservas que descontar).
create or replace function stock_reserved_by_store(p_store_id uuid default null)
returns table (store_id uuid, product_id uuid, variant_id uuid, reserved numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if stock_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'reservas_stock') then
    return;
  end if;
  return query
    select i.store_id, i.product_id, i.variant_id, sum(i.qty)::numeric
      from stock_reservation_items i
      join stock_reservations r on r.id = i.reservation_id
     where r.tenant_id = v_tenant
       and r.status in ('reservada', 'preparada')
       and r.expires_at > now()
       and (p_store_id is null or i.store_id = p_store_id)
     group by i.store_id, i.product_id, i.variant_id;
end;
$$;
revoke all on function stock_reserved_by_store(uuid) from public, anon;
grant execute on function stock_reserved_by_store(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- L) Catálogo público: disponible = stock − reservado vigente (copia de
--    20261121200000_nombre_fantasia + 'available').
-- -----------------------------------------------------------------------------
create or replace function public.public_catalog(p_slug text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select case when tt.id is null then null else jsonb_build_object(
    'tenant', jsonb_build_object('name', tt.name, 'slug', tt.slug),
    'branding', (
      select jsonb_build_object(
        'logo_url', b.logo_url, 'accent', b.accent, 'legal_name', b.legal_name,
        -- ADR-124: nombre de fantasía (el catálogo lo usa como título).
        'trade_name', nullif(btrim(b.trade_name), ''),
        'phone', b.phone, 'address', b.address
      ) from tenant_branding b where b.tenant_id = tt.id
    ),
    'products', coalesce((
      select jsonb_agg(s.x order by s.name) from (
        select p.name,
          jsonb_build_object(
            'id', p.id, 'name', p.name,
            -- Precio resuelto por la lista 'catalogo' activa (item por producto →
            -- ajuste % → base). Sin lista activa → precio base.
            'price', coalesce(
              pli.price,
              case when pl.adjustment_pct is not null
                then round(p.price * (1 + pl.adjustment_pct / 100), 2)
                else p.price end
            ),
            'image_url', p.image_url, 'category', c.name,
            -- ADR-129: disponible = stock − reservado vigente (pedidos y
            -- reservas). null = no controla stock (kits, servicios).
            'available', case
              when coalesce(p.track_stock, true) and not coalesce(p.is_kit, false)
                   and not coalesce(p.is_service, false)
              then greatest(coalesce(p.stock, 0) - coalesce((
                     select sum(ri.qty)
                       from stock_reservation_items ri
                       join stock_reservations r on r.id = ri.reservation_id
                      where ri.product_id = p.id and r.tenant_id = tt.id
                        and r.status in ('reservada', 'preparada') and r.expires_at > now()), 0), 0)
            end
          ) as x
        from products p
        left join categories c on c.id = p.category_id
        left join lateral (
          select id, adjustment_pct from price_lists
          where tenant_id = tt.id and channel = 'catalogo'
            and is_active and deleted_at is null
          limit 1
        ) pl on true
        left join price_list_items pli
          on pli.price_list_id = pl.id
         and pli.product_id = p.id
         and pli.variant_id is null
        where p.tenant_id = tt.id and p.is_active and p.deleted_at is null
      ) s
    ), '[]'::jsonb)
  ) end
  from (
    select id, name, slug from tenants
    where slug = p_slug and deleted_at is null and status in ('trial','active')
      -- Gate de plan: sin catalogo_publico no se publica el storefront.
      and tenant_has_feature_for(id, 'catalogo_publico')
    limit 1
  ) tt;
$function$;

-- -----------------------------------------------------------------------------
-- M) pg_cron: cada minuto. Sin pg_cron (stack local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el vencimiento de pedidos de salón.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'sale-orders-expire') then
    perform cron.unschedule('sale-orders-expire');
  end if;
  perform cron.schedule('sale-orders-expire', '* * * * *', $$select public.sale_orders_expire_due(500)$$);
end
$cron$;
