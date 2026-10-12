-- =============================================================================
-- 20261016100200_compras_ordenes_recepciones  (F18 · H101 + H102, ADR-050)
--
-- Órdenes de compra, recepción de mercadería, lotes y costeo de importación.
--
-- Máquina de estados de la OC (espejo puro en lib/purchases/orders.ts):
--   draft ──send──▶ sent ──receive──▶ partially_received ──receive──▶ received
--     ▲              │  └──receive (completa)──────────────────────▶ received
--     └──reopen──────┘ (sólo si no se recibió nada)
--   partially_received ──close (con motivo)──▶ received
--   draft | sent ──cancel (con motivo, sin nada recibido)──▶ cancelled
--
-- Recepción (goods_receipts): contra una OC o libre; parcial; diferencias con
-- motivo; por sucursal destino. Cada línea recibida:
--   • suma stock en la sucursal (products/product_variants.stock + movimiento
--     'purchase' con store_id: product_stock lo mantiene el trigger de ADR-046),
--   • recalcula el costo promedio ponderado móvil y el último costo del
--     producto (en pesos, neto de IVA),
--   • actualiza el último costo del producto en ese proveedor.
-- Costeo de importación (compras_importacion): se aplica sobre una recepción ya
-- registrada. El cálculo (FOB, CIF, tributos, gastos y prorrateo) es lógica
-- pura en lib/purchases/landed.ts; el servidor guarda la hoja, el costo puesto
-- en depósito por línea y el n° de despacho en el lote, y ajusta el promedio
-- con la diferencia sobre el stock existente.
--
-- Todo por RPC SECURITY DEFINER con search_path fijo; las tablas sólo tienen
-- policies de lectura. Cada paso deja evento (purchase_events) y audit_logs.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Órdenes de compra.
-- -----------------------------------------------------------------------------
create table if not exists purchase_orders (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  number             int not null,
  supplier_id        uuid not null references suppliers(id),
  store_id           uuid not null references stores(id),
  status             text not null default 'draft'
                       check (status in ('draft','sent','partially_received','received','cancelled')),
  issue_date         date not null default current_date,
  expected_date      date,
  currency           text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  fx_rate            numeric(14,6) not null default 1 check (fx_rate > 0),
  discount_pct       numeric(6,3) not null default 0 check (discount_pct >= 0 and discount_pct < 100),
  payment_terms_days int check (payment_terms_days is null or payment_terms_days between 0 and 365),
  notes              text check (notes is null or char_length(notes) <= 1000),
  subtotal           numeric(14,2) not null default 0,
  discount_total     numeric(14,2) not null default 0,
  net_total          numeric(14,2) not null default 0,
  tax_total          numeric(14,2) not null default 0,
  total              numeric(14,2) not null default 0,
  units_ordered      numeric(14,3) not null default 0,
  units_received     numeric(14,3) not null default 0,
  sent_at            timestamptz,
  sent_by            uuid,
  received_at        timestamptz,
  close_reason       text,
  cancelled_at       timestamptz,
  cancelled_by       uuid,
  cancel_reason      text,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint purchase_orders_tenant_number_key unique (tenant_id, number)
);

create index if not exists purchase_orders_tenant_status_idx
  on purchase_orders(tenant_id, status, created_at desc) where deleted_at is null;
create index if not exists purchase_orders_supplier_idx on purchase_orders(supplier_id);
create index if not exists purchase_orders_store_idx on purchase_orders(store_id);

drop trigger if exists set_updated_at_purchase_orders on purchase_orders;
create trigger set_updated_at_purchase_orders
  before update on purchase_orders
  for each row execute function set_updated_at();

create table if not exists purchase_order_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  order_id      uuid not null references purchase_orders(id) on delete cascade,
  product_id    uuid not null references products(id),
  variant_id    uuid references product_variants(id),
  product_name  text not null,
  variant_label text,
  sku           text,
  supplier_sku  text,
  unit          text not null default 'un',
  qty_ordered   numeric(12,3) not null check (qty_ordered > 0),
  qty_received  numeric(12,3) not null default 0 check (qty_received >= 0),
  unit_cost     numeric(14,4) not null default 0 check (unit_cost >= 0),
  discounts     numeric(6,3)[] not null default '{}',
  tax_rate      numeric(5,2) not null default 21 check (tax_rate >= 0 and tax_rate <= 100),
  line_net      numeric(14,2) not null default 0,
  notes         text check (notes is null or char_length(notes) <= 200),
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists purchase_order_items_order_idx on purchase_order_items(order_id, sort);
create index if not exists purchase_order_items_product_idx on purchase_order_items(product_id, variant_id);
create index if not exists purchase_order_items_tenant_idx on purchase_order_items(tenant_id);

drop trigger if exists set_updated_at_purchase_order_items on purchase_order_items;
create trigger set_updated_at_purchase_order_items
  before update on purchase_order_items
  for each row execute function set_updated_at();

-- Timeline común de compras (órdenes, recepciones, facturas y pagos).
create table if not exists purchase_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  entity      text not null check (entity in ('order','receipt','invoice','payment')),
  entity_id   uuid not null,
  kind        text not null,
  from_status text,
  to_status   text,
  actor_id    uuid,
  notes       text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists purchase_events_entity_idx on purchase_events(entity_id, created_at);
create index if not exists purchase_events_tenant_idx on purchase_events(tenant_id);

-- -----------------------------------------------------------------------------
-- B) Recepciones, líneas y lotes.
-- -----------------------------------------------------------------------------
create table if not exists goods_receipts (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  number             int not null,
  order_id           uuid references purchase_orders(id),
  supplier_id        uuid references suppliers(id),
  store_id           uuid not null references stores(id),
  received_date      date not null default current_date,
  remito_number      text check (remito_number is null or char_length(remito_number) <= 40),
  currency           text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  fx_rate            numeric(14,6) not null default 1 check (fx_rate > 0),
  notes              text check (notes is null or char_length(notes) <= 1000),
  total_units        numeric(14,3) not null default 0,
  total_cost         numeric(14,2) not null default 0,
  landed_total       numeric(14,2),
  costing            jsonb,
  costing_applied_at timestamptz,
  costing_applied_by uuid,
  dispatch_number    text check (dispatch_number is null or dispatch_number ~ '^[0-9A-Z]{16}$'),
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint goods_receipts_tenant_number_key unique (tenant_id, number)
);

