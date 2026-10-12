-- =============================================================================
-- 20261013200200_traslados  (F17 · H95, ADR-046)
--
-- Traslados de stock entre sucursales.
--
-- Máquina de estados (espejo puro en lib/stock/transfers.ts):
--   draft ──submit──▶ pending_approval ──approve──▶ scheduled
--     │                    │ reject (vuelve a draft)     │
--     └──submit (sin aprobación)────────────────────────▶ scheduled
--   scheduled ──dispatch──▶ in_transit   (descuenta el origen)
--   in_transit ──receive──▶ partially_received | received  (suma al destino)
--   partially_received ──receive──▶ partially_received | received
--   draft | pending_approval | scheduled ──cancel──▶ cancelled (sin stock)
--   in_transit ──cancel──▶ cancelled (devuelve lo despachado al origen)
--
-- • "Programado": scheduled_for (fecha). Sin cron: vence en forma perezosa
--   (la UI lo muestra como "para despachar hoy" o "atrasado").
-- • Aprobación opcional por negocio (stock_transfer_settings): todos, o sólo
--   arriba de N unidades o de $ valor (a costo). Aprueba el dueño o un encargado
--   distinto de quien lo armó (cuatro ojos).
-- • Recepción parcial o total; al cerrar, cada diferencia (faltante o sobrante)
--   queda con motivo. El faltante no vuelve a ninguna sucursal: salió del
--   origen al despachar y queda registrado en el ítem.
-- • Remito interno: número correlativo por negocio (stock_transfers.number).
-- • Todo por RPC SECURITY DEFINER con search_path fijo; las tablas sólo tienen
--   policies de lectura. Cada paso deja evento (timeline) y audit_logs.
-- • Gating: traslados + multi_sucursal (server-side) y al menos 2 sucursales.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración por negocio.
-- -----------------------------------------------------------------------------
create table if not exists stock_transfer_settings (
  tenant_id                    uuid primary key default current_tenant_id()
                                 references tenants(id) on delete cascade,
  require_approval             boolean not null default false,
  approval_min_units           numeric(12,3) check (approval_min_units is null or approval_min_units > 0),
  approval_min_value           numeric(14,2) check (approval_min_value is null or approval_min_value > 0),
  cashier_can_dispatch         boolean not null default false,
  cashier_can_receive          boolean not null default true,
  allow_over_receive           boolean not null default true,
  require_difference_reason    boolean not null default true,
  block_dispatch_without_stock boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  updated_by                   uuid default auth.uid() references public.users(id)
);

comment on table stock_transfer_settings is
  'Reglas de traslados por negocio (F17/H95, ADR-046): aprobación, permisos de cajero, sobrantes y diferencias.';

drop trigger if exists set_updated_at_stock_transfer_settings on stock_transfer_settings;
create trigger set_updated_at_stock_transfer_settings
  before update on stock_transfer_settings
  for each row execute function set_updated_at();

alter table stock_transfer_settings enable row level security;

drop policy if exists stock_transfer_settings_select on stock_transfer_settings;
create policy stock_transfer_settings_select on stock_transfer_settings
  for select using (tenant_id = (select current_tenant_id()) or (select is_internal()));

drop policy if exists stock_transfer_settings_insert on stock_transfer_settings;
create policy stock_transfer_settings_insert on stock_transfer_settings
  for insert with check (
    tenant_id = (select current_tenant_id())
    and (select stock_my_role()) in ('owner', 'manager')
  );

drop policy if exists stock_transfer_settings_update on stock_transfer_settings;
create policy stock_transfer_settings_update on stock_transfer_settings
  for update using (
    tenant_id = (select current_tenant_id())
    and (select stock_my_role()) in ('owner', 'manager')
  )
  with check (
    tenant_id = (select current_tenant_id())
    and (select stock_my_role()) in ('owner', 'manager')
  );

drop trigger if exists audit_stock_transfer_settings on stock_transfer_settings;
create trigger audit_stock_transfer_settings
  after insert or update on stock_transfer_settings
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- B) Traslados, ítems y eventos.
-- -----------------------------------------------------------------------------
create table if not exists stock_transfers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  number          int not null,
  origin_store_id uuid not null references stores(id),
  dest_store_id   uuid not null references stores(id),
  status          text not null default 'draft'
                    check (status in ('draft','pending_approval','scheduled','in_transit',
                                      'partially_received','received','cancelled')),
  scheduled_for   date,
  notes           text check (notes is null or char_length(notes) <= 500),
  carrier         text check (carrier is null or char_length(carrier) <= 120),
  cancel_reason   text,
  total_units     numeric(14,3) not null default 0,
  total_value     numeric(14,2) not null default 0,
  needs_approval  boolean not null default false,
  created_by      uuid default auth.uid() references public.users(id),
  submitted_at    timestamptz,
  approved_by     uuid references public.users(id),
  approved_at     timestamptz,
  dispatched_by   uuid references public.users(id),
  dispatched_at   timestamptz,
  received_by     uuid references public.users(id),
  received_at     timestamptz,
  cancelled_by    uuid references public.users(id),
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint stock_transfers_distinct_stores check (origin_store_id <> dest_store_id),
  constraint stock_transfers_tenant_number_key unique (tenant_id, number)
);

