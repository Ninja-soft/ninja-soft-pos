-- =============================================================================
-- 20261107200100_depositos  (F11 · H33, ADR-085)
--
-- Depósitos dentro de cada sucursal, sin tocar create_sale / return_sale /
-- exchange_sale ni el libro de stock por sucursal (ADR-046).
--
-- Modelo: el depósito es un DESGLOSE del stock de la sucursal.
--   • warehouses: depósitos de una sucursal. Tipos: principal (salón de
--     ventas, uno por sucursal, se crea solo con el primer depósito), reserva,
--     devolucion, merma y otro.
--   • warehouse_stock: saldo de cada depósito que NO es el principal.
--   • El principal no se guarda: es lo que queda de la sucursal.
--       principal = product_stock.qty (sucursal)
--                 − Σ warehouse_stock.qty de la sucursal
--                 − lo que está en tránsito entre depósitos de la sucursal
--     Así el total de la sucursal (y products.stock) no cambia al mover entre
--     depósitos: create_sale sigue descontando de la sucursal y, por lo tanto,
--     del salón. Si se vende más de lo que hay en el salón, el principal queda
--     negativo y la página lo marca "a reponer" (create_sale valida contra el
--     total de la sucursal, no contra el salón: deuda documentada en ADR-085).
--   • warehouse_moves + warehouse_move_items: movimientos internos. Al
--     despachar sale del origen y queda en tránsito; la recepción suma al
--     destino (parcial o total). Al cerrar con diferencias:
--       faltante → sale de la sucursal como merma ('loss', con motivo);
--       sobrante → entra a la sucursal como ajuste ('adjustment', motivo).
--     Esas dos son las únicas operaciones que cambian el stock de la sucursal
--     y van por transfer_move_stock (mismo camino que los traslados: total
--     consolidado + movimiento con sucursal, invariante de ADR-046 intacto).
--
-- Seguridad:
--   • Lectura: tenant_id = current_tenant_id() or internal_scope() (ADR-052).
--     Los movimientos internos suman una RESTRICTIVE por sucursal
--     (user_allowed_store_ids), como los traslados (ADR-080). El saldo por
--     depósito no se restringe (como product_stock, ADR-080).
--   • Escritura sólo por RPC SECURITY DEFINER (sin policies de escritura) +
--     role_write_guard 'manage' en las cuatro tablas (ADR-071): solo lectura
--     no escribe nunca, ni a través de una RPC.
--   • Roles: crear y archivar depósitos, contar, despachar, cancelar y cerrar
--     con diferencias: dueño o encargado. Recibir (sin diferencias): también
--     el cajero, que es quien suele recibir la mercadería en el salón.
--   • Acceso a la sucursal: user_can_access_store en cada escritura.
--   • Gating: feature `depositos` en todas las RPC (warehouse_assert); fuera
--     de la sucursal principal del negocio pide también `stock_sucursales`.
--   • audit_logs en cada escritura.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tablas
-- -----------------------------------------------------------------------------
create table if not exists warehouses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  store_id    uuid not null references stores(id),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  code        text check (code is null or char_length(code) <= 20),
  kind        text not null default 'reserva'
                check (kind in ('principal', 'reserva', 'devolucion', 'merma', 'otro')),
  sort        int not null default 0,
  created_by  uuid default auth.uid() references public.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

comment on table warehouses is
  'Depósitos dentro de una sucursal (F11/H33, ADR-085). El principal es el salón de ventas: su saldo se calcula, no se guarda.';

create unique index if not exists warehouses_one_principal_key
  on warehouses(store_id) where kind = 'principal' and deleted_at is null;
create unique index if not exists warehouses_store_name_key
  on warehouses(store_id, lower(btrim(name))) where deleted_at is null;
create unique index if not exists warehouses_tenant_code_key
  on warehouses(tenant_id, lower(code)) where code is not null and deleted_at is null;
create index if not exists warehouses_tenant_idx on warehouses(tenant_id);

drop trigger if exists set_updated_at_warehouses on warehouses;
create trigger set_updated_at_warehouses
  before update on warehouses
  for each row execute function set_updated_at();

create table if not exists warehouse_stock (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  store_id     uuid not null references stores(id),
  product_id   uuid not null references products(id) on delete cascade,
  variant_id   uuid references product_variants(id) on delete cascade,
  qty          numeric(12,3) not null default 0 check (qty >= 0),
  updated_at   timestamptz not null default now(),
  constraint warehouse_stock_line_key unique nulls not distinct (warehouse_id, product_id, variant_id)
);

comment on table warehouse_stock is
  'Saldo de los depósitos que no son el principal (F11/H33, ADR-085). Sólo lo escriben las RPC warehouse_*.';

