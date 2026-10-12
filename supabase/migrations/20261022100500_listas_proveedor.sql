-- =============================================================================
-- 20261022100500_listas_proveedor  (F18 · H100 + H101, ADR-059)
--
-- Importación de la lista de precios del proveedor (XLSX). El cliente lee el
-- archivo, el usuario mapea las columnas (código del proveedor, SKU o código
-- de barras, descripción, costo, unidades por bulto), el sistema cruza cada
-- fila con los productos del proveedor y muestra la vista previa con la
-- diferencia contra el costo de lista actual (lib/purchases/priceList.ts).
-- Al confirmar, supplier_price_list_apply:
--   • actualiza supplier_products.list_cost (y código, moneda y unidades por
--     bulto si vienen) o crea el vínculo producto-proveedor si se pidió,
--   • opcionalmente pasa el costo al costo de reposición del producto (en
--     pesos, por unidad: lista × TC ÷ unidades por bulto), con la historia de
--     costos con fuente 'supplier_list',
--   • guarda el mapeo de columnas en el proveedor para la próxima vez,
--   • deja el registro de la importación (supplier_price_list_imports) y
--     auditoría.
-- Gating: purchase_assert (compras, dueño o encargado).
-- =============================================================================

alter table suppliers add column if not exists price_list_mapping jsonb;

comment on column suppliers.price_list_mapping is
  'Último mapeo de columnas usado para importar la lista de precios del proveedor (F18, ADR-059).';

create table if not exists supplier_price_list_imports (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  supplier_id        uuid not null references suppliers(id),
  file_name          text check (file_name is null or char_length(file_name) <= 200),
  currency           text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  fx_rate            numeric(14,6) not null default 1 check (fx_rate > 0),
  update_replacement boolean not null default false,
  rows_total         int not null default 0,
  rows_updated       int not null default 0,
  rows_created       int not null default 0,
  rows_unchanged     int not null default 0,
  summary            jsonb not null default '[]'::jsonb,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now()
);

create index if not exists supplier_price_list_imports_supplier_idx
  on supplier_price_list_imports(supplier_id, created_at desc);
create index if not exists supplier_price_list_imports_tenant_idx on supplier_price_list_imports(tenant_id);

