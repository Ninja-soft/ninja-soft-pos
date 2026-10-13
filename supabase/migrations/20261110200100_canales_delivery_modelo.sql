-- =============================================================================
-- 20261110200100_canales_delivery_modelo  (F13 · H49 integraciones, ADR-102)
-- -----------------------------------------------------------------------------
-- Núcleo genérico de canales de delivery externos (PedidosYa, Rappi, Uber
-- Eats, Mercado Pago Delivery y el simulador). Extiende delivery_orders, no
-- crea un pedido paralelo:
--
--   delivery_channel_providers       catálogo de plataforma (sin tenant)
--   delivery_channel_connections     conexión por negocio y sucursal
--   delivery_channel_secrets         secreto del webhook y credenciales
--                                    (sin policies ni grants: sólo service_role)
--   delivery_channel_product_map     producto o modificador POS <-> id externo
--   delivery_channel_external_items  lo que la plataforma mandó (para sugerir
--                                    el mapeo y ver lo que falta mapear)
--   delivery_channel_orders          pedido externo (1 a 1 con delivery_orders):
--                                    canal, id externo, estado externo, tiempos,
--                                    repartidor y tracking, facturación
--   delivery_channel_events          eventos crudos entrantes, idempotentes por
--                                    (conexión, id externo del evento)
--   delivery_channel_outbox          llamadas salientes con reintentos y backoff
--   delivery_channel_settlements     comisión y liquidación por pedido
--   delivery_channel_sim_orders      "plataforma" del simulador (service_role)
--
-- Además:
--   * delivery_orders.channel acepta 'app' (pedido de una app de delivery).
--   * payments.method acepta 'plataforma' (la app cobra por cuenta del local);
--     payment_method_plan_key('plataforma') = 'canales_delivery' y el trigger
--     de cash_movements no registra movimiento de caja para ese medio.
--   * trg_order_item_price acepta el permiso de sesión ninja.channel_ingest
--     (el precio de la app no es el de la lista del POS).
--
-- Reglas: tenant_id explícito en cada insert (la columna no tiene default),
-- policies con (select ...), nunca OR is_internal(), sin escritura por REST
-- (sólo RPC SECURITY DEFINER o service_role), role_write_guard en cada tabla
-- operativa e índice en cada FK.
-- =============================================================================

-- ── 0) Catálogo de proveedores ───────────────────────────────────────────────
create table if not exists delivery_channel_providers (
  key                  text primary key
                         check (key in ('pedidosya', 'rappi', 'ubereats', 'mp_delivery', 'simulador')),
  name                 text not null,
  default_flow         text not null check (default_flow in ('directo', 'indirecto')),
  supports_tracking    boolean not null default false,
  supports_settlements boolean not null default false,
  supports_menu_sync   boolean not null default false,
  supports_reconcile   boolean not null default false,
  -- true cuando el adaptador productivo está homologado (hoy sólo el simulador).
  is_available         boolean not null default false,
  sort                 smallint not null default 0
);

insert into delivery_channel_providers
  (key, name, default_flow, supports_tracking, supports_settlements, supports_menu_sync,
   supports_reconcile, is_available, sort)
values
  ('pedidosya',   'PedidosYa',             'indirecto', false, false, true,  true,  false, 1),
  ('rappi',       'Rappi',                 'directo',   true,  true,  true,  true,  false, 2),
  ('ubereats',    'Uber Eats',             'directo',   false, false, true,  false, false, 3),
  ('mp_delivery', 'Mercado Pago Delivery', 'directo',   false, false, false, false, false, 4),
  ('simulador',   'Simulador',             'directo',   true,  true,  false, true,  true,  9)
on conflict (key) do update
  set name = excluded.name,
      default_flow = excluded.default_flow,
      supports_tracking = excluded.supports_tracking,
      supports_settlements = excluded.supports_settlements,
      supports_menu_sync = excluded.supports_menu_sync,
      supports_reconcile = excluded.supports_reconcile,
      sort = excluded.sort;

alter table delivery_channel_providers enable row level security;
drop policy if exists delivery_channel_providers_read on delivery_channel_providers;
create policy delivery_channel_providers_read on delivery_channel_providers
  for select to authenticated using (true);
revoke all on delivery_channel_providers from anon;
grant select on delivery_channel_providers to authenticated;

