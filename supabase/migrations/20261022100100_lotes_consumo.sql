-- =============================================================================
-- 20261022100100_lotes_consumo  (F18 · H101 + H102, ADR-059)
--
-- Consumo por lote y trazabilidad (lote y n° de despacho → ventas) SIN tocar
-- create_sale, void_sale ni las devoluciones de venta.
--
-- Modelo:
--   • product_lots.qty_available: lo que queda del lote en su sucursal.
--   • lot_allocations: libro de consumos por lote. qty > 0 = salió del lote
--     (venta, devolución al proveedor, anulación de la recepción); qty < 0 =
--     volvió al lote (anulación de la venta, devolución del cliente). lot_id
--     null = unidades vendidas de un producto con lotes que no tenían lote con
--     saldo en esa sucursal ("sin lote"): queda a la vista, nunca bloquea.
--
-- Asignación: trigger AFTER INSERT en stock_movements (la venta ya inserta un
-- movimiento 'sale' por línea y componente de kit con la sucursal del turno):
--   • 'sale' (delta < 0): consume de los lotes de esa sucursal con saldo, por
--     vencimiento (los que vencen antes primero, FEFO) y, sin vencimiento o
--     empatados, por antigüedad de ingreso (FIFO). Lo que no alcanza queda
--     "sin lote".
--   • 'sale_void' (delta > 0, referencia = venta): devuelve lo consumido por
--     esa venta (primero lo "sin lote", después los lotes del último al
--     primero).
--   • 'return' (delta > 0, referencia = devolución): igual que la anulación,
--     contra la venta de la devolución.
-- Sólo trabaja con productos que tienen lotes: un negocio sin lotes no paga
-- nada más que un exists por movimiento.
--
-- Traslados: el lote queda en la sucursal donde se recibió; lo que se vende en
-- otra sucursal sale "sin lote" (pendiente: mover lotes en traslados).
-- =============================================================================

alter table product_lots add column if not exists qty_available numeric(12,3);
alter table product_lots add column if not exists voided_at timestamptz;

comment on column product_lots.qty_available is
  'Saldo del lote en su sucursal (F18, ADR-059). Lo mantienen lot_allocations y las RPC de compras.';
comment on column product_lots.voided_at is
  'Lote dado de baja por la anulación de su recepción (no consume ni recibe).';

-- Backfill: el stock actual de la sucursal se reparte en los lotes del más
-- nuevo al más viejo (lo más viejo se vendió primero).
with ranked as (
  select l.id, l.qty_received,
         coalesce(ps.qty, 0) as store_qty,
         sum(l.qty_received) over (
           partition by l.product_id, l.variant_id, l.store_id
           order by l.created_at desc, l.id desc
         ) as cum
    from product_lots l
    left join product_stock ps
      on ps.store_id = l.store_id and ps.product_id = l.product_id
     and ps.variant_id is not distinct from l.variant_id
   where l.qty_available is null
)
update product_lots l
   set qty_available = greatest(0, least(r.qty_received, r.store_qty - (r.cum - r.qty_received)))
  from ranked r
 where r.id = l.id;

update product_lots set qty_available = 0 where qty_available is null;

create or replace function trg_product_lots_defaults()
returns trigger
language plpgsql
as $$
begin
  if new.qty_available is null then
    new.qty_available := coalesce(new.qty_received, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists product_lots_defaults on product_lots;
create trigger product_lots_defaults
  before insert on product_lots
  for each row execute function trg_product_lots_defaults();

create index if not exists product_lots_available_idx
  on product_lots(product_id, store_id, expires_on, created_at)
  where voided_at is null and qty_available > 0;

-- -----------------------------------------------------------------------------
-- Libro de consumos por lote.
-- -----------------------------------------------------------------------------
create table if not exists lot_allocations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  lot_id            uuid references product_lots(id) on delete cascade,
  product_id        uuid not null references products(id) on delete cascade,
  variant_id        uuid references product_variants(id) on delete cascade,
  store_id          uuid references stores(id),
  stock_movement_id uuid,
  kind              text not null check (kind in ('sale','sale_void','return','purchase_return','receipt_void')),
  sale_id           uuid references sales(id) on delete cascade,
  sale_item_id      uuid,
  reference_id      uuid,
  qty               numeric(12,3) not null check (qty <> 0),
  created_at        timestamptz not null default now()
);

