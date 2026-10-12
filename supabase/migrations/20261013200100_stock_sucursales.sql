-- =============================================================================
-- 20261013200100_stock_sucursales  (F17 · H94, ADR-046)
--
-- Stock por sucursal sin tocar create_sale / exchange_sale / return_sale.
--
-- Modelo:
--   • product_stock(tenant_id, store_id, product_id, variant_id, qty, min_qty,
--     max_qty, location): stock en mano por sucursal (variant_id null = producto
--     sin variantes). Es un saldo derivado del libro stock_movements.
--   • stock_movements.store_id: si un movimiento llega sin sucursal se completa
--     (BEFORE INSERT) con la de la venta referenciada o la sucursal principal
--     del negocio.
--   • AFTER INSERT/DELETE en stock_movements: aplica el delta al saldo de la
--     sucursal del movimiento.
--   • products.stock y product_variants.stock siguen siendo el TOTAL consolidado
--     (todas las pantallas actuales siguen funcionando). Los escriben las RPC de
--     siempre. Invariante garantizado al COMMIT por triggers de restricción
--     diferidos: Σ product_stock.qty = products.stock (variant_id null) y
--     Σ product_stock.qty = product_variants.stock (por variante). Si una
--     escritura cambió el total sin movimiento (alta de producto con stock
--     inicial, edición directa, import), la diferencia entra como movimiento
--     'adjustment' en la sucursal principal. Nunca bloquea la operación.
--   • Lo que está en tránsito (traslados despachados y no recibidos) NO suma en
--     ninguna sucursal ni en el total: se ve aparte (ver 20261013200200).
--
-- Backfill: el stock actual de cada producto y variante entra en la sucursal
-- principal de su negocio. Idempotente (sólo si el producto o la variante no
-- tiene filas todavía). Los negocios sin sucursal quedan sin filas (no hay a
-- dónde asignar); el trigger los toma cuando creen su primera sucursal y se
-- mueva el stock.
--
-- Gating: los datos se mantienen siempre (es barato y evita huecos si el negocio
-- sube de plan). La feature stock_sucursales (y multi_sucursal) se exige al
-- operar sobre una sucursal que no es la principal y al configurar mínimos,
-- máximos y ubicación por sucursal.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Motivos de movimiento: se suman los de traslado, conteo y producción
--    (register_production ya usa 'production'). NOT VALID: no revalida filas
--    históricas.
-- -----------------------------------------------------------------------------
alter table stock_movements drop constraint if exists stock_movements_reason_check;
alter table stock_movements
  add constraint stock_movements_reason_check
  check (reason in ('purchase','sale','sale_void','adjustment','transfer','loss','return',
                    'production','count','transfer_out','transfer_in','transfer_return'))
  not valid;

create index if not exists stock_movements_reference_idx
  on stock_movements(reference_id) where reference_id is not null;

