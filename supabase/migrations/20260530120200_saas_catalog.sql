-- =============================================================================
-- 20260530120200_saas_catalog
-- Hito 0 — plans, subscriptions, feature_flags, tenant_feature_flags,
-- system_settings. Ver docs/04-database.md §4.1-4.2, docs/07-feature-flags.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- plans — niveles de suscripción (global, lectura pública).
-- -----------------------------------------------------------------------------
create table if not exists plans (
  id                uuid primary key default gen_random_uuid(),
  key               text not null unique
                      check (key in ('start','pro','business','enterprise')),
  name              text not null,
  description       text,
  monthly_price_ars numeric(12,2) not null,
  yearly_price_ars  numeric(12,2),
  limits            jsonb not null default '{}'::jsonb,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- subscriptions — una por tenant.
-- -----------------------------------------------------------------------------
create table if not exists subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade unique,
  plan_id              uuid not null references plans(id),
  status               text not null
                         check (status in ('trial','active','past_due','suspended','cancelled')),
  billing_cycle        text not null default 'monthly'
                         check (billing_cycle in ('monthly','yearly')),
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists subscriptions_tenant_idx on subscriptions(tenant_id);

create trigger set_updated_at_subscriptions
  before update on subscriptions
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- feature_flags — catálogo de flags (global, lectura pública).
-- -----------------------------------------------------------------------------
create table if not exists feature_flags (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,
  description     text,
  default_enabled boolean not null default false,
  created_at      timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- tenant_feature_flags — activación por tenant.
-- -----------------------------------------------------------------------------
create table if not exists tenant_feature_flags (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  feature_flag_id uuid not null references feature_flags(id) on delete cascade,
  enabled         boolean not null,
  configured_by   uuid references public.users(id),
  configured_at   timestamptz not null default now(),
  unique(tenant_id, feature_flag_id)
);

create index if not exists tenant_feature_flags_tenant_idx on tenant_feature_flags(tenant_id);

-- -----------------------------------------------------------------------------
-- system_settings — config global (solo internal).
-- -----------------------------------------------------------------------------
create table if not exists system_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
