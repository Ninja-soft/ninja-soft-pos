-- =============================================================================
-- 20261110300100_envios_nucleo  (Envíos y logística, fase 1 · ADR-103)
--
-- Núcleo de datos del módulo de envíos. Espejo del patrón de pagos
-- (payment_providers / tenant_payment_methods / payment_secrets) con la
-- herencia negocio → sucursal de ADR-057:
--
--   A) shipping_providers: catálogo global de logísticas (carrier, agregador,
--      red de puntos o simulador), estado del adaptador (active, skeleton,
--      planned), capacidades y formatos de etiqueta. Lectura para todos.
--   B) shipping_connections: conexión por negocio (store_id null) o por
--      sucursal (pisa a la del negocio). Configuración NO secreta (número de
--      cliente, contratos, sucursal de despacho) y los nombres de las claves
--      cargadas. Se escribe sólo desde la Edge `shipping` (service_role), que
--      valida rol, sucursal y plan con shipping_access_check.
--   C) shipping_secrets: usuario, clave, API key por conexión. RLS sin
--      policies y sin GRANT para anon ni authenticated: sólo service_role.
--   D) shipments: el envío (origen POS, pedido, manual, Mercado Libre a
--      futuro), destino, bultos, valor declarado, servicio, cotización, estado
--      normalizado, tracking y etiqueta. idempotency_key única por negocio.
--      Se escribe sólo por RPC (20261110300200) o por el worker.
--   E) shipment_events: historial append-only (dedupe por evento).
--   F) shipping_jobs: cola idempotente (un trabajo vivo por envío y tipo),
--      reintentos con espera y toma con FOR UPDATE SKIP LOCKED.
--   G) Bucket privado shipping-labels (sólo service_role; la Edge entrega
--      URLs firmadas cortas).
--
-- RLS por negocio con "(select ...)" y alcance de sucursal; nunca
-- "OR is_internal()" (ADR-052). FKs con índice. role_write_guard.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogo de logísticas
-- -----------------------------------------------------------------------------
create table if not exists shipping_providers (
  key           text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name          text not null,
  kind          text not null check (kind in ('carrier', 'aggregator', 'points', 'simulator')),
  status        text not null default 'planned' check (status in ('active', 'skeleton', 'planned')),
  capabilities  jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  label_formats text[] not null default '{}',
  sort          int not null default 0,
  is_active     boolean not null default true
);
alter table shipping_providers enable row level security;
drop policy if exists shipping_providers_read on shipping_providers;
create policy shipping_providers_read on shipping_providers for select using (true);
revoke insert, update, delete on shipping_providers from anon, authenticated;

-- Capacidades: quote, label, points, track, cancel, webhooks, pickup.
-- active   = adaptador real o simulador; skeleton = adaptador documentado sin
-- endpoints confirmados (no opera); planned = sin documentación pública (se
-- integra por agregador o cuando un negocio con contrato la consiga).
insert into shipping_providers (key, name, kind, status, capabilities, label_formats, sort) values
  ('simulador', 'Simulador de envíos', 'simulator', 'active',
   '{"quote":true,"label":true,"points":true,"track":true,"cancel":true,"webhooks":false,"pickup":false}', array['pdf','zpl'], 0),
  ('andreani', 'Andreani', 'carrier', 'active',
   '{"quote":true,"label":true,"points":true,"track":true,"cancel":false,"webhooks":false,"pickup":false}', array['pdf'], 10),
  ('correo_argentino', 'Correo Argentino', 'carrier', 'skeleton',
   '{"quote":true,"label":false,"points":true,"track":true,"cancel":false,"webhooks":false,"pickup":false}', array['pdf'], 20),
  ('oca', 'OCA', 'carrier', 'skeleton',
   '{"quote":true,"label":true,"points":true,"track":true,"cancel":true,"webhooks":false,"pickup":true}', array['pdf'], 30),
  ('enviopack', 'Envíopack', 'aggregator', 'skeleton',
   '{"quote":true,"label":true,"points":true,"track":true,"cancel":true,"webhooks":true,"pickup":true}', array['pdf'], 40),
  ('pickit', 'Pickit', 'points', 'planned', '{}', '{}', 100),
  ('hop', 'HOP Envíos', 'points', 'planned', '{}', '{}', 110),
  ('andesmar', 'Andesmar Cargas', 'carrier', 'planned', '{}', '{}', 120),
  ('urbano', 'Urbano Express', 'carrier', 'planned', '{}', '{}', 130),
  ('bluemail', 'Bluemail', 'carrier', 'planned', '{}', '{}', 140),
  ('cabify_logistics', 'Cabify Logistics', 'carrier', 'planned', '{}', '{}', 150),
  ('moova', 'Moova', 'carrier', 'planned', '{}', '{}', 160),
  ('zipnova', 'Zipnova', 'aggregator', 'planned', '{}', '{}', 170)