alter table supplier_price_list_imports enable row level security;
drop policy if exists supplier_price_list_imports_select on supplier_price_list_imports;
create policy supplier_price_list_imports_select on supplier_price_list_imports
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- p_rows: [{product_id, variant_id?, supplier_sku?, list_cost, units_per_purchase?}]
-- p_options: {file_name?, currency?, fx_rate?, update_replacement?, link_new?, mapping?}
create or replace function supplier_price_list_apply(p_supplier_id uuid, p_rows jsonb, p_options jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := purchase_assert(true);
  v_cur     text := upper(coalesce(nullif(p_options ->> 'currency', ''), 'ARS'));
  v_fx      numeric;
  v_repl    boolean := coalesce((p_options ->> 'update_replacement')::boolean, false);
  v_link    boolean := coalesce((p_options ->> 'link_new')::boolean, false);
  v_row     record;
  v_sp      supplier_products;
  v_prod    record;
  v_units   numeric;
  v_old     numeric;
  v_upd     int := 0;
  v_new     int := 0;
  v_same    int := 0;
  v_total   int := 0;
  v_summary jsonb := '[]'::jsonb;
  v_id      uuid;
begin
  if not exists (select 1 from suppliers where id = p_supplier_id and tenant_id = v_tenant and deleted_at is null) then
    raise exception 'supplier_not_found';
  end if;
  if v_cur !~ '^[A-Z]{3}$' then
    raise exception 'invalid_currency';
  end if;
  v_fx := case when v_cur = 'ARS' then 1 else coalesce((p_options ->> 'fx_rate')::numeric, 0) end;
  if v_fx <= 0 then
    raise exception 'invalid_fx_rate';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_items';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'too_many_rows';
  end if;

  perform set_config('ninja.cost_source', 'supplier_list', true);
  perform set_config('ninja.cost_reference', p_supplier_id::text, true);

  for v_row in
    select x.product_id, x.variant_id, nullif(trim(coalesce(x.supplier_sku, '')), '') as supplier_sku,
           x.list_cost, x.units_per_purchase
      from jsonb_to_recordset(p_rows)
        as x(product_id uuid, variant_id uuid, supplier_sku text, list_cost numeric, units_per_purchase numeric)
  loop
    v_total := v_total + 1;
    if v_row.list_cost is null or v_row.list_cost < 0 then
      raise exception 'invalid_cost';
    end if;
    if v_row.units_per_purchase is not null and v_row.units_per_purchase <= 0 then
      raise exception 'invalid_qty';
    end if;
    select id, has_variants into v_prod from products
     where id = v_row.product_id and tenant_id = v_tenant and deleted_at is null;
    if v_prod.id is null then
      raise exception 'product_not_found';
    end if;
    if v_row.variant_id is not null and not exists (
      select 1 from product_variants
       where id = v_row.variant_id and product_id = v_prod.id and tenant_id = v_tenant and deleted_at is null
    ) then
      raise exception 'variant_not_found';
    end if;

    select * into v_sp from supplier_products
     where supplier_id = p_supplier_id and product_id = v_prod.id
       and variant_id is not distinct from v_row.variant_id and deleted_at is null
     for update;

    if v_sp.id is null then
      if not v_link then
        continue;
      end if;
      insert into supplier_products (tenant_id, supplier_id, product_id, variant_id, supplier_sku, list_cost,
                                     currency, units_per_purchase)
      values (v_tenant, p_supplier_id, v_prod.id, v_row.variant_id, v_row.supplier_sku, round(v_row.list_cost, 4),
              v_cur, coalesce(v_row.units_per_purchase, 1))
      returning * into v_sp;
      v_new := v_new + 1;
      v_summary := v_summary || jsonb_build_array(jsonb_build_object(
        'product_id', v_prod.id, 'variant_id', v_row.variant_id, 'old', null, 'new', round(v_row.list_cost, 4)));
    elsif v_sp.list_cost is not distinct from round(v_row.list_cost, 4) and v_sp.currency = v_cur
          and (v_row.units_per_purchase is null or v_row.units_per_purchase = v_sp.units_per_purchase)
          and (v_row.supplier_sku is null or v_row.supplier_sku is not distinct from v_sp.supplier_sku) then
      v_same := v_same + 1;
    else
      v_old := v_sp.list_cost;
      update supplier_products
         set list_cost = round(v_row.list_cost, 4),
             currency = v_cur,
             supplier_sku = coalesce(v_row.supplier_sku, supplier_sku),
             units_per_purchase = coalesce(v_row.units_per_purchase, units_per_purchase)
       where id = v_sp.id
      returning * into v_sp;
      v_upd := v_upd + 1;
      if jsonb_array_length(v_summary) < 500 then
        v_summary := v_summary || jsonb_build_array(jsonb_build_object(
          'product_id', v_prod.id, 'variant_id', v_row.variant_id, 'old', v_old, 'new',
          round(v_row.list_cost, 4)));
      end if;
    end if;

    if v_repl then
      v_units := coalesce(v_sp.units_per_purchase, 1);
      update products
         set replacement_cost = round(v_row.list_cost * v_fx / v_units, 4), updated_at = now()
       where id = v_prod.id
         and replacement_cost is distinct from round(v_row.list_cost * v_fx / v_units, 4);
    end if;
  end loop;

  perform set_config('ninja.cost_source', '', true);
  perform set_config('ninja.cost_reference', '', true);

  if jsonb_typeof(p_options -> 'mapping') = 'object' then
    update suppliers set price_list_mapping = p_options -> 'mapping' where id = p_supplier_id;
  end if;

  insert into supplier_price_list_imports (tenant_id, supplier_id, file_name, currency, fx_rate, update_replacement,
                                           rows_total, rows_updated, rows_created, rows_unchanged, summary,
                                           created_by)
  values (v_tenant, p_supplier_id, nullif(trim(coalesce(p_options ->> 'file_name', '')), ''), v_cur, v_fx, v_repl,
          v_total, v_upd, v_new, v_same, v_summary, auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'suppliers', p_supplier_id, 'supplier_price_list_imported',
          jsonb_build_object('import_id', v_id, 'rows', v_total, 'updated', v_upd, 'created', v_new,
                             'unchanged', v_same, 'currency', v_cur, 'fx_rate', v_fx,
                             'update_replacement', v_repl));
  return v_id;
end;
$$;
revoke all on function supplier_price_list_apply(uuid, jsonb, jsonb) from public, anon;
grant execute on function supplier_price_list_apply(uuid, jsonb, jsonb) to authenticated;