-- -----------------------------------------------------------------------------
-- B) Sucursal principal del negocio (destino por defecto del stock).
-- -----------------------------------------------------------------------------
create or replace function stock_default_store(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id
    from stores s
   where s.tenant_id = p_tenant
     and s.deleted_at is null
   order by s.is_default desc, s.is_active desc, s.created_at
   limit 1;
$$;
revoke all on function stock_default_store(uuid) from public, anon;
grant execute on function stock_default_store(uuid) to authenticated, service_role;

-- Rol activo del usuario en el negocio actual (null si no es miembro).
create or replace function stock_my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from tenant_users
   where tenant_id = current_tenant_id() and user_id = auth.uid() and status = 'active'
   limit 1;
$$;
revoke all on function stock_my_role() from public, anon;
grant execute on function stock_my_role() to authenticated;

-- Cantidad de sucursales operativas del negocio.
create or replace function stock_store_count(p_tenant uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int from stores
   where tenant_id = p_tenant and deleted_at is null and is_active;
$$;
revoke all on function stock_store_count(uuid) from public, anon;
grant execute on function stock_store_count(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- C) product_stock.
-- -----------------------------------------------------------------------------
create table if not exists product_stock (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  store_id    uuid not null references stores(id),
  product_id  uuid not null references products(id) on delete cascade,
  variant_id  uuid references product_variants(id) on delete cascade,
  qty         numeric(12,3) not null default 0,
  min_qty     numeric(12,3) check (min_qty is null or min_qty >= 0),
  max_qty     numeric(12,3) check (max_qty is null or max_qty >= 0),
  location    text check (location is null or char_length(location) <= 60),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint product_stock_store_product_variant_key
    unique nulls not distinct (store_id, product_id, variant_id),
  constraint product_stock_min_le_max
    check (min_qty is null or max_qty is null or min_qty <= max_qty)
);

comment on table product_stock is
  'Stock en mano por sucursal (F17/H94, ADR-046). Saldo derivado de stock_movements; '
  'la suma por producto/variante es igual a products.stock / product_variants.stock al commit.';
comment on column product_stock.min_qty is 'Mínimo / punto de reposición de la sucursal. null = usa products.stock_min.';
comment on column product_stock.max_qty is 'Máximo de la sucursal (objetivo al reponer). null = sin máximo.';
comment on column product_stock.location is 'Ubicación dentro de la sucursal (góndola, estante, depósito). Opcional.';

create index if not exists product_stock_tenant_idx on product_stock(tenant_id);
create index if not exists product_stock_product_idx on product_stock(product_id, variant_id);
create index if not exists product_stock_store_idx on product_stock(store_id);

drop trigger if exists set_updated_at_product_stock on product_stock;
create trigger set_updated_at_product_stock
  before update on product_stock
  for each row execute function set_updated_at();

alter table product_stock enable row level security;

-- Lectura para los miembros del negocio. Sin policies de escritura: el saldo
-- sólo cambia por movimientos (triggers) y la configuración por RPC.
drop policy if exists product_stock_select on product_stock;
create policy product_stock_select on product_stock
  for select using (
    tenant_id = (select current_tenant_id()) or (select is_internal())
  );

-- -----------------------------------------------------------------------------
-- D) Backfill: stock actual → sucursal principal (idempotente).
-- -----------------------------------------------------------------------------
insert into product_stock (tenant_id, store_id, product_id, variant_id, qty)
select p.tenant_id, d.store_id, p.id, null, p.stock
  from products p
  cross join lateral (select stock_default_store(p.tenant_id) as store_id) d
 where d.store_id is not null
   and coalesce(p.stock, 0) <> 0
   and not exists (
     select 1 from product_stock ps where ps.product_id = p.id and ps.variant_id is null
   );

insert into product_stock (tenant_id, store_id, product_id, variant_id, qty)
select v.tenant_id, d.store_id, v.product_id, v.id, v.stock
  from product_variants v
  cross join lateral (select stock_default_store(v.tenant_id) as store_id) d
 where d.store_id is not null
   and coalesce(v.stock, 0) <> 0
   and not exists (
     select 1 from product_stock ps where ps.variant_id = v.id
   );

-- -----------------------------------------------------------------------------
-- E) stock_movements → sucursal y saldo.
-- -----------------------------------------------------------------------------
create or replace function trg_stock_movement_store()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.tenant_id is null then
    select tenant_id into new.tenant_id from products where id = new.product_id;
  end if;
  if new.store_id is null then
    -- Venta / anulación: la sucursal de la venta (la de la caja del turno una
    -- vez que create_sale la tome de ahí).
    if new.reference_id is not null and new.reason in ('sale', 'sale_void', 'return') then
      select s.store_id into new.store_id
        from sales s
       where s.id = new.reference_id and s.tenant_id = new.tenant_id;
    end if;
    if new.store_id is null then
      new.store_id := stock_default_store(new.tenant_id);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function trg_stock_movement_store() from public, anon, authenticated;

