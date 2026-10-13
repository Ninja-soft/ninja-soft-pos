-- =============================================================================
-- 20261109400300_api_publica_v1  (ADR-094 · F5 · API pública v1)
--
-- Operaciones de /api/v1. Patrón de cada endpoint:
--
--   api_v1_<op>(p_token, ...)            pública, sólo anon (la llama la ruta
--     │                                  de Next con la anon key)
--     ├─ _api_auth(p_token, '<scope>')    token -> negocio, alcance, plan, límite
--     └─ _api_v1_<op>(v_tenant, ...)      SECURITY DEFINER, recibe el negocio
--                                         validado y filtra TODO por él
--
-- Ningún parámetro elige el negocio: un id (producto, sucursal, cliente) de
-- otro negocio simplemente no existe para la credencial (404 / error por ítem).
-- Los lotes (hasta 500) se validan antes de escribir y devuelven el resultado
-- por ítem; las escrituras en lote aceptan Idempotency-Key.
--
-- Rol de integración (ADR-071, docs/06-permissions-roles.md): la API actúa
-- como un encargado limitado por alcances: catálogo, stock, precios y
-- clientes; ventas sólo lectura; nunca caja, personal, permisos ni plan.
-- Auditoría: los triggers de cada tabla (audit_products, stock) más una fila
-- por lote con el cliente (entity_type 'api_client').
--
-- Índices nuevos para la sincronización por cursor (updated_at, id) y la
-- clave externa de clientes (customers.external_id).
-- =============================================================================

create index if not exists products_tenant_updated_idx on products (tenant_id, updated_at, id);

alter table customers add column if not exists external_id text
  check (external_id is null or char_length(external_id) between 1 and 100);
comment on column customers.external_id is
  'Id del cliente en el sistema externo que sincroniza por la API pública (ADR-094). Único por negocio.';
create unique index if not exists customers_tenant_external_idx
  on customers (tenant_id, external_id) where external_id is not null and deleted_at is null;
create index if not exists customers_tenant_updated_idx on customers (tenant_id, updated_at, id);

-- -----------------------------------------------------------------------------
-- Vistas JSON.
-- -----------------------------------------------------------------------------
create or replace function _api_product_json(p products)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id, 'sku', p.sku, 'barcode', p.barcode, 'name', p.name, 'description', p.description,
    'price', p.price, 'cost', p.cost, 'unit', p.unit, 'is_active', p.is_active,
    'track_stock', p.track_stock, 'stock', p.stock, 'stock_min', p.stock_min,
    'has_variants', p.has_variants, 'created_at', p.created_at, 'updated_at', p.updated_at,
    'deleted_at', p.deleted_at);
$$;
revoke all on function _api_product_json(products) from public, anon, authenticated;

create or replace function _api_customer_json(c customers)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id, 'external_id', c.external_id, 'name', c.name, 'email', c.email, 'phone', c.phone,
    'document_type', c.document_type, 'document_number', c.document_number, 'address', c.address,
    'iva_condition', c.iva_condition, 'notes', c.notes, 'is_active', c.is_active,
    'created_at', c.created_at, 'updated_at', c.updated_at, 'deleted_at', c.deleted_at);
$$;
revoke all on function _api_customer_json(customers) from public, anon, authenticated;

-- Lote: arreglo de 1 a p_max objetos.
create or replace function _api_assert_batch(p_items jsonb, p_max integer)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    perform _api_fail(422, 'validation_error', 'items tiene que ser un arreglo.');
  end if;
  n := jsonb_array_length(p_items);
  if n = 0 or n > p_max then
    perform _api_fail(422, 'validation_error', format('items: de 1 a %s elementos por pedido.', p_max));
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then
    perform _api_fail(422, 'validation_error', 'Cada elemento de items tiene que ser un objeto.');
  end if;
  return n;
end;
$$;
revoke all on function _api_assert_batch(jsonb, integer) from public, anon, authenticated;

create or replace function _api_limit(p_limit integer, p_default integer, p_max integer)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select least(greatest(coalesce(p_limit, p_default), 1), p_max);
$$;
revoke all on function _api_limit(integer, integer, integer) from public, anon, authenticated;

