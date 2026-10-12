-- =============================================================================
-- 20261013110000_personal_por_sucursal  (F17 · H91 · ADR-045)
--
-- Personal por sucursal con vigencias (traslados programados y coberturas):
--   A) staff_branch_assignments: una fila = "esta persona trabaja en esta
--      sucursal entre valid_from y valid_until (null = sin fin)". Sirve para
--      usuarios con login (user_id) y para perfiles de cajero sin cuenta
--      (cashier_profile_id). Tipos:
--        · home  : sucursal base. Un traslado definitivo corta la base vigente
--                  y abre otra desde una fecha (hoy o futura).
--        · cover : cobertura temporal EXCLUSIVA (fecha desde y hasta). Mientras
--                  dura, la persona sólo opera en esa sucursal.
--        · extra : acceso adicional (suma una sucursal, con o sin fin).
--      role (opcional) pisa el rol del negocio en esa sucursal (nunca owner).
--      Evaluación PEREZOSA: la vigencia se calcula al consultar por fecha (sin
--      cron). Baja lógica (deleted_at) para cancelar; superseded_by y
--      prev_valid_until permiten deshacer un traslado programado.
--   B) Resolución de alcance:
--        · staff_allowed_store_ids(tenant, user, profile, role, fecha)
--        · user_allowed_store_ids() / user_can_access_store(store) /
--          user_store_role(store) para el usuario del JWT.
--      Reglas: dueño, staff interno y negocios con una sola sucursal viva ven
--      todo (incluidas las archivadas, para no perder historia). Con
--      asignaciones vigentes: cobertura exclusiva > base + adicionales. Sin
--      asignaciones vigentes: encargado = todas; cajero o solo lectura = la
--      sucursal principal.
--   C) Policies RESTRICTIVE de lectura por sucursal en cash_shifts,
--      cash_movements, cash_z_closures y sales. Se suman a las de tenant (AND);
--      para el dueño y los negocios de una sucursal no cambian nada.
--   D) RPC staff_branch_schedule / staff_branch_cancel (owner/manager, gateado
--      por multi_sucursal, auditado). Sin policies de escritura: sólo RPC.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tabla
-- -----------------------------------------------------------------------------
create table if not exists staff_branch_assignments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id           uuid not null references stores(id),
  user_id            uuid references public.users(id) on delete cascade,
  cashier_profile_id uuid references cashier_profiles(id) on delete cascade,
  kind               text not null check (kind in ('home', 'cover', 'extra')),
  role               text check (role is null or role in ('manager', 'cashier', 'viewer')),
  valid_from         date not null,
  valid_until        date,
  reason             text,
  transfer_id        uuid not null default gen_random_uuid(),
  superseded_by      uuid,
  prev_valid_until   date,
  created_by         uuid default auth.uid() references public.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  cancel_reason      text,
  cancelled_by       uuid references public.users(id),
  constraint staff_branch_person_chk check ((user_id is null) <> (cashier_profile_id is null)),
  constraint staff_branch_dates_chk check (valid_until is null or valid_until >= valid_from),
  constraint staff_branch_cover_until_chk check (kind <> 'cover' or valid_until is not null)
);

create index if not exists staff_branch_user_idx
  on staff_branch_assignments (tenant_id, user_id) where deleted_at is null;
create index if not exists staff_branch_profile_idx
  on staff_branch_assignments (tenant_id, cashier_profile_id) where deleted_at is null;
create index if not exists staff_branch_store_idx
  on staff_branch_assignments (store_id) where deleted_at is null;

drop trigger if exists set_updated_at_staff_branch on staff_branch_assignments;
create trigger set_updated_at_staff_branch
  before update on staff_branch_assignments
  for each row execute function set_updated_at();

alter table staff_branch_assignments enable row level security;
drop policy if exists staff_branch_select on staff_branch_assignments;
create policy staff_branch_select on staff_branch_assignments
  for select using (tenant_id = current_tenant_id() or is_internal());
-- Sin policies de escritura: todo pasa por staff_branch_schedule/cancel.

-- -----------------------------------------------------------------------------
-- B) Resolución de alcance
-- -----------------------------------------------------------------------------
-- "Hoy" operativo del negocio (misma zona que la cuenta corriente).
create or replace function branch_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (now() at time zone 'America/Argentina/Buenos_Aires')::date;
$$;
grant execute on function branch_today() to authenticated, service_role;

