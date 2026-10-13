-- =============================================================================
-- 20261109600000_gastro_r2_cuenta_por_comensal  (F13 · H44: ticket separado por
--                                                comensal, ADR-097)
-- -----------------------------------------------------------------------------
-- Hasta hoy "dividir la cuenta" era UN create_sale con N pagos (un solo ticket).
-- Acá cada comensal (o cada parte igual) paga su propia VENTA con sus ítems,
-- sin tocar create_sale:
--
--   * table_order_items.diner: a qué comensal pertenece la línea (1..50, null =
--     compartido / sin asignar). Lo asigna el mozo (set_table_items_diner).
--   * split_table_order(pedido, líneas, etiqueta): crea un pedido HIJO
--     (table_orders.parent_order_id) en la misma mesa y le pasa las líneas
--     elegidas, enteras o con una cantidad parcial (partes iguales). El hijo se
--     cobra con el flujo normal (/pos?table=<hijo>): create_sale valida el precio
--     guardado de SUS líneas, emite la venta y marca el hijo 'cobrada'. Como la
--     mesa apunta al pedido padre (current_order_id), create_sale no la libera.
--   * unsplit_table_order(hijo): devuelve las líneas al padre (deshacer).
--   * Trigger: cuando se cobra el último hijo y el padre quedó sin líneas, el
--     padre se cierra ('cobrada', sin venta propia) y la mesa se libera.
--
-- Invariantes que garantiza el servidor (trigger table_orders_split_guard):
--   * Un padre con hijos abiertos no se cierra ni se cambia de mesa (create_sale,
--     cancel_table_order y move_table_order fallan con order_has_open_splits).
--   * Un hijo no se cancela salvo por unsplit (merged_into = padre).
-- El índice "un pedido abierto por mesa" pasa a contar sólo pedidos padre.
--
-- Línea parcial: la línea original baja su cantidad y se inserta una copia con
-- el resto del estado (precio, estación, cocina, tiempo, impresión). Las dos
-- barreras de la tabla (bajar qty de un ítem enviado, precio validado al
-- insertar) se saltean sólo con el permiso de sesión que pone esta RPC
-- (ninja.dining_split), igual que la anulación usa ninja.dining_item_void.
--
-- Reportes: gastro_turnover_report cuenta VISITAS (padre e hijos son una) para
-- que una mesa dividida no sume rotaciones. gastro_tables_report sigue contando
-- tickets (su promedio es por ticket).
-- Gating: flag operativo (dining_enabled), no feature de plan (CLAUDE.md §6).
-- =============================================================================

-- ── 1) Columnas ──────────────────────────────────────────────────────────────
alter table table_orders
  add column if not exists parent_order_id uuid references table_orders(id) on delete set null,
  add column if not exists split_label text
    check (split_label is null or char_length(split_label) between 1 and 60);

comment on column table_orders.parent_order_id is
  'Cuenta separada: pedido padre de la mesa del que salió este pedido (ticket por comensal o parte igual).';
comment on column table_orders.split_label is
  'Etiqueta de la cuenta separada ("Comensal 2", "Parte 1 de 3").';

create index if not exists table_orders_parent_idx
  on table_orders (parent_order_id) where parent_order_id is not null;

alter table table_order_items
  add column if not exists diner smallint check (diner is null or diner between 1 and 50);

comment on column table_order_items.diner is
  'Comensal al que pertenece la línea (1..50). null = compartido o sin asignar.';

-- Un pedido PADRE abierto por mesa (los hijos comparten la mesa mientras se cobran).
drop index if exists table_orders_one_open_per_table;
create unique index if not exists table_orders_one_open_per_table
  on table_orders (table_id) where status = 'abierta' and parent_order_id is null;

