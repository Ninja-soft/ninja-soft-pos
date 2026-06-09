-- =============================================================================
-- 20260608590000_kds  (F13 · H46 — KDS / pantalla de cocina y barra)
--                     (+ H45 mínimo: ruteo por estación con products.station)
-- -----------------------------------------------------------------------------
-- Lleva los ítems de los pedidos de mesa (H44) a una pantalla de preparación
-- (cocina / barra / cafetería / parrilla / postres / despacho). ADITIVO: no toca
-- el mostrador ni el cobro; sólo agrega ruteo por estación y un estado KDS por
-- línea. La impresión de comanda (H45 print) y el SLA configurable son follow-up.
--
-- MODELO (reusa H44; no se toca create_sale ni el flujo de cobro):
--
--  1) RUTEO (H45 mínimo): `products.station` (text, nullable) — a qué estación va
--     el producto. Lista fija razonable (cocina/barra/cafeteria/parrilla/postres/
--     despacho) + null = "sin estación". Default por categoría queda follow-up.
--     Al cargar un ítem a la mesa, se SNAPSHOTEA la estación del producto en
--     `table_order_items.station` (queda fija aunque el producto cambie después;
--     mismo criterio que el snapshot de modifiers/precio).
--
--  2) ESTADO KDS por ítem: `table_order_items.kds_status`
--     (pendiente → preparando → listo → entregado) + `kds_ready_at` (cuándo se
--     marcó listo). Un ítem nuevo nace 'pendiente'. 'entregado' lo saca del KDS.
--
--  3) KDS = consulta tenant-scoped de los ítems ACTIVOS (pedidos abiertos, no
--     entregados) por estación, con mesa/salón/hora para la tarjeta y el timer.
--     RPCs SECURITY DEFINER con guard de miembro activo (mismo patrón que H44):
--       - kds_tickets(p_station)        → ítems activos (todas las estaciones si
--                                          p_station es null/''); orden FIFO.
--       - set_item_kds_status(item,st)  → avanza el estado (sella ready_at).
--
-- FUERA DE ALCANCE (follow-up, NO en este PR): comanda IMPRESA + impresora por
-- estación (H45 print), SLA configurable avanzado, cancelación parcial con
-- re-impresión, KDS de barra físicamente separado, modo offline del KDS.
-- types/database.ts NO se regenera (el front castea; la DB + RLS validan).
-- =============================================================================

-- ── 1) Ruteo por estación: products.station (H45 mínimo) ─────────────────────
-- Nullable: null = "sin estación" (no va a ninguna pantalla de preparación). Sin
-- CHECK rígido para no romper futuras estaciones; la UI ofrece la lista fija.
alter table products add column if not exists station text;

-- ── 2) Estado KDS por línea del pedido de mesa ───────────────────────────────
-- station: snapshot de products.station al cargar el ítem (ruteo fijo).
-- kds_status: pendiente → preparando → listo → entregado.
-- kds_ready_at: instante en que se marcó 'listo' (para métricas / orden).
alter table table_order_items
  add column if not exists station      text,
  add column if not exists kds_status   text not null default 'pendiente'
    check (kds_status in ('pendiente','preparando','listo','entregado')),
  add column if not exists kds_ready_at  timestamptz;

-- Índice para la consulta del KDS: ítems activos por estación, FIFO por carga.
-- Acota a lo que el KDS realmente mira (no 'entregado').
create index if not exists table_order_items_kds_idx
  on table_order_items (tenant_id, station, created_at)
  where kds_status <> 'entregado';

