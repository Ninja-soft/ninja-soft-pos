-- =============================================================================
-- 20261106100200_agenda_lista_espera  (ADR-082 · F12 · H38)
--
-- Lista de espera de la agenda: clientes que esperan un hueco. Recepción los
-- anota (cliente de la base o nombre y teléfono sueltos, servicio, profesional
-- preferido, fecha y franja) y, cuando aparece el lugar, los pasa a turno.
--
--  * agenda_waitlist. Estados: esperando, agendado, cancelado.
--    Lectura: el negocio (o el staff interno con internal_scope, ADR-052).
--    Escritura por PostgREST: dueño, encargado y cajero (recepción), con la
--    feature `lista_espera`. Solo lectura (viewer) no escribe. Sin DELETE: se
--    cancela. El paso a 'agendado' y el appointment_id sólo los pone la RPC
--    (trigger lista_espera_guard).
--  * agenda_waitlist_schedule(entry, starts_at, professional, resource,
--    duration): crea el turno con el snapshot del servicio (precio, duración y
--    comisión del producto), lo enlaza y marca la entrada 'agendado', todo en
--    una transacción. El guard de recursos (20261106100100) aplica igual.
--    Audita en audit_logs ('waitlist_scheduled').
-- =============================================================================

create table if not exists agenda_waitlist (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  customer_id        uuid references customers(id),
  customer_name      text check (customer_name is null or char_length(customer_name) <= 120),
  phone              text check (phone is null or char_length(phone) <= 40),
  service_product_id uuid references products(id) on delete set null,
  service_name       text check (service_name is null or char_length(service_name) <= 120),
  professional_id    uuid references professionals(id) on delete set null,
  preferred_date     date,
  preferred_slot     text not null default 'cualquiera'
                       check (preferred_slot in ('cualquiera', 'manana', 'tarde', 'noche')),
  notes              text check (notes is null or char_length(notes) <= 300),
  status             text not null default 'esperando'
                       check (status in ('esperando', 'agendado', 'cancelado')),
  appointment_id     uuid references appointments(id) on delete set null,
  resolved_at        timestamptz,
  created_by         uuid references public.users(id) default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint agenda_waitlist_who check (customer_id is not null or nullif(btrim(customer_name), '') is not null)
);
create index if not exists agenda_waitlist_open_idx
  on agenda_waitlist (tenant_id, created_at) where status = 'esperando';

drop trigger if exists set_updated_at_agenda_waitlist on agenda_waitlist;
create trigger set_updated_at_agenda_waitlist
  before update on agenda_waitlist
  for each row execute function set_updated_at();

alter table agenda_waitlist enable row level security;

drop policy if exists agenda_waitlist_select on agenda_waitlist;
create policy agenda_waitlist_select on agenda_waitlist
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists agenda_waitlist_insert on agenda_waitlist;
create policy agenda_waitlist_insert on agenda_waitlist
  for insert with check (
    tenant_id = (select current_tenant_id())
    and (select agenda_my_role()) in ('owner', 'manager', 'cashier')
    and tenant_has_feature_for((select current_tenant_id()), 'lista_espera')
  );

drop policy if exists agenda_waitlist_update on agenda_waitlist;
create policy agenda_waitlist_update on agenda_waitlist
  for update using (
    tenant_id = (select current_tenant_id())
    and (select agenda_my_role()) in ('owner', 'manager', 'cashier')
    and tenant_has_feature_for((select current_tenant_id()), 'lista_espera')
  )
  with check (
    tenant_id = (select current_tenant_id())
    and (select agenda_my_role()) in ('owner', 'manager', 'cashier')
    and tenant_has_feature_for((select current_tenant_id()), 'lista_espera')
  );

-- Por PostgREST: alta siempre 'esperando'; no se agenda a mano ni se reabre
-- una entrada resuelta; referencias del mismo negocio.
-- SECURITY INVOKER a propósito: current_user es 'authenticated' por REST y el
-- dueño de la función dentro de la RPC SECURITY DEFINER.
create or replace function trg_agenda_waitlist_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if v_client then
    if tg_op = 'INSERT' then
      if new.status <> 'esperando' or new.appointment_id is not null then
        raise exception 'use_waitlist_schedule';
      end if;
    else
      if new.appointment_id is distinct from old.appointment_id
         or (new.status = 'agendado' and old.status <> 'agendado') then
        raise exception 'use_waitlist_schedule';
      end if;
      if old.status <> 'esperando' and new.status is distinct from old.status then
        raise exception 'waitlist_entry_closed';
      end if;
    end if;
  end if;

  if new.status = 'cancelado' and (tg_op = 'INSERT' or old.status <> 'cancelado') then
    new.resolved_at := now();
  end if;

  if new.customer_id is not null and not exists (
    select 1 from customers c where c.id = new.customer_id and c.tenant_id = new.tenant_id
  ) then
    raise exception 'customer_not_found';
  end if;
  if new.professional_id is not null and not exists (
    select 1 from professionals p where p.id = new.professional_id and p.tenant_id = new.tenant_id
  ) then
    raise exception 'professional_not_found';
  end if;
  if new.service_product_id is not null and not exists (
    select 1 from products p where p.id = new.service_product_id and p.tenant_id = new.tenant_id
  ) then
    raise exception 'product_not_found';
  end if;
  return new;
