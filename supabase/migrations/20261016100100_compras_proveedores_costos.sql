-- =============================================================================
-- 20261016100100_compras_proveedores_costos  (F18 · H101, ADR-050)
--
-- A) Tres costos por producto (BASE, sin key): último costo, costo promedio
--    ponderado (móvil, se recalcula en cada recepción) y costo de reposición
--    (manual o desde la lista del proveedor), con historia.
-- B) purchase_settings: modo simple / profesional, base de costo para el margen
--    y reglas de recepción. products.cost (el "Costo" que ya usan márgenes,
--    valor de inventario, traslados y el asistente) sigue a la base elegida si
--    sync_product_cost está activo.
-- C) Proveedores (ABM por tabla con RLS, baja lógica, CUIT validado, auditoría).
-- D) Productos por proveedor (código del proveedor, último costo, plazo de
--    entrega, mínimo de compra, unidad de compra).
--
-- Gating: escribir proveedores y productos por proveedor exige la feature
-- compras (policy RLS con tenant_has_feature_for). Leer no: un negocio que baja
-- de plan conserva el acceso de lectura a su historia.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) internal_scope() (ADR-052): las policies de tablas de negocio nunca usan
--    "OR is_internal()". La función la crea 20261013900000 (fix/sucursales-
--    tenant); si esta rama se aplica sin ella, se crea con la MISMA definición
--    y sin pisar una existente.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'internal_scope' and p.pronargs = 0
  ) then
    execute $f$
      create function public.internal_scope()
      returns boolean
      language sql
      stable
      set search_path = ''
      as $body$
        select public.is_internal()
           and coalesce(
             (nullif(current_setting('request.headers', true), '')::json ->> 'x-ninja-scope') = 'internal',
             false
           );
      $body$
    $f$;
    execute 'grant execute on function public.internal_scope() to anon, authenticated, service_role';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- A) Costos por producto.
-- -----------------------------------------------------------------------------
alter table products add column if not exists last_cost        numeric(14,4);
alter table products add column if not exists avg_cost         numeric(14,4);
alter table products add column if not exists replacement_cost numeric(14,4);
alter table products add column if not exists cost_updated_at  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_costs_nonnegative') then
    alter table products add constraint products_costs_nonnegative check (
      (last_cost is null or last_cost >= 0)
      and (avg_cost is null or avg_cost >= 0)
      and (replacement_cost is null or replacement_cost >= 0)
    ) not valid;
  end if;
end $$;

comment on column products.last_cost is
  'Último costo de compra, neto de IVA, en pesos (F18/H101). Lo escribe la recepción de mercadería.';
comment on column products.avg_cost is
  'Costo promedio ponderado móvil, neto de IVA, en pesos (F18/H101). Se recalcula en cada recepción.';
comment on column products.replacement_cost is
  'Costo de reposición (manual o desde la lista del proveedor), neto de IVA (F18/H101).';

-- Punto de partida: el costo cargado hasta hoy es el último y el promedio.
update products
   set last_cost = cost, avg_cost = cost
 where cost is not null and last_cost is null and avg_cost is null;

create table if not exists product_cost_history (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  product_id   uuid not null references products(id) on delete cascade,
  kind         text not null check (kind in ('cost','last','average','replacement')),
  old_value    numeric(14,4),
  new_value    numeric(14,4),
  source       text,
  reference_id uuid,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

create index if not exists product_cost_history_product_idx
  on product_cost_history(product_id, created_at desc);
create index if not exists product_cost_history_tenant_idx on product_cost_history(tenant_id);

alter table product_cost_history enable row level security;
drop policy if exists product_cost_history_select on product_cost_history;
create policy product_cost_history_select on product_cost_history
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- -----------------------------------------------------------------------------
-- B) Configuración de compras por negocio.
-- -----------------------------------------------------------------------------
create table if not exists purchase_settings (
  tenant_id                 uuid primary key references tenants(id) on delete cascade,
  mode                      text not null default 'simple' check (mode in ('simple','pro')),
  cost_basis                text not null default 'last'
                              check (cost_basis in ('last','average','replacement')),
  sync_product_cost         boolean not null default true,
  cashier_can_receive       boolean not null default true,
  allow_free_receipts       boolean not null default true,
  allow_over_receive        boolean not null default true,
  require_difference_reason boolean not null default false,
  default_currency          text not null default 'ARS' check (default_currency ~ '^[A-Z]{3}$'),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  updated_by                uuid default auth.uid()
);

