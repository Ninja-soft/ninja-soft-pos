-- =============================================================================
-- 20260530220000_fn_tenant_members
-- Panel del dueño — lista los miembros del tenant actual con su email y nombre.
-- SECURITY DEFINER porque resuelve datos de `users` (cuya RLS limita a la propia
-- fila). El aislamiento por tenant se garantiza filtrando por current_tenant_id()
-- y exigiendo que el llamador sea miembro activo del mismo tenant.
-- Ver docs/06-permissions-roles.md y docs/08-multi-tenant.md.
-- =============================================================================
create or replace function tenant_members()
returns table (
  user_id uuid,
  email text,
  full_name text,
  role text,
  status text,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tu.user_id, u.email, u.full_name, tu.role, tu.status, tu.joined_at
  from tenant_users tu
  join users u on u.id = tu.user_id
  where tu.tenant_id = current_tenant_id()
    and exists (
      select 1
      from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
    )
  order by tu.joined_at nulls last;
$$;

revoke all on function tenant_members() from public, anon;
grant execute on function tenant_members() to authenticated;