comment on table lot_allocations is
  'Consumos por lote (F18, ADR-059): qty > 0 sale del lote, qty < 0 vuelve. lot_id null = vendido sin lote con saldo.';

create index if not exists lot_allocations_lot_idx on lot_allocations(lot_id, created_at);
create index if not exists lot_allocations_sale_idx on lot_allocations(sale_id, product_id) where sale_id is not null;
create index if not exists lot_allocations_tenant_idx on lot_allocations(tenant_id, created_at desc);

alter table lot_allocations enable row level security;
-- Sólo lectura: lo escriben el trigger y las RPC de compras.
drop policy if exists lot_allocations_select on lot_allocations;
create policy lot_allocations_select on lot_allocations
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- Consume p_qty de los lotes (FEFO/FIFO) o de un lote puntual. Devuelve lo
-- asignado a lotes; con p_allow_unassigned el resto queda "sin lote".
create or replace function _lot_consume(
  p_tenant           uuid,
  p_product          uuid,
  p_variant          uuid,
  p_store            uuid,
  p_qty              numeric,
  p_kind             text,
  p_movement         uuid default null,
  p_sale             uuid default null,
  p_sale_item        uuid default null,
  p_reference        uuid default null,
  p_lot              uuid default null,
  p_allow_unassigned boolean default true
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_left numeric := coalesce(p_qty, 0);
  v_lot  record;
  v_take numeric;
begin
  if v_left <= 0 then
    return 0;
  end if;
  for v_lot in
    select l.id, l.qty_available
      from product_lots l
     where l.tenant_id = p_tenant
       and l.product_id = p_product
       and l.variant_id is not distinct from p_variant
       and l.voided_at is null
       and l.qty_available > 0
       and (p_lot is not null and l.id = p_lot
            or p_lot is null and l.store_id is not distinct from p_store)
     order by l.expires_on asc nulls last, l.created_at asc, l.id
     for update
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_lot.qty_available);
    update product_lots set qty_available = qty_available - v_take where id = v_lot.id;
    insert into lot_allocations (tenant_id, lot_id, product_id, variant_id, store_id, stock_movement_id, kind,
                                 sale_id, sale_item_id, reference_id, qty)
    values (p_tenant, v_lot.id, p_product, p_variant, p_store, p_movement, p_kind,
            p_sale, p_sale_item, p_reference, v_take);
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    if not p_allow_unassigned then
      raise exception 'lot_insufficient';
    end if;
    insert into lot_allocations (tenant_id, lot_id, product_id, variant_id, store_id, stock_movement_id, kind,
                                 sale_id, sale_item_id, reference_id, qty)
    values (p_tenant, null, p_product, p_variant, p_store, p_movement, p_kind,
            p_sale, p_sale_item, p_reference, v_left);
  end if;
  return coalesce(p_qty, 0) - v_left;
end;
$$;
revoke all on function _lot_consume(uuid, uuid, uuid, uuid, numeric, text, uuid, uuid, uuid, uuid, uuid, boolean)
  from public, anon, authenticated;