create index if not exists warehouse_stock_tenant_idx on warehouse_stock(tenant_id);
create index if not exists warehouse_stock_store_item_idx on warehouse_stock(store_id, product_id, variant_id);

drop trigger if exists set_updated_at_warehouse_stock on warehouse_stock;
create trigger set_updated_at_warehouse_stock
  before update on warehouse_stock
  for each row execute function set_updated_at();

create table if not exists warehouse_moves (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  store_id            uuid not null references stores(id),
  number              int not null,
  origin_warehouse_id uuid not null references warehouses(id),
  dest_warehouse_id   uuid not null references warehouses(id),
  status              text not null default 'in_transit'
                        check (status in ('in_transit', 'partially_received', 'received', 'cancelled')),
  reason              text not null default 'reposicion'
                        check (reason in ('reposicion', 'reserva', 'devolucion', 'merma', 'reorganizacion', 'otro')),
  notes               text check (notes is null or char_length(notes) <= 500),
  total_units         numeric(14,3) not null default 0,
  has_differences     boolean not null default false,
  cancel_reason       text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  created_by          uuid default auth.uid() references public.users(id),
  received_by         uuid references public.users(id),
  received_at         timestamptz,
  cancelled_by        uuid references public.users(id),
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint warehouse_moves_distinct check (origin_warehouse_id <> dest_warehouse_id),
  constraint warehouse_moves_tenant_number_key unique (tenant_id, number)
);

create index if not exists warehouse_moves_tenant_status_idx on warehouse_moves(tenant_id, status, created_at desc);
create index if not exists warehouse_moves_store_idx on warehouse_moves(store_id, status);
create index if not exists warehouse_moves_origin_idx on warehouse_moves(origin_warehouse_id);
create index if not exists warehouse_moves_dest_idx on warehouse_moves(dest_warehouse_id);

drop trigger if exists set_updated_at_warehouse_moves on warehouse_moves;
create trigger set_updated_at_warehouse_moves
  before update on warehouse_moves
  for each row execute function set_updated_at();

create table if not exists warehouse_move_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  move_id           uuid not null references warehouse_moves(id) on delete cascade,
  product_id        uuid not null references products(id),
  variant_id        uuid references product_variants(id),
  product_name      text not null,
  variant_label     text,
  sku               text,
  unit              text not null default 'un',
  qty_sent          numeric(12,3) not null check (qty_sent > 0),
  qty_received      numeric(12,3) not null default 0 check (qty_received >= 0),
  difference_reason text check (difference_reason is null or difference_reason in
                       ('faltante', 'danado', 'vencido', 'sobrante', 'error', 'otro')),
  notes             text check (notes is null or char_length(notes) <= 200),
  sort              int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint warehouse_move_items_line_key unique nulls not distinct (move_id, product_id, variant_id)
);

create index if not exists warehouse_move_items_move_idx on warehouse_move_items(move_id);
create index if not exists warehouse_move_items_item_idx on warehouse_move_items(product_id, variant_id);
create index if not exists warehouse_move_items_tenant_idx on warehouse_move_items(tenant_id);

drop trigger if exists set_updated_at_warehouse_move_items on warehouse_move_items;
create trigger set_updated_at_warehouse_move_items
  before update on warehouse_move_items
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- B) RLS: lectura por negocio (internal_scope, ADR-052) + alcance de sucursal
--    en los movimientos. Sin policies de escritura.
-- -----------------------------------------------------------------------------
alter table warehouses enable row level security;
alter table warehouse_stock enable row level security;
alter table warehouse_moves enable row level security;
alter table warehouse_move_items enable row level security;

drop policy if exists warehouses_select on warehouses;
create policy warehouses_select on warehouses
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists warehouse_stock_select on warehouse_stock;
create policy warehouse_stock_select on warehouse_stock
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists warehouse_moves_select on warehouse_moves;
create policy warehouse_moves_select on warehouse_moves
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists warehouse_move_items_select on warehouse_move_items;
create policy warehouse_move_items_select on warehouse_move_items
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists warehouse_moves_branch_scope on warehouse_moves;
create policy warehouse_moves_branch_scope on warehouse_moves
  as restrictive for select
  using (
    (select internal_scope())
    or store_id = any ((select user_allowed_store_ids())::uuid[])
  );

drop policy if exists warehouse_move_items_branch_scope on warehouse_move_items;
create policy warehouse_move_items_branch_scope on warehouse_move_items
  as restrictive for select
  using (
    (select internal_scope())
    or exists (
      select 1 from warehouse_moves m
       where m.id = warehouse_move_items.move_id
         and m.store_id = any ((select user_allowed_store_ids())::uuid[])
    )
  );

-- Permisos por rol (ADR-071): catálogo y stock, modo 'manage'.
do $$
declare
  t text;