drop trigger if exists stock_movements_fill_store on stock_movements;
create trigger stock_movements_fill_store
  before insert on stock_movements
  for each row execute function trg_stock_movement_store();

create or replace function trg_stock_movement_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row stock_movements;
  v_sign int;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_sign := -1;
  else
    v_row := new;
    v_sign := 1;
  end if;

  if v_row.store_id is null or coalesce(v_row.delta, 0) = 0 then
    return null;
  end if;

  insert into product_stock (tenant_id, store_id, product_id, variant_id, qty)
  values (v_row.tenant_id, v_row.store_id, v_row.product_id, v_row.variant_id, v_sign * v_row.delta)
  on conflict on constraint product_stock_store_product_variant_key
  do update set qty = product_stock.qty + excluded.qty, updated_at = now();

  return null;
end;
$$;
revoke all on function trg_stock_movement_apply() from public, anon, authenticated;

drop trigger if exists stock_movements_apply_store on stock_movements;
create trigger stock_movements_apply_store
  after insert or delete on stock_movements
  for each row execute function trg_stock_movement_apply();

-- -----------------------------------------------------------------------------
-- F) Conciliación al commit: total consolidado = Σ sucursales.
-- -----------------------------------------------------------------------------
create or replace function stock_reconcile(p_product uuid, p_variant uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_total  numeric;
  v_sum    numeric;
  v_store  uuid;
  v_diff   numeric;
begin
  if p_variant is null then
    select tenant_id, stock into v_tenant, v_total from products where id = p_product;
  else
    select tenant_id, stock into v_tenant, v_total from product_variants where id = p_variant;
  end if;
  if v_tenant is null then
    return 0;
  end if;

  v_store := stock_default_store(v_tenant);
  if v_store is null then
    return 0;
  end if;

  select coalesce(sum(qty), 0) into v_sum
    from product_stock
   where product_id = p_product and variant_id is not distinct from p_variant;

  v_diff := coalesce(v_total, 0) - v_sum;
  if v_diff <> 0 then
    insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, notes, created_by)
    values (v_tenant, p_product, p_variant, v_store, v_diff, 'adjustment',
            'Conciliación por sucursal: stock cargado sin movimiento, asignado a la sucursal principal',
            auth.uid());
  end if;
  return v_diff;
end;
$$;
revoke all on function stock_reconcile(uuid, uuid) from public, anon, authenticated;
grant execute on function stock_reconcile(uuid, uuid) to service_role;

create or replace function trg_stock_reconcile_deferred()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if tg_table_name = 'products' then
      perform stock_reconcile(new.id, null);
    elsif tg_table_name = 'product_variants' then
      perform stock_reconcile(new.product_id, new.id);
    elsif tg_table_name = 'stock_movements' then
      perform stock_reconcile(new.product_id, new.variant_id);
    end if;
  exception when others then
    -- Nunca bloquear una venta o una edición por la conciliación por sucursal.
    raise warning 'stock_reconcile % %: %', tg_table_name, new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_stock_reconcile_deferred() from public, anon, authenticated;

drop trigger if exists products_stock_reconcile_ins on products;
create constraint trigger products_stock_reconcile_ins
  after insert on products
  deferrable initially deferred
  for each row
  when (new.stock is distinct from 0)
  execute function trg_stock_reconcile_deferred();

drop trigger if exists products_stock_reconcile_upd on products;
create constraint trigger products_stock_reconcile_upd
  after update of stock on products
  deferrable initially deferred
  for each row
  when (old.stock is distinct from new.stock)
  execute function trg_stock_reconcile_deferred();

drop trigger if exists product_variants_stock_reconcile_ins on product_variants;
create constraint trigger product_variants_stock_reconcile_ins
  after insert on product_variants
  deferrable initially deferred
  for each row
  when (new.stock is distinct from 0)
  execute function trg_stock_reconcile_deferred();

