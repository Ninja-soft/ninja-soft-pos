-- =============================================================================
-- 20261013900000_aislamiento_staff_interno  (ADR-052)
--
-- Problema (incidente 2026-10-12): muchas políticas RLS de tablas de negocio
-- eran "tenant_id = current_tenant_id() OR is_internal()". El staff interno
-- (app_metadata.is_internal) usando el PANEL DEL NEGOCIO veía filas de TODOS
-- los negocios en cualquier lista que no filtrara a mano por tenant (p. ej.
-- Sucursales mostraba las sucursales de los 4 negocios).
--
-- Solución de raíz: el acceso interno cruzado vale sólo en el contexto del
-- panel interno. internal_scope() = is_internal() Y la request trae el header
-- `x-ninja-scope: internal`, que sólo mandan los clientes Supabase de /internal
-- (lib/supabase/client.ts y server.ts). Forjar el header no da nada a un no
-- interno (sigue exigiendo el JWT interno).
--
-- Se reescriben TODAS las políticas PERMISSIVE de tablas con tenant_id que
-- usan is_internal(). Las RESTRICTIVE (alcance por sucursal) y las de tablas de
-- plataforma (sin tenant_id: plans, features, system_*) no cambian.
-- Guardarraíl: tests/integration/rls.test.ts falla si vuelve a aparecer una
-- política PERMISSIVE de tabla de negocio con is_internal().
-- =============================================================================

create or replace function public.internal_scope()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.is_internal()
     and coalesce(
       (nullif(current_setting('request.headers', true), '')::json ->> 'x-ninja-scope') = 'internal',
       false
     );
$$;

grant execute on function public.internal_scope() to anon, authenticated, service_role;

do $$
declare
  r record;
  v_using text;
  v_check text;
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and permissive = 'PERMISSIVE'
       and (coalesce(qual, '') like '%is_internal()%' or coalesce(with_check, '') like '%is_internal()%')
       and (coalesce(qual, '') || coalesce(with_check, '')) like '%tenant_id%'
  loop
    v_using := case when r.qual is null then '' else format(' using (%s)', replace(r.qual, 'is_internal()', 'internal_scope()')) end;
    v_check := case when r.with_check is null then '' else format(' with check (%s)', replace(r.with_check, 'is_internal()', 'internal_scope()')) end;
    execute format('alter policy %I on %I.%I%s%s', r.policyname, r.schemaname, r.tablename, v_using, v_check);
  end loop;
end $$;

-- Guardarraíl: políticas PERMISSIVE de tablas de negocio que todavía abren el
-- acceso a todo el staff interno sin exigir el contexto del panel interno.
-- Debe devolver 0 filas (lo verifica tests/integration/rls.test.ts en CI).
create or replace function public.rls_internal_scope_leaks()
returns table (tablename name, policyname name)
language sql
stable
security definer
set search_path = ''
as $$
  select p.tablename, p.policyname
    from pg_catalog.pg_policies p
   where p.schemaname = 'public'
     and p.permissive = 'PERMISSIVE'
     and (coalesce(p.qual, '') like '%is_internal()%' or coalesce(p.with_check, '') like '%is_internal()%')
     and (coalesce(p.qual, '') || coalesce(p.with_check, '')) like '%tenant_id%';
$$;

revoke all on function public.rls_internal_scope_leaks() from public, anon, authenticated;
grant execute on function public.rls_internal_scope_leaks() to service_role;
