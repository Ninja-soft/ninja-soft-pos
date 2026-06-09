-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · H52 — Reportes gastronómicos y operación (mesas, cocina/KDS,         ║
-- ║              delivery, top ítems)                                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Cuatro RPCs de SOLO LECTURA que agregan EN SQL la operación gastronómica del
-- período, espejando el patrón de `sales_report` / `staff_productivity`:
-- SECURITY DEFINER, search_path fijo, tenant-scoped por current_tenant_id(),
-- reciben rango [p_from, p_to) (igual semántica que el resto de reportes), y
-- devuelven un jsonb agregado con coalesce a arrays/0 → NO rompen sin datos.
--
-- Se exponen al cliente (authenticated). NO tocan create_sale ni nada del flujo
-- de cobro. NO regeneran types/database.ts (el front castea; la DB + RLS validan).
--
-- ATRIBUCIÓN DE LA VENTA → MESA/PEDIDO:
--   Las ventas finales viven en `sales` y se enlazan con `table_orders.sale_id`
--   (mesa) o `delivery_orders.sale_id` (delivery). El "ingreso" de una mesa/zona
--   es sales.total de la venta enlazada (sólo ventas completed + pedidos cobrados).
--
-- MOZO: la mesa libera waiter_user_id al cobrar (dining_tables se resetea), así
--   que para el pedido cerrado usamos coalesce(dining_tables.waiter_user_id,
--   table_orders.opened_by): mientras la mesa está viva manda el mozo asignado;
--   ya cobrada, cae a quien abrió/atendió la mesa (señal durable por pedido).
--
-- TIEMPOS KDS: pendiente→listo = (kds_ready_at - created_at) en segundos, sólo
--   ítems con kds_ready_at (los efectivamente marcados listos). Mesa + delivery.
--
-- FUERA DE ALCANCE (follow-up): margen/costo por plato y merma (necesita recetas
--   H50), pronósticos y comparativas inter-período avanzadas.
-- =============================================================================

