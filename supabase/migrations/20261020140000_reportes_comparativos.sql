-- =============================================================================
-- 20261020140000_reportes_comparativos  (F17 · H97 · ADR-057)
--
-- Reportes "Consolidado / Por sucursal / Comparar sucursales". Consolidado y
-- por sucursal usan las RPC con p_store_id de 20261015200000; esta migración
-- suma la comparación lado a lado:
--
--   branch_compare_report(p_from, p_to, p_store_ids uuid[] default null)
--     Una fila por sucursal con: ventas, cantidad, ticket promedio, unidades,
--     anulaciones, devoluciones (por la sucursal de la venta original),
--     margen bruto estimado (importe − cantidad × costo actual del producto,
--     con la cobertura de costo informada), medios de pago, ventas por día,
--     diferencias de caja de los cierres Z del período y clientes (altas en la
--     sucursal, compradores y compradores que ya habían comprado antes).
--     Más los totales del negocio para las mismas sucursales.
--
-- Acceso (SECURITY DEFINER, validado adentro):
--   * Sucursales pedidas: cada una del negocio y con acceso del usuario
--     (user_can_access_store); si no, 'forbidden'. Sin lista: las que el
--     usuario ve (report_store_filter) que estén vivas o tengan ventas en el
--     período.
--   * Comparar más de una sucursal exige multi_sucursal (OPTIONAL, Business):
--     gating real en el servidor, no sólo en la UI.
-- =============================================================================

