-- =============================================================================
-- 20261105200100_comanda_anulaciones  (F13 · H45 follow-up: anulación parcial
--                                      de ítems enviados a cocina)
-- -----------------------------------------------------------------------------
-- Hasta hoy un ítem de la mesa se borraba con el tachito aunque la cocina ya lo
-- estuviera preparando: sin motivo, sin rastro y sin aviso a cocina. Es el hueco
-- clásico de fraude (mozo que cobra y "borra" el plato) y de desperdicio.
--
-- Regla: un ítem ENVIADO (comanda impresa, printed_at no null, o la cocina ya lo
-- tocó, kds_status <> 'pendiente') sólo se puede bajar o quitar con ANULACIÓN:
--   void_table_order_item(ítem, cantidad, motivo)
--     * motivo obligatorio (mín. 3 caracteres);
--     * cantidad parcial o total (null = todo);
--     * registra la anulación en `table_order_voids` (snapshot nombre, estación,
--       tiempo, mesa), escribe audit_logs 'comanda_item_voided' y baja/borra la
--       línea en la misma transacción.
-- Los ítems NO enviados (pendientes, sin imprimir) se siguen editando libre.
--
-- ENFORCEMENT server-side (la UI no es la única barrera):
--   * set_table_order_item_qty (copia de 20260608650000, la última) rechaza bajar
--     un ítem enviado con 'item_sent_use_void'.
--   * Trigger BEFORE UPDATE OF qty en table_order_items: bajar qty de un ítem
--     enviado exige el permiso de sesión que sólo pone void_table_order_item.
--   * La policy "for all" de table_order_items se parte en select/insert/update:
--     sin policy de DELETE, un borrado directo por REST no toca filas. Las RPCs
--     SECURITY DEFINER (dueño de la tabla) siguen borrando.
--
-- AVISO A COCINA: el KDS muestra las anulaciones recientes no vistas
-- (kds_recent_voids) con botón "Visto" (ack_comanda_void) y la UI imprime un
-- ticket de ANULACIÓN por estación (mark_comanda_void_printed).
--
-- Fuera de alcance: anulación de ítems de delivery (mismo patrón, follow-up).
-- Gating: flag operativo (dining_enabled), no feature de plan.
-- =============================================================================

-- ── 1) Registro de anulaciones ───────────────────────────────────────────────
create table if not exists table_order_voids (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  order_id    uuid not null references table_orders(id) on delete cascade,
  -- Sin FK: la línea puede desaparecer (anulación total).
  item_id     uuid not null,
  product_id  uuid references products(id) on delete set null,
  name        text not null,
  qty         numeric(12,3) not null check (qty > 0),
  unit_price  numeric(12,2) not null default 0,
  station     text,
  course      smallint not null default 1,
  table_label text,
  reason      text not null check (char_length(btrim(reason)) >= 3),
  voided_by   uuid references public.users(id) on delete set null default auth.uid(),
  printed_at  timestamptz,
  acknowledged_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists table_order_voids_tenant_idx
  on table_order_voids (tenant_id, created_at desc);
create index if not exists table_order_voids_order_idx on table_order_voids (order_id);

alter table table_order_voids enable row level security;
-- Lectura por tenant. Escritura sólo por RPC (sin policies de escritura).
create policy table_order_voids_select on table_order_voids
  for select using (tenant_id = (select current_tenant_id()));

-- ── 2) ¿Ítem enviado a cocina? ───────────────────────────────────────────────
create or replace function _dining_item_sent(p_printed_at timestamptz, p_kds_status text)
returns boolean
language sql
immutable
as $$
  select p_printed_at is not null or coalesce(p_kds_status, 'pendiente') <> 'pendiente';
$$;

-- ── 3) RLS de table_order_items sin DELETE directo ───────────────────────────
drop policy if exists table_order_items_tenant_isolation on table_order_items;
create policy table_order_items_select on table_order_items
  for select using (tenant_id = (select current_tenant_id()));
create policy table_order_items_insert on table_order_items
  for insert with check (tenant_id = (select current_tenant_id()));
create policy table_order_items_update on table_order_items
  for update using (tenant_id = (select current_tenant_id()))
  with check (tenant_id = (select current_tenant_id()));

-- ── 4) Trigger: bajar qty de un ítem enviado exige anulación ─────────────────
create or replace function _table_order_item_guard_qty()
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

drop trigger if exists table_order_items_guard_qty on table_order_items;
create trigger table_order_items_guard_qty
  before update of qty on table_order_items
  for each row execute function _table_order_item_guard_qty();

