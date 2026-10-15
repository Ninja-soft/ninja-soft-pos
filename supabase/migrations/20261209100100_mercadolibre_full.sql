-- =============================================================================
-- 20261209100100_mercadolibre_full  (ADR-142 · Mercado Libre Full)
--
-- Full (fulfillment) de Mercado Libre: ML guarda la mercadería del vendedor
-- en sus centros y despacha cada venta. El POS lo modela así:
--
--   ml_full_inventory       DEPÓSITO VIRTUAL "Mercado Libre Full" por cuenta:
--                           una fila por inventory_id (el código con el que ML
--                           identifica el producto dentro de Full; uno por
--                           publicación o por variación). Espejo de
--                           GET /inventories/{id}/stock/fulfillment:
--                           disponible, no disponible por motivo (dañado,
--                           perdido, retiro, proceso interno, transferencia,
--                           sin cobertura fiscal, no procesable) y condiciones.
--                           ML es la fuente de verdad: se sincroniza, no se
--                           edita a mano.
--   ml_full_stock_ops       Espejo de /stock/fulfillment/operations/search
--                           (ingresos, ventas, cancelaciones, retiros...):
--                           ventas por día para la cobertura y la recepción
--                           real de cada envío (INBOUND_RECEPTION con
--                           external_references inbound_id).
--   ml_full_inbounds        "Transferencia a Full": productos y cantidades
--   ml_full_inbound_items   que salen de un depósito propio. Estados: borrador
--                           -> en tránsito (sale del stock propio) -> recibido
--                           parcial -> recibido / cerrado con diferencias, o
--                           cancelado. La API pública de ML no permite crear el
--                           envío (inbound): se arma en Mercado Libre y acá se
--                           registra su número.
--   ml_full_costs           Cargos de Full del resumen de facturación de ML
--                           (almacenamiento, retiro, descarte) por período.
--
-- Reglas de stock (por qué NO es un depósito de ADR-085):
--   • Un depósito de ADR-085 es un desglose del stock de la sucursal: lo que
--     está ahí se puede vender en el mostrador. Lo de Full no: está en el
--     centro de ML y sólo lo vende ML. Por eso vive fuera de product_stock y
--     nunca suma al disponible del POS.
--   • Despachar un envío a Full saca las unidades del stock propio
--     (transfer_out con la sucursal, como un traslado) y quedan "en camino a
--     Full" en el envío. Cerrar la recepción no vuelve a tocar el stock propio
--     salvo lo faltante que se decide devolver (transfer_return).
--   • Una venta por Full (envío con logistic_type = fulfillment) NO descuenta
--     el stock propio: ml_ingest_pack se recrea (copia de
--     20261110400200_mercadolibre_rpc + bloque ADR-142) para marcar la línea
--     como Full y descontar el depósito Full (hasta la próxima sincronización,
--     que trae el número real). Esto rige aunque el negocio no tenga la
--     feature mercadolibre_full: nunca se descuenta del mostrador lo que
--     despachó Mercado Libre.
--
-- Seguridad (CLAUDE.md §3, ADR-052, ADR-071, ADR-083, ADR-090):
--   • tenant_id NOT NULL sin default; RLS en todas; lectura del negocio activo
--     con "(select current_tenant_id())"; costos sólo dueño o encargado.
--     Nunca "OR is_internal()".
--   • Sin policies de escritura: escriben las RPC SECURITY DEFINER
--     (ml_full_assert: rol + features mercadolibre y mercadolibre_full) y la
--     Edge ml_full con service_role. role_write_guard 'operate'.
--   • audit_logs en cada escritura de negocio (envíos, despacho, recepción,
--     cierre con diferencias, cancelación, etiquetas, configuración).
--   • Índice en cada FK.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración de Full por cuenta.
-- -----------------------------------------------------------------------------
alter table ml_accounts add column if not exists full_lead_days integer not null default 7
  check (full_lead_days between 1 and 90);
alter table ml_accounts add column if not exists full_target_days integer not null default 30
  check (full_target_days between 7 and 180);
alter table ml_accounts add column if not exists full_label_format text not null default 'thermal_50x25'
  check (full_label_format ~ '^[a-z0-9_]{3,30}$');
alter table ml_accounts add column if not exists full_last_sync_at timestamptz;
alter table ml_accounts add column if not exists full_costs_synced_at timestamptz;
alter table ml_accounts add column if not exists full_sync_error text
  check (full_sync_error is null or char_length(full_sync_error) <= 500);
alter table ml_accounts add column if not exists full_sync_note text
  check (full_sync_note is null or char_length(full_sync_note) <= 300);
comment on column ml_accounts.full_lead_days is
  'ADR-142: días que tarda un envío en estar disponible en Full (para la alerta de quiebre).';
comment on column ml_accounts.full_target_days is
  'ADR-142: cobertura objetivo en días de venta para sugerir cuánto mandar a Full.';

-- -----------------------------------------------------------------------------
-- B) Depósito virtual Full (espejo del stock de fulfillment).
-- -----------------------------------------------------------------------------
create table if not exists ml_full_inventory (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,
  account_id              uuid not null references ml_accounts(id) on delete cascade,
  inventory_id            text not null check (inventory_id ~ '^[A-Z0-9]{4,30}$'),
  ml_item_id              text check (ml_item_id is null or ml_item_id ~ '^[A-Z]{3}\d{4,16}$'),
  ml_variation_id         bigint,
  item_row_id             uuid references ml_items(id) on delete set null,
  product_id              uuid references products(id) on delete set null,
  variant_id              uuid references product_variants(id) on delete set null,
  title                   text not null default '' check (char_length(title) <= 300),
  variation_label         text check (variation_label is null or char_length(variation_label) <= 200),
  item_status             text check (item_status is null or char_length(item_status) <= 40),
  total                   integer not null default 0,
  available_quantity      integer not null default 0,
  not_available_quantity  integer not null default 0,
  damaged_qty             integer not null default 0,
  lost_qty                integer not null default 0,
  withdrawal_qty          integer not null default 0,
  internal_process_qty    integer not null default 0,
  transfer_qty            integer not null default 0,
  no_fiscal_coverage_qty  integer not null default 0,
  not_supported_qty       integer not null default 0,
  other_na_qty            integer not null default 0,
  not_available_detail    jsonb not null default '[]'::jsonb,
  conditions              jsonb not null default '[]'::jsonb,
  -- Ventas por Full registradas después de la última sincronización (se
  -- restan del disponible hasta que ML devuelva el número real).
  pending_sales           integer not null default 0 check (pending_sales >= 0),
  synced_at               timestamptz,
  stale_at                timestamptz,
  last_error              text check (last_error is null or char_length(last_error) <= 500),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);
comment on table ml_full_inventory is
  'ADR-142: depósito virtual Mercado Libre Full por cuenta (espejo de /inventories/{id}/stock/fulfillment). No vendible en el POS.';
create unique index if not exists ml_full_inventory_uq on ml_full_inventory (account_id, inventory_id);
create index if not exists ml_full_inventory_tenant_idx on ml_full_inventory (tenant_id, created_at desc);
create index if not exists ml_full_inventory_item_idx on ml_full_inventory (item_row_id) where item_row_id is not null;
create index if not exists ml_full_inventory_product_idx on ml_full_inventory (product_id, variant_id) where product_id is not null;
create index if not exists ml_full_inventory_variant_idx on ml_full_inventory (variant_id) where variant_id is not null;
create index if not exists ml_full_inventory_ml_item_idx on ml_full_inventory (account_id, ml_item_id);
drop trigger if exists set_updated_at_ml_full_inventory on ml_full_inventory;
create trigger set_updated_at_ml_full_inventory before update on ml_full_inventory
  for each row execute function set_updated_at();

create table if not exists ml_full_stock_ops (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  account_id           uuid not null references ml_accounts(id) on delete cascade,
  operation_id         bigint not null,
  inventory_id         text not null check (char_length(inventory_id) <= 30),
  op_type              text not null check (op_type ~ '^[a-z_]{2,60}$'),
  date_created         timestamptz not null,
  delta_available      integer not null default 0,
  delta_not_available  integer not null default 0,
  shipment_ref         text check (shipment_ref is null or char_length(shipment_ref) <= 40),
  inbound_ref          text check (inbound_ref is null or char_length(inbound_ref) <= 40),
  detail               jsonb not null default '{}'::jsonb,
  result               jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);
create unique index if not exists ml_full_stock_ops_uq on ml_full_stock_ops (account_id, operation_id);
create index if not exists ml_full_stock_ops_tenant_idx on ml_full_stock_ops (tenant_id, created_at desc);
create index if not exists ml_full_stock_ops_inv_idx on ml_full_stock_ops (account_id, inventory_id, date_created desc);
create index if not exists ml_full_stock_ops_inbound_idx on ml_full_stock_ops (account_id, inbound_ref) where inbound_ref is not null;

