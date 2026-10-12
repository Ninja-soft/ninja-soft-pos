-- =============================================================================
-- 20261013100000_sucursales_cajas  (F17 · H89 · ADR-045)
--
-- Sucursales y cajas como entidades administrables:
--   A) Columnas nuevas en stores (código, nombre corto, color, dirección
--      estructurada, zona horaria, punto de venta fiscal, horario, orden) y en
--      cash_registers (código, tipo, notas de dispositivo e impresora, PV propio,
--      baja lógica).
--   B) Features de plan: multi_sucursal deja de ser MARKETING-FUTURO (tiene
--      función y gating real); nueva multi_caja (OPTIONAL, Pro+). Límite nuevo
--      max_registers_per_store en plans.limits.limits.
--   C) tenant_limit_for(tenant, key): igual a tenant_limit() pero para un
--      tenant explícito (lo usan los triggers, que no siempre corren con JWT).
--      gating_summary suma max_registers_per_store.
--   D) Triggers de reglas: límite y feature por plan al crear o restaurar una
--      sucursal o caja; no se archiva la sucursal default, la última sucursal ni
--      una caja con turno abierto. La UI no es la única barrera.
--   E) cash_shifts.store_id desnormalizado (derivado de la caja por trigger):
--      base de las policies por sucursal (H91) y del fix de create_sale (H90).
--   F) RLS: lectura para miembros del tenant; escritura sólo owner/manager.
--      Sin DELETE físico (baja lógica con deleted_at).
--   G) Auditoría: write_audit_log en stores y cash_registers.
--   H) set_default_store(): cambia la sucursal principal de forma atómica.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Columnas
-- -----------------------------------------------------------------------------
alter table stores
  add column if not exists code            text,
  add column if not exists short_name      text,
  add column if not exists color           text,
  add column if not exists email           text,
  add column if not exists city            text,
  add column if not exists province        text,
  add column if not exists postal_code     text,
  add column if not exists timezone        text not null default 'America/Argentina/Buenos_Aires',
  add column if not exists afip_pos_number int,
  add column if not exists opening_hours   jsonb not null default '{}'::jsonb,
  add column if not exists notes           text,
  add column if not exists sort            int not null default 0,
  add column if not exists archived_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_afip_pos_number_chk') then
    alter table stores add constraint stores_afip_pos_number_chk
      check (afip_pos_number is null or afip_pos_number between 1 and 99998);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stores_opening_hours_chk') then
    alter table stores add constraint stores_opening_hours_chk
      check (jsonb_typeof(opening_hours) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stores_color_chk') then
    alter table stores add constraint stores_color_chk
      check (color is null or color ~ '^#[0-9a-fA-F]{6}$');
  end if;
end $$;

alter table cash_registers
  add column if not exists code            text,
  add column if not exists kind            text not null default 'fixed',
  add column if not exists device_notes    text,
  add column if not exists printer_notes   text,
  add column if not exists afip_pos_number int,
  add column if not exists sort            int not null default 0,
  add column if not exists deleted_at      timestamptz,
  add column if not exists archived_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cash_registers_kind_chk') then
    alter table cash_registers add constraint cash_registers_kind_chk
      check (kind in ('fixed', 'mobile', 'self_service'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cash_registers_afip_pos_number_chk') then
    alter table cash_registers add constraint cash_registers_afip_pos_number_chk
      check (afip_pos_number is null or afip_pos_number between 1 and 99998);
  end if;
end $$;

-- Una sola sucursal principal viva por negocio. Antes de crear el índice se
-- normalizan datos viejos (si hubiera dos defaults queda la más antigua).
update stores s
   set is_default = false
 where s.is_default
   and s.deleted_at is null
   and exists (
     select 1 from stores o
      where o.tenant_id = s.tenant_id and o.is_default and o.deleted_at is null
        and (o.created_at, o.id) < (s.created_at, s.id)
   );

create unique index if not exists stores_one_default_uidx
  on stores (tenant_id) where is_default and deleted_at is null;
create unique index if not exists stores_tenant_code_uidx
  on stores (tenant_id, lower(code)) where deleted_at is null and code is not null;
create unique index if not exists cash_registers_store_code_uidx
  on cash_registers (store_id, lower(code)) where deleted_at is null and code is not null;
create index if not exists cash_registers_store_idx
  on cash_registers (store_id) where deleted_at is null;

-- -----------------------------------------------------------------------------
-- B) Features de plan
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('multi_caja', 'Multi-caja', 'Varias cajas en una misma sucursal (desde la segunda caja)', 'ventas', false, 25)
on conflict (key) do nothing;

update features
   set description = 'Varias sucursales con cajas, personal, turnos y ventas por local (desde la segunda sucursal)'
 where key = 'multi_sucursal';

-- multi_caja: Pro, Business y Enterprise. Planes a medida: lo heredan de
-- multi_sucursal (quien tiene varias sucursales necesita varias cajas).
update plans p
   set limits = jsonb_set(
     coalesce(p.limits, '{}'::jsonb),
     '{modules}',
     coalesce(p.limits -> 'modules', '{}'::jsonb)
       || jsonb_build_object(
            'multi_caja',
            p.key in ('pro', 'business', 'enterprise')
              or coalesce((p.limits -> 'modules' ->> 'multi_sucursal')::boolean, false)
          )
   )
 where not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'multi_caja');

-- Cajas por sucursal (plans.limits.limits.max_registers_per_store). Enterprise
-- sin la key = ilimitado (misma convención que max_stores).
update plans p
   set limits = jsonb_set(
     coalesce(p.limits, '{}'::jsonb),
     '{limits}',
     coalesce(p.limits -> 'limits', '{}'::jsonb)
       || jsonb_build_object('max_registers_per_store',
            case p.key when 'start' then 1 when 'pro' then 3 when 'business' then 10 end)
   )
 where p.tenant_id is null
   and p.key in ('start', 'pro', 'business')
   and not (coalesce(p.limits -> 'limits', '{}'::jsonb) ? 'max_registers_per_store');

-- -----------------------------------------------------------------------------
-- C) Límite por tenant explícito + gating_summary
-- -----------------------------------------------------------------------------
create or replace function tenant_limit_for(p_tenant uuid, p_key text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select (s.limit_overrides ->> p_key)::numeric
       from subscriptions s where s.tenant_id = p_tenant limit 1),
    (select (p.limits -> 'limits' ->> p_key)::numeric
       from subscriptions s join plans p on p.id = s.plan_id
      where s.tenant_id = p_tenant limit 1)
  );
