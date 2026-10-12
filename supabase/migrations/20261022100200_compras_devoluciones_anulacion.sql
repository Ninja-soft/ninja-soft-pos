-- =============================================================================
-- 20261022100200_compras_devoluciones_anulacion  (F18 · H101, ADR-059)
--
-- A) Devoluciones a proveedor (purchase_returns): desde una recepción o
--    libres, por sucursal. Cada línea:
--      • saca stock de la sucursal (movimiento 'purchase_return'),
--      • descuenta del lote (el de la línea de la recepción o el elegido; si
--        no, por vencimiento y antigüedad),
--      • recalcula el costo promedio sacando esas unidades a su costo:
--          promedio nuevo = (S × P − q × c) / (S − q)   (S = stock antes,
--          P = promedio, q = unidades devueltas, c = costo de la línea).
--        Si no queda stock el promedio no cambia; nunca es negativo. El
--        último costo no cambia (sigue siendo el último precio de compra).
--    El crédito en la cuenta corriente del proveedor lo da la nota de
--    crédito: se carga junto con la devolución o después
--    (purchase_return_link_credit_note). Mientras no hay NC la devolución
--    queda "NC pendiente".
-- B) Anulación de recepciones (purchase_receipt_void), dueño o encargado,
--    con motivo. Exige: sin factura vinculada, sin devoluciones, lotes sin
--    consumir y stock suficiente en la sucursal. Revierte:
--      • stock (movimiento 'purchase_void' por línea),
--      • promedio con la misma fórmula de salida al costo valuado de la línea
--        (incluido el costeo de importación),
--      • último costo: si la recepción era la última del producto vuelve al
--        costo de la recepción vigente anterior; si no había otra, al valor
--        previo de la historia de costos,
--      • último costo del proveedor (misma regla),
--      • cantidades recibidas de la OC y su estado (enviada, recibida en
--        parte o recibida),
--      • lotes de la recepción: se dan de baja.
--    La recepción queda 'voided' (no se borra) y no admite más cambios.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Estado de la recepción y cantidades devueltas.
-- -----------------------------------------------------------------------------
alter table goods_receipts add column if not exists status text not null default 'posted';
alter table goods_receipts add column if not exists void_reason text;
alter table goods_receipts add column if not exists voided_at timestamptz;
alter table goods_receipts add column if not exists voided_by uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'goods_receipts_status_check') then
    alter table goods_receipts add constraint goods_receipts_status_check
      check (status in ('posted', 'voided'));
  end if;
end $$;

alter table goods_receipt_items add column if not exists qty_returned numeric(12,3) not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'goods_receipt_items_returned_check') then
    alter table goods_receipt_items add constraint goods_receipt_items_returned_check
      check (qty_returned >= 0 and qty_returned <= qty);
  end if;
end $$;

-- Una recepción anulada no cambia más (costeo, factura ni nada).
create or replace function trg_goods_receipts_voided_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'voided' then
    raise exception 'receipt_voided';
  end if;
  return new;
end;
$$;

drop trigger if exists goods_receipts_voided_guard on goods_receipts;
create trigger goods_receipts_voided_guard
  before update on goods_receipts
  for each row execute function trg_goods_receipts_voided_guard();

-- Timeline: entidad 'return'.
alter table purchase_events drop constraint if exists purchase_events_entity_check;
alter table purchase_events add constraint purchase_events_entity_check
  check (entity in ('order','receipt','invoice','payment','return'));

-- purchase_log: copia de 20261016100200 + entidad 'return'.
create or replace function purchase_log(
  p_tenant uuid, p_entity text, p_id uuid, p_kind text,
  p_from text, p_to text, p_notes text default null, p_data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into purchase_events (tenant_id, entity, entity_id, kind, from_status, to_status, actor_id, notes, data)
  values (p_tenant, p_entity, p_id, p_kind, p_from, p_to, auth.uid(),
          nullif(trim(coalesce(p_notes, '')), ''), coalesce(p_data, '{}'::jsonb));

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(),
          case p_entity when 'order' then 'purchase_orders' when 'receipt' then 'goods_receipts'
                        when 'invoice' then 'supplier_invoices' when 'return' then 'purchase_returns'
                        else 'supplier_payments' end,
          p_id, 'purchase_' || p_entity || '_' || p_kind,
          case when p_from is null then null else jsonb_build_object('status', p_from) end,
          jsonb_build_object('status', p_to) || coalesce(p_data, '{}'::jsonb),
          nullif(trim(coalesce(p_notes, '')), ''));
