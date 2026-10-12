-- =============================================================================
-- 20261015130000_impresoras_marca_sucursal  (F17 · H92 · F10/H22 · ADR-049)
--
--   A) Logo por sucursal (opcional): stores.logo_path / logo_url. Sin logo, la
--      sucursal hereda el del negocio (tenant_branding). Se guarda en el
--      bucket tenant-assets bajo <tenant_id>/stores/<store_id>/ (las policies
--      del bucket ya exigen la carpeta del negocio).
--   B) Registro de impresoras por sucursal y caja (printers): nombre, tipo
--      (térmica 58/80, A4, etiquetas, cocina/comandas), conexión (navegador,
--      red, USB, Bluetooth; hoy la salida es por el diálogo del navegador),
--      dirección o nota, activa, última prueba. BASE.
--   C) La asignación por tipo de documento vive en print_profiles (dominio
--      pos_settings, campo mapa): cada perfil suma printer_id y
--      fallback_printer_id, y se hereda negocio ← grupo ← sucursal ← caja con
--      config_overrides (se mezcla por tipo de documento). Nada nuevo en SQL
--      para eso: la whitelist ya admite print_profiles en todos los niveles.
--   D) printer_mark_test(): cualquier miembro con acceso a la sucursal deja
--      registrada la página de prueba (ok o con problema), auditado.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Logo por sucursal
-- -----------------------------------------------------------------------------
alter table stores
  add column if not exists logo_path text,
  add column if not exists logo_url  text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_logo_url_chk') then
    alter table stores add constraint stores_logo_url_chk
      check (logo_url is null or (char_length(logo_url) <= 1000 and logo_url ~ '^https?://'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stores_logo_path_chk') then
    -- La ruta tiene que estar dentro de la carpeta de la sucursal del negocio.
    alter table stores add constraint stores_logo_path_chk
      check (logo_path is null or logo_path like (tenant_id::text || '/stores/' || id::text || '/%'));
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- B) Impresoras
-- -----------------------------------------------------------------------------
create table if not exists printers (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  cash_register_id uuid references cash_registers(id) on delete set null,
  name             text not null check (char_length(btrim(name)) between 1 and 60),
  kind             text not null check (kind in ('thermal_58', 'thermal_80', 'a4', 'label', 'kitchen')),
  connection       text not null default 'browser'
                     check (connection in ('browser', 'network', 'usb', 'bluetooth')),
  address          text check (address is null or char_length(address) <= 120),
  active           boolean not null default true,
  notes            text check (notes is null or char_length(notes) <= 300),
  last_test_at     timestamptz,
  last_test_ok     boolean,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists printers_store_idx on printers (tenant_id, store_id) where deleted_at is null;
create unique index if not exists printers_store_name_key
  on printers (store_id, lower(btrim(name))) where deleted_at is null;

drop trigger if exists set_updated_at_printers on printers;
create trigger set_updated_at_printers
  before update on printers
  for each row execute function set_updated_at();

create or replace function printers_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reg_store uuid;
begin
  if not exists (select 1 from stores where id = new.store_id and tenant_id = new.tenant_id) then
    raise exception 'store_not_found' using errcode = '23503';
  end if;
  if new.cash_register_id is not null then
    select store_id into v_reg_store from cash_registers
     where id = new.cash_register_id and tenant_id = new.tenant_id;
    if v_reg_store is null then raise exception 'register_not_found' using errcode = '23503'; end if;
    if v_reg_store <> new.store_id then raise exception 'register_store_mismatch' using errcode = '23514'; end if;
  end if;
  new.name := btrim(new.name);
  return new;
end;
$$;
drop trigger if exists printers_rules on printers;
create trigger printers_rules
  before insert or update on printers
  for each row execute function printers_rules();

alter table printers enable row level security;
drop policy if exists printers_select on printers;
drop policy if exists printers_insert on printers;
drop policy if exists printers_update on printers;
create policy printers_select on printers
  for select using (
    internal_scope()
    or (tenant_id = current_tenant_id()
        and store_id = any ((select user_allowed_store_ids())::uuid[]))
  );
create policy printers_insert on printers
  for insert with check (
    tenant_id = current_tenant_id() and is_tenant_manager() and user_can_access_store(store_id)
  );
create policy printers_update on printers
  for update using (
    tenant_id = current_tenant_id() and is_tenant_manager() and user_can_access_store(store_id)
  )
  with check (
    tenant_id = current_tenant_id() and is_tenant_manager() and user_can_access_store(store_id)
  );

drop trigger if exists audit_printers on printers;
create trigger audit_printers
  after insert or update or delete on printers
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- D) Página de prueba
-- -----------------------------------------------------------------------------
create or replace function printer_mark_test(p_printer_id uuid, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  select store_id into v_store from printers
   where id = p_printer_id and tenant_id = v_tenant and deleted_at is null;
  if v_store is null then raise exception 'printer_not_found'; end if;
  if not user_can_access_store(v_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  -- El trigger genérico registra el UPDATE; además queda un evento legible
  -- con el resultado de la prueba.
  update printers set last_test_at = now(), last_test_ok = p_ok where id = p_printer_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'printers', p_printer_id, 'printer_test',
          jsonb_build_object('ok', p_ok, 'store_id', v_store));
end;
$$;
revoke all on function printer_mark_test(uuid, boolean) from public, anon;
grant execute on function printer_mark_test(uuid, boolean) to authenticated;
