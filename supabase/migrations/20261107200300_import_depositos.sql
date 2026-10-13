-- =============================================================================
-- 20261107200300_import_depositos  (F11 · H34 + H33, ADR-085)
--
-- Dos entidades nuevas en el motor de importación XLSX (ADR-078):
--   import_warehouses       depósitos por sucursal. Coincidencia: código; si
--                           no, sucursal + nombre. Sucursal por código o
--                           nombre (vacía = la principal del negocio).
--   import_warehouse_stock  conteo por depósito: depósito por código o
--                           sucursal + nombre, producto o variante por SKU o
--                           código de barras, cantidad = conteo (deja el
--                           depósito en ese valor moviendo la diferencia
--                           desde o hacia el salón, warehouse_stock_set).
-- Cada fila llama a las RPC de 20261107200100 (warehouse_save /
-- warehouse_stock_set), que validan rol, feature `depositos`, sucursal y
-- disponible; acá sólo se resuelve la coincidencia.
--
-- _import_exec se recrea copiando 20261104100100 (su única definición) con
-- las dos entidades nuevas en la lista blanca. Nada más cambia.
-- =============================================================================

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
                      'warranty_plans', 'return_reasons', 'warehouses', 'warehouse_stock') then
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

-- Sucursal por código o nombre (vacío = principal del negocio).
create or replace function _import_store(p_tenant uuid, p_store text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sid uuid;
begin
  if p_store is null then
    return stock_default_store(p_tenant);
  end if;
  select id into v_sid from stores
   where tenant_id = p_tenant and deleted_at is null
     and (lower(code) = lower(p_store) or lower(name) = lower(p_store))
   order by (lower(code) = lower(p_store)) desc nulls last
   limit 1;
  return v_sid;
end;
$$;
revoke all on function _import_store(uuid, text) from public, anon, authenticated;

-- Depósito por código, o por sucursal + nombre ("Salón de ventas" / "principal"
-- = el principal de la sucursal).
create or replace function _import_warehouse(p_tenant uuid, p_code text, p_store uuid, p_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_code is not null then
    select id into v_id from warehouses
     where tenant_id = p_tenant and deleted_at is null and lower(code) = lower(p_code) limit 1;
  end if;
  if v_id is null and p_store is not null and p_name is not null then
    select id into v_id from warehouses
     where tenant_id = p_tenant and store_id = p_store and deleted_at is null
       and (lower(btrim(name)) = lower(btrim(p_name))
            or (kind = 'principal' and lower(btrim(p_name)) = 'principal'))
     limit 1;
  end if;
  return v_id;
end;
$$;
revoke all on function _import_warehouse(uuid, text, uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- A) Depósitos
-- -----------------------------------------------------------------------------
create or replace function _import_warehouses_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r       jsonb;
  v_out   jsonb := '[]'::jsonb;
  v_row   int;
  v_sid   uuid;
  v_name  text;
  v_code  text;
  v_kind  text;
  v_sort  int;
  v_old   warehouses;
  v_id    uuid;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_sid  := _import_store(p_tenant, _import_txt(r, 'store'));
      v_name := _import_txt(r, 'name');
      v_code := _import_txt(r, 'code');
      v_kind := lower(_import_txt(r, 'kind'));
      v_sort := _import_num(r, 'sort')::int;
      if v_sid is null then raise exception 'import_store_not_found'; end if;

      v_id := _import_warehouse(p_tenant, v_code, v_sid, v_name);
      if v_id is null then
        if v_name is null then raise exception 'import_name_required'; end if;
        perform warehouse_save(null, v_sid, v_name, coalesce(v_kind, 'reserva'), v_code, coalesce(v_sort, 0));
        v_out := _import_out(v_out, v_row, 'create');
      else
        select * into v_old from warehouses where id = v_id;
        if (v_old.name, v_old.code, v_old.kind, v_old.sort) is not distinct from
           (coalesce(v_name, v_old.name), coalesce(v_code, v_old.code),
            case when v_old.kind = 'principal' then 'principal' else coalesce(v_kind, v_old.kind) end,
            coalesce(v_sort, v_old.sort)) then
          v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
        else
          perform warehouse_save(v_id, v_old.store_id, coalesce(v_name, v_old.name),
                                 coalesce(v_kind, v_old.kind), coalesce(v_code, v_old.code),
                                 coalesce(v_sort, v_old.sort));
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
revoke all on function _import_warehouses_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_warehouses(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('warehouses', 'depositos', p_rows, p_apply, p_file_name);
$$;
revoke all on function import_warehouses(jsonb, boolean, text) from public, anon;
grant execute on function import_warehouses(jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Stock por depósito (conteo)
-- -----------------------------------------------------------------------------
create or replace function _import_warehouse_stock_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r      jsonb;
  v_out  jsonb := '[]'::jsonb;
  v_row  int;
  v_sid  uuid;
  v_wid  uuid;
  v_item record;
  v_qty  numeric;
  v_cur  numeric;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_sid := _import_store(p_tenant, _import_txt(r, 'store'));
      v_wid := _import_warehouse(p_tenant, _import_txt(r, 'warehouse_code'), v_sid, _import_txt(r, 'warehouse'));
      if v_wid is null then raise exception 'import_warehouse_not_found'; end if;
      select * into v_item from _import_find_item(p_tenant, _import_txt(r, 'sku'), _import_txt(r, 'barcode'));
      if v_item.product_id is null then raise exception 'import_product_not_found'; end if;
      v_qty := _import_num(r, 'qty');
      if v_qty is null or v_qty < 0 then raise exception 'invalid_qty'; end if;

      select qty into v_cur from warehouse_stock
       where warehouse_id = v_wid and product_id = v_item.product_id
         and variant_id is not distinct from v_item.variant_id;

      if coalesce(v_cur, 0) = v_qty then
        v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
      else
        perform warehouse_stock_set(v_wid, v_item.product_id, v_item.variant_id, v_qty, 'Importación XLSX');
        v_out := _import_out(v_out, v_row, case when v_cur is null then 'create' else 'update' end);
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;
  return v_out;
end;
$$;
revoke all on function _import_warehouse_stock_run(uuid, jsonb) from public, anon, authenticated;

create or replace function import_warehouse_stock(p_rows jsonb, p_apply boolean default false, p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('warehouse_stock', 'depositos', p_rows, p_apply, p_file_name);
$$;
revoke all on function import_warehouse_stock(jsonb, boolean, text) from public, anon;
grant execute on function import_warehouse_stock(jsonb, boolean, text) to authenticated;