-- -----------------------------------------------------------------------------
-- C) Envíos a Full (transferencias desde un depósito propio).
-- -----------------------------------------------------------------------------
create table if not exists ml_full_inbounds (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  account_id           uuid not null references ml_accounts(id) on delete cascade,
  number               bigint not null,
  store_id             uuid not null references stores(id),
  warehouse_id         uuid references warehouses(id) on delete set null,
  status               text not null default 'draft'
                         check (status in ('draft', 'in_transit', 'partially_received', 'received',
                                           'closed_with_diff', 'cancelled')),
  ml_inbound_id        text check (ml_inbound_id is null or ml_inbound_id ~ '^[A-Za-z0-9-]{1,40}$'),
  boxes                integer not null default 1 check (boxes between 1 and 999),
  scheduled_for        date,
  notes                text check (notes is null or char_length(notes) <= 1000),
  cancel_reason        text check (cancel_reason is null or char_length(cancel_reason) <= 500),
  ml_reception         jsonb,
  ml_checked_at        timestamptz,
  label_units_printed  integer not null default 0,
  label_boxes_printed  integer not null default 0,
  created_by           uuid references public.users(id) on delete set null,
  dispatched_by        uuid references public.users(id) on delete set null,
  dispatched_at        timestamptz,
  received_at          timestamptz,
  closed_by            uuid references public.users(id) on delete set null,
  closed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table ml_full_inbounds is
  'ADR-142: envío a Full (transferencia desde un depósito propio hacia Mercado Libre Full) con tránsito y conciliación.';
create unique index if not exists ml_full_inbounds_number_uq on ml_full_inbounds (tenant_id, number);
-- Un número de envío de ML se usa en un solo envío vigente de la cuenta.
create unique index if not exists ml_full_inbounds_ml_uq
  on ml_full_inbounds (account_id, ml_inbound_id) where ml_inbound_id is not null and status <> 'cancelled';
create index if not exists ml_full_inbounds_tenant_idx on ml_full_inbounds (tenant_id, created_at desc);
create index if not exists ml_full_inbounds_tenant_status_idx on ml_full_inbounds (tenant_id, status);
create index if not exists ml_full_inbounds_account_idx on ml_full_inbounds (account_id, status);
create index if not exists ml_full_inbounds_store_idx on ml_full_inbounds (store_id);
create index if not exists ml_full_inbounds_warehouse_idx on ml_full_inbounds (warehouse_id) where warehouse_id is not null;
create index if not exists ml_full_inbounds_created_by_idx on ml_full_inbounds (created_by) where created_by is not null;
create index if not exists ml_full_inbounds_dispatched_by_idx on ml_full_inbounds (dispatched_by) where dispatched_by is not null;
create index if not exists ml_full_inbounds_closed_by_idx on ml_full_inbounds (closed_by) where closed_by is not null;
drop trigger if exists set_updated_at_ml_full_inbounds on ml_full_inbounds;
create trigger set_updated_at_ml_full_inbounds before update on ml_full_inbounds
  for each row execute function set_updated_at();

create table if not exists ml_full_inbound_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  inbound_id        uuid not null references ml_full_inbounds(id) on delete cascade,
  inventory_row_id  uuid references ml_full_inventory(id) on delete set null,
  inventory_id      text not null check (inventory_id ~ '^[A-Z0-9]{4,30}$'),
  product_id        uuid not null references products(id),
  variant_id        uuid references product_variants(id),
  title             text not null default '' check (char_length(title) <= 300),
  qty_sent          integer not null check (qty_sent between 1 and 99999),
  qty_received      integer not null default 0 check (qty_received >= 0),
  qty_damaged       integer not null default 0 check (qty_damaged >= 0),
  qty_missing       integer not null default 0 check (qty_missing >= 0),
  missing_action    text check (missing_action is null or missing_action in ('lost', 'returned')),
  missing_reason    text check (missing_reason is null or char_length(missing_reason) <= 300),
  ml_received       integer,
  ml_damaged        integer,
  wh_taken          numeric(12,3) not null default 0,
  created_at        timestamptz not null default now(),
  constraint ml_full_inbound_items_counts check (qty_received + qty_damaged + qty_missing <= qty_sent)
);
create unique index if not exists ml_full_inbound_items_uq
  on ml_full_inbound_items (inbound_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists ml_full_inbound_items_tenant_idx on ml_full_inbound_items (tenant_id, created_at desc);
create index if not exists ml_full_inbound_items_inventory_idx on ml_full_inbound_items (inventory_row_id) where inventory_row_id is not null;
create index if not exists ml_full_inbound_items_product_idx on ml_full_inbound_items (product_id, variant_id);
create index if not exists ml_full_inbound_items_variant_idx on ml_full_inbound_items (variant_id) where variant_id is not null;

-- -----------------------------------------------------------------------------
-- D) Costos de Full (resumen de facturación de ML).
-- -----------------------------------------------------------------------------
create table if not exists ml_full_costs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  account_id   uuid not null references ml_accounts(id) on delete cascade,
  period_key   date not null,
  charge_type  text not null default '' check (char_length(charge_type) <= 40),
  label        text not null check (char_length(label) <= 200),
  amount       numeric(14,2) not null default 0,
  currency     text not null default 'ARS',
  synced_at    timestamptz not null default now()
);
create unique index if not exists ml_full_costs_uq on ml_full_costs (account_id, period_key, charge_type, label);
create index if not exists ml_full_costs_tenant_idx on ml_full_costs (tenant_id, period_key desc);

-- -----------------------------------------------------------------------------
-- E) RLS.
-- -----------------------------------------------------------------------------
alter table ml_full_inventory     enable row level security;
alter table ml_full_stock_ops     enable row level security;
alter table ml_full_inbounds      enable row level security;
alter table ml_full_inbound_items enable row level security;
alter table ml_full_costs         enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ml_full_inventory', 'ml_full_stock_ops', 'ml_full_inbounds', 'ml_full_inbound_items'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (tenant_id = (select current_tenant_id()))',
      t || '_select', t);
  end loop;
  -- Plata: sólo dueño o encargado.
  execute 'drop policy if exists ml_full_costs_select on public.ml_full_costs';
  execute 'create policy ml_full_costs_select on public.ml_full_costs for select '
          'using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))';
  foreach t in array array['ml_full_inventory', 'ml_full_stock_ops', 'ml_full_inbounds', 'ml_full_inbound_items',
                           'ml_full_costs'] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- F) Guardas.
