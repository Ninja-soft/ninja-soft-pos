-- =============================================================================
-- 20261110400100_mercadolibre_base  (H87 · ADR-104 · Mercado Libre MVP)
--
-- Modelo de datos de la integración con Mercado Libre. Pensado para las fases
-- siguientes sin rehacer (v2: Full, Flex, multi-origen, planificador de envíos
-- a Full, ME1; v3: central de promociones):
--
--   ml_accounts        N cuentas de ML por negocio (una cuenta de ML en UN
--                      solo negocio). Configuración por cuenta: precio del
--                      canal (lista o margen), facturación, etiquetas.
--   ml_tokens          access/refresh token + lock de renovación. DENY-ALL:
--                      sólo service_role (Edge Functions).
--   ml_oauth_states    state + code_verifier PKCE de un solo uso. DENY-ALL.
--   ml_location_map    qué stock del POS (sucursal / depósito, reserva de
--                      seguridad) alimenta cada ubicación de ML. MVP: una fila
--                      'item_stock' por cuenta (available_quantity del ítem o
--                      selling_address). v2: selling_address separado,
--                      seller_warehouse (multi-origen) y meli_facility (Full,
--                      sólo lectura) sin cambiar el modelo.
--   ml_notifications   inbox idempotente de las notificaciones (dedupe_key =
--                      _id de ML). El webhook sólo inserta; el worker procesa.
--   ml_sync_jobs       outbox de escrituras hacia ML con coalescing por
--                      dedupe_key (el último stock gana), backoff y dead-letter.
--   ml_rate_buckets    token bucket por (cuenta, familia de recurso).
--   ml_items           espejo de las publicaciones de la cuenta.
--   ml_item_links      vínculo publicación (y variación clásica) <-> producto
--                      o variante del POS. User Products: un vínculo por ítem.
--   ml_orders          órdenes de ML; varias órdenes de un carrito (pack)
--                      comparten la MISMA venta del POS (sale_id).
--   ml_shipments       envíos (modo, logística, estado, tracking, etiqueta).
--                      Punto de enganche de la rama de envíos (me1_tracking).
--   ml_questions       bandeja de preguntas y su respuesta.
--
-- sales.channel ('mercadolibre') y sales.channel_ref (pack) identifican las
-- ventas del canal en /ventas y reportes.
--
-- Seguridad (CLAUDE.md §3, ADR-052, ADR-071, ADR-090):
--   • tenant_id NOT NULL SIN default (P3/P8): todo insert lo pasa explícito.
--   • RLS en todas; lectura del negocio activo con "(select ...)" (initplan);
--     inbox, outbox y buckets sólo dueño o encargado. Nunca "OR is_internal()".
--   • Sin policies de escritura: escriben sólo las RPC SECURITY DEFINER y las
--     Edge con service_role. role_write_guard 'manage' en las tablas
--     operativas (solo lectura no escribe nunca, ni por una RPC).
--   • Índice en cada FK.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Ventas del canal.
-- -----------------------------------------------------------------------------
alter table sales add column if not exists channel text
  check (channel is null or channel ~ '^[a-z_]{2,30}$');
alter table sales add column if not exists channel_ref text
  check (channel_ref is null or char_length(channel_ref) <= 64);
comment on column sales.channel is
  'ADR-104: canal externo de la venta (mercadolibre). null = POS (mostrador, salón, delivery...).';
comment on column sales.channel_ref is
  'ADR-104: referencia del canal (Mercado Libre: pack_id o, sin carrito, order_id).';
create index if not exists sales_tenant_channel_idx
  on sales (tenant_id, channel, created_at desc) where channel is not null;

