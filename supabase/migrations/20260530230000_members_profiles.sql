-- =============================================================================
-- 20260530230000_members_profiles  (H11b — F7)
-- Miembros del negocio: nombre visible por membresía, avatar, y perfiles de
-- cajero SIN login (etiqueta + PIN opcional). Extiende tenant_members().
-- Aplicada vía Supabase MCP el 2026-05-30 (members_profiles_and_tenant_members).
-- =============================================================================

alter table tenant_users add column if not exists display_name text;
alter table tenant_users add column if not exists avatar text;

create table if not exists cashier_profiles (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  display_name text not null,
  avatar       text,
  pin_hash     text,
  status       text not null default 'active' check (status in ('active','suspended')),
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists cashier_profiles_tenant_idx on cashier_profiles(tenant_id);

create trigger set_updated_at_cashier_profiles
  before update on cashier_profiles
  for each row execute function set_updated_at();

alter table cashier_profiles enable row level security;

-- Lectura: miembros del tenant. Escritura: solo vía Edge Function member_admin
-- (service_role valida owner/manager). Sin policy de escritura => denegado.
create policy cashier_profiles_select on cashier_profiles
  for select
  using (tenant_id = current_tenant_id() or is_internal());

-- Cambia el tipo de retorno respecto de 20260530220000 (suma display_name y
-- avatar): hace falta drop previo porque "create or replace" no puede cambiar
-- el row type. (Fix de replay 2026-06-04: en el remoto ya está aplicada con
-- este resultado; este drop solo repara la reproducción en DBs frescas —
-- local/staging/CI. Detectado por el job `rls` de CI.)
drop function if exists tenant_members();

create or replace function tenant_members()
returns table (
  user_id      uuid,
  email        text,
  full_name    text,
  display_name text,
  role         text,
  status       text,
  joined_at    timestamptz,
  avatar       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tu.user_id, u.email, u.full_name, tu.display_name, tu.role,
         tu.status, tu.joined_at, tu.avatar
  from tenant_users tu
  join users u on u.id = tu.user_id
  where tu.tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
    )
  order by tu.joined_at nulls last;
$$;

revoke all on function tenant_members() from public, anon;
grant execute on function tenant_members() to authenticated;
-- Nota: la galería de imágenes de producto (product_images + bucket Storage) está
-- en 20260531000000_product_images.sql.