on conflict (key) do update
  set name = excluded.name,
      kind = excluded.kind,
      status = excluded.status,
      capabilities = excluded.capabilities,
      label_formats = excluded.label_formats,
      sort = excluded.sort;

-- Key de plan de cada logística (espejo: lib/shipping/providerFeature.ts).
-- El simulador no tiene key propia: lo cubre `envios`.
create or replace function shipping_provider_plan_key(p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_key is null or p_key = 'simulador' then null else p_key end;
$$;

-- -----------------------------------------------------------------------------
-- B) Conexiones por negocio o sucursal
-- -----------------------------------------------------------------------------
create table if not exists shipping_connections (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  store_id        uuid references stores(id) on delete cascade,
  provider_key    text not null references shipping_providers(key),
  enabled         boolean not null default true,
  sandbox         boolean not null default true,
  config          jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  secret_keys     text[] not null default '{}',
  last_test_at    timestamptz,
  last_test_ok    boolean,
  last_test_error text check (last_test_error is null or char_length(last_test_error) <= 300),
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
-- Una conexión viva por (negocio, logística, sucursal); null = la del negocio.
create unique index if not exists shipping_connections_scope_uniq
  on shipping_connections (tenant_id, provider_key, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where deleted_at is null;
create index if not exists shipping_connections_tenant_idx
  on shipping_connections (tenant_id, created_at);
create index if not exists shipping_connections_store_idx
  on shipping_connections (store_id) where store_id is not null;
create index if not exists shipping_connections_provider_idx
  on shipping_connections (provider_key);
create index if not exists shipping_connections_created_by_idx
  on shipping_connections (created_by) where created_by is not null;

drop trigger if exists set_updated_at_shipping_connections on shipping_connections;
create trigger set_updated_at_shipping_connections
  before update on shipping_connections
  for each row execute function set_updated_at();

alter table shipping_connections enable row level security;
drop policy if exists shipping_connections_select on shipping_connections;
create policy shipping_connections_select on shipping_connections
  for select using (
    tenant_id = (select current_tenant_id())
    and (store_id is null or store_id = any ((select user_allowed_store_ids())::uuid[]))
  );
-- Sin INSERT/UPDATE/DELETE para clientes: la Edge `shipping` escribe con
-- service_role después de shipping_access_check (rol, sucursal y plan).
revoke insert, update, delete on shipping_connections from anon, authenticated;

drop trigger if exists role_write_guard on shipping_connections;
create trigger role_write_guard before insert or update or delete on shipping_connections
  for each row execute function trg_role_write_guard('manage');

-- Defensa en la base: sucursal del mismo negocio, negocio inmutable, logística
-- que no sea "planned" y nada que parezca un secreto en la config visible.
create or replace function _shipping_connections_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_immutable' using errcode = '42501';
  end if;
  if new.store_id is not null and not exists (
    select 1 from stores s where s.id = new.store_id and s.tenant_id = new.tenant_id
  ) then
    raise exception 'store_not_in_tenant' using errcode = '23514';
  end if;
  select status into v_status from shipping_providers where key = new.provider_key;
  if v_status is null or v_status = 'planned' then
    raise exception 'provider_not_available' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_object_keys(new.config) k
     where k ~* '(password|passwd|clave|secret|token|api_?key|apikey)'
  ) then
    raise exception 'secret_in_config' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function _shipping_connections_guard() from public, anon, authenticated;

drop trigger if exists shipping_connections_guard on shipping_connections;
create trigger shipping_connections_guard
  before insert or update on shipping_connections
  for each row execute function _shipping_connections_guard();

comment on table shipping_connections is
  'ADR-103: conexión de un negocio (store_id null) o de una sucursal (pisa a la del negocio) con una logística. Config no secreta; los secretos en shipping_secrets.';

-- -----------------------------------------------------------------------------
-- C) Secretos (sólo service_role)
-- -----------------------------------------------------------------------------
create table if not exists shipping_secrets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null unique references shipping_connections(id) on delete cascade,
  secrets       jsonb not null default '{}'::jsonb check (jsonb_typeof(secrets) = 'object'),
  updated_at    timestamptz not null default now()
);
create index if not exists shipping_secrets_tenant_idx on shipping_secrets (tenant_id);
alter table shipping_secrets enable row level security;
-- Sin policies: anon y authenticated no leen ni escriben nunca.
revoke all on shipping_secrets from anon, authenticated;