comment on column goods_receipts.total_cost is 'Valor de la recepción en pesos a costo neto de IVA (antes del costeo de importación).';
comment on column goods_receipts.dispatch_number is 'N° de despacho de importación (AAaaaTTTTnnnnnnX), también guardado en cada lote.';

create index if not exists goods_receipts_tenant_idx on goods_receipts(tenant_id, created_at desc) where deleted_at is null;
create index if not exists goods_receipts_order_idx on goods_receipts(order_id);
create index if not exists goods_receipts_supplier_idx on goods_receipts(supplier_id);

drop trigger if exists set_updated_at_goods_receipts on goods_receipts;
create trigger set_updated_at_goods_receipts
  before update on goods_receipts
  for each row execute function set_updated_at();

create table if not exists goods_receipt_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  receipt_id        uuid not null references goods_receipts(id) on delete cascade,
  order_item_id     uuid references purchase_order_items(id),
  product_id        uuid not null references products(id),
  variant_id        uuid references product_variants(id),
  product_name      text not null,
  variant_label     text,
  sku               text,
  unit              text not null default 'un',
  qty_expected      numeric(12,3),
  qty               numeric(12,3) not null check (qty >= 0),
  difference_reason text check (difference_reason is null or difference_reason in
                       ('faltante','sobrante','danado','vencido','error_proveedor','otro')),
  unit_cost         numeric(14,4) not null default 0 check (unit_cost >= 0),
  unit_cost_ars     numeric(14,4) not null default 0 check (unit_cost_ars >= 0),
  landed_unit_cost  numeric(14,4) check (landed_unit_cost is null or landed_unit_cost >= 0),
  valued_unit_cost  numeric(14,4) not null default 0,
  tax_rate          numeric(5,2) not null default 21,
  weight_kg         numeric(12,3) check (weight_kg is null or weight_kg >= 0),
  volume_m3         numeric(12,4) check (volume_m3 is null or volume_m3 >= 0),
  lot_code          text check (lot_code is null or char_length(lot_code) <= 60),
  expires_on        date,
  notes             text check (notes is null or char_length(notes) <= 200),
  sort              int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column goods_receipt_items.valued_unit_cost is
  'Costo unitario en pesos con el que la línea entró al promedio ponderado (el de compra o, después del costeo, el puesto en depósito).';

create index if not exists goods_receipt_items_receipt_idx on goods_receipt_items(receipt_id, sort);
create index if not exists goods_receipt_items_product_idx on goods_receipt_items(product_id, variant_id);
create index if not exists goods_receipt_items_order_item_idx on goods_receipt_items(order_item_id);
create index if not exists goods_receipt_items_tenant_idx on goods_receipt_items(tenant_id);

drop trigger if exists set_updated_at_goods_receipt_items on goods_receipt_items;
create trigger set_updated_at_goods_receipt_items
  before update on goods_receipt_items
  for each row execute function set_updated_at();

-- Lote de ingreso: código, vencimiento y n° de despacho (H102). No descuenta
-- por lote todavía (consumo por lote y n° de despacho en la venta: pendiente).
create table if not exists product_lots (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  product_id      uuid not null references products(id) on delete cascade,
  variant_id      uuid references product_variants(id) on delete cascade,
  store_id        uuid references stores(id),
  receipt_item_id uuid unique references goods_receipt_items(id) on delete set null,
  lot_code        text,
  dispatch_number text check (dispatch_number is null or dispatch_number ~ '^[0-9A-Z]{16}$'),
  expires_on      date,
  qty_received    numeric(12,3) not null default 0,
  unit_cost       numeric(14,4),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists product_lots_product_idx on product_lots(product_id, variant_id);
create index if not exists product_lots_tenant_idx on product_lots(tenant_id);
create index if not exists product_lots_dispatch_idx on product_lots(tenant_id, dispatch_number)
  where dispatch_number is not null;

drop trigger if exists set_updated_at_product_lots on product_lots;
create trigger set_updated_at_product_lots
  before update on product_lots
  for each row execute function set_updated_at();

alter table purchase_orders enable row level security;
alter table purchase_order_items enable row level security;
alter table purchase_events enable row level security;
alter table goods_receipts enable row level security;
alter table goods_receipt_items enable row level security;
alter table product_lots enable row level security;

drop policy if exists purchase_orders_select on purchase_orders;
create policy purchase_orders_select on purchase_orders
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists purchase_order_items_select on purchase_order_items;
create policy purchase_order_items_select on purchase_order_items
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists purchase_events_select on purchase_events;
create policy purchase_events_select on purchase_events
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists goods_receipts_select on goods_receipts;
create policy goods_receipts_select on goods_receipts
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists goods_receipt_items_select on goods_receipt_items;
create policy goods_receipt_items_select on goods_receipt_items
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists product_lots_select on product_lots;
create policy product_lots_select on product_lots
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- -----------------------------------------------------------------------------
-- C) Helpers puros (espejo de lib/purchases).
-- -----------------------------------------------------------------------------
-- Neto de una línea con descuentos en cascada (10 + 5 = 1 - 0,9 * 0,95).
create or replace function purchase_line_net(p_qty numeric, p_cost numeric, p_discounts numeric[])
returns numeric
language plpgsql
immutable
as $$
declare
  v numeric := coalesce(p_qty, 0) * coalesce(p_cost, 0);
  d numeric;
begin
  foreach d in array coalesce(p_discounts, '{}'::numeric[]) loop
    v := v * (1 - coalesce(d, 0) / 100);
  end loop;
  return round(v, 2);
end;
$$;

