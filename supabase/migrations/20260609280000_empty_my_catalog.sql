-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F12 — Vaciar catálogo                                                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Da de baja LÓGICA (deleted_at) todos los productos del tenant. Pensado para
-- arrancar de cero a mano (p. ej. al cambiar de rubro y querer otro catálogo). Es
-- destructivo desde la UI (el catálogo del POS queda vacío), pero respeta la baja
-- lógica del proyecto (recuperable por soporte). Sólo owner/manager. Auditado.
-- No toca ventas registradas ni categorías/marcas.
create or replace function public.empty_my_catalog()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant uuid := current_tenant_id();
  v_count integer;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;

  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant
       and user_id = auth.uid()
       and status = 'active'
       and role in ('owner','manager')
  ) then
    raise exception 'forbidden';
  end if;

  update products
     set deleted_at = now()
   where tenant_id = v_tenant
     and deleted_at is null;
  get diagnostics v_count = row_count;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'products', v_tenant, 'catalog_emptied',
          jsonb_build_object('deleted_count', v_count));

  return v_count;
end;
$function$;

revoke all on function public.empty_my_catalog() from public;
grant execute on function public.empty_my_catalog() to authenticated;