comment on table purchase_settings is
  'Compras por negocio (F18/H101, ADR-050): modo simple o profesional, base de costo para márgenes y reglas de recepción.';
comment on column purchase_settings.sync_product_cost is
  'Si está activo, products.cost sigue al costo de la base elegida (último, promedio o reposición).';

drop trigger if exists set_updated_at_purchase_settings on purchase_settings;
create trigger set_updated_at_purchase_settings
  before update on purchase_settings
  for each row execute function set_updated_at();

alter table purchase_settings enable row level security;
-- Sólo lectura por tabla: se escribe por RPC (purchase_settings_save).
drop policy if exists purchase_settings_select on purchase_settings;
create policy purchase_settings_select on purchase_settings
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- Configuración efectiva (defaults si el negocio no guardó nada).
create or replace function purchase_settings_for(p_tenant uuid)
returns purchase_settings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v purchase_settings;
begin
  select * into v from purchase_settings where tenant_id = p_tenant;
  if v.tenant_id is null then
    v.tenant_id := p_tenant;
    v.mode := 'simple';
    v.cost_basis := 'last';
    v.sync_product_cost := true;
    v.cashier_can_receive := true;
    v.allow_free_receipts := true;
    v.allow_over_receive := true;
    v.require_difference_reason := false;
    v.default_currency := 'ARS';
  end if;
  return v;
end;
$$;
revoke all on function purchase_settings_for(uuid) from public, anon, authenticated;
grant execute on function purchase_settings_for(uuid) to service_role;

-- Costo de la base elegida para un producto (null si no hay dato).
create or replace function product_basis_cost(p_basis text, p_last numeric, p_avg numeric, p_repl numeric)
returns numeric
language sql
immutable
as $$
  select case p_basis
           when 'average' then coalesce(p_avg, p_last)
           when 'replacement' then coalesce(p_repl, p_last)
           else coalesce(p_last, p_avg)
         end;
$$;

-- Historia de costos + sincronización de products.cost con la base elegida.
create or replace function trg_products_cost_track()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_set   purchase_settings;
  v_basis numeric;
  v_src   text := nullif(current_setting('ninja.cost_source', true), '');
  v_ref   uuid := nullif(current_setting('ninja.cost_reference', true), '')::uuid;
begin
  if new.last_cost is distinct from old.last_cost
     or new.avg_cost is distinct from old.avg_cost
     or new.replacement_cost is distinct from old.replacement_cost then
    v_set := purchase_settings_for(new.tenant_id);
    if v_set.sync_product_cost then
      v_basis := product_basis_cost(v_set.cost_basis, new.last_cost, new.avg_cost, new.replacement_cost);
      if v_basis is not null then
        new.cost := round(v_basis, 2);
      end if;
    end if;
    new.cost_updated_at := now();
  end if;

  if new.last_cost is distinct from old.last_cost then
    insert into product_cost_history (tenant_id, product_id, kind, old_value, new_value, source, reference_id)
    values (new.tenant_id, new.id, 'last', old.last_cost, new.last_cost, coalesce(v_src, 'manual'), v_ref);
  end if;
  if new.avg_cost is distinct from old.avg_cost then
    insert into product_cost_history (tenant_id, product_id, kind, old_value, new_value, source, reference_id)
    values (new.tenant_id, new.id, 'average', old.avg_cost, new.avg_cost, coalesce(v_src, 'manual'), v_ref);
  end if;
  if new.replacement_cost is distinct from old.replacement_cost then
    insert into product_cost_history (tenant_id, product_id, kind, old_value, new_value, source, reference_id)
    values (new.tenant_id, new.id, 'replacement', old.replacement_cost, new.replacement_cost,
            coalesce(v_src, 'manual'), v_ref);
  end if;
  if new.cost is distinct from old.cost then
    insert into product_cost_history (tenant_id, product_id, kind, old_value, new_value, source, reference_id)
    values (new.tenant_id, new.id, 'cost', old.cost, new.cost, coalesce(v_src, 'manual'), v_ref);
  end if;
  return new;
end;
$$;
revoke all on function trg_products_cost_track() from public, anon, authenticated;

