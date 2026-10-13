-- =============================================================================
-- 20261109600100_gastro_r2_kds_cursos_prioridad  (F13 · H45 prioridad en la
--                                                 comanda, H46 KDS por curso,
--                                                 ADR-097)
-- -----------------------------------------------------------------------------
--  1) Prioridad del pedido: table_orders.priority y delivery_orders.priority
--     ('normal' | 'urgente'). La cambia cualquier miembro activo con
--     set_order_priority (audita order_priority_changed). Se ve en el KDS (la
--     columna urgente va primero y resaltada) y en la comanda impresa.
--  2) KDS por curso: kds_tickets devuelve la prioridad y la etiqueta de la
--     cuenta separada (ADR-097, "Mesa 5 · Comensal 2"). kds_held_courses lista
--     por pedido los tiempos EN ESPERA (no disparados) para que la cocina vea
--     qué viene y pueda "marchar" el siguiente con fire_table_order_course /
--     fire_delivery_order_course (sin RPC nueva para disparar).
--
-- Recreadas copiando la definición más nueva (20260609140000_dining_item_allergens):
-- kds_tickets, comanda_items y delivery_comanda_items. Sólo agregan columnas al
-- final y la etiqueta de la cuenta separada; el resto es idéntico.
-- Gating: flag operativo (dining_enabled / delivery_enabled), no feature de plan.
-- =============================================================================

alter table table_orders
  add column if not exists priority text not null default 'normal'
    check (priority in ('normal', 'urgente'));
alter table delivery_orders
  add column if not exists priority text not null default 'normal'
    check (priority in ('normal', 'urgente'));

comment on column table_orders.priority is 'Prioridad en cocina: normal o urgente (KDS y comanda).';
comment on column delivery_orders.priority is 'Prioridad en cocina: normal o urgente (KDS y comanda).';

-- ── 1) set_order_priority ────────────────────────────────────────────────────
create or replace function set_order_priority(
  p_source   text,
  p_order_id uuid,
  p_priority text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_before text;
begin
  if p_priority not in ('normal', 'urgente') then
    raise exception 'invalid_priority';
  end if;

  if p_source = 'mesa' then
    select priority into v_before from table_orders
     where id = p_order_id and tenant_id = v_tenant and status = 'abierta'
     for update;
    if not found then
      raise exception 'order_not_open';
    end if;
    update table_orders set priority = p_priority, updated_at = now()
     where id = p_order_id and tenant_id = v_tenant;
  elsif p_source = 'delivery' then
    select priority into v_before from delivery_orders
     where id = p_order_id and tenant_id = v_tenant and deleted_at is null
       and sale_id is null and status not in ('entregado', 'cancelado')
     for update;
    if not found then
      raise exception 'order_not_open';
    end if;
    update delivery_orders set priority = p_priority, updated_at = now()
     where id = p_order_id and tenant_id = v_tenant;
  else
    raise exception 'invalid_source';
  end if;

  if v_before is distinct from p_priority then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_tenant, auth.uid(),
            case when p_source = 'mesa' then 'table_orders' else 'delivery_orders' end,
            p_order_id, 'order_priority_changed',
            jsonb_build_object('priority', v_before),
            jsonb_build_object('priority', p_priority));
  end if;

  return jsonb_build_object('order_id', p_order_id, 'source', p_source, 'priority', p_priority);
end;
$$;
revoke all on function set_order_priority(text, uuid, text) from public, anon;
grant execute on function set_order_priority(text, uuid, text) to authenticated;

-- ── 2) kds_tickets (copia de 20260609140000 + priority) ──────────────────────
drop function if exists kds_tickets(text);
create or replace function kds_tickets(p_station text default null)
returns table(
  item_id uuid, order_id uuid, table_id uuid, table_label text, area_name text,
  product_id uuid, name text, qty numeric, modifiers jsonb, notes text,
  allergens text, station text, kds_status text, course smallint,
  created_at timestamptz, ready_at timestamptz,
  source text, source_label text,
  priority text -- ADR-097
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
      'mesa'::text,
      ('Mesa ' || t.label || coalesce(' · ' || o.split_label, ''))::text, -- ADR-097
      o.priority
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
      'delivery'::text, _delivery_order_label(d.id, d.order_type),
      d.priority
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

-- ── 3) kds_held_courses: tiempos en espera por pedido ────────────────────────
-- Un renglón por pedido activo y tiempo con ítems sin disparar (de la estación
-- pedida o de todas). La cocina ve "T2 · Principal (3) en espera" y lo marcha.
create or replace function kds_held_courses(p_station text default null)
returns table(
  source text, order_id uuid, source_label text, area_name text,
  course smallint, held integer, priority text, first_at timestamptz
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
    select 'mesa'::text, o.id,
           ('Mesa ' || t.label || coalesce(' · ' || o.split_label, ''))::text,
           a.name, i.course, count(*)::integer, o.priority, min(i.created_at)
      from table_order_items i
      join table_orders o  on o.id = i.order_id and o.tenant_id = v_tenant
      join dining_tables t on t.id = o.table_id and t.tenant_id = v_tenant
      left join dining_areas a on a.id = t.area_id and a.tenant_id = v_tenant
     where i.tenant_id = v_tenant
       and o.status = 'abierta'
       and i.fired_at is null
       and (v_filter is null or i.station = v_filter)
     group by o.id, t.label, o.split_label, a.name, i.course, o.priority

    union all

    select 'delivery'::text, d.id, _delivery_order_label(d.id, d.order_type), null::text,
           di.course, count(*)::integer, d.priority, min(di.created_at)
      from delivery_order_items di
      join delivery_orders d on d.id = di.order_id and d.tenant_id = v_tenant
     where di.tenant_id = v_tenant
       and d.deleted_at is null
       and d.status not in ('entregado', 'cancelado')
       and d.sale_id is null
       and di.fired_at is null
       and (v_filter is null or di.station = v_filter)
     group by d.id, d.order_type, di.course, d.priority

    order by 8 asc, 5 asc;
end;
$$;
revoke all on function kds_held_courses(text) from public, anon;
grant execute on function kds_held_courses(text) to authenticated;

-- ── 4) comanda_items (copia de 20260609140000 + priority + cuenta separada) ──
drop function if exists comanda_items(uuid, boolean);
create or replace function comanda_items(p_order_id uuid, p_only_new boolean default false)
returns table(
  item_id uuid, product_id uuid, name text, qty numeric, modifiers jsonb,
  notes text, allergens text, station text, course smallint, printed_at timestamptz,
  table_label text, area_name text, waiter_name text, opened_at timestamptz,
  priority text, split_label text -- ADR-097
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
      o.opened_at,
      o.priority, o.split_label
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

-- ── 5) delivery_comanda_items (copia de 20260609140000 + priority) ───────────
drop function if exists delivery_comanda_items(uuid, boolean);
create or replace function delivery_comanda_items(p_order_id uuid, p_only_new boolean default false)
returns table(
  item_id uuid, product_id uuid, name text, qty numeric, modifiers jsonb,
  notes text, allergens text, station text, course smallint, printed_at timestamptz,
  source_label text, channel text, order_type text, courier_name text,
  customer_name text, address text, opened_at timestamptz,
  priority text -- ADR-097
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
      d.courier_name, d.customer_name, d.address, d.created_at,
      d.priority
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
