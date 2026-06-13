-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H56 — Reporte de performance de promociones                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Agrega, por promo de DESCUENTO que aplicó en el período (sales.promo_id no
-- nulo), cuántas ventas la usaron, cuánto descuento otorgó y la facturación de
-- esas ventas. Read-only, tenant-scoped (filtra por current_tenant_id). Las promos
-- de REGALO no descuentan ni setean promo_id → no figuran acá (otra métrica).
create or replace function public.promotion_performance(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with agg as (
    select s.promo_id,
           max(coalesce(s.promo_name, '(promo)')) as promo_name,
           count(*)::int as count,
           coalesce(sum(s.promo_discount), 0) as total_discount,
           coalesce(sum(s.total), 0) as total_sold
    from sales s
    where s.tenant_id = current_tenant_id()
      and s.status = 'completed'
      and s.promo_id is not null
      and s.created_at >= p_from
      and s.created_at < p_to
    group by s.promo_id
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'promo_id', promo_id,
        'promo_name', promo_name,
        'count', count,
        'total_discount', total_discount,
        'total_sold', total_sold
      ) order by total_discount desc)
      from agg
    ), '[]'::jsonb),
    'count', coalesce((select sum(count) from agg), 0),
    'total_discount', coalesce((select sum(total_discount) from agg), 0),
    'total_sold', coalesce((select sum(total_sold) from agg), 0)
  );
$function$;

revoke all on function public.promotion_performance(timestamptz, timestamptz) from public;
grant execute on function public.promotion_performance(timestamptz, timestamptz) to authenticated;
