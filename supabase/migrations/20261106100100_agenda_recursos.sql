-- =============================================================================
-- 20261106100100_agenda_recursos  (ADR-082 · F12 · H38)
--
-- Recursos de la agenda: silla, cabina, box o equipo. Un turno puede ocupar un
-- recurso (appointments.resource_id) además de un profesional. El servidor
-- impide la doble reserva del mismo recurso en turnos activos.
--
--  * agenda_resources: nombre, tipo, color, activo, orden, baja lógica.
--    Lectura: el negocio (o el staff interno con internal_scope, ADR-052).
--    Escritura: dueño o encargado, con la feature `agenda_recursos`. Sin
--    DELETE (baja lógica con deleted_at).
--  * appointments.resource_id: nullable. Trigger BEFORE (SECURITY DEFINER para
--    ver todos los turnos aunque el usuario tenga lectura sólo-propia, H39):
--      - asignar o cambiar el recurso exige la feature `agenda_recursos`;
--      - el recurso tiene que ser del negocio y estar activo;
--      - un turno activo (reservado, confirmado, en curso) no puede pisar a
--        otro turno activo del mismo recurso: 'resource_busy'. Lock por
--        recurso (advisory xact) para que dos altas simultáneas no pasen las
--        dos.
--    Los turnos sin recurso siguen exactamente igual que antes.
--
-- Helper agenda_my_role(): rol del usuario del JWT en el negocio activo.
-- =============================================================================

create or replace function agenda_my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from tenant_users
   where tenant_id = current_tenant_id() and user_id = auth.uid() and status = 'active'
   limit 1;
$$;
revoke all on function agenda_my_role() from public, anon;
grant execute on function agenda_my_role() to authenticated;

-- -----------------------------------------------------------------------------
-- A) Recursos
-- -----------------------------------------------------------------------------
create table if not exists agenda_resources (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  kind        text not null default 'silla' check (kind in ('silla', 'cabina', 'box', 'equipo', 'otro')),
  color       text not null default '#94a3b8' check (color ~ '^#[0-9a-fA-F]{6}$'),
  is_active   boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists agenda_resources_tenant_idx
  on agenda_resources (tenant_id) where deleted_at is null;

drop trigger if exists set_updated_at_agenda_resources on agenda_resources;
create trigger set_updated_at_agenda_resources
  before update on agenda_resources
  for each row execute function set_updated_at();

alter table agenda_resources enable row level security;

drop policy if exists agenda_resources_select on agenda_resources;
create policy agenda_resources_select on agenda_resources
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists agenda_resources_insert on agenda_resources;
create policy agenda_resources_insert on agenda_resources
  for insert with check (
    tenant_id = (select current_tenant_id())
    and (select agenda_my_role()) in ('owner', 'manager')
    and tenant_has_feature_for((select current_tenant_id()), 'agenda_recursos')
  );

drop policy if exists agenda_resources_update on agenda_resources;
create policy agenda_resources_update on agenda_resources
  for update using (
    tenant_id = (select current_tenant_id())
    and (select agenda_my_role()) in ('owner', 'manager')
    and tenant_has_feature_for((select current_tenant_id()), 'agenda_recursos')
  )
  with check (
    tenant_id = (select current_tenant_id())
    and (select agenda_my_role()) in ('owner', 'manager')
    and tenant_has_feature_for((select current_tenant_id()), 'agenda_recursos')
  );
-- Sin DELETE: baja lógica.

drop trigger if exists audit_agenda_resources on agenda_resources;
create trigger audit_agenda_resources
  after insert or update or delete on agenda_resources
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- B) Turno con recurso + guard de doble reserva
-- -----------------------------------------------------------------------------
alter table appointments
  add column if not exists resource_id uuid references agenda_resources(id) on delete set null;
create index if not exists appointments_resource_idx
  on appointments (resource_id, starts_at) where resource_id is not null;

create or replace function trg_appointments_resource_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed boolean;
  v_end     timestamptz;
begin
  if new.resource_id is null then
    return new;
  end if;

  v_changed := tg_op = 'INSERT' or new.resource_id is distinct from old.resource_id;

  if v_changed then
    if not tenant_has_feature_for(new.tenant_id, 'agenda_recursos') then
      raise exception 'feature_not_in_plan: agenda_recursos' using errcode = '42501';
    end if;
    if not exists (
      select 1 from agenda_resources r
       where r.id = new.resource_id and r.tenant_id = new.tenant_id
         and r.deleted_at is null and r.is_active
    ) then
      raise exception 'resource_not_found';
    end if;
  end if;

  if new.status in ('reservado', 'confirmado', 'en_curso') then
    perform pg_advisory_xact_lock(hashtextextended('agenda_resource:' || new.resource_id::text, 0));
    v_end := new.starts_at + make_interval(mins => new.duration_min);
    if exists (
      select 1 from appointments a
       where a.tenant_id = new.tenant_id
         and a.resource_id = new.resource_id
         and a.id <> new.id
         and a.status in ('reservado', 'confirmado', 'en_curso')
         and a.starts_at < v_end
         and new.starts_at < a.starts_at + make_interval(mins => a.duration_min)
    ) then
      raise exception 'resource_busy';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function trg_appointments_resource_guard() from public, anon, authenticated;

drop trigger if exists appointments_resource_guard on appointments;
create trigger appointments_resource_guard
  before insert or update of resource_id, starts_at, duration_min, status on appointments
  for each row execute function trg_appointments_resource_guard();
