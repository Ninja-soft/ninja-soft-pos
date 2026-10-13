-- =============================================================================
-- 20261105200400_rotacion_mesas_mozos  (F13 · H51 turnover + H52 mozos y
--                                        propinas)
-- -----------------------------------------------------------------------------
-- Turnover de mesas: cuánto tiempo se sienta la gente, cuánto tarda en pedir y
-- cuánto pasa entre "cuenta pedida" y el cobro. Para eso el pedido de mesa suma
-- dos marcas de tiempo, puestas por triggers (no se recrea create_sale, ni
-- close_dining_table, ni set_table_status):
--
--   * table_orders.bill_requested_at: la primera vez que la mesa pasa a
--     'cuenta_pedida' con ese pedido vivo (trigger en dining_tables).
--   * table_orders.closed_at: cuando el pedido deja de estar 'abierta'
--     (cobrada / cancelada; trigger BEFORE UPDATE en table_orders).
--   Backfill: closed_at = updated_at de los pedidos ya cerrados.
--
-- gastro_turnover_report(desde, hasta, sucursal) agrega EN SQL (mismo patrón y
-- filtro de sucursal que gastro_tables_report, 20261015200000):
--   * global y por mesa: pedidos, minutos sentados, minutos hasta el primer
--     pedido, minutos de cuenta pedida a cobro;
--   * por mozo (table_orders.waiter_user_id, 20261105200000; si falta, quien
--     abrió): pedidos, vendido, propinas (sales.tip_amount) y minutos sentados.
-- El reparto de propinas (por mozo o pozo común) se calcula en el cliente sobre
-- estos totales (lib/gastro/tips.ts).
-- =============================================================================

alter table table_orders
  add column if not exists bill_requested_at timestamptz,
  add column if not exists closed_at timestamptz;

update table_orders
   set closed_at = updated_at
 where status <> 'abierta' and closed_at is null;

-- ── closed_at ────────────────────────────────────────────────────────────────
create or replace function _table_orders_stamp_closed()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'abierta' and new.status <> 'abierta' then
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists table_orders_stamp_closed on table_orders;
create trigger table_orders_stamp_closed
  before update of status on table_orders
  for each row execute function _table_orders_stamp_closed();

-- ── bill_requested_at ────────────────────────────────────────────────────────
create or replace function _dining_tables_stamp_bill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cuenta_pedida'
     and old.status is distinct from 'cuenta_pedida'
     and new.current_order_id is not null then
    update table_orders
       set bill_requested_at = coalesce(bill_requested_at, now())
     where id = new.current_order_id and tenant_id = new.tenant_id;
  end if;
  return null;
end;
$$;
revoke all on function _dining_tables_stamp_bill() from public, anon, authenticated;

drop trigger if exists dining_tables_stamp_bill on dining_tables;
create trigger dining_tables_stamp_bill
  after update of status on dining_tables
  for each row execute function _dining_tables_stamp_bill();

-- ── gastro_turnover_report ───────────────────────────────────────────────────
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
    'orders', (select count(*) from o),
    'avg_seated_min', coalesce((select round(avg(seated_min)::numeric, 1) from o), 0),
    'avg_first_item_min', coalesce((select round(avg(first_item_min)::numeric, 1) from o), 0),
    'avg_bill_to_close_min', coalesce((select round(avg(bill_to_close_min)::numeric, 1) from o), 0),
    'tips_total', coalesce((select sum(tip) from o), 0),
    'by_table', coalesce((
      select jsonb_agg(x) from (
        select coalesce(table_label, 'Sin mesa') as table_label,
               coalesce(area_name, 'Sin salón')  as area,
               count(*) as orders,
               round(avg(seated_min)::numeric, 1)        as avg_seated_min,
               round(avg(first_item_min)::numeric, 1)    as avg_first_item_min,
               round(avg(bill_to_close_min)::numeric, 1) as avg_bill_to_close_min
        from o group by 1, 2 order by 3 desc, 1
      ) x), '[]'::jsonb),
    'by_waiter', coalesce((
      select jsonb_agg(x) from (
        select coalesce(u.full_name, u.email, 'Sin mozo') as waiter,
               count(*)          as orders,
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
