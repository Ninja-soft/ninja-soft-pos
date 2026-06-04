-- =============================================================================
-- Recuperada del remoto (schema_migrations, version 20260531094748): aplicada
-- vía MCP el 2026-05-31 pero nunca commiteada. Restaurada el 2026-06-04 para
-- que el historial replaye en DBs frescas (detectado por el job rls de CI).
-- =============================================================================
-- TX-5 — sumar "top clientes" al reporte (additivo). Solo ventas con cliente.
create or replace function sales_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with s as (
    select id, total, created_at, created_by, customer_id
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