-- Costo unitario neto de descuentos de línea y global (4 decimales).
create or replace function purchase_unit_net(p_cost numeric, p_discounts numeric[], p_global numeric)
returns numeric
language plpgsql
immutable
as $$
declare
  v numeric := coalesce(p_cost, 0);
  d numeric;
begin
  foreach d in array coalesce(p_discounts, '{}'::numeric[]) loop
    v := v * (1 - coalesce(d, 0) / 100);
  end loop;
  return round(v * (1 - coalesce(p_global, 0) / 100), 4);
end;
$$;

-- Promedio ponderado móvil (espejo de weightedAverageCost). Stock negativo
-- cuenta como cero: lo vendido sin stock no tiene costo que promediar.
create or replace function purchase_weighted_avg(
  p_stock_before numeric, p_avg_before numeric, p_qty numeric, p_unit_cost numeric
)
returns numeric
language plpgsql
immutable
as $$
declare
  s numeric := greatest(coalesce(p_stock_before, 0), 0);
begin
  if coalesce(p_qty, 0) <= 0 then
    return p_avg_before;
  end if;
  if p_avg_before is null or s = 0 then
    return round(coalesce(p_unit_cost, 0), 4);
  end if;
  return round((s * p_avg_before + p_qty * coalesce(p_unit_cost, 0)) / (s + p_qty), 4);
end;
$$;

-- Evento de timeline + audit_logs.
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
                        when 'invoice' then 'supplier_invoices' else 'supplier_payments' end,
          p_id, 'purchase_' || p_entity || '_' || p_kind,
          case when p_from is null then null else jsonb_build_object('status', p_from) end,
          jsonb_build_object('status', p_to) || coalesce(p_data, '{}'::jsonb),
          nullif(trim(coalesce(p_notes, '')), ''));