create index if not exists stock_transfers_tenant_status_idx
  on stock_transfers(tenant_id, status, scheduled_for) where deleted_at is null;
create index if not exists stock_transfers_origin_idx on stock_transfers(origin_store_id);
create index if not exists stock_transfers_dest_idx on stock_transfers(dest_store_id);

drop trigger if exists set_updated_at_stock_transfers on stock_transfers;
create trigger set_updated_at_stock_transfers
  before update on stock_transfers
  for each row execute function set_updated_at();

create table if not exists stock_transfer_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  transfer_id       uuid not null references stock_transfers(id) on delete cascade,
  product_id        uuid not null references products(id),
  variant_id        uuid references product_variants(id),
  product_name      text not null,
  variant_label     text,
  sku               text,
  unit              text not null default 'un',
  unit_cost         numeric(12,2),
  qty_requested     numeric(12,3) not null check (qty_requested > 0),
  qty_dispatched    numeric(12,3) check (qty_dispatched is null or qty_dispatched >= 0),
  qty_received      numeric(12,3) not null default 0 check (qty_received >= 0),
  difference_reason text check (difference_reason is null or difference_reason in
                       ('faltante','danado','vencido','error_despacho','sobrante','otro')),
  notes             text check (notes is null or char_length(notes) <= 200),
  sort              int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint stock_transfer_items_line_key unique nulls not distinct (transfer_id, product_id, variant_id)
);

create index if not exists stock_transfer_items_transfer_idx on stock_transfer_items(transfer_id);
create index if not exists stock_transfer_items_product_idx on stock_transfer_items(product_id, variant_id);
create index if not exists stock_transfer_items_tenant_idx on stock_transfer_items(tenant_id);

drop trigger if exists set_updated_at_stock_transfer_items on stock_transfer_items;
create trigger set_updated_at_stock_transfer_items
  before update on stock_transfer_items
  for each row execute function set_updated_at();

create table if not exists stock_transfer_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  transfer_id uuid not null references stock_transfers(id) on delete cascade,
  kind        text not null,
  from_status text,
  to_status   text,
  actor_id    uuid references public.users(id),
  notes       text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists stock_transfer_events_transfer_idx
  on stock_transfer_events(transfer_id, created_at);
create index if not exists stock_transfer_events_tenant_idx on stock_transfer_events(tenant_id);

alter table stock_transfers enable row level security;
alter table stock_transfer_items enable row level security;
alter table stock_transfer_events enable row level security;

drop policy if exists stock_transfers_select on stock_transfers;
create policy stock_transfers_select on stock_transfers
  for select using (tenant_id = (select current_tenant_id()) or (select is_internal()));

drop policy if exists stock_transfer_items_select on stock_transfer_items;
create policy stock_transfer_items_select on stock_transfer_items
  for select using (tenant_id = (select current_tenant_id()) or (select is_internal()));

drop policy if exists stock_transfer_events_select on stock_transfer_events;
create policy stock_transfer_events_select on stock_transfer_events
  for select using (tenant_id = (select current_tenant_id()) or (select is_internal()));

-- -----------------------------------------------------------------------------
-- C) Helpers.
-- -----------------------------------------------------------------------------
-- Guard común: negocio, miembro activo y plan. Devuelve el tenant.
create or replace function transfer_assert()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if stock_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
    raise exception 'feature_not_in_plan: multi_sucursal';
  end if;
  if not tenant_has_feature_for(v_tenant, 'traslados') then
    raise exception 'feature_not_in_plan: traslados';
  end if;
  return v_tenant;
end;
$$;
revoke all on function transfer_assert() from public, anon;
grant execute on function transfer_assert() to authenticated;

-- Configuración efectiva (defaults si el negocio no guardó nada).
create or replace function transfer_settings_for(p_tenant uuid)
returns stock_transfer_settings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v stock_transfer_settings;
begin
  select * into v from stock_transfer_settings where tenant_id = p_tenant;
  if v.tenant_id is null then
    v.tenant_id := p_tenant;
    v.require_approval := false;
    v.cashier_can_dispatch := false;
    v.cashier_can_receive := true;
    v.allow_over_receive := true;
    v.require_difference_reason := true;
    v.block_dispatch_without_stock := true;
  end if;
  return v;
