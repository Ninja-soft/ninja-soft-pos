-- =============================================================================
-- 20260530120100_identity_tenants_users
-- Hito 0 — tablas de identidad: tenants, users (espejo de auth.users),
-- tenant_users (membership). Ver docs/04-database.md §4.1-4.2, docs/08.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- tenants — catálogo de clientes del SaaS (tabla global, sin tenant_id propio).
-- -----------------------------------------------------------------------------
create table if not exists tenants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  cuit          text,
  industry      text check (industry in ('kiosco','textil','retail','restaurante','pyme','otro')),
  country       text not null default 'AR',
  status        text not null default 'trial'
                  check (status in ('trial','active','past_due','suspended','cancelled')),
  trial_ends_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists tenants_status_idx on tenants(status);
create index if not exists tenants_slug_idx on tenants(slug);

create trigger set_updated_at_tenants
  before update on tenants
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- users — espejo público de auth.users. PK = auth.users.id.
-- -----------------------------------------------------------------------------
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  full_name   text,
  avatar_url  text,
  locale      text default 'es-AR',
  is_internal boolean not null default false,  -- staff NinjaSoft
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger set_updated_at_users
  before update on public.users
  for each row execute function set_updated_at();

-- handle_new_user: al crear un auth.users, crea su fila espejo en public.users.
-- SECURITY DEFINER para poder escribir saltando RLS durante el signup.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- -----------------------------------------------------------------------------
-- tenant_users — relación usuario ↔ tenant con rol. Un usuario en N tenants.
-- -----------------------------------------------------------------------------
create table if not exists tenant_users (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  role       text not null check (role in ('owner','manager','cashier','viewer')),
  status     text not null default 'active'
               check (status in ('active','suspended','invited')),
  invited_at timestamptz,
  joined_at  timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id, user_id)
);

create index if not exists tenant_users_user_idx on tenant_users(user_id);
create index if not exists tenant_users_tenant_idx on tenant_users(tenant_id);

create trigger set_updated_at_tenant_users
  before update on tenant_users
  for each row execute function set_updated_at();