create or replace function _shipping_secrets_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from shipping_connections c where c.id = new.connection_id and c.tenant_id = new.tenant_id
  ) then
    raise exception 'connection_not_in_tenant' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function _shipping_secrets_guard() from public, anon, authenticated;

drop trigger if exists shipping_secrets_guard on shipping_secrets;
create trigger shipping_secrets_guard
  before insert or update on shipping_secrets
  for each row execute function _shipping_secrets_guard();

-- -----------------------------------------------------------------------------
-- D) Envíos
-- -----------------------------------------------------------------------------
create table if not exists shipments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  store_id            uuid not null references stores(id),
  connection_id       uuid references shipping_connections(id) on delete set null,
  provider_key        text references shipping_providers(key),
  source              text not null default 'manual'
                        check (source in ('pos_sale', 'order', 'manual', 'mercadolibre')),
  sale_id             uuid references sales(id) on delete set null,
  order_ref           text check (order_ref is null or char_length(order_ref) <= 80),
  external_ref        text check (external_ref is null or char_length(external_ref) <= 120),
  idempotency_key     text not null check (char_length(idempotency_key) between 8 and 120),
  service_type        text not null default 'door' check (service_type in ('door', 'branch')),
  service_code        text check (service_code is null or char_length(service_code) <= 40),
  pickup_point        jsonb check (pickup_point is null or jsonb_typeof(pickup_point) = 'object'),
  recipient           jsonb not null check (jsonb_typeof(recipient) = 'object'),
  destination         jsonb not null check (jsonb_typeof(destination) = 'object'),
  origin              jsonb not null default '{}'::jsonb check (jsonb_typeof(origin) = 'object'),
  packages            jsonb not null check (jsonb_typeof(packages) = 'array'),
  package_count       int not null default 1 check (package_count between 1 and 20),
  total_weight_kg     numeric(10,3) not null default 0 check (total_weight_kg >= 0),
  declared_value      numeric(14,2) not null default 0 check (declared_value >= 0),
  quote               jsonb check (quote is null or jsonb_typeof(quote) = 'object'),
  quoted_cost         numeric(14,2) check (quoted_cost is null or quoted_cost >= 0),
  status              text not null default 'draft'
                        check (status in ('draft', 'quoted', 'pending', 'created', 'label_ready',
                                          'picked_up', 'in_transit', 'out_for_delivery',
                                          'ready_for_pickup', 'delivered', 'failed_attempt',
                                          'returned', 'cancelled', 'error')),
  status_detail       text check (status_detail is null or char_length(status_detail) <= 500),
  carrier_status      text check (carrier_status is null or char_length(carrier_status) <= 200),
  tracking_number     text check (tracking_number is null or char_length(tracking_number) <= 80),
  external_id         text check (external_id is null or char_length(external_id) <= 120),
  label_path          text,
  label_format        text check (label_format is null or label_format in ('pdf', 'zpl')),
  label_ready_at      timestamptz,
  create_attempted_at timestamptz,
  create_uncertain    boolean not null default false,
  cancel_requested_at timestamptz,
  cancel_reason       text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  cancelled_at        timestamptz,
  delivered_at        timestamptz,
  last_tracked_at     timestamptz,
  next_track_at       timestamptz,
  track_failures      int not null default 0,
  notes               text check (notes is null or char_length(notes) <= 500),
  created_by          uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint shipments_idem_key unique (tenant_id, idempotency_key)
);
create index if not exists shipments_tenant_created_idx on shipments (tenant_id, created_at desc);
create index if not exists shipments_tenant_status_idx on shipments (tenant_id, status);
create index if not exists shipments_tenant_store_idx on shipments (tenant_id, store_id, created_at desc);
create index if not exists shipments_store_idx on shipments (store_id);
create index if not exists shipments_sale_idx on shipments (sale_id) where sale_id is not null;
create index if not exists shipments_connection_idx on shipments (connection_id) where connection_id is not null;
create index if not exists shipments_provider_idx on shipments (provider_key) where provider_key is not null;
create index if not exists shipments_created_by_idx on shipments (created_by) where created_by is not null;
create index if not exists shipments_tracking_idx on shipments (tenant_id, tracking_number) where tracking_number is not null;
create index if not exists shipments_track_due_idx on shipments (next_track_at)
  where external_id is not null and deleted_at is null
    and status not in ('draft', 'quoted', 'pending', 'delivered', 'returned', 'cancelled', 'error');