-- Auditoría de un lote de la API (una fila por pedido; las filas tocadas ya
-- quedan por los triggers de cada tabla).
create or replace function _api_audit(p_tenant uuid, p_client uuid, p_action text, p_data jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (p_tenant, null, 'api_client', p_client, p_action, null, p_data);
$$;
revoke all on function _api_audit(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- =============================================================================
-- PRODUCTOS
-- =============================================================================
create or replace function _api_v1_products_list(
  p_tenant uuid, p_limit integer, p_after_updated timestamptz, p_after_id uuid,
  p_updated_since timestamptz, p_sku text, p_include_deleted boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := _api_limit(p_limit, 100, 500);
  v_rows  jsonb;
  v_n     integer;
  v_last  jsonb;
begin
  if (p_after_updated is null) <> (p_after_id is null) then
    perform _api_fail(400, 'invalid_cursor', 'Cursor inválido.');
  end if;
  select coalesce(jsonb_agg(_api_product_json(x) order by x.updated_at, x.id), '[]'::jsonb)
    into v_rows
    from (select p.* from products p
           where p.tenant_id = p_tenant
             and (coalesce(p_include_deleted, false) or p.deleted_at is null)
             and (p_updated_since is null or p.updated_at >= p_updated_since)
             and (p_sku is null or p.sku = p_sku)
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
revoke all on function _api_v1_products_list(uuid, integer, timestamptz, uuid, timestamptz, text, boolean)
  from public, anon, authenticated;

create or replace function api_v1_products_list(
  p_token text, p_limit integer default null, p_after_updated timestamptz default null,
  p_after_id uuid default null, p_updated_since timestamptz default null, p_sku text default null,
  p_include_deleted boolean default false)
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
                                   p_updated_since, p_sku, p_include_deleted);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_products_list(text, integer, timestamptz, uuid, timestamptz, text, boolean)
  from public, authenticated;
grant execute on function api_v1_products_list(text, integer, timestamptz, uuid, timestamptz, text, boolean) to anon;

-- Upsert por SKU: hasta 500 por pedido. Un ítem con un campo ausente no lo
-- toca (en un alta toma el default). Resultado por ítem:
-- created | updated | unchanged | error (sku duplicado en otro producto por
-- código de barras, nombre faltante en un alta).
create or replace function _api_v1_products_upsert(p_tenant uuid, p_client uuid, p_items jsonb, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n       integer := _api_assert_batch(p_items, 500);
  v_replay  jsonb;
  v_plan    jsonb;
  v_upd     jsonb;
  v_ins     jsonb;
  v_results jsonb;
  v_counts  jsonb;
  v_env     jsonb;
  v_bad     jsonb;
begin
  v_replay := _api_idem_begin(p_tenant, p_client, p_key, 'products.upsert', _api_sha256(p_items::text));
  if v_replay is not null then return v_replay; end if;

  -- Validación del lote (Zod ya lo hizo en la ruta; acá es la barrera real).
  select jsonb_agg(jsonb_build_object('index', o - 1, 'message', m) order by o) into v_bad
    from (
      select o,
             case
               when nullif(btrim(e ->> 'sku'), '') is null or char_length(btrim(e ->> 'sku')) > 64 then 'sku: de 1 a 64 caracteres'
               when e ? 'name' and (nullif(btrim(e ->> 'name'), '') is null or char_length(e ->> 'name') > 200) then 'name: de 1 a 200 caracteres'
               when e ? 'barcode' and char_length(coalesce(e ->> 'barcode', '')) > 64 then 'barcode: hasta 64 caracteres'
               when e ? 'price' and (jsonb_typeof(e -> 'price') <> 'number' or (e ->> 'price')::numeric < 0
                                     or (e ->> 'price')::numeric >= 10000000000) then 'price: número mayor o igual a 0'
               when e ? 'cost' and jsonb_typeof(e -> 'cost') <> 'null' and (jsonb_typeof(e -> 'cost') <> 'number'
                                     or (e ->> 'cost')::numeric < 0 or (e ->> 'cost')::numeric >= 10000000000) then 'cost: número mayor o igual a 0'
               when e ? 'stock_min' and jsonb_typeof(e -> 'stock_min') <> 'null' and (jsonb_typeof(e -> 'stock_min') <> 'number'
                                     or (e ->> 'stock_min')::numeric < 0) then 'stock_min: número mayor o igual a 0'
               when e ? 'unit' and (nullif(btrim(e ->> 'unit'), '') is null or char_length(e ->> 'unit') > 10) then 'unit: de 1 a 10 caracteres'
               when e ? 'is_active' and jsonb_typeof(e -> 'is_active') <> 'boolean' then 'is_active: booleano'
               when e ? 'track_stock' and jsonb_typeof(e -> 'track_stock') <> 'boolean' then 'track_stock: booleano'
               when e ? 'description' and jsonb_typeof(e -> 'description') not in ('string', 'null') then 'description: texto'
               when e ? 'description' and char_length(coalesce(e ->> 'description', '')) > 2000 then 'description: hasta 2000 caracteres'
             end as m
        from jsonb_array_elements(p_items) with ordinality t(e, o)
    ) v
   where m is not null;
  if v_bad is not null then
    perform _api_fail(422, 'validation_error', 'Hay ítems inválidos.', v_bad);
  end if;
  if (select count(distinct btrim(e ->> 'sku')) from jsonb_array_elements(p_items) e) <> v_n then
    perform _api_fail(422, 'validation_error', 'Hay SKU repetidos en el lote.');
  end if;
  if exists (select nullif(btrim(e ->> 'barcode'), '') b from jsonb_array_elements(p_items) e
              where nullif(btrim(e ->> 'barcode'), '') is not null
              group by 1 having count(*) > 1) then
    perform _api_fail(422, 'validation_error', 'Hay códigos de barras repetidos en el lote.');
  end if;

  perform set_config('ninja.price_source', 'import', true);

  -- Plan por ítem.
  select jsonb_agg(jsonb_build_object(
           'idx', s.o - 1, 'sku', s.sku, 'e', s.e, 'product_id', s.pid,
           'action', case
                       when s.bc_taken then 'error'
                       when s.pid is null and nullif(btrim(s.e ->> 'name'), '') is null then 'error'
                       when s.pid is null then 'create'
                       else 'update'
                     end,
           'error', case
                      when s.bc_taken then 'barcode_in_use'
                      when s.pid is null and nullif(btrim(s.e ->> 'name'), '') is null then 'name_required'
                    end) order by s.o)
    into v_plan
    from (
      select t.o, t.e, btrim(t.e ->> 'sku') as sku,
             (select p.id from products p
               where p.tenant_id = p_tenant and p.sku = btrim(t.e ->> 'sku') and p.deleted_at is null) as pid,
             (nullif(btrim(t.e ->> 'barcode'), '') is not null and exists (
                select 1 from products q
                 where q.tenant_id = p_tenant and q.deleted_at is null
                   and q.barcode = btrim(t.e ->> 'barcode')
                   and q.sku is distinct from btrim(t.e ->> 'sku'))) as bc_taken
        from jsonb_array_elements(p_items) with ordinality t(e, o)
    ) s;

  -- Ediciones (sólo si algo cambia: un no-op no mueve updated_at).
  with src as (
    select s.idx, s.product_id, s.e
      from jsonb_to_recordset(v_plan) as s(idx integer, sku text, e jsonb, product_id uuid, action text, error text)
     where s.action = 'update'
  ),
  nv as (
    select src.idx, p.id,
           case when src.e ? 'name' then btrim(src.e ->> 'name') else p.name end as name,
           case when src.e ? 'barcode' then nullif(btrim(src.e ->> 'barcode'), '') else p.barcode end as barcode,
           case when src.e ? 'description' then src.e ->> 'description' else p.description end as description,
           case when src.e ? 'price' then (src.e ->> 'price')::numeric else p.price end as price,
           case when src.e ? 'cost' then (src.e ->> 'cost')::numeric else p.cost end as cost,
           case when src.e ? 'unit' then btrim(src.e ->> 'unit') else p.unit end as unit,
           case when src.e ? 'is_active' then (src.e ->> 'is_active')::boolean else p.is_active end as is_active,
           case when src.e ? 'track_stock' then (src.e ->> 'track_stock')::boolean else p.track_stock end as track_stock,
           case when src.e ? 'stock_min' then (src.e ->> 'stock_min')::numeric else p.stock_min end as stock_min
      from src
      join products p on p.id = src.product_id and p.tenant_id = p_tenant
  ),
  upd as (
    update products p
       set name = nv.name, barcode = nv.barcode, description = nv.description, price = nv.price,
           cost = nv.cost, unit = nv.unit, is_active = nv.is_active, track_stock = nv.track_stock,
           stock_min = nv.stock_min, updated_by = null, updated_at = now()
      from nv
     where p.id = nv.id and p.tenant_id = p_tenant
       and (p.name, p.barcode, p.description, p.price, p.cost, p.unit, p.is_active, p.track_stock, p.stock_min)
           is distinct from
           (nv.name, nv.barcode, nv.description, nv.price, nv.cost, nv.unit, nv.is_active, nv.track_stock, nv.stock_min)
    returning p.id
  )
  select coalesce(jsonb_agg(to_jsonb(upd.id)), '[]'::jsonb) into v_upd from upd;

  -- Altas.
  with src as (
    select s.idx, s.sku, s.e
      from jsonb_to_recordset(v_plan) as s(idx integer, sku text, e jsonb, product_id uuid, action text, error text)
     where s.action = 'create'
  ),
  ins as (
    insert into products (tenant_id, sku, name, barcode, description, price, cost, unit, is_active,
                          track_stock, stock_min)
    select p_tenant, src.sku, btrim(src.e ->> 'name'), nullif(btrim(src.e ->> 'barcode'), ''),
           src.e ->> 'description', coalesce((src.e ->> 'price')::numeric, 0), (src.e ->> 'cost')::numeric,
           coalesce(nullif(btrim(src.e ->> 'unit'), ''), 'un'), coalesce((src.e ->> 'is_active')::boolean, true),
           coalesce((src.e ->> 'track_stock')::boolean, true), coalesce((src.e ->> 'stock_min')::numeric, 0)
      from src
    returning id, sku
  )
  select coalesce(jsonb_object_agg(ins.sku, ins.id), '{}'::jsonb) into v_ins from ins;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'index', s.idx, 'sku', s.sku,
           'id', case when s.action = 'create' then v_ins ->> s.sku else s.product_id::text end,
           'status', case
                       when s.action = 'error' then 'error'
                       when s.action = 'create' then 'created'
                       when v_upd @> to_jsonb(s.product_id::text) then 'updated'
                       else 'unchanged'
                     end,
           'error', s.error)) order by s.idx)
    into v_results
    from jsonb_to_recordset(v_plan) as s(idx integer, sku text, e jsonb, product_id uuid, action text, error text);

  select jsonb_build_object(
           'created', count(*) filter (where r ->> 'status' = 'created'),
           'updated', count(*) filter (where r ->> 'status' = 'updated'),
           'unchanged', count(*) filter (where r ->> 'status' = 'unchanged'),
           'failed', count(*) filter (where r ->> 'status' = 'error'))
    into v_counts
    from jsonb_array_elements(v_results) r;

  perform _api_audit(p_tenant, p_client, 'api_products_upserted',
                     v_counts || jsonb_build_object('idempotency_key', p_key));
  v_env := jsonb_build_object('status', 200, 'body', jsonb_build_object('summary', v_counts, 'results', v_results));
  return _api_idem_finish(p_tenant, p_client, p_key, v_env);
end;
$$;
revoke all on function _api_v1_products_upsert(uuid, uuid, jsonb, text) from public, anon, authenticated;

create or replace function api_v1_products_upsert(p_token text, p_items jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'products:write');
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_products_upsert((v_auth ->> 'tenant_id')::uuid, (v_auth ->> 'client_id')::uuid,
                                     p_items, p_idempotency_key);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_products_upsert(text, jsonb, text) from public, authenticated;
grant execute on function api_v1_products_upsert(text, jsonb, text) to anon;

-- =============================================================================
-- PRECIOS (lote por SKU; costo opcional)
-- =============================================================================
create or replace function _api_v1_prices_update(p_tenant uuid, p_client uuid, p_items jsonb, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n       integer := _api_assert_batch(p_items, 500);
  v_replay  jsonb;
  v_bad     jsonb;
  v_upd     jsonb;
  v_results jsonb;
  v_counts  jsonb;
  v_env     jsonb;
begin
  v_replay := _api_idem_begin(p_tenant, p_client, p_key, 'prices.update', _api_sha256(p_items::text));
  if v_replay is not null then return v_replay; end if;

  select jsonb_agg(jsonb_build_object('index', o - 1, 'message', m) order by o) into v_bad
    from (
      select o,
             case
               when nullif(btrim(e ->> 'sku'), '') is null or char_length(btrim(e ->> 'sku')) > 64 then 'sku: de 1 a 64 caracteres'
               when jsonb_typeof(e -> 'price') is distinct from 'number' or (e ->> 'price')::numeric < 0
                    or (e ->> 'price')::numeric >= 10000000000 then 'price: número mayor o igual a 0'
               when e ? 'cost' and jsonb_typeof(e -> 'cost') <> 'null' and (jsonb_typeof(e -> 'cost') <> 'number'
                    or (e ->> 'cost')::numeric < 0 or (e ->> 'cost')::numeric >= 10000000000) then 'cost: número mayor o igual a 0'
             end as m
        from jsonb_array_elements(p_items) with ordinality t(e, o)
    ) v
   where m is not null;
  if v_bad is not null then
    perform _api_fail(422, 'validation_error', 'Hay ítems inválidos.', v_bad);
  end if;
  if (select count(distinct btrim(e ->> 'sku')) from jsonb_array_elements(p_items) e) <> v_n then
    perform _api_fail(422, 'validation_error', 'Hay SKU repetidos en el lote.');
  end if;

  perform set_config('ninja.price_source', 'import', true);

  with src as (
    select t.o - 1 as idx, btrim(t.e ->> 'sku') as sku, t.e
      from jsonb_array_elements(p_items) with ordinality t(e, o)
  ),
  nv as (
    select src.idx, p.id, (src.e ->> 'price')::numeric as price,
           case when src.e ? 'cost' then (src.e ->> 'cost')::numeric else p.cost end as cost
      from src
      join products p on p.tenant_id = p_tenant and p.sku = src.sku and p.deleted_at is null
  ),
  upd as (
    update products p
       set price = nv.price, cost = nv.cost, updated_by = null, updated_at = now()
      from nv
     where p.id = nv.id and p.tenant_id = p_tenant
       and (p.price, p.cost) is distinct from (nv.price, nv.cost)
    returning p.id
  )
  select coalesce(jsonb_agg(to_jsonb(upd.id)), '[]'::jsonb) into v_upd from upd;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'index', src.idx, 'sku', src.sku, 'id', p.id,
           'status', case when p.id is null then 'error'
                          when v_upd @> to_jsonb(p.id::text) then 'updated'
                          else 'unchanged' end,
           'error', case when p.id is null then 'product_not_found' end)) order by src.idx)
    into v_results
    from (select t.o - 1 as idx, btrim(t.e ->> 'sku') as sku
            from jsonb_array_elements(p_items) with ordinality t(e, o)) src
    left join products p on p.tenant_id = p_tenant and p.sku = src.sku and p.deleted_at is null;

  select jsonb_build_object(
           'updated', count(*) filter (where r ->> 'status' = 'updated'),
           'unchanged', count(*) filter (where r ->> 'status' = 'unchanged'),
           'failed', count(*) filter (where r ->> 'status' = 'error'))
    into v_counts
    from jsonb_array_elements(v_results) r;

  perform _api_audit(p_tenant, p_client, 'api_prices_updated',
                     v_counts || jsonb_build_object('idempotency_key', p_key));
  v_env := jsonb_build_object('status', 200, 'body', jsonb_build_object('summary', v_counts, 'results', v_results));
  return _api_idem_finish(p_tenant, p_client, p_key, v_env);