-- ── 2) open_dining_table (copia de 20260608580000, la única) ─────────────────
-- Único cambio: el pedido abierto que devuelve por idempotencia es el padre.
create or replace function open_dining_table(
  p_table_id uuid,
  p_waiter_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_table  dining_tables%rowtype;
  v_order_id uuid;
begin
  select * into v_table from dining_tables
   where id = p_table_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'table_not_found';
  end if;
  if v_table.status = 'bloqueada' then
    raise exception 'table_blocked';
  end if;

  -- ¿Ya hay un pedido abierto? (idempotencia + unique index lo respalda)
  select id into v_order_id from table_orders
   where table_id = p_table_id and tenant_id = v_tenant and status = 'abierta'
     and parent_order_id is null -- ADR-097
   limit 1;

  if v_order_id is null then
    insert into table_orders (tenant_id, table_id, status, opened_by)
    values (v_tenant, p_table_id, 'abierta', auth.uid())
    returning id into v_order_id;
  end if;

  update dining_tables
     set status = 'ocupada',
         current_order_id = v_order_id,
         waiter_user_id = coalesce(p_waiter_user_id, waiter_user_id, auth.uid())
   where id = p_table_id and tenant_id = v_tenant;

  return jsonb_build_object('order_id', v_order_id, 'table_id', p_table_id, 'status', 'ocupada');
end;
$$;
revoke all on function open_dining_table(uuid, uuid) from public, anon;
grant execute on function open_dining_table(uuid, uuid) to authenticated;

-- ── 3) Precio validado al insertar (copia de 20261019100000, la única) ───────
-- Único cambio: la copia de una línea que hace split_table_order (permiso de
-- sesión ninja.dining_split) conserva el precio guardado al cargarla.
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

-- ── 4) Trigger de qty de ítem enviado (copia de 20261105200100) ──────────────
-- Único cambio: también acepta el permiso de sesión de la separación de cuenta
-- (la cantidad no se pierde: pasa a la línea copia del pedido hijo).
create or replace function _table_order_item_guard_qty()
returns trigger
language plpgsql
as $$
begin
  if new.qty < old.qty
     and _dining_item_sent(old.printed_at, old.kds_status)
     and coalesce(current_setting('ninja.dining_item_void', true), '') <> 'on'
     and coalesce(current_setting('ninja.dining_split', true), '') <> 'on' -- ADR-097
  then
    raise exception 'item_sent_use_void';
  end if;
  return new;
end;
$$;

-- ── 5) Guard de pedidos padre/hijo ───────────────────────────────────────────
create or replace function _table_orders_split_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Un hijo sólo se cancela deshaciendo la separación (vuelve al padre).
  if new.parent_order_id is not null
     and old.status = 'abierta' and new.status = 'cancelada'
     and new.merged_into is distinct from new.parent_order_id then
    raise exception 'split_use_unsplit';
  end if;
  -- Un padre con cuentas separadas abiertas no se cierra ni cambia de mesa.
  if new.parent_order_id is null
     and ((old.status = 'abierta' and new.status <> 'abierta')
          or new.table_id is distinct from old.table_id)
     and exists (select 1 from table_orders c
                  where c.parent_order_id = old.id and c.tenant_id = old.tenant_id
                    and c.status = 'abierta') then
    raise exception 'order_has_open_splits';
  end if;
  return new;
end;
$$;
revoke all on function _table_orders_split_guard() from public, anon, authenticated;

drop trigger if exists table_orders_split_guard on table_orders;
create trigger table_orders_split_guard
  before update of status, table_id on table_orders
  for each row execute function _table_orders_split_guard();

