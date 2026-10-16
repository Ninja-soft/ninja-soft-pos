-- =============================================================================
-- ADR-165 · F22 · H148 (L5 de ADR-149): expedición robusta.
--
-- Pedido del dueño: el expedicionista tiene su pestaña de pendientes; se
-- puede configurar que escanee los productos para controlar y evitar cruces
-- (o no); marcar si algo está roto y no se puede entregar o entregar parcial;
-- pedir stock a otra sucursal.
--
--   A) Configuración › Logística › Expedición (columnas nuevas en
--      logistics_settings con su lectura y guardado propios, sin tocar
--      _logistics_settings ni logistics_settings_save de L2): escaneo al
--      armar, al cargar y al entregar (no, opcional u obligatorio), entrega
--      parcial sí o no, destino de lo roto (baja como merma o depósito de
--      merma o devolución), foto obligatoria de la rotura y qué hacer con lo
--      que no se entregó (reprogramar solo o dejarlo para revisar).
--   B) Resultado por producto: dispatch_items suma lo pedido, roto,
--      rechazado, faltante, reprogramado y resuelto; qty pasa a ser lo
--      ENTREGADO cuando la entrega cierra con parcial (así dispatch_sale_pending,
--      dispatch_create_for_sale y el trigger de devoluciones siguen contando
--      bien sin recrearlos). dispatches suma la entrega madre, el resultado,
--      el problema abierto, el traslado que espera y los cruces de escaneo.
--   C) Control por producto: dispatch_item_checks (una fila por renglón y
--      etapa), dispatch_scan_log (cada lectura, también las ajenas y los
--      cruces: append-only) y dispatch_damages (cada rotura con foto, motivo
--      y el movimiento de stock).
--   D) Stock siempre consistente, con las funciones de stock existentes:
--      la venta ya descontó lo que va en la entrega. Una rotura es una merma
--      (transfer_move_stock con motivo loss y loss_reason roto, o
--      warehouse_apply al depósito de merma) y lo que la reemplaza sale sin
--      otro movimiento; lo rechazado o lo que no se repone vuelve al stock
--      con la devolución de la venta (Devoluciones), que también devuelve la
--      plata. Nunca se mueve stock dos veces por la misma unidad.
--   E) Reprogramación con entrega hija (parent_dispatch_id) por lo
--      pendiente, con número y parte propios.
--   F) Pedir stock a otra sucursal: transfer_save + transfer_submit (sus
--      reglas de rol y aprobación) con stock_transfers.dispatch_id; al
--      recibir el traslado la entrega deja de esperar (trigger).
--   G) Compuertas del escaneo obligatorio como triggers (sin recrear
--      dispatch_advance, dispatch_deliver, delivery_event_record ni
--      route_start): no se pasa a Listo sin el control de armado, no sale la
--      hoja sin el control de carga y no se entrega sin el control de
--      entrega.
--   H) RPC: dispatch_scan, dispatch_check_justify, dispatch_check_reset,
--      dispatch_damage_report, dispatch_partial_deliver, dispatch_issue_resolve,
--      dispatch_stock_status, dispatch_request_stock, route_items y
--      delivery_items_record (app del repartidor, idempotente por el id del
--      teléfono). Todas SECURITY DEFINER con feature, capacidad, negocio,
--      sucursal y auditoría.
--   I) logistics_media_can (definición viva de L2) suma la carpeta
--      <negocio>/dispatches/<entrega>/ para las fotos de roturas de
--      Expedición.
--
-- Gating: pedidos_despacho (_dispatch_lock) en Expedición; reparto_propio
-- (_route_lock) en la app del repartidor; traslados y multi_sucursal
-- (transfer_assert) para pedir stock. El escaneo es FLAG-OPERATIVO
-- (CLAUDE.md §6, doc 45 §14): sin feature nueva.
-- Capacidades: logistics.prepare en las RPC de Expedición y el repartidor de
-- la hoja con logistics.deliver en las suyas. J) re-siembra el catálogo con
-- logistics.prepare y logistics.track (L3) como enforcement de servidor.
-- No toca create_sale, pos_sale_create_fulfilled, remito_issue, _dispatch_can,
-- dispatch_advance, dispatch_deliver, delivery_event_record, route_start,
-- route_detail ni _logistics_settings. Redefine desde su definición viva:
-- logistics_media_can. Nunca "OR is_internal()" (ADR-052, ADR-152).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración › Logística › Expedición
-- -----------------------------------------------------------------------------
alter table logistics_settings add column if not exists scan_on_pick text not null default 'opcional';
alter table logistics_settings add column if not exists scan_on_load text not null default 'opcional';
alter table logistics_settings add column if not exists scan_on_deliver text not null default 'no';
alter table logistics_settings add column if not exists allow_partial boolean not null default true;
alter table logistics_settings add column if not exists damaged_destination text not null default 'merma';
alter table logistics_settings add column if not exists damage_requires_photo boolean not null default true;
alter table logistics_settings add column if not exists undelivered_action text not null default 'reprogramar';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'logistics_settings_scan_modes_check') then
    alter table logistics_settings add constraint logistics_settings_scan_modes_check check (
      scan_on_pick in ('no', 'opcional', 'obligatorio')
      and scan_on_load in ('no', 'opcional', 'obligatorio')
      and scan_on_deliver in ('no', 'opcional', 'obligatorio'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'logistics_settings_damaged_destination_check') then
    alter table logistics_settings add constraint logistics_settings_damaged_destination_check
      check (damaged_destination in ('merma', 'deposito'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'logistics_settings_undelivered_action_check') then
    alter table logistics_settings add constraint logistics_settings_undelivered_action_check
      check (undelivered_action in ('reprogramar', 'revisar'));
  end if;
end;
$$;
comment on column logistics_settings.scan_on_pick is 'ADR-165: escaneo al armar (no, opcional, obligatorio). Obligatorio: no pasa a Listo sin completar o justificar.';
comment on column logistics_settings.scan_on_load is 'ADR-165: escaneo al cargar el camión. Obligatorio: la hoja no sale sin el control de carga.';
comment on column logistics_settings.scan_on_deliver is 'ADR-165: escaneo al entregar (repartidor o mostrador). Obligatorio: no se marca entregado sin escanear lo entregado.';
comment on column logistics_settings.damaged_destination is 'ADR-165: lo roto se da de baja como merma (loss/roto) o va al depósito de merma o devolución de la sucursal.';
comment on column logistics_settings.undelivered_action is 'ADR-165: lo que faltó o se rompió en una entrega parcial se reprograma solo (entrega hija) o queda en Con problemas para revisar.';

-- Configuración efectiva de Expedición (defaults si no hay fila).
create or replace function _expedition_settings(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'scan_on_pick', coalesce(s.scan_on_pick, 'opcional'),
    'scan_on_load', coalesce(s.scan_on_load, 'opcional'),
    'scan_on_deliver', coalesce(s.scan_on_deliver, 'no'),
    'allow_partial', coalesce(s.allow_partial, true),
    'damaged_destination', coalesce(s.damaged_destination, 'merma'),
    'damage_requires_photo', coalesce(s.damage_requires_photo, true),
    'undelivered_action', coalesce(s.undelivered_action, 'reprogramar'),
    'saved', s.tenant_id is not null)
    from (select 1) one
    left join logistics_settings s on s.tenant_id = p_tenant;
$$;
revoke all on function _expedition_settings(uuid) from public, anon, authenticated;

create or replace function public.expedition_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or stock_my_role() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  return _expedition_settings(v_tenant);
end;
$$;
revoke all on function public.expedition_settings_get() from public, anon;
grant execute on function public.expedition_settings_get() to authenticated;

create or replace function public.expedition_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before jsonb;
  k        text;
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'pedidos_despacho') then
    raise exception 'feature_not_in_plan: pedidos_despacho' using errcode = 'check_violation';
  end if;
  if not member_has_capability(v_tenant, 'logistics.settings') then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:logistics.settings';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_settings';
  end if;
  foreach k in array array['scan_on_pick', 'scan_on_load', 'scan_on_deliver'] loop
    if p ? k and (p ->> k) not in ('no', 'opcional', 'obligatorio') then
      raise exception 'invalid_settings' using detail = k;
    end if;
  end loop;
  if p ? 'damaged_destination' and (p ->> 'damaged_destination') not in ('merma', 'deposito') then
    raise exception 'invalid_settings' using detail = 'damaged_destination';
  end if;
  if p ? 'undelivered_action' and (p ->> 'undelivered_action') not in ('reprogramar', 'revisar') then
    raise exception 'invalid_settings' using detail = 'undelivered_action';
  end if;
  foreach k in array array['allow_partial', 'damage_requires_photo'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'boolean' then
      raise exception 'invalid_settings' using detail = k;
    end if;
  end loop;

  v_before := _expedition_settings(v_tenant);
  insert into logistics_settings (tenant_id) values (v_tenant) on conflict (tenant_id) do nothing;
  update logistics_settings set
    scan_on_pick = coalesce(nullif(p ->> 'scan_on_pick', ''), scan_on_pick),
    scan_on_load = coalesce(nullif(p ->> 'scan_on_load', ''), scan_on_load),
    scan_on_deliver = coalesce(nullif(p ->> 'scan_on_deliver', ''), scan_on_deliver),
    allow_partial = coalesce((p ->> 'allow_partial')::boolean, allow_partial),
    damaged_destination = coalesce(nullif(p ->> 'damaged_destination', ''), damaged_destination),
    damage_requires_photo = coalesce((p ->> 'damage_requires_photo')::boolean, damage_requires_photo),
    undelivered_action = coalesce(nullif(p ->> 'undelivered_action', ''), undelivered_action),
    updated_by = auth.uid()
  where tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'logistics_settings', v_tenant, 'expedition_settings_saved',
          v_before - 'saved', _expedition_settings(v_tenant) - 'saved');
  return _expedition_settings(v_tenant);
end;
$$;
revoke all on function public.expedition_settings_save(jsonb) from public, anon;
grant execute on function public.expedition_settings_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Resultado por producto y problemas de la entrega
-- -----------------------------------------------------------------------------
alter table dispatch_items add column if not exists qty_ordered numeric(12,3);
alter table dispatch_items add column if not exists qty_damaged numeric(12,3) not null default 0;
alter table dispatch_items add column if not exists qty_rejected numeric(12,3) not null default 0;
alter table dispatch_items add column if not exists qty_missing numeric(12,3) not null default 0;
alter table dispatch_items add column if not exists qty_rescheduled numeric(12,3) not null default 0;
alter table dispatch_items add column if not exists qty_settled numeric(12,3) not null default 0;
alter table dispatch_items add column if not exists parent_item_id uuid references dispatch_items(id) on delete set null;
alter table dispatch_items add column if not exists outcome_at timestamptz;
do $$
begin
  -- Un renglón que no se entregó nada queda en 0 (con lo pedido guardado).
  if exists (select 1 from pg_constraint where conname = 'dispatch_items_qty_check') then
    alter table dispatch_items drop constraint dispatch_items_qty_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dispatch_items_qty_l5_check') then
    alter table dispatch_items add constraint dispatch_items_qty_l5_check
      check (qty >= 0 and (qty > 0 or qty_ordered is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dispatch_items_outcome_check') then
    alter table dispatch_items add constraint dispatch_items_outcome_check check (
      qty_damaged >= 0 and qty_rejected >= 0 and qty_missing >= 0 and qty_rescheduled >= 0 and qty_settled >= 0
      and qty_rescheduled + qty_settled <= qty_damaged + qty_rejected + qty_missing + 0.0005
      and (qty_ordered is null or qty + qty_damaged + qty_rejected + qty_missing <= qty_ordered + 0.0005));
  end if;
end;
$$;
create index if not exists dispatch_items_parent_idx on dispatch_items (parent_item_id) where parent_item_id is not null;
comment on column dispatch_items.qty is 'Cantidad de la entrega. ADR-165: al cerrar con parcial pasa a ser lo ENTREGADO (lo pedido queda en qty_ordered).';
comment on column dispatch_items.qty_ordered is 'ADR-165: lo que tenía la entrega antes del resultado por producto.';
comment on column dispatch_items.qty_rescheduled is 'ADR-165: de lo roto, rechazado o faltante, cuánto pasó a una entrega hija.';
comment on column dispatch_items.qty_settled is 'ADR-165: de lo roto, rechazado o faltante, cuánto se resolvió (devolución de la venta).';

alter table dispatches add column if not exists parent_dispatch_id uuid references dispatches(id) on delete set null;
alter table dispatches add column if not exists delivery_result text;
alter table dispatches add column if not exists issue_open boolean not null default false;
alter table dispatches add column if not exists issue_summary text;
alter table dispatches add column if not exists awaiting_transfer_id uuid references stock_transfers(id) on delete set null;
alter table dispatches add column if not exists stock_arrived_at timestamptz;
alter table dispatches add column if not exists scan_alerts integer not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dispatches_delivery_result_check') then
    alter table dispatches add constraint dispatches_delivery_result_check
      check (delivery_result is null or delivery_result in ('completa', 'parcial'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dispatches_issue_summary_check') then
    alter table dispatches add constraint dispatches_issue_summary_check
      check (issue_summary is null or char_length(issue_summary) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dispatches_scan_alerts_check') then
    alter table dispatches add constraint dispatches_scan_alerts_check check (scan_alerts >= 0);
  end if;
end;
$$;
create index if not exists dispatches_parent_idx on dispatches (parent_dispatch_id) where parent_dispatch_id is not null;
create index if not exists dispatches_issue_idx on dispatches (tenant_id) where issue_open;
create index if not exists dispatches_awaiting_transfer_idx on dispatches (awaiting_transfer_id) where awaiting_transfer_id is not null;
comment on column dispatches.parent_dispatch_id is 'ADR-165: entrega de la que salió esta (reprogramación de lo pendiente).';
comment on column dispatches.issue_open is 'ADR-165: quedó algo roto, rechazado o faltante sin reprogramar ni resolver (pestaña Con problemas).';
comment on column dispatches.awaiting_transfer_id is 'ADR-165: traslado pedido a otra sucursal para esta entrega; se limpia solo al recibirlo.';
grant select (parent_dispatch_id, delivery_result, issue_open, issue_summary, awaiting_transfer_id, stock_arrived_at, scan_alerts)
  on dispatches to authenticated;

alter table stock_transfers add column if not exists dispatch_id uuid references dispatches(id) on delete set null;
create index if not exists stock_transfers_dispatch_idx on stock_transfers (dispatch_id) where dispatch_id is not null;
comment on column stock_transfers.dispatch_id is 'ADR-165: entrega de Expedición que pidió este traslado (pedir stock a otra sucursal).';

-- Los eventos y los resultados de parada conocen lo parcial y la rotura.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'delivery_events_type_check') then
    alter table delivery_events drop constraint delivery_events_type_check;
  end if;
  alter table delivery_events add constraint delivery_events_type_check check (type in (
    'salida', 'llegada', 'entregado', 'entregado_parcial', 'no_entregado', 'rotura', 'nota', 'regreso'));
  if exists (select 1 from pg_constraint where conname = 'route_stop_dispatches_outcome_check') then
    alter table route_stop_dispatches drop constraint route_stop_dispatches_outcome_check;
  end if;
  alter table route_stop_dispatches add constraint route_stop_dispatches_outcome_check
    check (outcome in ('pendiente', 'entregado', 'parcial', 'no_entregado', 'quitado'));
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Control por producto, lecturas y roturas
-- -----------------------------------------------------------------------------
create table if not exists dispatch_item_checks (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  dispatch_id          uuid not null references dispatches(id) on delete cascade,
  dispatch_item_id     uuid not null references dispatch_items(id) on delete cascade,
  -- Copias de la entrega para el alcance por sucursal (RESTRICTIVE).
  store_id             uuid not null references stores(id),
  fulfillment_store_id uuid not null references stores(id),
  stage                text not null check (stage in ('armado', 'carga', 'entrega')),
  route_id             uuid references delivery_routes(id) on delete set null,
  qty_expected         numeric(12,3) not null check (qty_expected >= 0),
  qty_scanned          numeric(12,3) not null default 0 check (qty_scanned >= 0),
  scanned_codes        text[] not null default '{}' check (cardinality(scanned_codes) <= 200),
  manual               boolean not null default false,
  difference_reason    text check (difference_reason is null or difference_reason in
                         ('faltante', 'danado', 'vencido', 'error_despacho', 'sobrante', 'sin_codigo', 'otro')),
  difference_note      text check (difference_note is null or char_length(difference_note) <= 300),
  checked_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint dispatch_item_checks_stage_key unique (dispatch_item_id, stage)
);
comment on table dispatch_item_checks is
  'ADR-165: control de cada renglón en cada etapa (armado, carga, entrega): cuánto se esperaba, cuánto se escaneó y, si no coincide, el motivo. Sólo por RPC.';
create index if not exists dispatch_item_checks_dispatch_idx on dispatch_item_checks (dispatch_id, stage);
create index if not exists dispatch_item_checks_tenant_idx on dispatch_item_checks (tenant_id);
create index if not exists dispatch_item_checks_store_idx on dispatch_item_checks (store_id);
create index if not exists dispatch_item_checks_ful_idx on dispatch_item_checks (fulfillment_store_id);
create index if not exists dispatch_item_checks_route_idx on dispatch_item_checks (route_id) where route_id is not null;
create index if not exists dispatch_item_checks_by_idx on dispatch_item_checks (checked_by) where checked_by is not null;

create table if not exists dispatch_scan_log (
  id                uuid primary key,
  tenant_id         uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id          uuid not null references stores(id),
  dispatch_id       uuid references dispatches(id) on delete cascade,
  route_id          uuid references delivery_routes(id) on delete cascade,
  stage             text not null check (stage in ('armado', 'carga', 'entrega')),
  code              text check (code is null or char_length(code) <= 80),
  qty               numeric(12,3) not null default 1 check (qty > 0),
  result            text not null check (result in ('ok', 'excedente', 'ajeno', 'cruce', 'desconocido', 'manual')),
  dispatch_item_id  uuid references dispatch_items(id) on delete set null,
  product_id        uuid references products(id) on delete set null,
  variant_id        uuid references product_variants(id) on delete set null,
  other_dispatch_id uuid references dispatches(id) on delete set null,
  actor_user_id     uuid references public.users(id) on delete set null,
  device_id         text check (device_id is null or char_length(device_id) <= 80),
  created_at        timestamptz not null default now(),
  constraint dispatch_scan_log_scope_check check (dispatch_id is not null or route_id is not null)
);
comment on table dispatch_scan_log is
  'ADR-165: cada lectura del escáner en Expedición, la carga o la entrega, también las de productos ajenos (cruces). Append-only; el id lo genera la pantalla (idempotente).';
create index if not exists dispatch_scan_log_dispatch_idx on dispatch_scan_log (dispatch_id, created_at) where dispatch_id is not null;
create index if not exists dispatch_scan_log_route_idx on dispatch_scan_log (route_id, created_at) where route_id is not null;
create index if not exists dispatch_scan_log_tenant_idx on dispatch_scan_log (tenant_id, created_at desc);
create index if not exists dispatch_scan_log_store_idx on dispatch_scan_log (store_id);
create index if not exists dispatch_scan_log_item_idx on dispatch_scan_log (dispatch_item_id) where dispatch_item_id is not null;
create index if not exists dispatch_scan_log_product_idx on dispatch_scan_log (product_id) where product_id is not null;
create index if not exists dispatch_scan_log_variant_idx on dispatch_scan_log (variant_id) where variant_id is not null;
create index if not exists dispatch_scan_log_other_idx on dispatch_scan_log (other_dispatch_id) where other_dispatch_id is not null;
create index if not exists dispatch_scan_log_actor_idx on dispatch_scan_log (actor_user_id) where actor_user_id is not null;

create table if not exists dispatch_damages (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  dispatch_id      uuid not null references dispatches(id) on delete cascade,
  dispatch_item_id uuid not null references dispatch_items(id) on delete cascade,
  store_id         uuid not null references stores(id),
  stage            text not null check (stage in ('armado', 'carga', 'entrega')),
  route_id         uuid references delivery_routes(id) on delete set null,
  event_id         uuid,
  product_id       uuid not null references products(id),
  variant_id       uuid references product_variants(id),
  qty              numeric(12,3) not null check (qty > 0),
  reason_key       text not null check (reason_key in ('roto', 'mal_estado', 'vencido', 'otro')),
  note             text check (note is null or char_length(note) <= 300),
  photo_paths      text[] not null default '{}' check (cardinality(photo_paths) <= 6),
  destination      text not null check (destination in ('merma', 'deposito', 'sin_stock')),
  warehouse_id     uuid references warehouses(id) on delete set null,
  stock_ref        uuid,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
comment on table dispatch_damages is
  'ADR-165: roturas de una entrega (al armar, al cargar o en la calle) con foto, motivo y adónde fue el stock: baja como merma, depósito de merma o sin stock (kits y productos sin control). Append-only.';
create index if not exists dispatch_damages_dispatch_idx on dispatch_damages (dispatch_id);
create index if not exists dispatch_damages_item_idx on dispatch_damages (dispatch_item_id);
create index if not exists dispatch_damages_tenant_idx on dispatch_damages (tenant_id, created_at desc);
create index if not exists dispatch_damages_store_idx on dispatch_damages (store_id);
create index if not exists dispatch_damages_route_idx on dispatch_damages (route_id) where route_id is not null;
create index if not exists dispatch_damages_product_idx on dispatch_damages (product_id);
create index if not exists dispatch_damages_variant_idx on dispatch_damages (variant_id) where variant_id is not null;
create index if not exists dispatch_damages_wh_idx on dispatch_damages (warehouse_id) where warehouse_id is not null;
create index if not exists dispatch_damages_by_idx on dispatch_damages (created_by) where created_by is not null;

drop trigger if exists set_updated_at_dispatch_item_checks on dispatch_item_checks;
create trigger set_updated_at_dispatch_item_checks
  before update on dispatch_item_checks
  for each row execute function set_updated_at();

alter table dispatch_item_checks enable row level security;
alter table dispatch_scan_log enable row level security;
alter table dispatch_damages enable row level security;
revoke all on dispatch_item_checks, dispatch_scan_log, dispatch_damages from anon, authenticated;
grant select on dispatch_item_checks, dispatch_scan_log, dispatch_damages to authenticated;

drop policy if exists dispatch_item_checks_select on dispatch_item_checks;
create policy dispatch_item_checks_select on dispatch_item_checks
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists dispatch_item_checks_branch_scope on dispatch_item_checks;
create policy dispatch_item_checks_branch_scope on dispatch_item_checks
  as restrictive for select
  using (
    (select internal_scope())
    or store_id = any ((select user_allowed_store_ids())::uuid[])
    or fulfillment_store_id = any ((select user_allowed_store_ids())::uuid[])
  );

drop policy if exists dispatch_scan_log_select on dispatch_scan_log;
create policy dispatch_scan_log_select on dispatch_scan_log
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists dispatch_scan_log_branch_scope on dispatch_scan_log;
create policy dispatch_scan_log_branch_scope on dispatch_scan_log
  as restrictive for select
  using ((select internal_scope()) or store_id = any ((select user_allowed_store_ids())::uuid[]));

drop policy if exists dispatch_damages_select on dispatch_damages;
create policy dispatch_damages_select on dispatch_damages
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists dispatch_damages_branch_scope on dispatch_damages;
create policy dispatch_damages_branch_scope on dispatch_damages
  as restrictive for select
  using ((select internal_scope()) or store_id = any ((select user_allowed_store_ids())::uuid[]));

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
-- Modo de escaneo de una etapa.
create or replace function _exp_scan_mode(p_tenant uuid, p_stage text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(case p_stage
                    when 'armado' then s.scan_on_pick
                    when 'carga' then s.scan_on_load
                    when 'entrega' then s.scan_on_deliver
                  end,
                  case p_stage when 'entrega' then 'no' else 'opcional' end)
    from (select 1) one
    left join logistics_settings s on s.tenant_id = p_tenant;
$$;
revoke all on function _exp_scan_mode(uuid, text) from public, anon, authenticated;

-- Códigos con los que se reconoce un renglón (código de barras y SKU de la
-- variante o del producto), normalizados en mayúsculas.
create or replace function _exp_item_codes(p_product uuid, p_variant uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct c) filter (where c is not null and c <> ''), '{}')
    from (
      select upper(btrim(v.barcode)) as c from product_variants v where v.id = p_variant
      union all select upper(btrim(v.sku)) from product_variants v where v.id = p_variant
      union all select upper(btrim(p.barcode)) from products p where p.id = p_product
      union all select upper(btrim(p.sku)) from products p where p.id = p_product
    ) x;
$$;
revoke all on function _exp_item_codes(uuid, uuid) from public, anon, authenticated;

-- Productos (y variantes) del negocio que se leen con este código.
create or replace function _exp_code_products(p_tenant uuid, p_code text)
returns table (product_id uuid, variant_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select v.product_id, v.id
    from product_variants v
   where v.tenant_id = p_tenant and v.deleted_at is null
     and (upper(btrim(v.barcode)) = p_code or upper(btrim(v.sku)) = p_code)
  union
  select p.id, null::uuid
    from products p
   where p.tenant_id = p_tenant and p.deleted_at is null
     and (upper(btrim(p.barcode)) = p_code or upper(btrim(p.sku)) = p_code);
$$;
revoke all on function _exp_code_products(uuid, text) from public, anon, authenticated;

-- ¿Está completo el control de una entrega en una etapa? Cada renglón con
-- cantidad tiene lo escaneado igual o mayor que lo esperado, o un motivo.
create or replace function _exp_check_complete(p_dispatch uuid, p_stage text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (
    select 1
      from dispatch_items di
      left join dispatch_item_checks c on c.dispatch_item_id = di.id and c.stage = p_stage
     where di.dispatch_id = p_dispatch and di.qty > 0
       and (c.id is null or (c.qty_scanned + 0.0005 < di.qty and c.difference_reason is null)));
$$;
revoke all on function _exp_check_complete(uuid, text) from public, anon, authenticated;

-- ¿Está cargada toda la hoja? (todas las entregas que viajan en ella).
create or replace function _exp_route_load_complete(p_route uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (
    select 1 from route_stop_dispatches x
     where x.route_id = p_route and x.outcome = 'pendiente'
       and not _exp_check_complete(x.dispatch_id, 'carga'));
$$;
revoke all on function _exp_route_load_complete(uuid) from public, anon, authenticated;

-- Pendiente de resolver de un renglón (roto, rechazado o faltante que no se
-- reprogramó ni se resolvió).
create or replace function _exp_item_open(di dispatch_items)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select greatest(di.qty_damaged + di.qty_rejected + di.qty_missing - di.qty_rescheduled - di.qty_settled, 0);
$$;
revoke all on function _exp_item_open(dispatch_items) from public, anon, authenticated;

-- Cantidad para leer: 1, 2,5 (sin ceros de más).
create or replace function _exp_qty_txt(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select replace(case when position('.' in p::text) > 0 then rtrim(rtrim(p::text, '0'), '.') else p::text end, '.', ',');
$$;
revoke all on function _exp_qty_txt(numeric) from public, anon, authenticated;

-- Recalcula el problema abierto de la entrega y su resumen ("1 roto, 2 rechazados").
create or replace function _exp_refresh_issue(p_dispatch uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_open boolean;
  v_dmg  numeric;
  v_rej  numeric;
  v_mis  numeric;
  v_sum  text;
begin
  select coalesce(bool_or(_exp_item_open(di) > 0.0005), false),
         coalesce(sum(di.qty_damaged), 0), coalesce(sum(di.qty_rejected), 0), coalesce(sum(di.qty_missing), 0)
    into v_open, v_dmg, v_rej, v_mis
    from dispatch_items di where di.dispatch_id = p_dispatch;
  v_sum := nullif(concat_ws(', ',
    case when v_dmg > 0 then _exp_qty_txt(v_dmg) || case when v_dmg = 1 then ' roto' else ' rotos' end end,
    case when v_rej > 0 then _exp_qty_txt(v_rej) || case when v_rej = 1 then ' rechazado' else ' rechazados' end end,
    case when v_mis > 0 then _exp_qty_txt(v_mis) || ' sin entregar' end), '');
  update dispatches set issue_open = v_open, issue_summary = left(v_sum, 200)
   where id = p_dispatch and (issue_open is distinct from v_open or issue_summary is distinct from left(v_sum, 200));
  return v_open;
end;
$$;
revoke all on function _exp_refresh_issue(uuid) from public, anon, authenticated;

-- Ruta de un archivo de la entrega: <negocio>/dispatches/<entrega>/<archivo>.
create or replace function _dispatch_media_ok(p_tenant uuid, p_dispatch uuid, p_path text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_path is null
      or p_path ~ ('^' || p_tenant::text || '/dispatches/' || p_dispatch::text || '/[A-Za-z0-9._-]{1,120}$');
$$;
revoke all on function _dispatch_media_ok(uuid, uuid, text) from public, anon, authenticated;

-- Capacidad de armar y despachar (Expedición). Devuelve el negocio.
create or replace function _exp_prepare_assert(p_tenant uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not member_has_capability(p_tenant, 'logistics.prepare') then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:logistics.prepare';
  end if;
  return p_tenant;
end;
$$;
revoke all on function _exp_prepare_assert(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Stock: rotura como merma (o al depósito de merma) con las funciones de
--    stock existentes. La venta ya descontó la unidad que se rompió: la
--    merma da de baja la unidad perdida y la que la reemplaza sale sin otro
--    movimiento.
-- -----------------------------------------------------------------------------
create or replace function _exp_register_damage(
  p_d       dispatches,
  p_item    dispatch_items,
  p_qty     numeric,
  p_stage   text,
  p_reason  text,
  p_note    text,
  p_photos  text[],
  p_route   uuid,
  p_event   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg   jsonb := _expedition_settings(p_d.tenant_id);
  v_store uuid := case when p_d.arrived_at is not null then p_d.fulfillment_store_id else p_d.store_id end;
  v_prod  record;
  v_wh    uuid;
  v_dest  text;
  v_ref   uuid := gen_random_uuid();
  v_id    uuid;
  v_label text := 'Rotura en la entrega N° ' || p_d.number
                  || case p_stage when 'armado' then ' (al armar)' when 'carga' then ' (al cargar)' else ' (en la entrega)' end;
begin
  if p_qty is null or p_qty <= 0 then
    return null;
  end if;
  if p_reason is null or p_reason not in ('roto', 'mal_estado', 'vencido', 'otro') then
    raise exception 'damage_reason_required';
  end if;
  if p_reason = 'otro' and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'damage_note_required';
  end if;
  if (v_cfg ->> 'damage_requires_photo')::boolean and coalesce(cardinality(p_photos), 0) = 0 then
    raise exception 'damage_photo_required';
  end if;
  select coalesce(p.track_stock, true) as track, coalesce(p.is_kit, false) as is_kit, coalesce(p.is_service, false) as is_service
    into v_prod from products p where p.id = p_item.product_id;

  if not v_prod.track or v_prod.is_kit or v_prod.is_service then
    v_dest := 'sin_stock';
  elsif v_cfg ->> 'damaged_destination' = 'deposito' then
    select w.id into v_wh from warehouses w
     where w.tenant_id = p_d.tenant_id and w.store_id = v_store and w.deleted_at is null and w.kind in ('merma', 'devolucion')
     order by (w.kind = 'merma') desc, w.sort, w.created_at
     limit 1;
  end if;

  if v_dest is null and v_wh is not null then
    -- Al depósito de merma: la unidad rota sigue en el total de la sucursal,
    -- fuera de lo vendible, hasta que se descarte o se reclame.
    perform warehouse_apply(p_d.tenant_id, v_wh, p_item.product_id, p_item.variant_id, p_qty);
    v_dest := 'deposito';
  elsif v_dest is null then
    -- Baja como merma (motivo loss, sub-motivo roto o vencido).
    perform transfer_move_stock(p_d.tenant_id, v_store, p_item.product_id, p_item.variant_id, -p_qty, 'loss', v_ref,
                                left(v_label || coalesce(': ' || nullif(btrim(p_note), ''), ''), 300));
    update stock_movements set loss_reason = case p_reason when 'vencido' then 'vencido' when 'otro' then 'otro' else 'roto' end
     where tenant_id = p_d.tenant_id and reference_id = v_ref and reason = 'loss';
    v_dest := 'merma';
  end if;

  insert into dispatch_damages (tenant_id, dispatch_id, dispatch_item_id, store_id, stage, route_id, event_id, product_id,
                                variant_id, qty, reason_key, note, photo_paths, destination, warehouse_id, stock_ref, created_by)
  values (p_d.tenant_id, p_d.id, p_item.id, v_store, p_stage, p_route, p_event, p_item.product_id, p_item.variant_id,
          p_qty, p_reason, left(nullif(btrim(coalesce(p_note, '')), ''), 300), coalesce(p_photos, '{}'), v_dest, v_wh,
          case when v_dest = 'merma' then v_ref end, auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason, store_id)
  values (p_d.tenant_id, auth.uid(), 'dispatches', p_d.id, 'dispatch_item_damaged',
          jsonb_build_object('damage_id', v_id, 'item_id', p_item.id, 'product_id', p_item.product_id,
                             'variant_id', p_item.variant_id, 'qty', p_qty, 'stage', p_stage, 'destination', v_dest,
                             'warehouse_id', v_wh, 'photos', coalesce(cardinality(p_photos), 0), 'route_id', p_route),
          p_reason || coalesce(': ' || left(nullif(btrim(p_note), ''), 200), ''), v_store);
  return jsonb_build_object('id', v_id, 'qty', p_qty, 'destination', v_dest);
end;
$$;
revoke all on function _exp_register_damage(dispatches, dispatch_items, numeric, text, text, text, text[], uuid, uuid)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Entrega hija con lo pendiente (p_lines: [{item_id, qty}])
-- -----------------------------------------------------------------------------
create or replace function _exp_spawn_child(p_d dispatches, p_lines jsonb, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id     uuid;
  v_number int;
  v_part   int;
  v_n      int;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or not exists (
    select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric) where l.qty > 0) then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtext('dispatch_number:' || p_d.tenant_id::text));
  select coalesce(max(number), 0) + 1 into v_number from dispatches where tenant_id = p_d.tenant_id;
  select coalesce(max(part), 0) + 1 into v_part from dispatches where sale_id = p_d.sale_id;
  if v_part > 20 then
    raise exception 'too_many_deliveries';
  end if;
  update dispatches set parts_total = v_part where sale_id = p_d.sale_id and parts_total < v_part;

  insert into dispatches (
    tenant_id, number, sale_id, sale_order_id, store_id, fulfillment_store_id, sale_store_id, delivery_type, status,
    customer_name, pickup_name, ship_address, address_id, ship_to, notes, part, parts_total, fulfillment_id,
    created_by, parent_dispatch_id, sent_by, sent_at, arrived_by, arrived_at
  ) values (
    p_d.tenant_id, v_number, p_d.sale_id, p_d.sale_order_id, p_d.store_id, p_d.fulfillment_store_id, p_d.sale_store_id,
    p_d.delivery_type, 'pendiente', p_d.customer_name, p_d.pickup_name, p_d.ship_address, p_d.address_id, p_d.ship_to,
    left('Reprogramada de la N° ' || p_d.number || coalesce('. ' || nullif(btrim(p_note), ''), ''), 500),
    v_part, v_part, p_d.fulfillment_id, auth.uid(), p_d.id, p_d.sent_by, p_d.sent_at, p_d.arrived_by, p_d.arrived_at
  )
  returning id into v_id;

  insert into dispatch_items (
    tenant_id, dispatch_id, sale_id, store_id, fulfillment_store_id, sale_store_id, product_id, variant_id,
    product_name, variant_label, sku, unit, qty, source_store_id, source_warehouse_id, sort, parent_item_id
  )
  select di.tenant_id, v_id, di.sale_id, di.store_id, di.fulfillment_store_id, di.sale_store_id, di.product_id,
         di.variant_id, di.product_name, di.variant_label, di.sku, di.unit, l.qty, di.source_store_id,
         di.source_warehouse_id, di.sort, di.id
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
    join dispatch_items di on di.id = l.item_id and di.dispatch_id = p_d.id
   where l.qty > 0;
  get diagnostics v_n = row_count;

  update dispatch_items di
     set qty_rescheduled = di.qty_rescheduled + l.qty
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
   where di.id = l.item_id and di.dispatch_id = p_d.id and l.qty > 0;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason, store_id)
  values (p_d.tenant_id, auth.uid(), 'dispatches', v_id, 'dispatch_rescheduled',
          jsonb_build_object('number', v_number, 'parent_id', p_d.id, 'parent_number', p_d.number, 'part', v_part,
                             'items', v_n, 'lines', p_lines),
          left(nullif(btrim(coalesce(p_note, '')), ''), 300), p_d.store_id);
  return jsonb_build_object('id', v_id, 'number', v_number, 'part', v_part);
end;
$$;
revoke all on function _exp_spawn_child(dispatches, jsonb, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Resultado por producto de una entrega. p_items: [{item_id, delivered,
-- damaged, rejected}] (lo que no se lista se entregó entero; lo que no suma
-- queda como faltante). p_ctx: {stage, route_id, event_id, reason_key, note,
-- photo_paths (de la rotura), scans: {item_id: qty}}.
-- Con algo entregado, el renglón queda con lo entregado y lo demás se
-- reprograma (lo roto y lo faltante, si la configuración lo pide) o queda en
-- Con problemas; sin nada entregado, la entrega no cambia (sigue debiendo
-- todo) y sólo se registra la rotura. Lo llaman delivery_items_record y
-- dispatch_partial_deliver, que cambian el estado.
-- -----------------------------------------------------------------------------
create or replace function _exp_apply_outcome(p_d dispatches, p_items jsonb, p_ctx jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg      jsonb := _expedition_settings(p_d.tenant_id);
  v_photos   text[];
  it         dispatch_items;
  v_in       jsonb;
  v_del      numeric;
  v_dmg      numeric;
  v_rej      numeric;
  v_mis      numeric;
  v_tot_del  numeric := 0;
  v_tot_qty  numeric := 0;
  v_tot_dmg  numeric := 0;
  v_tot_rej  numeric := 0;
  v_tot_mis  numeric := 0;
  v_rows     jsonb := '[]'::jsonb;
  v_r        jsonb;
  v_child    jsonb;
  v_lines    jsonb := '[]'::jsonb;
  v_open     boolean;
  v_scan     numeric;
  v_stage    text := coalesce(p_ctx ->> 'stage', 'entrega');
  v_route    uuid := _uuid_or_null(p_ctx ->> 'route_id');
  v_event    uuid := _uuid_or_null(p_ctx ->> 'event_id');
begin
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
     where not exists (select 1 from dispatch_items di
                        where di.id = _uuid_or_null(x ->> 'item_id') and di.dispatch_id = p_d.id)) then
    raise exception 'item_not_in_dispatch';
  end if;
  select coalesce(array_agg(x), '{}') into v_photos
    from jsonb_array_elements_text(case when jsonb_typeof(p_ctx -> 'photo_paths') = 'array' then p_ctx -> 'photo_paths'
                                        else '[]'::jsonb end) x;
  if cardinality(v_photos) > 6 then
    raise exception 'too_many_photos';
  end if;

  -- Primero se valida todo y se suma.
  for it in select * from dispatch_items where dispatch_id = p_d.id and qty > 0 order by sort, id for update loop
    select x into v_in from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
     where _uuid_or_null(x ->> 'item_id') = it.id limit 1;
    v_dmg := coalesce(nullif(v_in ->> 'damaged', '')::numeric, 0);
    v_rej := coalesce(nullif(v_in ->> 'rejected', '')::numeric, 0);
    v_del := case when v_in is null then it.qty
                  else coalesce(nullif(v_in ->> 'delivered', '')::numeric, greatest(it.qty - v_dmg - v_rej, 0)) end;
    if v_del < 0 or v_dmg < 0 or v_rej < 0 or v_del + v_dmg + v_rej > it.qty + 0.0005 then
      raise exception 'invalid_item_qty' using detail = it.product_name;
    end if;
    v_mis := greatest(it.qty - v_del - v_dmg - v_rej, 0);
    v_tot_qty := v_tot_qty + it.qty;
    v_tot_del := v_tot_del + v_del;
    v_tot_dmg := v_tot_dmg + v_dmg;
    v_tot_rej := v_tot_rej + v_rej;
    v_tot_mis := v_tot_mis + v_mis;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'item_id', it.id, 'qty', it.qty, 'delivered', v_del, 'damaged', v_dmg, 'rejected', v_rej, 'missing', v_mis));
  end loop;
  if jsonb_array_length(v_rows) = 0 then
    raise exception 'dispatch_without_items';
  end if;
  if v_tot_del > 0.0005 and v_tot_del + 0.0005 < v_tot_qty and not (v_cfg ->> 'allow_partial')::boolean then
    raise exception 'partial_not_allowed';
  end if;

  -- Escaneo de la entrega (lo que manda el teléfono o el mostrador).
  if jsonb_typeof(p_ctx -> 'scans') = 'object' then
    for v_r in select * from jsonb_array_elements(v_rows) loop
      v_scan := nullif(p_ctx -> 'scans' ->> (v_r ->> 'item_id'), '')::numeric;
      if v_scan is not null and v_scan >= 0 then
        insert into dispatch_item_checks (tenant_id, dispatch_id, dispatch_item_id, store_id, fulfillment_store_id, stage,
                                          route_id, qty_expected, qty_scanned, checked_by)
        values (p_d.tenant_id, p_d.id, (v_r ->> 'item_id')::uuid, p_d.store_id, p_d.fulfillment_store_id, 'entrega',
                v_route, (v_r ->> 'delivered')::numeric, least(v_scan, 99999), auth.uid())
        on conflict (dispatch_item_id, stage) do update
          set qty_scanned = greatest(dispatch_item_checks.qty_scanned, excluded.qty_scanned),
              qty_expected = excluded.qty_expected, route_id = coalesce(excluded.route_id, dispatch_item_checks.route_id),
              checked_by = excluded.checked_by;
      end if;
    end loop;
  end if;

  -- Roturas: merma (o depósito) con foto y motivo.
  for v_r in select * from jsonb_array_elements(v_rows) where (value ->> 'damaged')::numeric > 0 loop
    select * into it from dispatch_items where id = (v_r ->> 'item_id')::uuid;
    perform _exp_register_damage(p_d, it, (v_r ->> 'damaged')::numeric, v_stage,
                                 coalesce(nullif(p_ctx ->> 'damage_reason', ''), 'roto'), p_ctx ->> 'damage_note',
                                 v_photos, v_route, v_event);
  end loop;

  if v_tot_del <= 0.0005 then
    -- Nada entregado: la entrega sigue debiendo todo (lo roto se repone del stock).
    return jsonb_build_object('delivered', 0, 'damaged', v_tot_dmg, 'rejected', v_tot_rej, 'missing', v_tot_mis,
                              'complete', false, 'any_delivered', false, 'child', null, 'issue_open', false, 'items', v_rows);
  end if;

  -- Con algo entregado: cada renglón queda con lo entregado.
  for v_r in select * from jsonb_array_elements(v_rows) loop
    update dispatch_items
       set qty_ordered = coalesce(qty_ordered, qty),
           qty = (v_r ->> 'delivered')::numeric,
           qty_damaged = qty_damaged + (v_r ->> 'damaged')::numeric,
           qty_rejected = qty_rejected + (v_r ->> 'rejected')::numeric,
           qty_missing = qty_missing + (v_r ->> 'missing')::numeric,
           outcome_at = now()
     where id = (v_r ->> 'item_id')::uuid
       and ((v_r ->> 'delivered')::numeric + 0.0005 < qty or qty_ordered is not null);
    -- Lo roto y lo que faltó se reprograma solo si así está configurado;
    -- lo rechazado siempre queda para resolver.
    if v_cfg ->> 'undelivered_action' = 'reprogramar'
       and (v_r ->> 'damaged')::numeric + (v_r ->> 'missing')::numeric > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'item_id', v_r ->> 'item_id',
        'qty', (v_r ->> 'damaged')::numeric + (v_r ->> 'missing')::numeric));
    end if;
  end loop;
  if jsonb_array_length(v_lines) > 0 then
    v_child := _exp_spawn_child(p_d, v_lines, case when v_tot_dmg > 0 then 'Reposición de lo roto y lo pendiente' else 'Lo pendiente' end);
  end if;
  v_open := _exp_refresh_issue(p_d.id);
  return jsonb_build_object('delivered', v_tot_del, 'damaged', v_tot_dmg, 'rejected', v_tot_rej, 'missing', v_tot_mis,
                            'complete', v_tot_del + 0.0005 >= v_tot_qty, 'any_delivered', true, 'child', v_child,
                            'issue_open', v_open, 'items', v_rows);
end;
$$;
revoke all on function _exp_apply_outcome(dispatches, jsonb, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) Compuertas del escaneo obligatorio (triggers)
-- -----------------------------------------------------------------------------
create or replace function trg_dispatches_scan_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from dispatch_items di where di.dispatch_id = new.id and di.qty > 0) then
    return new;
  end if;
  -- Armado: no pasa a Listo sin el control completo o justificado.
  if new.status = 'listo' and old.status in ('pendiente', 'armando')
     and _exp_scan_mode(new.tenant_id, 'armado') = 'obligatorio'
     and not _exp_check_complete(new.id, 'armado') then
    raise exception 'pick_scan_incomplete' using errcode = 'check_violation';
  end if;
  -- Entrega: en el mostrador (retiro) y en la calle (hoja de ruta). La
  -- logística externa y el cadete sin hoja se confirman a distancia.
  if new.status = 'entregado' and old.status in ('listo', 'despachado') and new.delivery_type <> 'inmediato'
     and new.shipment_id is null and (old.status = 'listo' or new.route_id is not null)
     and _exp_scan_mode(new.tenant_id, 'entrega') = 'obligatorio'
     and not _exp_check_complete(new.id, 'entrega') then
    raise exception 'deliver_scan_incomplete' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_dispatches_scan_gate() from public, anon, authenticated;

drop trigger if exists dispatches_scan_gate on dispatches;
create trigger dispatches_scan_gate
  before update of status on dispatches
  for each row when (old.status is distinct from new.status)
  execute function trg_dispatches_scan_gate();

create or replace function trg_delivery_routes_load_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if _exp_scan_mode(new.tenant_id, 'carga') = 'obligatorio' and not _exp_route_load_complete(new.id) then
    raise exception 'load_scan_incomplete' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_delivery_routes_load_gate() from public, anon, authenticated;

drop trigger if exists delivery_routes_load_gate on delivery_routes;
create trigger delivery_routes_load_gate
  before update of status on delivery_routes
  for each row when (new.status = 'en_curso' and old.status in ('planificada', 'cargando'))
  execute function trg_delivery_routes_load_gate();

-- -----------------------------------------------------------------------------
-- F) Pedido de stock: al recibir el traslado la entrega deja de esperar.
-- -----------------------------------------------------------------------------
create or replace function trg_stock_transfers_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d dispatches;
begin
  select * into v_d from dispatches where id = new.dispatch_id and awaiting_transfer_id = new.id;
  if v_d.id is null then
    return null;
  end if;
  if new.status = 'received' then
    update dispatches set awaiting_transfer_id = null, stock_arrived_at = now() where id = v_d.id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_d.tenant_id, auth.uid(), 'dispatches', v_d.id, 'dispatch_stock_arrived',
            jsonb_build_object('transfer_id', new.id, 'transfer_number', new.number), v_d.store_id);
  elsif new.status = 'cancelled' then
    update dispatches set awaiting_transfer_id = null where id = v_d.id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason, store_id)
    values (v_d.tenant_id, auth.uid(), 'dispatches', v_d.id, 'dispatch_stock_request_cancelled',
            jsonb_build_object('transfer_id', new.id, 'transfer_number', new.number), new.cancel_reason, v_d.store_id);
  end if;
  return null;
end;
$$;
revoke all on function trg_stock_transfers_dispatch() from public, anon, authenticated;

drop trigger if exists stock_transfers_dispatch on stock_transfers;
create trigger stock_transfers_dispatch
  after update of status on stock_transfers
  for each row when (new.dispatch_id is not null and old.status is distinct from new.status)
  execute function trg_stock_transfers_dispatch();

-- -----------------------------------------------------------------------------
-- I) Fotos de las roturas de Expedición en logistics-media (definición viva
--    de L2 + carpeta dispatches). Vehículos y hojas siguen pidiendo
--    reparto_propio; las entregas, pedidos_despacho.
-- -----------------------------------------------------------------------------
create or replace function public.logistics_media_can(p_name text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_parts  text[] := string_to_array(coalesce(p_name, ''), '/');
  v_tenant uuid := current_tenant_id();
  v_id     uuid;
  v_status text;
  v_d      dispatches;
begin
  if v_tenant is null or cardinality(v_parts) <> 4 or v_parts[1] is distinct from v_tenant::text
     or v_parts[4] !~ '^[A-Za-z0-9._-]{1,120}$' then
    return false;
  end if;
  v_id := _uuid_or_null(v_parts[3]);
  if v_id is null then
    return false;
  end if;
  if v_parts[2] = 'dispatches' then
    if not tenant_has_feature_for(v_tenant, 'pedidos_despacho') then
      return false;
    end if;
    select * into v_d from dispatches where id = v_id and tenant_id = v_tenant and deleted_at is null;
    if v_d.id is null or not (coalesce(user_can_access_store(v_d.store_id), false)
                              or coalesce(user_can_access_store(v_d.fulfillment_store_id), false)
                              or coalesce(user_can_access_store(v_d.sale_store_id), false)) then
      return false;
    end if;
    if p_write then
      return v_d.status <> 'cancelado' and member_has_capability(v_tenant, 'logistics.prepare');
    end if;
    return member_has_capability(v_tenant, 'logistics.view');
  end if;
  if not tenant_has_feature_for(v_tenant, 'reparto_propio') then
    return false;
  end if;
  if v_parts[2] = 'vehicles' then
    if p_write then
      return member_has_capability(v_tenant, 'logistics.fleet.manage')
             and exists (select 1 from vehicles where id = v_id and tenant_id = v_tenant and deleted_at is null);
    end if;
    return member_has_capability(v_tenant, 'logistics.view');
  elsif v_parts[2] = 'routes' then
    select status into v_status from delivery_routes where id = v_id and tenant_id = v_tenant and deleted_at is null;
    if v_status is null then
      return false;
    end if;
    if p_write then
      return v_status in ('planificada', 'cargando', 'en_curso')
             and ((route_is_mine(v_id) and member_has_capability(v_tenant, 'logistics.deliver'))
                  or member_has_capability(v_tenant, 'logistics.route.manage'));
    end if;
    return member_has_capability(v_tenant, 'logistics.view') or route_is_mine(v_id);
  end if;
  return false;
end;
$$;
revoke all on function public.logistics_media_can(text, boolean) from public, anon;
grant execute on function public.logistics_media_can(text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: escaneo
-- -----------------------------------------------------------------------------
-- p: {id (lo genera la pantalla), stage ('armado' | 'carga' | 'entrega'),
--     dispatch_id o route_id, code, qty (1 por defecto) o item_id (confirmar
--     a mano un producto sin código), device_id}.
-- Resultado: ok (sumó al renglón), excedente (ya estaba completo), ajeno (el
-- producto no está en esta entrega ni en otra abierta), cruce (es de OTRA
-- entrega abierta) o desconocido (ningún producto tiene ese código). Todo
-- queda en dispatch_scan_log; ajeno y cruce suman una alerta a la entrega.
create or replace function public.dispatch_scan(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      uuid := _uuid_or_null(p ->> 'id');
  v_stage   text := p ->> 'stage';
  v_code    text := nullif(upper(btrim(coalesce(p ->> 'code', ''))), '');
  v_item_id uuid := _uuid_or_null(p ->> 'item_id');
  v_qty     numeric;
  v_d       dispatches;
  v_r       delivery_routes;
  v_tenant  uuid;
  v_store   uuid;
  v_scope   uuid[];
  v_old     dispatch_scan_log;
  v_it      dispatch_items;
  v_check   dispatch_item_checks;
  v_result  text;
  v_other   dispatches;
  v_prod    uuid;
  v_var     uuid;
  v_done    boolean;
  v_total   int;
  v_ok      int;
  v_name    text;
begin
  if jsonb_typeof(p) is distinct from 'object' or v_id is null then
    raise exception 'invalid_scan';
  end if;
  if v_stage is null or v_stage not in ('armado', 'carga', 'entrega') then
    raise exception 'invalid_stage';
  end if;
  begin
    v_qty := coalesce(nullif(p ->> 'qty', '')::numeric, 1);
  exception when others then
    raise exception 'invalid_qty';
  end;
  if v_qty <= 0 or v_qty > 9999 then
    raise exception 'invalid_qty';
  end if;
  if v_code is null and v_item_id is null then
    raise exception 'code_required';
  end if;
  if char_length(coalesce(v_code, '')) > 80 then
    raise exception 'invalid_code';
  end if;

  if nullif(p ->> 'route_id', '') is not null then
    -- Carga del camión o entrega en la calle: la hoja entera.
    v_r := _route_lock(_uuid_or_null(p ->> 'route_id'), 'driver');
    v_tenant := v_r.tenant_id;
    v_store := v_r.store_id;
    if v_stage = 'armado' then
      raise exception 'invalid_stage';
    end if;
    if v_stage = 'carga' and v_r.status not in ('borrador', 'planificada', 'cargando') then
      raise exception 'route_already_left';
    end if;
    if v_stage = 'entrega' and v_r.status <> 'en_curso' then
      raise exception 'route_not_started';
    end if;
    select coalesce(array_agg(x.dispatch_id), '{}') into v_scope
      from route_stop_dispatches x where x.route_id = v_r.id and x.outcome = 'pendiente';
  else
    v_d := _dispatch_lock(_uuid_or_null(p ->> 'dispatch_id'));
    v_tenant := _exp_prepare_assert(v_d.tenant_id);
    v_store := v_d.store_id;
    if v_stage = 'armado' and v_d.status not in ('pendiente', 'armando', 'listo') then
      raise exception 'invalid_transition: % -> armado', v_d.status;
    end if;
    if v_stage = 'carga' and v_d.status not in ('pendiente', 'armando', 'listo') then
      raise exception 'invalid_transition: % -> carga', v_d.status;
    end if;
    if v_stage = 'entrega' and v_d.status not in ('listo', 'despachado') then
      raise exception 'invalid_transition: % -> entrega', v_d.status;
    end if;
    v_scope := array[v_d.id];
  end if;

  -- Idempotencia: la misma lectura ya se guardó.
  select * into v_old from dispatch_scan_log where id = v_id;
  if v_old.id is not null then
    if v_old.tenant_id <> v_tenant then
      raise exception 'invalid_scan';
    end if;
    return jsonb_build_object('ok', v_old.result in ('ok', 'manual'), 'duplicate', true, 'result', v_old.result,
                              'item_id', v_old.dispatch_item_id);
  end if;

  if _exp_scan_mode(v_tenant, v_stage) = 'no' then
    raise exception 'scan_disabled';
  end if;

  if v_item_id is not null and v_code is null then
    -- Confirmar a mano: sólo un producto que no tiene ningún código.
    select di.* into v_it from dispatch_items di where di.id = v_item_id and di.dispatch_id = any (v_scope) and di.qty > 0;
    if v_it.id is null then
      raise exception 'item_not_in_dispatch';
    end if;
    if cardinality(_exp_item_codes(v_it.product_id, v_it.variant_id)) > 0 then
      raise exception 'item_has_code';
    end if;
    v_result := 'manual';
  else
    -- El primer renglón del alcance con ese código que todavía no está completo.
    select di.* into v_it
      from dispatch_items di
      join _exp_code_products(v_tenant, v_code) m
        on m.product_id = di.product_id and (m.variant_id is null or m.variant_id = di.variant_id)
      left join dispatch_item_checks c on c.dispatch_item_id = di.id and c.stage = v_stage
     where di.dispatch_id = any (v_scope) and di.qty > 0
     order by (coalesce(c.qty_scanned, 0) + 0.0005 < di.qty) desc, (m.variant_id is not null) desc, di.sort, di.id
     limit 1;
    if v_it.id is not null then
      select * into v_check from dispatch_item_checks where dispatch_item_id = v_it.id and stage = v_stage;
      v_result := case when coalesce(v_check.qty_scanned, 0) + 0.0005 >= v_it.qty then 'excedente' else 'ok' end;
    else
      select m.product_id, m.variant_id into v_prod, v_var from _exp_code_products(v_tenant, v_code) m limit 1;
      if v_prod is null then
        v_result := 'desconocido';
      else
        -- ¿Es de otra entrega abierta? (el cruce que se quiere evitar)
        select x.* into v_other
          from dispatches x
          join dispatch_items di on di.dispatch_id = x.id and di.qty > 0
          join _exp_code_products(v_tenant, v_code) m
            on m.product_id = di.product_id and (m.variant_id is null or m.variant_id = di.variant_id)
         where x.tenant_id = v_tenant and x.deleted_at is null and not (x.id = any (v_scope))
           and x.status in ('pendiente', 'armando', 'listo', 'en_transito', 'despachado')
         order by x.created_at
         limit 1;
        v_result := case when v_other.id is not null then 'cruce' else 'ajeno' end;
      end if;
    end if;
  end if;

  if v_result in ('ok', 'manual') then
    insert into dispatch_item_checks (tenant_id, dispatch_id, dispatch_item_id, store_id, fulfillment_store_id, stage,
                                      route_id, qty_expected, qty_scanned, scanned_codes, manual, checked_by)
    select v_tenant, v_it.dispatch_id, v_it.id, d.store_id, d.fulfillment_store_id, v_stage, v_r.id, v_it.qty,
           least(v_qty, v_it.qty), case when v_code is not null then array[v_code] else '{}' end,
           v_result = 'manual', auth.uid()
      from dispatches d where d.id = v_it.dispatch_id
    on conflict (dispatch_item_id, stage) do update
      set qty_scanned = least(dispatch_item_checks.qty_scanned + v_qty, excluded.qty_expected),
          qty_expected = excluded.qty_expected,
          scanned_codes = case when v_code is null or cardinality(dispatch_item_checks.scanned_codes) >= 200
                                    or v_code = any (dispatch_item_checks.scanned_codes)
                               then dispatch_item_checks.scanned_codes
                               else dispatch_item_checks.scanned_codes || v_code end,
          manual = dispatch_item_checks.manual or excluded.manual,
          route_id = coalesce(excluded.route_id, dispatch_item_checks.route_id),
          checked_by = excluded.checked_by
    returning * into v_check;
  elsif v_result in ('ajeno', 'cruce') then
    update dispatches set scan_alerts = scan_alerts + 1 where id = any (v_scope);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), case when v_r.id is not null then 'delivery_routes' else 'dispatches' end,
            coalesce(v_r.id, v_d.id), 'dispatch_scan_mismatch',
            jsonb_build_object('stage', v_stage, 'code', v_code, 'result', v_result, 'product_id', v_prod,
                               'variant_id', v_var, 'other_dispatch_id', v_other.id, 'other_number', v_other.number),
            v_store);
  end if;

  insert into dispatch_scan_log (id, tenant_id, store_id, dispatch_id, route_id, stage, code, qty, result,
                                 dispatch_item_id, product_id, variant_id, other_dispatch_id, actor_user_id, device_id)
  values (v_id, v_tenant, v_store, case when v_r.id is null then v_d.id else v_it.dispatch_id end, v_r.id, v_stage,
          v_code, v_qty, v_result, v_it.id, coalesce(v_it.product_id, v_prod), coalesce(v_it.variant_id, v_var),
          v_other.id, auth.uid(), left(nullif(p ->> 'device_id', ''), 80));

  -- Avance del control en el alcance.
  select count(*), count(*) filter (where c.qty_scanned + 0.0005 >= di.qty or c.difference_reason is not null)
    into v_total, v_ok
    from dispatch_items di
    left join dispatch_item_checks c on c.dispatch_item_id = di.id and c.stage = v_stage
   where di.dispatch_id = any (v_scope) and di.qty > 0;
  v_done := v_total > 0 and v_ok = v_total;
  if v_done and v_stage = 'carga' and v_r.id is not null then
    update delivery_routes set load_checked_by = auth.uid(), load_checked_at = now() where id = v_r.id;
  end if;
  v_name := case when v_it.id is not null
                 then concat_ws(' · ', v_it.product_name, nullif(v_it.variant_label, '')) end;
  return jsonb_build_object(
    'ok', v_result in ('ok', 'manual'), 'duplicate', false, 'result', v_result,
    'item_id', v_it.id, 'dispatch_id', v_it.dispatch_id, 'product_name', v_name,
    'scanned', v_check.qty_scanned, 'expected', v_it.qty,
    'other_dispatch_number', v_other.number, 'progress', jsonb_build_object('done', v_ok, 'total', v_total),
    'complete', v_done);
end;
$$;
revoke all on function public.dispatch_scan(jsonb) from public, anon;
grant execute on function public.dispatch_scan(jsonb) to authenticated;

-- Justificar la diferencia de un renglón (no se pudo escanear todo).
-- p: {dispatch_id o route_id, stage, item_id, reason, note}
create or replace function public.dispatch_check_justify(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stage  text := p ->> 'stage';
  v_reason text := p ->> 'reason';
  v_note   text := left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300);
  v_d      dispatches;
  v_r      delivery_routes;
  v_it     dispatch_items;
  v_tenant uuid;
  v_store  uuid;
begin
  if v_stage is null or v_stage not in ('armado', 'carga', 'entrega') then
    raise exception 'invalid_stage';
  end if;
  if v_reason is null or v_reason not in ('faltante', 'danado', 'vencido', 'error_despacho', 'sobrante', 'sin_codigo', 'otro') then
    raise exception 'reason_required';
  end if;
  if v_reason = 'otro' and char_length(coalesce(v_note, '')) < 3 then
    raise exception 'note_required';
  end if;
  if nullif(p ->> 'route_id', '') is not null then
    v_r := _route_lock(_uuid_or_null(p ->> 'route_id'), 'driver');
    v_tenant := v_r.tenant_id;
    v_store := v_r.store_id;
    select di.* into v_it from dispatch_items di
     where di.id = _uuid_or_null(p ->> 'item_id')
       and di.dispatch_id in (select dispatch_id from route_stop_dispatches where route_id = v_r.id and outcome = 'pendiente');
  else
    v_d := _dispatch_lock(_uuid_or_null(p ->> 'dispatch_id'));
    v_tenant := _exp_prepare_assert(v_d.tenant_id);
    v_store := v_d.store_id;
    select di.* into v_it from dispatch_items di where di.id = _uuid_or_null(p ->> 'item_id') and di.dispatch_id = v_d.id;
  end if;
  if v_it.id is null then
    raise exception 'item_not_in_dispatch';
  end if;
  insert into dispatch_item_checks (tenant_id, dispatch_id, dispatch_item_id, store_id, fulfillment_store_id, stage,
                                    route_id, qty_expected, qty_scanned, difference_reason, difference_note, checked_by)
  select v_tenant, v_it.dispatch_id, v_it.id, d.store_id, d.fulfillment_store_id, v_stage, v_r.id, v_it.qty, 0,
         v_reason, v_note, auth.uid()
    from dispatches d where d.id = v_it.dispatch_id
  on conflict (dispatch_item_id, stage) do update
    set difference_reason = excluded.difference_reason, difference_note = excluded.difference_note,
        qty_expected = excluded.qty_expected, checked_by = excluded.checked_by;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason, store_id)
  values (v_tenant, auth.uid(), 'dispatches', v_it.dispatch_id, 'dispatch_check_justified',
          jsonb_build_object('stage', v_stage, 'item_id', v_it.id, 'reason', v_reason,
                             'scanned', (select qty_scanned from dispatch_item_checks where dispatch_item_id = v_it.id and stage = v_stage),
                             'expected', v_it.qty),
          v_note, v_store);
  if v_stage = 'carga' and v_r.id is not null and _exp_route_load_complete(v_r.id) then
    update delivery_routes set load_checked_by = auth.uid(), load_checked_at = now() where id = v_r.id;
  end if;
  return jsonb_build_object('ok', true, 'item_id', v_it.id);
end;
$$;
revoke all on function public.dispatch_check_justify(jsonb) from public, anon;
grant execute on function public.dispatch_check_justify(jsonb) to authenticated;

-- Volver a contar una etapa desde cero (p: {dispatch_id o route_id, stage}).
create or replace function public.dispatch_check_reset(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stage  text := p ->> 'stage';
  v_d      dispatches;
  v_r      delivery_routes;
  v_tenant uuid;
  v_store  uuid;
  v_ids    uuid[];
  v_n      int;
begin
  if v_stage is null or v_stage not in ('armado', 'carga', 'entrega') then
    raise exception 'invalid_stage';
  end if;
  if nullif(p ->> 'route_id', '') is not null then
    v_r := _route_lock(_uuid_or_null(p ->> 'route_id'), 'driver');
    if v_stage = 'carga' and v_r.status not in ('borrador', 'planificada', 'cargando') then
      raise exception 'route_already_left';
    end if;
    v_tenant := v_r.tenant_id;
    v_store := v_r.store_id;
    select coalesce(array_agg(dispatch_id), '{}') into v_ids
      from route_stop_dispatches where route_id = v_r.id and outcome = 'pendiente';
  else
    v_d := _dispatch_lock(_uuid_or_null(p ->> 'dispatch_id'));
    v_tenant := _exp_prepare_assert(v_d.tenant_id);
    v_store := v_d.store_id;
    if v_d.status in ('entregado', 'cancelado') then
      raise exception 'invalid_transition: % -> control', v_d.status;
    end if;
    v_ids := array[v_d.id];
  end if;
  update dispatch_item_checks
     set qty_scanned = 0, scanned_codes = '{}', manual = false, difference_reason = null, difference_note = null,
         checked_by = auth.uid()
   where dispatch_id = any (v_ids) and stage = v_stage;
  get diagnostics v_n = row_count;
  if v_stage = 'carga' and v_r.id is not null then
    update delivery_routes set load_checked_by = null, load_checked_at = null where id = v_r.id;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), case when v_r.id is not null then 'delivery_routes' else 'dispatches' end,
          coalesce(v_r.id, v_d.id), 'dispatch_check_reset', jsonb_build_object('stage', v_stage, 'rows', v_n), v_store);
  return jsonb_build_object('ok', true, 'rows', v_n);
end;
$$;
revoke all on function public.dispatch_check_reset(jsonb) from public, anon;
grant execute on function public.dispatch_check_reset(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: roturas antes de salir, entrega parcial en Expedición y resolver
-- -----------------------------------------------------------------------------
-- Rotura al armar o al cargar (la entrega sigue igual: lo roto se repone del
-- stock). p: {dispatch_id, stage ('armado' | 'carga'), items: [{item_id, qty}],
-- reason ('roto' | 'mal_estado' | 'vencido' | 'otro'), note, photo_paths}
create or replace function public.dispatch_damage_report(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d      dispatches := _dispatch_lock(_uuid_or_null(p ->> 'dispatch_id'));
  v_stage  text := coalesce(nullif(p ->> 'stage', ''), 'armado');
  v_photos text[];
  v_it     dispatch_items;
  v_l      record;
  v_out    jsonb := '[]'::jsonb;
begin
  perform _exp_prepare_assert(v_d.tenant_id);
  if v_stage not in ('armado', 'carga') then
    raise exception 'invalid_stage';
  end if;
  if v_d.status not in ('pendiente', 'armando', 'listo') then
    raise exception 'invalid_transition: % -> rotura', v_d.status;
  end if;
  if jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'invalid_items';
  end if;
  select coalesce(array_agg(x), '{}') into v_photos
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'photo_paths') = 'array' then p -> 'photo_paths' else '[]'::jsonb end) x;
  if cardinality(v_photos) > 6 then
    raise exception 'too_many_photos';
  end if;
  if exists (select 1 from unnest(v_photos) x where not _dispatch_media_ok(v_d.tenant_id, v_d.id, x)) then
    raise exception 'invalid_media_path';
  end if;
  for v_l in
    select _uuid_or_null(x ->> 'item_id') as item_id, sum(nullif(x ->> 'qty', '')::numeric) as qty
      from jsonb_array_elements(p -> 'items') x group by 1
  loop
    select * into v_it from dispatch_items where id = v_l.item_id and dispatch_id = v_d.id for update;
    if v_it.id is null then
      raise exception 'item_not_in_dispatch';
    end if;
    if v_l.qty is null or v_l.qty <= 0 or v_l.qty > v_it.qty + 0.0005 then
      raise exception 'invalid_item_qty' using detail = v_it.product_name;
    end if;
    v_out := v_out || jsonb_build_array(_exp_register_damage(v_d, v_it, v_l.qty, v_stage, p ->> 'reason', p ->> 'note',
                                                             v_photos, v_d.route_id, null));
  end loop;
  return jsonb_build_object('ok', true, 'damages', v_out);
end;
$$;
revoke all on function public.dispatch_damage_report(jsonb) from public, anon;
grant execute on function public.dispatch_damage_report(jsonb) to authenticated;

-- Entrega parcial en el mostrador (retiro sin código) o de un cadete sin hoja.
-- p: {dispatch_id, items: [{item_id, delivered, damaged, rejected}],
--     delivered_to, damage_reason, damage_note, photo_paths, scans}
create or replace function public.dispatch_partial_deliver(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d     dispatches := _dispatch_lock(_uuid_or_null(p ->> 'dispatch_id'));
  v_cross boolean;
  v_res   jsonb;
  v_to    text := left(nullif(btrim(coalesce(p ->> 'delivered_to', '')), ''), 120);
begin
  perform _exp_prepare_assert(v_d.tenant_id);
  if v_d.route_id is not null then
    raise exception 'dispatch_in_route';
  end if;
  v_cross := v_d.fulfillment_store_id <> v_d.store_id;
  if not ((v_d.status = 'listo' and v_d.delivery_type = 'retiro' and (not v_cross or v_d.arrived_at is not null))
          or (v_d.status = 'despachado' and v_d.delivery_type = 'envio' and v_d.shipment_id is null)) then
    raise exception 'invalid_transition: % -> entregado', v_d.status;
  end if;
  if v_d.pickup_code_hash is not null then
    raise exception 'use_pickup_code';
  end if;
  if not (coalesce(user_can_access_store(v_d.fulfillment_store_id), false)
          or (v_d.status = 'despachado' and coalesce(user_can_access_store(v_d.sale_store_id), false))) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_d.delivery_type = 'retiro' and (v_to is null or char_length(v_to) < 2) then
    raise exception 'delivered_to_required';
  end if;
  if jsonb_typeof(p -> 'photo_paths') = 'array' and exists (
    select 1 from jsonb_array_elements_text(p -> 'photo_paths') x where not _dispatch_media_ok(v_d.tenant_id, v_d.id, x)) then
    raise exception 'invalid_media_path';
  end if;

  v_res := _exp_apply_outcome(v_d, p -> 'items',
                              jsonb_build_object('stage', 'entrega', 'photo_paths', p -> 'photo_paths',
                                                 'damage_reason', p ->> 'damage_reason', 'damage_note', p ->> 'damage_note',
                                                 'scans', p -> 'scans'));
  if not (v_res ->> 'any_delivered')::boolean then
    raise exception 'nothing_delivered';
  end if;
  update dispatches
     set status = 'entregado', delivered_by = auth.uid(), delivered_at = now(),
         delivered_to = left(coalesce(v_to, customer_name, pickup_name), 120),
         delivery_result = case when (v_res ->> 'complete')::boolean then 'completa' else 'parcial' end
   where id = v_d.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', v_d.id, 'dispatch_partial_delivered',
          jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', 'entregado', 'delivered_to', coalesce(v_to, v_d.customer_name, v_d.pickup_name))
            || (v_res - 'items'),
          v_d.fulfillment_store_id);
  return jsonb_build_object('ok', true) || v_res;
end;
$$;
revoke all on function public.dispatch_partial_deliver(jsonb) from public, anon;
grant execute on function public.dispatch_partial_deliver(jsonb) to authenticated;

-- Resolver lo pendiente de una entrega con problemas.
-- p: {dispatch_id, action ('reprogramar' | 'resuelto'), items: [{item_id, qty}]
--     (sin items: todo lo pendiente), note}
-- "resuelto": la plata y el stock de lo que no se entrega se arreglan con la
-- devolución de la venta (Devoluciones), que vuelve a sumar el stock.
create or replace function public.dispatch_issue_resolve(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d      dispatches := _dispatch_lock(_uuid_or_null(p ->> 'dispatch_id'));
  v_action text := p ->> 'action';
  v_note   text := left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300);
  v_lines  jsonb := '[]'::jsonb;
  v_child  jsonb;
  v_open   boolean;
  it       dispatch_items;
  v_q      numeric;
begin
  perform _exp_prepare_assert(v_d.tenant_id);
  if v_action is null or v_action not in ('reprogramar', 'resuelto') then
    raise exception 'invalid_action';
  end if;
  if v_action = 'resuelto' and char_length(coalesce(v_note, '')) < 3 then
    raise exception 'note_required';
  end if;
  if p ? 'items' and jsonb_typeof(p -> 'items') <> 'array' then
    raise exception 'invalid_items';
  end if;
  if not v_d.issue_open then
    raise exception 'no_open_issue';
  end if;
  for it in select * from dispatch_items where dispatch_id = v_d.id order by sort, id for update loop
    if jsonb_typeof(p -> 'items') = 'array' and jsonb_array_length(p -> 'items') > 0 then
      select sum(nullif(x ->> 'qty', '')::numeric) into v_q
        from jsonb_array_elements(p -> 'items') x where _uuid_or_null(x ->> 'item_id') = it.id;
    else
      v_q := _exp_item_open(it);
    end if;
    if v_q is null or v_q <= 0 then
      continue;
    end if;
    if v_q > _exp_item_open(it) + 0.0005 then
      raise exception 'invalid_item_qty' using detail = it.product_name;
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('item_id', it.id, 'qty', v_q));
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'nothing_to_resolve';
  end if;
  if v_action = 'reprogramar' then
    v_child := _exp_spawn_child(v_d, v_lines, v_note);
  else
    update dispatch_items di set qty_settled = di.qty_settled + l.qty
      from jsonb_to_recordset(v_lines) as l(item_id uuid, qty numeric)
     where di.id = l.item_id;
  end if;
  v_open := _exp_refresh_issue(v_d.id);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', v_d.id, 'dispatch_issue_resolved',
          jsonb_build_object('action', v_action, 'lines', v_lines, 'child', v_child, 'issue_open', v_open),
          v_note, v_d.store_id);
  return jsonb_build_object('ok', true, 'child', v_child, 'issue_open', v_open);
end;
$$;
revoke all on function public.dispatch_issue_resolve(jsonb) from public, anon;
grant execute on function public.dispatch_issue_resolve(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: pedir stock a otra sucursal
-- -----------------------------------------------------------------------------
-- Qué falta para armar la entrega y quién lo tiene. El salón de la sucursal
-- ya descontó lo vendido: si quedó en negativo, eso es lo que falta.
create or replace function public.dispatch_stock_status(p_dispatch uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d dispatches := _dispatch_lock(p_dispatch);
begin
  return jsonb_build_object(
    'dispatch_id', v_d.id,
    'store_id', v_d.store_id,
    'awaiting_transfer', (select jsonb_build_object('id', t.id, 'number', t.number, 'status', t.status,
                                                    'origin_store_id', t.origin_store_id)
                            from stock_transfers t where t.id = v_d.awaiting_transfer_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'item_id', di.id, 'product_id', di.product_id, 'variant_id', di.variant_id,
               'name', concat_ws(' · ', di.product_name, nullif(di.variant_label, '')), 'unit', di.unit, 'qty', di.qty,
               'here', h.qty,
               'shortage', greatest(least(di.qty, -h.qty), 0),
               'transferable', coalesce(pr.track_stock, true) and not coalesce(pr.is_kit, false),
               'stores', coalesce((
                 select jsonb_agg(jsonb_build_object('store_id', ps.store_id, 'name', s.name, 'qty', ps.qty) order by ps.qty desc)
                   from product_stock ps
                   join stores s on s.id = ps.store_id and s.deleted_at is null and s.is_active
                  where ps.tenant_id = v_d.tenant_id and ps.product_id = di.product_id
                    and ps.variant_id is not distinct from di.variant_id
                    and ps.store_id <> v_d.store_id and ps.qty > 0), '[]'::jsonb))
             order by di.sort, di.id)
        from dispatch_items di
        join products pr on pr.id = di.product_id
        cross join lateral (select warehouse_principal_qty(v_d.store_id, di.product_id, di.variant_id) as qty) h
       where di.dispatch_id = v_d.id and di.qty > 0), '[]'::jsonb));
end;
$$;
revoke all on function public.dispatch_stock_status(uuid) from public, anon;
grant execute on function public.dispatch_stock_status(uuid) to authenticated;

-- Arma el traslado con lo que falta y lo deja enlazado a la entrega.
-- p: {dispatch_id, origin_store_id, items: [{item_id, qty}], notes}
-- Las reglas de Traslados valen igual: rol, aprobación por monto o unidades.
create or replace function public.dispatch_request_stock(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d      dispatches := _dispatch_lock(_uuid_or_null(p ->> 'dispatch_id'));
  v_origin uuid := _uuid_or_null(p ->> 'origin_store_id');
  v_items  jsonb;
  v_tid    uuid;
  v_status text;
  v_t      stock_transfers;
begin
  perform _exp_prepare_assert(v_d.tenant_id);
  if v_d.status not in ('pendiente', 'armando') then
    raise exception 'invalid_transition: % -> pedir stock', v_d.status;
  end if;
  if v_d.awaiting_transfer_id is not null and exists (
    select 1 from stock_transfers t where t.id = v_d.awaiting_transfer_id and t.status not in ('received', 'cancelled')) then
    raise exception 'stock_already_requested';
  end if;
  if v_origin is null or v_origin = v_d.store_id then
    raise exception 'invalid_origin';
  end if;
  if jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'invalid_items';
  end if;
  if exists (
    select 1
      from (select _uuid_or_null(x ->> 'item_id') as item_id, sum(nullif(x ->> 'qty', '')::numeric) as qty
              from jsonb_array_elements(p -> 'items') x group by 1) l
      left join dispatch_items di on di.id = l.item_id and di.dispatch_id = v_d.id
     where di.id is null or l.qty is null or l.qty <= 0 or l.qty > di.qty + 0.0005) then
    raise exception 'invalid_item_qty';
  end if;
  select jsonb_agg(jsonb_build_object('product_id', di.product_id, 'variant_id', di.variant_id, 'qty', l.qty,
                                      'notes', 'Entrega N° ' || v_d.number))
    into v_items
    from (select _uuid_or_null(x ->> 'item_id') as item_id, sum(nullif(x ->> 'qty', '')::numeric) as qty
            from jsonb_array_elements(p -> 'items') x group by 1) l
    join dispatch_items di on di.id = l.item_id;

  -- Traslados de siempre (rol, plan, aprobación y numeración).
  v_tid := transfer_save(null, v_origin, v_d.store_id, current_date,
                         left('Para la entrega N° ' || v_d.number || coalesce('. ' || nullif(btrim(p ->> 'notes'), ''), ''), 500),
                         v_items, null);
  v_status := transfer_submit(v_tid);
  update stock_transfers set dispatch_id = v_d.id where id = v_tid returning * into v_t;
  update dispatches set awaiting_transfer_id = v_tid, stock_arrived_at = null where id = v_d.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', v_d.id, 'dispatch_stock_requested',
          jsonb_build_object('transfer_id', v_tid, 'transfer_number', v_t.number, 'origin_store_id', v_origin,
                             'status', v_status, 'items', v_items),
          v_d.store_id);
  return jsonb_build_object('ok', true, 'transfer_id', v_tid, 'number', v_t.number, 'status', v_status);
end;
$$;
revoke all on function public.dispatch_request_stock(jsonb) from public, anon;
grant execute on function public.dispatch_request_stock(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: app del repartidor
-- -----------------------------------------------------------------------------
-- Renglones de la hoja con sus códigos y controles (para escanear sin señal
-- en la entrega y para controlar la carga), y la configuración de Expedición.
create or replace function public.route_items(p_route uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_r      delivery_routes;
begin
  select * into v_r from delivery_routes where id = p_route and tenant_id = v_tenant and deleted_at is null;
  if v_r.id is null then
    raise exception 'route_not_found';
  end if;
  if not (((v_r.driver_user_id = auth.uid() or v_r.helper_user_id = auth.uid())
           and member_has_capability(v_tenant, 'logistics.deliver'))
          or member_has_capability(v_tenant, 'logistics.view')) then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:logistics.view';
  end if;
  return jsonb_build_object(
    'route_id', v_r.id,
    'settings', _expedition_settings(v_tenant) - 'saved',
    'load_checked_at', v_r.load_checked_at,
    'dispatches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'dispatch_id', d.id, 'number', d.number, 'stop_id', x.stop_id, 'outcome', x.outcome,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', di.id, 'product_id', di.product_id, 'variant_id', di.variant_id,
                          'name', concat_ws(' · ', di.product_name, nullif(di.variant_label, '')),
                          'qty', di.qty, 'unit', di.unit,
                          'codes', to_jsonb(_exp_item_codes(di.product_id, di.variant_id)),
                          'load', (select jsonb_build_object('scanned', c.qty_scanned, 'reason', c.difference_reason)
                                     from dispatch_item_checks c where c.dispatch_item_id = di.id and c.stage = 'carga'),
                          'delivery', (select jsonb_build_object('scanned', c.qty_scanned, 'reason', c.difference_reason)
                                         from dispatch_item_checks c where c.dispatch_item_id = di.id and c.stage = 'entrega'))
                          order by di.sort, di.id)
                   from dispatch_items di where di.dispatch_id = d.id and di.qty > 0), '[]'::jsonb))
             order by d.number)
        from route_stop_dispatches x
        join dispatches d on d.id = x.dispatch_id
       where x.route_id = v_r.id and x.outcome <> 'quitado'), '[]'::jsonb));
