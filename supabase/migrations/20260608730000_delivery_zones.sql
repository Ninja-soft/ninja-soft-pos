-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · H49 follow-up — Zonas de envío con tarifa automática (delivery)      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Hoy el costo de envío (delivery_orders.delivery_fee) se carga a mano por
-- pedido. Esto lo automatiza por ZONA: el dueño define zonas (ej. "Centro",
-- "Zona Norte") con su tarifa, y al tomar un pedido de delivery elige la zona →
-- el fee se AUTOCOMPLETA con la tarifa de la zona (y queda editable: override
-- manual). El fee real se SNAPSHOTEA en delivery_orders.delivery_fee, así
-- cambiar la tarifa de la zona después NO altera pedidos viejos.
--
-- MODELO:
--   1) `delivery_zones`: zonas del tenant (nombre, tarifa, eta opcional, activa,
--      orden). Baja lógica (deleted_at). RLS: lectura por miembros del tenant;
--      ESCRITURA sólo owner/manager (espeja tenant_branding · config del tenant).
--      A diferencia de dining_areas (CRUD abierto a cualquier miembro), las zonas
--      son configuración comercial → se gatean a owner/manager también en la DB.
--   2) `delivery_orders.zone_id`: qué zona se eligió (FK, on delete set null). El
--      fee NO se lee de la zona al mostrar: vive snapshotteado en delivery_fee.
--
-- create_delivery_order: se agrega `p_zone_id` (opcional, al final). Si viene
-- zona, valida que sea del tenant y la guarda. Si viene zona y NO viene fee
-- explícito (p_delivery_fee NULL), copia el fee de la zona (red de seguridad).
-- La UI igual autocompleta el fee al elegir la zona y manda el fee explícito
-- (posiblemente editado), así que el snapshot es lo que el cajero ve/edita.
--
-- FUERA DE ALCANCE (follow-up, NO en este PR): geocoding/mapa de la dirección,
-- detección automática de zona por dirección/GPS, polígonos, tarifa por
-- distancia/peso, mínimos por zona.
-- types/database.ts NO se regenera (el front castea; la DB + RLS validan).
-- =============================================================================

-- ── 1) Zonas de envío ─────────────────────────────────────────────────────────
create table if not exists delivery_zones (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  -- Nombre de la zona (ej. "Centro", "Zona Norte").
  name        text not null,
  -- Tarifa de envío de la zona. Se autocompleta en el alta y se snapshotea en
  -- delivery_orders.delivery_fee (cambiarla después no toca pedidos viejos).
  fee         numeric(12,2) not null default 0 check (fee >= 0),
  -- Tiempo estimado de entrega (minutos), opcional.
  eta_minutes int check (eta_minutes is null or eta_minutes >= 0),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists delivery_zones_tenant_idx
  on delivery_zones(tenant_id) where deleted_at is null;

create trigger set_updated_at_delivery_zones
  before update on delivery_zones
  for each row execute function set_updated_at();

alter table delivery_zones enable row level security;

-- Lectura: miembros del tenant (la usa el alta de pedido). Escritura: sólo
-- owner/manager del tenant (config comercial; espeja tenant_branding).
create policy delivery_zones_select on delivery_zones
  for select using (tenant_id = current_tenant_id());

create policy delivery_zones_write on delivery_zones
  for all
  using (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner','manager')
    )
  )
  with check (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner','manager')
    )
  );

create trigger audit_delivery_zones
  after insert or update or delete on delivery_zones
  for each row execute function write_audit_log();

-- ── 2) delivery_orders.zone_id ────────────────────────────────────────────────
-- Qué zona se eligió. on delete set null: borrar/archivar una zona no rompe
-- pedidos viejos (el fee ya está snapshotteado en delivery_fee).
alter table delivery_orders
  add column if not exists zone_id uuid references delivery_zones(id) on delete set null;
create index if not exists delivery_orders_zone_idx on delivery_orders(zone_id);

-- ── 3) create_delivery_order: + p_zone_id (autocompleta el fee desde la zona) ──
-- ESPEJA la versión H49 (guard de miembro activo, validación de tipo/canal/
-- cliente, takeaway sin dirección). Agrega p_zone_id (opcional, al FINAL):
--   • Si viene zona, valida que sea del tenant (no exige que esté activa: un
--     pedido podría re-tipearse; pero sí debe existir y no estar borrada) y la
--     guarda en zone_id. Sólo aplica a delivery (takeaway no tiene envío → zona
--     y fee = null/0).
--   • Si viene zona y p_delivery_fee es NULL, copia el fee de la zona (red de
--     seguridad server-side). Si viene fee explícito, gana el fee (override).
-- Cambio de aridad → la nueva firma (12 args) con default cubre las llamadas de
-- 11 nombres; se elimina la firma vieja de 11 args (mismo criterio que el cobro
-- atómico de mesa / dining_courses).
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

  -- Zona: sólo para delivery. Debe ser del tenant y no estar borrada. Si la zona
  -- existe, leemos su fee para autocompletar cuando no venga fee explícito.
  if v_type = 'delivery' and p_zone_id is not null then
    select id, fee into v_zone_id, v_zone_fee
      from delivery_zones
     where id = p_zone_id and tenant_id = v_tenant and deleted_at is null;
    if v_zone_id is null then
      raise exception 'zone_not_found';
    end if;
  end if;

  -- Fee final (snapshot): takeaway = 0. Para delivery, el fee explícito gana
  -- (override manual); si no vino fee y hay zona, copia el fee de la zona; si no,
  -- 0. Nunca negativo.
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
    -- Takeaway no lleva dirección.
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
$$;

-- Eliminar la firma anterior de 11 args (sin p_zone_id) para que exista una sola
-- definición autoritativa. La nueva de 12 args con default cubre todas las
-- llamadas de 11 nombres (PostgREST incluido).
drop function if exists create_delivery_order(text, text, uuid, text, text, text, text, timestamptz, text, numeric, text);

revoke all on function create_delivery_order(text, text, uuid, text, text, text, text, timestamptz, text, numeric, text, uuid) from public, anon;
grant execute on function create_delivery_order(text, text, uuid, text, text, text, text, timestamptz, text, numeric, text, uuid) to authenticated;
