-- =============================================================================
-- 20261105200000_mesas_mover_unir  (F13 · H44 follow-up: mover, unir y
--                                    transferir mesas + cambio de mozo)
-- -----------------------------------------------------------------------------
-- Operación diaria de salón que faltaba:
--
--  1) move_table_order(order, mesa destino)
--       * destino LIBRE   → el pedido completo se muda a la mesa destino (mismo
--                           pedido, mismo id; KDS y comanda siguen igual) y la
--                           mesa de origen queda libre.
--       * destino OCUPADA → UNIR: las líneas del origen pasan al pedido abierto
--                           del destino; el pedido de origen queda 'cancelada'
--                           con merged_into = pedido destino y su mesa se libera.
--  2) transfer_table_order_items(ítems, mesa destino)
--       Transferencia PARCIAL (p. ej. dos comensales se pasan a la barra): las
--       líneas elegidas pasan al pedido abierto del destino; si el destino está
--       libre, se abre. Las líneas conservan estado de cocina, tiempo y marca de
--       comanda impresa (no se reimprime nada).
--  3) set_table_waiter(mesa, mozo)
--       Cambia el mozo de una mesa abierta (relevo de turno). El mozo debe ser
--       miembro activo del negocio.
--
-- Las tres son acciones críticas: escriben audit_logs explícito (table_moved,
-- tables_merged, items_transferred, waiter_changed) además del trigger genérico.
--
-- MOZO POR PEDIDO: `table_orders.waiter_user_id` guarda el mozo del pedido. Hasta
-- hoy el mozo vivía sólo en la mesa y se borraba al cobrar, así que el reporte
-- por mozo caía en "quien abrió". Un trigger en dining_tables lo copia al pedido
-- vivo cada vez que cambia (abrir, cambiar mozo, mover), sin recrear
-- open_dining_table. Backfill: pedidos abiertos con mozo en la mesa.
--
-- NO se toca create_sale: cobra por table_orders.id y libera la mesa por
-- table_orders.table_id, que acá se actualiza en la misma transacción.
-- Concurrencia: pedido(s) FOR UPDATE y mesas FOR UPDATE en orden de id.
-- Gating: flag operativo (dining_enabled), no feature de plan (CLAUDE.md §6).
-- =============================================================================

alter table table_orders
  add column if not exists waiter_user_id uuid references public.users(id) on delete set null,
  add column if not exists merged_into uuid references table_orders(id) on delete set null;

comment on column table_orders.waiter_user_id is
  'Mozo del pedido (snapshot desde dining_tables.waiter_user_id; sobrevive al cobro).';
comment on column table_orders.merged_into is
  'Si el pedido se unió a otro (move_table_order sobre mesa ocupada), el pedido destino.';

update table_orders o
   set waiter_user_id = t.waiter_user_id
  from dining_tables t
 where t.current_order_id = o.id
   and t.tenant_id = o.tenant_id
   and o.status = 'abierta'
   and o.waiter_user_id is null
   and t.waiter_user_id is not null;

-- ── Trigger: mozo de la mesa → pedido vivo ───────────────────────────────────
create or replace function _dining_sync_order_waiter()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.current_order_id is not null and new.waiter_user_id is not null then
    update table_orders
       set waiter_user_id = new.waiter_user_id
     where id = new.current_order_id
       and tenant_id = new.tenant_id
       and status = 'abierta'
       and waiter_user_id is distinct from new.waiter_user_id;
  end if;
  return null;
end;
$$;
revoke all on function _dining_sync_order_waiter() from public, anon, authenticated;

drop trigger if exists dining_tables_sync_order_waiter on dining_tables;
create trigger dining_tables_sync_order_waiter
  after insert or update of waiter_user_id, current_order_id on dining_tables
  for each row execute function _dining_sync_order_waiter();

