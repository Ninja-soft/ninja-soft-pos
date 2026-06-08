-- =============================================================================
-- 20260608540000_agenda  (F12 · H38 — agenda y servicios para peluquería/estética)
-- -----------------------------------------------------------------------------
-- Peluquerías / barberías / estética / uñas / spa / lavaderos / talleres /
-- profesionales con turnos: agendar un servicio con un profesional, gestionar la
-- agenda (día/semana) y COBRAR desde el turno reusando el flujo del POS.
--
-- MODELO (reusa lo existente; sin tablas nuevas para "servicio"):
--
--  1) SERVICIOS = productos. Un servicio es un `products` con track_stock=false
--     (ya respetado por create_sale; los presets de rubro · H35 ya los crean así)
--     + dos campos nuevos:
--       products.service_duration_min int      → duración por defecto (min).
--       products.commission_pct        numeric → % de comisión del profesional.
--     Cualquier producto puede usarse en un turno; los servicios sólo agregan
--     duración/comisión por defecto. Categorías, precio, favoritos, listas de
--     precios, modificadores: todo se reusa tal cual.
--
--  2) PROFESIONALES = tabla nueva `professionals` (quién presta el servicio).
--     No se sobrecarga cashier_profiles (perfil de cajero con PIN de login): un
--     profesional es un concepto de agenda con color y comisión por defecto.
--     Puede enlazarse opcionalmente a un user_id (miembro con login) para futuro
--     (permiso "ver sólo mi agenda" · H39), pero no es obligatorio.
--
--  3) AGENDA = tabla `appointments` (turnos). Guarda professional_id, customer_id
--     y service_product_id + un SNAPSHOT del servicio (nombre/precio/duración/
--     comisión al momento de agendar) para que el turno sea estable aunque el
--     producto cambie o se borre. starts_at/duration_min definen el bloque.
--     Estados: reservado, confirmado, en_curso, realizado, cancelado, no_show.
--     `sale_id` enlaza el turno con la venta cuando se cobra.
--
-- RLS: aislamiento por tenant en todo (igual que el resto del dominio). Las
-- RPCs de escritura validan owner/manager del tenant activo (mismo patrón que
-- apply_industry_preset). La lectura de la agenda es para cualquier miembro del
-- tenant (un cajero ve la agenda para cobrar); la escritura es owner/manager
-- (y queda lugar para "el propio profesional" en H39 vía professionals.user_id).
--
-- GATING: se agrega la feature `agenda` al catálogo como BÁSICA (is_basic=true)
-- → visible para todos los planes por defecto (tenant_has_feature cae al
-- fallback is_basic cuando el plan no la declara). Un plan puede apagarla
-- explícitamente (modules.agenda=false). El nav del POS la gatea con esa key.
--
-- COBRO DESDE EL TURNO: NO se toca create_sale. El POS arranca la venta con el
-- servicio del turno cargado en el carrito (+ permite agregar productos extra) y
-- cobra con el flujo normal; al confirmar, link_appointment_sale() marca el turno
-- como 'realizado' y guarda sale_id (RPC tenant-scoped, owner/manager/cajero).
--
-- FUERA DE ALCANCE (follow-up, NO en este PR): liquidación de comisiones (H39),
-- seña/pago de reserva, propinas, lista de espera avanzada.
-- =============================================================================

-- ── 1) Servicios: campos extra en products ───────────────────────────────────
-- Nullables: sólo los servicios los usan; los productos normales los ignoran.
alter table products add column if not exists service_duration_min int
  check (service_duration_min is null or service_duration_min > 0);
alter table products add column if not exists commission_pct numeric(5,2)
  check (commission_pct is null or (commission_pct >= 0 and commission_pct <= 100));

-- ── 2) Profesionales ──────────────────────────────────────────────────────────
create table if not exists professionals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name           text not null,
  -- Color para la columna del profesional en la agenda (hex). Default ninja-flame.
  color          text not null default '#ff5a2c',
  -- Comisión por defecto del profesional (%); el servicio puede tener la suya.
  commission_pct numeric(5,2) check (commission_pct is null or (commission_pct >= 0 and commission_pct <= 100)),
  -- Enlace opcional a un miembro con login (para "ver sólo mi agenda" · H39).
  user_id        uuid references public.users(id),
  is_active      boolean not null default true,
  sort           int not null default 0,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists professionals_tenant_idx
  on professionals(tenant_id) where deleted_at is null;

