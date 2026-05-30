-- =============================================================================
-- 20260530190000_fn_sales_report
-- Hito 4 — reporte de ventas agregado (por día, medio de pago, categoría,
-- cajero) para un rango. SECURITY DEFINER porque resuelve nombres de cajeros
-- de la tabla users (cuya RLS limita a la propia fila); el aislamiento por
-- tenant se garantiza filtrando todo a través del CTE `s` con
-- current_tenant_id(). Ver docs/01-mvp.md §4.1.7.
-- =============================================================================
create or replace function sales_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with s as (
    select id, total, created_at, created_by
    from sales
    where status = 'completed'
      and tenant_id = current_tenant_id()
      and created_at >= p_from
      and created_at < p_to
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
      ) x), '[]'::jsonb)
  );
$$;