-- -----------------------------------------------------------------------------
-- B) Cuentas.
-- -----------------------------------------------------------------------------
create table if not exists ml_accounts (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  ml_user_id            bigint not null check (ml_user_id > 0),
  nickname              text not null default '' check (char_length(nickname) <= 120),
  site_id               text not null default 'MLA' check (site_id ~ '^[A-Z]{3}$'),
  tags                  text[] not null default '{}',
  user_product_seller   boolean not null default false,
  status                text not null default 'active'
                          check (status in ('active', 'reauth_required', 'disconnected')),
  status_reason         text check (status_reason is null or char_length(status_reason) <= 500),
  -- Precio del canal: lista de precios propia de ML o margen sobre el precio POS.
  price_list_id         uuid references price_lists(id) on delete set null,
  price_markup_pct      numeric(7,2) not null default 0 check (price_markup_pct between -90 and 500),
  price_rounding        numeric(12,2) not null default 0 check (price_rounding >= 0),
  price_sync            boolean not null default true,
  stock_sync            boolean not null default true,
  -- Facturación: al pagarse, al despacharse, a mano, o la emite el
  -- Facturador de ML (v3; el POS no encola ARCA) o ninguna.
  invoice_mode          text not null default 'manual'
                          check (invoice_mode in ('on_paid', 'on_shipped', 'manual', 'ml_billing', 'none')),
  upload_invoice        boolean not null default true,
  default_listing_type  text not null default 'gold_special'
                          check (default_listing_type ~ '^[a-z_]{2,30}$'),
  label_format          text not null default 'pdf' check (label_format in ('pdf', 'zpl2')),
  connected_by          uuid references public.users(id) on delete set null,
  connected_at          timestamptz not null default now(),
  last_sync_at          timestamptz,
  last_orders_poll_at   timestamptz,
  last_error            text check (last_error is null or char_length(last_error) <= 500),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
comment on table ml_accounts is
  'Cuentas de Mercado Libre conectadas por negocio (ADR-104). Una cuenta de ML no puede estar en dos negocios.';

-- Una cuenta de ML en un solo negocio (vigente).
create unique index if not exists ml_accounts_ml_user_uq
  on ml_accounts (ml_user_id) where deleted_at is null;
create index if not exists ml_accounts_tenant_idx on ml_accounts (tenant_id, created_at);
create index if not exists ml_accounts_price_list_idx on ml_accounts (price_list_id) where price_list_id is not null;
create index if not exists ml_accounts_connected_by_idx on ml_accounts (connected_by) where connected_by is not null;

drop trigger if exists set_updated_at_ml_accounts on ml_accounts;
create trigger set_updated_at_ml_accounts before update on ml_accounts
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- C) Tokens y estados OAuth (DENY-ALL: sólo service_role).
-- -----------------------------------------------------------------------------
create table if not exists ml_tokens (
  account_id          uuid primary key references ml_accounts(id) on delete cascade,
  tenant_id           uuid not null references tenants(id) on delete cascade,
  access_token        text not null,
  refresh_token       text,
  scope               text,
  expires_at          timestamptz not null,
  refresh_lock_until  timestamptz,
  refresh_lock_id     uuid,
  last_refresh_at     timestamptz,
  refresh_count       integer not null default 0,
  last_error          text,
  updated_at          timestamptz not null default now()
);
create index if not exists ml_tokens_tenant_idx on ml_tokens (tenant_id);
create index if not exists ml_tokens_expires_idx on ml_tokens (expires_at);
comment on table ml_tokens is
  'Tokens OAuth de Mercado Libre (ADR-104). Sin policies ni grants: sólo service_role. El refresh es de un solo uso: se renueva con lock (ml_token_lock).';

create table if not exists ml_oauth_states (
  state          text primary key check (state ~ '^[0-9a-f]{64}$'),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  code_verifier  text not null check (char_length(code_verifier) between 43 and 128),
  reconnect_id   uuid references ml_accounts(id) on delete cascade,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '15 minutes'
);
create index if not exists ml_oauth_states_tenant_idx on ml_oauth_states (tenant_id);
create index if not exists ml_oauth_states_user_idx on ml_oauth_states (user_id);
create index if not exists ml_oauth_states_reconnect_idx on ml_oauth_states (reconnect_id) where reconnect_id is not null;

