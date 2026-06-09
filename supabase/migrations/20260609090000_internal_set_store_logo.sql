-- =============================================================================
-- Tiendita — Foto/logo por tienda de origen (panel interno).
--
-- Al importar Excels con tiendas NUEVAS, éstas quedan sin logo (logo_url NULL).
-- Esta RPC permite al staff interno setear/cambiar el logo de una tienda de
-- origen (catalog_stores.logo_url) desde la gestión de catálogos. La imagen se
-- sube al bucket público 'catalog-assets' desde el cliente (mismas policies que
-- las carátulas de catálogo) y acá sólo persistimos la URL pública, con auditoría.
--
-- La columna catalog_stores.logo_url YA existe (creada en la migración fundación
-- 20260608380000_tiendita_catalogs.sql); esta migración sólo agrega la RPC.
-- =============================================================================

create or replace function public.internal_set_store_logo(
  p_store_key text,
  p_logo_url text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_before text;
  v_new text;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;

  v_new := nullif(btrim(p_logo_url), '');

  select s.logo_url into v_before
    from catalog_stores s
   where s.key = p_store_key;
  if not found then
    raise exception 'store_not_found';
  end if;

  update catalog_stores
     set logo_url = v_new
   where key = p_store_key;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, auth.uid(), 'catalog_stores', null, 'store_logo_updated',
          jsonb_build_object('store_key', p_store_key, 'logo_url', v_before),
          jsonb_build_object('store_key', p_store_key, 'logo_url', v_new));
end;
$function$;

revoke all on function public.internal_set_store_logo(text, text) from public, anon;
grant execute on function public.internal_set_store_logo(text, text) to authenticated;
