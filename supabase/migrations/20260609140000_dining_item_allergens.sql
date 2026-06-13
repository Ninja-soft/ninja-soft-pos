-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · Gastronomía — H47: Notas por ítem + ALERGIAS/intolerancias destacadas ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Cada línea de pedido (mesa y delivery/takeaway) ya tenía `notes` (nota libre
-- del ítem, que el mozo carga y la cocina ve en el KDS y la comanda). Faltaba el
-- caso de SEGURIDAD ALIMENTARIA: una ALERGIA/intolerancia (sin TACC, maní,
-- lactosa…) no debe ir mezclada con el resto de las notas — la cocina tiene que
-- verla DESTACADA. Agregamos un campo estructurado `allergens` (texto libre,
-- corto) que el front resalta en rojo en el KDS y en la comanda impresa.
--
-- ADITIVO y retro-compatible: columna nullable + parámetro OPCIONAL al final de
-- las RPC de alta; las RPC de KDS/comanda devuelven la columna nueva (el front la
-- lee por nombre). Nada del flujo actual cambia si no se carga alergia.

-- ── 1) Columnas nuevas ────────────────────────────────────────────────────────
alter table table_order_items
  add column if not exists allergens text;
alter table delivery_order_items
  add column if not exists allergens text;

comment on column table_order_items.allergens is
  'Alergia/intolerancia del ítem (texto libre corto). Se resalta en rojo en KDS y comanda. NULL = sin alergia.';
comment on column delivery_order_items.allergens is
  'Alergia/intolerancia del ítem (texto libre corto). Se resalta en rojo en KDS y comanda. NULL = sin alergia.';

