-- =============================================================================
-- 20260531090000_top_products
-- Productos frecuentes para la venta rápida del kiosco: top por unidades vendidas
-- en los últimos 60 días. SECURITY INVOKER → respeta RLS por tenant.
-- =============================================================================
create or replace function top_products(p_limit int default 12)
returns setof products
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select p.*
  from products p
  join sale_items si on si.product_id = p.id
  join sales s on s.id = si.sale_id
  where p.tenant_id = current_tenant_id()
    and p.deleted_at is null
    and p.is_active
    and s.status = 'completed'
    and s.created_at > now() - interval '60 days'
  group by p.id
  order by sum(si.quantity) desc, p.name
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

revoke execute on function top_products(int) from public, anon;
grant  execute on function top_products(int) to authenticated;