end;
$$;
revoke all on function purchase_log(uuid, text, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- Promedio después de sacar q unidades a costo c (espejo de
-- averageAfterOutflow en lib/purchases/returns.ts).
create or replace function purchase_avg_after_outflow(
  p_stock_before numeric, p_avg numeric, p_qty numeric, p_unit_cost numeric
)
returns numeric
language plpgsql
immutable
as $$
declare
  s numeric := greatest(coalesce(p_stock_before, 0), 0);
  r numeric;
begin
  if p_avg is null or coalesce(p_qty, 0) <= 0 then
    return p_avg;
  end if;
  r := s - p_qty;
  if r <= 0 then
    return p_avg;
  end if;
  return greatest(round((s * p_avg - p_qty * coalesce(p_unit_cost, 0)) / r, 4), 0);
end;
$$;

-- Stock total del producto (suma de variantes si tiene).
create or replace function purchase_total_stock(p_product uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when coalesce(p.has_variants, false)
              then (select coalesce(sum(v.stock), 0) from product_variants v
                     where v.product_id = p.id and v.deleted_at is null)
              else coalesce(p.stock, 0) end
    from products p where p.id = p_product;
$$;
revoke all on function purchase_total_stock(uuid) from public, anon, authenticated;

-- Stock de un producto o variante en una sucursal.
create or replace function purchase_store_qty(p_store uuid, p_product uuid, p_variant uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select ps.qty from product_stock ps
                    where ps.store_id = p_store and ps.product_id = p_product
                      and ps.variant_id is not distinct from p_variant), 0);
$$;
revoke all on function purchase_store_qty(uuid, uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- A) Devoluciones a proveedor.
-- -----------------------------------------------------------------------------
create table if not exists purchase_returns (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  number            int not null,
  supplier_id       uuid not null references suppliers(id),
  store_id          uuid not null references stores(id),
  receipt_id        uuid references goods_receipts(id),
  return_date       date not null default current_date,
  reason            text not null default 'otro'
                      check (reason in ('danado','vencido','error_proveedor','sobrante','calidad','otro')),
  notes             text check (notes is null or char_length(notes) <= 1000),
  total_units       numeric(14,3) not null default 0,
  total_cost        numeric(14,2) not null default 0,
  credit_invoice_id uuid references supplier_invoices(id),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint purchase_returns_tenant_number_key unique (tenant_id, number)
);

comment on table purchase_returns is
  'Devoluciones a proveedor (F18, ADR-059). El crédito en la cuenta corriente lo da la nota de crédito vinculada (credit_invoice_id).';
comment on column purchase_returns.total_cost is 'Valor devuelto en pesos a costo neto de IVA.';

create index if not exists purchase_returns_tenant_idx on purchase_returns(tenant_id, created_at desc);
create index if not exists purchase_returns_receipt_idx on purchase_returns(receipt_id);
create index if not exists purchase_returns_supplier_idx on purchase_returns(supplier_id);
create unique index if not exists purchase_returns_credit_key
  on purchase_returns(credit_invoice_id) where credit_invoice_id is not null;

drop trigger if exists set_updated_at_purchase_returns on purchase_returns;
create trigger set_updated_at_purchase_returns
  before update on purchase_returns
  for each row execute function set_updated_at();

create table if not exists purchase_return_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  return_id       uuid not null references purchase_returns(id) on delete cascade,
  receipt_item_id uuid references goods_receipt_items(id),
  lot_id          uuid references product_lots(id),
  product_id      uuid not null references products(id),
  variant_id      uuid references product_variants(id),
  product_name    text not null,
  variant_label   text,
  sku             text,
  unit            text not null default 'un',
  qty             numeric(12,3) not null check (qty > 0),
  unit_cost_ars   numeric(14,4) not null default 0 check (unit_cost_ars >= 0),
  avg_before      numeric(14,4),
  avg_after       numeric(14,4),
  notes           text check (notes is null or char_length(notes) <= 200),
  sort            int not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists purchase_return_items_return_idx on purchase_return_items(return_id, sort);
create index if not exists purchase_return_items_receipt_item_idx on purchase_return_items(receipt_item_id);
create index if not exists purchase_return_items_tenant_idx on purchase_return_items(tenant_id);

alter table purchase_returns enable row level security;
alter table purchase_return_items enable row level security;

drop policy if exists purchase_returns_select on purchase_returns;
create policy purchase_returns_select on purchase_returns
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists purchase_return_items_select on purchase_return_items;
create policy purchase_return_items_select on purchase_return_items
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- Anular la NC deja la devolución otra vez con "NC pendiente".
create or replace function trg_supplier_invoices_unlink_return()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'voided' and old.status is distinct from 'voided' then
    update purchase_returns set credit_invoice_id = null where credit_invoice_id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function trg_supplier_invoices_unlink_return() from public, anon, authenticated;

drop trigger if exists supplier_invoices_unlink_return on supplier_invoices;
create trigger supplier_invoices_unlink_return
  after update of status on supplier_invoices
  for each row execute function trg_supplier_invoices_unlink_return();

-- p: {receipt_id?, supplier_id?, store_id?, return_date?, reason?, notes?,
--     items: [{receipt_item_id? | product_id + variant_id?, lot_id?, qty,
--              unit_cost?, notes?}],
--     credit_note?: {letter, point_of_sale, number, issue_date, due_date?,
--                    vat_lines, exempt_amount?, non_taxed_amount?,
--                    other_taxes?, total, notes?}}
create or replace function purchase_return_create(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := purchase_assert(true);
  v_role     text := stock_my_role();
  v_rec      goods_receipts;
  v_ret      purchase_returns;
  v_number   int;
  v_store    uuid;
  v_supplier uuid;
  v_in       record;
  v_gi       goods_receipt_items;
  v_prod     record;
  v_var_id   uuid;
  v_var_lbl  text;
  v_var_sku  text;
  v_lot      uuid;
  v_cost     numeric;
  v_stock    numeric;
  v_avg      numeric;
  v_mov      uuid;
  v_sort     int := 0;
  v_units    numeric := 0;
  v_value    numeric := 0;
  v_reason   text := coalesce(nullif(p ->> 'reason', ''), 'otro');
  v_inv      uuid;
begin
  if p -> 'items' is null or jsonb_typeof(p -> 'items') <> 'array' then
    raise exception 'invalid_items';
  end if;

  if nullif(p ->> 'receipt_id', '') is not null then
    select * into v_rec from goods_receipts
     where id = (p ->> 'receipt_id')::uuid and tenant_id = v_tenant and deleted_at is null
     for update;
    if v_rec.id is null then
      raise exception 'receipt_not_found';
    end if;
    if v_rec.status <> 'posted' then
      raise exception 'receipt_voided';
    end if;
    v_store := v_rec.store_id;
    v_supplier := coalesce(v_rec.supplier_id, (nullif(p ->> 'supplier_id', ''))::uuid);
  else
    v_store := (nullif(p ->> 'store_id', ''))::uuid;
    v_supplier := (nullif(p ->> 'supplier_id', ''))::uuid;
  end if;

  if v_supplier is null or not exists (
    select 1 from suppliers where id = v_supplier and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'supplier_not_found';
  end if;
  if v_store is null or not exists (
    select 1 from stores where id = v_store and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;
  if v_role <> 'owner' and not user_can_access_store(v_store) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('purchase_return_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from purchase_returns where tenant_id = v_tenant;
  insert into purchase_returns (tenant_id, number, supplier_id, store_id, receipt_id, return_date, reason, notes,
                                created_by)
  values (v_tenant, v_number, v_supplier, v_store, v_rec.id,
          coalesce((nullif(p ->> 'return_date', ''))::date, current_date), v_reason,
          nullif(trim(coalesce(p ->> 'notes', '')), ''), auth.uid())
  returning * into v_ret;

  perform set_config('ninja.cost_source', 'purchase_return', true);
  perform set_config('ninja.cost_reference', v_ret.id::text, true);

  for v_in in
    select (x.value ->> 'receipt_item_id')::uuid as receipt_item_id,
           (x.value ->> 'product_id')::uuid as product_id,
           (x.value ->> 'variant_id')::uuid as variant_id,
           (x.value ->> 'lot_id')::uuid as lot_id,
           coalesce((x.value ->> 'qty')::numeric, 0) as qty,
           (x.value ->> 'unit_cost')::numeric as unit_cost,
           nullif(trim(coalesce(x.value ->> 'notes', '')), '') as notes
      from jsonb_array_elements(p -> 'items') as x(value)
  loop
    continue when v_in.qty = 0;
    if v_in.qty < 0 then
      raise exception 'invalid_qty';
    end if;

    v_gi := null;
    if v_in.receipt_item_id is not null then
      if v_rec.id is null then
        raise exception 'receipt_item_without_receipt';
      end if;
      select * into v_gi from goods_receipt_items
       where id = v_in.receipt_item_id and receipt_id = v_rec.id
       for update;
      if v_gi.id is null then
        raise exception 'item_not_found';
      end if;
      if v_in.qty > v_gi.qty - v_gi.qty_returned then
        raise exception 'return_exceeds_received: %', v_gi.product_name;
      end if;
    elsif v_in.product_id is null then
      raise exception 'product_required';
    end if;

    select id, name, sku, unit, is_kit, has_variants, track_stock, stock, last_cost, avg_cost, cost
      into v_prod
      from products
     where id = coalesce(v_gi.product_id, v_in.product_id) and tenant_id = v_tenant and deleted_at is null
     for update;
    if v_prod.id is null then
      raise exception 'product_not_found';
    end if;
    if coalesce(v_prod.is_kit, false) then
      raise exception 'kit_not_purchasable';
    end if;

    v_var_id := coalesce(v_gi.variant_id, v_in.variant_id);
    v_var_lbl := v_gi.variant_label;
    v_var_sku := null;
    if coalesce(v_prod.has_variants, false) then
      if v_var_id is null then
        raise exception 'variant_required';
      end if;
      select id, option1 || coalesce(' / ' || option2, ''), sku into v_var_id, v_var_lbl, v_var_sku
        from product_variants
       where id = v_var_id and product_id = v_prod.id and tenant_id = v_tenant;
      if v_var_id is null then
        raise exception 'variant_not_found';
      end if;
    elsif v_var_id is not null then
      raise exception 'variant_not_allowed';
    end if;

    -- Lote: el de la línea de la recepción o el elegido (de esa sucursal).
    v_lot := null;
    if v_gi.id is not null then
      select id into v_lot from product_lots where receipt_item_id = v_gi.id and voided_at is null;
    elsif v_in.lot_id is not null then
      select id into v_lot from product_lots
       where id = v_in.lot_id and tenant_id = v_tenant and product_id = v_prod.id
         and variant_id is not distinct from v_var_id and store_id = v_store and voided_at is null;
      if v_lot is null then
        raise exception 'lot_not_found';
      end if;
    end if;

    v_cost := coalesce(v_gi.valued_unit_cost, v_in.unit_cost, v_prod.avg_cost, v_prod.last_cost, v_prod.cost, 0);
    if v_cost < 0 then
      raise exception 'invalid_cost';
    end if;

    v_stock := purchase_total_stock(v_prod.id);
    v_avg := v_prod.avg_cost;

    if coalesce(v_prod.track_stock, true) then
      if purchase_store_qty(v_store, v_prod.id, v_var_id) < v_in.qty then
        raise exception 'return_exceeds_stock: %', v_prod.name;
      end if;
      if v_var_id is null then
        update products set stock = stock - v_in.qty, updated_at = now() where id = v_prod.id;
      else
        update product_variants set stock = stock - v_in.qty, updated_at = now() where id = v_var_id;
      end if;
      insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id,
                                   notes, created_by)
      values (v_tenant, v_prod.id, v_var_id, v_store, -v_in.qty, 'purchase_return', v_ret.id,
              'Devolución DEV-' || lpad(v_number::text, 6, '0'), auth.uid())
      returning id into v_mov;

      v_avg := purchase_avg_after_outflow(v_stock, v_prod.avg_cost, v_in.qty, v_cost);
      if v_avg is distinct from v_prod.avg_cost then
        update products set avg_cost = v_avg, updated_at = now() where id = v_prod.id;
      end if;

      if v_lot is not null then
        perform _lot_consume(v_tenant, v_prod.id, v_var_id, v_store, v_in.qty, 'purchase_return', v_mov,
                             null, null, v_ret.id, v_lot, false);
      elsif exists (
        select 1 from product_lots l
         where l.product_id = v_prod.id and l.variant_id is not distinct from v_var_id
           and l.store_id = v_store and l.voided_at is null and l.qty_available > 0
      ) then
        perform _lot_consume(v_tenant, v_prod.id, v_var_id, v_store, v_in.qty, 'purchase_return', v_mov,
                             null, null, v_ret.id, null, true);
      end if;
    end if;

    if v_gi.id is not null then
      update goods_receipt_items set qty_returned = qty_returned + v_in.qty where id = v_gi.id;
    end if;

    v_sort := v_sort + 1;
    insert into purchase_return_items (tenant_id, return_id, receipt_item_id, lot_id, product_id, variant_id,
                                       product_name, variant_label, sku, unit, qty, unit_cost_ars, avg_before,
                                       avg_after, notes, sort)
    values (v_tenant, v_ret.id, v_gi.id, v_lot, v_prod.id, v_var_id, v_prod.name, v_var_lbl,
            coalesce(v_var_sku, v_gi.sku, v_prod.sku), coalesce(v_prod.unit, 'un'), v_in.qty, round(v_cost, 4),
            v_prod.avg_cost, v_avg, v_in.notes, v_sort);

    v_units := v_units + v_in.qty;
    v_value := v_value + v_in.qty * v_cost;
  end loop;

  perform set_config('ninja.cost_source', '', true);
  perform set_config('ninja.cost_reference', '', true);

  if v_sort = 0 then
    raise exception 'return_empty';
  end if;

  update purchase_returns set total_units = v_units, total_cost = round(v_value, 2)
   where id = v_ret.id
  returning * into v_ret;

  -- Nota de crédito del proveedor (opcional): misma validación que cualquier
  -- comprobante (supplier_invoice_save).
  if jsonb_typeof(p -> 'credit_note') = 'object' then
    v_inv := supplier_invoice_save(
      null,
      (p -> 'credit_note') || jsonb_build_object('supplier_id', v_supplier, 'kind', 'credit_note',
                                                 'order_id', v_rec.order_id),
      null
    );
    update purchase_returns set credit_invoice_id = v_inv where id = v_ret.id;
  end if;

  perform purchase_log(v_tenant, 'return', v_ret.id, 'created', null, 'posted', p ->> 'notes',
                       jsonb_build_object('number', v_number, 'receipt_id', v_rec.id, 'store_id', v_store,
                                          'supplier_id', v_supplier, 'units', v_units,
                                          'value', round(v_value, 2), 'credit_invoice_id', v_inv,
                                          'reason', v_reason));
  if v_rec.id is not null then
    perform purchase_log(v_tenant, 'receipt', v_rec.id, 'returned', 'posted', 'posted', null,
                         jsonb_build_object('return_id', v_ret.id, 'units', v_units));
  end if;
  return v_ret.id;
end;
$$;
revoke all on function purchase_return_create(jsonb) from public, anon;
grant execute on function purchase_return_create(jsonb) to authenticated;

-- Vincular la NC del proveedor que llegó después.
create or replace function purchase_return_link_credit_note(p_return_id uuid, p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_ret    purchase_returns;
  v_inv    supplier_invoices;
begin
  select * into v_ret from purchase_returns where id = p_return_id and tenant_id = v_tenant for update;
  if v_ret.id is null then
    raise exception 'return_not_found';
  end if;
  if p_invoice_id is null then
    update purchase_returns set credit_invoice_id = null where id = v_ret.id;
    perform purchase_log(v_tenant, 'return', v_ret.id, 'credit_unlinked', 'posted', 'posted', null,
                         jsonb_build_object('previous', v_ret.credit_invoice_id));
    return;
  end if;
  select * into v_inv from supplier_invoices where id = p_invoice_id and tenant_id = v_tenant;
  if v_inv.id is null or v_inv.status <> 'posted' or v_inv.kind <> 'credit_note'
     or v_inv.supplier_id <> v_ret.supplier_id then
    raise exception 'credit_note_not_linkable';
  end if;
  if exists (select 1 from purchase_returns where credit_invoice_id = p_invoice_id and id <> v_ret.id) then
    raise exception 'credit_note_not_linkable';
  end if;
  update purchase_returns set credit_invoice_id = p_invoice_id where id = v_ret.id;
  perform purchase_log(v_tenant, 'return', v_ret.id, 'credit_linked', 'posted', 'posted', null,
                       jsonb_build_object('invoice_id', p_invoice_id, 'total', v_inv.total));
end;
$$;
revoke all on function purchase_return_link_credit_note(uuid, uuid) from public, anon;
grant execute on function purchase_return_link_credit_note(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Anulación de recepciones.
-- -----------------------------------------------------------------------------
create or replace function purchase_receipt_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := purchase_assert(true);
  v_role    text := stock_my_role();
  v_r       goods_receipts;
  v_it      goods_receipt_items;
  v_prod    record;
  v_stock   numeric;
  v_avg     numeric;
  v_latest  uuid;
  v_prev    record;
  v_last    numeric;
  v_lot     product_lots;
  v_o       purchase_orders;
  v_open    boolean;
  v_to      text;
  v_units   numeric := 0;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_r from goods_receipts
   where id = p_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if v_r.id is null then
    raise exception 'receipt_not_found';
  end if;
  if v_r.status <> 'posted' then
    raise exception 'receipt_voided';
  end if;
  if v_role <> 'owner' and not user_can_access_store(v_r.store_id) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_r.invoice_id is not null then
    raise exception 'receipt_invoiced';
  end if;
  if exists (select 1 from purchase_returns where receipt_id = v_r.id) then
    raise exception 'receipt_has_returns';
  end if;
  if exists (
    select 1 from product_lots l
      join goods_receipt_items gi on gi.id = l.receipt_item_id
     where gi.receipt_id = v_r.id and l.voided_at is null and l.qty_available < l.qty_received
  ) then
    raise exception 'receipt_lots_consumed';
  end if;

  perform set_config('ninja.cost_source', 'receipt_void', true);
  perform set_config('ninja.cost_reference', v_r.id::text, true);

  for v_it in
    select * from goods_receipt_items where receipt_id = v_r.id and qty > 0 order by sort
  loop
    select id, name, has_variants, track_stock, stock, avg_cost, last_cost into v_prod
      from products where id = v_it.product_id for update;

    v_stock := purchase_total_stock(v_prod.id);
    v_avg := v_prod.avg_cost;

    if coalesce(v_prod.track_stock, true) then
      if purchase_store_qty(v_r.store_id, v_prod.id, v_it.variant_id) < v_it.qty then
        raise exception 'receipt_stock_consumed: %', v_prod.name;
      end if;
      if v_it.variant_id is null then
        update products set stock = stock - v_it.qty, updated_at = now() where id = v_prod.id;
      else
        update product_variants set stock = stock - v_it.qty, updated_at = now() where id = v_it.variant_id;
      end if;
      insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id,
                                   notes, created_by)
      values (v_tenant, v_prod.id, v_it.variant_id, v_r.store_id, -v_it.qty, 'purchase_void', v_r.id,
              'Anulación REC-' || lpad(v_r.number::text, 6, '0'), auth.uid());
      v_avg := purchase_avg_after_outflow(v_stock, v_prod.avg_cost, v_it.qty, v_it.valued_unit_cost);
    end if;

    -- Último costo: sólo si esta recepción era la más reciente del producto.
    select gi.receipt_id into v_latest
      from goods_receipt_items gi
      join goods_receipts g on g.id = gi.receipt_id
     where gi.product_id = v_prod.id and gi.qty > 0 and g.deleted_at is null and g.status = 'posted'
     order by g.received_date desc, g.created_at desc
     limit 1;
    v_last := v_prod.last_cost;
    if v_latest = v_r.id then
      select gi.valued_unit_cost into v_last
        from goods_receipt_items gi
        join goods_receipts g on g.id = gi.receipt_id
       where gi.product_id = v_prod.id and gi.qty > 0 and g.deleted_at is null and g.status = 'posted'
         and g.id <> v_r.id
       order by g.received_date desc, g.created_at desc
       limit 1;
      if v_last is null then
        select h.old_value into v_last
          from product_cost_history h
         where h.product_id = v_prod.id and h.kind = 'last' and h.reference_id = v_r.id
         order by h.created_at asc
         limit 1;
      end if;
      v_last := coalesce(v_last, v_prod.last_cost);
    end if;

    if v_avg is distinct from v_prod.avg_cost or v_last is distinct from v_prod.last_cost then
      update products set avg_cost = v_avg, last_cost = v_last, updated_at = now() where id = v_prod.id;
    end if;

    -- Último costo del proveedor: la recepción vigente anterior de ese proveedor.
    if v_r.supplier_id is not null then
      select gi.unit_cost, g.currency into v_prev
        from goods_receipt_items gi
        join goods_receipts g on g.id = gi.receipt_id
       where gi.product_id = v_prod.id and gi.variant_id is not distinct from v_it.variant_id
         and gi.qty > 0 and g.supplier_id = v_r.supplier_id and g.deleted_at is null and g.status = 'posted'
         and g.id <> v_r.id
       order by g.received_date desc, g.created_at desc
       limit 1;
      if v_prev.unit_cost is not null then
        update supplier_products
           set last_cost = v_prev.unit_cost, currency = v_prev.currency
         where supplier_id = v_r.supplier_id and product_id = v_prod.id
           and variant_id is not distinct from v_it.variant_id and deleted_at is null;
      end if;
    end if;

    -- Lote de la línea: baja.
    select * into v_lot from product_lots where receipt_item_id = v_it.id and voided_at is null for update;
    if v_lot.id is not null then
      if v_lot.qty_available > 0 then
        insert into lot_allocations (tenant_id, lot_id, product_id, variant_id, store_id, kind, reference_id, qty)
        values (v_tenant, v_lot.id, v_lot.product_id, v_lot.variant_id, v_lot.store_id, 'receipt_void', v_r.id,
                v_lot.qty_available);
      end if;
      update product_lots set qty_available = 0, voided_at = now() where id = v_lot.id;
    end if;

    if v_it.order_item_id is not null then
      update purchase_order_items
         set qty_received = greatest(qty_received - v_it.qty, 0)
       where id = v_it.order_item_id;
    end if;
    v_units := v_units + v_it.qty;
  end loop;

  perform set_config('ninja.cost_source', '', true);
  perform set_config('ninja.cost_reference', '', true);

  -- OC: cantidades y estado.
  if v_r.order_id is not null then
    v_o := purchase_order_lock(v_tenant, v_r.order_id);
    v_o := purchase_order_recalc(v_o.id);
    if v_o.status in ('partially_received', 'received') then
      select exists (
        select 1 from purchase_order_items where order_id = v_o.id and qty_received < qty_ordered
      ) into v_open;
      v_to := case when v_o.units_received <= 0 then 'sent'
                   when v_open then 'partially_received'
                   else 'received' end;
      if v_to is distinct from v_o.status then
        update purchase_orders
           set status = v_to,
               received_at = case when v_to = 'received' then received_at else null end,
               close_reason = case when v_to = 'received' then close_reason else null end
         where id = v_o.id;
        perform purchase_log(v_tenant, 'order', v_o.id, 'receipt_voided', v_o.status, v_to, p_reason,
                             jsonb_build_object('receipt_id', v_r.id, 'units', v_units));
      end if;
    end if;
  end if;

  update goods_receipts
     set status = 'voided', void_reason = trim(p_reason), voided_at = now(), voided_by = auth.uid()
   where id = v_r.id;

  perform purchase_log(v_tenant, 'receipt', v_r.id, 'voided', 'posted', 'voided', p_reason,
                       jsonb_build_object('number', v_r.number, 'units', v_units, 'value', v_r.total_cost,
                                          'order_id', v_r.order_id));
end;
$$;
revoke all on function purchase_receipt_void(uuid, text) from public, anon;
grant execute on function purchase_receipt_void(uuid, text) to authenticated;