end;
$$;
revoke all on function transfer_settings_for(uuid) from public, anon, authenticated;

-- ¿Necesita aprobación? (espejo de needsApproval en lib/stock/transfers.ts)
create or replace function transfer_needs_approval(p_tenant uuid, p_units numeric, p_value numeric)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v stock_transfer_settings := transfer_settings_for(p_tenant);
begin
  if not v.require_approval then
    return false;
  end if;
  if v.approval_min_units is null and v.approval_min_value is null then
    return true;
  end if;
  return (v.approval_min_units is not null and coalesce(p_units, 0) >= v.approval_min_units)
      or (v.approval_min_value is not null and coalesce(p_value, 0) >= v.approval_min_value);
end;
$$;
revoke all on function transfer_needs_approval(uuid, numeric, numeric) from public, anon, authenticated;

-- Evento de timeline + audit_logs.
create or replace function transfer_log(
  p_transfer stock_transfers,
  p_kind     text,
  p_from     text,
  p_to       text,
  p_notes    text default null,
  p_data     jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into stock_transfer_events (tenant_id, transfer_id, kind, from_status, to_status, actor_id, notes, data)
  values (p_transfer.tenant_id, p_transfer.id, p_kind, p_from, p_to, auth.uid(),
          nullif(trim(coalesce(p_notes, '')), ''), coalesce(p_data, '{}'::jsonb));

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_transfer.tenant_id, auth.uid(), 'stock_transfers', p_transfer.id, 'transfer_' || p_kind,
          case when p_from is null then null else jsonb_build_object('status', p_from) end,
          jsonb_build_object('status', p_to, 'number', p_transfer.number,
                             'origin_store_id', p_transfer.origin_store_id,
                             'dest_store_id', p_transfer.dest_store_id) || coalesce(p_data, '{}'::jsonb),
          nullif(trim(coalesce(p_notes, '')), ''));
end;
$$;
revoke all on function transfer_log(stock_transfers, text, text, text, text, jsonb) from public, anon, authenticated;

-- Carga y bloquea el traslado del negocio actual.
create or replace function transfer_lock(p_tenant uuid, p_id uuid)
returns stock_transfers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v stock_transfers;
begin
  select * into v from stock_transfers
   where id = p_id and tenant_id = p_tenant and deleted_at is null
   for update;
  if v.id is null then
    raise exception 'transfer_not_found';
  end if;
  return v;
end;
$$;
revoke all on function transfer_lock(uuid, uuid) from public, anon, authenticated;

-- Mueve stock de una sucursal: total consolidado + movimiento con sucursal.
create or replace function transfer_move_stock(
  p_tenant   uuid,
  p_store    uuid,
  p_product  uuid,
  p_variant  uuid,
  p_delta    numeric,
  p_reason   text,
  p_transfer uuid,
  p_notes    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_delta, 0) = 0 then
    return;
  end if;
  if p_variant is null then
    update products
       set stock = stock + p_delta, updated_at = now()
     where id = p_product and tenant_id = p_tenant;
  else
    update product_variants
       set stock = stock + p_delta, updated_at = now()
     where id = p_variant and tenant_id = p_tenant;
  end if;

  insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id, notes, created_by)
  values (p_tenant, p_product, p_variant, p_store, p_delta, p_reason, p_transfer, p_notes, auth.uid());
