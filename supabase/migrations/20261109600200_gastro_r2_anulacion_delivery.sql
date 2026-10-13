-- =============================================================================
-- 20261109600200_gastro_r2_anulacion_delivery  (F13 · H49: anulación con motivo
--                                               de ítems de delivery, ADR-097)
-- -----------------------------------------------------------------------------
-- Mismo patrón que las mesas (20261105200100_comanda_anulaciones, ADR-081): un
-- ítem de delivery/takeaway/mostrador ENVIADO (comanda impresa o tocado por la
-- cocina) sólo baja con void_delivery_order_item(ítem, cantidad, motivo):
--   * delivery_order_voids guarda el snapshot (nombre, estación, tiempo,
--     etiqueta del pedido) y el motivo; audit 'delivery_item_voided'.
--   * set_delivery_order_item_qty (copia de 20260608720000, la única) rechaza
--     bajar un ítem enviado con 'item_sent_use_void'.
--   * Trigger BEFORE UPDATE OF qty en delivery_order_items: bajar un ítem
--     enviado exige el permiso de sesión que pone la RPC.
--   * La policy "for all" de delivery_order_items se parte en select, insert y
--     update: sin DELETE directo por REST.
-- Aviso a cocina: kds_recent_voids une las anulaciones de mesa y de delivery
-- (columna nueva `source`); ack y marca de impresión aceptan las dos.
-- Gating: flag operativo (delivery_enabled), no feature de plan.
-- =============================================================================

-- ── 1) Registro de anulaciones de delivery ───────────────────────────────────
create table if not exists delivery_order_voids (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  order_id        uuid not null references delivery_orders(id) on delete cascade,
  -- Sin FK: la línea puede desaparecer (anulación total).
  item_id         uuid not null,
  product_id      uuid references products(id) on delete set null,
  name            text not null,
  qty             numeric(12,3) not null check (qty > 0),
  unit_price      numeric(12,2) not null default 0,
  station         text,
  course          smallint not null default 1,
  order_label     text,
  reason          text not null check (char_length(btrim(reason)) >= 3),
  voided_by       uuid references public.users(id) on delete set null,
  printed_at      timestamptz,
  acknowledged_at timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists delivery_order_voids_tenant_idx
  on delivery_order_voids (tenant_id, created_at desc);
create index if not exists delivery_order_voids_order_idx on delivery_order_voids (order_id);
create index if not exists delivery_order_voids_product_idx
  on delivery_order_voids (product_id) where product_id is not null;
create index if not exists delivery_order_voids_voided_by_idx
  on delivery_order_voids (voided_by) where voided_by is not null;

alter table delivery_order_voids enable row level security;
-- Lectura por negocio. Escritura sólo por RPC (sin policies de escritura).
create policy delivery_order_voids_select on delivery_order_voids
  for select using (tenant_id = (select current_tenant_id()));

drop trigger if exists role_write_guard on delivery_order_voids;
create trigger role_write_guard before insert or update or delete on delivery_order_voids
  for each row execute function trg_role_write_guard('operate');

-- ── 2) RLS de delivery_order_items sin DELETE directo ────────────────────────
drop policy if exists delivery_order_items_tenant_isolation on delivery_order_items;
drop policy if exists delivery_order_items_select on delivery_order_items;
drop policy if exists delivery_order_items_insert on delivery_order_items;
drop policy if exists delivery_order_items_update on delivery_order_items;
create policy delivery_order_items_select on delivery_order_items
  for select using (tenant_id = (select current_tenant_id()));
create policy delivery_order_items_insert on delivery_order_items
  for insert with check (tenant_id = (select current_tenant_id()));
create policy delivery_order_items_update on delivery_order_items
  for update using (tenant_id = (select current_tenant_id()))
  with check (tenant_id = (select current_tenant_id()));

-- ── 3) Trigger: bajar qty de un ítem enviado exige anulación ─────────────────
create or replace function _delivery_order_item_guard_qty()
returns trigger
language plpgsql
as $$
begin
  if new.qty < old.qty
     and _dining_item_sent(old.printed_at, old.kds_status)
     and coalesce(current_setting('ninja.dining_item_void', true), '') <> 'on' then
    raise exception 'item_sent_use_void';
  end if;
  return new;
