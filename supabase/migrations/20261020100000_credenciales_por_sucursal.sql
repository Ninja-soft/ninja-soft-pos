-- =============================================================================
-- 20261020100000_credenciales_por_sucursal  (F17 · H93 · ADR-057)
--
-- Credenciales de proveedor por sucursal. Algunos proveedores trabajan por
-- local (GO Cuotas "API Key de la sucursal", Nave pos_id, Payway o Fiserv con
-- un n° de comercio por local, una cuenta de Mercado Pago por franquicia).
--
--   A) payment_secrets.store_id (null = credencial del negocio). La fila sin
--      sucursal es la de siempre: las filas existentes quedan como default del
--      negocio sin tocarlas. Resolución en las Edges: sucursal → negocio.
--      La PK (tenant_id, provider_key) pasa a un id uuid y la unicidad a
--      (tenant_id, provider_key, store_id) NULLS NOT DISTINCT, así el upsert de
--      PostgREST con onConflict "tenant_id,provider_key,store_id" sirve para
--      las dos clases de fila. Sigue con RLS deny-all: sólo service_role.
--   B) mp_payment_intents.secret_store_id: con qué credencial se creó el cobro
--      (null = la del negocio). Los webhooks y el poll verifican con ESA misma
--      credencial aunque después la sucursal cargue o borre la suya.
--   C) payment_secret_scope_check (service_role): valida para la Edge
--      set_payment_secret (y el OAuth de Mercado Pago) que la sucursal sea del
--      negocio y esté viva, que el usuario sea dueño o encargado con acceso a
--      ella y que el plan tenga multi_sucursal. Gating server-side real.
--   D) payment_secret_scopes(): qué alcances tienen credencial propia (sin
--      exponer ningún secreto), para la UI de "Todo el negocio / Sucursal X".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Columna, PK y unicidad
-- -----------------------------------------------------------------------------
alter table payment_secrets add column if not exists id uuid not null default gen_random_uuid();
alter table payment_secrets add column if not exists store_id uuid references stores(id) on delete cascade;

do $$
declare
  v_pk text;
begin
  select conname into v_pk from pg_constraint
   where conrelid = 'public.payment_secrets'::regclass and contype = 'p';
  if v_pk is not null and v_pk <> 'payment_secrets_id_pkey' then
    execute format('alter table payment_secrets drop constraint %I', v_pk);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.payment_secrets'::regclass and contype = 'p') then
    alter table payment_secrets add constraint payment_secrets_id_pkey primary key (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_secrets_scope_key') then
    alter table payment_secrets add constraint payment_secrets_scope_key
      unique nulls not distinct (tenant_id, provider_key, store_id);
  end if;
end $$;

create index if not exists payment_secrets_store_idx
  on payment_secrets (store_id) where store_id is not null;

-- La sucursal tiene que ser del mismo negocio (defensa ante un service_role
-- mal usado; la Edge ya lo valida con payment_secret_scope_check).
create or replace function payment_secrets_store_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.store_id is not null and not exists (
    select 1 from stores s where s.id = new.store_id and s.tenant_id = new.tenant_id
  ) then
    raise exception 'store_not_in_tenant' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists payment_secrets_store_guard on payment_secrets;
create trigger payment_secrets_store_guard
  before insert or update of store_id, tenant_id on payment_secrets
  for each row execute function payment_secrets_store_guard();

-- -----------------------------------------------------------------------------
-- B) Credencial usada por cada cobro
-- -----------------------------------------------------------------------------
alter table mp_payment_intents
  add column if not exists secret_store_id uuid references stores(id) on delete set null;

-- -----------------------------------------------------------------------------
-- C) Validación de alcance para las Edges (service_role)
-- -----------------------------------------------------------------------------
-- Devuelve null si el usuario puede guardar credenciales en ese alcance, o el
-- código de error. p_store null = credencial del negocio (dueño o encargado,
-- como siempre).
create or replace function payment_secret_scope_check(p_tenant uuid, p_user uuid, p_store uuid)
returns text
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
  if v_role is null or v_role not in ('owner', 'manager') then return 'forbidden'; end if;
  if v_role <> 'owner' and staff_effective_status(p_tenant, p_user, null, null) <> 'active' then
    return 'forbidden';
  end if;
  if p_store is null then return null; end if;
  if not tenant_has_feature_for(p_tenant, 'multi_sucursal') then
    return 'feature_not_in_plan';
  end if;
  if not exists (select 1 from stores where id = p_store and tenant_id = p_tenant and deleted_at is null) then
    return 'store_not_found';
  end if;
  v_allowed := staff_allowed_store_ids(p_tenant, p_user, null, v_role, null);
  if not (p_store = any (coalesce(v_allowed, '{}'::uuid[]))) then return 'forbidden'; end if;
  return null;
end;
$$;
revoke all on function payment_secret_scope_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function payment_secret_scope_check(uuid, uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- D) Alcances con credencial (sin secretos) para la UI
-- -----------------------------------------------------------------------------
-- Una fila por (proveedor, sucursal) con credencial cargada: claves que tiene
-- (sólo los nombres) y fecha. Dueño o encargado; las sucursales fuera de su
-- alcance no se listan.
create or replace function payment_secret_scopes()
returns table (provider_key text, store_id uuid, keys text[], updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_allowed uuid[];
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_allowed := user_allowed_store_ids();
  return query
    select ps.provider_key,
           ps.store_id,
           coalesce((select array_agg(k order by k) from jsonb_object_keys(ps.secrets) k), '{}'::text[]),
           ps.updated_at
      from payment_secrets ps
     where ps.tenant_id = v_tenant
       and (ps.store_id is null or ps.store_id = any (v_allowed))
     order by ps.provider_key, ps.store_id nulls first;
end;
$$;
revoke all on function payment_secret_scopes() from public, anon;
grant execute on function payment_secret_scopes() to authenticated;

comment on column payment_secrets.store_id is
  'F17 · ADR-057: null = credencial del negocio; con valor, credencial propia de esa sucursal (pisa a la del negocio).';
comment on column mp_payment_intents.secret_store_id is
  'F17 · ADR-057: sucursal de la credencial con la que se creó el cobro (null = la del negocio).';