-- ── 1) gastro_tables_report: mesas / salón / mozo ────────────────────────────
-- Agrega los pedidos de mesa COBRADOS del período (table_orders.status='cobrada'
-- con venta completed enlazada). El cierre del pedido = table_orders.updated_at
-- (no hay closed_at; updated_at se sella al cobrar). El filtro de rango se aplica
-- sobre la fecha de la VENTA (sales.created_at), consistente con sales_report.
--   * by_area  : ingreso, pedidos (rotación) y ticket promedio por salón.
--   * by_table : idem por mesa (rotación = # pedidos cerrados en el período).
--   * by_waiter: ingreso, pedidos y ticket promedio por mozo.
create or replace function gastro_tables_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with o as (
    select o.id,
           o.table_id,
           coalesce(dt.waiter_user_id, o.opened_by) as waiter_id,
           dt.label   as table_label,
           dt.area_id,
           da.name    as area_name,
           s.total    as sale_total
    from table_orders o
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
  )
  select jsonb_build_object(
    'total', coalesce((select sum(sale_total) from o), 0),
    'orders', (select count(*) from o),
    'avg_ticket', case when (select count(*) from o) > 0
                       then round((select sum(sale_total) from o)::numeric
                                  / (select count(*) from o), 2)
                       else 0 end,
    'by_area', coalesce((
      select jsonb_agg(x) from (
        select coalesce(area_name, 'Sin salón') as area,
               sum(sale_total) as total,
               count(*)        as orders,
               round((sum(sale_total) / count(*))::numeric, 2) as avg_ticket
        from o group by 1 order by 2 desc
      ) x), '[]'::jsonb),
    'by_table', coalesce((
      select jsonb_agg(x) from (
        select coalesce(table_label, 'Sin mesa') as table_label,
               coalesce(area_name, 'Sin salón')  as area,
               sum(sale_total) as total,
               count(*)        as orders,
               round((sum(sale_total) / count(*))::numeric, 2) as avg_ticket
        from o group by 1, 2 order by 3 desc
      ) x), '[]'::jsonb),
    'by_waiter', coalesce((
      select jsonb_agg(x) from (
        select coalesce(u.full_name, u.email, 'Sin mozo') as waiter,
               sum(o.sale_total) as total,
               count(*)          as orders,
               round((sum(o.sale_total) / count(*))::numeric, 2) as avg_ticket
        from o left join users u on u.id = o.waiter_id
        group by 1 order by 2 desc
      ) x), '[]'::jsonb)
  );
$$;
revoke all on function gastro_tables_report(timestamptz, timestamptz) from public, anon;
grant execute on function gastro_tables_report(timestamptz, timestamptz) to authenticated;

-- ── 2) gastro_kitchen_report: tiempos de cocina (KDS) por estación ───────────
-- Tiempo pendiente→listo (segundos) = kds_ready_at - created_at, sólo ítems con
-- kds_ready_at marcado, en el período (por created_at del ítem). Une mesa +
-- delivery. Devuelve global (avg/min/max/cantidad) y desglose por estación.
create or replace function gastro_kitchen_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with k as (
    select coalesce(nullif(btrim(station), ''), 'Sin estación') as station,
           extract(epoch from (kds_ready_at - created_at))::numeric as secs
    from table_order_items
    where tenant_id = current_tenant_id()
      and kds_ready_at is not null
      and created_at >= p_from
      and created_at <  p_to
    union all
    select coalesce(nullif(btrim(station), ''), 'Sin estación') as station,
           extract(epoch from (kds_ready_at - created_at))::numeric as secs
    from delivery_order_items
    where tenant_id = current_tenant_id()
      and kds_ready_at is not null
      and created_at >= p_from
      and created_at <  p_to
  ),
  -- Sólo tiempos no negativos (defensa: relojes / ediciones manuales raras).
  kk as (select station, secs from k where secs >= 0)
  select jsonb_build_object(
    'items', (select count(*) from kk),
    'avg_seconds', coalesce((select round(avg(secs), 0) from kk), 0),
    'min_seconds', coalesce((select round(min(secs), 0) from kk), 0),
    'max_seconds', coalesce((select round(max(secs), 0) from kk), 0),
    'by_station', coalesce((
      select jsonb_agg(x) from (
        select station,
               count(*)            as items,
               round(avg(secs), 0) as avg_seconds,
               round(min(secs), 0) as min_seconds,
               round(max(secs), 0) as max_seconds
        from kk group by 1 order by 3 desc
      ) x), '[]'::jsonb)
  );
$$;
revoke all on function gastro_kitchen_report(timestamptz, timestamptz) from public, anon;
grant execute on function gastro_kitchen_report(timestamptz, timestamptz) to authenticated;

