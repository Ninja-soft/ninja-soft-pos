-- =============================================================================
-- 20261120100000_servicios_tipos.sql  (ADR-122)
--
-- Tipos de servicio extensibles por negocio (Programa, Visita, Trabajo,
-- Informe, Análisis, Consultoría, Mantenimiento y los que sume el negocio).
-- Base: ADR-116 (products.is_service, unidad, invoice_detail, aclaraciones).
--
-- Clasificación (CLAUDE.md §6): FLAG-OPERATIVO, sin key nueva en `features`.
-- Es vocabulario del catálogo de servicios (como la unidad o las aclaraciones
-- de ADR-116): no tiene costo de plataforma ni se cobra aparte.
--
-- A) service_types: tipos del negocio. tenant_id, RLS con
--    (select current_tenant_id()), escritura dueño/encargado (policy +
--    trg_role_write_guard('manage')), sin DELETE (baja lógica) y auditoría.
-- B) ensure_service_types(): siembra los 7 tipos base la primera vez que el
--    negocio abre la lista (idempotente: si ya tuvo tipos, aunque los haya
--    dado de baja, no vuelve a sembrar).
-- C) products.service_type_id: el tipo del servicio (null = sin tipo).
-- D) sale_items.service_type_name: foto del tipo al vender (la factura no
--    cambia si después se renombra). La completa un trigger BEFORE INSERT
--    (create_sale no se toca: ADR-116 ya la copió completa).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tipos de servicio
-- -----------------------------------------------------------------------------
create table if not exists service_types (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  -- Ícono de lucide (clave corta: clipboard, map-pin, wrench...). Libre: la UI
  -- cae a uno genérico si no lo conoce.
  icon        text check (icon is null or char_length(icon) <= 40),
  sort        int not null default 0 check (sort between 0 and 9999),
  is_active   boolean not null default true,
  is_seed     boolean not null default false,
  created_by  uuid default auth.uid() references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Un nombre por negocio entre los vigentes.
create unique index if not exists service_types_tenant_name_key
  on service_types (tenant_id, lower(btrim(name))) where deleted_at is null;
create index if not exists service_types_tenant_sort_idx
  on service_types (tenant_id, sort, created_at) where deleted_at is null;
create index if not exists service_types_tenant_created_idx
  on service_types (tenant_id, created_at desc);
create index if not exists service_types_created_by_idx
  on service_types (created_by) where created_by is not null;

drop trigger if exists set_updated_at_service_types on service_types;
create trigger set_updated_at_service_types
  before update on service_types
  for each row execute function set_updated_at();

alter table service_types enable row level security;
drop policy if exists service_types_select on service_types;
create policy service_types_select on service_types
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists service_types_insert on service_types;
create policy service_types_insert on service_types
  for insert with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
drop policy if exists service_types_update on service_types;
create policy service_types_update on service_types
  for update using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
-- Sin DELETE: baja lógica (los servicios y las ventas guardan su nombre).
revoke delete on service_types from anon, authenticated;
revoke all on service_types from anon;

drop trigger if exists role_write_guard on service_types;
create trigger role_write_guard before insert or update or delete on service_types
  for each row execute function trg_role_write_guard('manage');

create or replace function _service_types_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (new.tenant_id, auth.uid(), 'service_type', new.id,
          case
            when tg_op = 'INSERT' then 'service_type_created'
            when new.deleted_at is not null and old.deleted_at is null then 'service_type_deleted'
            else 'service_type_updated'
          end,
          case when tg_op = 'UPDATE' then
            jsonb_build_object('name', old.name, 'icon', old.icon, 'is_active', old.is_active, 'sort', old.sort)
          end,
          jsonb_build_object('name', new.name, 'icon', new.icon, 'is_active', new.is_active, 'sort', new.sort,
                             'deleted', new.deleted_at is not null));
  return null;
end;
$$;
revoke all on function _service_types_audit() from public, anon, authenticated;

drop trigger if exists service_types_audit on service_types;
create trigger service_types_audit
  after insert or update on service_types
  for each row execute function _service_types_audit();

comment on table service_types is
  'ADR-122: tipos de servicio del negocio (Programa, Visita, Trabajo, Informe...). Baja lógica; el servicio guarda el id y la venta y el presupuesto, el nombre.';

-- -----------------------------------------------------------------------------
-- B) Semilla por negocio (la primera vez)
-- -----------------------------------------------------------------------------
create or replace function ensure_service_types()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
  v_n      int := 0;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  v_role := member_role_in(v_tenant);
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Solo lectura no siembra (el guard de rol lo rechazaría): ve la lista vacía.
  if v_role = 'viewer' then
    return 0;
  end if;
  -- Ya tuvo tipos (aunque estén dados de baja): no se vuelve a sembrar.
  if exists (select 1 from service_types where tenant_id = v_tenant) then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtext('service_types_seed:' || v_tenant::text));
  if exists (select 1 from service_types where tenant_id = v_tenant) then
    return 0;
  end if;
  insert into service_types (tenant_id, name, icon, sort, is_seed, created_by)
  select v_tenant, s.name, s.icon, s.sort, true, null
    from (values
      ('Programa',      'calendar-range', 10),
      ('Visita',        'map-pin',        20),
      ('Trabajo',       'hammer',         30),
      ('Informe',       'file-text',      40),
      ('Análisis',      'flask-conical',  50),
      ('Consultoría',   'messages-square',60),
      ('Mantenimiento', 'wrench',         70)
    ) as s(name, icon, sort);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function ensure_service_types() from public, anon;