drop trigger if exists set_updated_at_shipments on shipments;
create trigger set_updated_at_shipments
  before update on shipments
  for each row execute function set_updated_at();

alter table shipments enable row level security;
drop policy if exists shipments_select on shipments;
create policy shipments_select on shipments
  for select using (
    tenant_id = (select current_tenant_id())
    and store_id = any ((select user_allowed_store_ids())::uuid[])
  );
-- Sin escritura directa: shipment_create / _submit / _cancel / _retry (RPC) y
-- el worker de la Edge `shipping` (service_role).
revoke insert, update, delete on shipments from anon, authenticated;

drop trigger if exists role_write_guard on shipments;
create trigger role_write_guard before insert or update or delete on shipments
  for each row execute function trg_role_write_guard('operate');

create or replace function _shipments_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id is distinct from old.tenant_id then
      raise exception 'tenant_immutable' using errcode = '42501';
    end if;
    if new.idempotency_key is distinct from old.idempotency_key then
      raise exception 'idempotency_key_immutable' using errcode = '42501';
    end if;
  end if;
  if not exists (select 1 from stores s where s.id = new.store_id and s.tenant_id = new.tenant_id) then
    raise exception 'store_not_in_tenant' using errcode = '23514';
  end if;
  if new.sale_id is not null and (tg_op = 'INSERT' or new.sale_id is distinct from old.sale_id)
     and not exists (select 1 from sales sa where sa.id = new.sale_id and sa.tenant_id = new.tenant_id) then
    raise exception 'sale_not_in_tenant' using errcode = '23514';
  end if;
  if new.connection_id is not null and (tg_op = 'INSERT' or new.connection_id is distinct from old.connection_id)
     and not exists (select 1 from shipping_connections c where c.id = new.connection_id and c.tenant_id = new.tenant_id) then
    raise exception 'connection_not_in_tenant' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function _shipments_guard() from public, anon, authenticated;

drop trigger if exists shipments_guard on shipments;
create trigger shipments_guard
  before insert or update on shipments
  for each row execute function _shipments_guard();

comment on table shipments is
  'ADR-103: envío con una logística. Estado normalizado (lib/shipping/status.ts y _shared/shipping/status.ts), idempotency_key única por negocio. Escritura sólo por RPC o el worker.';

-- -----------------------------------------------------------------------------
-- E) Eventos (append-only)
-- -----------------------------------------------------------------------------
create table if not exists shipment_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  shipment_id       uuid not null references shipments(id) on delete cascade,
  status            text check (status is null or status in (
                      'draft', 'quoted', 'pending', 'created', 'label_ready', 'picked_up', 'in_transit',
                      'out_for_delivery', 'ready_for_pickup', 'delivered', 'failed_attempt', 'returned',
                      'cancelled', 'error')),
  carrier_status    text check (carrier_status is null or char_length(carrier_status) <= 200),
  description       text check (description is null or char_length(description) <= 500),
  location          text check (location is null or char_length(location) <= 200),
  occurred_at       timestamptz not null default now(),
  source            text not null default 'system' check (source in ('system', 'poll', 'webhook', 'manual')),
  external_event_id text check (external_event_id is null or char_length(external_event_id) <= 200),
  dedupe_key        text not null,
  raw               jsonb,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint shipment_events_dedupe unique (shipment_id, dedupe_key)
);
create index if not exists shipment_events_shipment_idx on shipment_events (shipment_id, occurred_at);
create index if not exists shipment_events_tenant_idx on shipment_events (tenant_id, created_at desc);
create index if not exists shipment_events_created_by_idx on shipment_events (created_by) where created_by is not null;