-- ── 1) move_table_order ──────────────────────────────────────────────────────
create or replace function move_table_order(p_order_id uuid, p_target_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _dining_assert_member();
  v_order   table_orders%rowtype;
  v_src     dining_tables%rowtype;
  v_dst     dining_tables%rowtype;
  v_dst_order table_orders%rowtype;
  v_moved   int := 0;
  v_lock    record;
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
  if v_order.table_id = p_target_table_id then
    raise exception 'same_table';
  end if;

  -- Bloqueo de ambas mesas en orden de id (evita deadlock entre dos mozos que
  -- mueven en sentidos opuestos).
  for v_lock in
    select id from dining_tables
     where id in (v_order.table_id, p_target_table_id) and tenant_id = v_tenant
     order by id
     for update
  loop
    null;
  end loop;

  select * into v_src from dining_tables where id = v_order.table_id and tenant_id = v_tenant;
  select * into v_dst from dining_tables
   where id = p_target_table_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'table_not_found';
  end if;
  if v_dst.status = 'bloqueada' then
    raise exception 'table_blocked';
  end if;
  if v_dst.status = 'reservada' then
    raise exception 'table_reserved';
  end if;

  if v_dst.current_order_id is null then
    -- Mesa destino libre: el pedido se muda entero.
    if exists (select 1 from table_orders
                where table_id = p_target_table_id and tenant_id = v_tenant
                  and status = 'abierta') then
      raise exception 'table_has_open_order';
    end if;

    update table_orders set table_id = p_target_table_id, updated_at = now()
     where id = p_order_id and tenant_id = v_tenant;

    update dining_tables
       set status = case when v_src.status = 'cuenta_pedida' then 'cuenta_pedida' else 'ocupada' end,
           current_order_id = p_order_id,
           waiter_user_id = coalesce(v_src.waiter_user_id, v_order.waiter_user_id)
     where id = p_target_table_id and tenant_id = v_tenant;

    update dining_tables
       set status = 'libre', current_order_id = null, waiter_user_id = null
     where id = v_src.id and tenant_id = v_tenant and current_order_id = p_order_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_tenant, auth.uid(), 'table_orders', p_order_id, 'table_moved',
            jsonb_build_object('table_id', v_src.id, 'table_label', v_src.label),
            jsonb_build_object('table_id', v_dst.id, 'table_label', v_dst.label));

    return jsonb_build_object('mode', 'moved', 'order_id', p_order_id,
                              'table_id', p_target_table_id);
  end if;

  -- Mesa destino ocupada: UNIR. Las líneas pasan al pedido del destino.
  select * into v_dst_order from table_orders
   where id = v_dst.current_order_id and tenant_id = v_tenant
   for update;
  if not found or v_dst_order.status <> 'abierta' then
    raise exception 'target_order_not_open';
  end if;

  update table_order_items set order_id = v_dst_order.id
   where order_id = p_order_id and tenant_id = v_tenant;
  get diagnostics v_moved = row_count;

  update table_orders
     set status = 'cancelada',
         merged_into = v_dst_order.id,
         notes = concat_ws(' · ', nullif(btrim(notes), ''),
                           'Unida a mesa ' || v_dst.label),
         updated_at = now()
   where id = p_order_id and tenant_id = v_tenant;

  update table_orders
     set notes = case
                   when nullif(btrim(v_order.notes), '') is null then notes
                   else concat_ws(' · ', nullif(btrim(notes), ''), btrim(v_order.notes))
                 end,
         updated_at = now()
   where id = v_dst_order.id and tenant_id = v_tenant;

  update dining_tables
     set status = 'libre', current_order_id = null, waiter_user_id = null
   where id = v_src.id and tenant_id = v_tenant and current_order_id = p_order_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'table_orders', v_dst_order.id, 'tables_merged',
          jsonb_build_object('order_id', p_order_id, 'table_id', v_src.id,
                             'table_label', v_src.label),
          jsonb_build_object('order_id', v_dst_order.id, 'table_id', v_dst.id,
                             'table_label', v_dst.label, 'items_moved', v_moved));

  return jsonb_build_object('mode', 'merged', 'order_id', v_dst_order.id,
                            'table_id', p_target_table_id, 'items_moved', v_moved);
end;
$$;
revoke all on function move_table_order(uuid, uuid) from public, anon;
grant execute on function move_table_order(uuid, uuid) to authenticated;

