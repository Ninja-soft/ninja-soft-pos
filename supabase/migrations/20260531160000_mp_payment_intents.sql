-- =============================================================================
-- 20260531160000_mp_payment_intents  (F8/H15 etapa 2)
-- Intentos de cobro por QR (Mercado Pago Checkout Pro). El POS crea un intent
-- (Edge Function), muestra el QR del init_point y consulta el estado en vivo
-- (select por tenant). El webhook actualiza el estado. Escritura solo service_role.
-- =============================================================================
create table if not exists mp_payment_intents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  provider_key  text not null default 'mercadopago',
  amount        numeric(12,2) not null check (amount > 0),
  status        text not null default 'pending'
                  check (status in ('pending','approved','rejected','cancelled','expired')),
  preference_id text,
  init_point    text,
  mp_payment_id text,
  sale_id       uuid references sales(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists mpi_tenant_idx on mp_payment_intents(tenant_id, created_at desc);

create trigger set_updated_at_mp_payment_intents
  before update on mp_payment_intents
  for each row execute function set_updated_at();

alter table mp_payment_intents enable row level security;
-- Lectura por tenant (el POS consulta el estado). Escritura: solo service_role
-- (Edge Functions) → sin policy de insert/update/delete.
create policy mpi_select on mp_payment_intents
  for select using (tenant_id = current_tenant_id() or is_internal());
