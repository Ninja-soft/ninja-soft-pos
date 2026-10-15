-- =============================================================================
-- 20261202100100_depositos_venta_entregas  (F11 · H33 + H32, ADR-136)
--
-- 1. Configuración por depósito (feature `depositos`):
--    • warehouses.sellable: su stock cuenta para la venta (salón, reserva) o
--      no (merma, devoluciones, reserva técnica). El salón siempre es vendible.
--    • warehouses.sale_priority: orden en que la venta toma de los depósitos
--      vendibles cuando el salón no alcanza (menor = primero).
--    • warehouse_store_links: sucursales que pueden vender el stock de un
--      depósito de OTRA sucursal (N a N). Su propia sucursal lo usa siempre.
--    • _sale_salon_take (la llama create_sale, ADR-088) se recrea para tomar
--      de los depósitos VENDIBLES por prioridad en lugar de "reserva u otro".
--      Con los valores que deja el backfill, el comportamiento es el mismo.
--      create_sale NO se recrea.
--
-- 2. Vender de otras sucursales y partir la entrega (feature
--    `entregas_remitos`):
--    • pos_sale_create_fulfilled(p_sale, p_plan): en UNA transacción saca el
--      stock de los orígenes elegidos (depósito vendible de esta sucursal, o
--      depósito o salón de otra sucursal habilitado para esta), lo pasa al
--      salón de la sucursal del turno, llama a create_sale con los mismos
--      argumentos de siempre y abre una entrega por parte en la expedición de
--      H32 (dispatches) con sus renglones (dispatch_items). Si create_sale
--      falla, no queda nada movido.
--    • dispatches: varias entregas por venta (part / parts_total), sucursal
--      que vende (sale_store_id) y la que arma (store_id). Lo que no se asigna
--      a ninguna parte se lleva en el momento (parte "retira ahora").
--    • warehouse_sources(p_store_id, p_items): de dónde se puede vender cada
--      producto desde esa sucursal (para el POS).
--
-- Seguridad:
--   • Lectura: tenant_id = (select current_tenant_id()) or (select
--     internal_scope()); dispatch_items además RESTRICTIVE por sucursal.
--     Nunca is_internal().
--   • Sin policies de escritura ni grants de insert/update/delete: todo por
--     RPC SECURITY DEFINER; role_write_guard 'manage' en los vínculos y
--     'operate' en los renglones de la entrega.
--   • Gating: depositos en la configuración y en los depósitos como origen;
--     entregas_remitos en la venta con plan; stock_sucursales para vender de
--     otra sucursal; pedidos_despacho para las partes que van a expedición.
--   • audit_logs: warehouse_config_saved, warehouse_principal_created,
--     sale_cross_store, sale_from_warehouse, sale_delivery_split,
--     dispatch_created (por parte).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Depósitos: vendible y prioridad
-- -----------------------------------------------------------------------------
alter table warehouses add column if not exists sellable boolean not null default true;
alter table warehouses add column if not exists sale_priority int not null default 100;

-- Backfill: merma y devoluciones no se venden (igual que _sale_salon_take de
-- ADR-088, que sólo tomaba de reserva u otro).
update warehouses set sellable = false where kind in ('merma', 'devolucion') and sellable;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'warehouses_principal_sellable') then
    alter table warehouses add constraint warehouses_principal_sellable check (kind <> 'principal' or sellable);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'warehouses_sale_priority_check') then
    alter table warehouses add constraint warehouses_sale_priority_check check (sale_priority between 0 and 999);
  end if;
end;
$$;

-- Un depósito nuevo de merma o devoluciones nace no vendible (warehouse_save
-- no conoce la columna). Después se cambia con warehouse_config_save.
create or replace function trg_warehouses_sellable_default()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.kind in ('merma', 'devolucion') then
    new.sellable := false;
  elsif new.kind = 'principal' then
    new.sellable := true;
  end if;
  return new;
end;
$$;
revoke all on function trg_warehouses_sellable_default() from public, anon, authenticated;

drop trigger if exists warehouses_sellable_default on warehouses;
create trigger warehouses_sellable_default
  before insert on warehouses
  for each row execute function trg_warehouses_sellable_default();

