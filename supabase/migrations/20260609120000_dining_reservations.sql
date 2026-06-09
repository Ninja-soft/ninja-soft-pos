-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · H51 — Reservas gastronómicas (agenda de mesas, sentar y seña)        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Parte de la SUITE de mesas (H44). Una reserva agenda una mesa o un sector para
-- una fecha/hora, con cliente (del catálogo o suelto), comensales, duración y
-- seña opcional. Cuando el cliente llega, se SIENTA: la reserva se convierte en
-- una mesa ocupada (reusa open_dining_table) conservando cliente/seña.
--
-- GATING: detrás de pos_settings.dining_enabled (toggle operativo del dueño, NO
-- feature de plan), consistente con el resto de la suite gastro (mesas/KDS).
--
-- MODELO:
--   `dining_reservations` (la reserva). Estados:
--     pendiente → confirmada → sentada (+ cancelada / no_show).
--   La reserva puede apuntar a una mesa específica (table_id) y/o a un sector
--   (area_id). Al SENTAR se abre la mesa (open_dining_table), se enlaza
--   table_order_id y la reserva pasa a 'sentada'.
--
-- BLOQUEO DE MESA (opcional/simple): si la reserva tiene table_id, se puede
-- marcar la mesa como 'reservada' (estado nuevo de dining_tables). Al SENTAR la
-- mesa pasa a 'ocupada' con su orden. Si la mesa no estaba reservada por esta
-- reserva, no se fuerza nada.
--
-- RPCs SECURITY DEFINER tenant-scoped (guard de miembro activo
-- `_dining_assert_member()`, search_path fijo), espejando las de mesa/delivery.
--
-- FUERA DE ALCANCE (follow-up, NO en este PR): recordatorio automático al cliente
-- (WhatsApp/email), reservas online públicas (storefront), overbooking/capacidad
-- por franja avanzada, waitlist.
-- types/database.ts NO se regenera (el front castea; la DB + RLS validan).
-- =============================================================================

-- ── 0) Estado 'reservada' en dining_tables (bloqueo opcional por reserva) ─────
-- Amplía el check de status para permitir marcar una mesa como reservada cuando
-- una reserva la tiene asignada. Al sentar pasa a 'ocupada'; al cancelar/no_show
-- vuelve a 'libre'. Aditivo: las mesas existentes (libre/ocupada/…) no cambian.
alter table dining_tables drop constraint if exists dining_tables_status_check;
alter table dining_tables add constraint dining_tables_status_check
  check (status in ('libre','ocupada','cuenta_pedida','bloqueada','reservada'));

-- ── 1) Reservas ───────────────────────────────────────────────────────────────
create table if not exists dining_reservations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  -- Sector (opcional) y/o mesa específica (opcional). Ambos null = reserva sin
  -- ubicación fija (se asigna mesa al sentar).
  area_id          uuid references dining_areas(id) on delete set null,
  table_id         uuid references dining_tables(id) on delete set null,
  -- Cliente del catálogo (opcional) + snapshot de nombre/teléfono de la reserva.
  customer_id      uuid references customers(id) on delete set null,
  customer_name    text,
  customer_phone   text,
  -- Comensales y momento de la reserva.
  party_size       int not null default 2 check (party_size > 0),
  reserved_at      timestamptz not null,
  duration_minutes int not null default 90 check (duration_minutes > 0),
  -- Estado de la reserva (transiciones validadas en set_reservation_status).
  status           text not null default 'pendiente'
                     check (status in ('pendiente','confirmada','sentada','cancelada','no_show')),
  -- Seña opcional (lo que dejó el cliente para asegurar la reserva).
  deposit_amount   numeric(12,2) not null default 0 check (deposit_amount >= 0),
  -- Orden de mesa creada al sentar (NULL hasta entonces).
  table_order_id   uuid references table_orders(id) on delete set null,
  notes            text,
  created_by       uuid references public.users(id) default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists dining_reservations_tenant_idx
  on dining_reservations(tenant_id) where deleted_at is null;
-- Agenda por fecha/hora (la vista trae las del día / próximas, no el histórico).
create index if not exists dining_reservations_when_idx
  on dining_reservations(tenant_id, reserved_at) where deleted_at is null;
create index if not exists dining_reservations_status_idx
  on dining_reservations(tenant_id, status) where deleted_at is null;
create index if not exists dining_reservations_table_idx on dining_reservations(table_id);

create trigger set_updated_at_dining_reservations
  before update on dining_reservations
  for each row execute function set_updated_at();

alter table dining_reservations enable row level security;
create policy dining_reservations_tenant_isolation on dining_reservations
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create trigger audit_dining_reservations
  after insert or update or delete on dining_reservations
  for each row execute function write_audit_log();