-- -----------------------------------------------------------------------------
-- D) Origen del stock por ubicación de ML.
-- -----------------------------------------------------------------------------
create table if not exists ml_location_map (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  account_id        uuid not null references ml_accounts(id) on delete cascade,
  -- item_stock: available_quantity del ítem (o selling_address si la cuenta
  -- convive con Full). v2: selling_address, seller_warehouse, meli_facility.
  location_type     text not null default 'item_stock'
                      check (location_type in ('item_stock', 'selling_address', 'seller_warehouse', 'meli_facility')),
  ml_store_id       text check (ml_store_id is null or char_length(ml_store_id) <= 64),
  ml_network_node   text check (ml_network_node is null or char_length(ml_network_node) <= 64),
  store_id          uuid references stores(id) on delete set null,
  warehouse_id      uuid references warehouses(id) on delete set null,
  reserve_qty       numeric(12,3) not null default 0 check (reserve_qty >= 0),
  push_enabled      boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ml_location_map_uq
  on ml_location_map (account_id, location_type, coalesce(ml_store_id, ''));
create index if not exists ml_location_map_tenant_idx on ml_location_map (tenant_id);
create index if not exists ml_location_map_store_idx on ml_location_map (store_id) where store_id is not null;
create index if not exists ml_location_map_warehouse_idx on ml_location_map (warehouse_id) where warehouse_id is not null;
drop trigger if exists set_updated_at_ml_location_map on ml_location_map;
create trigger set_updated_at_ml_location_map before update on ml_location_map
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- E) Inbox de notificaciones.
-- -----------------------------------------------------------------------------
create table if not exists ml_notifications (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  account_id       uuid not null references ml_accounts(id) on delete cascade,
  dedupe_key       text not null check (char_length(dedupe_key) <= 400),
  notification_id  text,
  source           text not null default 'webhook' check (source in ('webhook', 'missed_feeds', 'poll', 'manual')),
  topic            text not null check (char_length(topic) <= 60),
  resource         text not null check (char_length(resource) <= 300),
  ml_user_id       bigint not null,
  actions          text[] not null default '{}',
  attempts         integer not null default 0,
  sent_at          timestamptz,
  received_at      timestamptz not null default now(),
  status           text not null default 'pending'
                     check (status in ('pending', 'processing', 'done', 'ignored', 'error', 'dead')),
  tries            integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  locked_until     timestamptz,
  processed_at     timestamptz,
  last_error       text check (last_error is null or char_length(last_error) <= 500),
  constraint ml_notifications_dedupe_key unique (dedupe_key)
);
create index if not exists ml_notifications_queue_idx
  on ml_notifications (next_attempt_at) where status in ('pending', 'error');
create index if not exists ml_notifications_tenant_idx on ml_notifications (tenant_id, received_at desc);
create index if not exists ml_notifications_account_idx on ml_notifications (account_id, status);
create index if not exists ml_notifications_resource_idx on ml_notifications (account_id, topic, resource);

-- -----------------------------------------------------------------------------
-- F) Outbox de escrituras hacia ML.
-- -----------------------------------------------------------------------------
create table if not exists ml_sync_jobs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  account_id       uuid not null references ml_accounts(id) on delete cascade,
  kind             text not null check (kind in ('stock_push', 'price_push', 'item_status', 'item_refresh',
                                                 'invoice_upload', 'answer_question', 'me1_tracking',
                                                 'order_refresh', 'item_publish')),
  dedupe_key       text not null check (char_length(dedupe_key) <= 300),
  ref              text check (ref is null or char_length(ref) <= 120),
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending'
                     check (status in ('pending', 'running', 'done', 'error', 'dead', 'cancelled')),
  attempts         integer not null default 0,
  max_attempts     integer not null default 8 check (max_attempts between 1 and 30),
  next_attempt_at  timestamptz not null default now(),
  locked_until     timestamptz,
  last_error       text check (last_error is null or char_length(last_error) <= 500),
  result           jsonb,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- Coalescing: a lo sumo un pendiente por clave (el último valor gana).