create or replace function staff_allowed_store_ids(
  p_tenant  uuid,
  p_user    uuid,
  p_profile uuid,
  p_role    text,
  p_on      date default null
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_on     date := coalesce(p_on, branch_today());
  v_live   int;
  v_cover  uuid[];
  v_active uuid[];
begin
  select count(*) into v_live from stores where tenant_id = p_tenant and deleted_at is null;

  -- Alcance total: dueño o negocio con una sola sucursal viva.
  if p_role = 'owner' or v_live <= 1 then
    return coalesce((select array_agg(id order by created_at) from stores where tenant_id = p_tenant), '{}');
  end if;

  select array_agg(distinct a.store_id) filter (where a.kind = 'cover'),
         array_agg(distinct a.store_id)
    into v_cover, v_active
    from staff_branch_assignments a
    join stores s on s.id = a.store_id and s.deleted_at is null
   where a.tenant_id = p_tenant
     and a.deleted_at is null
     and ((p_user is not null and a.user_id = p_user)
          or (p_profile is not null and a.cashier_profile_id = p_profile))
     and a.valid_from <= v_on
     and (a.valid_until is null or a.valid_until >= v_on);

  if v_cover is not null and cardinality(v_cover) > 0 then
    return v_cover;
  end if;
  if v_active is not null and cardinality(v_active) > 0 then
    return v_active;
  end if;

  -- Sin asignaciones vigentes.
  if p_role = 'manager' then
    return coalesce((select array_agg(id order by created_at) from stores where tenant_id = p_tenant), '{}');
  end if;
  return coalesce((select array_agg(id) from stores
                    where tenant_id = p_tenant and deleted_at is null and is_default), '{}');
end;
$$;
revoke all on function staff_allowed_store_ids(uuid, uuid, uuid, text, date) from public, anon, authenticated;
grant execute on function staff_allowed_store_ids(uuid, uuid, uuid, text, date) to service_role;

-- Sucursales que el usuario del JWT puede ver y operar hoy.
create or replace function user_allowed_store_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
begin
  if v_tenant is null then return '{}'; end if;
  if is_internal() then
    return coalesce((select array_agg(id) from stores where tenant_id = v_tenant), '{}');
  end if;
  select role into v_role from tenant_users
   where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
   limit 1;
  if v_role is null then return '{}'; end if;
  return staff_allowed_store_ids(v_tenant, auth.uid(), null, v_role, null);
end;
$$;
revoke all on function user_allowed_store_ids() from public, anon;
grant execute on function user_allowed_store_ids() to authenticated;

create or replace function user_can_access_store(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_store_id = any (user_allowed_store_ids());
$$;
revoke all on function user_can_access_store(uuid) from public, anon;
grant execute on function user_can_access_store(uuid) to authenticated;

-- Rol efectivo del usuario del JWT en una sucursal: el del negocio salvo que
-- una asignación vigente con rol lo pise (cobertura > base > adicional). El
-- dueño siempre es dueño.
create or replace function user_store_role(p_store_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
  v_over   text;
begin
  select role into v_role from tenant_users
   where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
   limit 1;
  if v_role is null or v_role = 'owner' then return v_role; end if;
  select a.role into v_over
    from staff_branch_assignments a
   where a.tenant_id = v_tenant and a.user_id = auth.uid() and a.store_id = p_store_id
     and a.deleted_at is null and a.role is not null
     and a.valid_from <= branch_today()
     and (a.valid_until is null or a.valid_until >= branch_today())
   order by case a.kind when 'cover' then 0 when 'home' then 1 else 2 end, a.valid_from desc
   limit 1;
  return coalesce(v_over, v_role);
end;
$$;
revoke all on function user_store_role(uuid) from public, anon;
grant execute on function user_store_role(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Lectura por sucursal (policies RESTRICTIVE: se combinan con AND)
-- -----------------------------------------------------------------------------
drop policy if exists cash_shifts_branch_scope on cash_shifts;
create policy cash_shifts_branch_scope on cash_shifts
  as restrictive for select
  using (is_internal() or store_id = any ((select user_allowed_store_ids())));

drop policy if exists cash_movements_branch_scope on cash_movements;
create policy cash_movements_branch_scope on cash_movements
  as restrictive for select
  using (
    is_internal() or exists (
      select 1 from cash_shifts cs
       where cs.id = cash_movements.cash_shift_id
         and cs.store_id = any ((select user_allowed_store_ids()))
    )
  );

drop policy if exists czc_branch_scope on cash_z_closures;
create policy czc_branch_scope on cash_z_closures
  as restrictive for select
  using (is_internal() or store_id = any ((select user_allowed_store_ids())));

drop policy if exists sales_branch_scope on sales;
create policy sales_branch_scope on sales
  as restrictive for select
  using (is_internal() or store_id = any ((select user_allowed_store_ids())));

create index if not exists sales_tenant_store_created_idx on sales (tenant_id, store_id, created_at desc);

-- -----------------------------------------------------------------------------
-- D) RPC: programar y cancelar asignaciones / traslados
-- -----------------------------------------------------------------------------
create or replace function staff_branch_schedule(
  p_store_id           uuid,
  p_kind               text,
  p_user_id            uuid default null,
  p_cashier_profile_id uuid default null,
  p_from               date default null,
  p_until              date default null,
  p_role               text default null,
  p_reason             text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_today    date := branch_today();
  v_from     date := coalesce(p_from, branch_today());
  v_until    date := p_until;
  v_kind     text := lower(btrim(coalesce(p_kind, '')));
  v_role     text := nullif(lower(btrim(coalesce(p_role, ''))), '');
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_store    record;
  v_member   text;
  v_transfer uuid := gen_random_uuid();
  v_id       uuid;
  v_r        record;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
    raise exception 'feature_not_in_plan: multi_sucursal' using errcode = 'check_violation';
  end if;
  if v_kind not in ('home', 'cover', 'extra') then raise exception 'invalid_kind'; end if;
  if v_role is not null and v_role not in ('manager', 'cashier', 'viewer') then
    raise exception 'invalid_role';
  end if;
  if (p_user_id is null) = (p_cashier_profile_id is null) then raise exception 'invalid_person'; end if;
  if v_from < v_today then raise exception 'date_in_past'; end if;
  if v_kind = 'home' then v_until := null; end if;
  if v_kind = 'cover' and v_until is null then raise exception 'cover_needs_until'; end if;
  if v_until is not null and v_until < v_from then raise exception 'invalid_dates'; end if;

  select * into v_store from stores where id = p_store_id and tenant_id = v_tenant;
  if not found or v_store.deleted_at is not null then raise exception 'store_not_found'; end if;
  if not user_can_access_store(p_store_id) then raise exception 'store_not_allowed'; end if;

  -- La persona tiene que ser del negocio. El dueño ve todas: no se asigna.
  if p_user_id is not null then
    select role into v_member from tenant_users
     where tenant_id = v_tenant and user_id = p_user_id;
    if v_member is null then raise exception 'member_not_found'; end if;
    if v_member = 'owner' then raise exception 'owner_all_branches'; end if;
  else
    if not exists (select 1 from cashier_profiles
                    where id = p_cashier_profile_id and tenant_id = v_tenant and deleted_at is null) then
      raise exception 'member_not_found';
    end if;
  end if;

  if v_kind = 'home' then
    -- Ya es su base en esa fecha: nada que trasladar.
    if exists (select 1 from staff_branch_assignments a
                where a.tenant_id = v_tenant and a.deleted_at is null and a.kind = 'home'
                  and a.store_id = p_store_id
                  and a.user_id is not distinct from p_user_id
                  and a.cashier_profile_id is not distinct from p_cashier_profile_id
                  and a.valid_from <= v_from
                  and (a.valid_until is null or a.valid_until >= v_from)) then
      raise exception 'already_home';
    end if;
    -- Corta la base vigente en esa fecha y reemplaza las bases futuras.
    for v_r in
      select * from staff_branch_assignments a
       where a.tenant_id = v_tenant and a.deleted_at is null and a.kind = 'home'
         and a.user_id is not distinct from p_user_id
         and a.cashier_profile_id is not distinct from p_cashier_profile_id
         and (a.valid_until is null or a.valid_until >= v_from)
       for update
    loop
      if v_r.valid_from < v_from then
        update staff_branch_assignments
           set prev_valid_until = v_r.valid_until,
               valid_until = v_from - 1,
               superseded_by = v_transfer
         where id = v_r.id;
      else
        update staff_branch_assignments
           set deleted_at = now(),
               superseded_by = v_transfer,
               cancelled_by = auth.uid(),
               cancel_reason = 'Reemplazada por otro traslado'
         where id = v_r.id;
      end if;
    end loop;
  elsif v_kind = 'cover' then
    if exists (select 1 from staff_branch_assignments a
                where a.tenant_id = v_tenant and a.deleted_at is null and a.kind = 'cover'
                  and a.user_id is not distinct from p_user_id
                  and a.cashier_profile_id is not distinct from p_cashier_profile_id
                  and a.valid_from <= v_until
                  and (a.valid_until is null or a.valid_until >= v_from)) then
      raise exception 'cover_overlap';
    end if;
  else
    if exists (select 1 from staff_branch_assignments a
                where a.tenant_id = v_tenant and a.deleted_at is null and a.kind = 'extra'
                  and a.store_id = p_store_id
                  and a.user_id is not distinct from p_user_id
                  and a.cashier_profile_id is not distinct from p_cashier_profile_id
                  and (v_until is null or a.valid_from <= v_until)
                  and (a.valid_until is null or a.valid_until >= v_from)) then
      raise exception 'already_assigned';
    end if;
  end if;

  insert into staff_branch_assignments
    (tenant_id, store_id, user_id, cashier_profile_id, kind, role,
     valid_from, valid_until, reason, transfer_id)
  values
    (v_tenant, p_store_id, p_user_id, p_cashier_profile_id, v_kind, v_role,
     v_from, v_until, v_reason, v_transfer)
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'staff_branch_assignments', v_id, 'staff_branch_scheduled',
          jsonb_build_object('store_id', p_store_id, 'store_name', v_store.name,
                             'kind', v_kind, 'role', v_role,
                             'user_id', p_user_id, 'cashier_profile_id', p_cashier_profile_id,
                             'valid_from', v_from, 'valid_until', v_until,
                             'reason', v_reason, 'transfer_id', v_transfer));
  return v_id;
end;
$$;
revoke all on function staff_branch_schedule(uuid, text, uuid, uuid, date, date, text, text) from public, anon;
grant execute on function staff_branch_schedule(uuid, text, uuid, uuid, date, date, text, text) to authenticated;

-- Cancela una asignación programada (todavía no empezó: se da de baja y se
-- deshace lo que su traslado cortó) o finaliza una vigente (queda hasta ayer).
create or replace function staff_branch_cancel(p_assignment_id uuid, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_today  date := branch_today();
  v_a      record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_result text;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;

  select * into v_a from staff_branch_assignments
   where id = p_assignment_id and tenant_id = v_tenant
   for update;
  if not found or v_a.deleted_at is not null then raise exception 'assignment_not_found'; end if;
  if v_a.valid_until is not null and v_a.valid_until < v_today then
    raise exception 'assignment_already_ended';
  end if;

  if v_a.valid_from >= v_today then
    -- Programada (o empieza hoy): se cancela y se restaura lo que reemplazó.
    update staff_branch_assignments
       set deleted_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason
     where id = v_a.id;
    update staff_branch_assignments
       set deleted_at = null, superseded_by = null, cancelled_by = null, cancel_reason = null
     where tenant_id = v_tenant and superseded_by = v_a.transfer_id and deleted_at is not null;
    update staff_branch_assignments
       set valid_until = prev_valid_until, prev_valid_until = null, superseded_by = null
     where tenant_id = v_tenant and superseded_by = v_a.transfer_id and deleted_at is null;
    v_result := 'cancelled';
  else
    -- Vigente: termina ayer (desde hoy deja de aplicar).
    update staff_branch_assignments
       set valid_until = v_today - 1, cancelled_by = auth.uid(), cancel_reason = v_reason
     where id = v_a.id;
    v_result := 'ended';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'staff_branch_assignments', v_a.id,
          case v_result when 'cancelled' then 'staff_branch_cancelled' else 'staff_branch_ended' end,
          to_jsonb(v_a), jsonb_build_object('result', v_result, 'reason', v_reason));
  return v_result;
end;
$$;
revoke all on function staff_branch_cancel(uuid, text) from public, anon;
grant execute on function staff_branch_cancel(uuid, text) to authenticated;