$$;
revoke all on function tenant_limit_for(uuid, text) from public, anon;
grant execute on function tenant_limit_for(uuid, text) to authenticated, service_role;

create or replace function gating_summary()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'features', (select coalesce(jsonb_object_agg(f.key, tenant_has_feature(f.key)), '{}'::jsonb) from features f),
    'limits', jsonb_build_object(
      'max_stores', tenant_limit('max_stores'),
      'max_registers_per_store', tenant_limit('max_registers_per_store'),
      'max_users', tenant_limit('max_users'),
      'max_products', tenant_limit('max_products'),
      'max_sales_per_month', tenant_limit('max_sales_per_month')
    ),
    'plan', (select jsonb_build_object('key', p.key, 'name', p.name)
               from subscriptions s join plans p on p.id = s.plan_id
              where s.tenant_id = current_tenant_id() limit 1)
  );
$$;
revoke all on function gating_summary() from public, anon;
grant execute on function gating_summary() to authenticated;

-- -----------------------------------------------------------------------------
-- D) Reglas de sucursales y cajas (BEFORE INSERT/UPDATE)
-- -----------------------------------------------------------------------------
create or replace function enforce_store_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count  int;
  v_limit  numeric;
begin
  -- Normalización de textos (código en mayúsculas, vacíos a null).
  new.code := nullif(upper(btrim(coalesce(new.code, ''))), '');
  new.short_name := nullif(btrim(coalesce(new.short_name, '')), '');
  new.name := btrim(new.name);
  if new.name = '' then raise exception 'store_name_required' using errcode = 'check_violation'; end if;

  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    raise exception 'store_tenant_immutable' using errcode = 'check_violation';
  end if;

  -- Alta o restauración: feature y límite del plan.
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    perform pg_advisory_xact_lock(hashtext('stores_limit:' || new.tenant_id::text));
    select count(*) into v_count
      from stores
     where tenant_id = new.tenant_id and deleted_at is null and id <> new.id;
    if v_count >= 1 and not tenant_has_feature_for(new.tenant_id, 'multi_sucursal') then
      raise exception 'feature_not_in_plan: multi_sucursal' using errcode = 'check_violation';
    end if;
    v_limit := tenant_limit_for(new.tenant_id, 'max_stores');
    if v_limit is not null and v_count + 1 > v_limit then
      raise exception 'plan_limit: max_stores' using errcode = 'check_violation';
    end if;
    -- La primera sucursal viva del negocio es la principal.
    if v_count = 0 then new.is_default := true; end if;
  end if;

  if tg_op = 'UPDATE' then
    -- Archivar (baja lógica).
    if old.deleted_at is null and new.deleted_at is not null then
      if old.is_default then
        raise exception 'store_is_default' using errcode = 'check_violation';
      end if;
      if exists (select 1 from cash_shifts cs
                  where cs.store_id = new.id and cs.status = 'open') then
        raise exception 'store_has_open_shift' using errcode = 'check_violation';
      end if;
      new.is_active := false;
      new.is_default := false;
    end if;
    -- Pausar: no puede quedar el negocio sin ninguna sucursal activa ni con un
    -- turno abierto en la sucursal pausada.
    if old.is_active and not new.is_active and new.deleted_at is null then
      if not exists (select 1 from stores o
                      where o.tenant_id = new.tenant_id and o.id <> new.id
                        and o.deleted_at is null and o.is_active) then
        raise exception 'last_active_store' using errcode = 'check_violation';
      end if;
      if exists (select 1 from cash_shifts cs
                  where cs.store_id = new.id and cs.status = 'open') then
        raise exception 'store_has_open_shift' using errcode = 'check_violation';
      end if;
    end if;
    -- Restaurar: vuelve activa.
    if old.deleted_at is not null and new.deleted_at is null then
      new.is_active := true;
      new.archived_reason := null;
    end if;
  end if;

  return new;