create unique index if not exists ml_sync_jobs_pending_uq
  on ml_sync_jobs (dedupe_key) where status = 'pending';
create index if not exists ml_sync_jobs_queue_idx
  on ml_sync_jobs (next_attempt_at) where status in ('pending', 'error');
create index if not exists ml_sync_jobs_tenant_idx on ml_sync_jobs (tenant_id, created_at desc);
create index if not exists ml_sync_jobs_account_idx on ml_sync_jobs (account_id, status);
create index if not exists ml_sync_jobs_created_by_idx on ml_sync_jobs (created_by) where created_by is not null;
drop trigger if exists set_updated_at_ml_sync_jobs on ml_sync_jobs;
create trigger set_updated_at_ml_sync_jobs before update on ml_sync_jobs
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- G) Límite de llamadas por cuenta y familia de recurso.
-- -----------------------------------------------------------------------------
create table if not exists ml_rate_buckets (
  account_id     uuid not null references ml_accounts(id) on delete cascade,
  family         text not null check (family ~ '^[a-z_]{2,30}$'),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  tokens         numeric(10,3) not null,
  refilled_at    timestamptz not null default now(),
  blocked_until  timestamptz,
  primary key (account_id, family)
);
create index if not exists ml_rate_buckets_tenant_idx on ml_rate_buckets (tenant_id);