-- ── 6) Cierre del padre cuando se cobró la última cuenta separada ────────────
create or replace function _table_orders_split_close_parent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent table_orders%rowtype;
begin
  if new.parent_order_id is null
     or old.status <> 'abierta' or new.status <> 'cobrada' then
    return null;
  end if;

  select * into v_parent from table_orders
   where id = new.parent_order_id and tenant_id = new.tenant_id
   for update;
  if not found or v_parent.status <> 'abierta' then
    return null;
  end if;
  if exists (select 1 from table_order_items i
              where i.order_id = v_parent.id and i.tenant_id = v_parent.tenant_id)
     or exists (select 1 from table_orders c
                 where c.parent_order_id = v_parent.id and c.tenant_id = v_parent.tenant_id
                   and c.status = 'abierta') then
    return null;
  end if;

  update table_orders set status = 'cobrada', updated_at = now()
   where id = v_parent.id and tenant_id = v_parent.tenant_id;

  update dining_tables
     set status = 'libre', current_order_id = null, waiter_user_id = null
   where id = v_parent.table_id and tenant_id = v_parent.tenant_id
     and current_order_id = v_parent.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_parent.tenant_id, auth.uid(), 'table_orders', v_parent.id, 'table_split_closed',
          jsonb_build_object('last_split_id', new.id, 'table_id', v_parent.table_id,
                             'splits', (select count(*) from table_orders c
                                         where c.parent_order_id = v_parent.id
                                           and c.tenant_id = v_parent.tenant_id
                                           and c.status = 'cobrada')));
  return null;
end;
$$;
revoke all on function _table_orders_split_close_parent() from public, anon, authenticated;

drop trigger if exists table_orders_split_close_parent on table_orders;
create trigger table_orders_split_close_parent
  after update of status on table_orders
  for each row execute function _table_orders_split_close_parent();

-- ── 7) set_table_items_diner ─────────────────────────────────────────────────
create or replace function set_table_items_diner(p_item_ids uuid[], p_diner smallint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_orders int;
  v_order  uuid;
  v_n      int;
begin
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    raise exception 'no_items';
  end if;
  if p_diner is not null and (p_diner < 1 or p_diner > 50) then
    raise exception 'invalid_diner';
  end if;

  select count(distinct order_id), min(order_id::text)::uuid into v_orders, v_order
    from table_order_items
   where id = any (p_item_ids) and tenant_id = v_tenant;
  if v_orders = 0 then
    raise exception 'item_not_found';
  end if;
  if v_orders > 1 then
    raise exception 'items_from_several_orders';
  end if;

  perform 1 from table_orders
    where id = v_order and tenant_id = v_tenant and status = 'abierta'
    for update;
  if not found then
    raise exception 'order_not_open';
  end if;

  update table_order_items set diner = p_diner
   where id = any (p_item_ids) and tenant_id = v_tenant and order_id = v_order;
  get diagnostics v_n = row_count;

  return jsonb_build_object('order_id', v_order, 'diner', p_diner, 'updated', v_n);
end;
$$;
revoke all on function set_table_items_diner(uuid[], smallint) from public, anon;
grant execute on function set_table_items_diner(uuid[], smallint) to authenticated;

-- ── 8) split_table_order ─────────────────────────────────────────────────────
-- p_lines: [{"item_id": uuid, "qty": numeric|null}] (null = la línea entera).
create or replace function split_table_order(
  p_order_id uuid,
  p_lines    jsonb,
  p_label    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  table_orders%rowtype;
  v_child  uuid;
  v_label  text := left(coalesce(nullif(btrim(p_label), ''), 'Cuenta separada'), 60);
  v_line   record;
  v_item   table_order_items%rowtype;
  v_qty    numeric;
  v_moved  int := 0;
  v_parts  int := 0;
  v_total  numeric := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_items';
  end if;

  select * into v_order from table_orders
   where id = p_order_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status <> 'abierta' then
    raise exception 'order_not_open';
  end if;
  if v_order.parent_order_id is not null then
    raise exception 'order_is_split';
  end if;

  -- Sin ítems repetidos y todos del pedido.
  if (select count(*) from jsonb_array_elements(p_lines))
     <> (select count(distinct e ->> 'item_id') from jsonb_array_elements(p_lines) e) then
    raise exception 'duplicated_item';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
     where not exists (select 1 from table_order_items i
                        where i.id::text = e ->> 'item_id'
                          and i.order_id = p_order_id and i.tenant_id = v_tenant)
  ) then
    raise exception 'item_not_found';
  end if;

  -- Cuenta hija: misma mesa, mismo mozo y misma hora de apertura (rotación real).
  insert into table_orders (tenant_id, table_id, status, opened_by, opened_at,
                            waiter_user_id, bill_requested_at, parent_order_id, split_label)
  values (v_tenant, v_order.table_id, 'abierta', auth.uid(), v_order.opened_at,
          v_order.waiter_user_id, v_order.bill_requested_at, p_order_id, v_label)
  returning id into v_child;

  perform set_config('ninja.dining_split', 'on', true);
  for v_line in
    select (e ->> 'item_id')::uuid as item_id, nullif(e ->> 'qty', '')::numeric as qty
      from jsonb_array_elements(p_lines) e
  loop
    select * into v_item from table_order_items
     where id = v_line.item_id and tenant_id = v_tenant and order_id = p_order_id
     for update;
    v_qty := round(coalesce(v_line.qty, v_item.qty), 3);
    if v_qty <= 0 or v_qty > v_item.qty then
      perform set_config('ninja.dining_split', '', true);
      raise exception 'invalid_qty';
    end if;

    if v_qty >= v_item.qty then
      update table_order_items set order_id = v_child
       where id = v_item.id and tenant_id = v_tenant;
      v_moved := v_moved + 1;
    else
      update table_order_items set qty = qty - v_qty
       where id = v_item.id and tenant_id = v_tenant;
      insert into table_order_items
        (tenant_id, order_id, product_id, name, qty, unit_price, modifiers, notes,
         allergens, station, kds_status, kds_ready_at, printed_at, course, fired_at,
         diner, created_at)
      values (v_tenant, v_child, v_item.product_id, v_item.name, v_qty, v_item.unit_price,
              v_item.modifiers, v_item.notes, v_item.allergens, v_item.station,
              v_item.kds_status, v_item.kds_ready_at, v_item.printed_at, v_item.course,
              v_item.fired_at, v_item.diner, v_item.created_at);
      v_parts := v_parts + 1;
    end if;
    v_total := v_total + round(v_item.unit_price * v_qty, 2);
  end loop;
  perform set_config('ninja.dining_split', '', true);

  update table_orders set updated_at = now()
   where id = p_order_id and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'table_orders', p_order_id, 'table_split',
          jsonb_build_object('order_id', p_order_id, 'table_id', v_order.table_id),
          jsonb_build_object('split_id', v_child, 'label', v_label, 'lines', p_lines,
                             'moved', v_moved, 'partial', v_parts, 'total', v_total));

  return jsonb_build_object('order_id', v_child, 'parent_order_id', p_order_id,
                            'label', v_label, 'total', v_total,
                            'moved', v_moved, 'partial', v_parts);