create trigger set_updated_at_professionals
  before update on professionals
  for each row execute function set_updated_at();

alter table professionals enable row level security;
create policy professionals_tenant_isolation on professionals
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- ── 3) Turnos / agenda ────────────────────────────────────────────────────────
create table if not exists appointments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  professional_id    uuid references professionals(id) on delete set null,
  customer_id        uuid references customers(id),
  -- Servicio reservado (producto). on delete set null: si se borra el producto,
  -- el turno conserva el snapshot (nombre/precio/duración/comisión).
  service_product_id uuid references products(id) on delete set null,
  -- Snapshot del servicio al agendar (estable aunque el producto cambie/borre).
  service_name       text not null,
  service_price      numeric(12,2) not null default 0 check (service_price >= 0),
  commission_pct     numeric(5,2),
  -- Bloque del turno.
  starts_at          timestamptz not null,
  duration_min       int not null default 30 check (duration_min > 0),
  status             text not null default 'reservado'
                       check (status in ('reservado','confirmado','en_curso','realizado','cancelado','no_show')),
  notes              text,
  -- Walk-in (sin reserva previa, atención inmediata). Para reportes/filtros.
  is_walk_in         boolean not null default false,
  -- Venta enlazada cuando se cobra el turno (H38 · cobro desde el turno).
  sale_id            uuid references sales(id) on delete set null,
  -- Motivo de cancelación (cuando status='cancelado').
  cancel_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) default auth.uid()
);
-- Lecturas típicas de la agenda: por tenant + rango de fecha, y por profesional.
create index if not exists appointments_tenant_start_idx
  on appointments(tenant_id, starts_at);
create index if not exists appointments_professional_idx
  on appointments(professional_id, starts_at);
create index if not exists appointments_customer_idx on appointments(customer_id);
create index if not exists appointments_sale_idx on appointments(sale_id);

create trigger set_updated_at_appointments
  before update on appointments
  for each row execute function set_updated_at();

alter table appointments enable row level security;
create policy appointments_tenant_isolation on appointments
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- Auditoría de turnos (alta/cambios de estado/borrado). Mismo trigger genérico.
create trigger audit_appointments
  after insert or update or delete on appointments
  for each row execute function write_audit_log();

-- ── 4) Gating: feature 'agenda' en el catálogo (básica → visible por defecto) ─
insert into features (key, label, description, grupo, is_basic, sort) values
  ('agenda', 'Agenda y turnos', 'Agenda de turnos y servicios por profesional', 'ventas', true, 35)
on conflict (key) do nothing;

-- ── 5) link_appointment_sale: enlaza el turno con la venta y lo marca realizado ─
-- El POS cobra el turno con el flujo normal (create_sale, intacto) y, al obtener
-- el sale_id, llama a esta RPC para cerrar el turno. tenant-scoped + guard de
-- miembro activo (un cajero puede cobrar). Idempotente: si el turno ya tiene una
-- venta, no la pisa (devuelve el estado actual).
create or replace function link_appointment_sale(p_appointment_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_appt   appointments%rowtype;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  -- Cualquier miembro activo del tenant (incl. cajero) puede cerrar el cobro.
  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'forbidden';
  end if;

  select * into v_appt from appointments
   where id = p_appointment_id and tenant_id = v_tenant;
  if not found then
    raise exception 'appointment_not_found';
  end if;

  -- La venta debe ser del tenant (RLS ya acota; chequeo defensivo).
  if not exists (select 1 from sales where id = p_sale_id and tenant_id = v_tenant) then
    raise exception 'sale_not_found';
  end if;

  -- Idempotencia: si ya estaba enlazado a otra venta, no la pisa.
  if v_appt.sale_id is not null and v_appt.sale_id <> p_sale_id then
    return jsonb_build_object('appointment_id', v_appt.id, 'sale_id', v_appt.sale_id,
                              'status', v_appt.status, 'already_linked', true);
  end if;

  update appointments
     set sale_id = p_sale_id,
         status  = 'realizado',
         updated_at = now()
   where id = p_appointment_id and tenant_id = v_tenant;

  return jsonb_build_object('appointment_id', p_appointment_id, 'sale_id', p_sale_id,
                            'status', 'realizado', 'already_linked', false);
end;
$$;
revoke all on function link_appointment_sale(uuid, uuid) from public, anon;
grant execute on function link_appointment_sale(uuid, uuid) to authenticated;
