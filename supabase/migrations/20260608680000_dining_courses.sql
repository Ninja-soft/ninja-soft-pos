-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · Gastronomía — Cursos / despacho por tiempos (H47 "fire course")     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Cada ítem de la cuenta de una mesa pertenece a un TIEMPO (course): 1=entrada,
-- 2=principal, 3=postre… (libre, hasta ~9). El mozo decide CUÁNDO sale cada
-- tiempo a la cocina: un ítem puede cargarse "en espera" (hold) y dispararse más
-- tarde ("fire course"). Sólo lo DISPARADO (fired_at not null) llega al KDS y a
-- la comanda; lo que está en espera no aparece en cocina hasta dispararse.
--
-- Compatibilidad: todo lo ya cargado cuenta como YA disparado → backfill
-- fired_at = created_at. El flujo rápido (mostrador / cargar y mandar al toque)
-- NO cambia: add_table_order_item sin p_hold dispara igual que hoy.

-- ── Columnas nuevas en table_order_items ──────────────────────────────────────
alter table table_order_items
  add column if not exists course smallint not null default 1,
  add column if not exists fired_at timestamptz null;

-- Backfill: lo existente ya está "en cocina" → fired_at = created_at. Sin esto,
-- los pedidos abiertos previos a esta migración desaparecerían del KDS/comanda.
update table_order_items
   set fired_at = created_at
 where fired_at is null;

comment on column table_order_items.course is
  'Tiempo (course) al que pertenece el ítem: 1=entrada, 2=principal, 3=postre… (libre).';
comment on column table_order_items.fired_at is
  'Cuándo se disparó el ítem a cocina (fire course). NULL = en espera (no va al KDS/comanda).';

-- ── add_table_order_item: + p_course / p_hold (OPCIONALES) ────────────────────
-- Misma firma anterior + dos parámetros OPCIONALES al final. Preserva el lock
-- FOR UPDATE del pedido (BUG 2 — TOCTOU) y el resto de la lógica intacta.
--   p_course: tiempo del ítem (default 1).
--   p_hold = false (default) → fired_at = now(): se manda a cocina al toque
--            (comportamiento ACTUAL, no rompe el flujo rápido).
--   p_hold = true            → fired_at = null: queda "en espera", NO va a cocina
--            todavía (se dispara luego con fire_table_order_course).
create or replace function add_table_order_item(
  p_order_id uuid,
  p_product_id uuid,
  p_name text,
  p_qty numeric,
  p_unit_price numeric,
  p_modifiers jsonb default '[]'::jsonb,
  p_notes text default null,
  p_course smallint default 1,
  p_hold boolean default false
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
     station, kds_status, course, fired_at)
  values (
    v_tenant, p_order_id, p_product_id,
    coalesce(nullif(btrim(p_name), ''), 'Ítem'),
    p_qty, greatest(coalesce(p_unit_price, 0), 0),
    coalesce(p_modifiers, '[]'::jsonb), nullif(btrim(p_notes), ''),
    v_station, 'pendiente', v_course,
    case when coalesce(p_hold, false) then null else now() end
  )
  returning id into v_item_id;

  update table_orders set updated_at = now() where id = p_order_id;

  return v_item_id;
end;
$$;

-- add_table_order_item ganó 2 parámetros (p_course, p_hold) cambiando la aridad,
-- así que "create or replace" creó una SOBRECARGA en vez de reemplazar: quedó la
-- firma vieja de 7 args (que NO setea fired_at → el ítem quedaría "en espera"
-- para siempre, fuera del KDS/comanda) junto a la nueva de 9 args. La de 9 args
-- con p_course/p_hold DEFAULT ya cubre todas las llamadas de 7 args (incluidas
-- las de PostgREST con esos 7 nombres). Eliminamos la vieja para que exista una
-- sola definición autoritativa y no haya ambigüedad de resolución de overload
-- (mismo criterio que el drop de create_sale de 6 args en el cobro atómico).
drop function if exists add_table_order_item(uuid, uuid, text, numeric, numeric, jsonb, text);

