-- =============================================================================
-- 20270107100000_api_producto_completo  (H68b, ADR-168)
--
-- API pública v1: el producto completo. `GET /api/v1/products` acepta
-- `include` (lista separada por comas) e `ids` (hasta 100 ids, para leer uno
-- o varios productos puntuales):
--
--   attributes   atributos libres ({key, value}), categoría, marca, etiquetas,
--                modelo, temporada y contenido neto.
--   images       imágenes ordenadas (la principal primero) con url y path.
--   price_lists  precio del producto en cada lista vigente, resuelto con el
--                MISMO motor que el POS (_resolve_unit_price, ADR-058).
--   variants     variantes con SKU, código de barras, opciones por eje,
--                precio y stock (por sucursal si también se pide stock).
--   stock        stock por sucursal (product_stock) y total.
--
-- Sin `include` la respuesta es idéntica a la anterior (clientes existentes no
-- cambian). Con algún `include` el máximo por página baja a 100.
--
-- Mismo scope (products:read), mismo límite por credencial (_api_auth) y
-- aislamiento estricto: todo filtra por el tenant del token. Las funciones
-- internas no se exponen (revoke a public/anon/authenticated); las públicas se
-- ejecutan sólo como anon (la ruta Next las llama con la anon key).
-- =============================================================================

-- Valida la lista de include: null o vacía = nada; algo desconocido = 400.
create or replace function _api_product_includes(p_include text[])
returns text[]
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_out text[] := '{}';
  v text;
begin
  if p_include is null then return v_out; end if;
  foreach v in array p_include loop
    v := lower(btrim(v));
    if v = '' then continue; end if;
    if v not in ('attributes', 'images', 'price_lists', 'variants', 'stock') then
      perform _api_fail(400, 'invalid_include',
        'include acepta attributes, images, price_lists, variants y stock.',
        jsonb_build_object('value', v));
    end if;
    if not v = any (v_out) then v_out := v_out || v; end if;
  end loop;
  return v_out;
end;
$$;
revoke all on function _api_product_includes(text[]) from public, anon, authenticated;

-- Producto + lo pedido en include. p_tenant ya validado por _api_auth.
create or replace function _api_product_full_json(p_tenant uuid, p products, p_inc text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := _api_product_json(p);
  v_axes jsonb := case when jsonb_typeof(p.variant_axes) = 'array' then p.variant_axes else '[]'::jsonb end;
  v_stock boolean := 'stock' = any (p_inc);
begin
  if p.tenant_id <> p_tenant then return null; end if;
  if cardinality(p_inc) = 0 then return v; end if;

  if 'attributes' = any (p_inc) then
    v := v || jsonb_build_object(
      'attributes', case when jsonb_typeof(p.attributes) = 'array' then p.attributes
                         when jsonb_typeof(p.attributes) = 'object' then
                           (select coalesce(jsonb_agg(jsonb_build_object('key', e.key, 'value', e.value #>> '{}')), '[]'::jsonb)
                              from jsonb_each(p.attributes) e)
                         else '[]'::jsonb end,
      'category', (select jsonb_build_object('id', c.id, 'name', c.name)
                     from categories c where c.id = p.category_id and c.tenant_id = p_tenant),
      'brand', (select jsonb_build_object('id', b.id, 'name', b.name)
                  from brands b where b.id = p.brand_id and b.tenant_id = p_tenant),
      'tags', coalesce(to_jsonb(p.tags), '[]'::jsonb),
      'model', p.model,
      'season', p.season,
      'net_content', p.net_content,
      'net_content_unit', p.net_content_unit);
  end if;

  if 'images' = any (p_inc) then
    v := v || jsonb_build_object('images', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'url', nullif(i.url, ''), 'path', nullif(i.path, ''),
               'position', i.sort, 'is_primary', i.is_primary)
             order by i.is_primary desc, i.sort, i.created_at)
        from product_images i
       where i.product_id = p.id and i.tenant_id = p_tenant and i.deleted_at is null),
      case when nullif(p.image_url, '') is not null
           then jsonb_build_array(jsonb_build_object('id', null, 'url', p.image_url, 'path', null,
                                                     'position', 0, 'is_primary', true))
           else '[]'::jsonb end));
  end if;

  if 'price_lists' = any (p_inc) then
    v := v || jsonb_build_object('price_lists', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'name', l.name, 'channel', l.channel, 'kind', l.kind,
               'price', _resolve_unit_price(p_tenant, p.id, null, 1, null, null, l.id, now(), 'none', null),
               'prices_include_tax', l.prices_include_tax,
               'valid_from', l.valid_from, 'valid_to', l.valid_to)
             order by l.channel, l.name)
        from price_lists l
       where l.tenant_id = p_tenant and _price_list_valid(l, now())), '[]'::jsonb));
  end if;

  if 'variants' = any (p_inc) then
    v := v || jsonb_build_object('variants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pv.id, 'sku', pv.sku, 'barcode', pv.barcode,
               'options', (select coalesce(jsonb_agg(jsonb_build_object('axis', v_axes ->> (o.n - 1), 'value', o.val)
                                                     order by o.n), '[]'::jsonb)
                             from (values (1, pv.option1), (2, pv.option2)) o(n, val)
                            where nullif(o.val, '') is not null),
               'price', coalesce(pv.price_override, p.price),
               'stock', pv.stock,
               'updated_at', pv.updated_at)
             || case when v_stock then jsonb_build_object('stock_by_store', coalesce((
                  select jsonb_agg(jsonb_build_object('store_id', s.id, 'store_code', s.code, 'qty', ps.qty)
                                   order by s.sort nulls last, s.name)
                    from product_stock ps join stores s on s.id = ps.store_id and s.tenant_id = p_tenant
                   where ps.tenant_id = p_tenant and ps.product_id = p.id and ps.variant_id = pv.id
                     and s.deleted_at is null), '[]'::jsonb))
                else '{}'::jsonb end
             order by pv.option1, pv.option2, pv.created_at)
        from product_variants pv
       where pv.product_id = p.id and pv.tenant_id = p_tenant and pv.deleted_at is null), '[]'::jsonb));
  end if;

  if v_stock then
    v := v || jsonb_build_object('stock_by_store', coalesce((
      select jsonb_agg(jsonb_build_object(
               'store_id', s.id, 'store_code', s.code, 'store_name', s.name,
               'qty', ps.qty, 'min_qty', ps.min_qty, 'max_qty', ps.max_qty, 'location', ps.location)
             order by s.sort nulls last, s.name)
        from product_stock ps join stores s on s.id = ps.store_id and s.tenant_id = p_tenant
       where ps.tenant_id = p_tenant and ps.product_id = p.id and ps.variant_id is null
         and s.deleted_at is null), '[]'::jsonb));
  end if;

  return v;
