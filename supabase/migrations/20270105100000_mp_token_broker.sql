-- =============================================================================
-- ADR-166: MP token broker. Claves de servidor a servidor para que un sistema
-- externo del MISMO negocio lea el access token vigente de Mercado Pago sin
-- tener nunca el refresh token (NinjaPos sigue siendo el único que renueva).
--
-- * Una clave = un negocio. Se guarda sólo el SHA-256 (key_hash); la clave en
--   claro se entrega una vez y no se puede recuperar.
-- * Sin policies: la tabla sólo la lee la Edge mp_token_broker con
--   service_role. anon/authenticated no tienen ningún acceso.
-- * Revocación lógica (revoked_at); allowed_ips opcional.
-- =============================================================================
create table if not exists public.mp_token_broker_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  label text not null,
  key_hash text not null unique,
  key_prefix text not null,
  allowed_ips text[],
  created_at timestamptz not null default now(),
  created_by uuid,
  last_used_at timestamptz,
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint mp_token_broker_keys_hash_fmt check (key_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists mp_token_broker_keys_tenant_idx
  on public.mp_token_broker_keys (tenant_id);

alter table public.mp_token_broker_keys enable row level security;
revoke all on public.mp_token_broker_keys from anon, authenticated;

comment on table public.mp_token_broker_keys is
  'ADR-166: claves de la Edge mp_token_broker (sólo hash). Sin policies: service_role únicamente.';