drop trigger if exists products_cost_track on products;
create trigger products_cost_track
  before update of cost, last_cost, avg_cost, replacement_cost on products
  for each row
  when (old.cost is distinct from new.cost
        or old.last_cost is distinct from new.last_cost
        or old.avg_cost is distinct from new.avg_cost
        or old.replacement_cost is distinct from new.replacement_cost)
  execute function trg_products_cost_track();

-- Guardar configuración (dueño o encargado). Cambiar la base o activar la
-- sincronización recalcula products.cost de todo el negocio.
create or replace function purchase_settings_save(p jsonb)
returns purchase_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before purchase_settings;
  v_after  purchase_settings;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_before := purchase_settings_for(v_tenant);

  if coalesce(p ->> 'mode', v_before.mode) = 'pro'
     and not tenant_has_feature_for(v_tenant, 'compras') then
    raise exception 'feature_not_in_plan: compras';
  end if;

  insert into purchase_settings (tenant_id, mode, cost_basis, sync_product_cost, cashier_can_receive,
                                 allow_free_receipts, allow_over_receive, require_difference_reason,
                                 default_currency, updated_by)
  values (v_tenant,
          coalesce(p ->> 'mode', v_before.mode),
          coalesce(p ->> 'cost_basis', v_before.cost_basis),
          coalesce((p ->> 'sync_product_cost')::boolean, v_before.sync_product_cost),
          coalesce((p ->> 'cashier_can_receive')::boolean, v_before.cashier_can_receive),
          coalesce((p ->> 'allow_free_receipts')::boolean, v_before.allow_free_receipts),
          coalesce((p ->> 'allow_over_receive')::boolean, v_before.allow_over_receive),
          coalesce((p ->> 'require_difference_reason')::boolean, v_before.require_difference_reason),
          upper(coalesce(p ->> 'default_currency', v_before.default_currency)),
          auth.uid())
  on conflict (tenant_id) do update
    set mode = excluded.mode,
        cost_basis = excluded.cost_basis,
        sync_product_cost = excluded.sync_product_cost,
        cashier_can_receive = excluded.cashier_can_receive,
        allow_free_receipts = excluded.allow_free_receipts,
        allow_over_receive = excluded.allow_over_receive,
        require_difference_reason = excluded.require_difference_reason,
        default_currency = excluded.default_currency,
        updated_by = auth.uid()
  returning * into v_after;

  if v_after.sync_product_cost
     and (v_after.cost_basis is distinct from v_before.cost_basis
          or v_after.sync_product_cost is distinct from v_before.sync_product_cost) then
    perform set_config('ninja.cost_source', 'cost_basis_change', true);
    update products
       set cost = round(product_basis_cost(v_after.cost_basis, last_cost, avg_cost, replacement_cost), 2)
     where tenant_id = v_tenant
       and deleted_at is null
       and product_basis_cost(v_after.cost_basis, last_cost, avg_cost, replacement_cost) is not null
       and cost is distinct from round(product_basis_cost(v_after.cost_basis, last_cost, avg_cost, replacement_cost), 2);
    perform set_config('ninja.cost_source', '', true);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'purchase_settings', v_tenant, 'purchase_settings_save',
          to_jsonb(v_before), to_jsonb(v_after));
  return v_after;
end;
$$;
revoke all on function purchase_settings_save(jsonb) from public, anon;
grant execute on function purchase_settings_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Proveedores.
-- -----------------------------------------------------------------------------
-- Dígito verificador de CUIT / CUIL (espejo de isValidCuit en TS).
create or replace function cuit_is_valid(p text)
returns boolean
language plpgsql
immutable
as $$
declare
  d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  w int[] := array[5,4,3,2,7,6,5,4,3,2];
  s int := 0;
  c int;
begin
  if length(d) <> 11 then
    return false;
  end if;
  for i in 1..10 loop
    s := s + substr(d, i, 1)::int * w[i];
  end loop;
  c := 11 - (s % 11);
  if c = 11 then c := 0; end if;
  if c = 10 then c := 9; end if;
  return c = substr(d, 11, 1)::int;
end;
$$;