-- ── 1) Conexiones por negocio y sucursal ─────────────────────────────────────
create table if not exists delivery_channel_connections (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  store_id             uuid not null references stores(id),
  provider             text not null references delivery_channel_providers(key),
  label                text not null default '' check (char_length(label) <= 80),
  -- Id del local en la plataforma (vendor / store id). El simulador genera uno.
  external_store_id    text not null check (char_length(btrim(external_store_id)) between 1 and 120),
  status               text not null default 'pendiente'
                         check (status in ('pendiente', 'activa', 'pausada', 'error')),
  -- directo: se acepta desde NinjaSoft; indirecto: se acepta en la tablet de la
  -- app y llegan sólo pedidos ya aceptados (PedidosYa recomendado).
  flow                 text not null default 'directo' check (flow in ('directo', 'indirecto')),
  auto_accept          boolean not null default false,
  default_prep_minutes smallint not null default 20 check (default_prep_minutes between 1 and 180),
  billing_mode         text not null default 'manual' check (billing_mode in ('auto', 'manual')),
  -- Comisión estimada (para la conciliación); la real llega en la liquidación.
  commission_pct       numeric(5,2) not null default 0 check (commission_pct between 0 and 100),
  last_event_at        timestamptz,
  last_reconciled_at   timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  created_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
-- Un local de la plataforma pertenece a una sola conexión viva.
create unique index if not exists delivery_channel_connections_ext_uidx
  on delivery_channel_connections (provider, external_store_id) where deleted_at is null;
create index if not exists delivery_channel_connections_tenant_idx
  on delivery_channel_connections (tenant_id, created_at desc);
create index if not exists delivery_channel_connections_store_idx
  on delivery_channel_connections (store_id);
create index if not exists delivery_channel_connections_provider_idx
  on delivery_channel_connections (provider);
create index if not exists delivery_channel_connections_created_by_idx
  on delivery_channel_connections (created_by) where created_by is not null;

drop trigger if exists set_updated_at_delivery_channel_connections on delivery_channel_connections;
create trigger set_updated_at_delivery_channel_connections
  before update on delivery_channel_connections
  for each row execute function set_updated_at();

-- ── 2) Secretos (sólo service_role) ──────────────────────────────────────────
create table if not exists delivery_channel_secrets (
  connection_id  uuid primary key references delivery_channel_connections(id) on delete cascade,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  -- Secreto con el que la plataforma (o el simulador) firma el webhook.
  webhook_secret text not null,
  -- Credenciales de la API de la plataforma (client id/secret, tokens). Nunca
  -- vuelven al navegador.
  credentials    jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);
create index if not exists delivery_channel_secrets_tenant_idx on delivery_channel_secrets (tenant_id);
alter table delivery_channel_secrets enable row level security;
revoke all on delivery_channel_secrets from public, anon, authenticated;

