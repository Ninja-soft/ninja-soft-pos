-- =============================================================================
-- 20261015200000_reportes_por_sucursal  (F17 · H97 primer corte · ADR-049)
--
-- Los reportes por RPC (SECURITY DEFINER, por negocio) ganan un filtro de
-- sucursal opcional y dejan de mostrar datos de sucursales ajenas:
--
--   * report_store_filter(p_store_id) devuelve las sucursales a considerar:
--       - p_store_id informado: exige acceso a esa sucursal
--         (user_can_access_store) y devuelve {p_store_id}; si no, 'forbidden'
--         (42501).
--       - p_store_id null y el usuario ve TODAS las sucursales del negocio
--         (dueño, staff interno, encargado sin restricción, negocio con una
--         sola sucursal): null = consolidado, exactamente como hasta ahora.
--       - p_store_id null y el usuario está limitado a algunas sucursales:
--         user_allowed_store_ids(). Cierra la fuga por la que un cajero o
--         encargado de Norte veía en Reportes los totales de todo el negocio
--         (las RPC son SECURITY DEFINER y no pasan por la RLS por sucursal).
--
--   * sales_report, staff_productivity y gastro_*_report se recrean desde su
--     ÚLTIMA definición con un parámetro final p_store_id uuid default null.
--     Se dropea la firma vieja (evita la ambigüedad de sobrecarga en
--     PostgREST); las llamadas viejas con (p_from, p_to) siguen funcionando.
--     El resto de la lógica no cambia.
--
-- Criterio por reporte con filtro activo:
--   - Ventas (sales_report, mesas, delivery, productividad): sales.store_id.
--   - Cocina y top ítems (líneas de mesa y delivery, sin sucursal propia): las
--     líneas cuyo pedido tiene venta en las sucursales filtradas. Sin filtro
--     (consolidado) se cuentan todas como antes, incluidas las de pedidos aún
--     no cobrados.
--   - Servicios de la agenda (staff_productivity): los turnos realizados cuya
--     venta es de las sucursales filtradas (appointments no tiene sucursal).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Helper de alcance
-- -----------------------------------------------------------------------------
create or replace function report_store_filter(p_store_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_allowed uuid[];
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  if p_store_id is not null then
    if not exists (select 1 from stores where id = p_store_id and tenant_id = v_tenant)
       or not coalesce(user_can_access_store(p_store_id), false) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    return array[p_store_id];
  end if;

  if is_internal() then
    return null;
  end if;

  v_allowed := coalesce(user_allowed_store_ids(), '{}'::uuid[]);
  -- Alcance total: todas las sucursales del negocio (incluidas archivadas,
  -- para no perder historia) están permitidas → consolidado sin filtro.
  if not exists (
    select 1 from stores s
     where s.tenant_id = v_tenant
       and not (s.id = any (v_allowed))
  ) then
    return null;
  end if;
  return v_allowed;
end;
$$;
revoke all on function report_store_filter(uuid) from public, anon;
grant execute on function report_store_filter(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- B) sales_report (última versión: 20260531032000_sales_report_by_customer)
-- -----------------------------------------------------------------------------
drop function if exists sales_report(timestamptz, timestamptz);
create or replace function sales_report(
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
  s as (
    select sa.id, sa.total, sa.created_at, sa.created_by, sa.customer_id
    from sales sa
    cross join f
    where sa.status = 'completed'
      and sa.tenant_id = current_tenant_id()
      and sa.created_at >= p_from
      and sa.created_at < p_to
      and (f.ids is null or sa.store_id = any (f.ids))
  )
  select jsonb_build_object(
    'total', coalesce((select sum(total) from s), 0),
    'count', (select count(*) from s),
    'by_day', coalesce((
      select jsonb_agg(x) from (
        select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
               sum(total) as total, count(*) as count
        from s group by 1 order by 1
      ) x), '[]'::jsonb),
    'by_method', coalesce((
      select jsonb_agg(x) from (
        select p.method, sum(p.amount) as total
        from payments p join s on s.id = p.sale_id
        group by p.method order by 2 desc
      ) x), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(x) from (
        select coalesce(c.name, 'Sin categoría') as category,
               sum(si.subtotal) as total, sum(si.quantity) as qty
        from sale_items si
        join s on s.id = si.sale_id
        left join products pr on pr.id = si.product_id
        left join categories c on c.id = pr.category_id
        group by 1 order by 2 desc
      ) x), '[]'::jsonb),
    'by_user', coalesce((
      select jsonb_agg(x) from (
        select coalesce(u.full_name, u.email, 'N/D') as cashier,
               sum(s.total) as total, count(*) as count
        from s left join users u on u.id = s.created_by
        group by 1 order by 2 desc
      ) x), '[]'::jsonb),
    'by_product', coalesce((
      select jsonb_agg(x) from (
        select coalesce(si.product_name, 'N/D') as product,
               sum(si.subtotal) as total, sum(si.quantity) as qty
        from sale_items si
        join s on s.id = si.sale_id
        group by 1 order by 2 desc limit 15
      ) x), '[]'::jsonb),
    'by_customer', coalesce((
      select jsonb_agg(x) from (
        select cu.name as customer, sum(s.total) as total, count(*) as count
        from s join customers cu on cu.id = s.customer_id
        group by 1 order by 2 desc limit 15
      ) x), '[]'::jsonb)
  );
$$;
revoke all on function sales_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function sales_report(timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C) staff_productivity (última versión: 20260608550000_commissions_tips)
-- -----------------------------------------------------------------------------
drop function if exists public.staff_productivity(timestamptz, timestamptz);
create or replace function public.staff_productivity(
  p_from     timestamptz,
  p_to       timestamptz,
  p_store_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_own_only boolean;
  v_is_owner boolean;
  v_my_prof  uuid;
  v_stores   uuid[];
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'forbidden';
  end if;

  -- Sucursales del reporte (null = consolidado).
  v_stores := report_store_filter(p_store_id);

  select coalesce(staff_sees_own_only, false) into v_own_only
  from pos_settings where tenant_id = v_tenant;

  select exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = auth.uid()
       and status = 'active' and role = 'owner'
  ) into v_is_owner;

  -- Profesional del usuario actual (para el filtro sólo-propio).
  select id into v_my_prof
  from professionals
  where tenant_id = v_tenant and user_id = auth.uid() and deleted_at is null
  limit 1;

  return (
    with
    -- Ventas completadas del período, con el profesional atribuido (turno gana
    -- sobre venta directa).
    sales_scope as (
      select s.id,
             s.total,
             coalesce(s.tip_amount, 0) as tip_amount,
             coalesce(ap.professional_id, s.professional_id) as professional_id
      from sales s
      left join appointments ap
        on ap.sale_id = s.id and ap.tenant_id = v_tenant
      where s.tenant_id = v_tenant
        and s.status = 'completed'
        and s.created_at >= p_from
        and s.created_at < p_to
        and (v_stores is null or s.store_id = any (v_stores))
    ),
    scoped as (
      select * from sales_scope
      where professional_id is not null
        and (
          not v_own_only or v_is_owner
          or professional_id = v_my_prof
        )
    ),
    -- Comisión + conteo de productos por línea de cada venta atribuida.
    lines as (
      select sc.professional_id,
             si.product_id,
             si.quantity,
             si.subtotal,
             coalesce(pr.commission_pct, prof.commission_pct, 0) as pct
      from scoped sc
      join sale_items si on si.sale_id = sc.id and si.tenant_id = v_tenant
      left join products pr on pr.id = si.product_id
      left join professionals prof on prof.id = sc.professional_id
    ),
    per_prof_lines as (
      select professional_id,
             sum(case when product_id is not null then quantity else 0 end) as products_qty,
             sum(round((subtotal * pct / 100)::numeric, 2)) as commission
      from lines
      group by professional_id
    ),
    -- Turnos realizados (servicios) del período, por profesional. Con filtro de
    -- sucursal, sólo los turnos cuya venta es de esas sucursales.
    services as (
      select a.professional_id, count(*) as services_count
      from appointments a
      where a.tenant_id = v_tenant
        and a.professional_id is not null
        and a.status = 'realizado'
        and a.starts_at >= p_from
        and a.starts_at < p_to
        and (not v_own_only or v_is_owner or a.professional_id = v_my_prof)
        and (
          v_stores is null
          or exists (
            select 1 from sales sx
             where sx.id = a.sale_id
               and sx.tenant_id = v_tenant
               and sx.store_id = any (v_stores)
          )
        )
      group by a.professional_id
    ),
    -- Totales por venta atribuida (facturado, propina, ticket).
    per_prof_sales as (
      select professional_id,
             count(*) as sales_count,
             sum(total) as billed,
             sum(tip_amount) as tips
      from scoped
      group by professional_id
    )
    select coalesce(jsonb_agg(j), '[]'::jsonb) from (
      select jsonb_build_object(
        'professional_id', p.id,
        'professional', p.name,
        'services', coalesce(sv.services_count, 0),
        'products_qty', coalesce(pl.products_qty, 0),
        'sales_count', coalesce(ps.sales_count, 0),
        'billed', coalesce(ps.billed, 0),
        'commission', coalesce(pl.commission, 0),
        'tips', coalesce(ps.tips, 0),
        'avg_ticket', case when coalesce(ps.sales_count, 0) > 0
                           then round((ps.billed / ps.sales_count)::numeric, 2)
                           else 0 end
      ) as j
      from professionals p
      left join per_prof_sales ps on ps.professional_id = p.id
      left join per_prof_lines pl on pl.professional_id = p.id
      left join services      sv on sv.professional_id = p.id
      where p.tenant_id = v_tenant
        and p.deleted_at is null
        and (not v_own_only or v_is_owner or p.id = v_my_prof)
        -- Sólo profesionales con actividad en el período (o el propio).
        and (ps.professional_id is not null or sv.professional_id is not null
             or p.id = v_my_prof)
      order by coalesce(ps.billed, 0) desc, coalesce(pl.commission, 0) desc
    ) t
  );
end;
$function$;
revoke all on function public.staff_productivity(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.staff_productivity(timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) gastro_tables_report (última versión: 20260609130000_gastro_reports)
-- -----------------------------------------------------------------------------
drop function if exists gastro_tables_report(timestamptz, timestamptz);
create or replace function gastro_tables_report(
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
           o.table_id,
           coalesce(dt.waiter_user_id, o.opened_by) as waiter_id,
           dt.label   as table_label,
           dt.area_id,
           da.name    as area_name,
           s.total    as sale_total
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
revoke all on function gastro_tables_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function gastro_tables_report(timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- E) gastro_kitchen_report (última versión: 20260609130000_gastro_reports)
-- -----------------------------------------------------------------------------
drop function if exists gastro_kitchen_report(timestamptz, timestamptz);
create or replace function gastro_kitchen_report(
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
  k as (
    select coalesce(nullif(btrim(i.station), ''), 'Sin estación') as station,
           extract(epoch from (i.kds_ready_at - i.created_at))::numeric as secs
    from table_order_items i
    cross join f
    where i.tenant_id = current_tenant_id()
      and i.kds_ready_at is not null
      and i.created_at >= p_from
      and i.created_at <  p_to
      and (
        f.ids is null
        or exists (
          select 1 from table_orders o
          join sales s on s.id = o.sale_id and s.tenant_id = current_tenant_id()
          where o.id = i.order_id and s.store_id = any (f.ids)
        )
      )
    union all
    select coalesce(nullif(btrim(di.station), ''), 'Sin estación') as station,
           extract(epoch from (di.kds_ready_at - di.created_at))::numeric as secs
    from delivery_order_items di
    cross join f
    where di.tenant_id = current_tenant_id()
      and di.kds_ready_at is not null
      and di.created_at >= p_from
      and di.created_at <  p_to
      and (
        f.ids is null
        or exists (
          select 1 from delivery_orders d
          join sales s on s.id = d.sale_id and s.tenant_id = current_tenant_id()
          where d.id = di.order_id and s.store_id = any (f.ids)
        )
      )
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
revoke all on function gastro_kitchen_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function gastro_kitchen_report(timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) gastro_delivery_report (última versión: 20260609130000_gastro_reports)
-- -----------------------------------------------------------------------------
drop function if exists gastro_delivery_report(timestamptz, timestamptz);
create or replace function gastro_delivery_report(
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
  d as (
    select d.id,
           d.channel,
           d.order_type,
           d.zone_id,
           dz.name as zone_name,
           coalesce(d.delivery_fee, 0) as delivery_fee,
           s.total as sale_total
    from delivery_orders d
    cross join f
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
      and (f.ids is null or s.store_id = any (f.ids))
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
revoke all on function gastro_delivery_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function gastro_delivery_report(timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- G) gastro_top_items_report (última versión: 20260609180000_gastro_top_margin)
-- -----------------------------------------------------------------------------
drop function if exists gastro_top_items_report(timestamptz, timestamptz);
create or replace function gastro_top_items_report(
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
  rc as (
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
    cross join f
    left join rc on rc.product_id = i.product_id
    where i.tenant_id = current_tenant_id()
      and i.created_at >= p_from
      and i.created_at <  p_to
      and (
        f.ids is null
        or exists (
          select 1 from table_orders o
          join sales s on s.id = o.sale_id and s.tenant_id = current_tenant_id()
          where o.id = i.order_id and s.store_id = any (f.ids)
        )
      )
    union all
    select coalesce(nullif(btrim(di.name), ''), 'Ítem')           as name,
           coalesce(nullif(btrim(di.station), ''), 'Sin estación') as station,
           greatest(coalesce(di.course, 1), 1)                     as course,
           coalesce(di.qty, 0)                                     as qty,
           coalesce(di.qty, 0) * coalesce(di.unit_price, 0)        as amount,
           coalesce(di.qty, 0) * coalesce(rc.unit_cost, 0)         as cost
    from delivery_order_items di
    cross join f
    left join rc on rc.product_id = di.product_id
    where di.tenant_id = current_tenant_id()
      and di.created_at >= p_from
      and di.created_at <  p_to
      and (
        f.ids is null
        or exists (
          select 1 from delivery_orders d
          join sales s on s.id = d.sale_id and s.tenant_id = current_tenant_id()
          where d.id = di.order_id and s.store_id = any (f.ids)
        )
      )
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
revoke all on function gastro_top_items_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function gastro_top_items_report(timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- H) register_stock_waste por sucursal (última versión:
--    20260609170000_stock_waste). Suma p_store_id opcional: null = como antes
--    (el trigger de stock_movements completa la sucursal principal). Con
--    sucursal: tiene que ser del negocio, estar viva y el usuario tener acceso;
--    fuera de la principal exige multi_sucursal + stock_sucursales (mismo
--    criterio que adjust_store_stock). Sigue SECURITY INVOKER + RLS.
-- -----------------------------------------------------------------------------
drop function if exists register_stock_waste(uuid, numeric, text, text);
create or replace function register_stock_waste(
  p_product_id  uuid,
  p_qty         numeric,
  p_loss_reason text,
  p_notes       text default null,
  p_store_id    uuid default null
)
returns numeric
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_new_stock numeric;
  v_tenant    uuid := current_tenant_id();
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'invalid_qty';
  end if;
  if p_loss_reason not in ('vencido','roto','preparacion_fallida','devolucion','otro') then
    raise exception 'invalid_loss_reason: %', p_loss_reason;
  end if;

  if p_store_id is not null then
    if not exists (
      select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null
    ) then
      raise exception 'store_not_found';
    end if;
    if not coalesce(user_can_access_store(p_store_id), false) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if p_store_id is distinct from stock_default_store(v_tenant) then
      if not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
        raise exception 'feature_not_in_plan: multi_sucursal';
      end if;
      if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
        raise exception 'feature_not_in_plan: stock_sucursales';
      end if;
    end if;
  end if;

  -- RLS limita el UPDATE al tenant actual; si no matchea, no actualiza nada.
  update products
     set stock = stock - p_qty,
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_product_id
     and tenant_id = v_tenant
     and deleted_at is null
  returning stock into v_new_stock;

  if v_new_stock is null then
    raise exception 'product_not_found_or_forbidden';
  end if;

  insert into stock_movements (tenant_id, product_id, delta, reason, loss_reason, notes, created_by, store_id)
  values (v_tenant, p_product_id, -p_qty, 'loss', p_loss_reason, p_notes, auth.uid(), p_store_id);

  return v_new_stock;
end;
$$;