-- ── 5) set_table_order_item_qty (copia de 20260608650000 + regla de enviado) ─
create or replace function set_table_order_item_qty(
  p_item_id uuid,
  p_qty numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_item   table_order_items%rowtype;
  v_status text;
begin
  select i.* into v_item from table_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;
  -- FOR UPDATE sobre el pedido: serializa contra cobro/cancelación concurrente.
  select status into v_status from table_orders
   where id = v_item.order_id and tenant_id = v_tenant
   for update;
  if v_status <> 'abierta' then
    raise exception 'order_not_open';
  end if;

  -- F13 · H45: un ítem ya enviado a cocina sólo baja con anulación (motivo).
  if coalesce(p_qty, 0) < v_item.qty and _dining_item_sent(v_item.printed_at, v_item.kds_status) then
    raise exception 'item_sent_use_void';
  end if;

  if coalesce(p_qty, 0) <= 0 then
    delete from table_order_items where id = p_item_id and tenant_id = v_tenant;
    update table_orders set updated_at = now() where id = v_item.order_id;
    return jsonb_build_object('removed', true, 'item_id', p_item_id);
  end if;

  update table_order_items set qty = p_qty where id = p_item_id and tenant_id = v_tenant;
  update table_orders set updated_at = now() where id = v_item.order_id;
  return jsonb_build_object('removed', false, 'item_id', p_item_id, 'qty', p_qty);
end;
$$;
revoke all on function set_table_order_item_qty(uuid, numeric) from public, anon;
grant execute on function set_table_order_item_qty(uuid, numeric) to authenticated;

-- ── 6) void_table_order_item ─────────────────────────────────────────────────
create or replace function void_table_order_item(
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
  v_item   table_order_items%rowtype;
  v_status text;
  v_label  text;
  v_qty    numeric;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_void   uuid;
  v_removed boolean;
begin
  if char_length(v_reason) < 3 then
    raise exception 'void_reason_required';
  end if;

  select i.* into v_item from table_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;

  select o.status, t.label into v_status, v_label
    from table_orders o
    left join dining_tables t on t.id = o.table_id and t.tenant_id = v_tenant
   where o.id = v_item.order_id and o.tenant_id = v_tenant
   for update of o;
  if v_status <> 'abierta' then
    raise exception 'order_not_open';
  end if;

  v_qty := coalesce(p_qty, v_item.qty);
  if v_qty <= 0 or v_qty > v_item.qty then
    raise exception 'invalid_qty';
  end if;

  insert into table_order_voids (tenant_id, order_id, item_id, product_id, name, qty,
                                 unit_price, station, course, table_label, reason, voided_by)
  values (v_tenant, v_item.order_id, v_item.id, v_item.product_id, v_item.name, v_qty,
          v_item.unit_price, v_item.station, coalesce(v_item.course, 1), v_label,
          v_reason, auth.uid())
  returning id into v_void;

  v_removed := v_qty >= v_item.qty;
  if v_removed then
    delete from table_order_items where id = p_item_id and tenant_id = v_tenant;
  else
    perform set_config('ninja.dining_item_void', 'on', true);
    update table_order_items set qty = qty - v_qty where id = p_item_id and tenant_id = v_tenant;
    perform set_config('ninja.dining_item_void', '', true);
  end if;
  update table_orders set updated_at = now() where id = v_item.order_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'table_order_items', p_item_id, 'comanda_item_voided',
          jsonb_build_object('order_id', v_item.order_id, 'name', v_item.name,
                             'qty', v_item.qty, 'unit_price', v_item.unit_price,
                             'station', v_item.station, 'kds_status', v_item.kds_status,
                             'printed_at', v_item.printed_at),
          jsonb_build_object('void_id', v_void, 'voided_qty', v_qty,
                             'remaining_qty', greatest(v_item.qty - v_qty, 0),
                             'reason', v_reason, 'table_label', v_label));

  return jsonb_build_object('void_id', v_void, 'item_id', p_item_id, 'removed', v_removed,
                            'voided_qty', v_qty,
                            'remaining_qty', greatest(v_item.qty - v_qty, 0));
end;
$$;
revoke all on function void_table_order_item(uuid, numeric, text) from public, anon;
grant execute on function void_table_order_item(uuid, numeric, text) to authenticated;

-- ── 7) Marcas de impresión y "visto" en cocina ───────────────────────────────
create or replace function mark_comanda_void_printed(p_void_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_n int;
begin
  update table_order_voids set printed_at = now()
   where id = any (coalesce(p_void_ids, '{}')) and tenant_id = v_tenant
     and printed_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('marked', v_n);
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
    raise exception 'void_not_found';
  end if;
  return jsonb_build_object('void_id', p_void_id, 'acknowledged', true);
end;
$$;
revoke all on function ack_comanda_void(uuid) from public, anon;
grant execute on function ack_comanda_void(uuid) to authenticated;

-- Anulaciones de las últimas 2 horas sin "visto", para el aviso del KDS.
create or replace function kds_recent_voids(p_station text default null)
returns table(
  void_id uuid, order_id uuid, table_label text, name text, qty numeric,
  station text, course smallint, reason text, created_at timestamptz
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
    select v.id, v.order_id, v.table_label, v.name, v.qty, v.station, v.course,
           v.reason, v.created_at
      from table_order_voids v
     where v.tenant_id = v_tenant
       and v.acknowledged_at is null
       and v.created_at >= now() - interval '2 hours'
       and (v_filter is null or v.station = v_filter)
     order by v.created_at desc
     limit 50;
end;
$$;
revoke all on function kds_recent_voids(text) from public, anon;
grant execute on function kds_recent_voids(text) to authenticated;