end;
$$;
revoke all on function trg_agenda_waitlist_guard() from public, anon;

drop trigger if exists agenda_waitlist_guard on agenda_waitlist;
create trigger agenda_waitlist_guard
  before insert or update on agenda_waitlist
  for each row execute function trg_agenda_waitlist_guard();

drop trigger if exists audit_agenda_waitlist on agenda_waitlist;
create trigger audit_agenda_waitlist
  after insert or update or delete on agenda_waitlist
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- RPC: pasar una entrada de la lista de espera a turno.
-- -----------------------------------------------------------------------------
create or replace function agenda_waitlist_schedule(
  p_entry_id        uuid,
  p_starts_at       timestamptz,
  p_professional_id uuid default null,
  p_resource_id     uuid default null,
  p_duration_min    int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_role    text;
  v_entry   agenda_waitlist%rowtype;
  v_prod    products%rowtype;
  v_prof    professionals%rowtype;
  v_name    text;
  v_price   numeric(12,2) := 0;
  v_dur     int;
  v_pct     numeric(5,2);
  v_notes   text;
  v_appt    uuid;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  v_role := agenda_my_role();
  if v_role is null or v_role not in ('owner', 'manager', 'cashier') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'lista_espera') then
    raise exception 'feature_not_in_plan: lista_espera' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'agenda') then
    raise exception 'feature_not_in_plan: agenda' using errcode = '42501';
  end if;
  if p_starts_at is null then
    raise exception 'starts_at_required';
  end if;
  if p_duration_min is not null and p_duration_min <= 0 then
    raise exception 'invalid_duration';
  end if;

  select * into v_entry from agenda_waitlist
   where id = p_entry_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'waitlist_entry_not_found';
  end if;
  if v_entry.status <> 'esperando' then
    raise exception 'waitlist_entry_closed';
  end if;

  -- Profesional: el elegido ahora o el preferido de la entrada.
  if coalesce(p_professional_id, v_entry.professional_id) is not null then
    select * into v_prof from professionals
     where id = coalesce(p_professional_id, v_entry.professional_id)
       and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'professional_not_found';
    end if;
  end if;

  -- Snapshot del servicio (mismo criterio que el alta de turno en la agenda).
  v_name := nullif(btrim(coalesce(v_entry.service_name, '')), '');
  if v_entry.service_product_id is not null then
    select * into v_prod from products
     where id = v_entry.service_product_id and tenant_id = v_tenant;
    if found then
      v_name := coalesce(v_name, v_prod.name);
      v_price := coalesce(v_prod.price, 0);
      v_dur := v_prod.service_duration_min;
      v_pct := v_prod.commission_pct;
    end if;
  end if;
  v_name := coalesce(v_name, 'Turno');
  v_dur := coalesce(p_duration_min, v_dur, 30);
  v_pct := coalesce(v_pct, v_prof.commission_pct);

  v_notes := nullif(concat_ws(' · ',
    case when v_entry.customer_id is null then nullif(btrim(coalesce(v_entry.customer_name, '')), '') end,
    case when v_entry.customer_id is null then nullif(btrim(coalesce(v_entry.phone, '')), '') end,
    nullif(btrim(coalesce(v_entry.notes, '')), '')
  ), '');

  insert into appointments (
    tenant_id, professional_id, customer_id, service_product_id, service_name,
    service_price, commission_pct, starts_at, duration_min, status, notes,
    resource_id, created_by
  ) values (
    v_tenant, v_prof.id, v_entry.customer_id, v_entry.service_product_id, v_name,
    v_price, v_pct, p_starts_at, v_dur, 'reservado', v_notes,
    p_resource_id, auth.uid()
  )
  returning id into v_appt;

  update agenda_waitlist
     set status = 'agendado', appointment_id = v_appt, resolved_at = now()
   where id = v_entry.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'agenda_waitlist', v_entry.id, 'waitlist_scheduled',
          jsonb_build_object('appointment_id', v_appt, 'starts_at', p_starts_at,
                             'professional_id', v_prof.id, 'resource_id', p_resource_id));

  return jsonb_build_object('entry_id', v_entry.id, 'appointment_id', v_appt, 'status', 'agendado');
end;
$$;
revoke all on function agenda_waitlist_schedule(uuid, timestamptz, uuid, uuid, int) from public, anon;
grant execute on function agenda_waitlist_schedule(uuid, timestamptz, uuid, uuid, int) to authenticated;