-- ── 3) gastro_delivery_report: delivery por canal / zona ─────────────────────
-- Agrega pedidos de delivery COBRADOS del período (delivery_orders.sale_id no
-- null, venta completed). El rango se aplica sobre la VENTA (sales.created_at).
--   * by_channel : pedidos, ingreso, costo de envío y ticket promedio por canal.
--   * by_zone    : idem por zona de envío (delivery_zones).
--   * by_type    : delivery vs takeaway.
--   * totals     : pedidos, ingreso, costo de envío total, ticket promedio.
create or replace function gastro_delivery_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with d as (
    select d.id,
           d.channel,
           d.order_type,
           d.zone_id,
           dz.name as zone_name,
           coalesce(d.delivery_fee, 0) as delivery_fee,
           s.total as sale_total
    from delivery_orders d
    join sales s
      on s.id = d.sale_id
     and s.tenant_id = current_tenant_id()
     and s.status = 'completed'
    left join delivery_zones dz on dz.id = d.zone_id and dz.tenant_id = current_tenant_id()
    where d.tenant_id = current_tenant_id()
      and d.sale_id is not null
      and d.deleted_at is null
      and s.created_at >= p_from
      and s.created_at <  p_to
  )
  select jsonb_build_object(
    'orders', (select count(*) from d),
    'total', coalesce((select sum(sale_total) from d), 0),
    'delivery_fees', coalesce((select sum(delivery_fee) from d), 0),
    'avg_ticket', case when (select count(*) from d) > 0
                       then round((select sum(sale_total) from d)::numeric
                                  / (select count(*) from d), 2)
                       else 0 end,
    'by_channel', coalesce((
      select jsonb_agg(x) from (
        select channel,
               count(*)            as orders,
               sum(sale_total)     as total,
               sum(delivery_fee)   as delivery_fees,
               round((sum(sale_total) / count(*))::numeric, 2) as avg_ticket
        from d group by 1 order by 3 desc
      ) x), '[]'::jsonb),
    'by_zone', coalesce((
      select jsonb_agg(x) from (
        select coalesce(zone_name, 'Sin zona') as zone,
               count(*)            as orders,
               sum(sale_total)     as total,
               sum(delivery_fee)   as delivery_fees,
               round((sum(sale_total) / count(*))::numeric, 2) as avg_ticket
        from d group by 1 order by 3 desc
      ) x), '[]'::jsonb),
    'by_type', coalesce((
      select jsonb_agg(x) from (
        select order_type,
               count(*)        as orders,
               sum(sale_total) as total
        from d group by 1 order by 3 desc
      ) x), '[]'::jsonb)
  );
$$;
revoke all on function gastro_delivery_report(timestamptz, timestamptz) from public, anon;
grant execute on function gastro_delivery_report(timestamptz, timestamptz) to authenticated;

-- ── 4) gastro_top_items_report: top ítems por estación y por curso/tiempo ────
-- Une las líneas de mesa + delivery del período (por created_at del ítem),
-- agregando por nombre. Top global por cantidad e importe, y desglose por
-- estación y por curso/tiempo. Importe = qty * unit_price (snapshot de la línea).
create or replace function gastro_top_items_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with li as (
    select coalesce(nullif(btrim(name), ''), 'Ítem')           as name,
           coalesce(nullif(btrim(station), ''), 'Sin estación') as station,
           greatest(coalesce(course, 1), 1)                     as course,
           coalesce(qty, 0)                                     as qty,
           coalesce(qty, 0) * coalesce(unit_price, 0)           as amount
    from table_order_items
    where tenant_id = current_tenant_id()
      and created_at >= p_from
      and created_at <  p_to
    union all
    select coalesce(nullif(btrim(name), ''), 'Ítem')           as name,
           coalesce(nullif(btrim(station), ''), 'Sin estación') as station,
           greatest(coalesce(course, 1), 1)                     as course,
           coalesce(qty, 0)                                     as qty,
           coalesce(qty, 0) * coalesce(unit_price, 0)           as amount
    from delivery_order_items
    where tenant_id = current_tenant_id()
      and created_at >= p_from
      and created_at <  p_to
  )
  select jsonb_build_object(
    'top', coalesce((
      select jsonb_agg(x) from (
        select name, sum(qty) as qty, sum(amount) as total
        from li group by 1 order by 2 desc limit 20
      ) x), '[]'::jsonb),
    'by_station', coalesce((
      select jsonb_agg(x) from (
        select station, sum(qty) as qty, sum(amount) as total
        from li group by 1 order by 2 desc
      ) x), '[]'::jsonb),
    'by_course', coalesce((
      select jsonb_agg(x) from (
        select course, sum(qty) as qty, sum(amount) as total
        from li group by 1 order by 1 asc
      ) x), '[]'::jsonb)
  );
$$;
revoke all on function gastro_top_items_report(timestamptz, timestamptz) from public, anon;
grant execute on function gastro_top_items_report(timestamptz, timestamptz) to authenticated;
