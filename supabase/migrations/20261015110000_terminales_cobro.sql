-- =============================================================================
-- 20261015110000_terminales_cobro  (F17 · H93 · ADR-049)
--
-- Registro de terminales de cobro por sucursal y caja (BASE: cada terminal
-- sigue gateada por su medio, p. ej. mercadopago_point, nave_point).
--
--   A) payment_terminals: sucursal, caja (null = flotante en la sucursal),
--      proveedor, tipo (point, qr_caja, clover, posnet_manual), id externo
--      (device id de Point, pos_id de Nave, serie de Clover, external_pos_id
--      de la caja QR de MP), datos extra (ids de sucursal y caja de MP),
--      ambiente (prod / test), etiqueta, n° de comercio, adquirente, default
--      de la caja, activa y last_seen_at.
--   B) Reglas (trigger): sucursal y caja del mismo negocio, caja dentro de la
--      sucursal, tipo coherente con el proveedor, un solo default por caja y
--      proveedor.
--   C) RLS: lectura por sucursal permitida (user_allowed_store_ids), escritura
--      owner/manager con acceso a la sucursal; sin DELETE físico. Auditoría.
--   D) terminal_for_user(): las Edges (service_role) validan que la terminal
--      pedida sea del negocio, esté activa y en una sucursal del usuario (y,
--      si mandan sucursal, que sea esa).
--   E) mp_payment_intents.payment_terminal_id (trazabilidad del cobro).
--   F) Backfill compatible: la caja QR de MP de cada ambiente
--      (tenant_payment_methods.config.mp_qr), los Point de Nave
--      (payment_secrets.nave.point_pos_ids) y las series de Clover
--      (payment_secrets.fiserv.device_serials) pasan a terminales flotantes de
--      la sucursal principal. El almacenamiento viejo NO se borra: las Edges
--      siguen aceptando los parámetros de antes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tabla
-- -----------------------------------------------------------------------------
create table if not exists payment_terminals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  cash_register_id uuid references cash_registers(id) on delete set null,
  provider_key     text not null references payment_providers(key),
  kind             text not null check (kind in ('point', 'qr_caja', 'clover', 'posnet_manual')),
  external_id      text check (external_id is null or external_id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  external_meta    jsonb not null default '{}'::jsonb check (jsonb_typeof(external_meta) = 'object'),
  environment      text check (environment is null or environment in ('prod', 'test')),
  label            text not null check (char_length(btrim(label)) between 1 and 60),
  merchant_number  text check (merchant_number is null or merchant_number ~ '^[0-9A-Za-z]{1,20}$'),
  acquirer         text check (acquirer is null or char_length(acquirer) <= 40),
  is_default       boolean not null default false,
  active           boolean not null default true,
  last_seen_at     timestamptz,
  notes            text check (notes is null or char_length(notes) <= 300),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint payment_terminals_external_required
    check (kind = 'posnet_manual' or external_id is not null)
);

create unique index if not exists payment_terminals_external_key
  on payment_terminals (tenant_id, provider_key, coalesce(environment, ''), external_id)
  where deleted_at is null and external_id is not null;
create unique index if not exists payment_terminals_default_key
  on payment_terminals (cash_register_id, provider_key)
  where deleted_at is null and is_default and cash_register_id is not null;
create index if not exists payment_terminals_store_idx
  on payment_terminals (tenant_id, store_id) where deleted_at is null;

drop trigger if exists set_updated_at_payment_terminals on payment_terminals;
create trigger set_updated_at_payment_terminals
  before update on payment_terminals
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- B) Reglas
-- -----------------------------------------------------------------------------
create or replace function payment_terminals_rules()
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

  if (new.kind = 'qr_caja' and new.provider_key <> 'mercadopago')
     or (new.kind = 'clover' and new.provider_key <> 'fiserv_point')
     or (new.kind = 'point' and new.provider_key not in ('mercadopago_point', 'nave_point',
                                                         'payway_point', 'getnet_point')) then
    raise exception 'terminal_kind_mismatch' using errcode = '23514';
  end if;

  new.label := btrim(new.label);
  -- Sin caja no hay default; archivada no queda default.
  if new.cash_register_id is null or new.deleted_at is not null then
    new.is_default := false;
  end if;
  -- Un solo default por caja y proveedor: el nuevo desplaza al anterior.
  if new.is_default and (tg_op = 'INSERT' or not old.is_default
                         or new.cash_register_id is distinct from old.cash_register_id) then
    update payment_terminals
       set is_default = false
     where cash_register_id = new.cash_register_id
       and provider_key = new.provider_key
       and is_default and deleted_at is null
       and id <> new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists payment_terminals_rules on payment_terminals;
create trigger payment_terminals_rules
  before insert or update on payment_terminals
  for each row execute function payment_terminals_rules();