-- ── 3) Pedido externo (extiende delivery_orders) ─────────────────────────────
create table if not exists delivery_channel_orders (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  delivery_order_id     uuid not null unique references delivery_orders(id) on delete cascade,
  connection_id         uuid not null references delivery_channel_connections(id),
  store_id              uuid not null references stores(id),
  provider              text not null,
  -- Marca que ve el local (el simulador imita PedidosYa, Rappi o Uber Eats).
  brand                 text not null check (brand in ('pedidosya', 'rappi', 'ubereats', 'mp_delivery', 'simulador')),
  external_order_id     text not null check (char_length(external_order_id) between 1 and 120),
  external_display_code text,
  external_status       text not null default 'nuevo'
                          check (external_status in ('nuevo', 'aceptado', 'rechazado', 'listo',
                                                     'retirado', 'entregado', 'cancelado')),
  -- plataforma: reparte la app; propia: reparte el local.
  logistics             text not null default 'plataforma' check (logistics in ('plataforma', 'propia')),
  -- prepago: lo cobró la app; efectivo: lo cobra el repartidor del local.
  payment_mode          text not null default 'prepago' check (payment_mode in ('prepago', 'efectivo')),
  currency              text not null default 'ARS',
  subtotal              numeric(12,2) not null default 0,
  platform_discount     numeric(12,2) not null default 0,
  store_discount        numeric(12,2) not null default 0,
  delivery_fee          numeric(12,2) not null default 0,
  total                 numeric(12,2) not null default 0,
  placed_at             timestamptz not null default now(),
  accept_deadline_at    timestamptz,
  accepted_at           timestamptz,
  prep_minutes          smallint,
  ready_at              timestamptz,
  picked_up_at          timestamptz,
  delivered_at          timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,
  reject_reason         text,
  -- Repartidor (lo informa la plataforma): último estado, se pisa.
  courier_name          text,
  courier_phone         text,
  courier_status        text,
  courier_lat           numeric(9,6),
  courier_lng           numeric(9,6),
  courier_eta_at        timestamptz,
  tracking_url          text,
  courier_updated_at    timestamptz,
  -- Ítems que no se pudieron mapear a un producto (se cocinan igual).
  needs_review          boolean not null default false,
  -- Facturación: pendiente (falta facturar), facturado, no_facturar (cerrado sin
  -- factura por el dueño), anulado (venta anulada con nota de crédito), error.
  billing_status        text not null default 'pendiente'
                          check (billing_status in ('pendiente', 'facturado', 'no_facturar', 'anulado', 'error')),
  billing_error         text,
  billed_at             timestamptz,
  sale_id               uuid references sales(id) on delete set null,
  -- Última llamada saliente que falló (se ve en el tablero).
  sync_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- Idempotencia: un pedido externo por conexión.
create unique index if not exists delivery_channel_orders_ext_uidx
  on delivery_channel_orders (connection_id, external_order_id);
create index if not exists delivery_channel_orders_tenant_idx
  on delivery_channel_orders (tenant_id, created_at desc);
create index if not exists delivery_channel_orders_store_idx
  on delivery_channel_orders (store_id, created_at desc);
create index if not exists delivery_channel_orders_open_idx
  on delivery_channel_orders (tenant_id, external_status)
  where external_status in ('nuevo', 'aceptado', 'listo', 'retirado');
create index if not exists delivery_channel_orders_billing_idx
  on delivery_channel_orders (tenant_id, billing_status)
  where billing_status in ('pendiente', 'error');
create index if not exists delivery_channel_orders_sale_idx
  on delivery_channel_orders (sale_id) where sale_id is not null;

drop trigger if exists set_updated_at_delivery_channel_orders on delivery_channel_orders;
create trigger set_updated_at_delivery_channel_orders
  before update on delivery_channel_orders
  for each row execute function set_updated_at();

-- ── 4) Mapeo de productos y modificadores ────────────────────────────────────
create table if not exists delivery_channel_product_map (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  connection_id      uuid not null references delivery_channel_connections(id) on delete cascade,
  kind               text not null default 'product' check (kind in ('product', 'modifier')),
  external_id        text not null check (char_length(btrim(external_id)) between 1 and 120),
  external_name      text,
  product_id         uuid references products(id) on delete set null,
  modifier_option_id uuid references product_modifier_options(id) on delete set null,
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  check ((kind = 'product' and modifier_option_id is null)
         or (kind = 'modifier' and product_id is null))
);
create unique index if not exists delivery_channel_product_map_uidx
  on delivery_channel_product_map (connection_id, kind, external_id) where deleted_at is null;
create index if not exists delivery_channel_product_map_tenant_idx
  on delivery_channel_product_map (tenant_id, connection_id);
create index if not exists delivery_channel_product_map_conn_idx
  on delivery_channel_product_map (connection_id);
create index if not exists delivery_channel_product_map_product_idx
  on delivery_channel_product_map (product_id) where product_id is not null;
create index if not exists delivery_channel_product_map_option_idx
  on delivery_channel_product_map (modifier_option_id) where modifier_option_id is not null;
create index if not exists delivery_channel_product_map_created_by_idx
  on delivery_channel_product_map (created_by) where created_by is not null;

drop trigger if exists set_updated_at_delivery_channel_product_map on delivery_channel_product_map;
create trigger set_updated_at_delivery_channel_product_map
  before update on delivery_channel_product_map
  for each row execute function set_updated_at();

-- ── 5) Ítems vistos en la plataforma (catálogo externo observado) ────────────
create table if not exists delivery_channel_external_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null references delivery_channel_connections(id) on delete cascade,
  kind          text not null default 'product' check (kind in ('product', 'modifier')),
  external_id   text not null,
  name          text not null,
  sku           text,
  last_price    numeric(12,2),
  seen_count    integer not null default 1,
  last_seen_at  timestamptz not null default now(),
  unique (connection_id, kind, external_id)
);
create index if not exists delivery_channel_external_items_tenant_idx
  on delivery_channel_external_items (tenant_id, connection_id);