-- ── 2) create_reservation: alta de una reserva ────────────────────────────────
-- Cliente del catálogo (p_customer_id) o suelto (nombre/teléfono). Si tiene mesa
-- asignada (p_table_id) y la mesa está libre, la marca 'reservada' (bloqueo
-- opcional). No falla si la mesa no está libre: simplemente no la bloquea.
create or replace function create_reservation(
  p_customer_id      uuid,
  p_customer_name    text,
  p_customer_phone   text,
  p_party_size       int,
  p_reserved_at      timestamptz,
  p_duration_minutes int default 90,
  p_area_id          uuid default null,
  p_table_id         uuid default null,
  p_deposit_amount   numeric default 0,
  p_notes            text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_name   text := nullif(btrim(p_customer_name), '');
  v_table  dining_tables%rowtype;
  v_id     uuid;
begin
  if p_reserved_at is null then
    raise exception 'reserved_at_required';
  end if;
  if coalesce(p_party_size, 0) <= 0 then
    raise exception 'invalid_party_size';
  end if;

  -- Si vino un cliente del catálogo y no se pasó nombre, tomá el del catálogo.
  if v_name is null and p_customer_id is not null then
    select name into v_name from customers
     where id = p_customer_id and tenant_id = v_tenant and deleted_at is null;
  end if;
  if v_name is null then
    raise exception 'customer_name_required';
  end if;

  -- Mesa asignada (opcional): debe ser del tenant y existir.
  if p_table_id is not null then
    select * into v_table from dining_tables
     where id = p_table_id and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'table_not_found';
    end if;
  end if;

  insert into dining_reservations (
    tenant_id, area_id, table_id, customer_id, customer_name, customer_phone,
    party_size, reserved_at, duration_minutes, deposit_amount, notes
  ) values (
    v_tenant, p_area_id, p_table_id, p_customer_id, v_name,
    nullif(btrim(p_customer_phone), ''),
    p_party_size, p_reserved_at, coalesce(nullif(p_duration_minutes, 0), 90),
    greatest(coalesce(p_deposit_amount, 0), 0), nullif(btrim(p_notes), '')
  )
  returning id into v_id;

  -- Bloqueo opcional/simple: si la mesa asignada está libre, marcala 'reservada'.
  if p_table_id is not null and v_table.status = 'libre' then
    update dining_tables set status = 'reservada'
     where id = p_table_id and tenant_id = v_tenant and status = 'libre';
  end if;

  return v_id;
end;
$$;
revoke all on function create_reservation(uuid, text, text, int, timestamptz, int, uuid, uuid, numeric, text) from public, anon;
grant execute on function create_reservation(uuid, text, text, int, timestamptz, int, uuid, uuid, numeric, text) to authenticated;

-- ── 3) set_reservation_status: transiciones válidas (confirmar / cancelar / …) ─
-- Transiciones permitidas:
--   pendiente  → confirmada / cancelada / no_show
--   confirmada → cancelada / no_show / pendiente
-- 'sentada' se alcanza SÓLO por seat_reservation (no por este RPC). 'cancelada'
-- y 'no_show' son terminales. Al cancelar / no_show, si la mesa estaba 'reservada'
-- por esta reserva, se libera.
create or replace function set_reservation_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_res    dining_reservations%rowtype;
begin
  if p_status not in ('pendiente','confirmada','cancelada','no_show') then
    raise exception 'invalid_status';
  end if;

  select * into v_res from dining_reservations
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'reservation_not_found';
  end if;

  -- No se puede salir de un estado terminal ni de 'sentada' por este RPC.
  if v_res.status in ('sentada','cancelada','no_show') then
    raise exception 'reservation_closed';
  end if;

  update dining_reservations set status = p_status, updated_at = now()
   where id = p_id and tenant_id = v_tenant;

  -- Si se cancela / no_show y la mesa estaba reservada por esta reserva, liberarla.
  if p_status in ('cancelada','no_show') and v_res.table_id is not null then
    update dining_tables set status = 'libre'
     where id = v_res.table_id and tenant_id = v_tenant and status = 'reservada';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'dining_reservations', p_id, 'reservation_status',
          jsonb_build_object('status', v_res.status),
          jsonb_build_object('status', p_status));

  return jsonb_build_object('id', p_id, 'status', p_status);
end;
$$;
revoke all on function set_reservation_status(uuid, text) from public, anon;
grant execute on function set_reservation_status(uuid, text) to authenticated;