drop trigger if exists product_variants_stock_reconcile_upd on product_variants;
create constraint trigger product_variants_stock_reconcile_upd
  after update of stock on product_variants
  deferrable initially deferred
  for each row
  when (old.stock is distinct from new.stock)
  execute function trg_stock_reconcile_deferred();

drop trigger if exists stock_movements_reconcile on stock_movements;
create constraint trigger stock_movements_reconcile
  after insert on stock_movements
  deferrable initially deferred
  for each row
  execute function trg_stock_reconcile_deferred();

-- Diagnóstico (soporte interno / tests): productos y variantes cuyo total no
-- coincide con la suma por sucursal. Debe devolver 0 filas.
create or replace function product_stock_mismatches(p_tenant uuid)
returns table (product_id uuid, variant_id uuid, total numeric, by_store numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, null::uuid, p.stock,
         coalesce((select sum(ps.qty) from product_stock ps
                    where ps.product_id = p.id and ps.variant_id is null), 0)
    from products p
   where p.tenant_id = p_tenant
     and p.stock is distinct from coalesce((select sum(ps.qty) from product_stock ps
                                             where ps.product_id = p.id and ps.variant_id is null), 0)
  union all
  select v.product_id, v.id, v.stock,
         coalesce((select sum(ps.qty) from product_stock ps where ps.variant_id = v.id), 0)
    from product_variants v
   where v.tenant_id = p_tenant
     and v.stock is distinct from coalesce((select sum(ps.qty) from product_stock ps
                                             where ps.variant_id = v.id), 0);
$$;
revoke all on function product_stock_mismatches(uuid) from public, anon, authenticated;
grant execute on function product_stock_mismatches(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- G) RPC: ajuste / conteo por sucursal.
--    p_mode 'delta' suma p_qty; 'set' deja la sucursal en p_qty (conteo).
--    Mantiene el total consolidado y deja el movimiento con su sucursal.
-- -----------------------------------------------------------------------------
create or replace function adjust_store_stock(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_qty        numeric,
  p_mode       text default 'delta',
  p_reason     text default 'adjustment',
  p_notes      text default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
  v_prod   record;
  v_cur    numeric;
  v_delta  numeric;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_mode not in ('delta', 'set') then
    raise exception 'invalid_mode';
  end if;
  if p_reason not in ('purchase','adjustment','loss','return','count','production') then
    raise exception 'invalid_reason: %', p_reason;
  end if;
  if p_qty is null or (p_mode = 'delta' and p_qty = 0) or (p_mode = 'set' and p_qty < 0) then
    raise exception 'invalid_qty';
  end if;

  if not exists (
    select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;

  -- Fuera de la sucursal principal hace falta el stock por sucursal.
  if p_store_id is distinct from stock_default_store(v_tenant) then
    if not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
      raise exception 'feature_not_in_plan: multi_sucursal';
    end if;
    if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
      raise exception 'feature_not_in_plan: stock_sucursales';
    end if;
  end if;

  select id, has_variants into v_prod
    from products
   where id = p_product_id and tenant_id = v_tenant and deleted_at is null;
  if v_prod.id is null then
    raise exception 'product_not_found';
  end if;
  if coalesce(v_prod.has_variants, false) then
    if p_variant_id is null then
      raise exception 'variant_required';
    end if;
    if not exists (
      select 1 from product_variants
       where id = p_variant_id and product_id = p_product_id and tenant_id = v_tenant
         and deleted_at is null
    ) then
      raise exception 'variant_not_found';
    end if;
  elsif p_variant_id is not null then
    raise exception 'variant_not_allowed';
  end if;

  -- Bloqueo del saldo de la sucursal (si existe) para un conteo consistente.
  select qty into v_cur
    from product_stock
   where store_id = p_store_id and product_id = p_product_id
     and variant_id is not distinct from p_variant_id
   for update;
  v_cur := coalesce(v_cur, 0);

  v_delta := case when p_mode = 'set' then p_qty - v_cur else p_qty end;
  if v_delta = 0 then
    return v_cur;
  end if;

  if p_variant_id is null then
    update products
       set stock = stock + v_delta, updated_by = auth.uid(), updated_at = now()
     where id = p_product_id and tenant_id = v_tenant;
  else
    update product_variants
       set stock = stock + v_delta, updated_at = now()
     where id = p_variant_id and tenant_id = v_tenant;
  end if;

  insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, notes, created_by)
  values (v_tenant, p_product_id, p_variant_id, p_store_id, v_delta,
          case when p_mode = 'set' then 'count' else p_reason end,
          nullif(trim(coalesce(p_notes, '')), ''), auth.uid());

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'product_stock', p_product_id,
          case when p_mode = 'set' then 'stock_count' else 'stock_adjust' end,
          jsonb_build_object('store_id', p_store_id, 'variant_id', p_variant_id, 'qty', v_cur),
          jsonb_build_object('store_id', p_store_id, 'variant_id', p_variant_id, 'qty', v_cur + v_delta,
                             'delta', v_delta, 'reason', p_reason),
          nullif(trim(coalesce(p_notes, '')), ''));

  return v_cur + v_delta;
end;
$$;
revoke all on function adjust_store_stock(uuid, uuid, uuid, numeric, text, text, text) from public, anon;
grant execute on function adjust_store_stock(uuid, uuid, uuid, numeric, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: mínimo, máximo y ubicación por sucursal.
-- -----------------------------------------------------------------------------
create or replace function set_store_stock_settings(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_min_qty    numeric,
  p_max_qty    numeric,
  p_location   text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
  v_before jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
    raise exception 'feature_not_in_plan: multi_sucursal';
  end if;
  if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
    raise exception 'feature_not_in_plan: stock_sucursales';
  end if;
  if (p_min_qty is not null and p_min_qty < 0) or (p_max_qty is not null and p_max_qty < 0) then
    raise exception 'invalid_qty';
  end if;
  if p_min_qty is not null and p_max_qty is not null and p_min_qty > p_max_qty then
    raise exception 'min_greater_than_max';
  end if;
  if not exists (
    select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;
  if not exists (
    select 1 from products where id = p_product_id and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'product_not_found';
  end if;
  if p_variant_id is not null and not exists (
    select 1 from product_variants
     where id = p_variant_id and product_id = p_product_id and tenant_id = v_tenant
  ) then
    raise exception 'variant_not_found';
  end if;

  select jsonb_build_object('min_qty', min_qty, 'max_qty', max_qty, 'location', location)
    into v_before
    from product_stock
   where store_id = p_store_id and product_id = p_product_id
     and variant_id is not distinct from p_variant_id;

  insert into product_stock (tenant_id, store_id, product_id, variant_id, qty, min_qty, max_qty, location)
  values (v_tenant, p_store_id, p_product_id, p_variant_id, 0, p_min_qty, p_max_qty,
          nullif(trim(coalesce(p_location, '')), ''))
  on conflict on constraint product_stock_store_product_variant_key
  do update set min_qty = excluded.min_qty,
                max_qty = excluded.max_qty,
                location = excluded.location,
                updated_at = now();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'product_stock', p_product_id, 'stock_settings', v_before,
          jsonb_build_object('store_id', p_store_id, 'variant_id', p_variant_id,
                             'min_qty', p_min_qty, 'max_qty', p_max_qty,
                             'location', nullif(trim(coalesce(p_location, '')), '')));
end;
$$;
revoke all on function set_store_stock_settings(uuid, uuid, uuid, numeric, numeric, text) from public, anon;
grant execute on function set_store_stock_settings(uuid, uuid, uuid, numeric, numeric, text) to authenticated;
