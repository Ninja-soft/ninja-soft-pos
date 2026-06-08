-- =============================================================================
-- Tiendita — RPCs de administración del addon (panel interno).
--   - catalog_product_count(p_catalog_id): conteo de productos del catálogo,
--     deduplicado por EAN si dedupe_by_ean. Usado por la UI para mostrar tamaño.
--   - internal_save_catalog(...): crea/edita un catálogo y SINCRONIZA sus tiendas
--     (catalog_store_map) de forma transaccional. Sólo staff interno (no support).
-- =============================================================================

create or replace function public.catalog_product_count(p_catalog_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_total bigint;
begin
  -- Lectura del tamaño: cualquier autenticado puede verla (es parte de la oferta).
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

  return coalesce(v_total, 0);
end;
$function$;

revoke all on function public.catalog_product_count(uuid) from public, anon;
grant execute on function public.catalog_product_count(uuid) to authenticated;

create or replace function public.internal_save_catalog(
  p_id uuid,
  p_key text,
  p_name text,
  p_description text,
  p_cover_url text,
  p_price_ars numeric,
  p_dedupe_by_ean boolean,
  p_is_active boolean,
  p_store_keys text[]
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
  v_key text;
  v_before jsonb;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'invalid_name';
  end if;
  if p_price_ars is null or p_price_ars < 0 then
    raise exception 'invalid_price';
  end if;

  if p_id is null then
    v_key := coalesce(
      nullif(btrim(p_key), ''),
      regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g') || '-'
        || substr(md5(random()::text), 1, 4)
    );
    insert into catalogs (key, name, description, cover_url, price_ars,
                          dedupe_by_ean, is_active, created_by)
    values (v_key, btrim(p_name), nullif(btrim(p_description), ''),
            nullif(btrim(p_cover_url), ''), p_price_ars,
            coalesce(p_dedupe_by_ean, true), coalesce(p_is_active, true), auth.uid())
    returning id into v_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (null, auth.uid(), 'catalogs', v_id, 'catalog_saved',
            jsonb_build_object('key', v_key, 'name', btrim(p_name),
                               'price_ars', p_price_ars, 'stores', p_store_keys));
  else
    select to_jsonb(c.*) into v_before from catalogs c where c.id = p_id;
    if v_before is null then
      raise exception 'catalog_not_found';
    end if;
    v_id := p_id;
    update catalogs
       set name = btrim(p_name),
           description = nullif(btrim(p_description), ''),
           cover_url = nullif(btrim(p_cover_url), ''),
           price_ars = p_price_ars,
           dedupe_by_ean = coalesce(p_dedupe_by_ean, dedupe_by_ean),
           is_active = coalesce(p_is_active, is_active)
     where id = p_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
    values (null, auth.uid(), 'catalogs', p_id, 'catalog_saved', v_before,
            jsonb_build_object('name', btrim(p_name), 'price_ars', p_price_ars,
                               'stores', p_store_keys));
  end if;

  -- Sincronizar tiendas del catálogo: borrar las que ya no están, agregar nuevas.
  delete from catalog_store_map
   where catalog_id = v_id
     and (p_store_keys is null or store_key <> all(p_store_keys));

  if p_store_keys is not null then
    insert into catalog_store_map (catalog_id, store_key)
    select v_id, k
      from unnest(p_store_keys) as k
     where exists (select 1 from catalog_stores s where s.key = k)
    on conflict do nothing;
  end if;

  return v_id;
end;
$function$;

revoke all on function public.internal_save_catalog(
  uuid, text, text, text, text, numeric, boolean, boolean, text[]
) from public, anon;
grant execute on function public.internal_save_catalog(
  uuid, text, text, text, text, numeric, boolean, boolean, text[]
) to authenticated;