end;
$$;
revoke all on function _api_v1_prices_update(uuid, uuid, jsonb, text) from public, anon, authenticated;

create or replace function api_v1_prices_update(p_token text, p_items jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'prices:write');
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_prices_update((v_auth ->> 'tenant_id')::uuid, (v_auth ->> 'client_id')::uuid,
                                   p_items, p_idempotency_key);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_prices_update(text, jsonb, text) from public, authenticated;
grant execute on function api_v1_prices_update(text, jsonb, text) to anon;

-- =============================================================================
-- SUCURSALES Y STOCK
-- =============================================================================
create or replace function _api_v1_stores_list(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('status', 200, 'body', jsonb_build_object('data', coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'is_default', s.is_default,
                                        'is_active', s.is_active) order by s.is_default desc, s.created_at)
      from stores s
     where s.tenant_id = p_tenant and s.deleted_at is null), '[]'::jsonb)));
$$;
revoke all on function _api_v1_stores_list(uuid) from public, anon, authenticated;

create or replace function api_v1_stores_list(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'stock:read');
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  return _api_v1_stores_list((v_auth ->> 'tenant_id')::uuid) || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_stores_list(text) from public, authenticated;
grant execute on function api_v1_stores_list(text) to anon;

-- Stock por sucursal (productos sin variantes; sin fila = 0 en esa sucursal).
create or replace function _api_v1_stock_list(p_tenant uuid, p_store_id uuid, p_skus text[], p_limit integer,
                                              p_after_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := _api_limit(p_limit, 200, 500);
  v_rows  jsonb;
begin
  if p_store_id is not null and not exists (
       select 1 from stores s where s.id = p_store_id and s.tenant_id = p_tenant and s.deleted_at is null) then
    perform _api_fail(404, 'store_not_found', 'La sucursal no existe.');
  end if;
  if p_skus is not null and cardinality(p_skus) > 500 then
    perform _api_fail(422, 'validation_error', 'sku: hasta 500 por pedido.');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'store_id', x.store_id, 'product_id', x.product_id, 'sku', x.sku,
           'qty', x.qty, 'min_qty', x.min_qty, 'updated_at', x.updated_at) order by x.id), '[]'::jsonb)
    into v_rows
    from (select ps.id, ps.store_id, ps.product_id, p.sku, ps.qty, ps.min_qty, ps.updated_at
            from product_stock ps
            join products p on p.id = ps.product_id and p.tenant_id = p_tenant
           where ps.tenant_id = p_tenant
             and ps.variant_id is null
             and p.deleted_at is null
             and (p_store_id is null or ps.store_id = p_store_id)
             and (p_skus is null or p.sku = any (p_skus))
             and (p_after_id is null or ps.id > p_after_id)
           order by ps.id
           limit v_limit + 1) x;
  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object(
      'data', v_rows, 'next', jsonb_build_object('id', v_rows -> (v_limit - 1) -> 'id')));
  end if;
  return jsonb_build_object('status', 200, 'body', jsonb_build_object('data', v_rows, 'next', null));