-- ── 6) Eventos entrantes crudos (inbox) ──────────────────────────────────────
create table if not exists delivery_channel_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  connection_id     uuid not null references delivery_channel_connections(id) on delete cascade,
  external_event_id text not null check (char_length(external_event_id) between 1 and 200),
  event_type        text not null,
  external_order_id text,
  source            text not null default 'webhook' check (source in ('webhook', 'reconciliacion', 'simulador')),
  payload           jsonb not null,
  status            text not null default 'pendiente'
                      check (status in ('pendiente', 'procesado', 'ignorado', 'error')),
  attempts          smallint not null default 0,
  error             text,
  channel_order_id  uuid references delivery_channel_orders(id) on delete set null,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  -- Idempotencia del webhook: el mismo evento entra una sola vez.
  unique (connection_id, external_event_id)
);
create index if not exists delivery_channel_events_tenant_idx
  on delivery_channel_events (tenant_id, received_at desc);
create index if not exists delivery_channel_events_pending_idx
  on delivery_channel_events (status, received_at) where status in ('pendiente', 'error');
create index if not exists delivery_channel_events_order_idx
  on delivery_channel_events (channel_order_id) where channel_order_id is not null;
create index if not exists delivery_channel_events_ext_order_idx
  on delivery_channel_events (connection_id, external_order_id) where external_order_id is not null;

-- ── 7) Llamadas salientes (outbox) ───────────────────────────────────────────
create table if not exists delivery_channel_outbox (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  connection_id    uuid not null references delivery_channel_connections(id) on delete cascade,
  channel_order_id uuid references delivery_channel_orders(id) on delete cascade,
  action           text not null
                     check (action in ('accept', 'reject', 'mark_ready', 'mark_picked_up',
                                       'sync_menu', 'toggle_store')),
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pendiente'
                     check (status in ('pendiente', 'enviando', 'ok', 'error', 'descartado')),
  attempts         smallint not null default 0,
  max_attempts     smallint not null default 8,
  next_attempt_at  timestamptz not null default now(),
  claimed_at       timestamptz,
  last_error       text,
  response         jsonb,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  done_at          timestamptz
);
create index if not exists delivery_channel_outbox_tenant_idx
  on delivery_channel_outbox (tenant_id, created_at desc);
create index if not exists delivery_channel_outbox_due_idx
  on delivery_channel_outbox (next_attempt_at) where status in ('pendiente', 'enviando');
create index if not exists delivery_channel_outbox_conn_idx
  on delivery_channel_outbox (connection_id);
create index if not exists delivery_channel_outbox_order_idx
  on delivery_channel_outbox (channel_order_id) where channel_order_id is not null;
create index if not exists delivery_channel_outbox_created_by_idx
  on delivery_channel_outbox (created_by) where created_by is not null;

drop trigger if exists set_updated_at_delivery_channel_outbox on delivery_channel_outbox;
create trigger set_updated_at_delivery_channel_outbox
  before update on delivery_channel_outbox
  for each row execute function set_updated_at();

-- ── 8) Comisiones y liquidaciones por pedido ─────────────────────────────────
create table if not exists delivery_channel_settlements (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  connection_id       uuid not null references delivery_channel_connections(id) on delete cascade,
  channel_order_id    uuid references delivery_channel_orders(id) on delete set null,
  -- estimado: con el % de la conexión al recibir el pedido; liquidado: lo que
  -- informó la plataforma (API financiera o import del portal).
  kind                text not null check (kind in ('estimado', 'liquidado')),
  external_payment_id text,
  period_from         date,
  period_to           date,
  gross               numeric(12,2) not null default 0,
  commission          numeric(12,2) not null default 0,
  commission_vat      numeric(12,2) not null default 0,
  platform_discount   numeric(12,2) not null default 0,
  ads                 numeric(12,2) not null default 0,
  adjustments         numeric(12,2) not null default 0,
  net                 numeric(12,2) not null default 0,
  currency            text not null default 'ARS',
  raw                 jsonb,
  created_at          timestamptz not null default now()
);
create unique index if not exists delivery_channel_settlements_estimate_uidx
  on delivery_channel_settlements (channel_order_id) where kind = 'estimado';
create index if not exists delivery_channel_settlements_tenant_idx
  on delivery_channel_settlements (tenant_id, created_at desc);
create index if not exists delivery_channel_settlements_conn_idx
  on delivery_channel_settlements (connection_id);
create index if not exists delivery_channel_settlements_order_idx
  on delivery_channel_settlements (channel_order_id) where channel_order_id is not null;