-- -----------------------------------------------------------------------------
-- UI: devuelve el negocio. p_manage: dueño o encargado; si no, cualquier rol
-- operativo (no solo lectura). Exige mercadolibre y mercadolibre_full.
create or replace function ml_full_assert(p_manage boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(p_manage, true);
begin
  if not tenant_has_feature_for(v_tenant, 'mercadolibre_full') then
    raise exception 'feature_not_in_plan: mercadolibre_full' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function ml_full_assert(boolean) from public, anon;
grant execute on function ml_full_assert(boolean) to authenticated;

-- Edge (service_role): null = puede; si no, el código del error.
create or replace function ml_full_edge_guard(p_tenant uuid, p_user uuid, p_manage boolean default true)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_err text := ml_edge_guard(p_tenant, p_user, p_manage);
begin
  if v_err is not null then return v_err; end if;
  if not tenant_has_feature_for(p_tenant, 'mercadolibre_full') then return 'feature_not_in_plan'; end if;
  return null;
end;
$$;
revoke all on function ml_full_edge_guard(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function ml_full_edge_guard(uuid, uuid, boolean) to service_role;

-- Cuenta del negocio (activa o no) para las RPC de la UI.
create or replace function _ml_full_account(p_tenant uuid, p_account uuid)
returns ml_accounts
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v ml_accounts%rowtype;
begin
  select * into v from ml_accounts a
   where a.id = p_account and a.tenant_id = p_tenant and a.deleted_at is null;
  if v.id is null then raise exception 'account_not_found' using errcode = 'P0002'; end if;
  return v;
end;
$$;
revoke all on function _ml_full_account(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) Ingesta del worker (service_role).
-- -----------------------------------------------------------------------------
-- p: {rows: [{inventory_id, ml_item_id, ml_variation_id, title, variation_label,
--             item_status, total, available_quantity, not_available_quantity,
--             buckets: {damaged, lost, withdrawal, internal_process, transfer,
--                       no_fiscal_coverage, not_supported, other},
--             not_available_detail, conditions, error}],
--     complete: bool, keep_ids: [inventory_id]}  complete = rows + keep_ids es
-- TODO lo que está en Full: lo que no vino queda dado de baja (ya no es Full).
create or replace function ml_full_inventory_upsert(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc  ml_accounts%rowtype;
  v_r    jsonb;
  v_item uuid;
  v_prod uuid;
  v_var  uuid;
  v_n    int := 0;
  v_off  int := 0;
  v_ids  text[] := '{}';
  v_b    jsonb;
begin
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  if not (tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre')
          and tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre_full')) then
    return jsonb_build_object('ok', false, 'error', 'feature_not_in_plan');
  end if;
  for v_r in select value from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) loop
    continue when coalesce(v_r ->> 'inventory_id', '') !~ '^[A-Z0-9]{4,30}$';
    v_item := null; v_prod := null; v_var := null;
    select i.id into v_item from ml_items i
     where i.account_id = p_account and i.ml_item_id = v_r ->> 'ml_item_id';
    if v_item is not null then
      select l.product_id, l.variant_id into v_prod, v_var from ml_item_links l
       where l.item_id = v_item
         and (l.ml_variation_id is null or l.ml_variation_id::text = coalesce(v_r ->> 'ml_variation_id', ''))
       order by (l.ml_variation_id is null)
       limit 1;
    end if;
    v_b := coalesce(v_r -> 'buckets', '{}'::jsonb);
    insert into ml_full_inventory (tenant_id, account_id, inventory_id, ml_item_id, ml_variation_id, item_row_id,
                                   product_id, variant_id, title, variation_label, item_status, total,
                                   available_quantity, not_available_quantity, damaged_qty, lost_qty,
                                   withdrawal_qty, internal_process_qty, transfer_qty, no_fiscal_coverage_qty,
                                   not_supported_qty, other_na_qty, not_available_detail, conditions,
                                   pending_sales, synced_at, stale_at, last_error, deleted_at)
    values (v_acc.tenant_id, p_account, v_r ->> 'inventory_id', nullif(v_r ->> 'ml_item_id', ''),
            nullif(v_r ->> 'ml_variation_id', '')::bigint, v_item, v_prod, v_var,
            left(coalesce(v_r ->> 'title', ''), 300), left(nullif(v_r ->> 'variation_label', ''), 200),
            left(nullif(v_r ->> 'item_status', ''), 40),
            greatest(coalesce((v_r ->> 'total')::int, 0), 0),
            greatest(coalesce((v_r ->> 'available_quantity')::int, 0), 0),
            greatest(coalesce((v_r ->> 'not_available_quantity')::int, 0), 0),
            greatest(coalesce((v_b ->> 'damaged')::int, 0), 0), greatest(coalesce((v_b ->> 'lost')::int, 0), 0),
            greatest(coalesce((v_b ->> 'withdrawal')::int, 0), 0),
            greatest(coalesce((v_b ->> 'internal_process')::int, 0), 0),
            greatest(coalesce((v_b ->> 'transfer')::int, 0), 0),
            greatest(coalesce((v_b ->> 'no_fiscal_coverage')::int, 0), 0),
            greatest(coalesce((v_b ->> 'not_supported')::int, 0), 0),
            greatest(coalesce((v_b ->> 'other')::int, 0), 0),
            case when jsonb_typeof(v_r -> 'not_available_detail') = 'array' then v_r -> 'not_available_detail' else '[]'::jsonb end,
            case when jsonb_typeof(v_r -> 'conditions') = 'array' then v_r -> 'conditions' else '[]'::jsonb end,
            0, case when nullif(v_r ->> 'error', '') is null then now() end, null,
            left(nullif(v_r ->> 'error', ''), 500), null)
    on conflict (account_id, inventory_id) do update
      set ml_item_id = coalesce(excluded.ml_item_id, ml_full_inventory.ml_item_id),
          ml_variation_id = coalesce(excluded.ml_variation_id, ml_full_inventory.ml_variation_id),
          item_row_id = coalesce(excluded.item_row_id, ml_full_inventory.item_row_id),
          product_id = coalesce(excluded.product_id, ml_full_inventory.product_id),
          variant_id = case when excluded.product_id is not null then excluded.variant_id else ml_full_inventory.variant_id end,
          title = case when excluded.title <> '' then excluded.title else ml_full_inventory.title end,
          variation_label = coalesce(excluded.variation_label, ml_full_inventory.variation_label),
          item_status = coalesce(excluded.item_status, ml_full_inventory.item_status),
          -- Con error de lectura se conserva el último número bueno.
          total = case when excluded.last_error is null then excluded.total else ml_full_inventory.total end,
          available_quantity = case when excluded.last_error is null then excluded.available_quantity else ml_full_inventory.available_quantity end,
          not_available_quantity = case when excluded.last_error is null then excluded.not_available_quantity else ml_full_inventory.not_available_quantity end,
          damaged_qty = case when excluded.last_error is null then excluded.damaged_qty else ml_full_inventory.damaged_qty end,
          lost_qty = case when excluded.last_error is null then excluded.lost_qty else ml_full_inventory.lost_qty end,
          withdrawal_qty = case when excluded.last_error is null then excluded.withdrawal_qty else ml_full_inventory.withdrawal_qty end,
          internal_process_qty = case when excluded.last_error is null then excluded.internal_process_qty else ml_full_inventory.internal_process_qty end,
          transfer_qty = case when excluded.last_error is null then excluded.transfer_qty else ml_full_inventory.transfer_qty end,
          no_fiscal_coverage_qty = case when excluded.last_error is null then excluded.no_fiscal_coverage_qty else ml_full_inventory.no_fiscal_coverage_qty end,
          not_supported_qty = case when excluded.last_error is null then excluded.not_supported_qty else ml_full_inventory.not_supported_qty end,
          other_na_qty = case when excluded.last_error is null then excluded.other_na_qty else ml_full_inventory.other_na_qty end,
          not_available_detail = case when excluded.last_error is null then excluded.not_available_detail else ml_full_inventory.not_available_detail end,
          conditions = case when excluded.last_error is null then excluded.conditions else ml_full_inventory.conditions end,
          pending_sales = case when excluded.last_error is null then 0 else ml_full_inventory.pending_sales end,
          synced_at = coalesce(excluded.synced_at, ml_full_inventory.synced_at),
          stale_at = case when excluded.last_error is null then null else ml_full_inventory.stale_at end,
          last_error = excluded.last_error,
          deleted_at = null;
    v_ids := v_ids || (v_r ->> 'inventory_id');
    v_n := v_n + 1;
  end loop;
  if coalesce((p ->> 'complete')::boolean, false) then
    -- keep_ids: lo ya mandado en llamadas anteriores de la misma corrida.
    v_ids := v_ids || coalesce((select array_agg(upper(x)) from jsonb_array_elements_text(
                                  case when jsonb_typeof(p -> 'keep_ids') = 'array' then p -> 'keep_ids' else '[]'::jsonb end) x),
                               '{}'::text[]);
    update ml_full_inventory
       set deleted_at = now()
     where account_id = p_account and deleted_at is null and not (inventory_id = any (v_ids));
    get diagnostics v_off = row_count;
  end if;
  return jsonb_build_object('ok', true, 'upserted', v_n, 'removed', v_off);
end;
$$;
revoke all on function ml_full_inventory_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_full_inventory_upsert(uuid, jsonb) to service_role;

-- p: [{operation_id, inventory_id, type, date_created, delta_available,
--      delta_not_available, shipment_ref, inbound_ref, detail, result}]
create or replace function ml_full_ops_save(p_account uuid, p jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc ml_accounts%rowtype;
  v_n   int;
begin
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  if not tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre_full') then return 0; end if;
  insert into ml_full_stock_ops (tenant_id, account_id, operation_id, inventory_id, op_type, date_created,
                                 delta_available, delta_not_available, shipment_ref, inbound_ref, detail, result)
  select v_acc.tenant_id, p_account, (x ->> 'operation_id')::bigint, left(x ->> 'inventory_id', 30),
         lower(left(x ->> 'type', 60)), (x ->> 'date_created')::timestamptz,
         coalesce((x ->> 'delta_available')::int, 0), coalesce((x ->> 'delta_not_available')::int, 0),
         left(nullif(x ->> 'shipment_ref', ''), 40), left(nullif(x ->> 'inbound_ref', ''), 40),
         case when jsonb_typeof(x -> 'detail') = 'object' then x -> 'detail' else '{}'::jsonb end,
         case when jsonb_typeof(x -> 'result') = 'object' then x -> 'result' else '{}'::jsonb end
    from jsonb_array_elements(coalesce(p, '[]'::jsonb)) x
   where nullif(x ->> 'operation_id', '') is not null and nullif(x ->> 'inventory_id', '') is not null
     and lower(coalesce(x ->> 'type', '')) ~ '^[a-z_]{2,60}$' and nullif(x ->> 'date_created', '') is not null
  on conflict (account_id, operation_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function ml_full_ops_save(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_full_ops_save(uuid, jsonb) to service_role;

-- p: [{period_key, charge_type, label, amount, currency}] de UN período: lo
-- que ya no vino de ese período se borra (son cargos de ML, no de negocio).
create or replace function ml_full_costs_save(p_account uuid, p_period date, p jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc ml_accounts%rowtype;
  v_n   int;
begin
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  if not tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre_full') then return 0; end if;
  delete from ml_full_costs where account_id = p_account and period_key = p_period;
  insert into ml_full_costs (tenant_id, account_id, period_key, charge_type, label, amount, currency)
  select v_acc.tenant_id, p_account, p_period, left(coalesce(x ->> 'charge_type', ''), 40),
         left(coalesce(nullif(x ->> 'label', ''), 'Cargo de Full'), 200),
         coalesce((x ->> 'amount')::numeric, 0), coalesce(nullif(x ->> 'currency', ''), 'ARS')
    from jsonb_array_elements(coalesce(p, '[]'::jsonb)) x
  on conflict (account_id, period_key, charge_type, label) do update set amount = excluded.amount, synced_at = now();
  get diagnostics v_n = row_count;
  update ml_accounts set full_costs_synced_at = now() where id = p_account;
  return v_n;
end;
$$;
revoke all on function ml_full_costs_save(uuid, date, jsonb) from public, anon, authenticated;
grant execute on function ml_full_costs_save(uuid, date, jsonb) to service_role;

create or replace function ml_full_sync_done(p_account uuid, p_error text default null, p_note text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_accounts
     set full_last_sync_at = case when p_error is null then now() else full_last_sync_at end,
         full_sync_error = left(p_error, 500),
         full_sync_note = left(p_note, 300)
   where id = p_account;
$$;
revoke all on function ml_full_sync_done(uuid, text, text) from public, anon, authenticated;
grant execute on function ml_full_sync_done(uuid, text, text) to service_role;

-- Cuentas a sincronizar (cron): activas, con las dos features, sin sync en
-- 25 minutos o con filas marcadas por una venta Full.
create or replace function ml_full_accounts_due()
returns table (account_id uuid, tenant_id uuid, ml_user_id bigint, costs_due boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.tenant_id, a.ml_user_id,
         (a.full_costs_synced_at is null or a.full_costs_synced_at < now() - interval '20 hours')
    from ml_accounts a
   where a.deleted_at is null and a.status = 'active'
     and tenant_has_feature_for(a.tenant_id, 'mercadolibre')
     and tenant_has_feature_for(a.tenant_id, 'mercadolibre_full')
     and (a.full_last_sync_at is null or a.full_last_sync_at < now() - interval '25 minutes'
          or exists (select 1 from ml_full_inventory i where i.account_id = a.id and i.stale_at is not null))
   order by a.full_last_sync_at nulls first
   limit 20;
$$;
revoke all on function ml_full_accounts_due() from public, anon, authenticated;
grant execute on function ml_full_accounts_due() to service_role;

-- Lo que el worker leyó de ML para un envío (INBOUND_RECEPTION con su
-- inbound_id): sugerencia de recibido y dañado por inventory_id. No cierra
-- nada: la conciliación la confirma una persona.
-- p: {lines: [{inventory_id, received, damaged}]}
create or replace function ml_full_reception_save(p_inbound uuid, p jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int := 0;
  v_x jsonb;
begin
  for v_x in select value from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    update ml_full_inbound_items
       set ml_received = greatest(coalesce((v_x ->> 'received')::int, 0), 0),
           ml_damaged = greatest(coalesce((v_x ->> 'damaged')::int, 0), 0)
     where inbound_id = p_inbound and inventory_id = v_x ->> 'inventory_id';
    v_n := v_n + 1;
  end loop;
  update ml_full_inbounds set ml_reception = p, ml_checked_at = now() where id = p_inbound;
  return v_n;
end;
$$;
revoke all on function ml_full_reception_save(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_full_reception_save(uuid, jsonb) to service_role;

-- Una venta por Full: descuenta el depósito Full hasta la próxima
-- sincronización y lo marca para releer. Devuelve el inventory_id (o null).
create or replace function _ml_full_sale_apply(p_account uuid, p_ml_item text, p_variation text, p_qty numeric)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id  uuid;
  v_inv text;
begin
  select i.id, i.inventory_id into v_id, v_inv from ml_full_inventory i
   where i.account_id = p_account and i.ml_item_id = p_ml_item and i.deleted_at is null
     and (i.ml_variation_id is null or i.ml_variation_id::text = coalesce(p_variation, ''))
   order by (i.ml_variation_id is null)
   limit 1;
  if v_id is null then return null; end if;
  update ml_full_inventory
     set pending_sales = pending_sales + greatest(ceil(coalesce(p_qty, 0)), 0)::int,
         stale_at = now()
   where id = v_id;
  return v_inv;
end;
$$;
revoke all on function _ml_full_sale_apply(uuid, text, text, numeric) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC de la UI.
-- -----------------------------------------------------------------------------
-- p: {lead_days, target_days, label_format}
create or replace function ml_full_settings_save(p_account uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_full_assert(true);
  v_acc    ml_accounts%rowtype := _ml_full_account(v_tenant, p_account);
  v_lead   int := coalesce(nullif(p ->> 'lead_days', '')::int, v_acc.full_lead_days);
  v_target int := coalesce(nullif(p ->> 'target_days', '')::int, v_acc.full_target_days);
  v_fmt    text := coalesce(nullif(p ->> 'label_format', ''), v_acc.full_label_format);
begin
  if v_lead not between 1 and 90 or v_target not between 7 and 180 or v_target < v_lead then
    raise exception 'invalid_full_settings' using errcode = '22023';
  end if;
  if v_fmt !~ '^[a-z0-9_]{3,30}$' then raise exception 'invalid_label_format' using errcode = '22023'; end if;
  update ml_accounts
     set full_lead_days = v_lead, full_target_days = v_target, full_label_format = v_fmt
   where id = p_account;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'ml_accounts', p_account, 'ml_full_settings_saved',
          jsonb_build_object('lead_days', v_acc.full_lead_days, 'target_days', v_acc.full_target_days,
                             'label_format', v_acc.full_label_format),
          jsonb_build_object('lead_days', v_lead, 'target_days', v_target, 'label_format', v_fmt));
end;
$$;
revoke all on function ml_full_settings_save(uuid, jsonb) from public, anon;
grant execute on function ml_full_settings_save(uuid, jsonb) to authenticated;

-- Stock disponible propio de un producto para mandar a Full: depósito (si no
-- es el salón) o sucursal menos reservas de clientes.
create or replace function _ml_full_own_qty(p_tenant uuid, p_store uuid, p_wh uuid, p_product uuid, p_variant uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
begin
  if p_wh is not null then
    select w.kind into v_kind from warehouses w
     where w.id = p_wh and w.tenant_id = p_tenant and w.store_id = p_store and w.deleted_at is null;
  end if;
  if v_kind is not null and v_kind <> 'principal' then
    return coalesce((select ws.qty from warehouse_stock ws
                      where ws.warehouse_id = p_wh and ws.product_id = p_product
                        and ws.variant_id is not distinct from p_variant), 0);
  end if;
  return coalesce((select ps.qty from product_stock ps
                    where ps.store_id = p_store and ps.product_id = p_product
                      and ps.variant_id is not distinct from p_variant), 0)
         - coalesce(stock_reserved_qty(p_store, p_product, p_variant, null), 0);
end;
$$;
revoke all on function _ml_full_own_qty(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Alta o edición de un envío en borrador.
-- p: {account_id, store_id, warehouse_id, ml_inbound_id, boxes, scheduled_for,
--     notes, items: [{product_id, variant_id, qty}]}
create or replace function ml_full_inbound_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := ml_full_assert(true);
  v_account uuid := nullif(p ->> 'account_id', '')::uuid;
  v_store   uuid := nullif(p ->> 'store_id', '')::uuid;
  v_wh      uuid := nullif(p ->> 'warehouse_id', '')::uuid;
  v_mlid    text := nullif(btrim(coalesce(p ->> 'ml_inbound_id', '')), '');
  v_row     ml_full_inbounds%rowtype;
  v_acc     ml_accounts%rowtype;
  v_x       record;
  v_inv     ml_full_inventory%rowtype;
  v_p       products%rowtype;
  v_number  bigint;
  v_count   int := 0;
begin
  if p_id is not null then
    select * into v_row from ml_full_inbounds where id = p_id and tenant_id = v_tenant for update;
    if v_row.id is null then raise exception 'inbound_not_found' using errcode = 'P0002'; end if;
    if v_row.status <> 'draft' then raise exception 'inbound_not_editable' using errcode = '22023'; end if;
    v_account := v_row.account_id;
  end if;
  v_acc := _ml_full_account(v_tenant, v_account);
  if v_store is null
     or not exists (select 1 from stores s where s.id = v_store and s.tenant_id = v_tenant and s.deleted_at is null) then
    raise exception 'store_not_found' using errcode = '22023';
  end if;
  if not user_can_access_store(v_store) then raise exception 'store_forbidden' using errcode = '42501'; end if;
  if v_wh is not null and not exists (
       select 1 from warehouses w where w.id = v_wh and w.tenant_id = v_tenant and w.store_id = v_store
                                    and w.deleted_at is null) then
    raise exception 'warehouse_not_found' using errcode = '22023';
  end if;
  if v_mlid is not null and v_mlid !~ '^[A-Za-z0-9-]{1,40}$' then
    raise exception 'invalid_ml_inbound_id' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'empty_inbound' using errcode = '22023';
  end if;
  if jsonb_array_length(p -> 'items') > 300 then raise exception 'too_many_items' using errcode = '22023'; end if;

  if v_row.id is null then
    perform pg_advisory_xact_lock(hashtext('ml_full_inbound_number:' || v_tenant::text));
    select coalesce(max(number), 0) + 1 into v_number from ml_full_inbounds where tenant_id = v_tenant;
    insert into ml_full_inbounds (tenant_id, account_id, number, store_id, warehouse_id, ml_inbound_id, boxes,
                                  scheduled_for, notes, created_by)
    values (v_tenant, v_account, v_number, v_store, v_wh, v_mlid,
            least(greatest(coalesce(nullif(p ->> 'boxes', '')::int, 1), 1), 999),
            nullif(p ->> 'scheduled_for', '')::date, left(nullif(p ->> 'notes', ''), 1000), auth.uid())
    returning * into v_row;
  else
    update ml_full_inbounds
       set store_id = v_store, warehouse_id = v_wh, ml_inbound_id = v_mlid,
           boxes = least(greatest(coalesce(nullif(p ->> 'boxes', '')::int, 1), 1), 999),
           scheduled_for = nullif(p ->> 'scheduled_for', '')::date,
           notes = left(nullif(p ->> 'notes', ''), 1000)
     where id = v_row.id
    returning * into v_row;
    delete from ml_full_inbound_items where inbound_id = v_row.id;
  end if;

  -- Líneas repetidas se suman; cada una tiene que estar habilitada para Full.
  for v_x in
    select (x ->> 'product_id')::uuid as product_id, nullif(x ->> 'variant_id', '')::uuid as variant_id,
           sum((x ->> 'qty')::numeric) as qty
      from jsonb_array_elements(p -> 'items') x
     group by 1, 2
  loop
    if v_x.qty is null or v_x.qty <> floor(v_x.qty) or v_x.qty < 1 or v_x.qty > 99999 then
      raise exception 'invalid_qty' using errcode = '22023';
    end if;
    select * into v_p from products pr
     where pr.id = v_x.product_id and pr.tenant_id = v_tenant and pr.deleted_at is null;
    if v_p.id is null then raise exception 'product_not_found' using errcode = '22023'; end if;
    if not coalesce(v_p.track_stock, true) or coalesce(v_p.is_kit, false) then
      raise exception 'product_without_stock: %', v_p.name using errcode = '22023';
    end if;
    v_inv := null;
    select * into v_inv from ml_full_inventory i
     where i.account_id = v_account and i.product_id = v_x.product_id
       and i.variant_id is not distinct from v_x.variant_id and i.deleted_at is null
     order by i.synced_at desc nulls last
     limit 1;
    if v_inv.id is null then
      raise exception 'not_full_enabled: %', v_p.name using errcode = '22023',
        hint = 'El producto tiene que estar vinculado a una publicación con Full y sincronizado.';
    end if;
    insert into ml_full_inbound_items (tenant_id, inbound_id, inventory_row_id, inventory_id, product_id, variant_id,
                                       title, qty_sent)
    values (v_tenant, v_row.id, v_inv.id, v_inv.inventory_id, v_x.product_id, v_x.variant_id,
            left(coalesce(nullif(v_inv.title, ''), v_p.name), 300), v_x.qty::int);
    v_count := v_count + 1;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'ml_full_inbounds', v_row.id,
          case when p_id is null then 'ml_full_inbound_created' else 'ml_full_inbound_updated' end,
          jsonb_build_object('number', v_row.number, 'account_id', v_account, 'ml_inbound_id', v_mlid,
                             'items', v_count,
                             'units', (select sum(qty_sent) from ml_full_inbound_items where inbound_id = v_row.id)),
          v_store);
  return v_row.id;
end;
$$;
revoke all on function ml_full_inbound_save(uuid, jsonb) from public, anon;
grant execute on function ml_full_inbound_save(uuid, jsonb) to authenticated;

-- Número del envío de ML y cantidad de bultos (borrador o en tránsito).
create or replace function ml_full_inbound_set_ml(p_id uuid, p_ml_inbound_id text, p_boxes integer default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_full_assert(true);
  v_row    ml_full_inbounds%rowtype;
  v_mlid   text := nullif(btrim(coalesce(p_ml_inbound_id, '')), '');
begin
  select * into v_row from ml_full_inbounds where id = p_id and tenant_id = v_tenant for update;
  if v_row.id is null then raise exception 'inbound_not_found' using errcode = 'P0002'; end if;
  if v_row.status not in ('draft', 'in_transit', 'partially_received') then
    raise exception 'inbound_not_editable' using errcode = '22023';
  end if;
  if v_mlid is null or v_mlid !~ '^[A-Za-z0-9-]{1,40}$' then
    raise exception 'invalid_ml_inbound_id' using errcode = '22023';
  end if;
  update ml_full_inbounds
     set ml_inbound_id = v_mlid,
         boxes = coalesce(least(greatest(p_boxes, 1), 999), boxes)
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'ml_full_inbounds', p_id, 'ml_full_inbound_ml_id_set',
          jsonb_build_object('ml_inbound_id', v_row.ml_inbound_id, 'boxes', v_row.boxes),
          jsonb_build_object('ml_inbound_id', v_mlid, 'boxes', coalesce(least(greatest(p_boxes, 1), 999), v_row.boxes)),
          v_row.store_id);
end;
$$;
revoke all on function ml_full_inbound_set_ml(uuid, text, integer) from public, anon;
grant execute on function ml_full_inbound_set_ml(uuid, text, integer) to authenticated;

-- Despachar: valida el stock propio, lo saca (transfer_out con la sucursal y,
-- si el origen es un depósito que no es el salón, también del depósito) y el
-- envío queda en tránsito a Full. Exige el número del envío de ML.
create or replace function ml_full_inbound_dispatch(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := ml_full_assert(true);
  v_row     ml_full_inbounds%rowtype;
  v_it      record;
  v_kind    text;
  v_avail   numeric;
  v_short   jsonb := '[]'::jsonb;
  v_units   int := 0;
  v_note    text;
begin
  select * into v_row from ml_full_inbounds where id = p_id and tenant_id = v_tenant for update;
  if v_row.id is null then raise exception 'inbound_not_found' using errcode = 'P0002'; end if;
  if v_row.status <> 'draft' then raise exception 'inbound_not_draft' using errcode = '22023'; end if;
  if v_row.ml_inbound_id is null then raise exception 'ml_inbound_id_required' using errcode = '22023'; end if;
  if not user_can_access_store(v_row.store_id) then raise exception 'store_forbidden' using errcode = '42501'; end if;
  perform assert_account_active(v_tenant);
  if v_row.warehouse_id is not null then
    select w.kind into v_kind from warehouses w where w.id = v_row.warehouse_id and w.deleted_at is null;
  end if;

  -- Bloquea el stock de cada línea antes de validar (dos despachos a la vez
  -- no sacan dos veces la misma unidad).
  perform 1 from product_stock ps
    join ml_full_inbound_items i on i.product_id = ps.product_id and i.variant_id is not distinct from ps.variant_id
   where i.inbound_id = p_id and ps.store_id = v_row.store_id
   for update of ps;

  for v_it in select * from ml_full_inbound_items where inbound_id = p_id order by created_at loop
    v_avail := _ml_full_own_qty(v_tenant, v_row.store_id, v_row.warehouse_id, v_it.product_id, v_it.variant_id);
    if v_avail < v_it.qty_sent then
      v_short := v_short || jsonb_build_array(jsonb_build_object(
        'product_id', v_it.product_id, 'variant_id', v_it.variant_id, 'title', v_it.title,
        'needed', v_it.qty_sent, 'available', greatest(floor(v_avail), 0)));
    end if;
  end loop;
  if jsonb_array_length(v_short) > 0 then
    raise exception 'insufficient_stock' using errcode = '22023', detail = v_short::text;
  end if;

  v_note := left('Envío a Full N° ' || v_row.number || ' (Mercado Libre ' || v_row.ml_inbound_id || ')', 200);
  for v_it in select * from ml_full_inbound_items where inbound_id = p_id loop
    perform transfer_move_stock(v_tenant, v_row.store_id, v_it.product_id, v_it.variant_id,
                                -v_it.qty_sent, 'transfer_out', p_id, v_note);
    if v_kind is not null and v_kind <> 'principal' then
      perform warehouse_apply(v_tenant, v_row.warehouse_id, v_it.product_id, v_it.variant_id, -v_it.qty_sent);
      update ml_full_inbound_items set wh_taken = qty_sent where id = v_it.id;
    end if;
    v_units := v_units + v_it.qty_sent;
  end loop;

  update ml_full_inbounds
     set status = 'in_transit', dispatched_at = now(), dispatched_by = auth.uid()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'ml_full_inbounds', p_id, 'ml_full_inbound_dispatched',
          jsonb_build_object('number', v_row.number, 'ml_inbound_id', v_row.ml_inbound_id, 'units', v_units,
                             'warehouse_id', v_row.warehouse_id),
          v_row.store_id);
  return jsonb_build_object('ok', true, 'units', v_units);
end;
$$;
revoke all on function ml_full_inbound_dispatch(uuid) from public, anon;
grant execute on function ml_full_inbound_dispatch(uuid) to authenticated;

-- Recepción y conciliación.
-- p_lines: [{item_id, received, damaged, missing_action, missing_reason}]
-- Sin cerrar: guarda lo contado (cualquier rol operativo). Al cerrar (dueño o
-- encargado): faltante = enviado − recibido − dañado; cada faltante necesita
-- qué pasó: 'returned' (vuelve a tu depósito: transfer_return) o 'lost'
-- (perdido en el camino: ya salió del stock, queda registrado), con motivo.
-- Dañado: lo informa ML y queda en Full como no disponible.
create or replace function ml_full_inbound_receive(p_id uuid, p_lines jsonb, p_close boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := ml_full_assert(coalesce(p_close, false));
  v_row     ml_full_inbounds%rowtype;
  v_x       jsonb;
  v_it      ml_full_inbound_items%rowtype;
  v_rec     int;
  v_dmg     int;
  v_miss    int;
  v_action  text;
  v_reason  text;
  v_diffs   jsonb := '[]'::jsonb;
  v_any     boolean := false;
  v_has_diff boolean := false;
  v_status  text;
  v_note    text;
begin
  select * into v_row from ml_full_inbounds where id = p_id and tenant_id = v_tenant for update;
  if v_row.id is null then raise exception 'inbound_not_found' using errcode = 'P0002'; end if;
  if v_row.status not in ('in_transit', 'partially_received') then
    raise exception 'inbound_not_in_transit' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'invalid_lines' using errcode = '22023'; end if;

  for v_x in select value from jsonb_array_elements(p_lines) loop
    select * into v_it from ml_full_inbound_items
     where id = (v_x ->> 'item_id')::uuid and inbound_id = p_id for update;
    if v_it.id is null then raise exception 'item_not_found' using errcode = '22023'; end if;
    v_rec := coalesce(nullif(v_x ->> 'received', '')::int, v_it.qty_received);
    v_dmg := coalesce(nullif(v_x ->> 'damaged', '')::int, v_it.qty_damaged);
    if v_rec < 0 or v_dmg < 0 or v_rec + v_dmg > v_it.qty_sent then
      raise exception 'invalid_reception: %', v_it.title using errcode = '22023';
    end if;
    update ml_full_inbound_items set qty_received = v_rec, qty_damaged = v_dmg where id = v_it.id;
  end loop;

  select bool_or(qty_received + qty_damaged > 0) into v_any from ml_full_inbound_items where inbound_id = p_id;

  if not coalesce(p_close, false) then
    update ml_full_inbounds
       set status = case when coalesce(v_any, false) then 'partially_received' else status end
     where id = p_id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'ml_full_inbounds', p_id, 'ml_full_inbound_counted',
            jsonb_build_object('number', v_row.number,
                               'lines', (select jsonb_agg(jsonb_build_object('inventory_id', inventory_id,
                                                                             'sent', qty_sent, 'received', qty_received,
                                                                             'damaged', qty_damaged))
                                           from ml_full_inbound_items where inbound_id = p_id)),
            v_row.store_id);
    return jsonb_build_object('ok', true, 'status', case when coalesce(v_any, false) then 'partially_received' else v_row.status end);
  end if;

  -- Cierre con conciliación.
  v_note := left('Envío a Full N° ' || v_row.number || ': faltante que vuelve', 200);
  for v_it in select * from ml_full_inbound_items where inbound_id = p_id order by created_at loop
    v_miss := v_it.qty_sent - v_it.qty_received - v_it.qty_damaged;
    v_action := null; v_reason := null;
    if v_miss > 0 then
      select nullif(x ->> 'missing_action', ''), nullif(btrim(coalesce(x ->> 'missing_reason', '')), '')
        into v_action, v_reason
        from jsonb_array_elements(p_lines) x where (x ->> 'item_id')::uuid = v_it.id limit 1;
      if v_action is null or v_action not in ('lost', 'returned') then
        raise exception 'missing_action_required: %', v_it.title using errcode = '22023';
      end if;
      if v_reason is null or char_length(v_reason) < 3 then
        raise exception 'missing_reason_required: %', v_it.title using errcode = '22023';
      end if;
      if v_action = 'returned' then
        perform transfer_move_stock(v_tenant, v_row.store_id, v_it.product_id, v_it.variant_id,
                                    v_miss, 'transfer_return', p_id, v_note);
      end if;
      v_has_diff := true;
    end if;
    if v_it.qty_damaged > 0 then v_has_diff := true; end if;
    update ml_full_inbound_items
       set qty_missing = greatest(v_miss, 0), missing_action = case when v_miss > 0 then v_action end,
           missing_reason = case when v_miss > 0 then left(v_reason, 300) end
     where id = v_it.id;
    if v_miss > 0 or v_it.qty_damaged > 0 then
      v_diffs := v_diffs || jsonb_build_array(jsonb_build_object(
        'inventory_id', v_it.inventory_id, 'title', v_it.title, 'sent', v_it.qty_sent,
        'received', v_it.qty_received, 'damaged', v_it.qty_damaged, 'missing', greatest(v_miss, 0),
        'missing_action', case when v_miss > 0 then v_action end, 'reason', case when v_miss > 0 then v_reason end));
    end if;
  end loop;

  v_status := case when v_has_diff then 'closed_with_diff' else 'received' end;
  update ml_full_inbounds
     set status = v_status, received_at = coalesce(received_at, now()), closed_at = now(), closed_by = auth.uid()
   where id = p_id;
  -- Que la próxima sincronización traiga ya el stock de Full.
  update ml_full_inventory i set stale_at = now()
   where i.id in (select inventory_row_id from ml_full_inbound_items where inbound_id = p_id);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'ml_full_inbounds', p_id,
          case when v_has_diff then 'ml_full_inbound_closed_with_diff' else 'ml_full_inbound_received' end,
          jsonb_build_object('number', v_row.number, 'ml_inbound_id', v_row.ml_inbound_id, 'differences', v_diffs),
          v_row.store_id);
  return jsonb_build_object('ok', true, 'status', v_status, 'differences', v_diffs);
end;
$$;
revoke all on function ml_full_inbound_receive(uuid, jsonb, boolean) from public, anon;
grant execute on function ml_full_inbound_receive(uuid, jsonb, boolean) to authenticated;

-- Cancelar: un borrador, o un envío en tránsito sin nada recibido (todo
-- vuelve al depósito de origen).
create or replace function ml_full_inbound_cancel(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_full_assert(true);
  v_row    ml_full_inbounds%rowtype;
  v_it     record;
  v_kind   text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note   text;
begin
  select * into v_row from ml_full_inbounds where id = p_id and tenant_id = v_tenant for update;
  if v_row.id is null then raise exception 'inbound_not_found' using errcode = 'P0002'; end if;
  if v_row.status not in ('draft', 'in_transit') then raise exception 'inbound_not_cancellable' using errcode = '22023'; end if;
  if v_row.status = 'in_transit' then
    if v_reason is null or char_length(v_reason) < 3 then
      raise exception 'reason_required' using errcode = '22023';
    end if;
    if exists (select 1 from ml_full_inbound_items where inbound_id = p_id and qty_received + qty_damaged > 0) then
      raise exception 'inbound_has_reception' using errcode = '22023';
    end if;
    if v_row.warehouse_id is not null then
      select w.kind into v_kind from warehouses w where w.id = v_row.warehouse_id and w.deleted_at is null;
    end if;
    v_note := left('Envío a Full N° ' || v_row.number || ' cancelado', 200);
    for v_it in select * from ml_full_inbound_items where inbound_id = p_id loop
      perform transfer_move_stock(v_tenant, v_row.store_id, v_it.product_id, v_it.variant_id,
                                  v_it.qty_sent, 'transfer_return', p_id, v_note);
      if v_kind is not null and v_kind <> 'principal' and v_it.wh_taken > 0 then
        perform warehouse_apply(v_tenant, v_row.warehouse_id, v_it.product_id, v_it.variant_id, v_it.wh_taken);
      end if;
    end loop;
  end if;
  update ml_full_inbounds set status = 'cancelled', cancel_reason = left(v_reason, 500) where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_tenant, auth.uid(), 'ml_full_inbounds', p_id, 'ml_full_inbound_cancelled',
          jsonb_build_object('status', v_row.status),
          jsonb_build_object('number', v_row.number, 'returned_stock', v_row.status = 'in_transit'),
          left(v_reason, 500), v_row.store_id);
end;
$$;
revoke all on function ml_full_inbound_cancel(uuid, text) from public, anon;
grant execute on function ml_full_inbound_cancel(uuid, text) to authenticated;

-- Etiquetas impresas (de producto o de bulto): contador y auditoría.
create or replace function ml_full_labels_printed(p_id uuid, p_kind text, p_count integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_full_assert(false);
  v_row    ml_full_inbounds%rowtype;
begin
  if p_kind not in ('units', 'boxes') or coalesce(p_count, 0) not between 1 and 100000 then
    raise exception 'invalid_labels' using errcode = '22023';
  end if;
  select * into v_row from ml_full_inbounds where id = p_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'inbound_not_found' using errcode = 'P0002'; end if;
  update ml_full_inbounds
     set label_units_printed = label_units_printed + case when p_kind = 'units' then p_count else 0 end,
         label_boxes_printed = label_boxes_printed + case when p_kind = 'boxes' then p_count else 0 end
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'ml_full_inbounds', p_id, 'ml_full_labels_printed',
          jsonb_build_object('number', v_row.number, 'kind', p_kind, 'count', p_count), v_row.store_id);
end;
$$;
revoke all on function ml_full_labels_printed(uuid, text, integer) from public, anon;
grant execute on function ml_full_labels_printed(uuid, text, integer) to authenticated;

-- Tablero: stock de Full vs propio por inventory_id, en camino (envíos
-- abiertos), vendido en 30 días (operaciones de Full o, sin ellas, órdenes
-- de ML por Full) y configuración. La cobertura la calcula la UI con el
-- mismo cálculo testeado (lib/mercadolibre/full.ts).
create or replace function ml_full_overview(p_account uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_full_assert(false);
  v_acc    ml_accounts%rowtype := _ml_full_account(v_tenant, p_account);
  v_store  uuid;
  v_since  timestamptz := now() - interval '30 days';
begin
  select coalesce(m.store_id, stock_default_store(v_tenant)) into v_store
    from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  v_store := coalesce(v_store, stock_default_store(v_tenant));
  return jsonb_build_object(
    'settings', jsonb_build_object('lead_days', v_acc.full_lead_days, 'target_days', v_acc.full_target_days,
                                   'label_format', v_acc.full_label_format, 'last_sync_at', v_acc.full_last_sync_at,
                                   'sync_error', v_acc.full_sync_error, 'sync_note', v_acc.full_sync_note,
                                   'costs_synced_at', v_acc.full_costs_synced_at, 'own_store_id', v_store,
                                   'account_status', v_acc.status),
    'rows', coalesce((
      select jsonb_agg(r order by r ->> 'title')
        from (
          select jsonb_build_object(
                   'id', i.id, 'inventory_id', i.inventory_id, 'ml_item_id', i.ml_item_id,
                   'ml_variation_id', i.ml_variation_id::text, 'title', i.title,
                   'variation_label', i.variation_label, 'item_status', i.item_status,
                   'product_id', i.product_id, 'variant_id', i.variant_id,
                   'product_name', pr.name, 'sku', coalesce(v.sku, pr.sku), 'barcode', coalesce(v.barcode, pr.barcode),
                   'total', i.total, 'available', greatest(i.available_quantity - i.pending_sales, 0),
                   'pending_sales', i.pending_sales,
                   'not_available', i.not_available_quantity,
                   'damaged', i.damaged_qty, 'lost', i.lost_qty, 'withdrawal', i.withdrawal_qty,
                   'internal_process', i.internal_process_qty, 'transfer', i.transfer_qty,
                   'no_fiscal_coverage', i.no_fiscal_coverage_qty, 'not_supported', i.not_supported_qty,
                   'other', i.other_na_qty, 'conditions', i.conditions,
                   'in_transit', coalesce((
                     select sum(greatest(it.qty_sent - it.qty_received - it.qty_damaged, 0))
                       from ml_full_inbound_items it
                       join ml_full_inbounds ib on ib.id = it.inbound_id
                      where it.inventory_row_id = i.id and ib.status in ('in_transit', 'partially_received')), 0),
                   'own_qty', case when i.product_id is null or v_store is null then null
                                   else _ml_full_own_qty(v_tenant, v_store, null, i.product_id, i.variant_id) end,
                   'sold_30d_ops', (
                     select sum(case when o.op_type = 'sale_confirmation' then abs(o.delta_available)
                                     when o.op_type = 'sale_cancelation' then -abs(o.delta_available)
                                     else 0 end)
                       from ml_full_stock_ops o
                      where o.account_id = p_account and o.inventory_id = i.inventory_id
                        and o.date_created >= v_since
                        and o.op_type in ('sale_confirmation', 'sale_cancelation')),
                   'sold_30d_orders', (
                     select sum((l ->> 'quantity')::numeric)
                       from ml_orders o, jsonb_array_elements(o.lines) l
                      where o.account_id = p_account and o.date_created >= v_since
                        and o.status = 'paid' and coalesce((l ->> 'full')::boolean, false)
                        and l ->> 'ml_item_id' = i.ml_item_id
                        and (i.ml_variation_id is null or l ->> 'ml_variation_id' = i.ml_variation_id::text)),
                   'synced_at', i.synced_at, 'last_error', i.last_error) as r
            from ml_full_inventory i
            left join products pr on pr.id = i.product_id
            left join product_variants v on v.id = i.variant_id
           where i.account_id = p_account and i.deleted_at is null
        ) s), '[]'::jsonb));
end;
$$;
revoke all on function ml_full_overview(uuid) from public, anon;
grant execute on function ml_full_overview(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- I) ml_ingest_pack: copia de 20261110400200_mercadolibre_rpc (única
--    definición anterior) + bloque ADR-142: las líneas despachadas por Full
--    no descuentan el stock propio (applied = false, así la cancelación
--    tampoco lo toca) y descuentan el depósito Full si el negocio tiene la
--    feature. Las líneas guardan full y full_inventory_id.
-- -----------------------------------------------------------------------------
-- p: PackPayload (orders.ts). Devuelve {ok, decision, sale_id, number}.
create or replace function ml_ingest_pack(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc        ml_accounts%rowtype;
  v_tenant     uuid;
  v_pack       text := nullif(btrim(coalesce(p ->> 'pack_key', '')), '');
  v_o          jsonb;
  v_l          jsonb;
  v_all_paid   boolean;
  v_all_cancel boolean;
  v_any_cancel boolean;
  v_fraud      boolean;
  v_sale       uuid;
  v_sale_row   sales%rowtype;
  v_map        ml_location_map%rowtype;
  v_store      uuid;
  v_bill       jsonb := case when jsonb_typeof(p -> 'billing') = 'object' then p -> 'billing' end;
  v_doc        text;
  v_customer   uuid;
  v_lines      jsonb := '[]'::jsonb;
  v_lp         uuid;
  v_lv         uuid;
  v_tax_in     jsonb := '[]'::jsonb;
  v_tax        jsonb;
  v_tl         jsonb;
  v_total      numeric := 0;
  v_gross      numeric;
  v_number     bigint;
  v_i          int := 0;
  v_pname      text;
  v_psku       text;
  v_track      boolean;
  v_taken      numeric;
  v_fiscal     uuid;
  v_decision   text;
  v_ord        record;
  v_reverted   int := 0;
  v_unlinked   int;
  -- ADR-142: ventas por Full (las despacha ML desde su centro).
  v_full_pack  boolean := coalesce(p -> 'shipment' ->> 'logistic_type', '') = 'fulfillment';
  v_has_ship   boolean := jsonb_typeof(p -> 'shipment') = 'object';
  v_line_full  boolean;
  v_full_inv   text;
  v_full_lines int := 0;
  v_full_feat  boolean;
begin
  if v_pack is null or jsonb_typeof(p -> 'orders') <> 'array' or jsonb_array_length(p -> 'orders') = 0 then
    raise exception 'invalid_payload';
  end if;
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  v_tenant := v_acc.tenant_id;
  if not tenant_has_feature_for(v_tenant, 'mercadolibre') then
    return jsonb_build_object('ok', false, 'error', 'feature_not_in_plan');
  end if;
  -- Dos notificaciones del mismo carrito no crean dos ventas.
  perform pg_advisory_xact_lock(hashtext('ml_pack:' || p_account::text || ':' || v_pack));

  -- 1) Espejo de cada orden (no pisa con un estado más viejo).
  for v_o in select value from jsonb_array_elements(p -> 'orders') loop
    insert into ml_orders (tenant_id, account_id, ml_order_id, pack_key, pack_id, status, status_detail, tags,
                           date_created, date_closed, ml_last_updated, total_amount, paid_amount, currency,
                           sale_fee_total, buyer_id, buyer_nickname, shipment_id, fraud_risk, cancel_detail, lines)
    values (v_tenant, p_account, (v_o ->> 'ml_order_id')::bigint, v_pack, nullif(p ->> 'pack_id', '')::bigint,
            left(coalesce(v_o ->> 'status', 'unknown'), 40), left(v_o ->> 'status_detail', 200),
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_o -> 'tags', '[]'::jsonb)) x), '{}'),
            nullif(v_o ->> 'date_created', '')::timestamptz, nullif(v_o ->> 'date_closed', '')::timestamptz,
            nullif(v_o ->> 'last_updated', '')::timestamptz,
            coalesce((v_o ->> 'total_amount')::numeric, 0), coalesce((v_o ->> 'paid_amount')::numeric, 0),
            coalesce(nullif(v_o ->> 'currency', ''), 'ARS'), coalesce((v_o ->> 'sale_fee_total')::numeric, 0),
            nullif(v_o -> 'buyer' ->> 'id', '')::bigint, left(v_o -> 'buyer' ->> 'nickname', 120),
            nullif(v_o ->> 'shipment_id', '')::bigint, coalesce((v_o ->> 'fraud_risk')::boolean, false),
            case when jsonb_typeof(v_o -> 'cancel_detail') = 'object' then v_o -> 'cancel_detail' end,
            coalesce(v_o -> 'lines', '[]'::jsonb))
    on conflict (account_id, ml_order_id) do update
      set status = excluded.status, status_detail = excluded.status_detail, tags = excluded.tags,
          date_closed = excluded.date_closed, ml_last_updated = excluded.ml_last_updated,
          total_amount = excluded.total_amount, paid_amount = excluded.paid_amount,
          sale_fee_total = excluded.sale_fee_total, shipment_id = coalesce(excluded.shipment_id, ml_orders.shipment_id),
          fraud_risk = excluded.fraud_risk, cancel_detail = excluded.cancel_detail,
          pack_key = excluded.pack_key, pack_id = excluded.pack_id,
          -- Las líneas resueltas (producto, stock aplicado) no se pisan después de la venta.
          lines = case when ml_orders.sale_id is null then excluded.lines else ml_orders.lines end
      where ml_orders.ml_last_updated is null or excluded.ml_last_updated is null
         or excluded.ml_last_updated >= ml_orders.ml_last_updated;
  end loop;

  -- Costo de envío (si vino el envío normalizado).
  if jsonb_typeof(p -> 'shipment') = 'object' and nullif(p -> 'shipment' ->> 'cost', '') is not null then
    update ml_orders set shipping_cost = (p -> 'shipment' ->> 'cost')::numeric
     where account_id = p_account and pack_key = v_pack;
  end if;

  -- 2) Estado del carrito completo.
  select bool_and(o.status = 'paid'), bool_and(o.status in ('cancelled', 'invalid')),
         bool_or(o.status in ('cancelled', 'invalid')), bool_or(o.fraud_risk), max(o.sale_id::text)::uuid
    into v_all_paid, v_all_cancel, v_any_cancel, v_fraud, v_sale
    from ml_orders o
   where o.account_id = p_account and o.pack_key = v_pack;

  -- 2.a) Fraude sin venta: no se crea (ML la cancela; no despachar).
  if v_fraud and v_sale is null then
    update ml_orders set needs_review = 'Mercado Libre detectó riesgo de fraude: no despachar.'
     where account_id = p_account and pack_key = v_pack;
    return jsonb_build_object('ok', true, 'decision', 'fraud');
  end if;
  if v_fraud then
    update ml_orders set needs_review = 'Mercado Libre detectó riesgo de fraude después del pago: no despachar; se anula si ML la cancela.'
     where account_id = p_account and pack_key = v_pack and needs_review is null;
  end if;

  -- 2.b) Cancelaciones: revierte el stock de cada orden cancelada.
  if v_any_cancel then
    for v_ord in
      select o.id from ml_orders o
       where o.account_id = p_account and o.pack_key = v_pack and o.status in ('cancelled', 'invalid')
    loop
      if _ml_order_revert(v_ord.id) then v_reverted := v_reverted + 1; end if;
    end loop;
    if v_all_cancel then
      if v_sale is not null then
        update sales
           set status = 'voided', voided_at = now(), void_reason = 'Cancelada en Mercado Libre'
         where id = v_sale and tenant_id = v_tenant and status = 'completed';
        if found then
          insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
          values (v_tenant, null, 'sales', v_sale, 'ml_sale_cancelled',
                  jsonb_build_object('pack_key', v_pack, 'reverted_orders', v_reverted));
        end if;
      end if;
      update ml_orders set needs_review = null
       where account_id = p_account and pack_key = v_pack and needs_review like 'Carrito%';
      return jsonb_build_object('ok', true, 'decision', 'cancel', 'sale_id', v_sale, 'reverted', v_reverted);
    end if;
    update ml_orders set needs_review = 'Carrito con órdenes canceladas y otras no: revisá la venta (devolución parcial).'
     where account_id = p_account and pack_key = v_pack and needs_review is null;
    if v_reverted > 0 then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, null, 'sales', v_sale, 'ml_order_partial_cancel',
              jsonb_build_object('pack_key', v_pack, 'reverted_orders', v_reverted));
    end if;
    return jsonb_build_object('ok', true, 'decision', 'partial_cancel', 'sale_id', v_sale, 'reverted', v_reverted);
  end if;

  if v_sale is not null then
    return jsonb_build_object('ok', true, 'decision', 'noop', 'sale_id', v_sale);
  end if;
  if not coalesce(v_all_paid, false) then
    return jsonb_build_object('ok', true, 'decision', 'wait_payment');
  end if;

  -- 3) Crear la venta.
  perform assert_account_active(v_tenant);
  select * into v_map from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  v_store := coalesce(v_map.store_id, stock_default_store(v_tenant));
  if v_store is null then raise exception 'no_store'; end if;
  if v_map.warehouse_id is not null and not exists (
       select 1 from warehouses w where w.id = v_map.warehouse_id and w.store_id = v_store and w.deleted_at is null) then
    v_map.warehouse_id := null;
  end if;

  -- Cliente desde los datos de facturación (o consumidor final).
  if v_bill is not null then
    v_doc := nullif(regexp_replace(coalesce(v_bill ->> 'docNumber', ''), '\D', '', 'g'), '');
    if v_doc is not null then
      select c.id into v_customer from customers c
       where c.tenant_id = v_tenant and c.deleted_at is null
         and regexp_replace(coalesce(c.document_number, ''), '\D', '', 'g') = v_doc
       order by c.created_at limit 1;
      if v_customer is null then
        insert into customers (tenant_id, name, document_type, document_number, iva_condition, address, metadata)
        values (v_tenant, left(coalesce(nullif(v_bill ->> 'name', ''), 'Comprador de Mercado Libre'), 200),
                case when v_bill ->> 'docType' in ('cuit', 'cuil', 'dni', 'passport', 'other') then v_bill ->> 'docType' else 'other' end,
                v_doc,
                case when v_bill ->> 'ivaCondition' in ('consumidor_final', 'responsable_inscripto', 'monotributo',
                                                        'monotributo_social', 'exento', 'no_alcanzado', 'no_categorizado')
                     then v_bill ->> 'ivaCondition' else 'consumidor_final' end,
                left(v_bill ->> 'address', 300),
                jsonb_build_object('source', 'mercadolibre', 'ml_account_id', p_account,
                                   'taxpayer_type', v_bill ->> 'taxpayerRaw'))
        returning id into v_customer;
      end if;
    end if;
  end if;

  -- Líneas: publicación (y variación) vinculada -> producto/variante del POS.
  for v_ord in
    select o.id, o.ml_order_id, o.lines from ml_orders o
     where o.account_id = p_account and o.pack_key = v_pack order by o.ml_order_id
  loop
    for v_l in select value from jsonb_array_elements(v_ord.lines) loop
      v_lp := null; v_lv := null;
      select l.product_id, l.variant_id into v_lp, v_lv
        from ml_item_links l
        join ml_items i on i.id = l.item_id
       where i.account_id = p_account and i.ml_item_id = v_l ->> 'ml_item_id'
         and (l.ml_variation_id is null or l.ml_variation_id::text = coalesce(v_l ->> 'ml_variation_id', ''))
       order by (l.ml_variation_id is null)
       limit 1;
      v_gross := round(coalesce((v_l ->> 'unit_price')::numeric, 0) * coalesce((v_l ->> 'quantity')::numeric, 0), 2);
      v_total := v_total + v_gross;
      v_lines := v_lines || jsonb_build_array(v_l || jsonb_build_object(
        'order_row', v_ord.id, 'product_id', v_lp, 'variant_id', v_lv, 'gross', v_gross));
      v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object(
        'product_id', v_lp, 'variant_id', v_lv,
        'quantity', coalesce((v_l ->> 'quantity')::numeric, 0), 'gross', v_gross));
    end loop;
  end loop;
  if v_total <= 0 then raise exception 'empty_sale'; end if;

  -- Desglose fiscal (letra según emisor y receptor). La venta de ML no lleva
  -- percepciones: el precio lo fijó ML y ya está cobrado.
  v_tax := _sale_tax_compute(v_tenant, v_customer, v_tax_in, v_total, now());

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from sales where tenant_id = v_tenant;

  insert into sales (tenant_id, store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes, channel, channel_ref,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total, created_by)
  values (v_tenant, v_store, null, v_customer, v_number, 'completed',
          v_total, 0,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0),
          v_total, left('Mercado Libre ' || case when nullif(p ->> 'pack_id', '') is not null then 'carrito ' else 'orden ' end || v_pack, 200),
          'mercadolibre', v_pack,
          v_tax ->> 'letter',
          jsonb_build_object('emitter', v_tax -> 'emitter', 'receptor', v_tax -> 'receptor',
                             'requires_identification', v_tax -> 'requires_identification',
                             'warnings', v_tax -> 'warnings'),
          coalesce((v_tax ->> 'net_taxed')::numeric, 0), coalesce((v_tax ->> 'net_exempt')::numeric, 0),
          coalesce((v_tax ->> 'net_untaxed')::numeric, 0), coalesce((v_tax ->> 'iva_total')::numeric, 0),
          coalesce((v_tax ->> 'internal_total')::numeric, 0), 0, null)
  returning * into v_sale_row;
  v_sale := v_sale_row.id;

  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, rate_code, rate, base, amount, arca_id, source)
  select v_tenant, v_sale, 'iva', 'iva', x.code, x.rate, x.base, x.amount, x.arca_id, 'product'
    from jsonb_to_recordset(coalesce(v_tax -> 'iva', '[]'::jsonb))
      as x(code text, rate numeric, base numeric, amount numeric, arca_id int);
  if coalesce((v_tax ->> 'internal_total')::numeric, 0) > 0 then
    insert into sale_tax_lines (tenant_id, sale_id, kind, tax, base, amount, arca_id, source, name)
    values (v_tenant, v_sale, 'internos', 'internos', coalesce((v_tax ->> 'internal_base')::numeric, 0),
            (v_tax ->> 'internal_total')::numeric, 4, 'product', 'Impuestos internos');
  end if;

  -- Renglones y stock (una sola vez; la cancelación revierte lo mismo).
  for v_i in 0 .. jsonb_array_length(v_lines) - 1 loop
    v_l := v_lines -> v_i;
    v_tl := v_tax -> 'lines' -> v_i;
    v_pname := null; v_psku := null; v_track := false; v_taken := 0; v_full_inv := null;
    if nullif(v_l ->> 'product_id', '') is not null then
      select p2.name, p2.sku, coalesce(p2.track_stock, true) and not coalesce(p2.is_kit, false)
        into v_pname, v_psku, v_track
        from products p2 where p2.id = (v_l ->> 'product_id')::uuid and p2.tenant_id = v_tenant;
      if nullif(v_l ->> 'variant_id', '') is not null then
        select v_pname || ' · ' || v.option1 || coalesce(' / ' || v.option2, ''), coalesce(v.sku, v_psku)
          into v_pname, v_psku
          from product_variants v where v.id = (v_l ->> 'variant_id')::uuid and v.tenant_id = v_tenant;
      end if;
    end if;
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale, nullif(v_l ->> 'product_id', '')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
            left(coalesce(v_pname, v_l ->> 'title', 'Publicación de Mercado Libre'), 250),
            coalesce(v_psku, nullif(v_l ->> 'seller_sku', '')), null,
            (v_l ->> 'quantity')::numeric, (v_l ->> 'unit_price')::numeric, 0, (v_l ->> 'gross')::numeric, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
    -- ADR-142: una línea despachada por Full no sale del stock propio (nunca
    -- estuvo en el mostrador); descuenta el depósito Full hasta la próxima
    -- sincronización. Sin el envío normalizado, decide la publicación.
    v_line_full := v_full_pack or (not v_has_ship and exists (
      select 1 from ml_items mi
       where mi.account_id = p_account and mi.ml_item_id = v_l ->> 'ml_item_id'
         and mi.logistic_type = 'fulfillment'));
    if v_line_full then
      v_track := false;
      v_full_lines := v_full_lines + 1;
      if v_full_feat is null then
        v_full_feat := tenant_has_feature_for(v_tenant, 'mercadolibre_full');
      end if;
      if v_full_feat then
        v_full_inv := _ml_full_sale_apply(p_account, v_l ->> 'ml_item_id', v_l ->> 'ml_variation_id',
                                          (v_l ->> 'quantity')::numeric);
      end if;
    end if;
    if v_track then
      v_taken := _ml_stock_apply(v_tenant, v_sale, v_store, v_map.warehouse_id,
                                 (v_l ->> 'product_id')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
                                 (v_l ->> 'quantity')::numeric, 0, 'sale');
    end if;
    v_lines := jsonb_set(v_lines, array[v_i::text],
                         v_l || jsonb_build_object('applied', v_track, 'store_id', v_store,
                                                   'warehouse_id', v_map.warehouse_id, 'wh_taken', v_taken,
                                                   'full', v_line_full, 'full_inventory_id', v_full_inv));
  end loop;

  -- Cobro del canal: sin caja (lo liquida Mercado Pago).
  insert into payments (tenant_id, sale_id, method, amount, reference, card_voucher)
  values (v_tenant, v_sale, 'mercadolibre', v_total, left('ML ' || v_pack, 120), '{}'::jsonb);

  -- Cada orden guarda sus líneas resueltas (para revertir exacto).
  for v_ord in
    select o.id from ml_orders o where o.account_id = p_account and o.pack_key = v_pack
  loop
    select count(*) filter (where nullif(x ->> 'product_id', '') is null) into v_unlinked
      from jsonb_array_elements(v_lines) x where (x ->> 'order_row')::uuid = v_ord.id;
    update ml_orders
       set sale_id = v_sale, stock_applied_at = now(),
           lines = coalesce((select jsonb_agg(x - 'order_row') from jsonb_array_elements(v_lines) x
                              where (x ->> 'order_row')::uuid = v_ord.id), '[]'::jsonb),
           unlinked_lines = coalesce(v_unlinked, 0),
           needs_review = case when coalesce(v_unlinked, 0) > 0
                               then 'Hay publicaciones sin vincular: la venta se registró sin descontar su stock.'
                               else needs_review end,
           invoice_status = case v_acc.invoice_mode when 'none' then 'not_applicable'
                                                    when 'ml_billing' then 'not_applicable'
                                                    else 'pending' end
     where id = v_ord.id;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, null, 'sales', v_sale, 'ml_sale_ingested',
          jsonb_build_object('pack_key', v_pack, 'sale_number', v_number, 'total', v_total,
                             'orders', (select jsonb_agg(o.ml_order_id) from ml_orders o
                                         where o.account_id = p_account and o.pack_key = v_pack),
                             'account_id', p_account, 'full_lines', v_full_lines),
          v_store);

  -- Facturación al pagar (cola ARCA existente; nunca frena la venta).
  if v_acc.invoice_mode = 'on_paid' then
    begin
      v_fiscal := arca_enqueue_sale(v_sale, false);
      if v_fiscal is not null then
        update ml_orders set invoice_status = 'queued', fiscal_document_id = v_fiscal
         where account_id = p_account and pack_key = v_pack;
      end if;
    exception when others then
      raise warning 'ml_ingest_pack arca: %', sqlerrm;
    end;
  end if;

  return jsonb_build_object('ok', true, 'decision', 'create_sale', 'sale_id', v_sale, 'number', v_number,
                            'total', v_total);
end;
$$;
revoke all on function ml_ingest_pack(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_ingest_pack(uuid, jsonb) to service_role;
