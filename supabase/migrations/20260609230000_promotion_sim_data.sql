-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H56 — Datos para el SIMULADOR de promociones                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- El simulador corre una promo (en el cliente, con el motor puro) contra ventas
-- históricas para previsualizar su impacto. Esta RPC arma los datos: por cada
-- venta COMPLETADA del período (las más recientes, hasta p_limit) devuelve su
-- contexto temporal (día de semana / minuto del día / fecha en HORA LOCAL DE
-- ARGENTINA, resuelto acá para no hacer timezone en el cliente) y sus líneas
-- (producto + categoría + cantidad + precio + importe). SECURITY DEFINER con
-- filtro EXPLÍCITO por tenant (no expone datos de otros tenants). Sólo lectura.

create or replace function promotion_sim_data(
  p_from  timestamptz,
  p_to    timestamptz,
  p_limit int default 1000
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with s as (
    select
      sa.id,
      extract(dow  from (sa.created_at at time zone 'America/Argentina/Buenos_Aires'))::int as weekday,
      (extract(hour from (sa.created_at at time zone 'America/Argentina/Buenos_Aires')) * 60
        + extract(minute from (sa.created_at at time zone 'America/Argentina/Buenos_Aires')))::int as minutes,
      to_char((sa.created_at at time zone 'America/Argentina/Buenos_Aires'), 'YYYY-MM-DD') as date
    from sales sa
    where sa.tenant_id = current_tenant_id()
      and sa.status = 'completed'
      and sa.created_at >= p_from
      and sa.created_at <  p_to
    order by sa.created_at desc
    limit greatest(1, least(coalesce(p_limit, 1000), 5000))
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'weekday', s.weekday,
      'minutes', s.minutes,
      'date',    s.date,
      'lines', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'productId',  si.product_id,
          'categoryId', p.category_id,
          'unitPrice',  si.unit_price,
          'quantity',   si.quantity,
          'lineTotal',  si.subtotal
        )), '[]'::jsonb)
        from sale_items si
        left join products p on p.id = si.product_id
        where si.sale_id = s.id and si.tenant_id = current_tenant_id()
      )
    )
  ), '[]'::jsonb)
  from s;
$$;
revoke all on function promotion_sim_data(timestamptz, timestamptz, int) from public, anon;
grant execute on function promotion_sim_data(timestamptz, timestamptz, int) to authenticated;