end;
$$;
revoke all on function split_table_order(uuid, jsonb, text) from public, anon;
grant execute on function split_table_order(uuid, jsonb, text) to authenticated;

-- ── 9) unsplit_table_order ───────────────────────────────────────────────────
create or replace function unsplit_table_order(p_split_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_child  table_orders%rowtype;
  v_n      int;
begin
  select * into v_child from table_orders
   where id = p_split_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_child.parent_order_id is null then
    raise exception 'order_not_split';
  end if;
  if v_child.status <> 'abierta' then
    raise exception 'order_not_open';
  end if;
  perform 1 from table_orders
    where id = v_child.parent_order_id and tenant_id = v_tenant and status = 'abierta'
    for update;
  if not found then
    raise exception 'target_order_not_open';
  end if;

  update table_order_items set order_id = v_child.parent_order_id
   where order_id = p_split_id and tenant_id = v_tenant;
  get diagnostics v_n = row_count;

  update table_orders
     set status = 'cancelada', merged_into = v_child.parent_order_id, updated_at = now()
   where id = p_split_id and tenant_id = v_tenant;

  update table_orders set updated_at = now()
   where id = v_child.parent_order_id and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'table_orders', v_child.parent_order_id, 'table_split_undone',
          jsonb_build_object('split_id', p_split_id, 'label', v_child.split_label),
          jsonb_build_object('items_back', v_n));

  return jsonb_build_object('order_id', v_child.parent_order_id, 'items_back', v_n);
