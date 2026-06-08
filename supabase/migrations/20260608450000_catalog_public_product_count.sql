-- =============================================================================
-- 20260608450000_catalog_public_product_count
-- Tiendita — conteo PÚBLICO de productos por catálogo (info comercial).
--
-- El RPC catalog_product_count() quedó gateado a que el tenant haya COMPRADO el
-- catálogo (hardening 20260608400000): no sirve para mostrar el tamaño ANTES de
-- comprar. Pero el cliente necesita ver "Incluye N productos" en la tarjeta para
-- decidir la compra.
--
-- Solución: una columna DENORMALIZADA `catalogs.product_count` (bigint) que viaja
-- con la lectura pública de `catalogs` (policy catalogs_read: cualquier
-- autenticado ve los catálogos activos). No expone productos, sólo el número.
--
-- Mantenimiento:
--   - catalog_recount_products(p_catalog_id): recomputa el conteo (deduplicado
--     por EAN si dedupe_by_ean) y lo escribe en la columna. Pensada para el
--     import (service_role) y el panel interno.
--   - notify_catalog_update() ya computa el total deduplicado al cerrar cada
--     import; ahora además persiste ese total en catalogs.product_count, así el
--     número queda fresco sin pasos extra.
--
-- Al final: backfill del conteo real de los catálogos existentes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Columna denormalizada. Default 0; se rellena abajo con el conteo real.
-- -----------------------------------------------------------------------------
alter table public.catalogs
  add column if not exists product_count bigint not null default 0;

comment on column public.catalogs.product_count is
  'Cantidad de productos del catálogo (deduplicada por EAN si dedupe_by_ean). '
  'Denormalizada: la mantiene catalog_recount_products() / notify_catalog_update(). '
  'Lectura pública (info comercial del storefront): se muestra ANTES de comprar.';

-- -----------------------------------------------------------------------------
-- 2) catalog_recount_products(p_catalog_id): recomputa y persiste el conteo.
--    SECURITY DEFINER. Sólo staff interno (por JWT) o llamadas server-side sin
--    sesión (service_role/import script): cuando auth.uid() es null no hay JWT,
--    así el import por script puede refrescar el número sin ser is_internal().
--    Devuelve el conteo calculado.
-- -----------------------------------------------------------------------------
create or replace function public.catalog_recount_products(p_catalog_id uuid)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_total bigint;
begin
  -- Sólo staff interno o llamadas server-side sin sesión (service_role/import).
  if auth.uid() is not null and not is_internal() then
    raise exception 'forbidden';
  end if;

  select c.dedupe_by_ean into v_dedupe from catalogs c where c.id = p_catalog_id;
  if v_dedupe is null then
    return 0;
  end if;

  if v_dedupe then
    select count(distinct cp.ean) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  else
    select count(*) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  end if;

  v_total := coalesce(v_total, 0);

  update catalogs set product_count = v_total where id = p_catalog_id;

  return v_total;
end;
$function$;

revoke all on function public.catalog_recount_products(uuid) from public, anon;
grant execute on function public.catalog_recount_products(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 3) notify_catalog_update(): además de notificar, persiste el total deduplicado
--    en catalogs.product_count. Se recrea conservando firma/seguridad; el único
--    cambio es el `update catalogs ... product_count` tras computar v_total.
-- -----------------------------------------------------------------------------
create or replace function public.notify_catalog_update(p_catalog_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_name text;
  v_total bigint;
  r record;
  v_delta bigint;
  v_count integer := 0;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;

  select c.dedupe_by_ean, c.name into v_dedupe, v_name
    from catalogs c where c.id = p_catalog_id;
  if v_name is null then
    raise exception 'catalog_not_found';
  end if;

  if v_dedupe then
    select count(distinct cp.ean) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  else
    select count(*) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  end if;

  v_total := coalesce(v_total, 0);

  -- Persistir el conteo público (info comercial del storefront).
  update catalogs set product_count = v_total where id = p_catalog_id;

  for r in
    select tcp.id, tcp.tenant_id, tcp.last_notified_product_count
      from tenant_catalog_purchases tcp
      join tenants t on t.id = tcp.tenant_id
     where tcp.catalog_id = p_catalog_id
       and t.deleted_at is null
  loop
    v_delta := v_total - r.last_notified_product_count;
    if v_delta > 0 and r.last_notified_product_count > 0 then
      insert into notifications (
        target_tenant_id, target_role, type, severity, title, body, created_by
      )
      values (
        r.tenant_id, 'owner', 'news', 'info',
        'Tu catálogo "' || v_name || '" se actualizó',
        'Se sumaron ' || v_delta::text || ' productos nuevos al catálogo "'
          || v_name || '". Ya podés buscarlos y agregarlos a tu tienda.',
        auth.uid()
      );
      v_count := v_count + 1;
    end if;
    update tenant_catalog_purchases
       set last_notified_product_count = v_total
     where id = r.id;
  end loop;

  return v_count;
end;
$function$;

revoke all on function public.notify_catalog_update(uuid) from public, anon;
grant execute on function public.notify_catalog_update(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4) Backfill: conteo real de TODOS los catálogos existentes (deduplicado por
--    EAN si corresponde). Idempotente: se puede re-correr sin efectos.
-- -----------------------------------------------------------------------------
update catalogs c set product_count = sub.total
from (
  select cc.id,
         case
           when cc.dedupe_by_ean then count(distinct cp.ean)
           else count(cp.*)
         end as total
    from catalogs cc
    left join catalog_store_map csm on csm.catalog_id = cc.id
    left join catalog_products cp on cp.store_key = csm.store_key
   group by cc.id, cc.dedupe_by_ean
) sub
where sub.id = c.id;