end;
$$;
revoke all on function public.route_items(uuid) from public, anon;
grant execute on function public.route_items(uuid) to authenticated;

-- Entrega por producto en la calle (parcial, rotura o rechazo). Idempotente
-- por el id del teléfono, como delivery_event_record.
-- p: {id, route_id, stop_id, occurred_at, lat, lng, accuracy_m, far_confirmed,
--     received_by_name, received_by_doc, signature_path, photo_paths,
--     remito_photo_path, note, device_id,
--     dispatches: [{dispatch_id, items: [{item_id, delivered, damaged, rejected}]}],
--     damage_reason, damage_note, damage_photo_paths, scans: {item_id: qty},
--     foreign_codes: [código, ...]}
create or replace function public.delivery_items_record(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      uuid := _uuid_or_null(p ->> 'id');
  v_r       delivery_routes;
  v_stop    route_stops;
  v_cfg     jsonb;
  v_exp     jsonb;
  v_old     delivery_events;
  v_ev      delivery_events;
  v_lat     double precision;
  v_lng     double precision;
  v_dist    int;
  v_name    text := nullif(btrim(coalesce(p ->> 'received_by_name', '')), '');
  v_doc     text := nullif(regexp_replace(coalesce(p ->> 'received_by_doc', ''), '[^0-9A-Za-z]', '', 'g'), '');
  v_photos  int := case when jsonb_typeof(p -> 'photo_paths') = 'array' then jsonb_array_length(p -> 'photo_paths') else 0 end;
  v_dmg_ph  jsonb := case when jsonb_typeof(p -> 'damage_photo_paths') = 'array' then p -> 'damage_photo_paths' else '[]'::jsonb end;
  v_x       record;
  v_d       dispatches;
  v_items   jsonb;
  v_res     jsonb;
  v_results jsonb := '[]'::jsonb;
  v_any     boolean := false;
  v_all     boolean := true;
  v_dmg     numeric := 0;
  v_rej     numeric := 0;
  v_type    text;
  v_label   text;
  v_status  text;
  v_code    text;
  v_cross   dispatches;
  v_open    int;
  v_plan    jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' or v_id is null then
    raise exception 'invalid_event';
  end if;
  v_r := _route_lock(_uuid_or_null(p ->> 'route_id'), 'driver');

  select * into v_old from delivery_events where id = v_id;
  if v_old.id is not null then
    if v_old.tenant_id <> v_r.tenant_id or v_old.route_id <> v_r.id then
      raise exception 'invalid_event';
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true,
                              'stop_status', (select status from route_stops where id = v_old.stop_id));
  end if;
  if v_r.status <> 'en_curso' then
    raise exception 'route_not_started';
  end if;
  select * into v_stop from route_stops
   where id = _uuid_or_null(p ->> 'stop_id') and route_id = v_r.id and deleted_at is null
   for update;
  if v_stop.id is null then
    raise exception 'stop_not_found';
  end if;
  if v_stop.status in ('entregada', 'parcial', 'no_entregada', 'saltada') then
    raise exception 'stop_closed';
  end if;
  if jsonb_typeof(p -> 'dispatches') is distinct from 'array' then
    raise exception 'invalid_items';
  end if;
  if jsonb_array_length(v_dmg_ph) > 6 or exists (
    select 1 from jsonb_array_elements_text(v_dmg_ph) x where not _route_media_ok(v_r.tenant_id, v_r.id, x)) then
    raise exception 'invalid_media_path';
  end if;
  v_cfg := _logistics_settings(v_r.tenant_id);
  v_exp := _expedition_settings(v_r.tenant_id);

  -- Cuánto se entrega en total (para saber qué se exige).
  for v_x in
    select x.dispatch_id from route_stop_dispatches x where x.stop_id = v_stop.id and x.outcome = 'pendiente' order by x.created_at
  loop
    select e -> 'items' into v_items from jsonb_array_elements(p -> 'dispatches') e
     where _uuid_or_null(e ->> 'dispatch_id') = v_x.dispatch_id limit 1;
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('dispatch_id', v_x.dispatch_id, 'items', coalesce(v_items, '[]'::jsonb)));
    if exists (
      select 1 from dispatch_items di
       where di.dispatch_id = v_x.dispatch_id and di.qty > 0
         and coalesce((select nullif(i ->> 'delivered', '')::numeric
                         from jsonb_array_elements(coalesce(v_items, '[]'::jsonb)) i
                        where _uuid_or_null(i ->> 'item_id') = di.id limit 1), di.qty) > 0) then
      v_any := true;
    end if;
    select v_dmg + coalesce(sum(nullif(i ->> 'damaged', '')::numeric), 0), v_rej + coalesce(sum(nullif(i ->> 'rejected', '')::numeric), 0)
      into v_dmg, v_rej
      from jsonb_array_elements(coalesce(v_items, '[]'::jsonb)) i;
  end loop;
  if jsonb_array_length(v_plan) = 0 then
    raise exception 'stop_closed';
  end if;
  if exists (select 1 from jsonb_array_elements(p -> 'dispatches') e
              where not exists (select 1 from jsonb_array_elements(v_plan) q where q ->> 'dispatch_id' = e ->> 'dispatch_id')) then
    raise exception 'dispatch_not_in_stop';
  end if;

  if (p ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' and (p ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$' then
    v_lat := (p ->> 'lat')::double precision;
    v_lng := (p ->> 'lng')::double precision;
  end if;
  v_dist := _geo_distance_m(v_lat, v_lng, v_stop.lat, v_stop.lng);
  if v_any then
    -- Lo mismo que pide delivery_event_record para entregado.
    if (v_cfg ->> 'require_geo')::boolean and v_lat is null then
      raise exception 'geo_required';
    end if;
    if (v_cfg ->> 'require_signature')::boolean and nullif(p ->> 'signature_path', '') is null then
      raise exception 'signature_required';
    end if;
    if (v_cfg ->> 'require_photo')::boolean and v_photos = 0 then
      raise exception 'photo_required';
    end if;
    if (v_cfg ->> 'require_receiver_name')::boolean and (v_name is null or char_length(v_name) < 2) then
      raise exception 'receiver_name_required';
    end if;
    if (v_cfg ->> 'require_receiver_doc')::boolean and (v_doc is null or char_length(v_doc) < 6) then
      raise exception 'receiver_doc_required';
    end if;
    if (v_cfg ->> 'require_remito_photo')::boolean and nullif(p ->> 'remito_photo_path', '') is null then
      raise exception 'remito_photo_required';
    end if;
  end if;
  if v_dist is not null and v_dist > (v_cfg ->> 'max_distance_m')::int and not coalesce((p ->> 'far_confirmed')::boolean, false) then
    raise exception 'too_far_from_stop' using detail = 'distance_m:' || v_dist;
  end if;

  v_label := case when v_dmg > 0 and v_rej > 0 then 'Rotura y rechazo'
                  when v_dmg > 0 then 'Producto dañado'
                  when v_rej > 0 then 'Rechazó el pedido'
                  else 'Entrega parcial' end;
  v_type := case when not v_any then case when v_dmg > 0 then 'rotura' else 'no_entregado' end
                 else 'entregado_parcial' end;
  v_ev := _delivery_event_insert(
    v_r,
    p || jsonb_build_object(
      'reason_key', case when v_any then null when v_dmg > 0 then 'danado' else 'rechazo' end,
      'reason_label', case when v_any then null else v_label end,
      'payload', jsonb_build_object('dispatches', (select jsonb_agg(jsonb_build_object('dispatch_id', q ->> 'dispatch_id',
                                                                                       'items', jsonb_array_length(q -> 'items')))
                                                     from jsonb_array_elements(v_plan) q),
                                    'damaged', v_dmg, 'rejected', v_rej,
                                    'foreign', coalesce(jsonb_array_length(case when jsonb_typeof(p -> 'foreign_codes') = 'array'
                                                                                 then p -> 'foreign_codes' end), 0))),
    v_type, v_stop.id, v_dist);

  for v_x in select (q ->> 'dispatch_id')::uuid as dispatch_id, q -> 'items' as items from jsonb_array_elements(v_plan) q loop
    select * into v_d from dispatches where id = v_x.dispatch_id for update;
    v_res := _exp_apply_outcome(v_d, v_x.items,
                                jsonb_build_object('stage', 'entrega', 'route_id', v_r.id, 'event_id', v_ev.id,
                                                   'photo_paths', v_dmg_ph, 'damage_reason', p ->> 'damage_reason',
                                                   'damage_note', p ->> 'damage_note', 'scans', p -> 'scans'));
    if (v_res ->> 'any_delivered')::boolean then
      update dispatches
         set status = 'entregado', delivered_at = v_ev.occurred_at, delivered_by = auth.uid(),
             delivered_to = left(coalesce(v_ev.received_by_name, customer_name, v_stop.contact_name), 120),
             delivery_result = case when (v_res ->> 'complete')::boolean then 'completa' else 'parcial' end
       where id = v_d.id and status not in ('entregado', 'cancelado');
      update route_stop_dispatches
         set outcome = case when (v_res ->> 'complete')::boolean then 'entregado' else 'parcial' end, closed_at = now()
       where stop_id = v_stop.id and dispatch_id = v_d.id and outcome = 'pendiente';
      update remitos rm
         set received_name = coalesce(rm.received_name, v_ev.received_by_name),
             received_doc = coalesce(rm.received_doc, v_ev.received_by_doc),
             received_at = coalesce(rm.received_at, v_ev.occurred_at),
             signed_copy_path = coalesce(v_ev.remito_photo_path, rm.signed_copy_path),
             route_id = coalesce(rm.route_id, v_r.id),
             stop_id = coalesce(rm.stop_id, v_stop.id)
       where rm.status = 'emitido' and rm.deleted_at is null and rm.dispatch_id = v_d.id;
      if not (v_res ->> 'complete')::boolean then
        v_all := false;
      end if;
    else
      -- Nada entregado: vuelve a Expedición (Listo) con el motivo y un intento más.
      update dispatches d
         set route_id = null, route_stop_id = null,
             status = case when d.status = 'despachado' then 'listo' else d.status end,
             shipped_at = case when d.status = 'despachado' then null else d.shipped_at end,
             shipped_by = case when d.status = 'despachado' then null else d.shipped_by end,
             delivery_attempts = d.delivery_attempts + 1,
             last_failure_reason = v_label, last_failure_at = v_ev.occurred_at
       where d.id = v_d.id and d.status not in ('entregado', 'cancelado');
      update route_stop_dispatches set outcome = 'no_entregado', closed_at = now()
       where stop_id = v_stop.id and dispatch_id = v_d.id and outcome = 'pendiente';
      v_all := false;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object('dispatch_id', v_d.id, 'number', v_d.number) || (v_res - 'items'));
  end loop;

  -- Lecturas de productos ajenos en la puerta (cruces): quedan registradas.
  if jsonb_typeof(p -> 'foreign_codes') = 'array' then
    for v_code in
      select distinct upper(btrim(x)) from jsonb_array_elements_text(p -> 'foreign_codes') x
       where char_length(btrim(x)) between 1 and 80 limit 20
    loop
      v_cross := null;
      select x.* into v_cross
        from dispatches x
        join dispatch_items di on di.dispatch_id = x.id and di.qty > 0
        join _exp_code_products(v_r.tenant_id, v_code) m
          on m.product_id = di.product_id and (m.variant_id is null or m.variant_id = di.variant_id)
       where x.tenant_id = v_r.tenant_id and x.deleted_at is null
         and x.status in ('pendiente', 'armando', 'listo', 'en_transito', 'despachado')
         and x.id not in (select (q ->> 'dispatch_id')::uuid from jsonb_array_elements(v_plan) q)
       order by (x.route_id = v_r.id) desc nulls last, x.created_at
       limit 1;
      insert into dispatch_scan_log (id, tenant_id, store_id, dispatch_id, route_id, stage, code, qty, result,
                                     product_id, other_dispatch_id, actor_user_id, device_id)
      values (gen_random_uuid(), v_r.tenant_id, v_r.store_id, null, v_r.id, 'entrega', v_code, 1,
              case when v_cross.id is not null then 'cruce'
                   when exists (select 1 from _exp_code_products(v_r.tenant_id, v_code)) then 'ajeno'
                   else 'desconocido' end,
              (select m.product_id from _exp_code_products(v_r.tenant_id, v_code) m limit 1),
              v_cross.id, auth.uid(), left(nullif(p ->> 'device_id', ''), 80));
    end loop;
    if jsonb_array_length(p -> 'foreign_codes') > 0 then
      update dispatches set scan_alerts = scan_alerts + 1
       where id in (select (q ->> 'dispatch_id')::uuid from jsonb_array_elements(v_plan) q);
    end if;
  end if;

  v_status := case when v_any and v_all then 'entregada' when v_any then 'parcial' else 'no_entregada' end;
  update route_stops
     set status = v_status, completed_at = v_ev.occurred_at, arrived_at = coalesce(arrived_at, v_ev.occurred_at),
         failure_reason_key = case when v_status = 'no_entregada' then v_ev.reason_key end,
         failure_reason_label = case when v_status <> 'entregada' then v_label end
   where id = v_stop.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', v_r.id, 'route_stop_items_recorded',
          jsonb_build_object('stop_id', v_stop.id, 'event_id', v_ev.id, 'stop_status', v_status, 'results', v_results,
                             'received_by', v_ev.received_by_name, 'distance_m', v_dist, 'lat', v_ev.lat, 'lng', v_ev.lng,
                             'signature', v_ev.signature_path is not null, 'damage_photos', jsonb_array_length(v_dmg_ph)),
          v_r.store_id);
  select count(*) into v_open from route_stops
   where route_id = v_r.id and deleted_at is null and status in ('pendiente', 'en_camino', 'en_el_lugar');
  return jsonb_build_object('ok', true, 'duplicate', false, 'stop_status', v_status, 'distance_m', v_dist,
                            'open_stops', v_open, 'results', v_results);