-- ── 9) "Plataforma" del simulador (sólo service_role) ────────────────────────
-- Pedidos que la plataforma simulada tiene; el reconciliador los consulta
-- (fetchRecentOrders) como haría con la API real. Un pedido "con webhook
-- perdido" sólo existe acá hasta que el cron lo recupera.
create table if not exists delivery_channel_sim_orders (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  connection_id     uuid not null references delivery_channel_connections(id) on delete cascade,
  external_order_id text not null,
  payload           jsonb not null,
  platform_status   text not null default 'nuevo',
  webhook_sent      boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (connection_id, external_order_id)
);
create index if not exists delivery_channel_sim_orders_tenant_idx
  on delivery_channel_sim_orders (tenant_id, created_at desc);
alter table delivery_channel_sim_orders enable row level security;
revoke all on delivery_channel_sim_orders from public, anon, authenticated;

-- ── 10) RLS: lectura por negocio, sin escritura por REST ─────────────────────
alter table delivery_channel_connections    enable row level security;
alter table delivery_channel_orders         enable row level security;
alter table delivery_channel_product_map    enable row level security;
alter table delivery_channel_external_items enable row level security;
alter table delivery_channel_events         enable row level security;
alter table delivery_channel_outbox         enable row level security;
alter table delivery_channel_settlements    enable row level security;

-- Conexiones, pedidos y estado de la cola: cualquier miembro del negocio (el
-- cajero ve el canal, el repartidor y si la app confirmó).
drop policy if exists delivery_channel_connections_select on delivery_channel_connections;
create policy delivery_channel_connections_select on delivery_channel_connections
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists delivery_channel_orders_select on delivery_channel_orders;
create policy delivery_channel_orders_select on delivery_channel_orders
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists delivery_channel_outbox_select on delivery_channel_outbox;
create policy delivery_channel_outbox_select on delivery_channel_outbox
  for select using (tenant_id = (select current_tenant_id()));
-- Mapeo, catálogo externo, eventos crudos y liquidaciones: dueño o encargado.
drop policy if exists delivery_channel_product_map_select on delivery_channel_product_map;
create policy delivery_channel_product_map_select on delivery_channel_product_map
  for select using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
drop policy if exists delivery_channel_external_items_select on delivery_channel_external_items;
create policy delivery_channel_external_items_select on delivery_channel_external_items
  for select using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
drop policy if exists delivery_channel_events_select on delivery_channel_events;
create policy delivery_channel_events_select on delivery_channel_events
  for select using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
drop policy if exists delivery_channel_settlements_select on delivery_channel_settlements;
create policy delivery_channel_settlements_select on delivery_channel_settlements
  for select using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));

revoke insert, update, delete on delivery_channel_connections, delivery_channel_orders,
  delivery_channel_product_map, delivery_channel_external_items, delivery_channel_events,
  delivery_channel_outbox, delivery_channel_settlements from anon, authenticated;
grant select on delivery_channel_connections, delivery_channel_orders,
  delivery_channel_product_map, delivery_channel_external_items, delivery_channel_events,
  delivery_channel_outbox, delivery_channel_settlements to authenticated;

-- role_write_guard (ADR-071): solo lectura nunca escribe, ni a través de RPC.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('delivery_channel_connections', 'manage'),
      ('delivery_channel_product_map', 'manage'),
      ('delivery_channel_external_items', 'operate'),
      ('delivery_channel_orders', 'operate'),
      ('delivery_channel_events', 'operate'),
      ('delivery_channel_outbox', 'operate'),
      ('delivery_channel_settlements', 'manage')
    ) as t(tbl, mode)
  loop
    execute format('drop trigger if exists role_write_guard on public.%I', r.tbl);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', r.tbl, r.mode);
  end loop;
end;
$$;

-- ── 11) delivery_orders.channel: + 'app' ─────────────────────────────────────
alter table delivery_orders drop constraint if exists delivery_orders_channel_check;
alter table delivery_orders
  add constraint delivery_orders_channel_check
  check (channel in ('mostrador', 'telefono', 'whatsapp', 'qr', 'delivery_propio', 'app'));

-- ── 12) Medio de pago 'plataforma' ───────────────────────────────────────────
-- Lista copiada de 20261108200000_create_sale_deudas (la última) + 'plataforma'.
alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash', 'debit', 'credit', 'transfer', 'qr', 'other', 'store_credit',
                    'account', 'directo', 'sena', 'plataforma'));