end;
$$;
revoke all on function enforce_store_rules() from public, anon, authenticated;

drop trigger if exists stores_enforce_rules on stores;
create trigger stores_enforce_rules
  before insert or update on stores
  for each row execute function enforce_store_rules();

create or replace function enforce_cash_register_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store  record;
  v_count  int;
  v_limit  numeric;
  v_check  boolean := false;
begin
  new.code := nullif(upper(btrim(coalesce(new.code, ''))), '');
  new.name := btrim(new.name);
  if new.name = '' then raise exception 'register_name_required' using errcode = 'check_violation'; end if;

  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    raise exception 'register_tenant_immutable' using errcode = 'check_violation';
  end if;

  -- La sucursal tiene que ser del mismo negocio y no estar archivada.
  select id, tenant_id, deleted_at into v_store from stores where id = new.store_id;
  if not found or v_store.tenant_id <> new.tenant_id then
    raise exception 'store_not_found' using errcode = 'check_violation';
  end if;

  if new.deleted_at is null then
    if tg_op = 'INSERT' or old.deleted_at is not null then
      v_check := true;
    elsif new.store_id <> old.store_id then
      v_check := true;
    end if;
  end if;

  if v_check then
    if v_store.deleted_at is not null then
      raise exception 'store_archived' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtext('registers_limit:' || new.store_id::text));
    select count(*) into v_count
      from cash_registers
     where store_id = new.store_id and deleted_at is null and id <> new.id;
    if v_count >= 1 and not tenant_has_feature_for(new.tenant_id, 'multi_caja') then
      raise exception 'feature_not_in_plan: multi_caja' using errcode = 'check_violation';
    end if;
    v_limit := tenant_limit_for(new.tenant_id, 'max_registers_per_store');
    if v_limit is not null and v_count + 1 > v_limit then
      raise exception 'plan_limit: max_registers_per_store' using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- Mover de sucursal, pausar o archivar exige que no haya turno abierto.
    if (new.store_id <> old.store_id
        or (old.is_active and not new.is_active)
        or (old.deleted_at is null and new.deleted_at is not null))
       and exists (select 1 from cash_shifts cs
                    where cs.cash_register_id = new.id and cs.status = 'open') then
      raise exception 'register_has_open_shift' using errcode = 'check_violation';
    end if;
    -- Una sucursal viva no se queda sin cajas.
    if old.deleted_at is null and new.deleted_at is not null then
      if v_store.deleted_at is null and not exists (
        select 1 from cash_registers o
         where o.store_id = old.store_id and o.id <> new.id and o.deleted_at is null
      ) then
        raise exception 'last_register' using errcode = 'check_violation';
      end if;
      new.is_active := false;
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      new.is_active := true;
      new.archived_reason := null;
    end if;
  end if;

  return new;
end;
$$;
revoke all on function enforce_cash_register_rules() from public, anon, authenticated;