alter table shipment_events enable row level security;
drop policy if exists shipment_events_select on shipment_events;
create policy shipment_events_select on shipment_events
  for select using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from shipments s
       where s.id = shipment_events.shipment_id
         and s.store_id = any ((select user_allowed_store_ids())::uuid[])
    )
  );
revoke insert, update, delete on shipment_events from anon, authenticated;

-- Append-only: nadie edita ni borra un evento (tampoco service_role). El
-- borrado en cascada al eliminar el negocio corre como dueño de la tabla.
create or replace function _shipment_events_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' or current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'shipment_events_append_only' using errcode = '42501';
  end if;
  return old;
end;
$$;
revoke all on function _shipment_events_append_only() from public, anon, authenticated;

drop trigger if exists shipment_events_append_only on shipment_events;
create trigger shipment_events_append_only
  before update or delete on shipment_events
  for each row execute function _shipment_events_append_only();

create or replace function _shipment_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from shipments s where s.id = new.shipment_id and s.tenant_id = new.tenant_id) then
    raise exception 'shipment_not_in_tenant' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function _shipment_events_guard() from public, anon, authenticated;

drop trigger if exists shipment_events_guard on shipment_events;
create trigger shipment_events_guard
  before insert on shipment_events
  for each row execute function _shipment_events_guard();

-- -----------------------------------------------------------------------------
-- F) Cola de trabajos
-- -----------------------------------------------------------------------------
create table if not exists shipping_jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  shipment_id  uuid not null references shipments(id) on delete cascade,
  kind         text not null check (kind in ('create', 'label', 'track', 'cancel')),
  status       text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts     int not null default 0,
  max_attempts int not null default 6 check (max_attempts between 1 and 20),
  run_after    timestamptz not null default now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text check (last_error is null or char_length(last_error) <= 500),
  result       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);
-- Idempotencia: un solo trabajo vivo (pendiente o corriendo) por envío y tipo.
create unique index if not exists shipping_jobs_live_uniq
  on shipping_jobs (shipment_id, kind) where status in ('pending', 'running');
create index if not exists shipping_jobs_due_idx on shipping_jobs (run_after) where status = 'pending';
create index if not exists shipping_jobs_running_idx on shipping_jobs (locked_at) where status = 'running';
create index if not exists shipping_jobs_tenant_idx on shipping_jobs (tenant_id, created_at desc);
create index if not exists shipping_jobs_tenant_status_idx on shipping_jobs (tenant_id, status);
create index if not exists shipping_jobs_shipment_idx on shipping_jobs (shipment_id, created_at desc);

drop trigger if exists set_updated_at_shipping_jobs on shipping_jobs;
create trigger set_updated_at_shipping_jobs
  before update on shipping_jobs
  for each row execute function set_updated_at();

alter table shipping_jobs enable row level security;
drop policy if exists shipping_jobs_select on shipping_jobs;
create policy shipping_jobs_select on shipping_jobs
  for select using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from shipments s
       where s.id = shipping_jobs.shipment_id
         and s.store_id = any ((select user_allowed_store_ids())::uuid[])
    )
  );
revoke insert, update, delete on shipping_jobs from anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) Etiquetas en Storage privado
-- -----------------------------------------------------------------------------
-- Sin policies en storage.objects para este bucket: sólo service_role sube y
-- firma. La Edge valida que el usuario vea el envío antes de firmar la URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shipping-labels', 'shipping-labels', false, 10485760,
        array['application/pdf', 'text/plain', 'application/octet-stream'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