end;
$$;
revoke all on function _api_v1_stock_list(uuid, uuid, text[], integer, uuid) from public, anon, authenticated;

create or replace function api_v1_stock_list(p_token text, p_store_id uuid default null, p_skus text[] default null,
                                             p_limit integer default null, p_after_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'stock:read');
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_stock_list((v_auth ->> 'tenant_id')::uuid, p_store_id, p_skus, p_limit, p_after_id);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_stock_list(text, uuid, text[], integer, uuid) from public, authenticated;
grant execute on function api_v1_stock_list(text, uuid, text[], integer, uuid) to anon;

-- Ajuste de stock por sucursal con motivo. Misma regla que adjust_store_stock
-- (ADR-046), con el negocio de la credencial en lugar de la sesión: mueve el
-- consolidado, deja el movimiento (que mueve product_stock por trigger) y
-- audita cada ítem. mode 'set' = conteo (motivo 'count').
create or replace function _api_v1_stock_adjust(p_tenant uuid, p_client uuid, p_items jsonb, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n        integer := _api_assert_batch(p_items, 500);
  v_replay   jsonb;
  v_bad      jsonb;
  v_default  uuid := stock_default_store(p_tenant);
  v_multi    boolean;
  r          record;
  v_prod     record;
  v_store    uuid;
  v_cur      numeric;
  v_delta    numeric;
  v_results  jsonb := '[]'::jsonb;
  v_err      text;
  v_counts   jsonb;
  v_env      jsonb;
begin
  v_replay := _api_idem_begin(p_tenant, p_client, p_key, 'stock.adjust', _api_sha256(p_items::text));
  if v_replay is not null then return v_replay; end if;

  select jsonb_agg(jsonb_build_object('index', o - 1, 'message', m) order by o) into v_bad
    from (
      select o,
             case
               when nullif(btrim(e ->> 'sku'), '') is null or char_length(btrim(e ->> 'sku')) > 64 then 'sku: de 1 a 64 caracteres'
               when coalesce(e ->> 'mode', 'delta') not in ('delta', 'set') then 'mode: delta o set'
               when jsonb_typeof(e -> 'qty') is distinct from 'number' then 'qty: número'
               when coalesce(e ->> 'mode', 'delta') = 'delta' and (e ->> 'qty')::numeric = 0 then 'qty: distinto de 0'
               when coalesce(e ->> 'mode', 'delta') = 'set' and (e ->> 'qty')::numeric < 0 then 'qty: mayor o igual a 0'
               when abs((e ->> 'qty')::numeric) >= 1000000000 then 'qty: fuera de rango'
               when e ->> 'reason' is null or e ->> 'reason' not in ('purchase', 'adjustment', 'loss', 'return', 'count', 'production')
                 then 'reason: purchase, adjustment, loss, return, count o production'
               when e ? 'store_id' and jsonb_typeof(e -> 'store_id') <> 'null'
                    and coalesce(e ->> 'store_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then 'store_id: uuid'
               when char_length(coalesce(e ->> 'notes', '')) > 300 then 'notes: hasta 300 caracteres'
             end as m
        from jsonb_array_elements(p_items) with ordinality t(e, o)
    ) v
   where m is not null;
  if v_bad is not null then
    perform _api_fail(422, 'validation_error', 'Hay ítems inválidos.', v_bad);
  end if;

  v_multi := tenant_has_feature_for(p_tenant, 'multi_sucursal') and tenant_has_feature_for(p_tenant, 'stock_sucursales');

  -- Orden estable por producto y sucursal: dos lotes concurrentes bloquean en
  -- el mismo orden (sin deadlocks).
  for r in
    select t.o - 1 as idx, t.e, btrim(t.e ->> 'sku') as sku,
           coalesce(nullif(t.e ->> 'store_id', '')::uuid, v_default) as store_id
      from jsonb_array_elements(p_items) with ordinality t(e, o)
     order by btrim(t.e ->> 'sku'), 4, t.o
  loop
    v_err := null;
    v_store := r.store_id;
    select p.id, p.has_variants into v_prod
      from products p
     where p.tenant_id = p_tenant and p.sku = r.sku and p.deleted_at is null;
    if v_prod.id is null then
      v_err := 'product_not_found';
    elsif coalesce(v_prod.has_variants, false) then
      v_err := 'variants_not_supported';
    elsif v_store is null or not exists (select 1 from stores s where s.id = v_store and s.tenant_id = p_tenant
                                                                  and s.deleted_at is null) then
      v_err := 'store_not_found';
    elsif v_store is distinct from v_default and not v_multi then
      v_err := 'feature_not_in_plan';
    end if;

    if v_err is not null then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', r.idx, 'sku', r.sku, 'status', 'error', 'error', v_err));
      continue;
    end if;

    select ps.qty into v_cur
      from product_stock ps
     where ps.store_id = v_store and ps.product_id = v_prod.id and ps.variant_id is null
       and ps.tenant_id = p_tenant
     for update;
    v_cur := coalesce(v_cur, 0);
    v_delta := case when coalesce(r.e ->> 'mode', 'delta') = 'set'
                    then (r.e ->> 'qty')::numeric - v_cur
                    else (r.e ->> 'qty')::numeric end;
    if v_delta = 0 then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', r.idx, 'sku', r.sku, 'id', v_prod.id, 'store_id', v_store, 'status', 'unchanged', 'qty', v_cur));
      continue;
    end if;

    update products p set stock = p.stock + v_delta, updated_by = null, updated_at = now()
     where p.id = v_prod.id and p.tenant_id = p_tenant;

    insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, notes, created_by)
    values (p_tenant, v_prod.id, null, v_store, v_delta,
            case when coalesce(r.e ->> 'mode', 'delta') = 'set' then 'count' else r.e ->> 'reason' end,
            nullif(btrim(coalesce(r.e ->> 'notes', '')), ''), null);

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
    values (p_tenant, null, 'product_stock', v_prod.id,
            case when coalesce(r.e ->> 'mode', 'delta') = 'set' then 'stock_count' else 'stock_adjust' end,
            jsonb_build_object('store_id', v_store, 'variant_id', null, 'qty', v_cur),
            jsonb_build_object('store_id', v_store, 'variant_id', null, 'qty', v_cur + v_delta,
                               'delta', v_delta, 'reason', r.e ->> 'reason', 'api_client_id', p_client),
            nullif(btrim(coalesce(r.e ->> 'notes', '')), ''));

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'index', r.idx, 'sku', r.sku, 'id', v_prod.id, 'store_id', v_store, 'status', 'adjusted',
      'qty', v_cur + v_delta, 'delta', v_delta));
  end loop;

  select coalesce(jsonb_agg(x order by (x ->> 'index')::integer), '[]'::jsonb) into v_results
    from jsonb_array_elements(v_results) x;
  select jsonb_build_object(
           'adjusted', count(*) filter (where r2 ->> 'status' = 'adjusted'),
           'unchanged', count(*) filter (where r2 ->> 'status' = 'unchanged'),
           'failed', count(*) filter (where r2 ->> 'status' = 'error'))
    into v_counts
    from jsonb_array_elements(v_results) r2;

  perform _api_audit(p_tenant, p_client, 'api_stock_adjusted',
                     v_counts || jsonb_build_object('idempotency_key', p_key));
  v_env := jsonb_build_object('status', 200, 'body', jsonb_build_object('summary', v_counts, 'results', v_results));
  return _api_idem_finish(p_tenant, p_client, p_key, v_env);