-- ── set_table_order_item_course: cambiar el tiempo de un ítem ──────────────────
-- Tenant-scoped (guard de miembro). Permitido mientras el pedido esté ABIERTO
-- (simple): re-etiquetar el tiempo no afecta lo ya cobrado. Toma el pedido FOR
-- UPDATE (consistente con el resto: no tocar un pedido que se está cerrando).
create or replace function set_table_order_item_course(
  p_item_id uuid,
  p_course smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_item   table_order_items%rowtype;
  v_status text;
  v_course smallint := greatest(coalesce(p_course, 1), 1);
begin
  select i.* into v_item from table_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;
  select status into v_status from table_orders
   where id = v_item.order_id and tenant_id = v_tenant
   for update;
  if v_status <> 'abierta' then
    raise exception 'order_not_open';
  end if;

  update table_order_items set course = v_course
   where id = p_item_id and tenant_id = v_tenant;
  update table_orders set updated_at = now() where id = v_item.order_id;

  return jsonb_build_object('item_id', p_item_id, 'course', v_course);
end;
$$;

-- ── fire_table_order_course: disparar un tiempo a cocina ───────────────────────
-- Sella fired_at = now() en los ítems del pedido que estén EN ESPERA (fired_at
-- null). Con p_course no null, sólo ese tiempo; con null, dispara TODO lo que
-- quede en espera ("disparar todo"). Devuelve cuántos disparó. Tenant-scoped
-- (guard de miembro) + FOR UPDATE del pedido + audit log (mismo patrón que el
-- cierre atómico de mesa en create_sale).
create or replace function fire_table_order_course(
  p_order_id uuid,
  p_course smallint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  table_orders%rowtype;
  v_fired  int;
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

  with upd as (
    update table_order_items
       set fired_at = now()
     where order_id = p_order_id
       and tenant_id = v_tenant
       and fired_at is null
       and (p_course is null or course = p_course)
    returning 1
  )
  select count(*) into v_fired from upd;

  if v_fired > 0 then
    update table_orders set updated_at = now() where id = p_order_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                            action, after_data)
    values (v_tenant, auth.uid(), 'table_orders', p_order_id, 'fire_course',
            jsonb_build_object('course', p_course, 'fired', v_fired,
                               'table_id', v_order.table_id));
  end if;

  return jsonb_build_object('order_id', p_order_id, 'course', p_course,
                            'fired', v_fired);
end;
$$;

-- ── kds_tickets: sólo lo DISPARADO + expone el curso ──────────────────────────
-- Recreada preservando todo lo demás (tenant guard, joins, filtro de estación,
-- excluir 'entregado', orden FIFO). Cambios: (1) sólo ítems con fired_at not null
-- (lo en espera NO va a la pantalla de cocina); (2) devuelve `course` para que la
-- cocina vea la secuencia (Tiempo N).
drop function if exists kds_tickets(text);
create or replace function kds_tickets(p_station text default null)
returns table(
  item_id uuid, order_id uuid, table_id uuid, table_label text, area_name text,
  product_id uuid, name text, qty numeric, modifiers jsonb, notes text,
  station text, kds_status text, course smallint,
  created_at timestamptz, ready_at timestamptz
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
    select
      i.id, i.order_id, t.id, t.label, a.name,
      i.product_id, i.name, i.qty, i.modifiers, i.notes,
      i.station, i.kds_status, i.course, i.created_at, i.kds_ready_at
    from table_order_items i
    join table_orders o   on o.id = i.order_id and o.tenant_id = v_tenant
    join dining_tables t  on t.id = o.table_id  and t.tenant_id = v_tenant
    left join dining_areas a on a.id = t.area_id and a.tenant_id = v_tenant
    where i.tenant_id = v_tenant
      and o.status = 'abierta'
      and i.kds_status <> 'entregado'
      and i.fired_at is not null
      and (v_filter is null or i.station = v_filter)
    order by i.created_at asc;
end;
$$;

-- ── comanda_items: sólo lo DISPARADO + expone el curso ────────────────────────
-- Recreada preservando todo (tenant guard, joins, p_only_new, orden). Cambios:
-- (1) sólo ítems disparados (fired_at not null); (2) devuelve `course` para
-- agrupar/etiquetar por tiempo en la comanda impresa.
drop function if exists comanda_items(uuid, boolean);
create or replace function comanda_items(p_order_id uuid, p_only_new boolean default false)
returns table(
  item_id uuid, product_id uuid, name text, qty numeric, modifiers jsonb,
  notes text, station text, course smallint, printed_at timestamptz,
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
      i.station, i.course, i.printed_at,
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