-- Guard común de compras: negocio, miembro activo y plan. Devuelve el tenant.
create or replace function purchase_assert(p_manager boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if v_role is null or (p_manager and v_role not in ('owner', 'manager')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'compras') then
    raise exception 'feature_not_in_plan: compras';
  end if;
  return v_tenant;
end;
$$;
revoke all on function purchase_assert(boolean) from public, anon;
grant execute on function purchase_assert(boolean) to authenticated;

-- ¿El usuario puede escribir en compras? (policies de proveedores)
create or replace function purchase_can_write()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(stock_my_role() in ('owner', 'manager'), false)
     and tenant_has_feature_for(current_tenant_id(), 'compras');
$$;
revoke all on function purchase_can_write() from public, anon;
grant execute on function purchase_can_write() to authenticated;

create table if not exists suppliers (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name               text not null check (char_length(trim(name)) between 1 and 200),
  trade_name         text check (trade_name is null or char_length(trade_name) <= 200),
  cuit               text check (cuit is null or (cuit ~ '^\d{11}$' and cuit_is_valid(cuit))),
  foreign_tax_id     text check (foreign_tax_id is null or char_length(foreign_tax_id) <= 40),
  iva_condition      text not null default 'responsable_inscripto'
                       check (iva_condition in ('responsable_inscripto','monotributo','exento',
                                                'no_responsable','consumidor_final','no_alcanzado',
                                                'exterior')),
  contact_name       text check (contact_name is null or char_length(contact_name) <= 120),
  email              text check (email is null or char_length(email) <= 200),
  phone              text check (phone is null or char_length(phone) <= 60),
  whatsapp           text check (whatsapp is null or char_length(whatsapp) <= 60),
  address            text check (address is null or char_length(address) <= 300),
  city               text check (city is null or char_length(city) <= 120),
  province           text check (province is null or char_length(province) <= 60),
  country            text not null default 'AR' check (country ~ '^[A-Z]{2}$'),
  payment_terms_days int not null default 0 check (payment_terms_days between 0 and 365),
  payment_terms_note text check (payment_terms_note is null or char_length(payment_terms_note) <= 200),
  currency           text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  cbu                text check (cbu is null or cbu ~ '^\d{22}$'),
  alias              text check (alias is null or alias ~ '^[A-Za-z0-9.\-]{6,20}$'),
  bank_name          text check (bank_name is null or char_length(bank_name) <= 120),
  notes              text check (notes is null or char_length(notes) <= 2000),
  is_active          boolean not null default true,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

comment on table suppliers is 'Proveedores del negocio (F18/H101, ADR-050). Baja lógica con deleted_at.';

create index if not exists suppliers_tenant_idx on suppliers(tenant_id) where deleted_at is null;
create unique index if not exists suppliers_tenant_cuit_key
  on suppliers(tenant_id, cuit) where deleted_at is null and cuit is not null;

-- Normaliza CUIT, CBU y alias antes de validar.
create or replace function trg_suppliers_normalize()
returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  new.cuit := nullif(regexp_replace(coalesce(new.cuit, ''), '\D', '', 'g'), '');
  new.cbu := nullif(regexp_replace(coalesce(new.cbu, ''), '\D', '', 'g'), '');
  new.alias := nullif(trim(coalesce(new.alias, '')), '');
  new.currency := upper(coalesce(new.currency, 'ARS'));
  return new;
end;
$$;

drop trigger if exists suppliers_normalize on suppliers;
create trigger suppliers_normalize
  before insert or update on suppliers
  for each row execute function trg_suppliers_normalize();

drop trigger if exists set_updated_at_suppliers on suppliers;
create trigger set_updated_at_suppliers
  before update on suppliers
  for each row execute function set_updated_at();

alter table suppliers enable row level security;

drop policy if exists suppliers_select on suppliers;
create policy suppliers_select on suppliers
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists suppliers_insert on suppliers;
create policy suppliers_insert on suppliers
  for insert with check (tenant_id = (select current_tenant_id()) and (select purchase_can_write()));

drop policy if exists suppliers_update on suppliers;
create policy suppliers_update on suppliers
  for update using (tenant_id = (select current_tenant_id()) and (select purchase_can_write()))
  with check (tenant_id = (select current_tenant_id()) and (select purchase_can_write()));
-- Sin DELETE: baja lógica (deleted_at).

drop trigger if exists audit_suppliers on suppliers;
create trigger audit_suppliers
  after insert or update or delete on suppliers
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- D) Productos por proveedor.
-- -----------------------------------------------------------------------------
create table if not exists supplier_products (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  supplier_id        uuid not null references suppliers(id) on delete cascade,
  product_id         uuid not null references products(id) on delete cascade,
  variant_id         uuid references product_variants(id) on delete cascade,
  supplier_sku       text check (supplier_sku is null or char_length(supplier_sku) <= 80),
  last_cost          numeric(14,4) check (last_cost is null or last_cost >= 0),
  list_cost          numeric(14,4) check (list_cost is null or list_cost >= 0),
  currency           text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  last_cost_at       timestamptz,
  lead_time_days     int check (lead_time_days is null or lead_time_days between 0 and 365),
  min_order_qty      numeric(12,3) check (min_order_qty is null or min_order_qty > 0),
  purchase_unit      text check (purchase_unit is null or char_length(purchase_unit) <= 30),
  units_per_purchase numeric(12,3) not null default 1 check (units_per_purchase > 0),
  is_preferred       boolean not null default false,
  notes              text check (notes is null or char_length(notes) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

comment on table supplier_products is
  'Producto por proveedor (F18/H101): código del proveedor, último costo, costo de lista, plazo de entrega y unidad de compra.';
comment on column supplier_products.list_cost is
  'Costo de lista del proveedor (en su moneda). Puede usarse como costo de reposición del producto.';

create unique index if not exists supplier_products_line_key
  on supplier_products(supplier_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where deleted_at is null;
create index if not exists supplier_products_product_idx on supplier_products(product_id) where deleted_at is null;
create index if not exists supplier_products_tenant_idx on supplier_products(tenant_id);

drop trigger if exists set_updated_at_supplier_products on supplier_products;
create trigger set_updated_at_supplier_products
  before update on supplier_products
  for each row execute function set_updated_at();

alter table supplier_products enable row level security;

drop policy if exists supplier_products_select on supplier_products;
create policy supplier_products_select on supplier_products
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists supplier_products_insert on supplier_products;
create policy supplier_products_insert on supplier_products
  for insert with check (
    tenant_id = (select current_tenant_id()) and (select purchase_can_write())
    and exists (select 1 from suppliers s where s.id = supplier_products.supplier_id and s.tenant_id = (select current_tenant_id()))
    and exists (select 1 from products p where p.id = supplier_products.product_id and p.tenant_id = (select current_tenant_id()))
  );

drop policy if exists supplier_products_update on supplier_products;
create policy supplier_products_update on supplier_products
  for update using (tenant_id = (select current_tenant_id()) and (select purchase_can_write()))
  with check (
    tenant_id = (select current_tenant_id()) and (select purchase_can_write())
    and exists (select 1 from suppliers s where s.id = supplier_products.supplier_id and s.tenant_id = (select current_tenant_id()))
    and exists (select 1 from products p where p.id = supplier_products.product_id and p.tenant_id = (select current_tenant_id()))
  );

drop trigger if exists audit_supplier_products on supplier_products;
create trigger audit_supplier_products
  after insert or update or delete on supplier_products
  for each row execute function write_audit_log();

-- Usar el costo de lista del proveedor como costo de reposición (en pesos).
create or replace function supplier_product_set_replacement(p_id uuid, p_fx_rate numeric default 1)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_sp     supplier_products;
  v_cost   numeric;
begin
  select * into v_sp from supplier_products
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if v_sp.id is null then
    raise exception 'supplier_product_not_found';
  end if;
  if coalesce(p_fx_rate, 0) <= 0 then
    raise exception 'invalid_fx_rate';
  end if;
  v_cost := coalesce(v_sp.list_cost, v_sp.last_cost);
  if v_cost is null then
    raise exception 'supplier_cost_missing';
  end if;
  v_cost := round(v_cost * case when v_sp.currency = 'ARS' then 1 else p_fx_rate end
                  / v_sp.units_per_purchase, 4);

  perform set_config('ninja.cost_source', 'supplier_list', true);
  perform set_config('ninja.cost_reference', v_sp.supplier_id::text, true);
  update products set replacement_cost = v_cost, updated_at = now()
   where id = v_sp.product_id and tenant_id = v_tenant;
  perform set_config('ninja.cost_source', '', true);
  perform set_config('ninja.cost_reference', '', true);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'products', v_sp.product_id, 'replacement_cost_from_supplier',
          jsonb_build_object('supplier_id', v_sp.supplier_id, 'replacement_cost', v_cost,
                             'fx_rate', p_fx_rate));
  return v_cost;
end;
$$;
revoke all on function supplier_product_set_replacement(uuid, numeric) from public, anon;
grant execute on function supplier_product_set_replacement(uuid, numeric) to authenticated;
