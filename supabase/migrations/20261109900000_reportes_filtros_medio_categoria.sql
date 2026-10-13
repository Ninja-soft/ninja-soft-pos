-- =============================================================================
-- 20261109900000_reportes_filtros_medio_categoria  (TX-5 · ADR-100)
--
-- Filtros guardables de Reportes: además del rango y la sucursal, el usuario
-- filtra por MEDIO DE PAGO y por CATEGORÍA (con sus subcategorías). Los
-- presets se guardan por usuario en users.settings (sin tabla nueva); acá sólo
-- cambia el RPC que arma el reporte de ventas.
--
-- sales_report se recrea desde su ÚLTIMA definición
-- (20261015200000_reportes_por_sucursal) con dos parámetros finales opcionales:
--   p_method      text default null  → payments.method ('cash', 'debit', ...)
--   p_category_id uuid default null  → categories.id (incluye hijas directas)
-- Con ambos en null el resultado es idéntico al anterior. Se dropea la firma
-- de 3 argumentos para no dejar sobrecargas ambiguas en PostgREST; las
-- llamadas con (p_from, p_to[, p_store_id]) siguen funcionando por defaults.
--
-- Criterio con filtro activo (documentado en ADR-100):
--   * Categoría: entran las ventas con al menos un ítem de la categoría y el
--     importe de cada venta pasa a ser la suma de esos ítems. Top productos y
--     categorías muestran sólo esos ítems; los medios de pago se prorratean.
--   * Medio: entran las ventas con al menos un cobro en ese medio y el importe
--     de cada venta se multiplica por la parte cobrada en ese medio. Medios de
--     pago muestra sólo ese medio.
--   * Ambos: se combinan (importe de la categoría × parte del medio).
--
-- Seguridad: igual que antes. SECURITY DEFINER, tenant explícito
-- (sales.tenant_id = current_tenant_id()), alcance por sucursal con
-- report_store_filter (42501 si pide una sucursal ajena). Sin escrituras.
-- =============================================================================

drop function if exists sales_report(timestamptz, timestamptz, uuid);

create or replace function sales_report(
  p_from        timestamptz,
  p_to          timestamptz,
  p_store_id    uuid default null,
  p_method      text default null,
  p_category_id uuid default null
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
  cats as (
    -- Categoría elegida y sus hijas (dos niveles, F6 · H10b), del negocio.
    select c.id
      from categories c
     where p_category_id is not null
       and c.tenant_id = current_tenant_id()
       and (c.id = p_category_id or c.parent_id = p_category_id)
  ),
  base as (
    select sa.id, sa.total, sa.created_at, sa.created_by, sa.customer_id
      from sales sa
      cross join f
     where sa.status = 'completed'
       and sa.tenant_id = current_tenant_id()
       and sa.created_at >= p_from
       and sa.created_at < p_to
       and (f.ids is null or sa.store_id = any (f.ids))
  ),
  scoped as (
    select b.*,
           case when p_category_id is null then b.total
                else coalesce((
                  select sum(si.subtotal)
                    from sale_items si
                    join products pr on pr.id = si.product_id
                   where si.sale_id = b.id
                     and pr.category_id in (select id from cats)
                ), 0)
           end as cat_amount,
           case when p_method is null then 1::numeric
                -- Ojo: least() ignora NULL; sin cobros en el medio la parte es 0.
                else coalesce((
                  select case when coalesce(sum(p.amount), 0) <= 0 then 0::numeric
                              else least(1::numeric,
                                         coalesce(sum(p.amount) filter (where p.method = p_method), 0)
                                         / sum(p.amount))
                         end
                    from payments p
                   where p.sale_id = b.id
                ), 0)
           end as method_share
      from base b
  ),
  s as (
    select sc.id, sc.created_at, sc.created_by, sc.customer_id, sc.total as sale_total,
           round(sc.cat_amount * sc.method_share, 2) as total
      from scoped sc
     where (p_category_id is null or sc.cat_amount > 0)
       and (p_method is null or sc.method_share > 0)
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
        select p.method,
               round(sum(p.amount * case when s.sale_total > 0 and p_category_id is not null
                                         then s.total / s.sale_total
                                         else 1 end), 2) as total
        from payments p join s on s.id = p.sale_id
        where p_method is null or p.method = p_method
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
        where p_category_id is null or pr.category_id in (select id from cats)
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
        left join products pr on pr.id = si.product_id
        where p_category_id is null or pr.category_id in (select id from cats)
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

revoke all on function sales_report(timestamptz, timestamptz, uuid, text, uuid) from public, anon;
grant execute on function sales_report(timestamptz, timestamptz, uuid, text, uuid) to authenticated;