end;
$$;
revoke all on function transfer_move_stock(uuid, uuid, uuid, uuid, numeric, text, uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Crear / editar borrador.
--    p_items: [{product_id, variant_id?, qty, notes?}]. Las líneas repetidas se
--    suman. Kits y productos sin control de stock no se trasladan.
-- -----------------------------------------------------------------------------
create or replace function transfer_save(
  p_id            uuid,
  p_origin        uuid,
  p_dest          uuid,
  p_scheduled_for date,
  p_notes         text,
  p_items         jsonb,
  p_carrier       text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := transfer_assert();
  v_role   text := stock_my_role();
  v_t      stock_transfers;
  v_number int;
  v_item   record;
  v_prod   record;
  v_var_id    uuid;
  v_var_label text;
  v_var_sku   text;
  v_sort   int := 0;
  v_units  numeric := 0;
  v_value  numeric := 0;
  v_kind   text;
begin
  if v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_origin is null or p_dest is null then
    raise exception 'stores_required';
  end if;
  if p_origin = p_dest then
    raise exception 'same_store';
  end if;
  if stock_store_count(v_tenant) < 2 then
    raise exception 'single_store';
  end if;
  if (select count(*) from stores
       where id in (p_origin, p_dest) and tenant_id = v_tenant
         and deleted_at is null and is_active) <> 2 then
    raise exception 'store_not_found';
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items';
  end if;

  if p_id is null then
    perform pg_advisory_xact_lock(hashtext('stock_transfer_number:' || v_tenant::text));
    select coalesce(max(number), 0) + 1 into v_number from stock_transfers where tenant_id = v_tenant;
    insert into stock_transfers (tenant_id, number, origin_store_id, dest_store_id, status,
                                 scheduled_for, notes, carrier, created_by)
    values (v_tenant, v_number, p_origin, p_dest, 'draft', p_scheduled_for,
            nullif(trim(coalesce(p_notes, '')), ''), nullif(trim(coalesce(p_carrier, '')), ''),
            auth.uid())
    returning * into v_t;
    v_kind := 'created';
  else
    v_t := transfer_lock(v_tenant, p_id);
    if v_t.status <> 'draft' then
      raise exception 'invalid_transition: % -> draft', v_t.status;
    end if;
    update stock_transfers
       set origin_store_id = p_origin,
           dest_store_id = p_dest,
           scheduled_for = p_scheduled_for,
           notes = nullif(trim(coalesce(p_notes, '')), ''),
           carrier = nullif(trim(coalesce(p_carrier, '')), '')
     where id = v_t.id
    returning * into v_t;
    -- Líneas de un borrador: se reemplazan enteras (todavía no movieron stock).
    delete from stock_transfer_items where transfer_id = v_t.id;
    v_kind := 'updated';
  end if;

  for v_item in
    select (e.value ->> 'product_id')::uuid as product_id,
           (e.value ->> 'variant_id')::uuid as variant_id,
           sum((e.value ->> 'qty')::numeric) as qty,
           max(e.value ->> 'notes') as notes
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as e(value, ord)
     group by 1, 2
     order by min(e.ord)
  loop
    if v_item.product_id is null or coalesce(v_item.qty, 0) <= 0 then
      raise exception 'invalid_qty';
    end if;

    select id, name, sku, unit, cost, is_kit, track_stock, has_variants into v_prod
      from products
     where id = v_item.product_id and tenant_id = v_tenant and deleted_at is null;
    if v_prod.id is null then
      raise exception 'product_not_found';
    end if;
    if coalesce(v_prod.is_kit, false) then
      raise exception 'kit_not_transferable';
    end if;
    if not coalesce(v_prod.track_stock, true) then
      raise exception 'untracked_not_transferable';
    end if;

    v_var_id := null;
    v_var_label := null;
    v_var_sku := null;
    if coalesce(v_prod.has_variants, false) then
      if v_item.variant_id is null then
        raise exception 'variant_required';
      end if;
      select id, option1 || coalesce(' / ' || option2, ''), sku
        into v_var_id, v_var_label, v_var_sku
        from product_variants
       where id = v_item.variant_id and product_id = v_prod.id and tenant_id = v_tenant
         and deleted_at is null;
      if v_var_id is null then
        raise exception 'variant_not_found';
      end if;
    elsif v_item.variant_id is not null then
      raise exception 'variant_not_allowed';
    end if;

    v_sort := v_sort + 1;
    insert into stock_transfer_items (tenant_id, transfer_id, product_id, variant_id, product_name,
                                      variant_label, sku, unit, unit_cost, qty_requested, notes, sort)
    values (v_tenant, v_t.id, v_prod.id, v_var_id, v_prod.name, v_var_label,
            coalesce(v_var_sku, v_prod.sku), coalesce(v_prod.unit, 'un'), v_prod.cost,
            v_item.qty, nullif(trim(coalesce(v_item.notes, '')), ''), v_sort);

    v_units := v_units + v_item.qty;
    v_value := v_value + v_item.qty * coalesce(v_prod.cost, 0);
  end loop;

  update stock_transfers
     set total_units = v_units,
         total_value = round(v_value, 2),
         needs_approval = transfer_needs_approval(v_tenant, v_units, v_value)
   where id = v_t.id
  returning * into v_t;

  perform transfer_log(v_t, v_kind, case when v_kind = 'created' then null else 'draft' end, 'draft',
                       null, jsonb_build_object('items', v_sort, 'units', v_units));
  return v_t.id;
end;
$$;
revoke all on function transfer_save(uuid, uuid, uuid, date, text, jsonb, text) from public, anon;
grant execute on function transfer_save(uuid, uuid, uuid, date, text, jsonb, text) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Confirmar (borrador → pendiente de aprobación | programado).
-- -----------------------------------------------------------------------------
create or replace function transfer_submit(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := transfer_assert();
  v_t      stock_transfers;
  v_to     text;
  v_needs  boolean;
begin
  if stock_my_role() not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_t := transfer_lock(v_tenant, p_id);
  if v_t.status <> 'draft' then
    raise exception 'invalid_transition: % -> scheduled', v_t.status;
  end if;
  if not exists (select 1 from stock_transfer_items where transfer_id = v_t.id) then
    raise exception 'transfer_empty';
  end if;
  if stock_store_count(v_tenant) < 2 then
    raise exception 'single_store';
  end if;

  v_needs := transfer_needs_approval(v_tenant, v_t.total_units, v_t.total_value);
  -- El dueño no necesita pedirse aprobación a sí mismo.
  v_to := case when v_needs and stock_my_role() <> 'owner' then 'pending_approval' else 'scheduled' end;

  update stock_transfers
     set status = v_to,
         needs_approval = v_needs,
         submitted_at = now(),
         approved_by = case when v_to = 'scheduled' and v_needs then auth.uid() else approved_by end,
         approved_at = case when v_to = 'scheduled' and v_needs then now() else approved_at end
   where id = v_t.id
  returning * into v_t;

  perform transfer_log(v_t, 'submitted', 'draft', v_to);
  return v_to;
end;
$$;
revoke all on function transfer_submit(uuid) from public, anon;
grant execute on function transfer_submit(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Aprobar / rechazar.
-- -----------------------------------------------------------------------------
create or replace function transfer_approve(p_id uuid, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := transfer_assert();
  v_role   text := stock_my_role();
  v_t      stock_transfers;
begin
  v_t := transfer_lock(v_tenant, p_id);
  if v_t.status <> 'pending_approval' then
    raise exception 'invalid_transition: % -> scheduled', v_t.status;
  end if;
  -- Cuatro ojos: aprueba el dueño o un encargado que no armó el traslado.
  if not (v_role = 'owner' or (v_role = 'manager' and v_t.created_by is distinct from auth.uid())) then
    raise exception 'forbidden_approval' using errcode = '42501';
  end if;

  update stock_transfers
     set status = 'scheduled', approved_by = auth.uid(), approved_at = now()
   where id = v_t.id
  returning * into v_t;

  perform transfer_log(v_t, 'approved', 'pending_approval', 'scheduled', p_notes);
end;
$$;
revoke all on function transfer_approve(uuid, text) from public, anon;
grant execute on function transfer_approve(uuid, text) to authenticated;

create or replace function transfer_reject(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := transfer_assert();
  v_role   text := stock_my_role();
  v_t      stock_transfers;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  v_t := transfer_lock(v_tenant, p_id);
  if v_t.status <> 'pending_approval' then
    raise exception 'invalid_transition: % -> draft', v_t.status;
  end if;
  if not (v_role = 'owner' or (v_role = 'manager' and v_t.created_by is distinct from auth.uid())) then
    raise exception 'forbidden_approval' using errcode = '42501';
  end if;

  update stock_transfers set status = 'draft', submitted_at = null
   where id = v_t.id
  returning * into v_t;

  perform transfer_log(v_t, 'rejected', 'pending_approval', 'draft', p_reason);
end;
$$;
revoke all on function transfer_reject(uuid, text) from public, anon;
grant execute on function transfer_reject(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Reprogramar (fecha) sin volver a borrador.
-- -----------------------------------------------------------------------------
create or replace function transfer_reschedule(p_id uuid, p_date date, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := transfer_assert();
  v_t      stock_transfers;
  v_prev   date;
begin
  if stock_my_role() not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_t := transfer_lock(v_tenant, p_id);
  if v_t.status not in ('draft', 'pending_approval', 'scheduled') then
    raise exception 'invalid_transition: % -> scheduled', v_t.status;
  end if;
  v_prev := v_t.scheduled_for;
  update stock_transfers set scheduled_for = p_date where id = v_t.id returning * into v_t;
  perform transfer_log(v_t, 'rescheduled', v_t.status, v_t.status, p_notes,
                       jsonb_build_object('from_date', v_prev, 'to_date', p_date));
end;
$$;
revoke all on function transfer_reschedule(uuid, date, text) from public, anon;
grant execute on function transfer_reschedule(uuid, date, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Despachar (programado → en tránsito). Descuenta el origen.
--    p_items opcional: [{item_id, qty}] para despachar otra cantidad (0 = no va).
-- -----------------------------------------------------------------------------
create or replace function transfer_dispatch(p_id uuid, p_items jsonb default null, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := transfer_assert();
  v_role   text := stock_my_role();
  v_set    stock_transfer_settings;
  v_t      stock_transfers;
  v_it     record;
  v_q      numeric;
  v_have   numeric;
  v_sent   numeric := 0;
  v_value  numeric := 0;
begin
  v_set := transfer_settings_for(v_tenant);
  if not (v_role in ('owner', 'manager') or (v_role = 'cashier' and v_set.cashier_can_dispatch)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items';
  end if;

  v_t := transfer_lock(v_tenant, p_id);
  if v_t.status <> 'scheduled' then
    raise exception 'invalid_transition: % -> in_transit', v_t.status;
  end if;
  if not exists (select 1 from stores where id = v_t.origin_store_id and deleted_at is null)
     or not exists (select 1 from stores where id = v_t.dest_store_id and deleted_at is null) then
    raise exception 'store_not_found';
  end if;

  for v_it in
    select i.*
      from stock_transfer_items i
     where i.transfer_id = v_t.id
     order by i.sort
  loop
    v_q := v_it.qty_requested;
    if p_items is not null then
      select x.qty into v_q
        from jsonb_to_recordset(p_items) as x(item_id uuid, qty numeric)
       where x.item_id = v_it.id;
      v_q := coalesce(v_q, v_it.qty_requested);
    end if;
    if v_q < 0 then
      raise exception 'invalid_qty';
    end if;

    if v_q > 0 and v_set.block_dispatch_without_stock then
      select qty into v_have
        from product_stock
       where store_id = v_t.origin_store_id and product_id = v_it.product_id
         and variant_id is not distinct from v_it.variant_id
       for update;
      if coalesce(v_have, 0) < v_q then
        raise exception 'insufficient_stock_origin: %', v_it.product_name
          using detail = jsonb_build_object('item_id', v_it.id, 'available', coalesce(v_have, 0),
                                            'requested', v_q)::text;
      end if;
    end if;

    update stock_transfer_items set qty_dispatched = v_q where id = v_it.id;

    if v_q > 0 then
      perform transfer_move_stock(v_tenant, v_t.origin_store_id, v_it.product_id, v_it.variant_id,
                                  -v_q, 'transfer_out', v_t.id,
                                  'Traslado R-' || lpad(v_t.number::text, 6, '0') || ' (envío)');
      v_sent := v_sent + v_q;
      v_value := v_value + v_q * coalesce(v_it.unit_cost, 0);
    end if;
  end loop;

  if v_sent <= 0 then
    raise exception 'nothing_to_dispatch';
  end if;

  update stock_transfers
     set status = 'in_transit', dispatched_by = auth.uid(), dispatched_at = now()
   where id = v_t.id
  returning * into v_t;

  perform transfer_log(v_t, 'dispatched', 'scheduled', 'in_transit', p_notes,
                       jsonb_build_object('units', v_sent, 'value', round(v_value, 2)));
end;
$$;
revoke all on function transfer_dispatch(uuid, jsonb, text) from public, anon;
grant execute on function transfer_dispatch(uuid, jsonb, text) to authenticated;

-- -----------------------------------------------------------------------------
-- I) Recibir (en tránsito | recibido parcial → recibido parcial | recibido).
--    p_items: [{item_id, qty, reason?, notes?}] con la cantidad que llega AHORA.
--    p_close: cierra la recepción aunque falte mercadería (las diferencias
--    quedan con motivo). Si todo llegó completo, cierra solo.
-- -----------------------------------------------------------------------------
create or replace function transfer_receive(
  p_id    uuid,
  p_items jsonb,
  p_close boolean default false,
  p_notes text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := transfer_assert();
  v_role   text := stock_my_role();
  v_set    stock_transfer_settings;
  v_t      stock_transfers;
  v_from   text;
  v_to     text;
  v_in     record;
  v_it     stock_transfer_items;
  v_new    numeric;
  v_got    numeric := 0;
  v_open   boolean;
  v_diffs  jsonb := '[]'::jsonb;
begin
  v_set := transfer_settings_for(v_tenant);
  if not (v_role in ('owner', 'manager') or (v_role = 'cashier' and v_set.cashier_can_receive)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items';
  end if;

  v_t := transfer_lock(v_tenant, p_id);
  if v_t.status not in ('in_transit', 'partially_received') then
    raise exception 'invalid_transition: % -> received', v_t.status;
  end if;
  v_from := v_t.status;

  for v_in in
    select x.item_id, coalesce(x.qty, 0) as qty, nullif(trim(coalesce(x.reason, '')), '') as reason,
           nullif(trim(coalesce(x.notes, '')), '') as notes
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb))
           as x(item_id uuid, qty numeric, reason text, notes text)
  loop
    select * into v_it from stock_transfer_items
     where id = v_in.item_id and transfer_id = v_t.id
     for update;
    if v_it.id is null then
      raise exception 'item_not_found';
    end if;
    if v_in.qty < 0 then
      raise exception 'invalid_qty';
    end if;
    v_new := v_it.qty_received + v_in.qty;
    if v_new > coalesce(v_it.qty_dispatched, 0) and not v_set.allow_over_receive then
      raise exception 'over_receive_not_allowed: %', v_it.product_name;
    end if;

    update stock_transfer_items
       set qty_received = v_new,
           difference_reason = coalesce(v_in.reason, difference_reason),
           notes = coalesce(v_in.notes, notes)
     where id = v_it.id;

    if v_in.qty > 0 then
      perform transfer_move_stock(v_tenant, v_t.dest_store_id, v_it.product_id, v_it.variant_id,
                                  v_in.qty, 'transfer_in', v_t.id,
                                  'Traslado R-' || lpad(v_t.number::text, 6, '0') || ' (recepción)');
      v_got := v_got + v_in.qty;
    end if;
  end loop;

  -- ¿Queda algo pendiente?
  select exists (
    select 1 from stock_transfer_items
     where transfer_id = v_t.id and qty_received < coalesce(qty_dispatched, 0)
  ) into v_open;

  if p_close or not v_open then
    -- Cierre: toda diferencia necesita motivo (si el negocio lo exige).
    if v_set.require_difference_reason and exists (
      select 1 from stock_transfer_items
       where transfer_id = v_t.id
         and qty_dispatched is not null
         and qty_received <> qty_dispatched
         and difference_reason is null
    ) then
      raise exception 'difference_reason_required';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', id, 'product', product_name, 'variant', variant_label,
             'dispatched', qty_dispatched, 'received', qty_received,
             'difference', qty_received - qty_dispatched, 'reason', difference_reason)), '[]'::jsonb)
      into v_diffs
      from stock_transfer_items
     where transfer_id = v_t.id and qty_dispatched is not null and qty_received <> qty_dispatched;
    v_to := 'received';
  else
    if v_got <= 0 then
      raise exception 'nothing_to_receive';
    end if;
    v_to := 'partially_received';
  end if;

  update stock_transfers
     set status = v_to,
         received_by = case when v_to = 'received' then auth.uid() else received_by end,
         received_at = case when v_to = 'received' then now() else received_at end
   where id = v_t.id
  returning * into v_t;

  perform transfer_log(v_t, case when v_to = 'received' then 'received' else 'partially_received' end,
                       v_from, v_to, p_notes,
                       jsonb_build_object('units', v_got, 'differences', v_diffs));
  return v_to;
end;
$$;
revoke all on function transfer_receive(uuid, jsonb, boolean, text) from public, anon;
grant execute on function transfer_receive(uuid, jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- J) Cancelar. En tránsito: lo despachado vuelve al origen.
-- -----------------------------------------------------------------------------
create or replace function transfer_cancel(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := transfer_assert();
  v_t      stock_transfers;
  v_from   text;
  v_it     record;
  v_back   numeric := 0;
begin
  if stock_my_role() not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  v_t := transfer_lock(v_tenant, p_id);
  v_from := v_t.status;
  if v_from not in ('draft', 'pending_approval', 'scheduled', 'in_transit') then
    raise exception 'invalid_transition: % -> cancelled', v_from;
  end if;

  if v_from = 'in_transit' then
    for v_it in
      select * from stock_transfer_items
       where transfer_id = v_t.id and coalesce(qty_dispatched, 0) > 0
    loop
      perform transfer_move_stock(v_tenant, v_t.origin_store_id, v_it.product_id, v_it.variant_id,
                                  v_it.qty_dispatched, 'transfer_return', v_t.id,
                                  'Traslado R-' || lpad(v_t.number::text, 6, '0') || ' cancelado (vuelve al origen)');
      v_back := v_back + v_it.qty_dispatched;
    end loop;
  end if;

  update stock_transfers
     set status = 'cancelled', cancel_reason = trim(p_reason),
         cancelled_by = auth.uid(), cancelled_at = now()
   where id = v_t.id
  returning * into v_t;

  perform transfer_log(v_t, 'cancelled', v_from, 'cancelled', p_reason,
                       jsonb_build_object('returned_units', v_back));
end;
$$;
revoke all on function transfer_cancel(uuid, text) from public, anon;
grant execute on function transfer_cancel(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- K) Lecturas (SECURITY INVOKER: aplica la RLS de cada tabla).
-- -----------------------------------------------------------------------------
-- Stock por sucursal de un conjunto de productos, con lo que está en camino.
create or replace function stock_by_store(p_product_ids uuid[])
returns table (
  store_id       uuid,
  product_id     uuid,
  variant_id     uuid,
  qty            numeric,
  min_qty        numeric,
  max_qty        numeric,
  location       text,
  in_transit_in  numeric,
  in_transit_out numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with transit as (
    select t.origin_store_id, t.dest_store_id, i.product_id, i.variant_id,
           greatest(coalesce(i.qty_dispatched, 0) - i.qty_received, 0) as pending
      from stock_transfer_items i
      join stock_transfers t on t.id = i.transfer_id
     where t.status in ('in_transit', 'partially_received')
       and t.deleted_at is null
       and i.product_id = any (p_product_ids)
  ),
  keys as (
    select ps.store_id, ps.product_id, ps.variant_id from product_stock ps
     where ps.product_id = any (p_product_ids)
    union
    select dest_store_id, product_id, variant_id from transit where pending > 0
    union
    select origin_store_id, product_id, variant_id from transit where pending > 0
  )
  select k.store_id, k.product_id, k.variant_id,
         coalesce(ps.qty, 0), ps.min_qty, ps.max_qty, ps.location,
         coalesce((select sum(tr.pending) from transit tr
                    where tr.dest_store_id = k.store_id and tr.product_id = k.product_id
                      and tr.variant_id is not distinct from k.variant_id), 0),
         coalesce((select sum(tr.pending) from transit tr
                    where tr.origin_store_id = k.store_id and tr.product_id = k.product_id
                      and tr.variant_id is not distinct from k.variant_id), 0)
    from keys k
    left join product_stock ps
      on ps.store_id = k.store_id and ps.product_id = k.product_id
     and ps.variant_id is not distinct from k.variant_id;
$$;
revoke all on function stock_by_store(uuid[]) from public, anon;
grant execute on function stock_by_store(uuid[]) to authenticated;

-- Productos y variantes bajo el mínimo en alguna sucursal, con el saldo de
-- TODAS las sucursales (para sugerir traslados desde la que tiene sobrante).
-- Mínimo efectivo: el de la sucursal o, si no tiene, products.stock_min.
create or replace function stock_low_by_store(p_limit int default 300)
returns table (
  product_id    uuid,
  variant_id    uuid,
  product_name  text,
  variant_label text,
  sku           text,
  unit          text,
  store_id      uuid,
  qty           numeric,
  min_qty       numeric,
  max_qty       numeric,
  in_transit_in numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with st as (
    select s.id from stores s
     where s.tenant_id = current_tenant_id() and s.deleted_at is null and s.is_active
  ),
  items as (
    select p.id as product_id, null::uuid as variant_id, p.name as product_name,
           null::text as variant_label, p.sku, p.unit, p.stock_min
      from products p
     where p.tenant_id = current_tenant_id() and p.deleted_at is null and p.is_active
       and coalesce(p.track_stock, true) and not coalesce(p.is_kit, false)
       and not coalesce(p.has_variants, false)
    union all
    select p.id, v.id, p.name, v.option1 || coalesce(' / ' || v.option2, ''),
           coalesce(v.sku, p.sku), p.unit, p.stock_min
      from product_variants v
      join products p on p.id = v.product_id
     where p.tenant_id = current_tenant_id() and p.deleted_at is null and p.is_active
       and v.deleted_at is null and coalesce(p.track_stock, true)
       and coalesce(p.has_variants, false)
  ),
  transit as (
    select t.dest_store_id, i.product_id, i.variant_id,
           sum(greatest(coalesce(i.qty_dispatched, 0) - i.qty_received, 0)) as pending
      from stock_transfer_items i
      join stock_transfers t on t.id = i.transfer_id
     where t.status in ('in_transit', 'partially_received') and t.deleted_at is null
     group by 1, 2, 3
  ),
  grid as (
    select i.*, s.id as store_id, coalesce(ps.qty, 0) as qty,
           coalesce(ps.min_qty, i.stock_min, 0) as min_qty, ps.max_qty,
           coalesce(tr.pending, 0) as in_transit_in
      from items i
      cross join st s
      left join product_stock ps
        on ps.store_id = s.id and ps.product_id = i.product_id
       and ps.variant_id is not distinct from i.variant_id
      left join transit tr
        on tr.dest_store_id = s.id and tr.product_id = i.product_id
       and tr.variant_id is not distinct from i.variant_id
  ),
  low as (
    select distinct g.product_id, g.variant_id
      from grid g
     where g.min_qty > 0 and g.qty + g.in_transit_in < g.min_qty
     limit greatest(1, least(coalesce(p_limit, 300), 1000))
  )
  select g.product_id, g.variant_id, g.product_name, g.variant_label, g.sku, g.unit,
         g.store_id, g.qty, g.min_qty, g.max_qty, g.in_transit_in
    from grid g
    join low l on l.product_id = g.product_id and l.variant_id is not distinct from g.variant_id;
$$;
revoke all on function stock_low_by_store(int) from public, anon;
grant execute on function stock_low_by_store(int) to authenticated;