end;
$$;
revoke all on function _api_v1_stock_adjust(uuid, uuid, jsonb, text) from public, anon, authenticated;

create or replace function api_v1_stock_adjust(p_token text, p_items jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'stock:write');
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_stock_adjust((v_auth ->> 'tenant_id')::uuid, (v_auth ->> 'client_id')::uuid,
                                  p_items, p_idempotency_key);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_stock_adjust(text, jsonb, text) from public, authenticated;
grant execute on function api_v1_stock_adjust(text, jsonb, text) to anon;

-- =============================================================================
-- VENTAS (sólo lectura, por rango de hasta 93 días)
-- =============================================================================
create or replace function _api_v1_sales_list(p_tenant uuid, p_from timestamptz, p_to timestamptz, p_store_id uuid,
                                              p_limit integer, p_after_created timestamptz, p_after_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := _api_limit(p_limit, 50, 200);
  v_rows  jsonb;
  v_last  jsonb;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    perform _api_fail(422, 'validation_error', 'from y to son obligatorios y to tiene que ser posterior a from.');
  end if;
  if p_to - p_from > interval '93 days' then
    perform _api_fail(422, 'validation_error', 'El rango no puede superar 93 días.');
  end if;
  if (p_after_created is null) <> (p_after_id is null) then
    perform _api_fail(400, 'invalid_cursor', 'Cursor inválido.');
  end if;
  if p_store_id is not null and not exists (
       select 1 from stores s where s.id = p_store_id and s.tenant_id = p_tenant) then
    perform _api_fail(404, 'store_not_found', 'La sucursal no existe.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'number', s.number, 'status', s.status, 'store_id', s.store_id,
           'customer_id', s.customer_id, 'subtotal', s.subtotal, 'discount_total', s.discount_total,
           'tax_total', s.tax_total, 'total', s.total, 'created_at', s.created_at, 'voided_at', s.voided_at,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'product_id', si.product_id, 'variant_id', si.variant_id, 'sku', si.sku,
                      'name', si.product_name, 'quantity', si.quantity, 'unit_price', si.unit_price,
                      'discount', si.discount, 'subtotal', si.subtotal, 'returned_qty', si.returned_qty)
                    order by si.created_at, si.id)
               from sale_items si where si.sale_id = s.id and si.tenant_id = p_tenant), '[]'::jsonb),
           'payments', coalesce((
             select jsonb_agg(jsonb_build_object('method', pm.method, 'amount', pm.amount,
                                                 'reference', pm.reference) order by pm.created_at, pm.id)
               from payments pm where pm.sale_id = s.id and pm.tenant_id = p_tenant), '[]'::jsonb))
         order by s.created_at, s.id), '[]'::jsonb)
    into v_rows
    from (select x.* from sales x
           where x.tenant_id = p_tenant
             and x.created_at >= p_from and x.created_at < p_to
             and x.status <> 'suspended'
             and (p_store_id is null or x.store_id = p_store_id)
             and (p_after_created is null or (x.created_at, x.id) > (p_after_created, p_after_id))
           order by x.created_at, x.id
           limit v_limit + 1) s;

  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
    return jsonb_build_object('status', 200, 'body', jsonb_build_object(
      'data', v_rows, 'next', jsonb_build_object('created_at', v_last -> 'created_at', 'id', v_last -> 'id')));
  end if;
  return jsonb_build_object('status', 200, 'body', jsonb_build_object('data', v_rows, 'next', null));