end;
$$;
revoke all on function unsplit_table_order(uuid) from public, anon;
grant execute on function unsplit_table_order(uuid) to authenticated;

-- ── 10) gastro_turnover_report (copia de 20261105200400, la única) ───────────
-- Único cambio: cuenta VISITAS (padre e hijos de una cuenta separada son una
-- sola rotación). Montos y propinas siguen sumando todas las ventas.
create or replace function gastro_turnover_report(
  p_from     timestamptz,
  p_to       timestamptz,
  p_store_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with f as (
    select report_store_filter(p_store_id) as ids
  ),
  o as (
    select o.id,
           coalesce(o.parent_order_id, o.id) as visit_id, -- ADR-097
           coalesce(o.waiter_user_id, o.opened_by) as waiter_id,
           dt.label as table_label,
           da.name  as area_name,
           s.total  as sale_total,
           coalesce(s.tip_amount, 0) as tip,
           greatest(extract(epoch from (coalesce(o.closed_at, s.created_at) - o.opened_at)), 0) / 60.0
             as seated_min,
           (select greatest(extract(epoch from (min(i.created_at) - o.opened_at)), 0) / 60.0
              from table_order_items i
             where i.order_id = o.id and i.tenant_id = current_tenant_id()) as first_item_min,
           case when o.bill_requested_at is not null
                then greatest(extract(epoch from (coalesce(o.closed_at, s.created_at)
                                                  - o.bill_requested_at)), 0) / 60.0
           end as bill_to_close_min
    from table_orders o
    cross join f
    join sales s
      on s.id = o.sale_id
     and s.tenant_id = current_tenant_id()
     and s.status = 'completed'
    left join dining_tables dt on dt.id = o.table_id and dt.tenant_id = current_tenant_id()
    left join dining_areas  da on da.id = dt.area_id and da.tenant_id = current_tenant_id()
    where o.tenant_id = current_tenant_id()
      and o.status = 'cobrada'
      and o.sale_id is not null
      and s.created_at >= p_from
      and s.created_at <  p_to
      and (f.ids is null or s.store_id = any (f.ids))
  )
  select jsonb_build_object(
    'orders', (select count(distinct visit_id) from o),
    'avg_seated_min', coalesce((select round(avg(seated_min)::numeric, 1) from o), 0),
    'avg_first_item_min', coalesce((select round(avg(first_item_min)::numeric, 1) from o), 0),
    'avg_bill_to_close_min', coalesce((select round(avg(bill_to_close_min)::numeric, 1) from o), 0),
    'tips_total', coalesce((select sum(tip) from o), 0),
    'by_table', coalesce((
      select jsonb_agg(x) from (
        select coalesce(table_label, 'Sin mesa') as table_label,
               coalesce(area_name, 'Sin salón')  as area,
               count(distinct visit_id) as orders,
               round(avg(seated_min)::numeric, 1)        as avg_seated_min,
               round(avg(first_item_min)::numeric, 1)    as avg_first_item_min,
               round(avg(bill_to_close_min)::numeric, 1) as avg_bill_to_close_min
        from o group by 1, 2 order by 3 desc, 1
      ) x), '[]'::jsonb),
    'by_waiter', coalesce((
      select jsonb_agg(x) from (
        select coalesce(u.full_name, u.email, 'Sin mozo') as waiter,
               count(distinct o.visit_id) as orders,
               sum(o.sale_total) as total,
               sum(o.tip)        as tips,
               round(avg(o.seated_min)::numeric, 1) as avg_seated_min
        from o left join users u on u.id = o.waiter_id
        group by 1 order by 3 desc
      ) x), '[]'::jsonb)
  );
$$;
revoke all on function gastro_turnover_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function gastro_turnover_report(timestamptz, timestamptz, uuid) to authenticated;