-- payment_method_plan_key: copia de 20261013300000_fiserv_clover_point (la
-- última definición) + 'plataforma' -> canales_delivery. El trigger
-- payments_assert_method corta el medio sin la feature en el plan.
create or replace function payment_method_plan_key(p_method text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_method, ''))
    when 'cash'              then 'efectivo'
    when 'efectivo'          then 'efectivo'
    when 'transfer'          then 'transferencia'
    when 'transferencia'     then 'transferencia'
    when 'mercadopago'       then 'mercado_pago'
    when 'mp'                then 'mercado_pago'
    when 'mercado_pago'      then 'mercado_pago'
    when 'mercadopago_point' then 'mercadopago_point'
    when 'modo'              then 'modo'
    when 'mobbex'            then 'mobbex'
    when 'payway'            then 'payway'
    when 'payway_point'      then 'payway_point'
    when 'getnet'            then 'getnet'
    when 'getnet_point'      then 'getnet_point'
    when 'fiserv'            then 'fiserv'
    when 'fiserv_point'      then 'fiserv_point'
    when 'pagos360'          then 'pagos360'
    when 'nave'              then 'nave'
    when 'nave_point'        then 'nave_point'
    when 'gocuotas'          then 'gocuotas'
    when 'directo'           then 'directo'
    when 'account'           then 'cuenta_corriente'
    when 'cuenta_corriente'  then 'cuenta_corriente'
    when 'plataforma'        then 'canales_delivery'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;

-- La app cobra por cuenta del local: sin movimiento de caja (no entra plata al
-- cajón ni a la cuenta del turno). Un BEFORE INSERT que devuelve null descarta
-- la fila; nadie hace insert ... returning sobre este medio.
create or replace function _cash_movements_skip_platform()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.payment_method = 'plataforma' then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function _cash_movements_skip_platform() from public, anon, authenticated;

drop trigger if exists cash_movements_skip_platform on cash_movements;
create trigger cash_movements_skip_platform
  before insert on cash_movements
  for each row
  when (new.payment_method = 'plataforma')
  execute function _cash_movements_skip_platform();

-- ── 13) trg_order_item_price: + permiso de la ingesta de canales ─────────────
-- Copia de 20261109600000_gastro_r2_cuenta_por_comensal (la última definición).
-- Único cambio: el INSERT que hace la ingesta de un pedido de app (ninja.
-- channel_ingest, lo pone sólo delivery_channel_ingest_event) guarda el precio
-- que cobró la plataforma, que no es el de la lista del POS. create_sale lo
-- acepta porque valida contra el precio guardado en la línea del pedido.
create or replace function trg_order_item_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exp numeric;
begin
  -- ADR-097: copia de una línea al separar la cuenta (mismo precio ya validado).
  if tg_op = 'INSERT' and coalesce(current_setting('ninja.dining_split', true), '') = 'on' then
    return new;
  end if;
  -- ADR-102: línea de un pedido de app con el precio de la plataforma.
  if tg_op = 'INSERT' and coalesce(current_setting('ninja.channel_ingest', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.unit_price is not distinct from old.unit_price
     and new.product_id is not distinct from old.product_id
     and new.modifiers is not distinct from old.modifiers then
    return new;
  end if;
  if new.product_id is null then
    if not coalesce((_effective_config(new.tenant_id, 'pos_settings', '', null, null) -> 'value'
                     ->> 'allow_free_sale')::boolean, true) then
      raise exception 'free_sale_not_allowed';
    end if;
    return new;
  end if;
  v_exp := _resolve_unit_price(new.tenant_id, new.product_id, null, new.qty, null, null, null, now());
  if v_exp is null then raise exception 'product_not_found'; end if;
  v_exp := round(v_exp + _sale_modifier_delta(new.tenant_id, new.product_id, new.modifiers), 2);
  if abs(coalesce(new.unit_price, 0) - v_exp) > 0.01 then
    raise exception using message = 'price_mismatch:' || jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('product_id', new.product_id, 'variant_id', null,
                         'expected', v_exp, 'received', new.unit_price)))::text,
                          errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function trg_order_item_price() from public, anon, authenticated;

comment on table delivery_channel_connections is 'Conexión de un negocio y sucursal a una app de delivery (ADR-102).';
comment on table delivery_channel_orders is 'Pedido de una app de delivery; extiende delivery_orders 1 a 1 (ADR-102).';
comment on table delivery_channel_events is 'Eventos crudos entrantes de las apps, idempotentes por conexión e id externo (ADR-102).';
comment on table delivery_channel_outbox is 'Llamadas salientes a las apps con reintentos y backoff (ADR-102).';