-- ── 2) add_table_order_item: + p_allergens (OPCIONAL, al final) ───────────────
-- Recreada preservando TODO de la versión H47 (lock FOR UPDATE del pedido,
-- snapshot de station, course/hold). Único cambio: persiste `allergens`. Como
-- agrega un parámetro cambiando la aridad, "create or replace" deja una
-- SOBRECARGA; eliminamos la firma de 9 args para que exista una sola definición
-- autoritativa (mismo criterio que el drop de la firma vieja en dining_courses).
create or replace function add_table_order_item(
  p_order_id uuid,
  p_product_id uuid,
  p_name text,
  p_qty numeric,
  p_unit_price numeric,
  p_modifiers jsonb default '[]'::jsonb,
  p_notes text default null,
  p_course smallint default 1,
  p_hold boolean default false,
  p_allergens text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  table_orders%rowtype;
  v_item_id uuid;
  v_station text;
  v_course smallint := greatest(coalesce(p_course, 1), 1);
begin
  select * into v_order from table_orders
   where id = p_order_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status <> 'abierta' then
    raise exception 'order_not_open';
  end if;
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'invalid_qty';
  end if;

  if p_product_id is not null then
    select nullif(btrim(station), '') into v_station
      from products
     where id = p_product_id and tenant_id = v_tenant;
  end if;

  insert into table_order_items
    (tenant_id, order_id, product_id, name, qty, unit_price, modifiers, notes,
     station, kds_status, course, fired_at, allergens)
  values (
    v_tenant, p_order_id, p_product_id,
    coalesce(nullif(btrim(p_name), ''), 'Ítem'),
    p_qty, greatest(coalesce(p_unit_price, 0), 0),
    coalesce(p_modifiers, '[]'::jsonb), nullif(btrim(p_notes), ''),
    v_station, 'pendiente', v_course,
    case when coalesce(p_hold, false) then null else now() end,
    nullif(btrim(p_allergens), '')
  )
  returning id into v_item_id;

  update table_orders set updated_at = now() where id = p_order_id;

  return v_item_id;
end;
$$;

-- Elimina la firma de 9 args (sin p_allergens) para que no haya ambigüedad de
-- overload: la nueva de 10 args con p_allergens DEFAULT cubre todas las llamadas.
drop function if exists add_table_order_item(uuid, uuid, text, numeric, numeric, jsonb, text, smallint, boolean);

-- ── 3) add_delivery_order_item: + p_allergens (espeja mesa) ───────────────────
create or replace function add_delivery_order_item(
  p_order_id   uuid,
  p_product_id uuid,
  p_name       text,
  p_qty        numeric,
  p_unit_price numeric,
  p_modifiers  jsonb default '[]'::jsonb,
  p_notes      text default null,
  p_course     smallint default 1,
  p_hold       boolean default false,
  p_allergens  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _dining_assert_member();
  v_order   delivery_orders%rowtype;
  v_item_id uuid;
  v_station text;
  v_course  smallint := greatest(coalesce(p_course, 1), 1);
begin
  select * into v_order from delivery_orders
   where id = p_order_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status = 'cancelado' or v_order.sale_id is not null then
    raise exception 'order_not_open';
  end if;
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'invalid_qty';
  end if;

  if p_product_id is not null then
    select nullif(btrim(station), '') into v_station
      from products
     where id = p_product_id and tenant_id = v_tenant;
  end if;

  insert into delivery_order_items
    (tenant_id, order_id, product_id, name, qty, unit_price, modifiers, notes,
     station, kds_status, course, fired_at, allergens)
  values (
    v_tenant, p_order_id, p_product_id,
    coalesce(nullif(btrim(p_name), ''), 'Ítem'),
    p_qty, greatest(coalesce(p_unit_price, 0), 0),
    coalesce(p_modifiers, '[]'::jsonb), nullif(btrim(p_notes), ''),
    v_station, 'pendiente', v_course,
    case when coalesce(p_hold, false) then null else now() end,
    nullif(btrim(p_allergens), '')
  )
  returning id into v_item_id;

  update delivery_orders set updated_at = now() where id = p_order_id;

  return v_item_id;
end;
$$;
revoke all on function add_delivery_order_item(uuid, uuid, text, numeric, numeric, jsonb, text, smallint, boolean, text) from public, anon;
grant execute on function add_delivery_order_item(uuid, uuid, text, numeric, numeric, jsonb, text, smallint, boolean, text) to authenticated;
drop function if exists add_delivery_order_item(uuid, uuid, text, numeric, numeric, jsonb, text, smallint, boolean);

-- ── 4) kds_tickets: UNE mesa + delivery + expone `allergens` ──────────────────
-- Recreada preservando TODO de la versión unificada H49 (tenant guard, joins,
-- filtro de estación, excluir 'entregado', fired_at not null, orden FIFO, source/
-- source_label). Único cambio: devuelve `allergens` (después de `notes`) para que
-- la cocina vea la alergia DESTACADA en la tarjeta.
drop function if exists kds_tickets(text);
create or replace function kds_tickets(p_station text default null)
returns table(
  item_id uuid, order_id uuid, table_id uuid, table_label text, area_name text,
  product_id uuid, name text, qty numeric, modifiers jsonb, notes text,
  allergens text, station text, kds_status text, course smallint,
  created_at timestamptz, ready_at timestamptz,
  source text, source_label text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_filter text := nullif(btrim(coalesce(p_station, '')), '');
begin
  return query
    -- Fuente MESA.
    select
      i.id, i.order_id, t.id, t.label, a.name,
      i.product_id, i.name, i.qty, i.modifiers, i.notes,
      i.allergens, i.station, i.kds_status, i.course, i.created_at, i.kds_ready_at,
      'mesa'::text, ('Mesa ' || t.label)::text
    from table_order_items i
    join table_orders o   on o.id = i.order_id and o.tenant_id = v_tenant
    join dining_tables t  on t.id = o.table_id  and t.tenant_id = v_tenant
    left join dining_areas a on a.id = t.area_id and a.tenant_id = v_tenant
    where i.tenant_id = v_tenant
      and o.status = 'abierta'
      and i.kds_status <> 'entregado'
      and i.fired_at is not null
      and (v_filter is null or i.station = v_filter)

    union all

    -- Fuente DELIVERY / TAKEAWAY.
    select
      di.id, di.order_id, null::uuid, _delivery_order_label(d.id, d.order_type), null::text,
      di.product_id, di.name, di.qty, di.modifiers, di.notes,
      di.allergens, di.station, di.kds_status, di.course, di.created_at, di.kds_ready_at,
      'delivery'::text, _delivery_order_label(d.id, d.order_type)
    from delivery_order_items di
    join delivery_orders d on d.id = di.order_id and d.tenant_id = v_tenant
    where di.tenant_id = v_tenant
      and d.deleted_at is null
      and d.status not in ('entregado','cancelado')
      and d.sale_id is null
      and di.kds_status <> 'entregado'
      and di.fired_at is not null
      and (v_filter is null or di.station = v_filter)

    order by created_at asc;
end;
$$;
revoke all on function kds_tickets(text) from public, anon;
grant execute on function kds_tickets(text) to authenticated;

-- ── 5) comanda_items (mesa): + `allergens` ────────────────────────────────────
drop function if exists comanda_items(uuid, boolean);
create or replace function comanda_items(p_order_id uuid, p_only_new boolean default false)
returns table(
  item_id uuid, product_id uuid, name text, qty numeric, modifiers jsonb,
  notes text, allergens text, station text, course smallint, printed_at timestamptz,
  table_label text, area_name text, waiter_name text, opened_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
begin
  return query
    select
      i.id, i.product_id, i.name, i.qty, i.modifiers, i.notes,
      i.allergens, i.station, i.course, i.printed_at,
      t.label, a.name,
      nullif(btrim(coalesce(u.full_name, u.email, '')), ''),
      o.opened_at
    from table_order_items i
    join table_orders o   on o.id = i.order_id and o.tenant_id = v_tenant
    join dining_tables t  on t.id = o.table_id  and t.tenant_id = v_tenant
    left join dining_areas a on a.id = t.area_id and a.tenant_id = v_tenant
    left join public.users u on u.id = t.waiter_user_id
    where i.order_id = p_order_id
      and i.tenant_id = v_tenant
      and i.fired_at is not null
      and (p_only_new is not true or i.printed_at is null)
    order by i.created_at asc;
end;
$$;
revoke all on function comanda_items(uuid, boolean) from public, anon;
grant execute on function comanda_items(uuid, boolean) to authenticated;

-- ── 6) delivery_comanda_items: + `allergens` ──────────────────────────────────
drop function if exists delivery_comanda_items(uuid, boolean);
create or replace function delivery_comanda_items(p_order_id uuid, p_only_new boolean default false)
returns table(
  item_id uuid, product_id uuid, name text, qty numeric, modifiers jsonb,
  notes text, allergens text, station text, course smallint, printed_at timestamptz,
  source_label text, channel text, order_type text, courier_name text,
  customer_name text, address text, opened_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
begin
  return query
    select
      di.id, di.product_id, di.name, di.qty, di.modifiers, di.notes,
      di.allergens, di.station, di.course, di.printed_at,
      _delivery_order_label(d.id, d.order_type), d.channel, d.order_type,
      d.courier_name, d.customer_name, d.address, d.created_at
    from delivery_order_items di
    join delivery_orders d on d.id = di.order_id and d.tenant_id = v_tenant
    where di.order_id = p_order_id
      and di.tenant_id = v_tenant
      and di.fired_at is not null
      and (p_only_new is not true or di.printed_at is null)
    order by di.created_at asc;
end;
$$;
revoke all on function delivery_comanda_items(uuid, boolean) from public, anon;
grant execute on function delivery_comanda_items(uuid, boolean) to authenticated;