end;
$$;
revoke all on function public.delivery_items_record(jsonb) from public, anon;
grant execute on function public.delivery_items_record(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- J) Catálogo de capacidades: logistics.prepare (RPC de Expedición de L5) y
--    logistics.track (route_live y route_track de L3, ADR-164) pasan a
--    enforcement de servidor. El resto es idéntico al seed vivo en producción.
-- -----------------------------------------------------------------------------
-- Seed generado desde lib/permissions/capabilities.ts (no editar a mano).
-- @@SEED-INICIO@@
insert into permission_capabilities (key, module, label, description, level, risk, depends_on, requires_all, min_base, enforced, grant_feature, sort) values
  ('sales.view', 'ventas', 'Ver ventas', 'Ver el listado y el detalle de las ventas de sus sucursales.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 10),
  ('sales.create', 'ventas', 'Vender y cobrar', 'Cobrar ventas en el POS dentro de su turno de caja.', 'operate', 'medium', array['sales.view', 'products.view']::text[], array['products.view', 'sales.view']::text[], 'cashier', 'server', null, 20),
  ('sales.void', 'ventas', 'Anular ventas del día', 'Anular una venta de hoy: vuelve el stock y sale la plata de la caja.', 'operate', 'high', array['sales.view']::text[], array['sales.view']::text[], 'cashier', 'server', null, 30),
  ('sales.void.past_days', 'ventas', 'Anular ventas de días anteriores', 'Anular ventas de otros días (hora de Argentina). Toca cierres ya hechos.', 'admin', 'critical', array['sales.void']::text[], array['sales.view', 'sales.void']::text[], 'cashier', 'server', null, 40),
  ('sales.return', 'ventas', 'Devoluciones y cambios', 'Registrar devoluciones, cambios y reintegros de una venta.', 'operate', 'high', array['sales.view']::text[], array['sales.view']::text[], 'cashier', 'server', null, 50),
  ('cash.view', 'caja', 'Ver cajas y turnos', 'Ver las cajas, los turnos y los cierres de sus sucursales.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 60),
  ('cash.open', 'caja', 'Abrir turno de caja', 'Abrir su propio turno en una caja de su sucursal.', 'operate', 'medium', array['cash.view']::text[], array['cash.view']::text[], 'cashier', 'server', null, 70),
  ('cash.close', 'caja', 'Cerrar turno de caja', 'Cerrar su turno con el arqueo y el cierre Z.', 'operate', 'medium', array['cash.open']::text[], array['cash.open', 'cash.view']::text[], 'cashier', 'server', null, 80),
  ('cash.movements', 'caja', 'Ingresos y retiros de caja', 'Cargar ingresos y retiros de plata en su turno.', 'operate', 'high', array['cash.open']::text[], array['cash.open', 'cash.view']::text[], 'cashier', 'server', null, 90),
  ('products.view', 'productos', 'Ver productos y precios', 'Ver el catálogo, las variantes y los precios.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 100),
  ('products.edit', 'productos', 'Crear y editar productos', 'Alta, edición y baja de productos, variantes, categorías y marcas.', 'admin', 'medium', array['products.view']::text[], array['products.view']::text[], 'cashier', 'server', null, 110),
  ('products.price', 'productos', 'Cambiar precios y costos', 'Cambiar el precio de venta y el costo de un producto.', 'admin', 'high', array['products.edit']::text[], array['products.edit', 'products.view']::text[], 'cashier', 'server', null, 120),
  ('prices.manage', 'productos', 'Listas de precios y cambios masivos', 'Listas de precios, escalas, condiciones de pago y aumentos masivos.', 'admin', 'high', array['products.price']::text[], array['products.edit', 'products.price', 'products.view']::text[], 'cashier', 'server', null, 130),
  ('stock.view', 'stock', 'Ver stock e inventario', 'Stock por sucursal y depósito, movimientos e historial de ajustes.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'server', null, 140),
  ('stock.valuation', 'stock', 'Ver costos y valuación del stock', 'Costo de cada producto, valor del stock y valor de cada ajuste.', 'admin', 'medium', array['stock.view']::text[], array['stock.view']::text[], 'viewer', 'server', 'ajustes_stock', 150),
  ('stock.export', 'stock', 'Exportar planillas de stock', 'Descargar el stock en Excel y la planilla para contar.', 'operate', 'low', array['stock.view']::text[], array['stock.view']::text[], 'viewer', 'ui', 'ajustes_stock', 160),
  ('stock.adjust', 'stock', 'Ajustar stock a mano', 'Sumar, restar o fijar stock con motivo, mermas y producción. Desde el umbral, queda pendiente de aprobación.', 'admin', 'high', array['stock.view']::text[], array['stock.view']::text[], 'cashier', 'server', 'ajustes_stock', 170),
  ('stock.count', 'stock', 'Contar stock', 'Conteos cíclicos y ajustes con motivo Conteo (inventario físico), aunque no pueda hacer otros ajustes.', 'operate', 'medium', array['stock.view']::text[], array['stock.view']::text[], 'cashier', 'server', 'ajustes_stock', 180),
  ('stock.import', 'stock', 'Importar ajustes y conteos desde Excel', 'Carga rápida desde la planilla. Además pide la importación desde Excel en el plan.', 'admin', 'high', array['stock.view']::text[], array['stock.view']::text[], 'manager', 'server', 'ajustes_stock', 190),
  ('stock.adjust.approve', 'stock', 'Aprobar ajustes de stock', 'Aprobar o rechazar los ajustes pendientes que cargó otra persona (auditor de inventario).', 'admin', 'critical', array['stock.view']::text[], array['stock.view']::text[], 'cashier', 'server', 'aprobacion_ajustes', 200),
  ('stock.settings', 'stock', 'Configurar la aprobación de ajustes', 'Prender la aprobación, el umbral, la foto obligatoria y quién aprueba.', 'admin', 'high', array['stock.view']::text[], array['stock.view']::text[], 'cashier', 'server', 'aprobacion_ajustes', 210),
  ('customers.view', 'clientes', 'Ver clientes', 'Ver la lista y la ficha de los clientes.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 220),
  ('customers.create', 'clientes', 'Dar de alta clientes', 'Crear clientes nuevos desde Clientes o desde el POS.', 'operate', 'low', array['customers.view']::text[], array['customers.view']::text[], 'cashier', 'server', null, 230),
  ('customers.edit', 'clientes', 'Editar clientes', 'Cambiar datos de contacto y fiscales de un cliente.', 'operate', 'low', array['customers.view']::text[], array['customers.view']::text[], 'cashier', 'server', null, 240),
  ('customers.delete', 'clientes', 'Dar de baja clientes', 'Dar de baja un cliente (queda en la historia).', 'admin', 'medium', array['customers.edit']::text[], array['customers.edit', 'customers.view']::text[], 'cashier', 'server', null, 250),
  ('purchases.manage', 'compras', 'Compras y proveedores', 'Cargar compras, proveedores, recepciones y costos de compra.', 'admin', 'high', array['products.view']::text[], array['products.view']::text[], 'manager', 'server', null, 260),
  ('treasury.manage', 'finanzas', 'Tesorería', 'Cuentas, cheques, pagos y cobranzas de tesorería.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 270),
  ('taxes.manage', 'finanzas', 'Impuestos', 'Regímenes, alícuotas, percepciones y retenciones del negocio.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 280),
  ('accounting.manage', 'finanzas', 'Contabilidad', 'Plan de cuentas, asientos y períodos contables.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 290),
  ('reports.view', 'reportes', 'Ver reportes', 'Ver los reportes de ventas, caja y stock de sus sucursales.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 300),
  ('reports.costs', 'reportes', 'Ver costos y márgenes', 'Ver márgenes, costo de lo vendido y alertas de margen.', 'admin', 'medium', array['reports.view']::text[], array['reports.view']::text[], 'viewer', 'server', null, 310),
  ('audit.view', 'reportes', 'Ver la auditoría', 'Ver quién hizo qué en el negocio (no sólo lo propio).', 'admin', 'medium', '{}'::text[], '{}'::text[], 'viewer', 'server', null, 320),
  ('config.edit', 'configuracion', 'Editar la configuración del POS', 'Topes de descuento, venta sin stock, tickets y reglas del POS.', 'admin', 'critical', '{}'::text[], '{}'::text[], 'manager', 'server', null, 330),
  ('config.security', 'configuracion', 'Seguridad y PIN de supervisor', 'Quién autoriza con PIN y qué acciones lo piden.', 'admin', 'critical', '{}'::text[], '{}'::text[], 'owner', 'server', null, 340),
  ('billing.manage', 'configuracion', 'Plan y suscripción', 'Cambiar el plan, pagar y ceder la titularidad.', 'admin', 'critical', '{}'::text[], '{}'::text[], 'owner', 'server', null, 350),
  ('team.view', 'equipo', 'Ver el equipo', 'Ver quién trabaja en el negocio y en qué sucursal.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 360),
  ('team.manage', 'equipo', 'Invitar y gestionar personal', 'Invitar, editar, suspender y asignar roles (nunca más permisos que los propios).', 'admin', 'critical', array['team.view']::text[], array['team.view']::text[], 'manager', 'server', null, 370),
  ('team.roles', 'equipo', 'Crear y editar roles', 'Crear roles, cambiar sus permisos y dar permisos puntuales.', 'admin', 'critical', array['team.manage']::text[], array['team.manage', 'team.view']::text[], 'owner', 'server', null, 380),
  ('integrations.manage', 'integraciones', 'Conectar logísticas y medios de pago', 'Credenciales de logísticas y comisiones de los medios de pago.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 390),
  ('logistics.view', 'logistica', 'Ver Logística', 'Ver expedición, hojas de ruta, flota y el detalle de cada entrega.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'server', null, 400),
  ('logistics.prepare', 'logistica', 'Armar y despachar entregas', 'Pasar entregas a armando y listo, despacharlas y emitir sus remitos.', 'operate', 'medium', array['logistics.view']::text[], array['logistics.view']::text[], 'cashier', 'server', null, 410),
  ('logistics.route.manage', 'logistica', 'Armar hojas de ruta', 'Crear hojas de ruta, sumar entregas, ordenar paradas, asignar camión y repartidor, y cancelar.', 'operate', 'medium', array['logistics.view']::text[], array['logistics.view']::text[], 'cashier', 'server', null, 420),
  ('logistics.deliver', 'logistica', 'Repartir con la app', 'Usar la app de reparto en sus hojas: salir, llegar, entregar con firma y foto o marcar que no se pudo.', 'operate', 'medium', '{}'::text[], '{}'::text[], 'cashier', 'server', null, 430),
  ('logistics.track', 'logistica', 'Ver el seguimiento', 'Ver en el mapa dónde está cada camión y lo entregado (llega con el mapa en vivo).', 'view', 'low', array['logistics.view']::text[], array['logistics.view']::text[], 'viewer', 'server', null, 440),
  ('logistics.fleet.manage', 'logistica', 'Flota, repartidores y orígenes', 'Alta y edición de vehículos con fotos, perfiles de repartidores y orígenes de reparto.', 'admin', 'medium', array['logistics.view']::text[], array['logistics.view']::text[], 'manager', 'server', null, 450),
  ('logistics.remito.void', 'logistica', 'Anular remitos', 'Anular un remito emitido con motivo.', 'admin', 'high', array['logistics.view']::text[], array['logistics.view']::text[], 'manager', 'ui', null, 460),
  ('logistics.cot.manage', 'logistica', 'COT: credenciales y reintentos', 'Cargar la clave de transporte de ARBA o AGIP y reintentar pedidos de COT (llega con el COT automático).', 'admin', 'critical', '{}'::text[], '{}'::text[], 'owner', 'ui', null, 470),
  ('logistics.settings', 'logistica', 'Configurar Logística', 'Remitos, copias y modelos, qué se exige en cada entrega y motivos de no entrega.', 'admin', 'high', array['logistics.view']::text[], array['logistics.view']::text[], 'manager', 'server', null, 480)
on conflict (key) do update set module = excluded.module, label = excluded.label, description = excluded.description,
  level = excluded.level, risk = excluded.risk, depends_on = excluded.depends_on, requires_all = excluded.requires_all,
  min_base = excluded.min_base, enforced = excluded.enforced, grant_feature = excluded.grant_feature, sort = excluded.sort,
  updated_at = now();

insert into permission_roles (id, tenant_id, key, name, description, color, icon, base_role, sort) values
  ('00000000-0000-4000-8000-0000000000a1', null, 'owner', 'Dueño', 'Todo el negocio, siempre. No se edita.', 'flame', 'crown', 'owner', 10),
  ('00000000-0000-4000-8000-0000000000a2', null, 'manager', 'Encargado', 'Opera todo el negocio salvo la configuración del POS, la seguridad y el plan.', 'gold', 'shield', 'manager', 20),
  ('00000000-0000-4000-8000-0000000000a3', null, 'cashier', 'Cajero', 'Vende y cobra en su turno, anula ventas del día y hace devoluciones.', 'blue', 'store', 'cashier', 30),
  ('00000000-0000-4000-8000-0000000000a4', null, 'viewer', 'Solo lectura', 'Mira ventas, caja, stock y reportes. No cambia nada.', 'slate', 'eye', 'viewer', 40),
  ('00000000-0000-4000-8000-0000000000a5', null, 'seller', 'Vendedor', 'Atiende y arma pedidos para que cobre la caja. No abre caja, no cobra ni anula.', 'green', 'tag', 'cashier', 50),
  ('00000000-0000-4000-8000-0000000000a6', null, 'auditor', 'Auditor', 'Mira todo, incluso costos y auditoría, sin tocar nada.', 'violet', 'search', 'viewer', 60),
  ('00000000-0000-4000-8000-0000000000a7', null, 'driver', 'Repartidor', 'Sólo la app de reparto: sus hojas de ruta, entregas con firma, foto y ubicación. No vende ni ve caja.', 'teal', 'truck', 'cashier', 70)
on conflict (id) do update set key = excluded.key, name = excluded.name, description = excluded.description,
  color = excluded.color, icon = excluded.icon, base_role = excluded.base_role, sort = excluded.sort, updated_at = now();

delete from permission_role_capabilities where tenant_id is null;
insert into permission_role_capabilities (role_id, capability, tenant_id) values
  ('00000000-0000-4000-8000-0000000000a1', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'sales.create', null),
  ('00000000-0000-4000-8000-0000000000a1', 'sales.void', null),
  ('00000000-0000-4000-8000-0000000000a1', 'sales.void.past_days', null),
  ('00000000-0000-4000-8000-0000000000a1', 'sales.return', null),
  ('00000000-0000-4000-8000-0000000000a1', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'cash.open', null),
  ('00000000-0000-4000-8000-0000000000a1', 'cash.close', null),
  ('00000000-0000-4000-8000-0000000000a1', 'cash.movements', null),
  ('00000000-0000-4000-8000-0000000000a1', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'products.edit', null),
  ('00000000-0000-4000-8000-0000000000a1', 'products.price', null),
  ('00000000-0000-4000-8000-0000000000a1', 'prices.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.adjust', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.count', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.import', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.adjust.approve', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.settings', null),
  ('00000000-0000-4000-8000-0000000000a1', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a1', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a1', 'customers.delete', null),
  ('00000000-0000-4000-8000-0000000000a1', 'purchases.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'treasury.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'taxes.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'accounting.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'reports.costs', null),
  ('00000000-0000-4000-8000-0000000000a1', 'audit.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'config.edit', null),
  ('00000000-0000-4000-8000-0000000000a1', 'config.security', null),
  ('00000000-0000-4000-8000-0000000000a1', 'billing.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'team.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'team.roles', null),
  ('00000000-0000-4000-8000-0000000000a1', 'integrations.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.prepare', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.route.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.deliver', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.track', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.fleet.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.remito.void', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.cot.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.settings', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.create', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.void', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.void.past_days', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.return', null),
  ('00000000-0000-4000-8000-0000000000a2', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'cash.open', null),
  ('00000000-0000-4000-8000-0000000000a2', 'cash.close', null),
  ('00000000-0000-4000-8000-0000000000a2', 'cash.movements', null),
  ('00000000-0000-4000-8000-0000000000a2', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'products.edit', null),
  ('00000000-0000-4000-8000-0000000000a2', 'products.price', null),
  ('00000000-0000-4000-8000-0000000000a2', 'prices.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.adjust', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.count', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.import', null),
  ('00000000-0000-4000-8000-0000000000a2', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a2', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a2', 'customers.delete', null),
  ('00000000-0000-4000-8000-0000000000a2', 'purchases.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'treasury.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'taxes.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'accounting.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'reports.costs', null),
  ('00000000-0000-4000-8000-0000000000a2', 'audit.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'team.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'integrations.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.prepare', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.route.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.deliver', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.track', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.fleet.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.remito.void', null),
  ('00000000-0000-4000-8000-0000000000a3', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'sales.create', null),
  ('00000000-0000-4000-8000-0000000000a3', 'sales.void', null),
  ('00000000-0000-4000-8000-0000000000a3', 'sales.return', null),
  ('00000000-0000-4000-8000-0000000000a3', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'cash.open', null),
  ('00000000-0000-4000-8000-0000000000a3', 'cash.close', null),
  ('00000000-0000-4000-8000-0000000000a3', 'cash.movements', null),
  ('00000000-0000-4000-8000-0000000000a3', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a3', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a3', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'logistics.prepare', null),
  ('00000000-0000-4000-8000-0000000000a4', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a4', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a5', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'logistics.track', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a6', 'reports.costs', null),
  ('00000000-0000-4000-8000-0000000000a6', 'audit.view', null),
  ('00000000-0000-4000-8000-0000000000a7', 'logistics.deliver', null);
-- @@SEED-FIN@@