end;
$$;

drop trigger if exists delivery_order_items_guard_qty on delivery_order_items;
create trigger delivery_order_items_guard_qty
  before update of qty on delivery_order_items
  for each row execute function _delivery_order_item_guard_qty();

-- ── 4) set_delivery_order_item_qty (copia de 20260608720000 + regla) ─────────
create or replace function set_delivery_order_item_qty(p_item_id uuid, p_qty numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_item   delivery_order_items%rowtype;
  v_order  delivery_orders%rowtype;
begin
  select i.* into v_item from delivery_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;
  select * into v_order from delivery_orders
   where id = v_item.order_id and tenant_id = v_tenant
   for update;
  if v_order.status = 'cancelado' or v_order.sale_id is not null then
    raise exception 'order_not_open';
  end if;

  -- ADR-097: un ítem ya enviado a cocina sólo baja con anulación (motivo).
  if coalesce(p_qty, 0) < v_item.qty and _dining_item_sent(v_item.printed_at, v_item.kds_status) then
    raise exception 'item_sent_use_void';
  end if;

  if coalesce(p_qty, 0) <= 0 then
    delete from delivery_order_items where id = p_item_id and tenant_id = v_tenant;
    update delivery_orders set updated_at = now() where id = v_item.order_id;
    return jsonb_build_object('removed', true, 'item_id', p_item_id);
  end if;

  update delivery_order_items set qty = p_qty where id = p_item_id and tenant_id = v_tenant;
  update delivery_orders set updated_at = now() where id = v_item.order_id;
  return jsonb_build_object('removed', false, 'item_id', p_item_id, 'qty', p_qty);
end;
$$;
revoke all on function set_delivery_order_item_qty(uuid, numeric) from public, anon;
grant execute on function set_delivery_order_item_qty(uuid, numeric) to authenticated;

-- ── 5) void_delivery_order_item ──────────────────────────────────────────────
create or replace function void_delivery_order_item(
  p_item_id uuid,
  p_qty     numeric,
  p_reason  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_item   delivery_order_items%rowtype;
  v_order  delivery_orders%rowtype;
  v_label  text;
  v_qty    numeric;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_void   uuid;
  v_removed boolean;
begin
  if char_length(v_reason) < 3 then
    raise exception 'void_reason_required';
  end if;

  select i.* into v_item from delivery_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;

  select * into v_order from delivery_orders
   where id = v_item.order_id and tenant_id = v_tenant
   for update;
  if v_order.status in ('cancelado', 'entregado') or v_order.sale_id is not null
     or v_order.deleted_at is not null then
    raise exception 'order_not_open';
  end if;
  v_label := _delivery_order_label(v_order.id, v_order.order_type);

  v_qty := coalesce(p_qty, v_item.qty);
  if v_qty <= 0 or v_qty > v_item.qty then
    raise exception 'invalid_qty';
  end if;

  insert into delivery_order_voids (tenant_id, order_id, item_id, product_id, name, qty,
                                    unit_price, station, course, order_label, reason, voided_by)
  values (v_tenant, v_item.order_id, v_item.id, v_item.product_id, v_item.name, v_qty,
          v_item.unit_price, v_item.station, coalesce(v_item.course, 1), v_label,
          v_reason, auth.uid())
  returning id into v_void;

  v_removed := v_qty >= v_item.qty;
  if v_removed then
    delete from delivery_order_items where id = p_item_id and tenant_id = v_tenant;
  else
    perform set_config('ninja.dining_item_void', 'on', true);
    update delivery_order_items set qty = qty - v_qty where id = p_item_id and tenant_id = v_tenant;
    perform set_config('ninja.dining_item_void', '', true);
  end if;
  update delivery_orders set updated_at = now() where id = v_item.order_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'delivery_order_items', p_item_id, 'delivery_item_voided',
          jsonb_build_object('order_id', v_item.order_id, 'name', v_item.name,
                             'qty', v_item.qty, 'unit_price', v_item.unit_price,
                             'station', v_item.station, 'kds_status', v_item.kds_status,
                             'printed_at', v_item.printed_at),
          jsonb_build_object('void_id', v_void, 'voided_qty', v_qty,
                             'remaining_qty', greatest(v_item.qty - v_qty, 0),
                             'reason', v_reason, 'order_label', v_label));

  return jsonb_build_object('void_id', v_void, 'item_id', p_item_id, 'removed', v_removed,
                            'voided_qty', v_qty,
                            'remaining_qty', greatest(v_item.qty - v_qty, 0));