grant execute on function ensure_service_types() to authenticated;

-- -----------------------------------------------------------------------------
-- C) Tipo del servicio en el catálogo
-- -----------------------------------------------------------------------------
alter table products
  add column if not exists service_type_id uuid references service_types(id) on delete set null;
create index if not exists products_service_type_idx
  on products (service_type_id) where service_type_id is not null;
comment on column products.service_type_id is
  'ADR-122: tipo del servicio (service_types). Sólo tiene sentido con is_service.';

-- El tipo tiene que ser del mismo negocio que el producto.
create or replace function _products_service_type_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.service_type_id is not null
     and (tg_op = 'INSERT' or new.service_type_id is distinct from old.service_type_id)
     and not exists (select 1 from service_types t
                      where t.id = new.service_type_id and t.tenant_id = new.tenant_id) then
    raise exception 'service_type_invalid' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function _products_service_type_check() from public, anon, authenticated;

drop trigger if exists products_service_type_check on products;
create trigger products_service_type_check
  before insert or update of service_type_id on products
  for each row execute function _products_service_type_check();

-- -----------------------------------------------------------------------------
-- D) Foto del tipo en el renglón vendido
-- -----------------------------------------------------------------------------
alter table sale_items add column if not exists service_type_name text;
alter table sale_items drop constraint if exists sale_items_service_type_len;
alter table sale_items add constraint sale_items_service_type_len
  check (service_type_name is null or char_length(service_type_name) <= 40) not valid;
comment on column sale_items.service_type_name is
  'ADR-122: tipo del servicio al venderlo (sale en la factura debajo del nombre). null = producto o servicio sin tipo.';

-- Un solo lookup por PK en products por renglón con producto. Sin
-- current_tenant_id() (ADR-083): el tenant es el de la fila.
create or replace function _sale_items_service_type()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.product_id is not null and new.service_type_name is null then
    select t.name into new.service_type_name
      from products p
      join service_types t on t.id = p.service_type_id and t.tenant_id = p.tenant_id
     where p.id = new.product_id and p.tenant_id = new.tenant_id and coalesce(p.is_service, false);
  end if;
  return new;
end;
$$;
revoke all on function _sale_items_service_type() from public, anon, authenticated;

drop trigger if exists sale_items_service_type on sale_items;
create trigger sale_items_service_type
  before insert on sale_items
  for each row execute function _sale_items_service_type();