end;
$$;
revoke all on function purchase_log(uuid, text, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

create or replace function purchase_order_lock(p_tenant uuid, p_id uuid)
returns purchase_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v purchase_orders;
begin
  select * into v from purchase_orders
   where id = p_id and tenant_id = p_tenant and deleted_at is null
   for update;
  if v.id is null then
    raise exception 'order_not_found';
  end if;
  return v;
end;
$$;
revoke all on function purchase_order_lock(uuid, uuid) from public, anon, authenticated;

-- Recalcula los totales de la OC desde sus líneas.
create or replace function purchase_order_recalc(p_id uuid)
returns purchase_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v   purchase_orders;
  sub numeric;
  tax numeric;
  uni numeric;
  rec numeric;
begin
  select * into v from purchase_orders where id = p_id;
  select coalesce(sum(line_net), 0),
         coalesce(sum(round(line_net * (1 - v.discount_pct / 100) * tax_rate / 100, 2)), 0),
         coalesce(sum(qty_ordered), 0),
         coalesce(sum(qty_received), 0)
    into sub, tax, uni, rec
    from purchase_order_items where order_id = p_id;
  update purchase_orders
     set subtotal = sub,
         discount_total = round(sub * discount_pct / 100, 2),
         net_total = sub - round(sub * discount_pct / 100, 2),
         tax_total = tax,
         total = sub - round(sub * discount_pct / 100, 2) + tax,
         units_ordered = uni,
         units_received = rec
   where id = p_id
  returning * into v;
  return v;
end;
$$;
revoke all on function purchase_order_recalc(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) OC: crear / editar borrador.
--    p_items: [{product_id, variant_id?, qty, unit_cost, discounts?: [..],
--               tax_rate?, supplier_sku?, notes?}]
-- -----------------------------------------------------------------------------
create or replace function purchase_order_save(
  p_id                 uuid,
  p_supplier_id        uuid,
  p_store_id           uuid,
  p_expected_date      date,
  p_currency           text,
  p_fx_rate            numeric,
  p_discount_pct       numeric,
  p_payment_terms_days int,
  p_notes              text,
  p_items              jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := purchase_assert(true);
  v_o       purchase_orders;
  v_number  int;
  v_it      record;
  v_prod    record;
  v_var_id  uuid;
  v_var_lbl text;
  v_var_sku text;
  v_sp_sku  text;
  v_disc    numeric[];
  v_sort    int := 0;
  v_kind    text;
  v_cur     text := upper(coalesce(nullif(trim(p_currency), ''), 'ARS'));
  v_fx      numeric := case when upper(coalesce(nullif(trim(p_currency), ''), 'ARS')) = 'ARS'
                            then 1 else coalesce(p_fx_rate, 0) end;
begin
  if p_supplier_id is null or not exists (
    select 1 from suppliers where id = p_supplier_id and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'supplier_not_found';
  end if;
  if p_store_id is null or not exists (
    select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null and is_active
  ) then
    raise exception 'store_not_found';
  end if;
  if v_cur !~ '^[A-Z]{3}$' then
    raise exception 'invalid_currency';
  end if;
  if v_fx <= 0 then
    raise exception 'invalid_fx_rate';
  end if;
  if coalesce(p_discount_pct, 0) < 0 or coalesce(p_discount_pct, 0) >= 100 then
    raise exception 'invalid_discount';
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items';
  end if;

  if p_id is null then
    perform pg_advisory_xact_lock(hashtext('purchase_order_number:' || v_tenant::text));
    select coalesce(max(number), 0) + 1 into v_number from purchase_orders where tenant_id = v_tenant;
    insert into purchase_orders (tenant_id, number, supplier_id, store_id, status, expected_date, currency,
                                 fx_rate, discount_pct, payment_terms_days, notes, created_by)
    values (v_tenant, v_number, p_supplier_id, p_store_id, 'draft', p_expected_date, v_cur, v_fx,
            coalesce(p_discount_pct, 0), p_payment_terms_days,
            nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
    returning * into v_o;
    v_kind := 'created';
  else
    v_o := purchase_order_lock(v_tenant, p_id);
    if v_o.status <> 'draft' then
      raise exception 'invalid_transition: % -> draft', v_o.status;
    end if;
    update purchase_orders
       set supplier_id = p_supplier_id,
           store_id = p_store_id,
           expected_date = p_expected_date,
           currency = v_cur,
           fx_rate = v_fx,
           discount_pct = coalesce(p_discount_pct, 0),
           payment_terms_days = p_payment_terms_days,
           notes = nullif(trim(coalesce(p_notes, '')), '')
     where id = v_o.id
    returning * into v_o;
    delete from purchase_order_items where order_id = v_o.id;
    v_kind := 'updated';
  end if;

  for v_it in
    select (e.value ->> 'product_id')::uuid as product_id,
           (e.value ->> 'variant_id')::uuid as variant_id,
           (e.value ->> 'qty')::numeric as qty,
           coalesce((e.value ->> 'unit_cost')::numeric, 0) as unit_cost,
           e.value -> 'discounts' as discounts,
           (e.value ->> 'tax_rate')::numeric as tax_rate,
           nullif(trim(coalesce(e.value ->> 'supplier_sku', '')), '') as supplier_sku,
           nullif(trim(coalesce(e.value ->> 'notes', '')), '') as notes
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(value)
  loop
    if v_it.product_id is null or coalesce(v_it.qty, 0) <= 0 then
      raise exception 'invalid_qty';
    end if;
    if v_it.unit_cost < 0 then
      raise exception 'invalid_cost';
    end if;
    select id, name, sku, unit, is_kit, has_variants, tax_rate into v_prod
      from products
     where id = v_it.product_id and tenant_id = v_tenant and deleted_at is null;
    if v_prod.id is null then
      raise exception 'product_not_found';
    end if;
    if coalesce(v_prod.is_kit, false) then
      raise exception 'kit_not_purchasable';
    end if;

    v_var_id := null; v_var_lbl := null; v_var_sku := null;
    if coalesce(v_prod.has_variants, false) then
      if v_it.variant_id is null then
        raise exception 'variant_required';
      end if;
      select id, option1 || coalesce(' / ' || option2, ''), sku
        into v_var_id, v_var_lbl, v_var_sku
        from product_variants
       where id = v_it.variant_id and product_id = v_prod.id and tenant_id = v_tenant and deleted_at is null;
      if v_var_id is null then
        raise exception 'variant_not_found';
      end if;
    elsif v_it.variant_id is not null then
      raise exception 'variant_not_allowed';
    end if;

    v_disc := '{}';
    if v_it.discounts is not null and jsonb_typeof(v_it.discounts) = 'array' then
      select coalesce(array_agg(x.v::numeric order by x.ord), '{}') into v_disc
        from jsonb_array_elements_text(v_it.discounts) with ordinality as x(v, ord)
       where nullif(x.v, '') is not null and x.v::numeric <> 0;
    end if;
    if exists (select 1 from unnest(v_disc) d where d < 0 or d >= 100) then
      raise exception 'invalid_discount';
    end if;

    select sp.supplier_sku into v_sp_sku
      from supplier_products sp
     where sp.supplier_id = p_supplier_id and sp.product_id = v_prod.id
       and sp.variant_id is not distinct from v_var_id and sp.deleted_at is null
     limit 1;

    v_sort := v_sort + 1;
    insert into purchase_order_items (tenant_id, order_id, product_id, variant_id, product_name, variant_label,
                                      sku, supplier_sku, unit, qty_ordered, unit_cost, discounts, tax_rate,
                                      line_net, notes, sort)
    values (v_tenant, v_o.id, v_prod.id, v_var_id, v_prod.name, v_var_lbl,
            coalesce(v_var_sku, v_prod.sku), coalesce(v_it.supplier_sku, v_sp_sku), coalesce(v_prod.unit, 'un'),
            v_it.qty, v_it.unit_cost, v_disc, coalesce(v_it.tax_rate, v_prod.tax_rate, 21),
            purchase_line_net(v_it.qty, v_it.unit_cost, v_disc), v_it.notes, v_sort);
  end loop;

  v_o := purchase_order_recalc(v_o.id);
  perform purchase_log(v_tenant, 'order', v_o.id, v_kind, case when v_kind = 'created' then null else 'draft' end,
                       'draft', null, jsonb_build_object('number', v_o.number, 'items', v_sort, 'total', v_o.total));
  return v_o.id;
end;
$$;
revoke all on function purchase_order_save(uuid, uuid, uuid, date, text, numeric, numeric, int, text, jsonb) from public, anon;
grant execute on function purchase_order_save(uuid, uuid, uuid, date, text, numeric, numeric, int, text, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- E) OC: enviar, reabrir, cancelar y cerrar.
-- -----------------------------------------------------------------------------
create or replace function purchase_order_send(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_o      purchase_orders;
begin
  v_o := purchase_order_lock(v_tenant, p_id);
  if v_o.status <> 'draft' then
    raise exception 'invalid_transition: % -> sent', v_o.status;
  end if;
  if not exists (select 1 from purchase_order_items where order_id = v_o.id) then
    raise exception 'order_empty';
  end if;
  update purchase_orders
     set status = 'sent', sent_at = now(), sent_by = auth.uid(), issue_date = current_date
   where id = v_o.id;
  perform purchase_log(v_tenant, 'order', v_o.id, 'sent', 'draft', 'sent', null,
                       jsonb_build_object('number', v_o.number, 'total', v_o.total));
end;
$$;
revoke all on function purchase_order_send(uuid) from public, anon;
grant execute on function purchase_order_send(uuid) to authenticated;

create or replace function purchase_order_reopen(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_o      purchase_orders;
begin
  v_o := purchase_order_lock(v_tenant, p_id);
  if v_o.status <> 'sent' or v_o.units_received > 0 then
    raise exception 'invalid_transition: % -> draft', v_o.status;
  end if;
  update purchase_orders set status = 'draft' where id = v_o.id;
  perform purchase_log(v_tenant, 'order', v_o.id, 'reopened', 'sent', 'draft');
end;
$$;
revoke all on function purchase_order_reopen(uuid) from public, anon;
grant execute on function purchase_order_reopen(uuid) to authenticated;

create or replace function purchase_order_cancel(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_o      purchase_orders;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  v_o := purchase_order_lock(v_tenant, p_id);
  if v_o.status not in ('draft', 'sent') or v_o.units_received > 0 then
    raise exception 'invalid_transition: % -> cancelled', v_o.status;
  end if;
  update purchase_orders
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
   where id = v_o.id;
  perform purchase_log(v_tenant, 'order', v_o.id, 'cancelled', v_o.status, 'cancelled', p_reason);
end;
$$;
revoke all on function purchase_order_cancel(uuid, text) from public, anon;
grant execute on function purchase_order_cancel(uuid, text) to authenticated;

-- Cerrar una OC recibida en parte: lo pendiente no se espera más.
create or replace function purchase_order_close(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_o      purchase_orders;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  v_o := purchase_order_lock(v_tenant, p_id);
  if v_o.status <> 'partially_received' then
    raise exception 'invalid_transition: % -> received', v_o.status;
  end if;
  update purchase_orders
     set status = 'received', received_at = now(), close_reason = trim(p_reason)
   where id = v_o.id;
  perform purchase_log(v_tenant, 'order', v_o.id, 'closed', 'partially_received', 'received', p_reason,
                       jsonb_build_object('pending_units', v_o.units_ordered - v_o.units_received));
end;
$$;
revoke all on function purchase_order_close(uuid, text) from public, anon;
grant execute on function purchase_order_close(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Recepción de mercadería (contra OC o libre).
--    p_items: [{order_item_id?, product_id?, variant_id?, qty, unit_cost?,
--               reason?, lot_code?, expires_on?, weight_kg?, volume_m3?, notes?}]
--    Con OC, unit_cost por defecto es el neto de la línea de la OC.
--    p_close: cierra la OC aunque falte mercadería.
-- -----------------------------------------------------------------------------
create or replace function purchase_receive(
  p_order_id      uuid,
  p_store_id      uuid,
  p_supplier_id   uuid,
  p_received_date date,
  p_remito_number text,
  p_currency      text,
  p_fx_rate       numeric,
  p_items         jsonb,
  p_close         boolean default false,
  p_notes         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := purchase_assert(false);
  v_role     text := stock_my_role();
  v_set      purchase_settings;
  v_o        purchase_orders;
  v_r        goods_receipts;
  v_number   int;
  v_store    uuid;
  v_supplier uuid;
  v_cur      text;
  v_fx       numeric;
  v_in       record;
  v_oi       purchase_order_items;
  v_prod     record;
  v_var_id   uuid;
  v_var_lbl  text;
  v_var_sku  text;
  v_cost     numeric;
  v_cost_ars numeric;
  v_stock    numeric;
  v_avg      numeric;
  v_item_id  uuid;
  v_sort     int := 0;
  v_units    numeric := 0;
  v_value    numeric := 0;
  v_open     boolean;
  v_to       text;
  v_from     text;
begin
  v_set := purchase_settings_for(v_tenant);
  if not (v_role in ('owner', 'manager') or (v_role = 'cashier' and v_set.cashier_can_receive)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items';
  end if;

  if p_order_id is not null then
    v_o := purchase_order_lock(v_tenant, p_order_id);
    if v_o.status not in ('sent', 'partially_received') then
      raise exception 'invalid_transition: % -> received', v_o.status;
    end if;
    v_from := v_o.status;
    v_store := v_o.store_id;
    v_supplier := v_o.supplier_id;
    v_cur := v_o.currency;
    v_fx := case when v_o.currency = 'ARS' then 1 else coalesce(nullif(p_fx_rate, 0), v_o.fx_rate) end;
  else
    if not v_set.allow_free_receipts and v_role <> 'owner' then
      raise exception 'free_receipt_not_allowed';
    end if;
    v_store := p_store_id;
    v_supplier := p_supplier_id;
    v_cur := upper(coalesce(nullif(trim(p_currency), ''), 'ARS'));
    v_fx := case when v_cur = 'ARS' then 1 else coalesce(p_fx_rate, 0) end;
    if v_supplier is not null and not exists (
      select 1 from suppliers where id = v_supplier and tenant_id = v_tenant and deleted_at is null
    ) then
      raise exception 'supplier_not_found';
    end if;
  end if;

  if v_cur !~ '^[A-Z]{3}$' then
    raise exception 'invalid_currency';
  end if;
  if v_fx <= 0 then
    raise exception 'invalid_fx_rate';
  end if;
  if v_store is null or not exists (
    select 1 from stores where id = v_store and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;
  if v_role <> 'owner' and not user_can_access_store(v_store) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('goods_receipt_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from goods_receipts where tenant_id = v_tenant;
  insert into goods_receipts (tenant_id, number, order_id, supplier_id, store_id, received_date, remito_number,
                              currency, fx_rate, notes, created_by)
  values (v_tenant, v_number, p_order_id, v_supplier, v_store, coalesce(p_received_date, current_date),
          nullif(trim(coalesce(p_remito_number, '')), ''), v_cur, v_fx,
          nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning * into v_r;

  perform set_config('ninja.cost_source', 'receipt', true);
  perform set_config('ninja.cost_reference', v_r.id::text, true);

  for v_in in
    select (x.value ->> 'order_item_id')::uuid as order_item_id,
           (x.value ->> 'product_id')::uuid as product_id,
           (x.value ->> 'variant_id')::uuid as variant_id,
           coalesce((x.value ->> 'qty')::numeric, 0) as qty,
           (x.value ->> 'unit_cost')::numeric as unit_cost,
           nullif(trim(coalesce(x.value ->> 'reason', '')), '') as reason,
           nullif(trim(coalesce(x.value ->> 'lot_code', '')), '') as lot_code,
           (nullif(x.value ->> 'expires_on', ''))::date as expires_on,
           (x.value ->> 'weight_kg')::numeric as weight_kg,
           (x.value ->> 'volume_m3')::numeric as volume_m3,
           nullif(trim(coalesce(x.value ->> 'notes', '')), '') as notes
      from jsonb_array_elements(p_items) as x(value)
  loop
    if v_in.qty < 0 then
      raise exception 'invalid_qty';
    end if;
    v_oi := null;
    if v_in.order_item_id is not null then
      if p_order_id is null then
        raise exception 'order_item_without_order';
      end if;
      select * into v_oi from purchase_order_items
       where id = v_in.order_item_id and order_id = p_order_id
       for update;
      if v_oi.id is null then
        raise exception 'item_not_found';
      end if;
      if v_oi.qty_received + v_in.qty > v_oi.qty_ordered and not v_set.allow_over_receive then
        raise exception 'over_receive_not_allowed: %', v_oi.product_name;
      end if;
    elsif v_in.product_id is null then
      raise exception 'product_required';
    end if;

    select id, name, sku, unit, is_kit, has_variants, track_stock, stock, last_cost, avg_cost, cost, tax_rate
      into v_prod
      from products
     where id = coalesce(v_oi.product_id, v_in.product_id) and tenant_id = v_tenant and deleted_at is null
     for update;
    if v_prod.id is null then
      raise exception 'product_not_found';
    end if;
    if coalesce(v_prod.is_kit, false) then
      raise exception 'kit_not_purchasable';
    end if;

    v_var_id := coalesce(v_oi.variant_id, v_in.variant_id);
    v_var_lbl := v_oi.variant_label;
    v_var_sku := null;
    if coalesce(v_prod.has_variants, false) then
      if v_var_id is null then
        raise exception 'variant_required';
      end if;
      select id, option1 || coalesce(' / ' || option2, ''), sku
        into v_var_id, v_var_lbl, v_var_sku
        from product_variants
       where id = v_var_id and product_id = v_prod.id and tenant_id = v_tenant;
      if v_var_id is null then
        raise exception 'variant_not_found';
      end if;
    elsif v_var_id is not null then
      raise exception 'variant_not_allowed';
    end if;

    v_cost := coalesce(v_in.unit_cost,
                       case when v_oi.id is not null
                            then purchase_unit_net(v_oi.unit_cost, v_oi.discounts, v_o.discount_pct) end,
                       0);
    if v_cost < 0 then
      raise exception 'invalid_cost';
    end if;
    v_cost_ars := round(v_cost * v_fx, 4);

    -- Stock total antes de esta línea (para el promedio ponderado).
    if coalesce(v_prod.has_variants, false) then
      select coalesce(sum(stock), 0) into v_stock
        from product_variants where product_id = v_prod.id and deleted_at is null;
    else
      v_stock := coalesce(v_prod.stock, 0);
    end if;

    v_sort := v_sort + 1;
    insert into goods_receipt_items (tenant_id, receipt_id, order_item_id, product_id, variant_id, product_name,
                                     variant_label, sku, unit, qty_expected, qty, difference_reason, unit_cost,
                                     unit_cost_ars, valued_unit_cost, tax_rate, weight_kg, volume_m3, lot_code,
                                     expires_on, notes, sort)
    values (v_tenant, v_r.id, v_oi.id, v_prod.id, v_var_id, v_prod.name, v_var_lbl,
            coalesce(v_var_sku, v_oi.sku, v_prod.sku), coalesce(v_prod.unit, 'un'),
            case when v_oi.id is not null then greatest(v_oi.qty_ordered - v_oi.qty_received, 0) end,
            v_in.qty, v_in.reason, v_cost, v_cost_ars, v_cost_ars,
            coalesce(v_oi.tax_rate, v_prod.tax_rate, 21), v_in.weight_kg, v_in.volume_m3, v_in.lot_code,
            v_in.expires_on, v_in.notes, v_sort)
    returning id into v_item_id;

    if v_oi.id is not null then
      update purchase_order_items
         set qty_received = qty_received + v_in.qty
       where id = v_oi.id;
    end if;

    if v_in.qty > 0 then
      -- Stock: total consolidado + movimiento con sucursal (ADR-046).
      if coalesce(v_prod.track_stock, true) then
        if v_var_id is null then
          update products set stock = stock + v_in.qty, updated_at = now() where id = v_prod.id;
        else
          update product_variants set stock = stock + v_in.qty, updated_at = now() where id = v_var_id;
        end if;
        insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id,
                                     notes, created_by)
        values (v_tenant, v_prod.id, v_var_id, v_store, v_in.qty, 'purchase', v_r.id,
                'Recepción REC-' || lpad(v_number::text, 6, '0')
                  || case when v_o.id is not null then ' (OC-' || lpad(v_o.number::text, 6, '0') || ')' else '' end,
                auth.uid());
        v_avg := purchase_weighted_avg(v_stock, coalesce(v_prod.avg_cost, v_prod.last_cost, v_prod.cost),
                                       v_in.qty, v_cost_ars);
      else
        v_avg := v_cost_ars;
      end if;

      update products
         set last_cost = v_cost_ars, avg_cost = v_avg, updated_at = now()
       where id = v_prod.id;

      -- Último costo del producto en este proveedor (en la moneda de la compra).
      if v_supplier is not null then
        update supplier_products
           set last_cost = v_cost, currency = v_cur, last_cost_at = now()
         where supplier_id = v_supplier and product_id = v_prod.id
           and variant_id is not distinct from v_var_id and deleted_at is null;
        if not found then
          insert into supplier_products (tenant_id, supplier_id, product_id, variant_id, supplier_sku,
                                         last_cost, currency, last_cost_at)
          values (v_tenant, v_supplier, v_prod.id, v_var_id, v_oi.supplier_sku, v_cost, v_cur, now());
        end if;
      end if;

      if v_in.lot_code is not null or v_in.expires_on is not null then
        insert into product_lots (tenant_id, product_id, variant_id, store_id, receipt_item_id, lot_code,
                                  expires_on, qty_received, unit_cost)
        values (v_tenant, v_prod.id, v_var_id, v_store, v_item_id, v_in.lot_code, v_in.expires_on,
                v_in.qty, v_cost_ars);
      end if;

      v_units := v_units + v_in.qty;
      v_value := v_value + v_in.qty * v_cost_ars;
    end if;
  end loop;

  perform set_config('ninja.cost_source', '', true);
  perform set_config('ninja.cost_reference', '', true);

  if v_sort = 0 then
    raise exception 'receipt_empty';
  end if;
  if v_units <= 0 and not (p_order_id is not null and p_close) then
    raise exception 'nothing_to_receive';
  end if;

  update goods_receipts
     set total_units = v_units, total_cost = round(v_value, 2)
   where id = v_r.id
  returning * into v_r;

  if p_order_id is not null then
    v_o := purchase_order_recalc(p_order_id);
    select exists (
      select 1 from purchase_order_items where order_id = p_order_id and qty_received < qty_ordered
    ) into v_open;

    if p_close or not v_open then
      if v_set.require_difference_reason and exists (
        select 1 from purchase_order_items oi
         where oi.order_id = p_order_id and oi.qty_received <> oi.qty_ordered
           and not exists (select 1 from goods_receipt_items gi
                            where gi.order_item_id = oi.id and gi.difference_reason is not null)
      ) then
        raise exception 'difference_reason_required';
      end if;
      v_to := 'received';
    else
      v_to := 'partially_received';
    end if;

    update purchase_orders
       set status = v_to,
           received_at = case when v_to = 'received' then now() else received_at end,
           close_reason = case when v_to = 'received' and v_open
                               then coalesce(nullif(trim(coalesce(p_notes, '')), ''), 'Cerrada con faltante')
                               else close_reason end
     where id = p_order_id;
    if v_to is distinct from v_from then
      perform purchase_log(v_tenant, 'order', p_order_id, v_to, v_from, v_to, null,
                           jsonb_build_object('receipt_id', v_r.id, 'units', v_units));
    end if;
  end if;

  perform purchase_log(v_tenant, 'receipt', v_r.id, 'created', null, 'posted', p_notes,
                       jsonb_build_object('number', v_number, 'order_id', p_order_id, 'store_id', v_store,
                                          'units', v_units, 'value', round(v_value, 2)));
  return v_r.id;
end;
$$;
revoke all on function purchase_receive(uuid, uuid, uuid, date, text, text, numeric, jsonb, boolean, text) from public, anon;
grant execute on function purchase_receive(uuid, uuid, uuid, date, text, text, numeric, jsonb, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Costeo de importación sobre una recepción (compras_importacion).
--    p_items: [{item_id, landed_unit_cost}] en pesos (calculado con
--    lib/purchases/landed.ts). Re-aplicable: ajusta contra el costo anterior.
--    Ajuste del promedio: la diferencia total se reparte sobre el stock actual
--    del producto (si hay stock); el último costo pasa al costo puesto en
--    depósito si esta recepción es la última del producto.
-- -----------------------------------------------------------------------------
create or replace function purchase_apply_costing(
  p_receipt_id      uuid,
  p_costing         jsonb,
  p_items           jsonb,
  p_dispatch_number text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := purchase_assert(true);
  v_r        goods_receipts;
  v_in       record;
  v_it       goods_receipt_items;
  v_prod     record;
  v_stock    numeric;
  v_diff     numeric;
  v_dispatch text := nullif(upper(regexp_replace(coalesce(p_dispatch_number, ''), '\s', '', 'g')), '');
  v_total    numeric := 0;
  v_latest   uuid;
begin
  if not tenant_has_feature_for(v_tenant, 'compras_importacion') then
    raise exception 'feature_not_in_plan: compras_importacion';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items';
  end if;
  if v_dispatch is not null and v_dispatch !~ '^[0-9A-Z]{16}$' then
    raise exception 'invalid_dispatch_number';
  end if;

  select * into v_r from goods_receipts
   where id = p_receipt_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if v_r.id is null then
    raise exception 'receipt_not_found';
  end if;

  perform set_config('ninja.cost_source', 'import_costing', true);
  perform set_config('ninja.cost_reference', v_r.id::text, true);

  for v_in in
    select x.item_id, x.landed_unit_cost
      from jsonb_to_recordset(p_items) as x(item_id uuid, landed_unit_cost numeric)
  loop
    if v_in.landed_unit_cost is null or v_in.landed_unit_cost < 0 then
      raise exception 'invalid_cost';
    end if;
    select * into v_it from goods_receipt_items
     where id = v_in.item_id and receipt_id = v_r.id
     for update;
    if v_it.id is null then
      raise exception 'item_not_found';
    end if;

    v_diff := (round(v_in.landed_unit_cost, 4) - v_it.valued_unit_cost) * v_it.qty;

    update goods_receipt_items
       set landed_unit_cost = round(v_in.landed_unit_cost, 4),
           valued_unit_cost = round(v_in.landed_unit_cost, 4)
     where id = v_it.id;

    if v_it.qty > 0 then
      select id, has_variants, stock, avg_cost, last_cost into v_prod
        from products where id = v_it.product_id for update;
      if coalesce(v_prod.has_variants, false) then
        select coalesce(sum(stock), 0) into v_stock
          from product_variants where product_id = v_prod.id and deleted_at is null;
      else
        v_stock := coalesce(v_prod.stock, 0);
      end if;

      -- ¿Es la recepción más reciente de este producto?
      select gi.id into v_latest
        from goods_receipt_items gi
        join goods_receipts g on g.id = gi.receipt_id
       where gi.product_id = v_it.product_id and gi.qty > 0 and g.deleted_at is null
       order by g.received_date desc, g.created_at desc
       limit 1;

      update products
         set avg_cost = case when v_stock > 0 and avg_cost is not null
                             then greatest(round(avg_cost + v_diff / v_stock, 4), 0)
                             else avg_cost end,
             last_cost = case when v_latest = v_it.id then round(v_in.landed_unit_cost, 4) else last_cost end,
             updated_at = now()
       where id = v_prod.id;

      insert into product_lots (tenant_id, product_id, variant_id, store_id, receipt_item_id, lot_code,
                                dispatch_number, expires_on, qty_received, unit_cost)
      values (v_tenant, v_it.product_id, v_it.variant_id, v_r.store_id, v_it.id, v_it.lot_code, v_dispatch,
              v_it.expires_on, v_it.qty, round(v_in.landed_unit_cost, 4))
      on conflict (receipt_item_id) do update
        set dispatch_number = coalesce(excluded.dispatch_number, product_lots.dispatch_number),
            unit_cost = excluded.unit_cost;
    end if;

    v_total := v_total + v_it.qty * round(v_in.landed_unit_cost, 4);
  end loop;

  perform set_config('ninja.cost_source', '', true);
  perform set_config('ninja.cost_reference', '', true);

  update goods_receipts
     set costing = p_costing,
         landed_total = round(v_total, 2),
         dispatch_number = coalesce(v_dispatch, dispatch_number),
         costing_applied_at = now(),
         costing_applied_by = auth.uid()
   where id = v_r.id;

  perform purchase_log(v_tenant, 'receipt', v_r.id, 'costing_applied', 'posted', 'posted', null,
                       jsonb_build_object('landed_total', round(v_total, 2), 'dispatch_number', v_dispatch,
                                          'previous_total', v_r.landed_total));
end;
$$;
revoke all on function purchase_apply_costing(uuid, jsonb, jsonb, text) from public, anon;
grant execute on function purchase_apply_costing(uuid, jsonb, jsonb, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Sugerencia de compra por sucursal (SECURITY INVOKER: aplica RLS).
--    Productos bajo el mínimo en la sucursal contando lo que viene en camino
--    (traslados) y lo pedido en OC abiertas. Con proveedor: sólo los suyos.
--    La cantidad sugerida la calcula lib/purchases/suggest.ts.
-- -----------------------------------------------------------------------------
create or replace function purchase_suggestions(
  p_store_id    uuid,
  p_supplier_id uuid default null,
  p_limit       int default 300
)
returns table (
  product_id         uuid,
  variant_id         uuid,
  product_name       text,
  variant_label      text,
  sku                text,
  unit               text,
  qty                numeric,
  min_qty            numeric,
  max_qty            numeric,
  in_transit_in      numeric,
  on_order           numeric,
  cost               numeric,
  tax_rate           numeric,
  supplier_sku       text,
  supplier_cost      numeric,
  min_order_qty      numeric,
  units_per_purchase numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with items as (
    select p.id as product_id, null::uuid as variant_id, p.name as product_name,
           null::text as variant_label, p.sku, p.unit, p.stock_min, p.cost, p.tax_rate
      from products p
     where p.tenant_id = current_tenant_id() and p.deleted_at is null and p.is_active
       and coalesce(p.track_stock, true) and not coalesce(p.is_kit, false)
       and not coalesce(p.has_variants, false)
    union all
    select p.id, v.id, p.name, v.option1 || coalesce(' / ' || v.option2, ''),
           coalesce(v.sku, p.sku), p.unit, p.stock_min, p.cost, p.tax_rate
      from product_variants v
      join products p on p.id = v.product_id
     where p.tenant_id = current_tenant_id() and p.deleted_at is null and p.is_active
       and v.deleted_at is null and coalesce(p.track_stock, true) and coalesce(p.has_variants, false)
  ),
  transit as (
    select i.product_id, i.variant_id,
           sum(greatest(coalesce(i.qty_dispatched, 0) - i.qty_received, 0)) as pending
      from stock_transfer_items i
      join stock_transfers t on t.id = i.transfer_id
     where t.dest_store_id = p_store_id
       and t.status in ('in_transit', 'partially_received') and t.deleted_at is null
     group by 1, 2
  ),
  ordered as (
    select oi.product_id, oi.variant_id, sum(greatest(oi.qty_ordered - oi.qty_received, 0)) as pending
      from purchase_order_items oi
      join purchase_orders o on o.id = oi.order_id
     where o.store_id = p_store_id
       and o.status in ('draft', 'sent', 'partially_received') and o.deleted_at is null
     group by 1, 2
  ),
  grid as (
    select i.*, coalesce(ps.qty, 0) as qty, coalesce(ps.min_qty, i.stock_min, 0) as min_qty, ps.max_qty,
           coalesce(tr.pending, 0) as in_transit_in, coalesce(od.pending, 0) as on_order,
           sp.supplier_sku, sp.last_cost as supplier_cost, sp.min_order_qty, sp.units_per_purchase
      from items i
      left join product_stock ps
        on ps.store_id = p_store_id and ps.product_id = i.product_id
       and ps.variant_id is not distinct from i.variant_id
      left join transit tr on tr.product_id = i.product_id and tr.variant_id is not distinct from i.variant_id
      left join ordered od on od.product_id = i.product_id and od.variant_id is not distinct from i.variant_id
      left join lateral (
        select s.supplier_sku, s.last_cost, s.min_order_qty, s.units_per_purchase
          from supplier_products s
         where s.product_id = i.product_id
           and (s.variant_id is null or s.variant_id is not distinct from i.variant_id)
           and s.deleted_at is null
           and (p_supplier_id is null or s.supplier_id = p_supplier_id)
         order by (s.variant_id is not distinct from i.variant_id) desc, s.is_preferred desc, s.last_cost_at desc nulls last
         limit 1
      ) sp on true
  )
  select g.product_id, g.variant_id, g.product_name, g.variant_label, g.sku, g.unit, g.qty, g.min_qty,
         g.max_qty, g.in_transit_in, g.on_order, g.cost, g.tax_rate, g.supplier_sku, g.supplier_cost,
         g.min_order_qty, coalesce(g.units_per_purchase, 1)
    from grid g
   where g.min_qty > 0
     and g.qty + g.in_transit_in + g.on_order < g.min_qty
     and (p_supplier_id is null or g.supplier_cost is not null or g.supplier_sku is not null
          or exists (select 1 from supplier_products s2
                      where s2.supplier_id = p_supplier_id and s2.product_id = g.product_id
                        and s2.deleted_at is null))
   order by g.product_name, g.variant_label
   limit greatest(1, least(coalesce(p_limit, 300), 1000));
$$;
revoke all on function purchase_suggestions(uuid, uuid, int) from public, anon;
grant execute on function purchase_suggestions(uuid, uuid, int) to authenticated;
