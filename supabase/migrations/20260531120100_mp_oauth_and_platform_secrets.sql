-- =============================================================================
-- 20260531120000_mp_oauth_and_platform_secrets  (H15 etapa 3 — F8)
-- OAuth de Mercado Pago para tenants + secretos de plataforma (cuenta MP propia
-- de NinjaSoft para cobrar suscripciones). Aplicada vía Supabase MCP.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- platform_secrets — credenciales globales de NinjaSoft (no por tenant).
-- Ej: app de Mercado Pago (client_id/secret para OAuth + access_token propio
-- para cobrar suscripciones). RLS sin policies = deny a todos; solo service_role
-- (Edge Functions) las lee/escribe. Se editan desde el panel internal.
-- -----------------------------------------------------------------------------
create table if not exists platform_secrets (
  key        text primary key,           -- ej. 'mercadopago'
  secrets    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table platform_secrets enable row level security;

create trigger set_updated_at_platform_secrets
  before update on platform_secrets
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- mp_oauth_states — anti-CSRF del flujo OAuth. Cada "Conectar con Mercado Pago"
-- crea una fila; el callback la valida y la borra. RLS deny a todos.
-- -----------------------------------------------------------------------------
create table if not exists mp_oauth_states (
  state       text primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null,
  created_at  timestamptz not null default now()
);
alter table mp_oauth_states enable row level security;
create index if not exists mp_oauth_states_tenant_idx on mp_oauth_states(tenant_id);

-- -----------------------------------------------------------------------------
-- subscriptions.mp_preapproval_id — id de la suscripción (preapproval) de MP
-- creada con la cuenta de NinjaSoft. El webhook de billing actualiza el estado
-- de la suscripción matcheando por este id (o por external_reference = sub.id).
-- -----------------------------------------------------------------------------
alter table subscriptions
  add column if not exists mp_preapproval_id text;
create index if not exists subscriptions_mp_preapproval_idx
  on subscriptions(mp_preapproval_id);