end;
$$;
revoke all on function void_delivery_order_item(uuid, numeric, text) from public, anon;
grant execute on function void_delivery_order_item(uuid, numeric, text) to authenticated;

-- ── 6) Marcas de impresión y "visto" (copia de 20261105200100 + delivery) ────
create or replace function mark_comanda_void_printed(p_void_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_n int;
  v_d int;
begin
  update table_order_voids set printed_at = now()
   where id = any (coalesce(p_void_ids, '{}')) and tenant_id = v_tenant
     and printed_at is null;
  get diagnostics v_n = row_count;
  -- ADR-097: anulaciones de delivery.
  update delivery_order_voids set printed_at = now()
   where id = any (coalesce(p_void_ids, '{}')) and tenant_id = v_tenant
     and printed_at is null;
  get diagnostics v_d = row_count;
  return jsonb_build_object('marked', v_n + v_d);
end;
$$;
revoke all on function mark_comanda_void_printed(uuid[]) from public, anon;
grant execute on function mark_comanda_void_printed(uuid[]) to authenticated;

create or replace function ack_comanda_void(p_void_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
begin
  update table_order_voids set acknowledged_at = coalesce(acknowledged_at, now())
   where id = p_void_id and tenant_id = v_tenant;
  if not found then
    -- ADR-097: anulaciones de delivery.
    update delivery_order_voids set acknowledged_at = coalesce(acknowledged_at, now())
     where id = p_void_id and tenant_id = v_tenant;
    if not found then
      raise exception 'void_not_found';
    end if;
  end if;
  return jsonb_build_object('void_id', p_void_id, 'acknowledged', true);
end;
$$;
revoke all on function ack_comanda_void(uuid) from public, anon;
grant execute on function ack_comanda_void(uuid) to authenticated;

-- ── 7) kds_recent_voids (copia de 20261105200100 + delivery + source) ────────
drop function if exists kds_recent_voids(text);
create or replace function kds_recent_voids(p_station text default null)
returns table(
  void_id uuid, order_id uuid, table_label text, name text, qty numeric,
  station text, course smallint, reason text, created_at timestamptz,
  source text -- ADR-097: 'mesa' | 'delivery'
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_filter text := nullif(btrim(coalesce(p_station, '')), '');
begin
  return query
    select x.id, x.order_id, x.label, x.name, x.qty, x.station, x.course,
           x.reason, x.created_at, x.source
      from (
        select v.id, v.order_id, v.table_label as label, v.name, v.qty, v.station,
               v.course, v.reason, v.created_at, 'mesa'::text as source
          from table_order_voids v
         where v.tenant_id = v_tenant
           and v.acknowledged_at is null
           and v.created_at >= now() - interval '2 hours'
           and (v_filter is null or v.station = v_filter)
        union all
        select d.id, d.order_id, d.order_label, d.name, d.qty, d.station,
               d.course, d.reason, d.created_at, 'delivery'::text
          from delivery_order_voids d
         where d.tenant_id = v_tenant
           and d.acknowledged_at is null
           and d.created_at >= now() - interval '2 hours'
           and (v_filter is null or d.station = v_filter)
      ) x
     order by x.created_at desc
     limit 50;
end;
$$;
revoke all on function kds_recent_voids(text) from public, anon;
grant execute on function kds_recent_voids(text) to authenticated;