-- Devuelve hasta p_qty de lo que consumió una venta (lo "sin lote" primero,
-- después los lotes del último consumo al primero).
create or replace function _lot_release_sale(
  p_tenant    uuid,
  p_sale      uuid,
  p_product   uuid,
  p_variant   uuid,
  p_qty       numeric,
  p_kind      text,
  p_movement  uuid default null,
  p_reference uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_left numeric := coalesce(p_qty, 0);
  v_row  record;
  v_take numeric;
begin
  for v_row in
    select a.lot_id, sum(a.qty) as net, max(a.created_at) as last_at, min(a.store_id::text)::uuid as store_id
      from lot_allocations a
     where a.sale_id = p_sale
       and a.product_id = p_product
       and a.variant_id is not distinct from p_variant
     group by a.lot_id
    having sum(a.qty) > 0
     order by (a.lot_id is null) desc, max(a.created_at) desc
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_row.net);
    if v_row.lot_id is not null then
      update product_lots set qty_available = qty_available + v_take
       where id = v_row.lot_id and voided_at is null;
    end if;
    insert into lot_allocations (tenant_id, lot_id, product_id, variant_id, store_id, stock_movement_id, kind,
                                 sale_id, reference_id, qty)
    values (p_tenant, v_row.lot_id, p_product, p_variant, v_row.store_id, p_movement, p_kind,
            p_sale, p_reference, -v_take);
    v_left := v_left - v_take;
  end loop;
  return coalesce(p_qty, 0) - v_left;
end;
$$;
revoke all on function _lot_release_sale(uuid, uuid, uuid, uuid, numeric, text, uuid, uuid)
  from public, anon, authenticated;

-- Trigger: asigna lotes a las ventas y los devuelve en anulaciones y
-- devoluciones de clientes. Nunca bloquea el movimiento de stock.
create or replace function trg_stock_movement_lots()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale uuid;
  v_item uuid;
begin
  if new.reference_id is null then
    return null;
  end if;

  if new.reason = 'sale' and new.delta < 0 then
    if not exists (
      select 1 from product_lots l
       where l.product_id = new.product_id and l.voided_at is null
         and l.variant_id is not distinct from new.variant_id
    ) then
      return null;
    end if;
    select si.id into v_item
      from sale_items si
     where si.sale_id = new.reference_id and si.product_id = new.product_id
       and si.variant_id is not distinct from new.variant_id
     order by si.created_at, si.id
     limit 1;
    perform _lot_consume(new.tenant_id, new.product_id, new.variant_id, new.store_id, -new.delta, 'sale',
                         new.id, new.reference_id, v_item, null, null, true);
    return null;
  end if;

  if new.reason in ('sale_void', 'return') and new.delta > 0 then
    if new.reason = 'sale_void' then
      v_sale := new.reference_id;
    else
      select r.sale_id into v_sale from sale_returns r where r.id = new.reference_id;
    end if;
    if v_sale is null or not exists (
      select 1 from lot_allocations a where a.sale_id = v_sale and a.product_id = new.product_id
    ) then
      return null;
    end if;
    perform _lot_release_sale(new.tenant_id, v_sale, new.product_id, new.variant_id, new.delta, new.reason,
                              new.id, case when new.reason = 'return' then new.reference_id end);
  end if;
  return null;
end;
$$;
revoke all on function trg_stock_movement_lots() from public, anon, authenticated;

drop trigger if exists stock_movement_lots on stock_movements;
create trigger stock_movement_lots
  after insert on stock_movements
  for each row
  when (new.reason in ('sale', 'sale_void', 'return'))
  execute function trg_stock_movement_lots();

-- -----------------------------------------------------------------------------
-- Trazabilidad: qué ventas se llevaron cada lote (neto de anulaciones y
-- devoluciones). Vista con la RLS de quien consulta.
-- -----------------------------------------------------------------------------
create or replace view lot_sales
with (security_invoker = true) as
  select a.tenant_id,
         a.lot_id,
         l.lot_code,
         l.dispatch_number,
         l.expires_on,
         a.product_id,
         a.variant_id,
         s.store_id,
         a.sale_id,
         s.number      as sale_number,
         s.created_at  as sold_at,
         s.customer_id,
         s.status      as sale_status,
         sum(a.qty)    as qty
    from lot_allocations a
    join product_lots l on l.id = a.lot_id
    join sales s on s.id = a.sale_id
   where a.sale_id is not null
   group by a.tenant_id, a.lot_id, l.lot_code, l.dispatch_number, l.expires_on, a.product_id, a.variant_id,
            s.store_id, a.sale_id, s.number, s.created_at, s.customer_id, s.status;

revoke all on lot_sales from anon;
grant select on lot_sales to authenticated;