-- ── 4) cancel_reservation: cancela con motivo ─────────────────────────────────
-- Atajo de set_reservation_status('cancelada') que además registra el motivo en
-- el audit. No se puede cancelar una reserva ya sentada / terminal.
create or replace function cancel_reservation(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_res    dining_reservations%rowtype;
begin
  select * into v_res from dining_reservations
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'reservation_not_found';
  end if;
  if v_res.status in ('sentada','cancelada','no_show') then
    raise exception 'reservation_closed';
  end if;

  update dining_reservations set status = 'cancelada', updated_at = now()
   where id = p_id and tenant_id = v_tenant;

  if v_res.table_id is not null then
    update dining_tables set status = 'libre'
     where id = v_res.table_id and tenant_id = v_tenant and status = 'reservada';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'dining_reservations', p_id, 'reservation_cancel',
          jsonb_build_object('status', v_res.status),
          jsonb_build_object('status', 'cancelada'),
          nullif(btrim(p_reason), ''));

  return jsonb_build_object('id', p_id, 'status', 'cancelada');
end;
$$;
revoke all on function cancel_reservation(uuid, text) from public, anon;
grant execute on function cancel_reservation(uuid, text) to authenticated;

-- ── 5) seat_reservation: sienta la reserva → mesa ocupada con su orden ─────────
-- Convierte la reserva en una mesa ocupada. Reusa open_dining_table (abre la mesa
-- y crea el pedido), luego enlaza table_order_id y marca la reserva 'sentada'.
-- p_table_id = mesa donde sentar (si la reserva no tenía mesa o se elige otra).
-- Si no se pasa, usa la mesa de la reserva. Valida que la mesa esté disponible
-- (libre o reservada — su propia reserva). Conserva cliente/nombre poniéndolo en
-- las notas del pedido (table_orders no tiene customer_id; el snapshot queda en
-- la reserva y se muestra en la cuenta).
create or replace function seat_reservation(p_id uuid, p_table_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := _dining_assert_member();
  v_res      dining_reservations%rowtype;
  v_table_id uuid;
  v_table    dining_tables%rowtype;
  v_open     jsonb;
  v_order_id uuid;
  v_seat_note text;
begin
  select * into v_res from dining_reservations
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'reservation_not_found';
  end if;
  if v_res.status not in ('pendiente','confirmada') then
    raise exception 'reservation_not_seatable';
  end if;

  v_table_id := coalesce(p_table_id, v_res.table_id);
  if v_table_id is null then
    raise exception 'table_required';
  end if;

  select * into v_table from dining_tables
   where id = v_table_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'table_not_found';
  end if;
  -- Disponible = libre, o reservada (la propia reserva la dejó así). Si está
  -- ocupada/cuenta_pedida/bloqueada por otro, no se puede sentar acá.
  if v_table.status not in ('libre','reservada') then
    raise exception 'table_not_free';
  end if;

  -- Pasá la mesa a 'libre' transitoriamente: open_dining_table rechaza 'bloqueada'
  -- pero acepta cualquier otro estado; 'reservada' no rompe nada (setea 'ocupada').
  -- No hace falta tocarla: open_dining_table sólo bloquea si status='bloqueada'.

  -- Abre la mesa (crea el pedido, mesa → ocupada). Reusa la lógica existente.
  v_open := open_dining_table(v_table_id, null);
  v_order_id := (v_open ->> 'order_id')::uuid;

  -- Conservá cliente/nombre + seña en las notas del pedido (snapshot legible en la
  -- cuenta del salón). Sólo si el pedido recién abierto no tenía notas.
  v_seat_note := 'Reserva: ' || coalesce(v_res.customer_name, 'cliente')
    || ' · ' || v_res.party_size || ' pax'
    || case when v_res.deposit_amount > 0
            then ' · seña ' || to_char(v_res.deposit_amount, 'FM999999990.00')
            else '' end;
  update table_orders
     set notes = coalesce(notes, v_seat_note), updated_at = now()
   where id = v_order_id and tenant_id = v_tenant and notes is null;

  -- Marca la reserva sentada y enlaza el pedido.
  update dining_reservations
     set status = 'sentada', table_id = v_table_id, table_order_id = v_order_id,
         updated_at = now()
   where id = p_id and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'dining_reservations', p_id, 'reservation_seat',
          jsonb_build_object('status', v_res.status),
          jsonb_build_object('status', 'sentada', 'table_id', v_table_id,
                             'table_order_id', v_order_id));

  return jsonb_build_object('id', p_id, 'status', 'sentada',
                            'table_id', v_table_id, 'table_order_id', v_order_id);
end;
$$;
revoke all on function seat_reservation(uuid, uuid) from public, anon;
grant execute on function seat_reservation(uuid, uuid) to authenticated;
