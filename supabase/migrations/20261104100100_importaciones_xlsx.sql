-- =============================================================================
-- 20261104100100_importaciones_xlsx  (TX-4 · H34, ADR-078)
--
-- Importaciones masivas desde XLSX con revisión en el servidor. El navegador
-- lee el archivo, mapea columnas y valida cada fila (Zod); acá se decide qué
-- pasa con cada fila (crear, actualizar, omitir o error) contra los datos
-- reales del negocio y, sólo si el usuario confirma, se escribe.
--
-- Una RPC por entidad, todas con la misma firma:
--   import_<entidad>(p_rows jsonb, p_apply boolean default false,
--                    p_file_name text default null) returns jsonb
--   • p_rows: array de objetos (máx. 1000 por llamada; la UI manda lotes de
--     250). Cada fila trae `_row` (número de fila en el archivo) y sus campos
--     ya normalizados.
--   • p_apply = false (default) → DRY-RUN: corre exactamente la misma lógica
--     (triggers, límites de plan y constraints incluidos) dentro de un bloque
--     que se revierte al final con una excepción propia (SQLSTATE NJDRY). Nada
--     queda escrito; el resultado es una predicción fiel de la aplicación.
--   • p_apply = true → aplica y deja UNA entrada en audit_logs por llamada
--     (entity_type = entidad, action = 'imported', conteos y nombre de archivo).
--   • Devuelve { applied, created, updated, skipped, errors,
--                rows: [{ row, action: create|update|skip|error, message }] }.
--   Cada fila corre en su propio subbloque: un error en una fila (constraint,
--   límite de plan, feature) se informa en esa fila y no frena las demás.
--
-- Guardas (en todas): negocio activo en el JWT, rol owner o manager (el cajero
-- nunca importa, docs/06-permissions-roles.md), feature `importacion_excel`
-- (OPTIONAL, desde Pro) y la feature de la entidad cuando está gateada:
--   productos → productos · clientes → clientes · stock → stock ·
--   garantías → garantias · motivos → devoluciones ·
--   listas de precios → listas_precios por fila (el precio base no la pide) ·
--   sucursales → el trigger enforce_store_rules (multi_sucursal y max_stores) ·
--   stock fuera de la sucursal principal y mínimos/máximos/ubicación →
--   adjust_store_stock / set_store_stock_settings (multi_sucursal y
--   stock_sucursales).
--
-- Entidades y regla de coincidencia (qué fila del archivo actualiza a qué
-- registro existente; si no hay coincidencia se crea):
--   import_products        SKU, si no código de barras. Al actualizar no toca
--                          el stock (eso va por import_stock).
--   import_customers       número de documento (sin puntos ni guiones).
--   import_stock           sucursal (código o nombre; vacío = principal) +
--                          SKU o código de barras del producto o variante.
--                          Cantidad = conteo (deja la sucursal en ese valor).
--   import_price_lists     lista por nombre ("Precio de venta" = precio base)
--                          + SKU o código de barras. Con fecha futura queda
--                          programado (price_schedules).
--   import_stores          código, si no nombre.
--   import_warranty_plans  nombre del plan.
--   import_return_reasons  código, si no nombre.
--
-- Columnas vacías en una actualización = no se tocan.
-- Funciones nuevas (no recrea ninguna existente).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Helpers internos (sin grant a authenticated)
-- -----------------------------------------------------------------------------
create or replace function _import_txt(p_row jsonb, p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(btrim(p_row ->> p_key), '');
$$;
revoke all on function _import_txt(jsonb, text) from public, anon, authenticated;

create or replace function _import_num(p_row jsonb, p_key text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(btrim(p_row ->> p_key), '')::numeric;
$$;
revoke all on function _import_num(jsonb, text) from public, anon, authenticated;

create or replace function _import_bool(p_row jsonb, p_key text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(btrim(p_row ->> p_key), '')::boolean;
$$;
revoke all on function _import_bool(jsonb, text) from public, anon, authenticated;

-- Agrega el resultado de una fila.
create or replace function _import_out(p_out jsonb, p_row int, p_action text, p_message text default null)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_out || jsonb_build_array(jsonb_build_object('row', p_row, 'action', p_action, 'message', p_message));
$$;
revoke all on function _import_out(jsonb, int, text, text) from public, anon, authenticated;

-- Resumen: conteos + filas.
create or replace function _import_summary(p_out jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'created', count(*) filter (where e ->> 'action' = 'create'),
    'updated', count(*) filter (where e ->> 'action' = 'update'),
    'skipped', count(*) filter (where e ->> 'action' = 'skip'),
    'errors',  count(*) filter (where e ->> 'action' = 'error'),
    'rows',    coalesce(jsonb_agg(e), '[]'::jsonb))
  from jsonb_array_elements(coalesce(p_out, '[]'::jsonb)) e;
$$;
revoke all on function _import_summary(jsonb) from public, anon, authenticated;

-- Guarda común: negocio, rol, feature de importación y de la entidad, filas.
create or replace function _import_guard(p_feature text, p_rows jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'importacion_excel') then
    raise exception 'feature_not_in_plan: importacion_excel' using errcode = 'check_violation';
  end if;
  if p_feature is not null and not tenant_has_feature_for(v_tenant, p_feature) then
    raise exception 'feature_not_in_plan: %', p_feature using errcode = 'check_violation';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_rows' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'too_many_rows' using errcode = '22023';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _import_guard(text, jsonb) from public, anon, authenticated;

-- Auditoría de una aplicación (una entrada por llamada).
create or replace function _import_audit(p_tenant uuid, p_entity text, p_file text, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), p_entity, null, 'imported',
          jsonb_build_object(
            'source', 'xlsx',
            'file', nullif(btrim(coalesce(p_file, '')), ''),
            'total', jsonb_array_length(coalesce(p_result -> 'rows', '[]'::jsonb)),
            'created', (p_result ->> 'created')::int,
            'updated', (p_result ->> 'updated')::int,
            'skipped', (p_result ->> 'skipped')::int,
            'errors', (p_result ->> 'errors')::int));
end;
$$;
revoke all on function _import_audit(uuid, text, text, jsonb) from public, anon, authenticated;

-- Categoría por nombre (la crea si no existe).
create or replace function _import_category(p_tenant uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then return null; end if;
  select id into v_id from categories
   where tenant_id = p_tenant and deleted_at is null and lower(name) = lower(btrim(p_name))
   order by parent_id nulls first, created_at
   limit 1;
  if v_id is null then
    insert into categories (tenant_id, name) values (p_tenant, btrim(p_name)) returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function _import_category(uuid, text) from public, anon, authenticated;

-- Marca por nombre (la crea si no existe).
create or replace function _import_brand(p_tenant uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then return null; end if;
  select id into v_id from brands
   where tenant_id = p_tenant and deleted_at is null and lower(name) = lower(btrim(p_name))
   limit 1;
  if v_id is null then
    insert into brands (tenant_id, name) values (p_tenant, btrim(p_name)) returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function _import_brand(uuid, text) from public, anon, authenticated;

-- Producto o variante por SKU o código de barras.
create or replace function _import_find_item(p_tenant uuid, p_sku text, p_barcode text,
                                             out product_id uuid, out variant_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_sku is not null then
    select p.id into product_id from products p
     where p.tenant_id = p_tenant and p.deleted_at is null and lower(p.sku) = lower(p_sku) limit 1;
  end if;
  if product_id is null and p_barcode is not null then
    select p.id into product_id from products p
     where p.tenant_id = p_tenant and p.deleted_at is null and p.barcode = p_barcode limit 1;
  end if;
  if product_id is not null then return; end if;
  if p_sku is not null then
    select v.product_id, v.id into product_id, variant_id from product_variants v
     where v.tenant_id = p_tenant and v.deleted_at is null and lower(v.sku) = lower(p_sku) limit 1;
  end if;
  if product_id is null and p_barcode is not null then
    select v.product_id, v.id into product_id, variant_id from product_variants v
     where v.tenant_id = p_tenant and v.deleted_at is null and v.barcode = p_barcode limit 1;
  end if;
end;
$$;
revoke all on function _import_find_item(uuid, text, text) from public, anon, authenticated;

-- Ejecuta el run de una entidad: dry-run (revierte) o aplicación (audita).
create or replace function _import_exec(p_entity text, p_feature text, p_rows jsonb,
                                        p_apply boolean, p_file text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _import_guard(p_feature, p_rows);
  v_apply  boolean := coalesce(p_apply, false);
  v_out    jsonb;
  v_res    jsonb;
begin
  if p_entity not in ('products', 'customers', 'stock', 'price_lists', 'stores',
                      'warranty_plans', 'return_reasons') then
    raise exception 'invalid_entity' using errcode = '22023';
  end if;
  begin
    execute format('select _import_%s_run($1, $2)', p_entity) into v_out using v_tenant, p_rows;
    if not v_apply then
      -- Dry-run: todo lo escrito arriba se revierte; v_out (variable) queda.
      raise exception 'dry_run' using errcode = 'NJDRY';
    end if;
  exception when sqlstate 'NJDRY' then
    null;
  end;
  v_res := _import_summary(v_out);
  if v_apply then
    perform _import_audit(v_tenant, p_entity, p_file, v_res);
  end if;
  return v_res || jsonb_build_object('applied', v_apply, 'entity', p_entity);
end;
$$;
revoke all on function _import_exec(text, text, jsonb, boolean, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Productos
-- -----------------------------------------------------------------------------
create or replace function _import_products_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_row    int;
  v_name   text;
  v_sku    text;
  v_code   text;
  v_price  numeric;
  v_cost   numeric;
  v_tax    numeric;
  v_unit   text;
  v_stock  numeric;
  v_min    numeric;
  v_track  boolean;
  v_cat    uuid;
  v_brand  uuid;
  v_id     uuid;
  v_old    products;
  v_msg    text;
begin
  perform set_config('ninja.price_source', 'import', true);
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_name  := _import_txt(r, 'name');
      v_sku   := _import_txt(r, 'sku');
      v_code  := _import_txt(r, 'barcode');
      v_price := _import_num(r, 'price');
      v_cost  := _import_num(r, 'cost');
      v_tax   := _import_num(r, 'tax_rate');
      v_unit  := _import_txt(r, 'unit');
      v_stock := _import_num(r, 'stock');
      v_min   := _import_num(r, 'stock_min');
      v_track := _import_bool(r, 'track_stock');
      v_msg   := null;

      if v_price is not null and v_price < 0 then raise exception 'import_price_invalid'; end if;
      if v_cost is not null and v_cost < 0 then raise exception 'import_cost_invalid'; end if;
      if v_tax is not null and (v_tax < 0 or v_tax > 100) then raise exception 'import_tax_invalid'; end if;

      v_id := null;
      if v_sku is not null then
        select id into v_id from products
         where tenant_id = p_tenant and deleted_at is null and lower(sku) = lower(v_sku) limit 1;
      end if;
      if v_id is null and v_code is not null then
        select id into v_id from products
         where tenant_id = p_tenant and deleted_at is null and barcode = v_code limit 1;
      end if;
      if v_id is not null and v_code is not null and exists (
        select 1 from products where tenant_id = p_tenant and deleted_at is null
           and barcode = v_code and id <> v_id) then
        raise exception 'import_barcode_taken';
      end if;

      v_cat   := _import_category(p_tenant, _import_txt(r, 'category'));
      v_brand := _import_brand(p_tenant, _import_txt(r, 'brand'));

      if v_id is null then
        if v_name is null then raise exception 'import_name_required'; end if;
        if v_price is null then raise exception 'import_price_required'; end if;
        insert into products (tenant_id, name, sku, barcode, price, cost, stock, stock_min, unit,
                              tax_rate, track_stock, category_id, brand_id, created_by, updated_by)
        values (p_tenant, v_name, v_sku, v_code, round(v_price, 2), v_cost, coalesce(v_stock, 0),
                coalesce(v_min, 0), coalesce(v_unit, 'un'), coalesce(v_tax, 21), coalesce(v_track, true),
                v_cat, v_brand, auth.uid(), auth.uid());
        v_out := _import_out(v_out, v_row, 'create');
      else
        select * into v_old from products where id = v_id for update;
        if v_stock is not null and v_stock is distinct from v_old.stock then
          v_msg := 'stock_ignored';
        end if;
        if (v_old.name, v_old.price, v_old.cost, v_old.barcode, v_old.tax_rate, v_old.unit,
            v_old.stock_min, v_old.track_stock, v_old.category_id, v_old.brand_id)
           is not distinct from
           (coalesce(v_name, v_old.name), coalesce(round(v_price, 2), v_old.price), coalesce(v_cost, v_old.cost),
            coalesce(v_code, v_old.barcode), coalesce(v_tax, v_old.tax_rate), coalesce(v_unit, v_old.unit),
            coalesce(v_min, v_old.stock_min), coalesce(v_track, v_old.track_stock),
            coalesce(v_cat, v_old.category_id), coalesce(v_brand, v_old.brand_id)) then
          v_out := _import_out(v_out, v_row, 'skip', coalesce(v_msg, 'unchanged'));
        else
          update products
             set name        = coalesce(v_name, name),
                 price       = coalesce(round(v_price, 2), price),
                 cost        = coalesce(v_cost, cost),
                 barcode     = coalesce(v_code, barcode),
                 tax_rate    = coalesce(v_tax, tax_rate),
                 unit        = coalesce(v_unit, unit),
                 stock_min   = coalesce(v_min, stock_min),
                 track_stock = coalesce(v_track, track_stock),
                 category_id = coalesce(v_cat, category_id),
                 brand_id    = coalesce(v_brand, brand_id),
                 updated_by  = auth.uid(),
                 updated_at  = now()
           where id = v_id and tenant_id = p_tenant;
          v_out := _import_out(v_out, v_row, 'update', v_msg);
        end if;
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;
  return v_out;
end;
$$;
revoke all on function _import_products_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_products(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('products', 'productos', p_rows, p_apply, p_file_name);
$$;
revoke all on function import_products(jsonb, boolean, text) from public, anon;
grant execute on function import_products(jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Clientes
-- -----------------------------------------------------------------------------
create or replace function _import_customers_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r       jsonb;
  v_out   jsonb := '[]'::jsonb;
  v_row   int;
  v_name  text;
  v_dtype text;
  v_doc   text;
  v_key   text;
  v_iva   text;
  v_email text;
  v_phone text;
  v_addr  text;
  v_notes text;
  v_id    uuid;
  v_old   customers;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_name  := _import_txt(r, 'name');
      v_dtype := _import_txt(r, 'document_type');
      v_doc   := _import_txt(r, 'document_number');
      v_iva   := _import_txt(r, 'iva_condition');
      v_email := _import_txt(r, 'email');
      v_phone := _import_txt(r, 'phone');
      v_addr  := _import_txt(r, 'address');
      v_notes := _import_txt(r, 'notes');

      v_id := null;
      v_key := upper(regexp_replace(coalesce(v_doc, ''), '[^0-9A-Za-z]', '', 'g'));
      if v_key <> '' then
        select id into v_id from customers
         where tenant_id = p_tenant and deleted_at is null
           and upper(regexp_replace(coalesce(document_number, ''), '[^0-9A-Za-z]', '', 'g')) = v_key
         order by created_at
         limit 1;
      end if;

      if v_id is null then
        if v_name is null then raise exception 'import_name_required'; end if;
        insert into customers (tenant_id, name, document_type, document_number, iva_condition,
                               email, phone, address, notes, is_active)
        values (p_tenant, v_name, v_dtype, v_doc, v_iva, v_email, v_phone, v_addr, v_notes, true);
        v_out := _import_out(v_out, v_row, 'create');
      else
        select * into v_old from customers where id = v_id for update;
        if (v_old.name, v_old.document_type, v_old.iva_condition, v_old.email, v_old.phone,
            v_old.address, v_old.notes)
           is not distinct from
           (coalesce(v_name, v_old.name), coalesce(v_dtype, v_old.document_type),
            coalesce(v_iva, v_old.iva_condition), coalesce(v_email, v_old.email),
            coalesce(v_phone, v_old.phone), coalesce(v_addr, v_old.address),
            coalesce(v_notes, v_old.notes)) then
          v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
        else
          update customers
             set name          = coalesce(v_name, name),
                 document_type = coalesce(v_dtype, document_type),
                 iva_condition = coalesce(v_iva, iva_condition),
                 email         = coalesce(v_email, email),
                 phone         = coalesce(v_phone, phone),
                 address       = coalesce(v_addr, address),
                 notes         = coalesce(v_notes, notes)
           where id = v_id and tenant_id = p_tenant;
          v_out := _import_out(v_out, v_row, 'update');
        end if;
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;
  return v_out;
end;
$$;
revoke all on function _import_customers_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_customers(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('customers', 'clientes', p_rows, p_apply, p_file_name);
$$;
revoke all on function import_customers(jsonb, boolean, text) from public, anon;
grant execute on function import_customers(jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Stock por sucursal (conteo + mínimo/máximo/ubicación)
-- -----------------------------------------------------------------------------
create or replace function _import_stock_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_row    int;
  v_store  text;
  v_sid    uuid;
  v_item   record;
  v_qty    numeric;
  v_min    numeric;
  v_max    numeric;
  v_loc    text;
  v_cur    product_stock;
  v_has    boolean;
  v_done   boolean;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_store := _import_txt(r, 'store');
      v_qty   := _import_num(r, 'qty');
      v_min   := _import_num(r, 'min_qty');
      v_max   := _import_num(r, 'max_qty');
      v_loc   := _import_txt(r, 'location');
      v_done  := false;

      if v_store is null then
        v_sid := stock_default_store(p_tenant);
      else
        select id into v_sid from stores
         where tenant_id = p_tenant and deleted_at is null
           and (lower(code) = lower(v_store) or lower(name) = lower(v_store))
         order by (lower(code) = lower(v_store)) desc nulls last
         limit 1;
      end if;
      if v_sid is null then raise exception 'import_store_not_found'; end if;

      select * into v_item from _import_find_item(p_tenant, _import_txt(r, 'sku'), _import_txt(r, 'barcode'));
      if v_item.product_id is null then raise exception 'import_product_not_found'; end if;
      if v_qty is null and v_min is null and v_max is null and v_loc is null then
        raise exception 'import_nothing_to_do';
      end if;

      select * into v_cur from product_stock
       where store_id = v_sid and product_id = v_item.product_id
         and variant_id is not distinct from v_item.variant_id;
      v_has := v_cur.id is not null;

      if v_qty is not null and v_qty is distinct from coalesce(v_cur.qty, 0) then
        if v_qty < 0 then raise exception 'invalid_qty'; end if;
        perform adjust_store_stock(v_sid, v_item.product_id, v_item.variant_id, v_qty, 'set',
                                   'adjustment', 'Importación XLSX');
        v_done := true;
      end if;

      if (v_min is not null or v_max is not null or v_loc is not null)
         and (coalesce(v_min, v_cur.min_qty), coalesce(v_max, v_cur.max_qty), coalesce(v_loc, v_cur.location))
             is distinct from (v_cur.min_qty, v_cur.max_qty, v_cur.location) then
        perform set_store_stock_settings(v_sid, v_item.product_id, v_item.variant_id,
                                         coalesce(v_min, v_cur.min_qty), coalesce(v_max, v_cur.max_qty),
                                         coalesce(v_loc, v_cur.location));
        v_done := true;
      end if;

      if not v_done then
        v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
      elsif v_has then
        v_out := _import_out(v_out, v_row, 'update');
      else
        v_out := _import_out(v_out, v_row, 'create');
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;
  return v_out;
end;
$$;
revoke all on function _import_stock_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_stock(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('stock', 'stock', p_rows, p_apply, p_file_name);
$$;
revoke all on function import_stock(jsonb, boolean, text) from public, anon;
grant execute on function import_stock(jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Listas de precios (precio base o lista; ahora o programado)
-- -----------------------------------------------------------------------------
create or replace function _import_price_lists_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_row    int;
  v_list   text;
  v_lid    uuid;
  v_item   record;
  v_price  numeric;
  v_eff    timestamptz;
  v_cur    numeric;
  v_exists boolean;
begin
  perform set_config('ninja.price_source', 'import', true);
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_list  := _import_txt(r, 'list');
      v_price := round(_import_num(r, 'price'), 2);
      v_eff   := nullif(btrim(coalesce(r ->> 'effective_at', '')), '')::timestamptz;
      if v_price is null or v_price < 0 then raise exception 'import_price_invalid'; end if;

      v_lid := null;
      if v_list is not null and lower(v_list) not in ('precio de venta', 'precio base', 'base') then
        select id into v_lid from price_lists
         where tenant_id = p_tenant and deleted_at is null and lower(name) = lower(v_list)
         order by created_at limit 1;
        if v_lid is null then raise exception 'import_list_not_found'; end if;
        if not tenant_has_feature_for(p_tenant, 'listas_precios') then
          raise exception 'feature_not_in_plan: listas_precios';
        end if;
      end if;

      select * into v_item from _import_find_item(p_tenant, _import_txt(r, 'sku'), _import_txt(r, 'barcode'));
      if v_item.product_id is null then raise exception 'import_product_not_found'; end if;

      v_exists := true;
      if v_lid is null then
        if v_item.variant_id is null then
          select price into v_cur from products where id = v_item.product_id;
        else
          select price_override into v_cur from product_variants where id = v_item.variant_id;
        end if;
      else
        select price into v_cur from price_list_items
         where price_list_id = v_lid and product_id = v_item.product_id
           and variant_id is not distinct from v_item.variant_id;
        v_exists := found;
      end if;

      if v_eff is not null and v_eff > now() then
        insert into price_schedules (tenant_id, list_id, product_id, variant_id, price, effective_at, status, source)
        values (p_tenant, v_lid, v_item.product_id, v_item.variant_id, v_price, v_eff, 'scheduled', 'import');
        v_out := _import_out(v_out, v_row, 'update', 'scheduled');
      elsif v_exists and v_cur is not distinct from v_price then
        v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
      else
        perform _price_write(p_tenant, v_lid, v_item.product_id, v_item.variant_id, v_price);
        v_out := _import_out(v_out, v_row, case when v_exists then 'update' else 'create' end);
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;
  return v_out;
end;
$$;
revoke all on function _import_price_lists_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_price_lists(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('price_lists', null, p_rows, p_apply, p_file_name);
$$;
revoke all on function import_price_lists(jsonb, boolean, text) from public, anon;
grant execute on function import_price_lists(jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Sucursales
-- -----------------------------------------------------------------------------
create or replace function _import_stores_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r       jsonb;
  v_out   jsonb := '[]'::jsonb;
  v_row   int;
  v_name  text;
  v_code  text;
  v_short text;
  v_addr  text;
  v_city  text;
  v_prov  text;
  v_cp    text;
  v_phone text;
  v_email text;
  v_pos   int;
  v_notes text;
  v_id    uuid;
  v_old   stores;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_name  := _import_txt(r, 'name');
      v_code  := _import_txt(r, 'code');
      v_short := _import_txt(r, 'short_name');
      v_addr  := _import_txt(r, 'address');
      v_city  := _import_txt(r, 'city');
      v_prov  := _import_txt(r, 'province');
      v_cp    := _import_txt(r, 'postal_code');
      v_phone := _import_txt(r, 'phone');
      v_email := _import_txt(r, 'email');
      v_pos   := _import_num(r, 'afip_pos_number')::int;
      v_notes := _import_txt(r, 'notes');

      v_id := null;
      if v_code is not null then
        select id into v_id from stores
         where tenant_id = p_tenant and deleted_at is null and lower(code) = lower(v_code) limit 1;
      end if;
      if v_id is null and v_name is not null then
        select id into v_id from stores
         where tenant_id = p_tenant and deleted_at is null and lower(name) = lower(v_name)
         order by created_at limit 1;
      end if;

      if v_id is null then
        if v_name is null then raise exception 'import_name_required'; end if;
        insert into stores (tenant_id, name, code, short_name, address, city, province, postal_code,
                            phone, email, afip_pos_number, notes)
        values (p_tenant, v_name, v_code, v_short, v_addr, v_city, v_prov, v_cp, v_phone, v_email,
                v_pos, v_notes);
        v_out := _import_out(v_out, v_row, 'create');
      else
        select * into v_old from stores where id = v_id for update;
        if (v_old.name, v_old.code, v_old.short_name, v_old.address, v_old.city, v_old.province,
            v_old.postal_code, v_old.phone, v_old.email, v_old.afip_pos_number, v_old.notes)
           is not distinct from
           (coalesce(v_name, v_old.name), coalesce(v_code, v_old.code), coalesce(v_short, v_old.short_name),
            coalesce(v_addr, v_old.address), coalesce(v_city, v_old.city), coalesce(v_prov, v_old.province),
            coalesce(v_cp, v_old.postal_code), coalesce(v_phone, v_old.phone), coalesce(v_email, v_old.email),
            coalesce(v_pos, v_old.afip_pos_number), coalesce(v_notes, v_old.notes)) then
          v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
        else
          update stores
             set name            = coalesce(v_name, name),
                 code            = coalesce(v_code, code),
                 short_name      = coalesce(v_short, short_name),
                 address         = coalesce(v_addr, address),
                 city            = coalesce(v_city, city),
                 province        = coalesce(v_prov, province),
                 postal_code     = coalesce(v_cp, postal_code),
                 phone           = coalesce(v_phone, phone),
                 email           = coalesce(v_email, email),
                 afip_pos_number = coalesce(v_pos, afip_pos_number),
                 notes           = coalesce(v_notes, notes)
           where id = v_id and tenant_id = p_tenant;
          v_out := _import_out(v_out, v_row, 'update');
        end if;
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;
  return v_out;
end;
$$;
revoke all on function _import_stores_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_stores(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('stores', null, p_rows, p_apply, p_file_name);
$$;
revoke all on function import_stores(jsonb, boolean, text) from public, anon;
grant execute on function import_stores(jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Planes de garantía extendida
-- -----------------------------------------------------------------------------
create or replace function _import_warranty_plans_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_row    int;
  v_label  text;
  v_months int;
  v_price  numeric;
  v_pct    numeric;
  v_comm   numeric;
  v_desc   text;
  v_sort   int;
  v_active boolean;
  v_id     uuid;
  v_old    warranty_plans;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_label  := _import_txt(r, 'label');
      v_months := _import_num(r, 'months')::int;
      v_price  := _import_num(r, 'price');
      v_pct    := _import_num(r, 'price_pct');
      v_comm   := _import_num(r, 'commission_pct');
      v_desc   := _import_txt(r, 'description');
      v_sort   := _import_num(r, 'sort')::int;
      v_active := _import_bool(r, 'is_active');

      if v_label is null then raise exception 'import_name_required'; end if;
      if v_months is not null and v_months < 0 then raise exception 'import_months_invalid'; end if;
      if v_price is not null and v_price < 0 then raise exception 'import_price_invalid'; end if;
      if (v_pct is not null and (v_pct < 0 or v_pct > 100))
         or (v_comm is not null and (v_comm < 0 or v_comm > 100)) then
        raise exception 'import_pct_invalid';
      end if;

      select id into v_id from warranty_plans
       where tenant_id = p_tenant and lower(label) = lower(v_label)
       order by created_at limit 1;

      if v_id is null then
        insert into warranty_plans (tenant_id, label, months, price, price_pct, commission_pct,
                                    description, sort, is_active)
        values (p_tenant, v_label, coalesce(v_months, 0), coalesce(v_price, 0), coalesce(v_pct, 0),
                coalesce(v_comm, 0), v_desc, coalesce(v_sort, 0), coalesce(v_active, true));
        v_out := _import_out(v_out, v_row, 'create');
      else
        select * into v_old from warranty_plans where id = v_id for update;
        if (v_old.months, v_old.price, v_old.price_pct, v_old.commission_pct, v_old.description,
            v_old.sort, v_old.is_active)
           is not distinct from
           (coalesce(v_months, v_old.months), coalesce(v_price, v_old.price), coalesce(v_pct, v_old.price_pct),
            coalesce(v_comm, v_old.commission_pct), coalesce(v_desc, v_old.description),
            coalesce(v_sort, v_old.sort), coalesce(v_active, v_old.is_active)) then
          v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
        else
          update warranty_plans
             set months         = coalesce(v_months, months),
                 price          = coalesce(v_price, price),
                 price_pct      = coalesce(v_pct, price_pct),
                 commission_pct = coalesce(v_comm, commission_pct),
                 description    = coalesce(v_desc, description),
                 sort           = coalesce(v_sort, sort),
                 is_active      = coalesce(v_active, is_active)
           where id = v_id and tenant_id = p_tenant;
          v_out := _import_out(v_out, v_row, 'update');
        end if;
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;
  return v_out;
end;
$$;
revoke all on function _import_warranty_plans_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_warranty_plans(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('warranty_plans', 'garantias', p_rows, p_apply, p_file_name);
$$;
revoke all on function import_warranty_plans(jsonb, boolean, text) from public, anon;
grant execute on function import_warranty_plans(jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Motivos de devolución
-- -----------------------------------------------------------------------------
create or replace function _import_return_reasons_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_row    int;
  v_label  text;
  v_code   text;
  v_dest   text;
  v_sort   int;
  v_active boolean;
  v_id     uuid;
  v_old    return_reasons;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_label  := _import_txt(r, 'label');
      v_code   := lower(_import_txt(r, 'code'));
      v_dest   := _import_txt(r, 'stock_destination');
      v_sort   := _import_num(r, 'sort')::int;
      v_active := _import_bool(r, 'is_active');

      if v_dest is not null and v_dest not in ('resale', 'warehouse', 'loss', 'review') then
        raise exception 'import_destination_invalid';
      end if;

      v_id := null;
      if v_code is not null then
        select id into v_id from return_reasons
         where tenant_id = p_tenant and deleted_at is null and lower(code) = v_code limit 1;
      end if;
      if v_id is null and v_label is not null then
        select id into v_id from return_reasons
         where tenant_id = p_tenant and deleted_at is null and lower(label) = lower(v_label)
         order by created_at limit 1;
      end if;

      if v_id is null then
        if v_label is null then raise exception 'import_name_required'; end if;
        insert into return_reasons (tenant_id, label, code, stock_destination, sort, is_active)
        values (p_tenant, v_label, v_code, coalesce(v_dest, 'resale'), coalesce(v_sort, 0),
                coalesce(v_active, true));
        v_out := _import_out(v_out, v_row, 'create');
      else
        select * into v_old from return_reasons where id = v_id for update;
        if (v_old.label, v_old.code, v_old.stock_destination, v_old.sort, v_old.is_active)
           is not distinct from
           (coalesce(v_label, v_old.label), coalesce(v_code, v_old.code), coalesce(v_dest, v_old.stock_destination),
            coalesce(v_sort, v_old.sort), coalesce(v_active, v_old.is_active)) then
          v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
        else
          update return_reasons
             set label             = coalesce(v_label, label),
                 code              = coalesce(v_code, code),
                 stock_destination = coalesce(v_dest, stock_destination),
                 sort              = coalesce(v_sort, sort),
                 is_active         = coalesce(v_active, is_active)
           where id = v_id and tenant_id = p_tenant;
          v_out := _import_out(v_out, v_row, 'update');
        end if;
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;
  return v_out;
end;
$$;
revoke all on function _import_return_reasons_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_return_reasons(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('return_reasons', 'devoluciones', p_rows, p_apply, p_file_name);
$$;
revoke all on function import_return_reasons(jsonb, boolean, text) from public, anon;
grant execute on function import_return_reasons(jsonb, boolean, text) to authenticated;
