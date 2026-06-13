-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · Gastronomía — H52: margen por plato en el reporte de top ítems      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Con las recetas/escandallo (H50, `product_recipes`) ya se conoce el COSTO de
-- cada plato. Sumamos a `gastro_top_items_report` el costo estimado y el MARGEN
-- por ítem del top: cierra el criterio de H52 ("el owner identifica los productos
-- con más margen"). Cambio ADITIVO: el bloque `top` gana `cost` y `margin`; el
-- resto del reporte (by_station, by_course) queda igual. La función sigue
-- devolviendo jsonb (misma firma) → create or replace sin drop.
--
-- Costo del plato = suma de qty*unit_cost de su receta (por unidad). El costo de
-- la línea = qty vendida * costo unitario; el margen = importe − costo. Productos
-- SIN receta → costo 0 (margen = importe; la UI lo marca como no significativo).

create or replace function gastro_top_items_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with rc as (
    -- Costo unitario del plato según su receta (por producto).
    select product_id,
           sum(coalesce(qty, 0) * coalesce(unit_cost, 0)) as unit_cost
    from product_recipes
    where tenant_id = current_tenant_id()
    group by product_id
  ),
  li as (
    select coalesce(nullif(btrim(i.name), ''), 'Ítem')           as name,
           coalesce(nullif(btrim(i.station), ''), 'Sin estación') as station,
           greatest(coalesce(i.course, 1), 1)                     as course,
           coalesce(i.qty, 0)                                     as qty,
           coalesce(i.qty, 0) * coalesce(i.unit_price, 0)         as amount,
           coalesce(i.qty, 0) * coalesce(rc.unit_cost, 0)         as cost
    from table_order_items i
    left join rc on rc.product_id = i.product_id
    where i.tenant_id = current_tenant_id()
      and i.created_at >= p_from
      and i.created_at <  p_to
    union all
    select coalesce(nullif(btrim(di.name), ''), 'Ítem')           as name,
           coalesce(nullif(btrim(di.station), ''), 'Sin estación') as station,
           greatest(coalesce(di.course, 1), 1)                     as course,
           coalesce(di.qty, 0)                                     as qty,
           coalesce(di.qty, 0) * coalesce(di.unit_price, 0)        as amount,
           coalesce(di.qty, 0) * coalesce(rc.unit_cost, 0)         as cost
    from delivery_order_items di
    left join rc on rc.product_id = di.product_id
    where di.tenant_id = current_tenant_id()
      and di.created_at >= p_from
      and di.created_at <  p_to
  )
  select jsonb_build_object(
    'top', coalesce((
      select jsonb_agg(x) from (
        select name,
               sum(qty)              as qty,
               sum(amount)           as total,
               sum(cost)             as cost,
               sum(amount) - sum(cost) as margin
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