create or replace function branch_compare_report(
  p_from      timestamptz,
  p_to        timestamptz,
  p_store_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_scope  uuid[];
  v_ids    uuid[];
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if p_to - p_from > interval '400 days' then
    raise exception 'range_too_long' using errcode = '22023';
  end if;

  if p_store_ids is not null and cardinality(p_store_ids) > 0 then
    foreach v_id in array p_store_ids loop
      if not exists (select 1 from stores where id = v_id and tenant_id = v_tenant)
         or not coalesce(user_can_access_store(v_id), false) then
        raise exception 'forbidden' using errcode = '42501';
      end if;
    end loop;
    select array_agg(distinct x) into v_ids from unnest(p_store_ids) x;
  else
    v_scope := report_store_filter(null);
    select coalesce(array_agg(s.id order by s.is_default desc, s.sort, s.created_at), '{}'::uuid[])
      into v_ids
      from stores s
     where s.tenant_id = v_tenant
       and (v_scope is null or s.id = any (v_scope))
       and (s.deleted_at is null
            or exists (select 1 from sales sa
                        where sa.tenant_id = v_tenant and sa.store_id = s.id
                          and sa.created_at >= p_from and sa.created_at < p_to));
  end if;

  if cardinality(v_ids) > 1 and not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
    raise exception 'feature_not_in_plan: multi_sucursal' using errcode = '42501';
  end if;

  return (
    with st as (
      select s.id, s.name, s.short_name, s.color, s.is_default, s.sort, s.created_at,
             (s.deleted_at is not null) as archived
        from stores s
       where s.tenant_id = v_tenant and s.id = any (v_ids)
    ),
    sl as (
      select sa.id, sa.store_id, sa.total, sa.status, sa.created_at, sa.customer_id
        from sales sa
       where sa.tenant_id = v_tenant
         and sa.store_id = any (v_ids)
         and sa.created_at >= p_from and sa.created_at < p_to
    ),
    done as (select * from sl where status = 'completed'),
    k as (
      select d.store_id,
             count(*) as cnt,
             coalesce(sum(d.total), 0) as total
        from done d group by d.store_id
    ),
    voids as (
      select store_id, count(*) as cnt, coalesce(sum(total), 0) as total
        from sl where status = 'voided' group by store_id
    ),
    items as (
      select d.store_id,
             coalesce(sum(si.quantity), 0) as qty,
             coalesce(sum(si.subtotal), 0) as amount,
             coalesce(sum(si.subtotal) filter (where pr.cost is not null and pr.cost > 0), 0) as amount_with_cost,
             coalesce(sum(si.quantity * pr.cost) filter (where pr.cost is not null and pr.cost > 0), 0) as cost
        from done d
        join sale_items si on si.sale_id = d.id
        left join products pr on pr.id = si.product_id
       group by d.store_id
    ),
    rets as (
      select sa.store_id, count(*) as cnt, coalesce(sum(r.total), 0) as total
        from sale_returns r
        join sales sa on sa.id = r.sale_id
       where r.tenant_id = v_tenant
         and sa.store_id = any (v_ids)
         and r.created_at >= p_from and r.created_at < p_to
       group by sa.store_id
    ),
    pays as (
      select d.store_id, p.method, coalesce(sum(p.amount), 0) as total, count(*) as cnt
        from done d join payments p on p.sale_id = d.id
       group by d.store_id, p.method
    ),
    days as (
      select d.store_id,
             to_char((d.created_at at time zone 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') as day,
             coalesce(sum(d.total), 0) as total, count(*) as cnt
        from done d group by 1, 2
    ),
    zs as (
      select z.store_id, count(*) as cnt,
             coalesce(sum(z.difference), 0) as diff,
             coalesce(sum(abs(z.difference)), 0) as diff_abs,
             count(*) filter (where z.difference <> 0) as with_diff
        from cash_z_closures z
       where z.tenant_id = v_tenant and z.store_id = any (v_ids)
         and z.closed_at >= p_from and z.closed_at < p_to
       group by z.store_id
    ),
    cust as (
      select d.store_id,
             count(distinct d.customer_id) as buyers,
             count(distinct d.customer_id) filter (where exists (
               select 1 from sales prev
                where prev.tenant_id = v_tenant and prev.customer_id = d.customer_id
                  and prev.status = 'completed' and prev.created_at < p_from)) as returning_buyers
        from done d where d.customer_id is not null
       group by d.store_id
    ),
    alta as (
      select c.store_id_alta as store_id, count(*) as cnt
        from customers c
       where c.tenant_id = v_tenant and c.store_id_alta = any (v_ids)
         and c.created_at >= p_from and c.created_at < p_to and c.deleted_at is null
       group by c.store_id_alta
    ),
    rs as (
      select st.*,
             coalesce(k.cnt, 0) as cnt,
             coalesce(k.total, 0) as total,
             coalesce(i.qty, 0) as qty,
             coalesce(i.amount, 0) as amount,
             coalesce(i.amount_with_cost, 0) as amount_with_cost,
             coalesce(i.cost, 0) as cost,
             coalesce(v.cnt, 0) as voids_count,
             coalesce(v.total, 0) as voids_total,
             coalesce(r.cnt, 0) as returns_count,
             coalesce(r.total, 0) as returns_total,
             coalesce(z.cnt, 0) as z_count,
             coalesce(z.diff, 0) as cash_diff,
             coalesce(z.diff_abs, 0) as cash_diff_abs,
             coalesce(z.with_diff, 0) as z_with_diff,
             coalesce(c.buyers, 0) as buyers,
             coalesce(c.returning_buyers, 0) as returning_buyers,
             coalesce(a.cnt, 0) as new_customers
        from st
        left join k on k.store_id = st.id
        left join items i on i.store_id = st.id
        left join voids v on v.store_id = st.id
        left join rets r on r.store_id = st.id
        left join zs z on z.store_id = st.id
        left join cust c on c.store_id = st.id
        left join alta a on a.store_id = st.id
    )
    select jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'stores', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'store_id', x.id, 'name', x.name, 'short_name', x.short_name, 'color', x.color,
                 'archived', x.archived,
                 'total', x.total, 'count', x.cnt,
                 'avg_ticket', case when x.cnt > 0 then round(x.total / x.cnt, 2) else 0 end,
                 'items_qty', x.qty,
                 'voids_count', x.voids_count, 'voids_total', x.voids_total,
                 'returns_count', x.returns_count, 'returns_total', x.returns_total,
                 'net_total', x.total - x.returns_total,
                 'margin', x.amount_with_cost - x.cost,
                 'margin_pct', case when x.amount_with_cost > 0
                                    then round((x.amount_with_cost - x.cost) / x.amount_with_cost * 100, 1) end,
                 'cost_coverage_pct', case when x.amount > 0
                                           then round(x.amount_with_cost / x.amount * 100, 1) else 0 end,
                 'z_count', x.z_count, 'cash_diff', x.cash_diff, 'cash_diff_abs', x.cash_diff_abs,
                 'z_with_diff', x.z_with_diff,
                 'buyers', x.buyers, 'returning_buyers', x.returning_buyers,
                 'new_customers', x.new_customers,
                 'by_method', coalesce((
                    select jsonb_agg(jsonb_build_object('method', p.method, 'total', p.total, 'count', p.cnt)
                                     order by p.total desc)
                      from pays p where p.store_id = x.id), '[]'::jsonb),
                 'by_day', coalesce((
                    select jsonb_agg(jsonb_build_object('day', d.day, 'total', d.total, 'count', d.cnt)
                                     order by d.day)
                      from days d where d.store_id = x.id), '[]'::jsonb))
                 order by x.is_default desc, x.sort, x.created_at)
          from rs x), '[]'::jsonb),
      'totals', (
        select jsonb_build_object(
                 'total', coalesce(sum(x.total), 0),
                 'count', coalesce(sum(x.cnt), 0),
                 'avg_ticket', case when coalesce(sum(x.cnt), 0) > 0
                                    then round(sum(x.total) / sum(x.cnt), 2) else 0 end,
                 'items_qty', coalesce(sum(x.qty), 0),
                 'returns_total', coalesce(sum(x.returns_total), 0),
                 'voids_total', coalesce(sum(x.voids_total), 0),
                 'margin', coalesce(sum(x.amount_with_cost - x.cost), 0),
                 'margin_pct', case when coalesce(sum(x.amount_with_cost), 0) > 0
                                    then round(sum(x.amount_with_cost - x.cost) / sum(x.amount_with_cost) * 100, 1) end,
                 'cost_coverage_pct', case when coalesce(sum(x.amount), 0) > 0
                                           then round(sum(x.amount_with_cost) / sum(x.amount) * 100, 1) else 0 end,
                 'cash_diff', coalesce(sum(x.cash_diff), 0),
                 'new_customers', coalesce(sum(x.new_customers), 0))
          from rs x)
    )
  );
end;
$$;
revoke all on function branch_compare_report(timestamptz, timestamptz, uuid[]) from public, anon;
grant execute on function branch_compare_report(timestamptz, timestamptz, uuid[]) to authenticated;