begin
  foreach t in array array['warehouses', 'warehouse_stock', 'warehouse_moves', 'warehouse_move_items'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'manage');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Helpers
-- -----------------------------------------------------------------------------
-- Guard común: negocio, miembro activo, plan y sucursal. Devuelve el tenant.
create or replace function warehouse_assert(p_store_id uuid, p_managers_only boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_managers_only and v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'depositos') then
    raise exception 'feature_not_in_plan: depositos' using errcode = 'check_violation';
  end if;
  if p_store_id is null or not exists (
    select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;
  if p_store_id is distinct from stock_default_store(v_tenant)
     and not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
    raise exception 'feature_not_in_plan: stock_sucursales' using errcode = 'check_violation';
  end if;
  if not user_can_access_store(p_store_id) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function warehouse_assert(uuid, boolean) from public, anon, authenticated;

-- Principal de la sucursal (lo crea si falta). Interno.
create or replace function warehouse_ensure_principal(p_tenant uuid, p_store uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  select id into v_id from warehouses
   where store_id = p_store and kind = 'principal' and deleted_at is null;
  if v_id is null then
    insert into warehouses (tenant_id, store_id, name, kind, sort)
    values (p_tenant, p_store, 'Salón de ventas', 'principal', 0)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function warehouse_ensure_principal(uuid, uuid) from public, anon, authenticated;

-- Lo que hay en tránsito entre depósitos de la sucursal (por ítem).
create or replace function warehouse_in_transit_qty(p_store uuid, p_product uuid, p_variant uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(greatest(i.qty_sent - i.qty_received, 0)), 0)
    from warehouse_move_items i
    join warehouse_moves m on m.id = i.move_id
   where m.store_id = p_store
     and m.status in ('in_transit', 'partially_received')
     and i.product_id = p_product
     and i.variant_id is not distinct from p_variant;
$$;
revoke all on function warehouse_in_transit_qty(uuid, uuid, uuid) from public, anon, authenticated;

-- Saldo del principal (salón): sucursal − otros depósitos − tránsito.
create or replace function warehouse_principal_qty(p_store uuid, p_product uuid, p_variant uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select ps.qty from product_stock ps
                    where ps.store_id = p_store and ps.product_id = p_product
                      and ps.variant_id is not distinct from p_variant), 0)
       - coalesce((select sum(ws.qty) from warehouse_stock ws
                    where ws.store_id = p_store and ws.product_id = p_product
                      and ws.variant_id is not distinct from p_variant), 0)
       - warehouse_in_transit_qty(p_store, p_product, p_variant);
$$;
revoke all on function warehouse_principal_qty(uuid, uuid, uuid) from public, anon, authenticated;

-- Valida el ítem (producto con stock, variante correcta). Devuelve nombre,
-- etiqueta de variante, SKU y unidad. Interno.
create or replace function warehouse_item_info(
  p_tenant uuid, p_product uuid, p_variant uuid,
  out product_name text, out variant_label text, out sku text, out unit text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prod record;
begin
  select pr.id, pr.name, pr.sku, pr.unit, pr.is_kit, pr.track_stock, pr.has_variants into v_prod
    from products pr
   where pr.id = p_product and pr.tenant_id = p_tenant and pr.deleted_at is null;
  if v_prod.id is null then
    raise exception 'product_not_found';
  end if;
  if coalesce(v_prod.is_kit, false) then
    raise exception 'kit_not_transferable';
  end if;
  if not coalesce(v_prod.track_stock, true) then
    raise exception 'untracked_not_transferable';
  end if;
  product_name := v_prod.name;
  sku := v_prod.sku;
  unit := coalesce(v_prod.unit, 'un');
  if coalesce(v_prod.has_variants, false) then
    if p_variant is null then
      raise exception 'variant_required';
    end if;
    select v.option1 || coalesce(' / ' || v.option2, ''), coalesce(v.sku, v_prod.sku)
      into variant_label, sku
      from product_variants v
     where v.id = p_variant and v.product_id = p_product and v.tenant_id = p_tenant
       and v.deleted_at is null;
    if variant_label is null then
      raise exception 'variant_not_found';
    end if;
  elsif p_variant is not null then
    raise exception 'variant_not_allowed';
  end if;
end;
$$;
revoke all on function warehouse_item_info(uuid, uuid, uuid) from public, anon, authenticated;

-- Suma (o resta) en un depósito. En el principal no hace nada: su saldo se
-- calcula. Bloquea la fila y no deja el depósito en negativo.
create or replace function warehouse_apply(
  p_tenant uuid, p_warehouse uuid, p_product uuid, p_variant uuid, p_delta numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wh  warehouses;
  v_cur numeric;
begin
  if coalesce(p_delta, 0) = 0 then
    return;
  end if;
  select * into v_wh from warehouses where id = p_warehouse and tenant_id = p_tenant;
  if v_wh.id is null then
    raise exception 'warehouse_not_found';
  end if;
  if v_wh.kind = 'principal' then
    return;
  end if;

  select qty into v_cur from warehouse_stock
   where warehouse_id = p_warehouse and product_id = p_product
     and variant_id is not distinct from p_variant
   for update;

  if coalesce(v_cur, 0) + p_delta < 0 then
    raise exception 'insufficient_warehouse_stock';
  end if;

  if v_cur is not null then
    update warehouse_stock
       set qty = qty + p_delta
     where warehouse_id = p_warehouse and product_id = p_product
       and variant_id is not distinct from p_variant;
  else
    insert into warehouse_stock (tenant_id, warehouse_id, store_id, product_id, variant_id, qty)
    values (p_tenant, p_warehouse, v_wh.store_id, p_product, p_variant, p_delta);
  end if;
end;
$$;
revoke all on function warehouse_apply(uuid, uuid, uuid, uuid, numeric) from public, anon, authenticated;

-- Saca de un depósito validando disponible (principal incluido).
create or replace function warehouse_take(
  p_tenant uuid, p_warehouse warehouses, p_product uuid, p_variant uuid, p_qty numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_avail numeric;
begin
  if p_warehouse.kind = 'principal' then
    -- Lock del saldo de la sucursal para que dos despachos no se pasen.
    perform 1 from product_stock
      where store_id = p_warehouse.store_id and product_id = p_product
        and variant_id is not distinct from p_variant
      for update;
    v_avail := warehouse_principal_qty(p_warehouse.store_id, p_product, p_variant);
    if v_avail < p_qty then
      raise exception 'insufficient_warehouse_stock';
    end if;
  else
    perform warehouse_apply(p_tenant, p_warehouse.id, p_product, p_variant, -p_qty);
  end if;
end;
$$;
revoke all on function warehouse_take(uuid, warehouses, uuid, uuid, numeric) from public, anon, authenticated;

create or replace function warehouse_audit(
  p_tenant uuid, p_entity text, p_id uuid, p_action text,
  p_before jsonb, p_after jsonb, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), p_entity, p_id, p_action, p_before, p_after,
          nullif(btrim(coalesce(p_reason, '')), ''));
end;
$$;
revoke all on function warehouse_audit(uuid, text, uuid, text, jsonb, jsonb, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Alta y edición de depósitos
-- -----------------------------------------------------------------------------
create or replace function warehouse_save(
  p_id       uuid,
  p_store_id uuid,
  p_name     text,
  p_kind     text default 'reserva',
  p_code     text default null,
  p_sort     int default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_wh     warehouses;
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_code   text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if p_id is not null then
    select * into v_wh from warehouses where id = p_id and deleted_at is null;
    if v_wh.id is null or v_wh.tenant_id is distinct from current_tenant_id() then
      raise exception 'warehouse_not_found';
    end if;
    v_tenant := warehouse_assert(v_wh.store_id);
  else
    v_tenant := warehouse_assert(p_store_id);
  end if;

  if v_name is null then
    raise exception 'name_required';
  end if;

  if p_id is null then
    if p_kind is null or p_kind not in ('reserva', 'devolucion', 'merma', 'otro') then
      raise exception 'invalid_kind';
    end if;
    perform warehouse_ensure_principal(v_tenant, p_store_id);
    insert into warehouses (tenant_id, store_id, name, code, kind, sort)
    values (v_tenant, p_store_id, v_name, v_code, p_kind, coalesce(p_sort, 0))
    returning * into v_wh;
    perform warehouse_audit(v_tenant, 'warehouses', v_wh.id, 'warehouse_created', null,
                            jsonb_build_object('store_id', v_wh.store_id, 'name', v_wh.name,
                                               'kind', v_wh.kind, 'code', v_wh.code));
  else
    -- El tipo del principal no cambia (se ignora p_kind); los demás no pasan
    -- a principal.
    if v_wh.kind <> 'principal' and (p_kind is null or p_kind not in ('reserva', 'devolucion', 'merma', 'otro')) then
      raise exception 'invalid_kind';
    end if;
    update warehouses
       set name = v_name,
           code = v_code,
           kind = case when v_wh.kind = 'principal' then 'principal' else p_kind end,
           sort = coalesce(p_sort, sort)
     where id = v_wh.id;
    perform warehouse_audit(v_tenant, 'warehouses', v_wh.id, 'warehouse_updated',
                            jsonb_build_object('name', v_wh.name, 'kind', v_wh.kind, 'code', v_wh.code),
                            jsonb_build_object('name', v_name, 'kind',
                                               case when v_wh.kind = 'principal' then 'principal' else p_kind end,
                                               'code', v_code));
  end if;
  return v_wh.id;
end;
$$;
revoke all on function warehouse_save(uuid, uuid, text, text, text, int) from public, anon;
grant execute on function warehouse_save(uuid, uuid, text, text, text, int) to authenticated;

-- Baja lógica: sin stock ni movimientos abiertos. El principal sólo se da de
-- baja cuando no quedan otros depósitos en la sucursal.
create or replace function warehouse_archive(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_wh     warehouses;
begin
  select * into v_wh from warehouses where id = p_id and deleted_at is null;
  if v_wh.id is null or v_wh.tenant_id is distinct from current_tenant_id() then
    raise exception 'warehouse_not_found';
  end if;
  v_tenant := warehouse_assert(v_wh.store_id);

  if v_wh.kind = 'principal' then
    if exists (select 1 from warehouses
                where store_id = v_wh.store_id and kind <> 'principal' and deleted_at is null) then
      raise exception 'warehouse_principal_in_use';
    end if;
  elsif exists (select 1 from warehouse_stock where warehouse_id = v_wh.id and qty > 0) then
    raise exception 'warehouse_has_stock';
  end if;
  if exists (select 1 from warehouse_moves
              where (origin_warehouse_id = v_wh.id or dest_warehouse_id = v_wh.id)
                and status in ('in_transit', 'partially_received')) then
    raise exception 'warehouse_has_open_moves';
  end if;

  update warehouses set deleted_at = now() where id = v_wh.id;
  perform warehouse_audit(v_tenant, 'warehouses', v_wh.id, 'warehouse_archived',
                          jsonb_build_object('name', v_wh.name, 'kind', v_wh.kind), null);
end;
$$;
revoke all on function warehouse_archive(uuid) from public, anon;
grant execute on function warehouse_archive(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Conteo / carga inicial de un depósito (no principal)
--    Deja el depósito en p_qty moviendo la diferencia desde o hacia el salón:
--    el total de la sucursal no cambia. Para sumar mercadería nueva se usa
--    el ajuste o la compra de la sucursal y después se mueve.
-- -----------------------------------------------------------------------------
create or replace function warehouse_stock_set(
  p_warehouse_id uuid,
  p_product_id   uuid,
  p_variant_id   uuid,
  p_qty          numeric,
  p_notes        text default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_wh     warehouses;
  v_info   record;
  v_cur    numeric;
  v_delta  numeric;
  v_avail  numeric;
begin
  select * into v_wh from warehouses where id = p_warehouse_id and deleted_at is null;
  if v_wh.id is null or v_wh.tenant_id is distinct from current_tenant_id() then
    raise exception 'warehouse_not_found';
  end if;
  v_tenant := warehouse_assert(v_wh.store_id);
  if v_wh.kind = 'principal' then
    raise exception 'warehouse_principal_is_computed';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'invalid_qty';
  end if;
  select * into v_info from warehouse_item_info(v_tenant, p_product_id, p_variant_id);

  perform 1 from product_stock
    where store_id = v_wh.store_id and product_id = p_product_id
      and variant_id is not distinct from p_variant_id
    for update;

  select qty into v_cur from warehouse_stock
   where warehouse_id = v_wh.id and product_id = p_product_id
     and variant_id is not distinct from p_variant_id;
  v_cur := coalesce(v_cur, 0);
  v_delta := p_qty - v_cur;
  if v_delta = 0 then
    return v_cur;
  end if;

  if v_delta > 0 then
    v_avail := warehouse_principal_qty(v_wh.store_id, p_product_id, p_variant_id);
    if v_avail < v_delta then
      raise exception 'insufficient_warehouse_stock';
    end if;
  end if;

  perform warehouse_apply(v_tenant, v_wh.id, p_product_id, p_variant_id, v_delta);

  perform warehouse_audit(v_tenant, 'warehouse_stock', p_product_id, 'warehouse_count',
                          jsonb_build_object('warehouse_id', v_wh.id, 'variant_id', p_variant_id, 'qty', v_cur),
                          jsonb_build_object('warehouse_id', v_wh.id, 'variant_id', p_variant_id,
                                             'qty', p_qty, 'delta', v_delta),
                          p_notes);
  return p_qty;
end;
$$;
revoke all on function warehouse_stock_set(uuid, uuid, uuid, numeric, text) from public, anon;
grant execute on function warehouse_stock_set(uuid, uuid, uuid, numeric, text) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Movimiento interno: despacho (queda en tránsito) o movimiento inmediato.
--    p_items: [{product_id, variant_id?, qty, notes?}]; las líneas repetidas
--    se suman. p_receive_now = true lo recibe completo en la misma
--    transacción (reponer el salón desde la reserva, sin tránsito).
-- -----------------------------------------------------------------------------
create or replace function warehouse_move_create(
  p_origin      uuid,
  p_dest        uuid,
  p_items       jsonb,
  p_reason      text default 'reposicion',
  p_notes       text default null,
  p_receive_now boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_o      warehouses;
  v_d      warehouses;
  v_m      warehouse_moves;
  v_number int;
  v_item   record;
  v_info   record;
  v_sort   int := 0;
  v_units  numeric := 0;
begin
  select * into v_o from warehouses where id = p_origin and deleted_at is null;
  select * into v_d from warehouses where id = p_dest and deleted_at is null;
  if v_o.id is null or v_d.id is null
     or v_o.tenant_id is distinct from current_tenant_id()
     or v_d.tenant_id is distinct from current_tenant_id() then
    raise exception 'warehouse_not_found';
  end if;
  if v_o.id = v_d.id then
    raise exception 'same_warehouse';
  end if;
  if v_o.store_id <> v_d.store_id then
    -- Entre sucursales se usa el traslado (H95), con su remito y su tránsito.
    raise exception 'different_store';
  end if;
  v_tenant := warehouse_assert(v_o.store_id);
  if coalesce(p_reason, 'reposicion') not in ('reposicion', 'reserva', 'devolucion', 'merma', 'reorganizacion', 'otro') then
    raise exception 'invalid_reason';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'invalid_items';
  end if;

  perform pg_advisory_xact_lock(hashtext('warehouse_move_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from warehouse_moves where tenant_id = v_tenant;

  insert into warehouse_moves (tenant_id, store_id, number, origin_warehouse_id, dest_warehouse_id,
                               status, reason, notes, created_by)
  values (v_tenant, v_o.store_id, v_number, v_o.id, v_d.id, 'in_transit',
          coalesce(p_reason, 'reposicion'), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning * into v_m;

  for v_item in
    select (e.value ->> 'product_id')::uuid as product_id,
           nullif(e.value ->> 'variant_id', '')::uuid as variant_id,
           sum((e.value ->> 'qty')::numeric) as qty,
           max(e.value ->> 'notes') as notes
      from jsonb_array_elements(p_items) with ordinality as e(value, ord)
     group by 1, 2
     order by min(e.ord)
  loop
    if v_item.product_id is null or coalesce(v_item.qty, 0) <= 0 then
      raise exception 'invalid_qty';
    end if;
    select * into v_info from warehouse_item_info(v_tenant, v_item.product_id, v_item.variant_id);

    -- Sale del origen (valida disponible) y queda en tránsito.
    perform warehouse_take(v_tenant, v_o, v_item.product_id, v_item.variant_id, v_item.qty);

    v_sort := v_sort + 1;
    insert into warehouse_move_items (tenant_id, move_id, product_id, variant_id, product_name,
                                      variant_label, sku, unit, qty_sent, notes, sort)
    values (v_tenant, v_m.id, v_item.product_id, v_item.variant_id, v_info.product_name,
            v_info.variant_label, v_info.sku, v_info.unit, v_item.qty,
            nullif(btrim(coalesce(v_item.notes, '')), ''), v_sort);
    v_units := v_units + v_item.qty;
  end loop;

  update warehouse_moves set total_units = v_units where id = v_m.id returning * into v_m;

  perform warehouse_audit(v_tenant, 'warehouse_moves', v_m.id, 'warehouse_move_dispatched', null,
                          jsonb_build_object('number', v_m.number, 'store_id', v_m.store_id,
                                             'origin_warehouse_id', v_o.id, 'dest_warehouse_id', v_d.id,
                                             'reason', v_m.reason, 'items', v_sort, 'units', v_units),
                          p_notes);

  if coalesce(p_receive_now, false) then
    update warehouse_move_items set qty_received = qty_sent where move_id = v_m.id;
    for v_item in select product_id, variant_id, qty_sent from warehouse_move_items where move_id = v_m.id loop
      perform warehouse_apply(v_tenant, v_d.id, v_item.product_id, v_item.variant_id, v_item.qty_sent);
    end loop;
    update warehouse_moves
       set status = 'received', received_by = auth.uid(), received_at = now()
     where id = v_m.id;
    perform warehouse_audit(v_tenant, 'warehouse_moves', v_m.id, 'warehouse_move_received',
                            jsonb_build_object('status', 'in_transit'),
                            jsonb_build_object('status', 'received', 'number', v_m.number, 'immediate', true));
  end if;

  return v_m.id;
end;
$$;
revoke all on function warehouse_move_create(uuid, uuid, jsonb, text, text, boolean) from public, anon;
grant execute on function warehouse_move_create(uuid, uuid, jsonb, text, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Recepción (parcial o total) y cierre con diferencias
--    p_items: [{item_id, qty, reason?, notes?}] con la cantidad que se recibe
--    AHORA (se acumula). p_close = true cierra el movimiento: lo que falta se
--    da como faltante (merma de la sucursal) y lo recibido de más como
--    sobrante (ajuste); cada diferencia exige motivo y sólo la cierra el dueño
--    o un encargado. Sin diferencias, el cajero también puede recibir.
-- -----------------------------------------------------------------------------
create or replace function warehouse_move_receive(
  p_move_id uuid,
  p_items   jsonb,
  p_close   boolean default false
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_role   text := stock_my_role();
  v_m      warehouse_moves;
  v_line   record;
  v_it     warehouse_move_items;
  v_diff   numeric;
  v_status text;
  v_diffs  int := 0;
  v_qty    numeric;
begin
  select * into v_m from warehouse_moves where id = p_move_id for update;
  if v_m.id is null or v_m.tenant_id is distinct from current_tenant_id() then
    raise exception 'move_not_found';
  end if;
  v_tenant := warehouse_assert(v_m.store_id, false);
  if v_m.status not in ('in_transit', 'partially_received') then
    raise exception 'invalid_transition: % -> received', v_m.status;
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items';
  end if;

  for v_line in
    select (e.value ->> 'item_id')::uuid as item_id,
           coalesce(nullif(e.value ->> 'qty', '')::numeric, 0) as qty,
           nullif(btrim(coalesce(e.value ->> 'reason', '')), '') as reason,
           nullif(btrim(coalesce(e.value ->> 'notes', '')), '') as notes
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
  loop
    select * into v_it from warehouse_move_items
     where id = v_line.item_id and move_id = v_m.id
     for update;
    if v_it.id is null then
      raise exception 'item_not_found';
    end if;
    if v_line.qty < 0 then
      raise exception 'invalid_qty';
    end if;
    -- Recibir de más sólo al cerrar (el sobrante entra como ajuste).
    if v_it.qty_received + v_line.qty > v_it.qty_sent and not coalesce(p_close, false) then
      raise exception 'over_receive_requires_close';
    end if;
    if v_line.qty > 0 then
      perform warehouse_apply(v_tenant, v_m.dest_warehouse_id, v_it.product_id, v_it.variant_id, v_line.qty);
    end if;
    update warehouse_move_items
       set qty_received = qty_received + v_line.qty,
           difference_reason = coalesce(v_line.reason, difference_reason),
           notes = coalesce(v_line.notes, notes)
     where id = v_it.id;
  end loop;

  if coalesce(p_close, false)
     or not exists (select 1 from warehouse_move_items
                     where move_id = v_m.id and qty_received <> qty_sent) then
    -- Cierre: cada diferencia con motivo; sólo dueño o encargado.
    for v_it in select * from warehouse_move_items where move_id = v_m.id order by sort loop
      v_diff := v_it.qty_received - v_it.qty_sent;
      if v_diff = 0 then
        continue;
      end if;
      if v_role not in ('owner', 'manager') then
        raise exception 'forbidden_differences' using errcode = '42501';
      end if;
      if v_it.difference_reason is null then
        raise exception 'difference_reason_required';
      end if;
      if v_diff > 0 and v_it.difference_reason <> 'sobrante' then
        raise exception 'difference_reason_required';
      end if;
      if v_diff < 0 and v_it.difference_reason = 'sobrante' then
        raise exception 'difference_reason_required';
      end if;
      v_diffs := v_diffs + 1;
      -- Faltante: sale de la sucursal como merma. Sobrante: entra como ajuste.
      perform transfer_move_stock(v_tenant, v_m.store_id, v_it.product_id, v_it.variant_id, v_diff,
                                  case when v_diff < 0 then 'loss' else 'adjustment' end,
                                  v_m.id,
                                  'Depósitos: movimiento #' || v_m.number || ' (' || v_it.difference_reason || ')');
    end loop;
    v_status := 'received';
    update warehouse_moves
       set status = 'received', has_differences = v_diffs > 0,
           received_by = auth.uid(), received_at = now()
     where id = v_m.id;
  else
    v_status := 'partially_received';
    update warehouse_moves set status = 'partially_received' where id = v_m.id;
  end if;

  select coalesce(sum(qty_received), 0) into v_qty from warehouse_move_items where move_id = v_m.id;
  perform warehouse_audit(v_tenant, 'warehouse_moves', v_m.id,
                          case when v_status = 'received' then 'warehouse_move_received'
                               else 'warehouse_move_partial' end,
                          jsonb_build_object('status', v_m.status),
                          jsonb_build_object('status', v_status, 'number', v_m.number,
                                             'received_units', v_qty, 'differences', v_diffs));
  return v_status;
end;
$$;
revoke all on function warehouse_move_receive(uuid, jsonb, boolean) from public, anon;
grant execute on function warehouse_move_receive(uuid, jsonb, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Cancelar: sólo en tránsito sin nada recibido; vuelve todo al origen.
-- -----------------------------------------------------------------------------
create or replace function warehouse_move_cancel(p_move_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_m      warehouse_moves;
  v_it     record;
begin
  select * into v_m from warehouse_moves where id = p_move_id for update;
  if v_m.id is null or v_m.tenant_id is distinct from current_tenant_id() then
    raise exception 'move_not_found';
  end if;
  v_tenant := warehouse_assert(v_m.store_id);
  if v_m.status <> 'in_transit'
     or exists (select 1 from warehouse_move_items where move_id = v_m.id and qty_received > 0) then
    raise exception 'invalid_transition: % -> cancelled', v_m.status;
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;

  for v_it in select product_id, variant_id, qty_sent from warehouse_move_items where move_id = v_m.id loop
    perform warehouse_apply(v_tenant, v_m.origin_warehouse_id, v_it.product_id, v_it.variant_id, v_it.qty_sent);
  end loop;

  update warehouse_moves
     set status = 'cancelled', cancel_reason = btrim(p_reason),
         cancelled_by = auth.uid(), cancelled_at = now()
   where id = v_m.id;

  perform warehouse_audit(v_tenant, 'warehouse_moves', v_m.id, 'warehouse_move_cancelled',
                          jsonb_build_object('status', v_m.status),
                          jsonb_build_object('status', 'cancelled', 'number', v_m.number), p_reason);
end;
$$;
revoke all on function warehouse_move_cancel(uuid, text) from public, anon;
grant execute on function warehouse_move_cancel(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- I) Vista de stock por depósito de una sucursal (para la página Depósitos).
--    Una fila por producto o variante con stock en la sucursal, en algún
--    depósito o en tránsito. principal_qty puede ser negativo (vendido de
--    más en el salón: hay que reponer). min_qty / max_qty de la sucursal
--    (o el mínimo del producto).
-- -----------------------------------------------------------------------------
create or replace function warehouse_stock_overview(p_store_id uuid, p_search text default null, p_limit int default 300)
returns table (
  product_id    uuid,
  variant_id    uuid,
  product_name  text,
  variant_label text,
  sku           text,
  unit          text,
  store_qty     numeric,
  principal_qty numeric,
  in_transit    numeric,
  min_qty       numeric,
  max_qty       numeric,
  by_warehouse  jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := warehouse_assert(p_store_id, false);
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
begin
  return query
  with items as (
    select ps.product_id, ps.variant_id from product_stock ps
     where ps.store_id = p_store_id and ps.qty <> 0
    union
    select ws.product_id, ws.variant_id from warehouse_stock ws
     where ws.store_id = p_store_id and ws.qty <> 0
    union
    select i.product_id, i.variant_id
      from warehouse_move_items i join warehouse_moves m on m.id = i.move_id
     where m.store_id = p_store_id and m.status in ('in_transit', 'partially_received')
  )
  select it.product_id, it.variant_id, p.name::text,
         (v.option1 || coalesce(' / ' || v.option2, ''))::text,
         coalesce(v.sku, p.sku)::text, coalesce(p.unit, 'un')::text,
         coalesce(ps.qty, 0)::numeric,
         warehouse_principal_qty(p_store_id, it.product_id, it.variant_id),
         warehouse_in_transit_qty(p_store_id, it.product_id, it.variant_id),
         coalesce(ps.min_qty, nullif(p.stock_min, 0))::numeric,
         ps.max_qty::numeric,
         coalesce((select jsonb_object_agg(ws.warehouse_id::text, ws.qty)
                     from warehouse_stock ws
                    where ws.store_id = p_store_id and ws.product_id = it.product_id
                      and ws.variant_id is not distinct from it.variant_id and ws.qty <> 0),
                  '{}'::jsonb)
    from items it
    join products p on p.id = it.product_id and p.tenant_id = v_tenant and p.deleted_at is null
    left join product_variants v on v.id = it.variant_id
    left join product_stock ps on ps.store_id = p_store_id and ps.product_id = it.product_id
                              and ps.variant_id is not distinct from it.variant_id
   where v_q is null
      or p.name ilike '%' || v_q || '%'
      or coalesce(v.sku, p.sku) ilike '%' || v_q || '%'
      or coalesce(v.barcode, p.barcode) = v_q
   order by p.name, v.option1, v.option2
   limit greatest(1, least(coalesce(p_limit, 300), 1000));
end;
$$;
revoke all on function warehouse_stock_overview(uuid, text, int) from public, anon;
grant execute on function warehouse_stock_overview(uuid, text, int) to authenticated;