drop trigger if exists cash_registers_enforce_rules on cash_registers;
create trigger cash_registers_enforce_rules
  before insert or update on cash_registers
  for each row execute function enforce_cash_register_rules();

-- -----------------------------------------------------------------------------
-- E) cash_shifts.store_id (desnormalizado desde la caja)
-- -----------------------------------------------------------------------------
alter table cash_shifts add column if not exists store_id uuid references stores(id);

-- Backfill sin disparar auditoría ni updated_at (es un dato derivado).
alter table cash_shifts disable trigger audit_cash_shifts;
alter table cash_shifts disable trigger set_updated_at_cash_shifts;
update cash_shifts cs
   set store_id = cr.store_id
  from cash_registers cr
 where cr.id = cs.cash_register_id
   and cs.store_id is null;
alter table cash_shifts enable trigger audit_cash_shifts;
alter table cash_shifts enable trigger set_updated_at_cash_shifts;

alter table cash_shifts alter column store_id set not null;
create index if not exists cash_shifts_store_status_idx on cash_shifts (store_id, status);

create or replace function cash_shifts_set_store()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store uuid;
begin
  if tg_op = 'INSERT' or new.cash_register_id is distinct from old.cash_register_id then
    select store_id into v_store
      from cash_registers
     where id = new.cash_register_id and tenant_id = new.tenant_id;
    if v_store is null then
      raise exception 'register_not_found' using errcode = 'check_violation';
    end if;
    new.store_id := v_store;
  elsif new.store_id is distinct from old.store_id then
    -- El store_id del turno es histórico: no se reescribe a mano.
    new.store_id := old.store_id;
  end if;
  return new;
end;
$$;
revoke all on function cash_shifts_set_store() from public, anon, authenticated;

drop trigger if exists cash_shifts_set_store on cash_shifts;
create trigger cash_shifts_set_store
  before insert or update on cash_shifts
  for each row execute function cash_shifts_set_store();

-- -----------------------------------------------------------------------------
-- F) RLS: lectura de miembros, escritura owner/manager, sin DELETE físico.
-- -----------------------------------------------------------------------------
drop policy if exists stores_tenant_isolation on stores;
drop policy if exists stores_select on stores;
drop policy if exists stores_insert on stores;
drop policy if exists stores_update on stores;
create policy stores_select on stores
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy stores_insert on stores
  for insert with check (tenant_id = current_tenant_id() and is_tenant_manager());
create policy stores_update on stores
  for update using (tenant_id = current_tenant_id() and is_tenant_manager())
  with check (tenant_id = current_tenant_id() and is_tenant_manager());

drop policy if exists cash_registers_tenant_isolation on cash_registers;
drop policy if exists cash_registers_select on cash_registers;
drop policy if exists cash_registers_insert on cash_registers;
drop policy if exists cash_registers_update on cash_registers;
create policy cash_registers_select on cash_registers
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy cash_registers_insert on cash_registers
  for insert with check (tenant_id = current_tenant_id() and is_tenant_manager());
create policy cash_registers_update on cash_registers
  for update using (tenant_id = current_tenant_id() and is_tenant_manager())
  with check (tenant_id = current_tenant_id() and is_tenant_manager());

-- -----------------------------------------------------------------------------
-- G) Auditoría
-- -----------------------------------------------------------------------------
drop trigger if exists audit_stores on stores;
create trigger audit_stores
  after insert or update or delete on stores
  for each row execute function write_audit_log();

drop trigger if exists audit_cash_registers on cash_registers;
create trigger audit_cash_registers
  after insert or update or delete on cash_registers
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- H) Sucursal principal
-- -----------------------------------------------------------------------------
create or replace function set_default_store(p_store_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  record;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;

  select * into v_store from stores where id = p_store_id and tenant_id = v_tenant;
  if not found or v_store.deleted_at is not null then raise exception 'store_not_found'; end if;
  if not v_store.is_active then raise exception 'store_paused'; end if;
  if v_store.is_default then return; end if;

  update stores set is_default = false
   where tenant_id = v_tenant and is_default and deleted_at is null;
  update stores set is_default = true where id = p_store_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'stores', p_store_id, 'store_set_default',
          jsonb_build_object('store_id', p_store_id, 'name', v_store.name));
end;
$$;
revoke all on function set_default_store(uuid) from public, anon;
grant execute on function set_default_store(uuid) to authenticated;