end;
$$;
revoke all on function _api_product_full_json(uuid, products, text[]) from public, anon, authenticated;

-- Listado: misma firma de antes + p_include (default null = respuesta de siempre).
drop function if exists api_v1_products_list(text, integer, timestamptz, uuid, timestamptz, text, boolean);
drop function if exists _api_v1_products_list(uuid, integer, timestamptz, uuid, timestamptz, text, boolean);

create or replace function _api_v1_products_list(
  p_tenant uuid, p_limit integer, p_after_updated timestamptz, p_after_id uuid,
  p_updated_since timestamptz, p_sku text, p_include_deleted boolean, p_include text[] default null,
  p_ids uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_inc   text[] := _api_product_includes(p_include);
  v_limit integer := _api_limit(p_limit, 100, case when cardinality(v_inc) > 0 then 100 else 500 end);
  v_rows  jsonb;
  v_n     integer;
  v_last  jsonb;
begin
  if (p_after_updated is null) <> (p_after_id is null) then
    perform _api_fail(400, 'invalid_cursor', 'Cursor inválido.');
  end if;
  if cardinality(p_ids) > 100 then
    perform _api_fail(400, 'validation_error', 'ids acepta hasta 100 ids.');
  end if;
  select coalesce(jsonb_agg(_api_product_full_json(p_tenant, x, v_inc) order by x.updated_at, x.id), '[]'::jsonb)
    into v_rows
    from (select p.* from products p
           where p.tenant_id = p_tenant
             and (coalesce(p_include_deleted, false) or p.deleted_at is null)
             and (p_updated_since is null or p.updated_at >= p_updated_since)
             and (p_sku is null or p.sku = p_sku)
             and (p_ids is null or p.id = any (p_ids))
             and (p_after_updated is null or (p.updated_at, p.id) > (p_after_updated, p_after_id))
           order by p.updated_at, p.id
           limit v_limit + 1) x;
  v_n := jsonb_array_length(v_rows);
  if v_n > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
    return jsonb_build_object('status', 200, 'body', jsonb_build_object(
      'data', v_rows,
      'next', jsonb_build_object('updated_at', v_last -> 'updated_at', 'id', v_last -> 'id')));
  end if;
  return jsonb_build_object('status', 200, 'body', jsonb_build_object('data', v_rows, 'next', null));
end;
$$;
revoke all on function _api_v1_products_list(uuid, integer, timestamptz, uuid, timestamptz, text, boolean, text[], uuid[])
  from public, anon, authenticated;

create or replace function api_v1_products_list(
  p_token text, p_limit integer default null, p_after_updated timestamptz default null,
  p_after_id uuid default null, p_updated_since timestamptz default null, p_sku text default null,
  p_include_deleted boolean default false, p_include text[] default null,
  p_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'products:read');
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_products_list((v_auth ->> 'tenant_id')::uuid, p_limit, p_after_updated, p_after_id,
                                   p_updated_since, p_sku, p_include_deleted, p_include, p_ids);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_products_list(text, integer, timestamptz, uuid, timestamptz, text, boolean, text[], uuid[])
  from public, authenticated;
grant execute on function api_v1_products_list(text, integer, timestamptz, uuid, timestamptz, text, boolean, text[], uuid[]) to anon;

notify pgrst, 'reload schema';