-- -----------------------------------------------------------------------------
-- B) Vínculos depósito → sucursales que lo pueden vender (N a N)
-- -----------------------------------------------------------------------------
create table if not exists warehouse_store_links (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  store_id     uuid not null references stores(id),
  created_by   uuid default auth.uid() references public.users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

comment on table warehouse_store_links is
  'Sucursales que pueden vender el stock de un depósito de otra sucursal (F11/H33, ADR-136). Baja lógica con deleted_at. Sólo lo escribe warehouse_config_save.';

create unique index if not exists warehouse_store_links_key
  on warehouse_store_links(warehouse_id, store_id) where deleted_at is null;
create index if not exists warehouse_store_links_store_idx on warehouse_store_links(store_id) where deleted_at is null;
create index if not exists warehouse_store_links_tenant_idx on warehouse_store_links(tenant_id);
create index if not exists warehouse_store_links_created_by_idx on warehouse_store_links(created_by)
  where created_by is not null;

alter table warehouse_store_links enable row level security;

drop policy if exists warehouse_store_links_select on warehouse_store_links;
create policy warehouse_store_links_select on warehouse_store_links
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

revoke all on warehouse_store_links from anon, authenticated;
grant select on warehouse_store_links to authenticated;

drop trigger if exists role_write_guard on warehouse_store_links;
create trigger role_write_guard before insert or update or delete on warehouse_store_links
  for each row execute function trg_role_write_guard('manage');

-- -----------------------------------------------------------------------------
-- C) Configuración de un depósito (dueño o encargado, feature depositos)
-- -----------------------------------------------------------------------------
-- p_store_ids: sucursales (distintas de la del depósito) que lo pueden vender.
create or replace function warehouse_config_save(
  p_id        uuid,
  p_sellable  boolean,
  p_priority  int,
  p_store_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid;
  v_wh      warehouses;
  v_ids     uuid[];
  v_before  uuid[];
  v_sell    boolean;
  v_prio    int := coalesce(p_priority, 100);
begin
  select * into v_wh from warehouses where id = p_id and deleted_at is null;
  if v_wh.id is null or v_wh.tenant_id is distinct from current_tenant_id() then
    raise exception 'warehouse_not_found';
  end if;
  v_tenant := warehouse_assert(v_wh.store_id);
  if v_prio < 0 or v_prio > 999 then
    raise exception 'invalid_priority';
  end if;
  v_sell := case when v_wh.kind = 'principal' then true else coalesce(p_sellable, v_wh.sellable) end;

  select coalesce(array_agg(distinct x), '{}') into v_ids
    from unnest(coalesce(p_store_ids, '{}')) as x
   where x is not null and x <> v_wh.store_id;
  if cardinality(v_ids) > 0 then
    if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
      raise exception 'feature_not_in_plan: stock_sucursales' using errcode = 'check_violation';
    end if;
    if exists (select 1 from unnest(v_ids) x
                where not exists (select 1 from stores s where s.id = x and s.tenant_id = v_tenant and s.deleted_at is null)) then
      raise exception 'store_not_found';
    end if;
  end if;

  select coalesce(array_agg(l.store_id order by l.store_id), '{}') into v_before
    from warehouse_store_links l where l.warehouse_id = v_wh.id and l.deleted_at is null;

  update warehouses set sellable = v_sell, sale_priority = v_prio where id = v_wh.id;

  update warehouse_store_links set deleted_at = now()
   where warehouse_id = v_wh.id and deleted_at is null and not (store_id = any (v_ids));
  insert into warehouse_store_links (tenant_id, warehouse_id, store_id)
  select v_tenant, v_wh.id, x from unnest(v_ids) x
   where not exists (select 1 from warehouse_store_links l
                      where l.warehouse_id = v_wh.id and l.store_id = x and l.deleted_at is null);

  perform warehouse_audit(v_tenant, 'warehouses', v_wh.id, 'warehouse_config_saved',
    jsonb_build_object('sellable', v_wh.sellable, 'sale_priority', v_wh.sale_priority, 'store_ids', to_jsonb(v_before)),
    jsonb_build_object('sellable', v_sell, 'sale_priority', v_prio,
                       'store_ids', to_jsonb(coalesce((select array_agg(x order by x) from unnest(v_ids) x), '{}'::uuid[]))));
  return jsonb_build_object('id', v_wh.id, 'sellable', v_sell, 'sale_priority', v_prio, 'store_ids', to_jsonb(v_ids));
end;
$$;
revoke all on function warehouse_config_save(uuid, boolean, int, uuid[]) from public, anon;
grant execute on function warehouse_config_save(uuid, boolean, int, uuid[]) to authenticated;

-- El salón de una sucursal como fila (para habilitarlo a otras sucursales sin
-- crear otro depósito). Sin otros depósitos la venta sigue igual: create_sale
-- sólo mira el salón si hay depósitos que no son el principal.
create or replace function warehouse_principal_setup(p_store_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := warehouse_assert(p_store_id);
  v_had    boolean;
  v_id     uuid;
begin
  v_had := exists (select 1 from warehouses where store_id = p_store_id and kind = 'principal' and deleted_at is null);
  v_id := warehouse_ensure_principal(v_tenant, p_store_id);
  if not v_had then
    perform warehouse_audit(v_tenant, 'warehouses', v_id, 'warehouse_principal_created', null,
                            jsonb_build_object('store_id', p_store_id));
  end if;
  return v_id;
end;
$$;
revoke all on function warehouse_principal_setup(uuid) from public, anon;
grant execute on function warehouse_principal_setup(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) La venta toma de los depósitos VENDIBLES por prioridad (ADR-088 → 136).
--    Misma firma y mismo resultado que la versión de 20261108200000.
-- -----------------------------------------------------------------------------
create or replace function _sale_salon_take(p_store uuid, p_product uuid, p_variant uuid, p_qty numeric, p_from_reserve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_salon numeric;
  v_short numeric;
  v_taken numeric := 0;
  v_take  numeric;
  v_from  jsonb := '[]'::jsonb;
  r       record;
begin
  if coalesce(p_qty, 0) <= 0 then return null; end if;
  v_salon := warehouse_principal_qty(p_store, p_product, p_variant);
  if v_salon >= p_qty then return null; end if;
  v_short := p_qty - greatest(v_salon, 0);

  if p_from_reserve then
    for r in
      select ws.id, ws.qty, w.id as warehouse_id, w.name
        from warehouse_stock ws
        join warehouses w on w.id = ws.warehouse_id
       where ws.store_id = p_store and ws.product_id = p_product
         and ws.variant_id is not distinct from p_variant
         and ws.qty > 0
         and w.deleted_at is null and w.kind <> 'principal' and w.sellable
       order by w.sale_priority, ws.qty desc, w.sort, w.id
       for update of ws
    loop
      exit when v_short <= 0;
      v_take := least(r.qty, v_short);
      update warehouse_stock set qty = qty - v_take where id = r.id;
      v_taken := v_taken + v_take;
      v_short := v_short - v_take;
      v_from := v_from || jsonb_build_array(jsonb_build_object(
        'warehouse_id', r.warehouse_id, 'name', r.name, 'qty', v_take));
    end loop;
  end if;

  return jsonb_build_object('product_id', p_product, 'variant_id', p_variant, 'quantity', p_qty,
                            'salon', v_salon, 'taken', v_taken, 'short', greatest(v_short, 0),
                            'from', v_from);
end;
$$;
revoke all on function _sale_salon_take(uuid, uuid, uuid, numeric, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Expedición con varias entregas por venta
-- -----------------------------------------------------------------------------
alter table dispatches add column if not exists sale_store_id uuid references stores(id);
alter table dispatches add column if not exists part int not null default 1;
alter table dispatches add column if not exists parts_total int not null default 1;
alter table dispatches add column if not exists fulfillment_id uuid;

update dispatches set sale_store_id = store_id where sale_store_id is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dispatches_part_check') then
    alter table dispatches add constraint dispatches_part_check check (part between 1 and parts_total and parts_total between 1 and 20);
  end if;
end;
$$;

comment on column dispatches.store_id is
  'Sucursal donde se arma (de donde sale la mercadería). En una venta de stock de otra sucursal (ADR-136) es la sucursal de origen; la que vendió queda en sale_store_id.';
comment on column dispatches.sale_store_id is 'Sucursal de la venta (ADR-136).';
comment on column dispatches.part is 'Número de entrega dentro de la venta (ADR-136).';
comment on column dispatches.fulfillment_id is 'Operación de pos_sale_create_fulfilled que abrió la entrega (referencia de los movimientos de stock).';

-- Una entrega abierta por venta y parte (H32 abría una sola: parte 1).
drop index if exists dispatches_sale_open_key;
create unique index if not exists dispatches_sale_part_open_key on dispatches(sale_id, part)
  where status <> 'cancelado' and deleted_at is null;
create index if not exists dispatches_sale_store_idx on dispatches(sale_store_id, status);

-- _dispatch_open (H32) no conoce sale_store_id: se completa solo.
create or replace function trg_dispatches_sale_store()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.sale_store_id is null then
    new.sale_store_id := coalesce((select s.store_id from sales s where s.id = new.sale_id), new.store_id);
  end if;
  return new;
end;
$$;
revoke all on function trg_dispatches_sale_store() from public, anon, authenticated;

drop trigger if exists dispatches_sale_store on dispatches;
create trigger dispatches_sale_store
  before insert on dispatches
  for each row execute function trg_dispatches_sale_store();

-- La sucursal que vendió también ve la entrega.
drop policy if exists dispatches_branch_scope on dispatches;
create policy dispatches_branch_scope on dispatches
  as restrictive for select
  using (
    (select internal_scope())
    or store_id = any ((select user_allowed_store_ids())::uuid[])
    or fulfillment_store_id = any ((select user_allowed_store_ids())::uuid[])
    or sale_store_id = any ((select user_allowed_store_ids())::uuid[])
  );

grant select (sale_store_id, part, parts_total, fulfillment_id) on dispatches to authenticated;

create table if not exists dispatch_items (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  dispatch_id          uuid not null references dispatches(id) on delete cascade,
  sale_id              uuid not null references sales(id),
  -- Copias de la entrega para el alcance por sucursal (RESTRICTIVE).
  store_id             uuid not null references stores(id),
  fulfillment_store_id uuid not null references stores(id),
  sale_store_id        uuid not null references stores(id),
  product_id           uuid not null references products(id),
  variant_id           uuid references product_variants(id),
  product_name         text not null,
  variant_label        text,
  sku                  text,
  unit                 text not null default 'un',
  qty                  numeric(12,3) not null check (qty > 0),
  source_store_id      uuid not null references stores(id),
  source_warehouse_id  uuid references warehouses(id),
  sort                 int not null default 0,
  created_at           timestamptz not null default now()
);

comment on table dispatch_items is
  'Renglones de cada entrega de una venta partida (ADR-136): qué va en cada parte y de qué depósito o sucursal sale. Sólo lo escribe pos_sale_create_fulfilled.';

create index if not exists dispatch_items_dispatch_idx on dispatch_items(dispatch_id);
create index if not exists dispatch_items_sale_idx on dispatch_items(sale_id);
create index if not exists dispatch_items_tenant_idx on dispatch_items(tenant_id);
create index if not exists dispatch_items_product_idx on dispatch_items(product_id, variant_id);
create index if not exists dispatch_items_variant_idx on dispatch_items(variant_id) where variant_id is not null;
create index if not exists dispatch_items_store_idx on dispatch_items(store_id);
create index if not exists dispatch_items_fulfillment_idx on dispatch_items(fulfillment_store_id);
create index if not exists dispatch_items_sale_store_idx on dispatch_items(sale_store_id);
create index if not exists dispatch_items_source_store_idx on dispatch_items(source_store_id);
create index if not exists dispatch_items_source_wh_idx on dispatch_items(source_warehouse_id)
  where source_warehouse_id is not null;

alter table dispatch_items enable row level security;

drop policy if exists dispatch_items_select on dispatch_items;
create policy dispatch_items_select on dispatch_items
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists dispatch_items_branch_scope on dispatch_items;
create policy dispatch_items_branch_scope on dispatch_items
  as restrictive for select
  using (
    (select internal_scope())
    or store_id = any ((select user_allowed_store_ids())::uuid[])
    or fulfillment_store_id = any ((select user_allowed_store_ids())::uuid[])
    or sale_store_id = any ((select user_allowed_store_ids())::uuid[])
  );

revoke all on dispatch_items from anon, authenticated;
grant select on dispatch_items to authenticated;

drop trigger if exists role_write_guard on dispatch_items;
create trigger role_write_guard before insert or update or delete on dispatch_items
  for each row execute function trg_role_write_guard('operate');

-- -----------------------------------------------------------------------------
-- F) De dónde se puede vender cada producto desde una sucursal (POS)
-- -----------------------------------------------------------------------------
-- p_items: [{product_id, variant_id}] (hasta 100). Devuelve, por producto:
--   • el salón de la sucursal (siempre, aunque esté en 0), con lo reservado
--     descontado;
--   • los depósitos vendibles de la sucursal (con `depositos`);
--   • los depósitos (o salones) de OTRAS sucursales habilitados para esta
--     (con `depositos` y `stock_sucursales`), con stock.
-- Espejo del armado de orígenes en lib/stock/fulfillment.ts.
create or replace function warehouse_sources(p_store_id uuid, p_items jsonb)
returns table (
  product_id     uuid,
  variant_id     uuid,
  store_id       uuid,
  store_name     text,
  warehouse_id   uuid,
  warehouse_name text,
  kind           text,
  own_store      boolean,
  sale_priority  int,
  available      numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
  v_dep    boolean;
  v_multi  boolean;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_store_id is null or not exists (
    select 1 from stores s where s.id = p_store_id and s.tenant_id = v_tenant and s.deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;
  if not coalesce(user_can_access_store(p_store_id), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 100 then
    raise exception 'invalid_items';
  end if;
  v_dep := tenant_has_feature_for(v_tenant, 'depositos');
  v_multi := v_dep and tenant_has_feature_for(v_tenant, 'stock_sucursales');

  return query
  with it as (
    select distinct x.product_id, x.variant_id
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(product_id uuid, variant_id uuid)
      join products p on p.id = x.product_id and p.tenant_id = v_tenant and p.deleted_at is null
     where x.product_id is not null
  ),
  src as (
    -- Salón de esta sucursal.
    select it.product_id, it.variant_id, p_store_id as store_id,
           (select w.id from warehouses w where w.store_id = p_store_id and w.kind = 'principal' and w.deleted_at is null) as warehouse_id,
           'principal'::text as kind, true as own_store, 0 as sale_priority,
           (case when v_dep then warehouse_principal_qty(p_store_id, it.product_id, it.variant_id)
                 else coalesce((select ps.qty from product_stock ps where ps.store_id = p_store_id
                                  and ps.product_id = it.product_id and ps.variant_id is not distinct from it.variant_id), 0)
            end) - stock_reserved_qty(p_store_id, it.product_id, it.variant_id, null) as available
      from it
    union all
    -- Depósitos vendibles de esta sucursal.
    select it.product_id, it.variant_id, p_store_id, w.id, w.kind, true, w.sale_priority, ws.qty
      from it
      join warehouse_stock ws on ws.store_id = p_store_id and ws.product_id = it.product_id
                             and ws.variant_id is not distinct from it.variant_id and ws.qty > 0
      join warehouses w on w.id = ws.warehouse_id and w.deleted_at is null and w.kind <> 'principal' and w.sellable
     where v_dep
    union all
    -- Depósitos y salones de otras sucursales habilitados para esta.
    select it.product_id, it.variant_id, w.store_id, w.id, w.kind, false, w.sale_priority,
           case when w.kind = 'principal'
                then warehouse_principal_qty(w.store_id, it.product_id, it.variant_id)
                     - stock_reserved_qty(w.store_id, it.product_id, it.variant_id, null)
                else coalesce((select ws.qty from warehouse_stock ws where ws.warehouse_id = w.id
                                 and ws.product_id = it.product_id and ws.variant_id is not distinct from it.variant_id), 0)
           end
      from it
      join warehouse_store_links l on l.store_id = p_store_id and l.tenant_id = v_tenant and l.deleted_at is null
      join warehouses w on w.id = l.warehouse_id and w.deleted_at is null and w.sellable and w.store_id <> p_store_id
      join stores s on s.id = w.store_id and s.deleted_at is null
     where v_multi
  )
  select src.product_id, src.variant_id, src.store_id, st.name::text,
         src.warehouse_id, coalesce(w.name, 'Salón de ventas')::text, src.kind, src.own_store, src.sale_priority,
         round(src.available, 3)
    from src
    join stores st on st.id = src.store_id
    left join warehouses w on w.id = src.warehouse_id
   where src.own_store and src.kind = 'principal' or src.available > 0
   order by src.product_id, src.own_store desc, src.sale_priority, src.available desc, st.name;
end;
$$;
revoke all on function warehouse_sources(uuid, jsonb) from public, anon;
grant execute on function warehouse_sources(uuid, jsonb) to authenticated;


-- -----------------------------------------------------------------------------
-- G) Venta con plan de entregas
-- -----------------------------------------------------------------------------
-- p_sale: los argumentos de create_sale tal cual los manda el POS
--   ({p_items, p_payments, p_discount_total, p_customer_id, p_notes, p_extras,
--     p_promo_discount, p_promo_id, p_promo_name, p_coupon_id, p_cash_shift_id,
--     p_service}).
-- p_plan: {deliveries: [{mode: 'ahora'|'retiro'|'envio',
--   fulfillment_store_id, pickup_name, ship_address, notes,
--   items: [{product_id, variant_id, qty, source_store_id, source_warehouse_id}]}]}
--
-- Reglas (espejo en lib/stock/fulfillment.ts, checkFulfillmentPlan):
--   • Hasta 10 entregas. Cada renglón con cantidad > 0 de un producto que
--     está en la venta; la suma por producto y variante no supera lo vendido.
--     Lo que no se asigna (y no es servicio) va a la parte "retira ahora"
--     desde la sucursal de la venta: la suma de las entregas es lo vendido.
--   • Todos los renglones de una entrega salen de la misma sucursal (una
--     entrega = un lugar de armado).
--   • ahora: sólo desde la sucursal de la venta; queda entregada al cobrar.
--   • retiro: en la sucursal de origen o en otra (esa la habilita
--     order_config.delivery_types.retiro.cross_branch, como en H32); con
--     nombre de quien retira (o el cliente).
--   • envio: sale de la sucursal de origen; domicilio obligatorio.
--   • retiro y envío pasan por expedición: pedidos_despacho y el tipo
--     habilitado en order_config.
--   • Origen en otra sucursal: depósito (o salón) vendible y habilitado para
--     la sucursal de la venta; kits y productos sin control de stock sólo
--     desde el salón de la sucursal de la venta.
--   • No se combina con mesas, delivery ni pedidos de salón (sus entregas ya
--     tienen su circuito).
create or replace function pos_sale_create_fulfilled(p_sale jsonb, p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_role     text := stock_my_role();
  v_shift    uuid;
  v_store    uuid;
  v_cfg      jsonb;
  v_dels     jsonb := coalesce(p_plan -> 'deliveries', '[]'::jsonb);
  v_d        jsonb;
  v_i        jsonb;
  v_n        int;
  v_idx      int;
  v_mode     text;
  v_origin   uuid;
  v_ful      uuid;
  v_src      uuid;
  v_vid      uuid;
  v_vlabel   text;
  v_vsku     text;
  v_wh       warehouses;
  v_whid     uuid;
  v_prod     record;
  v_qty      numeric;
  v_avail    numeric;
  v_ref      uuid := gen_random_uuid();
  v_sold     jsonb;
  v_rows     jsonb := '[]'::jsonb;
  v_drows    jsonb;
  v_res      jsonb;
  v_sale     uuid;
  v_sale_no  bigint;
  v_cname    text;
  v_pickup   text;
  v_addr     text;
  v_disp     uuid;
  v_number   int;
  v_code     text;
  v_out      jsonb := '[]'::jsonb;
  v_cross    jsonb := '[]'::jsonb;
  v_local    jsonb := '[]'::jsonb;
  v_parts    int;
  v_part     int := 0;
  v_now_idx  int;
  r          record;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'entregas_remitos') then
    raise exception 'feature_not_in_plan: entregas_remitos' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_sale) is distinct from 'object' or jsonb_typeof(v_dels) is distinct from 'array' then
    raise exception 'invalid_plan';
  end if;
  v_n := jsonb_array_length(v_dels);
  if v_n < 1 or v_n > 10 then
    raise exception 'invalid_plan';
  end if;
  if nullif(p_sale ->> 'p_table_order_id', '') is not null or nullif(p_sale ->> 'p_delivery_order_id', '') is not null
     or exists (select 1 from jsonb_array_elements(coalesce(p_sale -> 'p_extras', '[]'::jsonb)) e
                 where lower(coalesce(e ->> 'kind', '')) = 'reservation') then
    raise exception 'fulfillment_not_for_orders';
  end if;

  select r2.o_shift_id, r2.o_store_id into v_shift, v_store
    from resolve_sale_shift(nullif(p_sale ->> 'p_cash_shift_id', '')::uuid, true) r2;
  if v_store is null then
    raise exception 'no_open_shift';
  end if;
  v_cfg := pos_order_config(v_tenant);

  -- Lo vendido por producto y variante (sin servicios ni ítems libres).
  select coalesce(jsonb_agg(jsonb_build_object('product_id', s.product_id, 'variant_id', s.variant_id, 'qty', s.qty)), '[]'::jsonb)
    into v_sold
    from (
      select x.product_id, x.variant_id, sum(x.quantity) as qty
        from jsonb_to_recordset(coalesce(p_sale -> 'p_items', '[]'::jsonb)) as x(product_id uuid, variant_id uuid, quantity numeric)
        join products p on p.id = x.product_id and p.tenant_id = v_tenant and p.deleted_at is null
       where x.product_id is not null and not coalesce(p.is_service, false) and coalesce(x.quantity, 0) > 0
       group by x.product_id, x.variant_id
    ) s;

  -- Validación del plan.
  for v_idx in 0 .. v_n - 1 loop
    v_d := v_dels -> v_idx;
    v_mode := v_d ->> 'mode';
    if v_mode is null or v_mode not in ('ahora', 'retiro', 'envio') then
      raise exception 'invalid_delivery_mode';
    end if;
    if jsonb_typeof(v_d -> 'items') is distinct from 'array' or jsonb_array_length(v_d -> 'items') = 0 then
      raise exception 'delivery_empty';
    end if;
    v_origin := null;
    v_drows := '[]'::jsonb;
    for v_i in select * from jsonb_array_elements(v_d -> 'items') loop
      v_qty := nullif(v_i ->> 'qty', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'invalid_qty';
      end if;
      v_vid := nullif(v_i ->> 'variant_id', '')::uuid;
      select p.id, p.name, p.sku, coalesce(p.unit, 'un') as unit, coalesce(p.is_kit, false) as is_kit,
             coalesce(p.track_stock, true) as track, coalesce(p.is_service, false) as is_service,
             coalesce(p.has_variants, false) as has_variants
        into v_prod
        from products p
       where p.id = nullif(v_i ->> 'product_id', '')::uuid and p.tenant_id = v_tenant and p.deleted_at is null;
      if v_prod.id is null or v_prod.is_service or not exists (
        select 1 from jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid)
         where s.product_id = v_prod.id and s.variant_id is not distinct from v_vid
      ) then
        raise exception 'delivery_item_not_in_sale';
      end if;
      if v_prod.has_variants and v_vid is null then
        raise exception 'variant_required';
      end if;
      v_src := coalesce(nullif(v_i ->> 'source_store_id', '')::uuid, v_store);
      if v_origin is null then
        v_origin := v_src;
      elsif v_origin <> v_src then
        raise exception 'delivery_mixed_origin';
      end if;

      v_whid := null;
      if nullif(v_i ->> 'source_warehouse_id', '') is not null then
        select * into v_wh from warehouses w
         where w.id = (v_i ->> 'source_warehouse_id')::uuid and w.tenant_id = v_tenant and w.deleted_at is null;
        if v_wh.id is null or v_wh.store_id <> v_src then
          raise exception 'source_not_available';
        end if;
        if not v_wh.sellable then
          raise exception 'source_not_sellable';
        end if;
        -- El salón propio no se mueve: lo descuenta create_sale.
        if not (v_wh.kind = 'principal' and v_src = v_store) then
          v_whid := v_wh.id;
        end if;
      end if;

      if v_src <> v_store then
        if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
          raise exception 'feature_not_in_plan: stock_sucursales' using errcode = 'check_violation';
        end if;
        if not tenant_has_feature_for(v_tenant, 'depositos') then
          raise exception 'feature_not_in_plan: depositos' using errcode = 'check_violation';
        end if;
        if v_prod.is_kit or not v_prod.track then
          raise exception 'kit_cross_store';
        end if;
        if v_whid is null then
          select w.id into v_whid from warehouses w
           where w.store_id = v_src and w.kind = 'principal' and w.deleted_at is null;
        end if;
        if v_whid is null or not exists (
          select 1 from warehouse_store_links l
           where l.warehouse_id = v_whid and l.store_id = v_store and l.deleted_at is null
        ) or not exists (select 1 from warehouses w where w.id = v_whid and w.sellable) then
          raise exception 'source_not_available';
        end if;
      elsif v_whid is not null then
        if not tenant_has_feature_for(v_tenant, 'depositos') then
          raise exception 'feature_not_in_plan: depositos' using errcode = 'check_violation';
        end if;
        if v_prod.is_kit or not v_prod.track then
          raise exception 'kit_cross_store';
        end if;
      end if;

      v_vlabel := null;
      v_vsku := null;
      if v_vid is not null then
        select v.option1 || coalesce(' / ' || v.option2, ''), v.sku into v_vlabel, v_vsku
          from product_variants v where v.id = v_vid and v.product_id = v_prod.id;
      end if;
      v_drows := v_drows || jsonb_build_array(jsonb_build_object(
        'd', v_idx, 'mode', v_mode, 'origin', v_src, 'product_id', v_prod.id, 'variant_id', v_vid,
        'qty', v_qty, 'src_store', v_src, 'src_wh', v_whid, 'name', v_prod.name,
        'variant_label', v_vlabel, 'sku', coalesce(v_vsku, v_prod.sku), 'unit', v_prod.unit));
    end loop;

    -- Modalidad y lugar de entrega.
    if v_mode = 'ahora' then
      if v_origin <> v_store then
        raise exception 'ahora_requires_local';
      end if;
      v_ful := v_store;
      v_now_idx := v_idx;
    else
      if not tenant_has_feature_for(v_tenant, 'pedidos_despacho') then
        raise exception 'feature_not_in_plan: pedidos_despacho' using errcode = 'check_violation';
      end if;
      if not coalesce((v_cfg -> 'delivery_types' -> v_mode ->> 'enabled')::boolean, false) then
        raise exception 'delivery_type_disabled: %', v_mode;
      end if;
      if v_mode = 'envio' then
        v_ful := v_origin;
        if char_length(btrim(coalesce(v_d ->> 'ship_address', ''))) < 5 then
          raise exception 'ship_address_required';
        end if;
      else
        v_ful := coalesce(nullif(v_d ->> 'fulfillment_store_id', '')::uuid, v_origin);
        if not exists (select 1 from stores s where s.id = v_ful and s.tenant_id = v_tenant and s.deleted_at is null) then
          raise exception 'store_not_found';
        end if;
        if v_ful <> v_origin and not coalesce((v_cfg -> 'delivery_types' -> 'retiro' ->> 'cross_branch')::boolean, false) then
          raise exception 'cross_branch_not_allowed: retiro';
        end if;
      end if;
    end if;
    v_rows := v_rows || (select jsonb_agg(x || jsonb_build_object('ful', v_ful)) from jsonb_array_elements(v_drows) x);
  end loop;

  -- La suma por producto no supera lo vendido.
  if exists (
    select 1
      from (select fp.product_id, fp.variant_id, sum(fp.qty) as q
              from jsonb_to_recordset(v_rows) as fp(product_id uuid, variant_id uuid, qty numeric)
             group by 1, 2) p
      left join jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid, qty numeric)
        on s.product_id = p.product_id and s.variant_id is not distinct from p.variant_id
     where p.q > coalesce(s.qty, 0)
  ) then
    raise exception 'delivery_qty_mismatch';
  end if;

  -- Lo no asignado: parte "retira ahora" desde la sucursal de la venta.
  select coalesce(jsonb_agg(jsonb_build_object(
           'mode', 'ahora', 'origin', v_store, 'ful', v_store, 'product_id', s.product_id, 'variant_id', s.variant_id,
           'qty', s.qty - coalesce(a.q, 0), 'src_store', v_store, 'src_wh', null, 'name', pr.name,
           'variant_label', v.option1 || coalesce(' / ' || v.option2, ''), 'sku', coalesce(v.sku, pr.sku),
           'unit', coalesce(pr.unit, 'un'))), '[]'::jsonb)
    into v_drows
    from jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid, qty numeric)
    join products pr on pr.id = s.product_id
    left join product_variants v on v.id = s.variant_id
    left join (select fp.product_id, fp.variant_id, sum(fp.qty) as q
                 from jsonb_to_recordset(v_rows) as fp(product_id uuid, variant_id uuid, qty numeric)
                group by 1, 2) a on a.product_id = s.product_id and a.variant_id is not distinct from s.variant_id
   where s.qty > coalesce(a.q, 0);
  if jsonb_array_length(v_drows) > 0 then
    if v_now_idx is null then
      v_now_idx := v_n;
    end if;
    v_rows := v_rows || (select jsonb_agg(x || jsonb_build_object('d', v_now_idx)) from jsonb_array_elements(v_drows) x);
  end if;

  -- Mover el stock de los orígenes al salón de la sucursal de la venta. Orden
  -- fijo (sucursal, depósito, producto) para no cruzar locks con otra venta.
  for r in
    select fp.src_store, fp.src_wh, fp.product_id, fp.variant_id, sum(fp.qty) as qty, min(fp.name) as name
      from jsonb_to_recordset(v_rows) as fp(src_store uuid, src_wh uuid, product_id uuid, variant_id uuid, qty numeric, name text)
     where fp.src_store <> v_store or fp.src_wh is not null
     group by fp.src_store, fp.src_wh, fp.product_id, fp.variant_id
     order by fp.src_store, fp.src_wh nulls first, fp.product_id, fp.variant_id nulls first
  loop
    perform pg_advisory_xact_lock(hashtext('stock_reservation:' || r.src_store::text));
    if exists (select 1 from warehouses w where w.id = r.src_wh and w.kind <> 'principal') then
      select ws.qty into v_avail from warehouse_stock ws
       where ws.warehouse_id = r.src_wh and ws.product_id = r.product_id
         and ws.variant_id is not distinct from r.variant_id
       for update;
      if coalesce(v_avail, 0) < r.qty then
        raise exception 'insufficient_source_stock: %', r.name;
      end if;
      update warehouse_stock set qty = qty - r.qty
       where warehouse_id = r.src_wh and product_id = r.product_id and variant_id is not distinct from r.variant_id;
    else
      -- Salón de otra sucursal: sin lo reservado.
      perform 1 from product_stock ps
        where ps.store_id = r.src_store and ps.product_id = r.product_id and ps.variant_id is not distinct from r.variant_id
        for update;
      v_avail := warehouse_principal_qty(r.src_store, r.product_id, r.variant_id)
                 - stock_reserved_qty(r.src_store, r.product_id, r.variant_id, null);
      if v_avail < r.qty then
        raise exception 'insufficient_source_stock: %', r.name;
      end if;
    end if;
    if r.src_store <> v_store then
      perform transfer_move_stock(v_tenant, r.src_store, r.product_id, r.variant_id, -r.qty, 'transfer_out', v_ref,
                                  'Venta en otra sucursal (ADR-136)');
      perform transfer_move_stock(v_tenant, v_store, r.product_id, r.variant_id, r.qty, 'transfer_in', v_ref,
                                  'Venta de stock de otra sucursal (ADR-136)');
      v_cross := v_cross || jsonb_build_array(jsonb_build_object(
        'product_id', r.product_id, 'variant_id', r.variant_id, 'qty', r.qty,
        'store_id', r.src_store, 'warehouse_id', r.src_wh));
    else
      v_local := v_local || jsonb_build_array(jsonb_build_object(
        'product_id', r.product_id, 'variant_id', r.variant_id, 'qty', r.qty, 'warehouse_id', r.src_wh));
    end if;
  end loop;

  -- La venta, igual que siempre.
  v_res := create_sale(
    p_items           => coalesce(p_sale -> 'p_items', '[]'::jsonb),
    p_payments        => coalesce(p_sale -> 'p_payments', '[]'::jsonb),
    p_discount_total  => coalesce(nullif(p_sale ->> 'p_discount_total', '')::numeric, 0),
    p_customer_id     => nullif(p_sale ->> 'p_customer_id', '')::uuid,
    p_notes           => p_sale ->> 'p_notes',
    p_extras          => coalesce(p_sale -> 'p_extras', '[]'::jsonb),
    p_promo_discount  => coalesce(nullif(p_sale ->> 'p_promo_discount', '')::numeric, 0),
    p_promo_id        => nullif(p_sale ->> 'p_promo_id', '')::uuid,
    p_promo_name      => p_sale ->> 'p_promo_name',
    p_coupon_id       => nullif(p_sale ->> 'p_coupon_id', '')::uuid,
    p_cash_shift_id   => v_shift,
    p_service         => case when jsonb_typeof(p_sale -> 'p_service') = 'object' then p_sale -> 'p_service' end
  );
  v_sale := (v_res ->> 'sale_id')::uuid;
  select s.number, c.name into v_sale_no, v_cname
    from sales s left join customers c on c.id = s.customer_id
   where s.id = v_sale;

  -- Una entrega por parte; la de "ahora" primero.
  select count(distinct fp.d) into v_parts from jsonb_to_recordset(v_rows) as fp(d int);
  for r in
    select fp.d, min(fp.mode) as mode, min(fp.origin::text)::uuid as origin, min(fp.ful::text)::uuid as ful
      from jsonb_to_recordset(v_rows) as fp(d int, mode text, origin uuid, ful uuid)
     group by fp.d
     order by (min(fp.mode) = 'ahora') desc, fp.d
  loop
    v_part := v_part + 1;
    v_d := case when r.d < jsonb_array_length(v_dels) then v_dels -> r.d else '{}'::jsonb end;
    v_pickup := left(nullif(btrim(coalesce(v_d ->> 'pickup_name', '')), ''), 120);
    v_addr := left(nullif(btrim(coalesce(v_d ->> 'ship_address', '')), ''), 300);
    if r.mode = 'retiro' then
      v_pickup := coalesce(v_pickup, v_cname);
      if v_pickup is null then
        raise exception 'pickup_name_required';
      end if;
    end if;
    perform pg_advisory_xact_lock(hashtext('dispatch_number:' || v_tenant::text));
    select coalesce(max(number), 0) + 1 into v_number from dispatches where tenant_id = v_tenant;
    insert into dispatches (
      tenant_id, number, sale_id, store_id, fulfillment_store_id, sale_store_id, delivery_type, status,
      customer_name, pickup_name, ship_address, notes, part, parts_total, fulfillment_id, created_by,
      delivered_by, delivered_at, delivered_to
    ) values (
      v_tenant, v_number, v_sale, r.origin, r.ful, v_store,
      case r.mode when 'ahora' then 'inmediato' else r.mode end,
      case when r.mode = 'ahora' then 'entregado' else 'pendiente' end,
      left(coalesce(v_cname, v_pickup), 120), v_pickup, case when r.mode = 'envio' then v_addr end,
      left(nullif(btrim(coalesce(v_d ->> 'notes', '')), ''), 500), v_part, v_parts, v_ref, auth.uid(),
      case when r.mode = 'ahora' then auth.uid() end,
      case when r.mode = 'ahora' then now() end,
      case when r.mode = 'ahora' then left(coalesce(v_cname, 'Cliente en el mostrador'), 120) end
    )
    returning id into v_disp;

    insert into dispatch_items (
      tenant_id, dispatch_id, sale_id, store_id, fulfillment_store_id, sale_store_id, product_id, variant_id,
      product_name, variant_label, sku, unit, qty, source_store_id, source_warehouse_id, sort
    )
    select v_tenant, v_disp, v_sale, r.origin, r.ful, v_store, fp.product_id, fp.variant_id,
           fp.name, fp.variant_label, fp.sku, fp.unit, sum(fp.qty), fp.src_store, fp.src_wh,
           (row_number() over (order by fp.name, fp.variant_label))::int
      from jsonb_to_recordset(v_rows) as fp(d int, product_id uuid, variant_id uuid, name text, variant_label text,
                                            sku text, unit text, qty numeric, src_store uuid, src_wh uuid)
     where fp.d = r.d
     group by fp.product_id, fp.variant_id, fp.name, fp.variant_label, fp.sku, fp.unit, fp.src_store, fp.src_wh;

    v_code := null;
    if r.mode = 'retiro' and coalesce((v_cfg -> 'delivery_types' -> 'retiro' ->> 'pickup_code')::boolean, false) then
      v_code := otp_random_digits(6);
      update dispatches set pickup_code_hash = stock_reservation_code_hash(v_disp, v_code) where id = v_disp;
    end if;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'dispatches', v_disp, 'dispatch_created',
            jsonb_build_object('number', v_number, 'sale_id', v_sale, 'delivery_type', r.mode,
                               'part', v_part, 'parts_total', v_parts, 'origin_store_id', r.origin,
                               'fulfillment_store_id', r.ful, 'fulfillment_id', v_ref),
            r.origin);

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_disp, 'number', v_number, 'part', v_part, 'mode', r.mode,
      'origin_store_id', r.origin, 'fulfillment_store_id', r.ful, 'pickup_code', v_code));
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_delivery_split',
          jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'parts', v_parts,
                             'deliveries', (select jsonb_agg(x - 'pickup_code') from jsonb_array_elements(v_out) x)),
          v_store);
  if jsonb_array_length(v_cross) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_cross_store',
            jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'lines', v_cross), v_store);
  end if;
  if jsonb_array_length(v_local) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_from_warehouse',
            jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'lines', v_local), v_store);
  end if;

  return v_res || jsonb_build_object('deliveries', v_out, 'fulfillment_id', v_ref);
end;
$$;
revoke all on function pos_sale_create_fulfilled(jsonb, jsonb) from public, anon;
grant execute on function pos_sale_create_fulfilled(jsonb, jsonb) to authenticated;