end;
$$;
revoke all on function _api_v1_sales_list(uuid, timestamptz, timestamptz, uuid, integer, timestamptz, uuid)
  from public, anon, authenticated;

create or replace function api_v1_sales_list(p_token text, p_from timestamptz, p_to timestamptz,
                                             p_store_id uuid default null, p_limit integer default null,
                                             p_after_created timestamptz default null, p_after_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'sales:read');
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_sales_list((v_auth ->> 'tenant_id')::uuid, p_from, p_to, p_store_id, p_limit,
                                p_after_created, p_after_id);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_sales_list(text, timestamptz, timestamptz, uuid, integer, timestamptz, uuid)
  from public, authenticated;
grant execute on function api_v1_sales_list(text, timestamptz, timestamptz, uuid, integer, timestamptz, uuid) to anon;

-- =============================================================================
-- CLIENTES
-- =============================================================================
create or replace function _api_v1_customers_list(p_tenant uuid, p_limit integer, p_after_updated timestamptz,
                                                  p_after_id uuid, p_updated_since timestamptz,
                                                  p_external_id text, p_include_deleted boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := _api_limit(p_limit, 100, 500);
  v_rows  jsonb;
  v_last  jsonb;
begin
  if (p_after_updated is null) <> (p_after_id is null) then
    perform _api_fail(400, 'invalid_cursor', 'Cursor inválido.');
  end if;
  select coalesce(jsonb_agg(_api_customer_json(x) order by x.updated_at, x.id), '[]'::jsonb)
    into v_rows
    from (select c.* from customers c
           where c.tenant_id = p_tenant
             and (coalesce(p_include_deleted, false) or c.deleted_at is null)
             and (p_updated_since is null or c.updated_at >= p_updated_since)
             and (p_external_id is null or c.external_id = p_external_id)
             and (p_after_updated is null or (c.updated_at, c.id) > (p_after_updated, p_after_id))
           order by c.updated_at, c.id
           limit v_limit + 1) x;
  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
    return jsonb_build_object('status', 200, 'body', jsonb_build_object(
      'data', v_rows, 'next', jsonb_build_object('updated_at', v_last -> 'updated_at', 'id', v_last -> 'id')));
  end if;
  return jsonb_build_object('status', 200, 'body', jsonb_build_object('data', v_rows, 'next', null));
end;
$$;
revoke all on function _api_v1_customers_list(uuid, integer, timestamptz, uuid, timestamptz, text, boolean)
  from public, anon, authenticated;

create or replace function api_v1_customers_list(
  p_token text, p_limit integer default null, p_after_updated timestamptz default null,
  p_after_id uuid default null, p_updated_since timestamptz default null, p_external_id text default null,
  p_include_deleted boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'customers:read');
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_customers_list((v_auth ->> 'tenant_id')::uuid, p_limit, p_after_updated, p_after_id,
                                    p_updated_since, p_external_id, p_include_deleted);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_customers_list(text, integer, timestamptz, uuid, timestamptz, text, boolean)
  from public, authenticated;
grant execute on function api_v1_customers_list(text, integer, timestamptz, uuid, timestamptz, text, boolean) to anon;

-- Upsert de clientes: cada ítem trae `id` (cliente existente del negocio) o
-- `external_id` (clave del sistema externo, única por negocio). No toca
-- cuenta corriente (límite, condiciones, cobrador): eso sigue en el panel.
create or replace function _api_v1_customers_upsert(p_tenant uuid, p_client uuid, p_items jsonb, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n       integer := _api_assert_batch(p_items, 500);
  v_replay  jsonb;
  v_bad     jsonb;
  v_plan    jsonb;
  v_upd     jsonb;
  v_ins     jsonb;
  v_results jsonb;
  v_counts  jsonb;
  v_env     jsonb;
  v_uuid    constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  v_replay := _api_idem_begin(p_tenant, p_client, p_key, 'customers.upsert', _api_sha256(p_items::text));
  if v_replay is not null then return v_replay; end if;

  select jsonb_agg(jsonb_build_object('index', o - 1, 'message', m) order by o) into v_bad
    from (
      select o,
             case
               when nullif(btrim(coalesce(e ->> 'id', '')), '') is null
                    and nullif(btrim(coalesce(e ->> 'external_id', '')), '') is null then 'id o external_id: obligatorio'
               when e ? 'id' and jsonb_typeof(e -> 'id') <> 'null' and coalesce(e ->> 'id', '') !~* v_uuid then 'id: uuid'
               when char_length(coalesce(e ->> 'external_id', '')) > 100 then 'external_id: hasta 100 caracteres'
               when e ? 'name' and (nullif(btrim(e ->> 'name'), '') is null or char_length(e ->> 'name') > 200) then 'name: de 1 a 200 caracteres'
               when char_length(coalesce(e ->> 'email', '')) > 200 then 'email: hasta 200 caracteres'
               when char_length(coalesce(e ->> 'phone', '')) > 50 then 'phone: hasta 50 caracteres'
               when char_length(coalesce(e ->> 'address', '')) > 300 then 'address: hasta 300 caracteres'
               when char_length(coalesce(e ->> 'notes', '')) > 1000 then 'notes: hasta 1000 caracteres'
               when e ? 'is_active' and jsonb_typeof(e -> 'is_active') <> 'boolean' then 'is_active: booleano'
               when e ->> 'document_type' is not null and e ->> 'document_type' not in ('cuit', 'dni', 'cuil', 'passport', 'other')
                 then 'document_type: cuit, dni, cuil, passport u other'
               when e ->> 'iva_condition' is not null and e ->> 'iva_condition' not in
                    ('consumidor_final', 'responsable_inscripto', 'monotributo', 'monotributo_social', 'exento',
                     'no_responsable', 'no_categorizado', 'no_alcanzado', 'iva_liberado', 'exterior')
                 then 'iva_condition: valor no admitido'
               when nullif(btrim(coalesce(e ->> 'document_number', '')), '') is not null
                    and e ->> 'document_type' in ('cuit', 'cuil')
                    and not (length(regexp_replace(e ->> 'document_number', '\D', '', 'g')) = 11
                             and cuit_is_valid(regexp_replace(e ->> 'document_number', '\D', '', 'g')))
                 then 'document_number: CUIT/CUIL inválido'
               when nullif(btrim(coalesce(e ->> 'document_number', '')), '') is not null
                    and e ->> 'document_type' = 'dni'
                    and regexp_replace(e ->> 'document_number', '\D', '', 'g') !~ '^\d{7,8}$'
                 then 'document_number: DNI inválido'
             end as m
        from jsonb_array_elements(p_items) with ordinality t(e, o)
    ) v
   where m is not null;
  if v_bad is not null then
    perform _api_fail(422, 'validation_error', 'Hay ítems inválidos.', v_bad);
  end if;
  if exists (select nullif(btrim(e ->> 'external_id'), '') from jsonb_array_elements(p_items) e
              where nullif(btrim(e ->> 'external_id'), '') is not null group by 1 having count(*) > 1)
     or exists (select lower(e ->> 'id') from jsonb_array_elements(p_items) e
                 where nullif(e ->> 'id', '') is not null group by 1 having count(*) > 1) then
    perform _api_fail(422, 'validation_error', 'Hay clientes repetidos en el lote.');
  end if;

  -- Plan: por id (del negocio) o por external_id.
  select jsonb_agg(jsonb_build_object(
           'idx', s.o - 1, 'ext', s.ext, 'e', s.e, 'customer_id', coalesce(s.by_id, s.by_ext),
           'action', case
                       when s.has_id and s.by_id is null then 'error'
                       when s.has_id and s.ext is not null and s.by_ext is not null and s.by_ext <> s.by_id then 'error'
                       when coalesce(s.by_id, s.by_ext) is null and nullif(btrim(s.e ->> 'name'), '') is null then 'error'
                       when coalesce(s.by_id, s.by_ext) is null then 'create'
                       else 'update'
                     end,
           'error', case
                      when s.has_id and s.by_id is null then 'customer_not_found'
                      when s.has_id and s.ext is not null and s.by_ext is not null and s.by_ext <> s.by_id then 'external_id_in_use'
                      when coalesce(s.by_id, s.by_ext) is null and nullif(btrim(s.e ->> 'name'), '') is null then 'name_required'
                    end) order by s.o)
    into v_plan
    from (
      select t.o, t.e, nullif(btrim(t.e ->> 'external_id'), '') as ext,
             nullif(t.e ->> 'id', '') is not null as has_id,
             (select c.id from customers c
               where c.tenant_id = p_tenant and c.deleted_at is null
                 and c.id = nullif(t.e ->> 'id', '')::uuid) as by_id,
             (select c.id from customers c
               where c.tenant_id = p_tenant and c.deleted_at is null
                 and c.external_id = nullif(btrim(t.e ->> 'external_id'), '')) as by_ext
        from jsonb_array_elements(p_items) with ordinality t(e, o)
    ) s;

  with src as (
    select s.customer_id, s.ext, s.e
      from jsonb_to_recordset(v_plan) as s(idx integer, ext text, e jsonb, customer_id uuid, action text, error text)
     where s.action = 'update'
  ),
  nv as (
    select c.id,
           coalesce(src.ext, c.external_id) as external_id,
           case when src.e ? 'name' then btrim(src.e ->> 'name') else c.name end as name,
           case when src.e ? 'email' then nullif(btrim(src.e ->> 'email'), '') else c.email end as email,
           case when src.e ? 'phone' then nullif(btrim(src.e ->> 'phone'), '') else c.phone end as phone,
           case when src.e ? 'document_type' then src.e ->> 'document_type' else c.document_type end as document_type,
           case when src.e ? 'document_number' then nullif(btrim(src.e ->> 'document_number'), '') else c.document_number end as document_number,
           case when src.e ? 'address' then nullif(btrim(src.e ->> 'address'), '') else c.address end as address,
           case when src.e ? 'iva_condition' then src.e ->> 'iva_condition' else c.iva_condition end as iva_condition,
           case when src.e ? 'notes' then src.e ->> 'notes' else c.notes end as notes,
           case when src.e ? 'is_active' then (src.e ->> 'is_active')::boolean else c.is_active end as is_active
      from src
      join customers c on c.id = src.customer_id and c.tenant_id = p_tenant
  ),
  upd as (
    update customers c
       set external_id = nv.external_id, name = nv.name, email = nv.email, phone = nv.phone,
           document_type = nv.document_type, document_number = nv.document_number, address = nv.address,
           iva_condition = nv.iva_condition, notes = nv.notes, is_active = nv.is_active, updated_at = now()
      from nv
     where c.id = nv.id and c.tenant_id = p_tenant
       and (c.external_id, c.name, c.email, c.phone, c.document_type, c.document_number, c.address,
            c.iva_condition, c.notes, c.is_active)
           is distinct from
           (nv.external_id, nv.name, nv.email, nv.phone, nv.document_type, nv.document_number, nv.address,
            nv.iva_condition, nv.notes, nv.is_active)
    returning c.id
  )
  select coalesce(jsonb_agg(to_jsonb(upd.id)), '[]'::jsonb) into v_upd from upd;

  with src as (
    select s.ext, s.e
      from jsonb_to_recordset(v_plan) as s(idx integer, ext text, e jsonb, customer_id uuid, action text, error text)
     where s.action = 'create'
  ),
  ins as (
    insert into customers (tenant_id, external_id, name, email, phone, document_type, document_number,
                           address, iva_condition, notes, is_active)
    select p_tenant, src.ext, btrim(src.e ->> 'name'), nullif(btrim(src.e ->> 'email'), ''),
           nullif(btrim(src.e ->> 'phone'), ''), src.e ->> 'document_type',
           nullif(btrim(src.e ->> 'document_number'), ''), nullif(btrim(src.e ->> 'address'), ''),
           src.e ->> 'iva_condition', src.e ->> 'notes', coalesce((src.e ->> 'is_active')::boolean, true)
      from src
    returning id, external_id
  )
  select coalesce(jsonb_object_agg(ins.external_id, ins.id), '{}'::jsonb) into v_ins from ins;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'index', s.idx, 'external_id', s.ext,
           'id', case when s.action = 'create' then v_ins ->> s.ext else s.customer_id::text end,
           'status', case
                       when s.action = 'error' then 'error'
                       when s.action = 'create' then 'created'
                       when v_upd @> to_jsonb(s.customer_id::text) then 'updated'
                       else 'unchanged'
                     end,
           'error', s.error)) order by s.idx)
    into v_results
    from jsonb_to_recordset(v_plan) as s(idx integer, ext text, e jsonb, customer_id uuid, action text, error text);

  select jsonb_build_object(
           'created', count(*) filter (where r ->> 'status' = 'created'),
           'updated', count(*) filter (where r ->> 'status' = 'updated'),
           'unchanged', count(*) filter (where r ->> 'status' = 'unchanged'),
           'failed', count(*) filter (where r ->> 'status' = 'error'))
    into v_counts
    from jsonb_array_elements(v_results) r;

  perform _api_audit(p_tenant, p_client, 'api_customers_upserted',
                     v_counts || jsonb_build_object('idempotency_key', p_key));
  v_env := jsonb_build_object('status', 200, 'body', jsonb_build_object('summary', v_counts, 'results', v_results));
  return _api_idem_finish(p_tenant, p_client, p_key, v_env);
end;
$$;
revoke all on function _api_v1_customers_upsert(uuid, uuid, jsonb, text) from public, anon, authenticated;

create or replace function api_v1_customers_upsert(p_token text, p_items jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth jsonb := _api_auth(p_token, 'customers:write');
  v_out  jsonb;
  v_st text; v_msg text; v_det text;
begin
  if not (v_auth ->> 'ok')::boolean then return v_auth - 'ok'; end if;
  begin
    v_out := _api_v1_customers_upsert((v_auth ->> 'tenant_id')::uuid, (v_auth ->> 'client_id')::uuid,
                                      p_items, p_idempotency_key);
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text, v_det = pg_exception_detail;
    v_out := _api_from_exception(v_st, v_msg, v_det);
  end;
  return v_out || jsonb_build_object('rate', v_auth -> 'rate');
end;
$$;
revoke all on function api_v1_customers_upsert(text, jsonb, text) from public, authenticated;
grant execute on function api_v1_customers_upsert(text, jsonb, text) to anon;