-- ── 2) transfer_table_order_items ────────────────────────────────────────────
create or replace function transfer_table_order_items(
  p_item_ids uuid[],
  p_target_table_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := _dining_assert_member();
  v_src_order uuid;
  v_orders   int;
  v_order    table_orders%rowtype;
  v_dst      dining_tables%rowtype;
  v_dst_order uuid;
  v_moved    int := 0;
  v_lock     record;
  v_opened   boolean := false;
begin
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    raise exception 'no_items';
  end if;

  -- Todas las líneas deben ser del negocio y de UN mismo pedido.
  select count(distinct order_id), min(order_id::text)::uuid
    into v_orders, v_src_order
    from table_order_items
   where id = any (p_item_ids) and tenant_id = v_tenant;
  if v_orders = 0 or (select count(*) from table_order_items
                       where id = any (p_item_ids) and tenant_id = v_tenant)
                     <> cardinality(p_item_ids) then
    raise exception 'item_not_found';
  end if;
  if v_orders > 1 then
    raise exception 'items_from_several_orders';
  end if;

  select * into v_order from table_orders
   where id = v_src_order and tenant_id = v_tenant
   for update;
  if v_order.status <> 'abierta' then
    raise exception 'order_not_open';
  end if;
  if v_order.table_id = p_target_table_id then
    raise exception 'same_table';
  end if;

  for v_lock in
    select id from dining_tables
     where id in (v_order.table_id, p_target_table_id) and tenant_id = v_tenant
     order by id
     for update
  loop
    null;
  end loop;

  select * into v_dst from dining_tables
   where id = p_target_table_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'table_not_found';
  end if;
  if v_dst.status = 'bloqueada' then
    raise exception 'table_blocked';
  end if;
  if v_dst.status = 'reservada' then
    raise exception 'table_reserved';
  end if;

  if v_dst.current_order_id is null then
    -- Abre la mesa destino (mismo criterio que open_dining_table).
    insert into table_orders (tenant_id, table_id, status, opened_by, waiter_user_id)
    values (v_tenant, p_target_table_id, 'abierta', auth.uid(), auth.uid())
    returning id into v_dst_order;
    update dining_tables
       set status = 'ocupada', current_order_id = v_dst_order,
           waiter_user_id = coalesce(waiter_user_id, auth.uid())
     where id = p_target_table_id and tenant_id = v_tenant;
    v_opened := true;
  else
    v_dst_order := v_dst.current_order_id;
    perform 1 from table_orders
      where id = v_dst_order and tenant_id = v_tenant and status = 'abierta'
      for update;
    if not found then
      raise exception 'target_order_not_open';
    end if;
  end if;

  update table_order_items set order_id = v_dst_order
   where id = any (p_item_ids) and tenant_id = v_tenant and order_id = v_src_order;
  get diagnostics v_moved = row_count;

  update table_orders set updated_at = now()
   where id in (v_src_order, v_dst_order) and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'table_orders', v_src_order, 'items_transferred',
          jsonb_build_object('order_id', v_src_order, 'table_id', v_order.table_id,
                             'item_ids', to_jsonb(p_item_ids)),
          jsonb_build_object('order_id', v_dst_order, 'table_id', v_dst.id,
                             'table_label', v_dst.label, 'items_moved', v_moved,
                             'opened_target', v_opened));

  return jsonb_build_object('order_id', v_dst_order, 'table_id', p_target_table_id,
                            'items_moved', v_moved, 'opened_target', v_opened);
end;
$$;
revoke all on function transfer_table_order_items(uuid[], uuid) from public, anon;
grant execute on function transfer_table_order_items(uuid[], uuid) to authenticated;

-- ── 3) set_table_waiter ──────────────────────────────────────────────────────
create or replace function set_table_waiter(p_table_id uuid, p_waiter_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_table  dining_tables%rowtype;
begin
  select * into v_table from dining_tables
   where id = p_table_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'table_not_found';
  end if;
  if v_table.current_order_id is null then
    raise exception 'table_not_open';
  end if;
  if p_waiter_user_id is null or not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = p_waiter_user_id and status = 'active'
  ) then
    raise exception 'waiter_not_member';
  end if;

  update dining_tables set waiter_user_id = p_waiter_user_id
   where id = p_table_id and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'dining_tables', p_table_id, 'waiter_changed',
          jsonb_build_object('waiter_user_id', v_table.waiter_user_id),
          jsonb_build_object('waiter_user_id', p_waiter_user_id,
                             'order_id', v_table.current_order_id));

  return jsonb_build_object('table_id', p_table_id, 'waiter_user_id', p_waiter_user_id);
end;
$$;
revoke all on function set_table_waiter(uuid, uuid) from public, anon;
grant execute on function set_table_waiter(uuid, uuid) to authenticated;