-- -----------------------------------------------------------------------------
-- C) RLS y auditoría
-- -----------------------------------------------------------------------------
alter table payment_terminals enable row level security;
drop policy if exists payment_terminals_select on payment_terminals;
drop policy if exists payment_terminals_insert on payment_terminals;
drop policy if exists payment_terminals_update on payment_terminals;
create policy payment_terminals_select on payment_terminals
  for select using (
    internal_scope()
    or (tenant_id = current_tenant_id()
        and store_id = any ((select user_allowed_store_ids())::uuid[]))
  );
create policy payment_terminals_insert on payment_terminals
  for insert with check (
    tenant_id = current_tenant_id() and is_tenant_manager() and user_can_access_store(store_id)
  );
create policy payment_terminals_update on payment_terminals
  for update using (
    tenant_id = current_tenant_id() and is_tenant_manager() and user_can_access_store(store_id)
  )
  with check (
    tenant_id = current_tenant_id() and is_tenant_manager() and user_can_access_store(store_id)
  );

drop trigger if exists audit_payment_terminals on payment_terminals;
create trigger audit_payment_terminals
  after insert or update or delete on payment_terminals
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- D) Validación para las Edges (service_role)
-- -----------------------------------------------------------------------------
create or replace function terminal_for_user(
  p_tenant   uuid,
  p_user     uuid,
  p_terminal uuid,
  p_store    uuid default null
)
returns setof payment_terminals
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text;
  v_allowed uuid[];
begin
  select role into v_role from tenant_users
   where tenant_id = p_tenant and user_id = p_user and status = 'active'
   limit 1;
  if v_role is null then return; end if;
  v_allowed := staff_allowed_store_ids(p_tenant, p_user, null, v_role, null);
  return query
    select t.* from payment_terminals t
     where t.id = p_terminal
       and t.tenant_id = p_tenant
       and t.deleted_at is null
       and t.active
       and t.store_id = any (v_allowed)
       and (p_store is null or t.store_id = p_store);
end;
$$;
revoke all on function terminal_for_user(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function terminal_for_user(uuid, uuid, uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- E) Trazabilidad del cobro
-- -----------------------------------------------------------------------------
alter table mp_payment_intents
  add column if not exists payment_terminal_id uuid references payment_terminals(id) on delete set null;

-- -----------------------------------------------------------------------------
-- F) Backfill (idempotente: on conflict / not exists)
-- -----------------------------------------------------------------------------

-- Caja QR de Mercado Pago (una por ambiente) → terminal flotante de la
-- sucursal principal.
insert into payment_terminals
  (tenant_id, store_id, provider_key, kind, external_id, external_meta, environment, label, created_by)
select m.tenant_id, s.id, 'mercadopago', 'qr_caja', q.value ->> 'external_pos_id', q.value, q.key,
       case when q.key = 'test' then 'Caja QR Mercado Pago (prueba)' else 'Caja QR Mercado Pago' end,
       null
  from tenant_payment_methods m
  cross join lateral jsonb_each(case when jsonb_typeof(m.config -> 'mp_qr') = 'object'
                                     then m.config -> 'mp_qr' else '{}'::jsonb end) q
  join lateral (select st.id from stores st
                 where st.tenant_id = m.tenant_id and st.deleted_at is null
                 order by st.is_default desc, st.created_at limit 1) s on true
 where m.provider_key = 'mercadopago'
   and q.key in ('prod', 'test')
   and jsonb_typeof(q.value) = 'object'
   and coalesce(q.value ->> 'external_pos_id', '') ~ '^[A-Za-z0-9_.:-]{1,120}$'
on conflict do nothing;

-- Point de Nave ("Caja 1: 1234, Caja 2: 5678") y series de Clover.
insert into payment_terminals
  (tenant_id, store_id, provider_key, kind, external_id, label, created_by)
select x.tenant_id, s.id, x.provider_key, x.kind, x.ext,
       left(coalesce(nullif(x.lbl, ''), 'Terminal ' || x.ext), 60), null
  from (
    select ps.tenant_id,
           case ps.provider_key when 'nave' then 'nave_point' else 'fiserv_point' end as provider_key,
           case ps.provider_key when 'nave' then 'point' else 'clover' end as kind,
           btrim(case when position(':' in part) > 0
                      then regexp_replace(part, '^.*:', '') else part end) as ext,
           btrim(case when position(':' in part) > 0
                      then regexp_replace(part, ':[^:]*$', '') else '' end) as lbl
      from payment_secrets ps
      cross join lateral regexp_split_to_table(
        coalesce(case ps.provider_key when 'nave' then ps.secrets ->> 'point_pos_ids'
                                      else ps.secrets ->> 'device_serials' end, ''),
        '[,;\n]+') part
     where ps.provider_key in ('nave', 'fiserv')
       and btrim(part) <> ''
  ) x
  join lateral (select st.id from stores st
                 where st.tenant_id = x.tenant_id and st.deleted_at is null
                 order by st.is_default desc, st.created_at limit 1) s on true
 where x.ext ~ '^[A-Za-z0-9_-]{1,64}$'
on conflict do nothing;
