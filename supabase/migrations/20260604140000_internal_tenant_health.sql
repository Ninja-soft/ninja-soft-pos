-- =============================================================================
-- 20260604140000_internal_tenant_health
-- F2 — salud operativa por tenant para el panel interno. SECURITY DEFINER con
-- guard is_internal(): solo staff. Devuelve únicamente AGREGADOS (sin filas de
-- ventas ni datos de clientes): último login, última venta, ventas 7 días y
-- usuarios activos. sales queda tenant-aislada para todo lo demás.
-- =============================================================================

create or replace function internal_tenant_health()
returns table (
  tenant_id uuid,
  active_users integer,
  last_login_at timestamptz,
  last_sale_at timestamptz,
  sales_7d_count integer,
  sales_7d_total numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_internal() then raise exception 'forbidden'; end if;

  return query
  select
    t.id,
    coalesce(m.n_active, 0)::int,
    m.last_login,
    s.last_sale,
    coalesce(s.n_7d, 0)::int,
    coalesce(s.total_7d, 0)::numeric
  from tenants t
  left join (
    select tu.tenant_id as tid,
           count(*) filter (where tu.status = 'active') as n_active,
           max(au.last_sign_in_at) as last_login
    from tenant_users tu
    left join auth.users au on au.id = tu.user_id
    group by tu.tenant_id
  ) m on m.tid = t.id
  left join (
    select sa.tenant_id as tid,
           max(sa.created_at) filter (where sa.status = 'completed') as last_sale,
           count(*) filter (
             where sa.status = 'completed'
               and sa.created_at >= now() - interval '7 days'
           ) as n_7d,
           sum(sa.total) filter (
             where sa.status = 'completed'
               and sa.created_at >= now() - interval '7 days'
           ) as total_7d
    from sales sa
    group by sa.tenant_id
  ) s on s.tid = t.id;
end;
$$;

revoke execute on function internal_tenant_health() from public;
revoke execute on function internal_tenant_health() from anon;
grant execute on function internal_tenant_health() to authenticated;