-- ── 3) add_table_order_item: ahora snapshotea la estación del producto ────────
-- Misma firma que H44 (el picker/POS no cambian). Si el ítem trae product_id,
-- copia products.station a la línea; si es ítem libre (sin product_id), queda
-- sin estación (null) salvo que se rutee a mano más adelante (follow-up).
create or replace function add_table_order_item(
  p_order_id   uuid,
  p_product_id uuid,
  p_name       text,
  p_qty        numeric,
  p_unit_price numeric,
  p_modifiers  jsonb default '[]'::jsonb,
  p_notes      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_order  table_orders%rowtype;
  v_item_id uuid;
  v_station text;
begin
  select * into v_order from table_orders
   where id = p_order_id and tenant_id = v_tenant;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status <> 'abierta' then
    raise exception 'order_not_open';
  end if;
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'invalid_qty';
  end if;

  -- Ruteo: estación del producto (si es del catálogo). Ítem libre → null.
  if p_product_id is not null then
    select nullif(btrim(station), '') into v_station
      from products
     where id = p_product_id and tenant_id = v_tenant;
  end if;

  insert into table_order_items
    (tenant_id, order_id, product_id, name, qty, unit_price, modifiers, notes,
     station, kds_status)
  values (
    v_tenant, p_order_id, p_product_id,
    coalesce(nullif(btrim(p_name), ''), 'Ítem'),
    p_qty, greatest(coalesce(p_unit_price, 0), 0),
    coalesce(p_modifiers, '[]'::jsonb), nullif(btrim(p_notes), ''),
    v_station, 'pendiente'
  )
  returning id into v_item_id;

  -- Tocar el pedido (updated_at) para refrescar el total acumulado.
  update table_orders set updated_at = now() where id = p_order_id;

  return v_item_id;
end;
$$;
revoke all on function add_table_order_item(uuid, uuid, text, numeric, numeric, jsonb, text) from public, anon;
grant execute on function add_table_order_item(uuid, uuid, text, numeric, numeric, jsonb, text) to authenticated;

-- ── 4) kds_tickets: ítems activos por estación (tenant-scoped) ────────────────
-- Devuelve las líneas de pedidos ABIERTOS que todavía no se entregaron, con la
-- mesa / salón / hora para la tarjeta y el timer. p_station null o '' = todas.
-- 'entregado' nunca aparece (sale de la vista). Orden FIFO (por carga) para
-- atender lo más viejo primero. SECURITY DEFINER + guard de miembro activo.
create or replace function kds_tickets(p_station text default null)
returns table (
  item_id     uuid,
  order_id    uuid,
  table_id    uuid,
  table_label text,
  area_name   text,
  product_id  uuid,
  name        text,
  qty         numeric,
  modifiers   jsonb,
  notes       text,
  station     text,
  kds_status  text,
  created_at  timestamptz,
  ready_at    timestamptz
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
    select
      i.id, i.order_id, t.id, t.label, a.name,
      i.product_id, i.name, i.qty, i.modifiers, i.notes,
      i.station, i.kds_status, i.created_at, i.kds_ready_at
    from table_order_items i
    join table_orders o   on o.id = i.order_id and o.tenant_id = v_tenant
    join dining_tables t  on t.id = o.table_id  and t.tenant_id = v_tenant
    left join dining_areas a on a.id = t.area_id and a.tenant_id = v_tenant
    where i.tenant_id = v_tenant
      and o.status = 'abierta'
      and i.kds_status <> 'entregado'
      and (v_filter is null or i.station = v_filter)
    order by i.created_at asc;
end;
$$;
revoke all on function kds_tickets(text) from public, anon;
grant execute on function kds_tickets(text) to authenticated;

-- ── 5) set_item_kds_status: avanza el estado de una línea ─────────────────────
-- pendiente → preparando → listo → entregado (o vuelta atrás). Al pasar a
-- 'listo' sella kds_ready_at; al salir de 'listo' lo limpia. tenant-scoped +
-- guard de miembro activo. No exige que el pedido esté abierto (la cocina puede
-- cerrar un ítem aunque la mesa ya esté en cuenta pedida), pero sí del tenant.
create or replace function set_item_kds_status(p_item_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_item   table_order_items%rowtype;
begin
  if p_status not in ('pendiente','preparando','listo','entregado') then
    raise exception 'invalid_status';
  end if;
  select i.* into v_item from table_order_items i
   where i.id = p_item_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'item_not_found';
  end if;

  update table_order_items
     set kds_status   = p_status,
         kds_ready_at = case
                          when p_status = 'listo' then coalesce(kds_ready_at, now())
                          when p_status = 'entregado' then kds_ready_at
                          else null
                        end
   where id = p_item_id and tenant_id = v_tenant;

  return jsonb_build_object('item_id', p_item_id, 'kds_status', p_status);
end;
$$;
revoke all on function set_item_kds_status(uuid, text) from public, anon;
grant execute on function set_item_kds_status(uuid, text) to authenticated;