-- -----------------------------------------------------------------------------
-- H) Publicaciones y vínculos.
-- -----------------------------------------------------------------------------
create table if not exists ml_items (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  account_id          uuid not null references ml_accounts(id) on delete cascade,
  ml_item_id          text not null check (ml_item_id ~ '^[A-Z]{3}\d{4,16}$'),
  user_product_id     text check (user_product_id is null or char_length(user_product_id) <= 40),
  family_id           text check (family_id is null or char_length(family_id) <= 40),
  title               text not null default '' check (char_length(title) <= 300),
  category_id         text check (category_id is null or char_length(category_id) <= 40),
  listing_type_id     text check (listing_type_id is null or char_length(listing_type_id) <= 40),
  status              text not null default 'active' check (char_length(status) <= 40),
  sub_status          text[] not null default '{}',
  tags                text[] not null default '{}',
  logistic_type       text check (logistic_type is null or char_length(logistic_type) <= 40),
  shipping_mode       text check (shipping_mode is null or char_length(shipping_mode) <= 20),
  free_shipping       boolean not null default false,
  catalog_listing     boolean not null default false,
  catalog_product_id  text check (catalog_product_id is null or char_length(catalog_product_id) <= 40),
  permalink           text check (permalink is null or char_length(permalink) <= 500),
  thumbnail           text check (thumbnail is null or char_length(thumbnail) <= 500),
  currency            text not null default 'ARS',
  price               numeric(14,2),
  available_quantity  integer,
  sold_quantity       integer,
  has_variations      boolean not null default false,
  health              numeric(5,2),
  -- pos: el precio sale del POS (lista o margen); manual: el de la
  -- publicación; automation: lo maneja la automatización de ML (no se pisa).
  price_source        text not null default 'pos' check (price_source in ('pos', 'manual', 'automation')),
  stock_mode          text check (stock_mode is null or stock_mode in
                        ('item', 'item_variations', 'selling_address', 'seller_warehouse', 'full_only')),
  last_pushed_qty     integer,
  last_pushed_price   numeric(14,2),
  last_pushed_at      timestamptz,
  last_error          text check (last_error is null or char_length(last_error) <= 500),
  synced_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create unique index if not exists ml_items_account_item_uq on ml_items (account_id, ml_item_id);
create index if not exists ml_items_tenant_idx on ml_items (tenant_id, status);
create index if not exists ml_items_tenant_created_idx on ml_items (tenant_id, created_at desc);
create index if not exists ml_items_up_idx on ml_items (account_id, user_product_id) where user_product_id is not null;
drop trigger if exists set_updated_at_ml_items on ml_items;
create trigger set_updated_at_ml_items before update on ml_items
  for each row execute function set_updated_at();

create table if not exists ml_item_links (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  account_id       uuid not null references ml_accounts(id) on delete cascade,
  item_id          uuid not null references ml_items(id) on delete cascade,
  ml_variation_id  bigint,
  product_id       uuid not null references products(id) on delete cascade,
  variant_id       uuid references product_variants(id) on delete cascade,
  linked_by        text not null default 'manual' check (linked_by in ('manual', 'sku', 'gtin', 'publish')),
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
create unique index if not exists ml_item_links_item_var_uq
  on ml_item_links (item_id, coalesce(ml_variation_id, 0));
create index if not exists ml_item_links_tenant_idx on ml_item_links (tenant_id);
create index if not exists ml_item_links_account_idx on ml_item_links (account_id);
create index if not exists ml_item_links_product_idx on ml_item_links (product_id, variant_id);
create index if not exists ml_item_links_variant_idx on ml_item_links (variant_id) where variant_id is not null;
create index if not exists ml_item_links_created_by_idx on ml_item_links (created_by) where created_by is not null;

-- -----------------------------------------------------------------------------
-- I) Órdenes, envíos y preguntas.
-- -----------------------------------------------------------------------------
create table if not exists ml_orders (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  account_id         uuid not null references ml_accounts(id) on delete cascade,
  ml_order_id        bigint not null,
  pack_key           text not null check (char_length(pack_key) <= 30),
  pack_id            bigint,
  status             text not null check (char_length(status) <= 40),
  status_detail      text,
  tags               text[] not null default '{}',
  date_created       timestamptz,
  date_closed        timestamptz,
  ml_last_updated    timestamptz,
  total_amount       numeric(14,2) not null default 0,
  paid_amount        numeric(14,2) not null default 0,
  currency           text not null default 'ARS',
  sale_fee_total     numeric(14,2) not null default 0,
  shipping_cost      numeric(14,2),
  buyer_id           bigint,
  buyer_nickname     text,
  shipment_id        bigint,
  fraud_risk         boolean not null default false,
  cancel_detail      jsonb,
  lines              jsonb not null default '[]'::jsonb,
  unlinked_lines     integer not null default 0,
  sale_id            uuid references sales(id) on delete set null,
  stock_applied_at   timestamptz,
  stock_reverted_at  timestamptz,
  needs_review       text check (needs_review is null or char_length(needs_review) <= 300),
  invoice_status     text not null default 'none'
                       check (invoice_status in ('none', 'pending', 'queued', 'approved', 'uploaded', 'error', 'not_applicable')),
  fiscal_document_id uuid references fiscal_documents(id) on delete set null,
  ml_fiscal_doc_id   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists ml_orders_account_order_uq on ml_orders (account_id, ml_order_id);
create index if not exists ml_orders_tenant_created_idx on ml_orders (tenant_id, date_created desc);
create index if not exists ml_orders_tenant_status_idx on ml_orders (tenant_id, status);
create index if not exists ml_orders_pack_idx on ml_orders (account_id, pack_key);
create index if not exists ml_orders_sale_idx on ml_orders (sale_id) where sale_id is not null;
create index if not exists ml_orders_fiscal_idx on ml_orders (fiscal_document_id) where fiscal_document_id is not null;
create index if not exists ml_orders_shipment_idx on ml_orders (account_id, shipment_id) where shipment_id is not null;
drop trigger if exists set_updated_at_ml_orders on ml_orders;
create trigger set_updated_at_ml_orders before update on ml_orders
  for each row execute function set_updated_at();

create table if not exists ml_shipments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  account_id         uuid not null references ml_accounts(id) on delete cascade,
  shipment_id        bigint not null,
  pack_key           text,
  mode               text,
  logistic_type      text,
  status             text not null default 'pending',
  substatus          text,
  tracking_number    text,
  tracking_method    text,
  cost               numeric(14,2),
  city               text,
  state              text,
  zip                text,
  date_created       timestamptz,
  label_printed_at   timestamptz,
  label_print_count  integer not null default 0,
  -- Punto de enganche de la rama de envíos (ME1, Flex): tracking informado.
  me1_tracking       jsonb,
  synced_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists ml_shipments_account_shipment_uq on ml_shipments (account_id, shipment_id);
create index if not exists ml_shipments_tenant_status_idx on ml_shipments (tenant_id, status, substatus);
create index if not exists ml_shipments_tenant_created_idx on ml_shipments (tenant_id, created_at desc);
drop trigger if exists set_updated_at_ml_shipments on ml_shipments;
create trigger set_updated_at_ml_shipments before update on ml_shipments
  for each row execute function set_updated_at();

create table if not exists ml_questions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  account_id       uuid not null references ml_accounts(id) on delete cascade,
  question_id      bigint not null,
  ml_item_id       text not null,
  item_row_id      uuid references ml_items(id) on delete set null,
  text             text not null check (char_length(text) <= 2000),
  status           text not null check (char_length(status) <= 40),
  date_created     timestamptz,
  from_id          bigint,
  answer_text      text check (answer_text is null or char_length(answer_text) <= 2000),
  answer_date      timestamptz,
  answer_state     text not null default 'none' check (answer_state in ('none', 'sending', 'sent', 'error')),
  answered_by      uuid references public.users(id) on delete set null,
  last_error       text check (last_error is null or char_length(last_error) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists ml_questions_account_question_uq on ml_questions (account_id, question_id);
create index if not exists ml_questions_tenant_status_idx on ml_questions (tenant_id, status, date_created desc);
create index if not exists ml_questions_tenant_created_idx on ml_questions (tenant_id, created_at desc);
create index if not exists ml_questions_item_idx on ml_questions (item_row_id) where item_row_id is not null;
create index if not exists ml_questions_answered_by_idx on ml_questions (answered_by) where answered_by is not null;
drop trigger if exists set_updated_at_ml_questions on ml_questions;
create trigger set_updated_at_ml_questions before update on ml_questions
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- J) RLS.
-- -----------------------------------------------------------------------------
alter table ml_accounts      enable row level security;
alter table ml_tokens        enable row level security;
alter table ml_oauth_states  enable row level security;
alter table ml_location_map  enable row level security;
alter table ml_notifications enable row level security;
alter table ml_sync_jobs     enable row level security;
alter table ml_rate_buckets  enable row level security;
alter table ml_items         enable row level security;
alter table ml_item_links    enable row level security;
alter table ml_orders        enable row level security;
alter table ml_shipments     enable row level security;
alter table ml_questions     enable row level security;

-- Secretos: ni lectura ni escritura para clientes.
revoke all on ml_tokens, ml_oauth_states, ml_rate_buckets from anon, authenticated;

-- Lectura del negocio activo (cualquier miembro activo; el negocio sale del JWT).
do $$
declare
  t text;
begin
  foreach t in array array['ml_accounts', 'ml_location_map', 'ml_items', 'ml_item_links',
                           'ml_orders', 'ml_shipments', 'ml_questions'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (tenant_id = (select current_tenant_id()))',
      t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  -- Diagnóstico de la cola: sólo dueño o encargado.
  foreach t in array array['ml_notifications', 'ml_sync_jobs'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))',
      t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end;
$$;
revoke all on ml_notifications, ml_sync_jobs, ml_accounts, ml_location_map, ml_items, ml_item_links,
              ml_orders, ml_shipments, ml_questions from anon;

-- Permisos por rol (ADR-071): nadie escribe por REST; solo lectura tampoco por RPC.
do $$
declare
  t text;
begin
  foreach t in array array['ml_accounts', 'ml_location_map', 'ml_items', 'ml_item_links',
                           'ml_orders', 'ml_shipments', 'ml_questions', 'ml_sync_jobs'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
end;
$$;
