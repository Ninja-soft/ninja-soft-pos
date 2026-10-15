-- =============================================================================
-- ADR-149 · F22 · H143 (L0): ordenar y arreglar la logística que ya existe.
--
-- Sin funciones nuevas grandes: corrige lo roto que encontró la auditoría de
-- docs/45-logistica-reparto.md (§2.3) y deja la base sana para L1 a L6.
--
--   A1  dispatch_create_for_sale suma una entrega a una venta que ya tiene
--       partes (venta repartida), sólo con lo que falta entregar por producto.
--   A2  Anular una venta cancela sus entregas abiertas; devolver lo que no se
--       entregó cancela las entregas abiertas de ese producto. Los remitos
--       emitidos no se tocan: queda el aviso en la auditoría.
--   A3  Cancelar una entrega que movió stock entre sucursales o desde un
--       depósito lo devuelve a donde está la mercadería (_dispatch_close).
--   A4  La sucursal que vendió también opera la entrega (_dispatch_lock).
--   A5  dispatch_ship engancha el envío de ESA entrega (shipments.dispatch_id),
--       nunca "el último de la venta" si hay más de uno.
--   A6  Despachar escribe shipped_at (no delivered_at); el estado del envío
--       vuelve a la entrega (trigger en shipments): entregado, cancelado.
--   A7  Cobrar un pedido de delivery que todavía no salió no lo marca
--       entregado (trigger en delivery_orders).
--   A11 shipment_create acepta dispatch_id: el envío nace enganchado.
--   A13 Un remito activo por venta y producto: remito_issue no repite lo que
--       ya está en otro remito activo de la misma venta. remito_preview
--       devuelve renglones y valor antes de emitir (A9).
--   R18 sales.fulfillment_mode (en_mostrador, retiro, envio, logistica,
--       mixto), mantenida por trigger desde las entregas.
--
-- Cada función parte de la definición vigente en producción
-- (pg_get_functiondef al 2026-10-15). Escrituras sólo por RPC SECURITY
-- DEFINER, auditoría en audit_logs, sin policies nuevas (las tablas no
-- cambian de alcance). Producción: 0 entregas, 0 remitos, 0 envíos, así que el
-- backfill es trivial.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Columnas
-- -----------------------------------------------------------------------------
alter table dispatches add column if not exists shipped_by uuid references public.users(id);
alter table dispatches add column if not exists shipped_at timestamptz;
alter table dispatches add column if not exists shipment_status text;
alter table dispatches add column if not exists stock_returned_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dispatches_shipment_status_check') then
    alter table dispatches add constraint dispatches_shipment_status_check
      check (shipment_status is null or char_length(shipment_status) <= 40);
  end if;
end;
$$;

comment on column dispatches.shipped_at is 'Cuándo se entregó a la logística o al cadete (ADR-149, A6). delivered_at queda para la entrega real.';
comment on column dispatches.shipment_status is 'Último estado del envío con logística enganchado (shipments.status), copiado por trigger (ADR-149, A6).';
comment on column dispatches.stock_returned_at is 'Al cancelar: cuándo se devolvió el stock movido entre sucursales o desde un depósito (ADR-149, A3).';

create index if not exists dispatches_shipped_by_idx on dispatches(shipped_by) where shipped_by is not null;

-- "Despachado" ya no es "entregado": lo de antes pasa a shipped_at.
update dispatches
   set shipped_at = delivered_at, shipped_by = delivered_by, delivered_at = null, delivered_by = null
 where status = 'despachado' and shipped_at is null;

grant select (shipped_by, shipped_at, shipment_status, stock_returned_at) on dispatches to authenticated;

alter table shipments add column if not exists dispatch_id uuid references dispatches(id) on delete set null;
comment on column shipments.dispatch_id is 'Entrega de Expedición que lleva este envío (ADR-149, A5 y A11).';
create index if not exists shipments_dispatch_idx on shipments(dispatch_id) where dispatch_id is not null;
-- Un envío vivo por entrega (los cancelados no cuentan).
create unique index if not exists shipments_dispatch_active_key on shipments(dispatch_id)
  where dispatch_id is not null and deleted_at is null and status <> 'cancelled';

-- Enganche de los envíos que ya apuntaban desde la entrega.
update shipments sh
   set dispatch_id = d.id
  from dispatches d
 where d.shipment_id = sh.id and sh.dispatch_id is null and d.deleted_at is null and d.status <> 'cancelado';

alter table sales add column if not exists fulfillment_mode text not null default 'en_mostrador';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_fulfillment_mode_check') then
    alter table sales add constraint sales_fulfillment_mode_check
      check (fulfillment_mode in ('en_mostrador', 'retiro', 'envio', 'logistica', 'mixto'));
  end if;
end;
$$;
comment on column sales.fulfillment_mode is
  'Cómo se entrega la venta (ADR-149, R18): en_mostrador, retiro, envio, logistica o mixto. La mantiene el trigger de dispatches.';
create index if not exists sales_fulfillment_mode_idx on sales(tenant_id, fulfillment_mode, created_at desc)
  where fulfillment_mode <> 'en_mostrador';

-- -----------------------------------------------------------------------------
-- B) R18: modo de entrega de la venta
-- -----------------------------------------------------------------------------
create or replace function _sale_fulfillment_mode(p_sale uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
           when count(distinct x.m) = 0 then 'en_mostrador'
           when count(distinct x.m) = 1 then min(x.m)
           else 'mixto'
         end
    from (
      select case when d.delivery_type = 'envio' and d.shipment_id is not null then 'logistica'
                  else d.delivery_type end as m
        from dispatches d
       where d.sale_id = p_sale and d.status <> 'cancelado' and d.deleted_at is null
         and d.delivery_type <> 'inmediato'
    ) x;
$$;
revoke all on function _sale_fulfillment_mode(uuid) from public, anon, authenticated;

create or replace function trg_dispatches_sale_mode()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text := _sale_fulfillment_mode(new.sale_id);
begin
  update sales set fulfillment_mode = v_mode
   where id = new.sale_id and fulfillment_mode is distinct from v_mode;
  return null;
end;
$$;
revoke all on function trg_dispatches_sale_mode() from public, anon, authenticated;

drop trigger if exists dispatches_sale_mode on dispatches;
create trigger dispatches_sale_mode
  after insert or update of status, delivery_type, shipment_id, deleted_at on dispatches
  for each row execute function trg_dispatches_sale_mode();

update sales s
   set fulfillment_mode = _sale_fulfillment_mode(s.id)
 where exists (select 1 from dispatches d where d.sale_id = s.id)
   and s.fulfillment_mode is distinct from _sale_fulfillment_mode(s.id);

-- -----------------------------------------------------------------------------
-- C) Transiciones: lo despachado sin logística se puede marcar entregado
-- (espejo en lib/orders/logic.ts, dispatchCanMove).
-- -----------------------------------------------------------------------------
create or replace function public._dispatch_can(p_from text, p_to text, p_type text, p_cross boolean, p_arrived boolean)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when p_from in ('entregado', 'cancelado') then false
    when p_from = 'despachado' then p_to = 'entregado' and p_type = 'envio'
    when p_to = 'cancelado' then true
    when p_from = 'pendiente' then p_to in ('armando', 'listo')
    when p_from = 'armando' then p_to in ('pendiente', 'listo')
    when p_from = 'en_transito' then p_to = 'listo'
    when p_from = 'listo' then
      case
        when p_to = 'armando' then not (p_cross and p_arrived)
        when p_to = 'en_transito' then p_cross and not p_arrived
        when p_to = 'entregado' then p_type in ('inmediato', 'retiro') and (not p_cross or p_arrived)
        when p_to = 'despachado' then p_type = 'envio' and (not p_cross or p_arrived)
        else false
      end
    else false
  end;
$function$;

-- -----------------------------------------------------------------------------
-- D) A4: la sucursal que vendió también opera
-- -----------------------------------------------------------------------------
create or replace function public._dispatch_lock(p_id uuid)
 RETURNS dispatches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_d dispatches;
begin
  select * into v_d from dispatches
   where id = p_id and tenant_id = current_tenant_id() and deleted_at is null
   for update;
  if v_d.id is null then
    raise exception 'dispatch_not_found';
  end if;
  if stock_my_role() is null or stock_my_role() = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_d.tenant_id, 'pedidos_despacho') then
    raise exception 'feature_not_in_plan: pedidos_despacho' using errcode = 'check_violation';
  end if;
  if not (coalesce(user_can_access_store(v_d.store_id), false)
          or coalesce(user_can_access_store(v_d.fulfillment_store_id), false)
          or coalesce(user_can_access_store(v_d.sale_store_id), false)) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  return v_d;
end;
$function$;

-- -----------------------------------------------------------------------------
-- E) A3: cerrar una entrega devolviendo el stock movido. Interna: la usan
-- dispatch_cancel y los triggers de anulación y devolución.
-- -----------------------------------------------------------------------------
create or replace function _dispatch_close(p_id uuid, p_reason text, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d      dispatches;
  it       record;
  v_dest   uuid;
  v_moved  jsonb := '[]'::jsonb;
begin
  select * into v_d from dispatches where id = p_id for update;
  if v_d.id is null or v_d.status in ('entregado', 'despachado', 'cancelado') then
    return null;
  end if;

  if v_d.stock_returned_at is null then
    for it in
      select di.*, w.kind as wh_kind
        from dispatch_items di
        left join warehouses w on w.id = di.source_warehouse_id
       where di.dispatch_id = v_d.id
       order by di.source_store_id, di.source_warehouse_id nulls first, di.product_id, di.variant_id nulls first
    loop
      -- Sólo lo que pos_sale_create_fulfilled movió: de otra sucursal o de un
      -- depósito que no es el salón.
      if it.source_store_id = it.sale_store_id and coalesce(it.wh_kind, 'principal') = 'principal' then
        continue;
      end if;
      -- La mercadería está donde llegó (si ya llegó) o en su origen.
      v_dest := case when v_d.arrived_at is not null then v_d.fulfillment_store_id else it.source_store_id end;
      if v_d.arrived_at is null and coalesce(it.wh_kind, 'principal') <> 'principal' then
        insert into warehouse_stock (tenant_id, warehouse_id, store_id, product_id, variant_id, qty)
        values (it.tenant_id, it.source_warehouse_id, it.source_store_id, it.product_id, it.variant_id, it.qty)
        on conflict on constraint warehouse_stock_line_key
          do update set qty = warehouse_stock.qty + excluded.qty, updated_at = now();
      end if;
      if v_dest <> it.sale_store_id then
        perform transfer_move_stock(it.tenant_id, it.sale_store_id, it.product_id, it.variant_id, -it.qty, 'transfer_out',
                                    v_d.id, 'Entrega cancelada: vuelve a su sucursal (ADR-149)');
        perform transfer_move_stock(it.tenant_id, v_dest, it.product_id, it.variant_id, it.qty, 'transfer_in',
                                    v_d.id, 'Entrega cancelada: vuelve a su sucursal (ADR-149)');
      end if;
      v_moved := v_moved || jsonb_build_array(jsonb_build_object(
        'product_id', it.product_id, 'variant_id', it.variant_id, 'qty', it.qty,
        'from_store_id', it.sale_store_id, 'to_store_id', v_dest,
        'warehouse_id', case when v_d.arrived_at is null and coalesce(it.wh_kind, 'principal') <> 'principal'
                             then it.source_warehouse_id end));
    end loop;
  end if;

  update dispatches
     set status = 'cancelado', cancel_reason = left(p_reason, 300), cancelled_by = auth.uid(), cancelled_at = now(),
         stock_returned_at = case when jsonb_array_length(v_moved) > 0 then now() else stock_returned_at end
   where id = v_d.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', v_d.id, p_action,
          jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', 'cancelado', 'sale_id', v_d.sale_id, 'stock_returned', v_moved),
          left(p_reason, 300), v_d.store_id);
  return jsonb_build_object('id', v_d.id, 'stock_returned', v_moved);
end;
$$;
revoke all on function _dispatch_close(uuid, text, text) from public, anon, authenticated;

create or replace function public.dispatch_cancel(p_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_d      dispatches;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  v_d := _dispatch_lock(p_id);
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'cancel_requires_manager' using errcode = '42501';
  end if;
  if v_d.status in ('entregado', 'despachado', 'cancelado') then
    raise exception 'invalid_transition: % -> cancelado', v_d.status;
  end if;
  perform _dispatch_close(p_id, v_reason, 'dispatch_cancelled');
end;
$function$;

-- -----------------------------------------------------------------------------
-- F) A2: anular la venta cancela sus entregas abiertas; devolver lo que no se
-- entregó cancela las entregas abiertas de ese producto.
-- -----------------------------------------------------------------------------
create or replace function trg_sales_void_dispatches()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d       record;
  v_n     int := 0;
  v_rem   jsonb;
  v_ships jsonb;
begin
  if new.status = 'voided' and old.status is distinct from 'voided' then
    for d in
      select id from dispatches
       where sale_id = new.id and deleted_at is null and status not in ('entregado', 'despachado', 'cancelado')
       order by part, id
    loop
      perform _dispatch_close(d.id, 'Venta anulada', 'dispatch_cancelled_sale_voided');
      v_n := v_n + 1;
    end loop;
    select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'pto_vta', r.pto_vta, 'number', r.number)), '[]'::jsonb)
      into v_rem
      from remitos r where r.sale_id = new.id and r.status = 'emitido' and r.deleted_at is null;
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'number', x.number, 'shipment_id', x.shipment_id)), '[]'::jsonb)
      into v_ships
      from dispatches x where x.sale_id = new.id and x.status = 'despachado' and x.deleted_at is null;
    if v_n > 0 or jsonb_array_length(v_rem) > 0 or jsonb_array_length(v_ships) > 0 then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
      values (new.tenant_id, auth.uid(), 'sales', new.id, 'sale_voided_logistics',
              jsonb_build_object('sale_number', new.number, 'dispatches_cancelled', v_n,
                                 'remitos_open', v_rem, 'dispatches_shipped', v_ships),
              new.store_id);
    end if;
  end if;
  return null;
end;
$$;
revoke all on function trg_sales_void_dispatches() from public, anon, authenticated;

drop trigger if exists sales_void_dispatches on sales;
create trigger sales_void_dispatches
  after update of status on sales
  for each row
  when (new.status = 'voided' and old.status is distinct from 'voided')
  execute function trg_sales_void_dispatches();

create or replace function trg_sale_return_items_dispatches()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale     uuid;
  v_variant  uuid;
  v_returned numeric;
  v_given    numeric;
  d          record;
begin
  if new.product_id is null then
    return null;
  end if;
  select r.sale_id into v_sale from sale_returns r where r.id = new.return_id;
  if v_sale is null or not exists (select 1 from dispatches x where x.sale_id = v_sale and x.deleted_at is null) then
    return null;
  end if;
  select si.variant_id into v_variant from sale_items si where si.id = new.sale_item_id;

  -- Devuelto en total vs. lo que ya se le dio (entregado o despachado).
  select coalesce(sum(ri.quantity), 0) into v_returned
    from sale_return_items ri
    join sale_returns r on r.id = ri.return_id
    left join sale_items si on si.id = ri.sale_item_id
   where r.sale_id = v_sale and ri.product_id = new.product_id and si.variant_id is not distinct from v_variant;
  select coalesce(sum(di.qty), 0) into v_given
    from dispatch_items di
    join dispatches x on x.id = di.dispatch_id
   where x.sale_id = v_sale and x.deleted_at is null and x.status in ('entregado', 'despachado')
     and di.product_id = new.product_id and di.variant_id is not distinct from v_variant;
  if v_returned <= v_given then
    return null;
  end if;

  -- Devolvió algo que todavía no recibió: esa entrega ya no sale como estaba.
  for d in
    select distinct x.id, x.part
      from dispatches x
      join dispatch_items di on di.dispatch_id = x.id
     where x.sale_id = v_sale and x.deleted_at is null and x.status not in ('entregado', 'despachado', 'cancelado')
       and di.product_id = new.product_id and di.variant_id is not distinct from v_variant
     order by x.part, x.id
  loop
    perform _dispatch_close(d.id, 'Devolución de algo que no se había entregado', 'dispatch_cancelled_sale_returned');
  end loop;
  return null;
end;
$$;
revoke all on function trg_sale_return_items_dispatches() from public, anon, authenticated;

drop trigger if exists sale_return_items_dispatches on sale_return_items;
create trigger sale_return_items_dispatches
  after insert on sale_return_items
  for each row execute function trg_sale_return_items_dispatches();

-- -----------------------------------------------------------------------------
-- G) A1: sumar una entrega a una venta que ya tiene partes
-- -----------------------------------------------------------------------------
create or replace function public.dispatch_create_for_sale(p_sale_id uuid, p_delivery jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_tenant uuid;
  v_sale   record;
  v_type   text := coalesce(nullif(btrim(p_delivery ->> 'delivery_type'), ''), 'retiro');
  v_ful    uuid;
  v_cfg    jsonb;
  v_pickup text := nullif(btrim(coalesce(p_delivery ->> 'pickup_name', '')), '');
  v_cname  text;
  v_id     uuid;
  v_code   text;
  v_pick   jsonb := coalesce(p_delivery -> 'items', '[]'::jsonb);
  v_rows   jsonb;
  v_has    boolean;
  v_number int;
  v_part   int;
begin
  select s.id, s.store_id, s.status, s.customer_id, s.number into v_sale
    from sales s where s.id = p_sale_id and s.tenant_id = current_tenant_id()
   for update;
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  v_tenant := _order_assert(v_sale.store_id);
  if v_sale.status <> 'completed' then
    raise exception 'sale_not_completed';
  end if;
  if jsonb_typeof(v_pick) is distinct from 'array' then
    raise exception 'invalid_items';
  end if;
  -- Una entrega de H32 (sin renglones) cubre toda la venta.
  if exists (
    select 1 from dispatches d
     where d.sale_id = p_sale_id and d.status <> 'cancelado' and d.deleted_at is null
       and not exists (select 1 from dispatch_items di where di.dispatch_id = d.id)
  ) then
    raise exception 'sale_already_dispatched';
  end if;
  v_ful := _order_delivery_check(v_tenant, v_sale.store_id, v_type,
                                 nullif(p_delivery ->> 'fulfillment_store_id', '')::uuid,
                                 p_delivery ->> 'ship_address');
  if v_type = 'inmediato' then
    raise exception 'invalid_delivery_type';
  end if;
  v_cfg := pos_order_config(v_tenant);
  select c.name into v_cname from customers c where c.id = v_sale.customer_id;
  if v_type = 'retiro' then
    v_pickup := coalesce(v_pickup, v_cname);
    if v_pickup is null then
      raise exception 'pickup_name_required';
    end if;
  end if;

  -- Lo que falta entregar por producto: vendido, menos lo que está en entregas
  -- vigentes, menos lo devuelto que nunca se le dio.
  select exists (
    select 1 from sale_items si join products p on p.id = si.product_id
     where si.sale_id = p_sale_id and not coalesce(p.is_service, false)
  ) into v_has;
  with sold as (
    select si.product_id, si.variant_id, min(si.product_name) as name, min(si.sku) as sku,
           coalesce(min(si.unit_label), min(p.unit), 'un') as unit,
           sum(si.quantity) as qty, sum(coalesce(si.returned_qty, 0)) as returned
      from sale_items si
      join products p on p.id = si.product_id
     where si.sale_id = p_sale_id and not coalesce(p.is_service, false) and si.quantity > 0
     group by si.product_id, si.variant_id
  ),
  used as (
    select di.product_id, di.variant_id, sum(di.qty) as qty,
           sum(di.qty) filter (where d.status in ('entregado', 'despachado')) as given
      from dispatch_items di
      join dispatches d on d.id = di.dispatch_id
     where d.sale_id = p_sale_id and d.status <> 'cancelado' and d.deleted_at is null
     group by di.product_id, di.variant_id
  ),
  pend as (
    select s.product_id, s.variant_id, s.name, s.sku, s.unit,
           s.qty - coalesce(u.qty, 0) - greatest(s.returned - coalesce(u.given, 0), 0) as qty
      from sold s
      left join used u on u.product_id = s.product_id and u.variant_id is not distinct from s.variant_id
  ),
  pick as (
    select x.product_id, x.variant_id, sum(x.qty) as qty
      from jsonb_to_recordset(v_pick) as x(product_id uuid, variant_id uuid, qty numeric)
     group by 1, 2
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', pd.product_id, 'variant_id', pd.variant_id, 'name', pd.name,
           'variant_label', v.option1 || coalesce(' / ' || v.option2, ''), 'sku', coalesce(v.sku, pd.sku),
           'unit', pd.unit,
           'qty', case when jsonb_array_length(v_pick) = 0 then pd.qty else pk.qty end,
           'pending', pd.qty) order by pd.name), '[]'::jsonb)
    into v_rows
    from pend pd
    left join pick pk on pk.product_id = pd.product_id and pk.variant_id is not distinct from pd.variant_id
    left join product_variants v on v.id = pd.variant_id
   where pd.qty > 0.0005
     and (jsonb_array_length(v_pick) = 0 or coalesce(pk.qty, 0) > 0);

  if jsonb_array_length(v_pick) > 0 then
    if exists (select 1 from jsonb_to_recordset(v_pick) as x(qty numeric) where coalesce(x.qty, 0) <= 0) then
      raise exception 'invalid_qty';
    end if;
    -- Lo pedido tiene que estar pendiente y no pasarse.
    if exists (
      select 1
        from (select x.product_id, x.variant_id, sum(x.qty) as qty
                from jsonb_to_recordset(v_pick) as x(product_id uuid, variant_id uuid, qty numeric) group by 1, 2) pk
        left join jsonb_to_recordset(v_rows) as r(product_id uuid, variant_id uuid, pending numeric)
          on r.product_id = pk.product_id and r.variant_id is not distinct from pk.variant_id
       where pk.qty > coalesce(r.pending, 0) + 0.0005
    ) then
      raise exception 'delivery_qty_mismatch';
    end if;
  end if;

  if v_has and jsonb_array_length(v_rows) = 0 then
    raise exception 'nothing_pending';
  end if;
  -- Venta sin productos con stock (sólo renglones libres): como H32, una
  -- entrega sin renglones y una sola vez.
  if not v_has and exists (
    select 1 from dispatches d where d.sale_id = p_sale_id and d.status <> 'cancelado' and d.deleted_at is null
  ) then
    raise exception 'sale_already_dispatched';
  end if;

  perform pg_advisory_xact_lock(hashtext('dispatch_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from dispatches where tenant_id = v_tenant;
  select coalesce(max(part), 0) + 1 into v_part from dispatches where sale_id = p_sale_id;
  if v_part > 20 then
    raise exception 'too_many_deliveries';
  end if;
  update dispatches set parts_total = v_part where sale_id = p_sale_id and parts_total < v_part;

  insert into dispatches (
    tenant_id, number, sale_id, store_id, fulfillment_store_id, sale_store_id, delivery_type,
    customer_name, pickup_name, ship_address, notes, part, parts_total, created_by
  ) values (
    v_tenant, v_number, p_sale_id, v_sale.store_id, v_ful, v_sale.store_id, v_type,
    left(coalesce(v_cname, v_pickup), 120), left(v_pickup, 120),
    case when v_type = 'envio' then left(nullif(btrim(coalesce(p_delivery ->> 'ship_address', '')), ''), 300) end,
    left(nullif(btrim(coalesce(p_delivery ->> 'notes', '')), ''), 500), v_part, v_part, auth.uid()
  )
  returning id into v_id;

  insert into dispatch_items (
    tenant_id, dispatch_id, sale_id, store_id, fulfillment_store_id, sale_store_id, product_id, variant_id,
    product_name, variant_label, sku, unit, qty, source_store_id, source_warehouse_id, sort
  )
  select v_tenant, v_id, p_sale_id, v_sale.store_id, v_ful, v_sale.store_id, r.product_id, r.variant_id,
         r.name, r.variant_label, r.sku, coalesce(r.unit, 'un'), r.qty, v_sale.store_id, null,
         (row_number() over (order by r.name, r.variant_label))::int
    from jsonb_to_recordset(v_rows) as r(product_id uuid, variant_id uuid, name text, variant_label text,
                                         sku text, unit text, qty numeric);

  if v_type = 'retiro' and coalesce((v_cfg -> 'delivery_types' -> 'retiro' ->> 'pickup_code')::boolean, false) then
    v_code := otp_random_digits(6);
    update dispatches set pickup_code_hash = stock_reservation_code_hash(v_id, v_code) where id = v_id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'dispatches', v_id, 'dispatch_created',
          jsonb_build_object('number', v_number, 'sale_id', p_sale_id, 'sale_number', v_sale.number,
                             'delivery_type', v_type, 'part', v_part, 'fulfillment_store_id', v_ful,
                             'items', (select coalesce(jsonb_agg(x - 'pending' - 'name' - 'sku' - 'unit' - 'variant_label'), '[]'::jsonb)
                                         from jsonb_array_elements(v_rows) x)),
          v_sale.store_id);

  return jsonb_build_object('id', v_id, 'number', v_number, 'part', v_part, 'pickup_code', v_code,
                            'items', jsonb_array_length(v_rows));
end;
$function$;

-- Lo que falta entregar de una venta (para el modal "Agregar una venta").
create or replace function public.dispatch_sale_pending(p_sale_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale record;
  v_rows jsonb;
begin
  select s.id, s.store_id, s.status, s.number into v_sale
    from sales s where s.id = p_sale_id and s.tenant_id = current_tenant_id();
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  perform _order_assert(v_sale.store_id);
  with sold as (
    select si.product_id, si.variant_id, min(si.product_name) as name, sum(si.quantity) as qty,
           sum(coalesce(si.returned_qty, 0)) as returned
      from sale_items si join products p on p.id = si.product_id
     where si.sale_id = p_sale_id and not coalesce(p.is_service, false) and si.quantity > 0
     group by si.product_id, si.variant_id
  ),
  used as (
    select di.product_id, di.variant_id, sum(di.qty) as qty,
           sum(di.qty) filter (where d.status in ('entregado', 'despachado')) as given
      from dispatch_items di join dispatches d on d.id = di.dispatch_id
     where d.sale_id = p_sale_id and d.status <> 'cancelado' and d.deleted_at is null
     group by di.product_id, di.variant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id, 'variant_id', s.variant_id,
           'name', s.name || coalesce(' (' || v.option1 || coalesce(' / ' || v.option2, '') || ')', ''),
           'sold', s.qty, 'in_dispatches', coalesce(u.qty, 0), 'returned', s.returned,
           'pending', greatest(s.qty - coalesce(u.qty, 0) - greatest(s.returned - coalesce(u.given, 0), 0), 0))
           order by s.name), '[]'::jsonb)
    into v_rows
    from sold s
    left join used u on u.product_id = s.product_id and u.variant_id is not distinct from s.variant_id
    left join product_variants v on v.id = s.variant_id;
  return jsonb_build_object('sale_id', v_sale.id, 'number', v_sale.number, 'status', v_sale.status,
                            'store_id', v_sale.store_id, 'items', v_rows);
end;
$$;
revoke all on function public.dispatch_sale_pending(uuid) from public, anon;
grant execute on function public.dispatch_sale_pending(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- H) A5 y A6: despachar engancha el envío de esta entrega y escribe shipped_at
-- -----------------------------------------------------------------------------
create or replace function public.dispatch_ship(p_id uuid, p_tracking text DEFAULT NULL::text, p_shipment_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_d     dispatches;
  v_sh    shipments;
  v_track text := left(nullif(btrim(coalesce(p_tracking, '')), ''), 120);
begin
  v_d := _dispatch_lock(p_id);
  if not _dispatch_can(v_d.status, 'despachado', v_d.delivery_type, v_d.fulfillment_store_id <> v_d.store_id,
                       v_d.arrived_at is not null) then
    raise exception 'invalid_transition: % -> despachado', v_d.status;
  end if;
  if p_shipment_id is not null then
    select * into v_sh from shipments sh
     where sh.id = p_shipment_id and sh.tenant_id = v_d.tenant_id and sh.sale_id = v_d.sale_id
       and sh.deleted_at is null and sh.status <> 'cancelled'
       and (sh.dispatch_id is null or sh.dispatch_id = v_d.id);
    if v_sh.id is null then
      raise exception 'shipment_not_found';
    end if;
  else
    -- El de esta entrega; si no hay, el único envío vivo de la venta que no
    -- es de otra entrega. Con dos candidatos no adivina.
    select * into v_sh from shipments sh
     where sh.tenant_id = v_d.tenant_id and sh.deleted_at is null and sh.status <> 'cancelled'
       and (sh.dispatch_id = v_d.id or sh.id = v_d.shipment_id)
     order by sh.created_at desc
     limit 1;
    if v_sh.id is null and (
      select count(*) from shipments sh
       where sh.tenant_id = v_d.tenant_id and sh.sale_id = v_d.sale_id and sh.deleted_at is null
         and sh.status <> 'cancelled' and sh.dispatch_id is null
    ) = 1 then
      select * into v_sh from shipments sh
       where sh.tenant_id = v_d.tenant_id and sh.sale_id = v_d.sale_id and sh.deleted_at is null
         and sh.status <> 'cancelled' and sh.dispatch_id is null;
    end if;
  end if;
  if v_sh.id is not null and exists (
    select 1 from dispatches o where o.shipment_id = v_sh.id and o.id <> v_d.id and o.status <> 'cancelado'
  ) then
    raise exception 'shipment_in_use';
  end if;
  v_track := coalesce(v_track, v_sh.tracking_number);

  update dispatches
     set status = 'despachado', shipped_by = auth.uid(), shipped_at = now(),
         shipment_id = v_sh.id, shipment_status = v_sh.status, tracking = v_track
   where id = p_id;
  if v_sh.id is not null and v_sh.dispatch_id is null then
    update shipments set dispatch_id = p_id where id = v_sh.id;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', p_id, 'dispatch_shipped',
          jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', 'despachado', 'shipment_id', v_sh.id, 'tracking', v_track),
          v_d.fulfillment_store_id);
  -- Si la logística ya lo entregó, queda entregado.
  if v_sh.status = 'delivered' then
    update dispatches
       set status = 'entregado', delivered_at = coalesce(v_sh.delivered_at, now()),
           delivered_to = left(coalesce(v_sh.recipient ->> 'name', customer_name), 120)
     where id = p_id;
  end if;
end;
$function$;

-- Lo despachado sin logística (cadete propio) se marca entregado a mano.
create or replace function public.dispatch_deliver(p_id uuid, p_code text DEFAULT NULL::text, p_delivered_to text DEFAULT NULL::text, p_override_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_d        dispatches;
  v_role     text := stock_my_role();
  v_to       text := nullif(btrim(coalesce(p_delivered_to, '')), '');
  v_override text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_ok_code  boolean := false;
  v_cross    boolean;
begin
  v_d := _dispatch_lock(p_id);
  v_cross := v_d.fulfillment_store_id <> v_d.store_id;
  if not _dispatch_can(v_d.status, 'entregado', v_d.delivery_type, v_cross, v_d.arrived_at is not null) then
    raise exception 'invalid_transition: % -> entregado', v_d.status;
  end if;
  if not (coalesce(user_can_access_store(v_d.fulfillment_store_id), false)
          or (v_d.status = 'despachado' and coalesce(user_can_access_store(v_d.sale_store_id), false))) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_d.delivery_type = 'retiro' and (v_to is null or char_length(v_to) < 2) then
    raise exception 'delivered_to_required';
  end if;

  if v_d.pickup_code_hash is not null then
    if v_d.failed_attempts < 5 and nullif(btrim(coalesce(p_code, '')), '') is not null then
      v_ok_code := stock_reservation_code_hash(coalesce(v_d.sale_order_id, v_d.id), p_code) = v_d.pickup_code_hash;
    end if;
    if not v_ok_code then
      if v_override is not null then
        if coalesce(v_role, '') not in ('owner', 'manager') then
          raise exception 'override_requires_manager' using errcode = '42501';
        end if;
      else
        update dispatches set failed_attempts = failed_attempts + 1 where id = p_id;
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
        values (v_d.tenant_id, auth.uid(), 'dispatches', p_id, 'dispatch_pickup_failed',
                jsonb_build_object('failed_attempts', v_d.failed_attempts + 1), v_d.fulfillment_store_id);
        return jsonb_build_object(
          'ok', false,
          'error', case when v_d.failed_attempts + 1 >= 5 then 'pickup_code_locked' else 'pickup_code_invalid' end,
          'attempts_left', greatest(5 - (v_d.failed_attempts + 1), 0));
      end if;
    end if;
  end if;

  update dispatches
     set status = 'entregado', delivered_by = auth.uid(), delivered_at = now(),
         delivered_to = left(coalesce(v_to, customer_name, pickup_name), 120),
         override_reason = case when v_d.pickup_code_hash is not null and not v_ok_code then left(v_override, 300) end
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_d.tenant_id, auth.uid(), 'dispatches', p_id, 'dispatch_delivered',
          jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', 'entregado', 'delivered_to', coalesce(v_to, v_d.customer_name, v_d.pickup_name),
                             'verified_by', case when v_d.pickup_code_hash is null then 'none'
                                                 when v_ok_code then 'code' else 'override' end),
          case when v_d.pickup_code_hash is not null and not v_ok_code then v_override end,
          v_d.fulfillment_store_id);
  return jsonb_build_object('ok', true);
end;
$function$;

-- El estado del envío vuelve a la entrega.
create or replace function trg_shipments_dispatch_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d record;
begin
  for d in
    select x.id, x.tenant_id, x.status, x.customer_name, x.fulfillment_store_id
      from dispatches x
     where x.deleted_at is null and (x.id = new.dispatch_id or x.shipment_id = new.id)
     for update
  loop
    if new.status = 'delivered' and d.status = 'despachado' then
      update dispatches
         set status = 'entregado', shipment_status = new.status,
             delivered_at = coalesce(new.delivered_at, now()),
             delivered_to = left(coalesce(nullif(new.recipient ->> 'name', ''), d.customer_name), 120)
       where id = d.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
      values (d.tenant_id, auth.uid(), 'dispatches', d.id, 'dispatch_delivered',
              jsonb_build_object('status', d.status),
              jsonb_build_object('status', 'entregado', 'verified_by', 'logistica', 'shipment_id', new.id),
              d.fulfillment_store_id);
    elsif new.status = 'cancelled' then
      -- Envío cancelado: la entrega vuelve a Listo para despacharla de nuevo.
      update dispatches
         set shipment_id = null, shipment_status = new.status,
             status = case when d.status = 'despachado' then 'listo' else status end,
             shipped_at = case when d.status = 'despachado' then null else shipped_at end,
             shipped_by = case when d.status = 'despachado' then null else shipped_by end
       where id = d.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
      values (d.tenant_id, auth.uid(), 'dispatches', d.id, 'dispatch_shipment_cancelled',
              jsonb_build_object('status', d.status, 'shipment_id', new.id),
              jsonb_build_object('status', case when d.status = 'despachado' then 'listo' else d.status end),
              d.fulfillment_store_id);
    else
      update dispatches set shipment_status = new.status
       where id = d.id and shipment_status is distinct from new.status;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function trg_shipments_dispatch_sync() from public, anon, authenticated;

drop trigger if exists shipments_dispatch_sync on shipments;
create trigger shipments_dispatch_sync
  after update of status on shipments
  for each row
  when (old.status is distinct from new.status)
  execute function trg_shipments_dispatch_sync();

-- -----------------------------------------------------------------------------
-- I) A11: el envío nace desde la entrega
-- -----------------------------------------------------------------------------
create or replace function public.shipment_create(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant    uuid := current_tenant_id();
  v_user      uuid := auth.uid();
  v_key       text := btrim(coalesce(p ->> 'idempotency_key', ''));
  v_existing  shipments;
  v_row       shipments;
  v_err       text;
  v_store     uuid;
  v_provider  text := nullif(btrim(coalesce(p ->> 'provider_key', '')), '');
  v_conn      uuid;
  v_source    text := coalesce(nullif(p ->> 'source', ''), 'manual');
  v_sale      uuid;
  v_sale_row  record;
  v_order     text := left(nullif(btrim(coalesce(p ->> 'order_ref', '')), ''), 80);
  v_type      text := coalesce(nullif(p ->> 'service_type', ''), 'door');
  v_rec       jsonb := coalesce(p -> 'recipient', '{}'::jsonb);
  v_dest      jsonb := coalesce(p -> 'destination', '{}'::jsonb);
  v_point     jsonb := p -> 'pickup_point';
  v_pkgs      jsonb;
  v_declared  numeric;
  v_quote     jsonb := p -> 'quote';
  v_cost      numeric;
  v_submit    boolean;
  v_origin    jsonb;
  v_cp        text;
  v_id        uuid;
  v_disp      dispatches;
begin
  perform _shipping_assert_operator(v_tenant);
  v_err := _shipping_feature_check(v_tenant, null);
  if v_err is not null then raise exception '%', v_err using errcode = '42501'; end if;

  if char_length(v_key) < 8 or char_length(v_key) > 120 then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  -- Reintento del cliente con la misma clave: devuelve el envío ya creado.
  select * into v_existing from shipments where tenant_id = v_tenant and idempotency_key = v_key;
  if found then
    return to_jsonb(v_existing) || jsonb_build_object('replayed', true);
  end if;

  -- ADR-149 (A11): desde una entrega de Expedición. Queda enganchado a ella.
  if nullif(p ->> 'dispatch_id', '') is not null then
    select * into v_disp from dispatches
     where id = (p ->> 'dispatch_id')::uuid and tenant_id = v_tenant and deleted_at is null
     for update;
    if v_disp.id is null then raise exception 'dispatch_not_found' using errcode = '22023'; end if;
    if v_disp.status in ('entregado', 'despachado', 'cancelado') then
      raise exception 'dispatch_closed' using errcode = '22023';
    end if;
    if v_disp.delivery_type <> 'envio' then raise exception 'dispatch_not_envio' using errcode = '22023'; end if;
    if exists (select 1 from shipments sh where sh.dispatch_id = v_disp.id and sh.deleted_at is null and sh.status <> 'cancelled') then
      raise exception 'dispatch_has_shipment' using errcode = '22023';
    end if;
    if nullif(p ->> 'sale_id', '') is not null and (p ->> 'sale_id')::uuid <> v_disp.sale_id then
      raise exception 'sale_not_found' using errcode = '22023';
    end if;
    v_source := 'pos_sale';
    v_sale := v_disp.sale_id;
  end if;

  if v_source not in ('pos_sale', 'order', 'manual') then
    raise exception 'invalid_source' using errcode = '22023';
  end if;

  v_store := coalesce(nullif(p ->> 'store_id', '')::uuid, v_disp.store_id);
  if v_source = 'pos_sale' then
    v_sale := coalesce(v_sale, nullif(p ->> 'sale_id', '')::uuid);
    if v_sale is null then raise exception 'sale_required' using errcode = '22023'; end if;
    select sa.id, sa.store_id, sa.status into v_sale_row
      from sales sa where sa.id = v_sale and sa.tenant_id = v_tenant;
    if v_sale_row.id is null then raise exception 'sale_not_found' using errcode = '22023'; end if;
    if v_sale_row.status <> 'completed' then raise exception 'sale_not_completed' using errcode = '22023'; end if;
    v_store := coalesce(v_store, v_sale_row.store_id);
  elsif v_source = 'order' and v_order is null then
    raise exception 'order_ref_required' using errcode = '22023';
  end if;

  if v_store is null or not exists (
    select 1 from stores s where s.id = v_store and s.tenant_id = v_tenant and s.deleted_at is null
  ) then
    raise exception 'store_not_found' using errcode = '22023';
  end if;
  if not user_can_access_store(v_store) then raise exception 'forbidden' using errcode = '42501'; end if;

  if v_provider is not null then
    v_err := _shipping_feature_check(v_tenant, v_provider);
    if v_err is not null then raise exception '%', v_err using errcode = '42501'; end if;
    v_conn := shipping_effective_connection(v_tenant, v_store, v_provider);
    if v_conn is null and v_provider <> 'simulador' then
      raise exception 'carrier_not_connected' using errcode = '22023';
    end if;
  end if;

  if v_type not in ('door', 'branch') then raise exception 'invalid_service_type' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(v_rec ->> 'name', ''))) < 2 then
    raise exception 'recipient_name_required' using errcode = '22023';
  end if;
  v_cp := upper(btrim(coalesce(v_dest ->> 'postal_code', '')));
  if v_cp !~ '^([0-9]{4}|[A-Z][0-9]{4}[A-Z]{3})$' then
    raise exception 'invalid_postal_code' using errcode = '22023';
  end if;
  if v_type = 'door' and (
       char_length(btrim(coalesce(v_dest ->> 'street', ''))) < 2
    or char_length(btrim(coalesce(v_dest ->> 'number', ''))) < 1
    or char_length(btrim(coalesce(v_dest ->> 'city', ''))) < 2
    or char_length(btrim(coalesce(v_dest ->> 'province', ''))) < 2) then
    raise exception 'destination_address_required' using errcode = '22023';
  end if;
  if v_type = 'branch' and (v_point is null or char_length(btrim(coalesce(v_point ->> 'id', ''))) = 0) then
    raise exception 'pickup_point_required' using errcode = '22023';
  end if;

  v_pkgs := _shipping_clean_packages(p -> 'packages');
  v_declared := coalesce(nullif(p ->> 'declared_value', '')::numeric, 0);
  if v_declared < 0 or v_declared > 1000000000 then raise exception 'invalid_declared_value' using errcode = '22023'; end if;

  if v_quote is not null and jsonb_typeof(v_quote) = 'object'
     and (v_quote ->> 'provider_key') is not distinct from v_provider then
    v_cost := nullif(v_quote ->> 'cost', '')::numeric;
    if v_cost is not null and v_cost < 0 then v_cost := null; end if;
  else
    v_quote := null;
  end if;

  v_submit := coalesce((p ->> 'submit')::boolean, true) and v_provider is not null;

  select jsonb_build_object('name', s.name, 'street', s.address, 'city', s.city, 'province', s.province,
                            'postal_code', s.postal_code, 'phone', s.phone, 'email', s.email)
    into v_origin
    from stores s where s.id = v_store;

  insert into shipments (
    tenant_id, store_id, connection_id, provider_key, source, sale_id, order_ref, external_ref,
    idempotency_key, service_type, service_code, pickup_point, recipient, destination, origin,
    packages, package_count, total_weight_kg, declared_value, quote, quoted_cost, status, notes, created_by,
    dispatch_id
  ) values (
    v_tenant, v_store, v_conn, v_provider, v_source, v_sale, v_order,
    left(nullif(btrim(coalesce(p ->> 'external_ref', '')), ''), 120),
    v_key, v_type, left(nullif(btrim(coalesce(p ->> 'service_code', v_quote ->> 'service_code', '')), ''), 40),
    case when v_type = 'branch' then v_point end,
    jsonb_strip_nulls(jsonb_build_object(
      'name', left(btrim(v_rec ->> 'name'), 120),
      'document', left(nullif(btrim(coalesce(v_rec ->> 'document', '')), ''), 20),
      'email', left(nullif(btrim(coalesce(v_rec ->> 'email', '')), ''), 160),
      'phone', left(nullif(btrim(coalesce(v_rec ->> 'phone', '')), ''), 40))),
    jsonb_strip_nulls(jsonb_build_object(
      'street', left(nullif(btrim(coalesce(v_dest ->> 'street', '')), ''), 120),
      'number', left(nullif(btrim(coalesce(v_dest ->> 'number', '')), ''), 20),
      'floor', left(nullif(btrim(coalesce(v_dest ->> 'floor', '')), ''), 20),
      'apartment', left(nullif(btrim(coalesce(v_dest ->> 'apartment', '')), ''), 20),
      'city', left(nullif(btrim(coalesce(v_dest ->> 'city', '')), ''), 80),
      'province', left(nullif(btrim(coalesce(v_dest ->> 'province', '')), ''), 80),
      'postal_code', v_cp,
      'reference', left(nullif(btrim(coalesce(v_dest ->> 'reference', '')), ''), 200))),
    coalesce(jsonb_strip_nulls(v_origin), '{}'::jsonb),
    v_pkgs, jsonb_array_length(v_pkgs),
    (select coalesce(sum((x ->> 'weight_kg')::numeric), 0) from jsonb_array_elements(v_pkgs) x),
    v_declared, v_quote, v_cost,
    case when v_submit then 'pending' when v_quote is not null then 'quoted' else 'draft' end,
    left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 500),
    v_user,
    v_disp.id
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Carrera con otro pedido de la misma clave: gana el primero.
    select * into v_existing from shipments where tenant_id = v_tenant and idempotency_key = v_key;
    return to_jsonb(v_existing) || jsonb_build_object('replayed', true);
  end if;

  if v_disp.id is not null then
    update dispatches set shipment_id = v_id, shipment_status = (select status from shipments where id = v_id)
     where id = v_disp.id;
  end if;

  insert into shipment_events (tenant_id, shipment_id, status, description, source, dedupe_key, created_by)
  values (v_tenant, v_id, case when v_submit then 'pending' else 'draft' end,
          case when v_submit then 'Envío creado; se está generando en la logística'
               else 'Borrador guardado' end,
          'system', 'created', v_user);

  if v_submit then
    perform _shipping_enqueue(v_tenant, v_id, 'create', 0);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, v_user, 'shipment', v_id, 'shipment_created',
          jsonb_build_object('provider_key', v_provider, 'source', v_source, 'sale_id', v_sale,
                             'order_ref', v_order, 'service_type', v_type, 'packages', jsonb_array_length(v_pkgs),
                             'declared_value', v_declared, 'quoted_cost', v_cost, 'submitted', v_submit,
                             'dispatch_id', v_disp.id),
          v_store);

  select * into v_row from shipments where id = v_id;
  return to_jsonb(v_row) || jsonb_build_object('replayed', false);
end;
$function$;

-- -----------------------------------------------------------------------------
-- J) A13 y A9: renglones del remito sin repetir lo ya remitido, y vista previa
-- -----------------------------------------------------------------------------
create or replace function _remito_lines(p_sale uuid, p_dispatch uuid, p_pick jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with sold as (
    select si.product_id, si.variant_id, min(si.product_name) as name, min(si.sku) as sku,
           coalesce(min(si.unit_label), min(pr.unit), 'un') as unit,
           sum(si.quantity - coalesce(si.returned_qty, 0)) as qty,
           case when sum(si.quantity) > 0 then round(sum(si.subtotal) / sum(si.quantity), 2) end as unit_price
      from sale_items si
      left join products pr on pr.id = si.product_id
     where si.sale_id = p_sale and not coalesce(pr.is_service, false)
     group by si.product_id, si.variant_id
  ),
  src as (
    select di.product_id, di.variant_id,
           di.product_name || coalesce(' (' || di.variant_label || ')', '') as description,
           di.sku, di.unit, di.qty
      from dispatch_items di
     where p_dispatch is not null and di.dispatch_id = p_dispatch
    union all
    select s.product_id, s.variant_id, s.name, s.sku, s.unit, s.qty
      from sold s
     where s.qty > 0
       and (p_dispatch is null or not exists (select 1 from dispatch_items di where di.dispatch_id = p_dispatch))
  ),
  -- Lo que ya está en otro remito activo de la misma venta (A13).
  done as (
    select ri.product_id, ri.variant_id, sum(ri.qty) as qty
      from remito_items ri
      join remitos r on r.id = ri.remito_id
     where r.sale_id = p_sale and r.status = 'emitido' and r.deleted_at is null
     group by ri.product_id, ri.variant_id
  ),
  pick as (
    select x.product_id, x.variant_id, sum(x.qty) as qty
      from jsonb_to_recordset(coalesce(p_pick, '[]'::jsonb)) as x(product_id uuid, variant_id uuid, qty numeric)
     group by 1, 2
  ),
  fin as (
    select src.product_id, src.variant_id, src.description, src.sku, src.unit,
           greatest(least(
             case when jsonb_array_length(coalesce(p_pick, '[]'::jsonb)) = 0 then src.qty
                  else least(src.qty, coalesce(pk.qty, 0)) end,
             coalesce(sold.qty, src.qty) - coalesce(dn.qty, 0)), 0) as qty,
           least(src.qty, coalesce(dn.qty, 0)) as already,
           sold.unit_price
      from src
      left join pick pk on pk.product_id is not distinct from src.product_id and pk.variant_id is not distinct from src.variant_id
      left join sold on sold.product_id is not distinct from src.product_id and sold.variant_id is not distinct from src.variant_id
      left join done dn on dn.product_id is not distinct from src.product_id and dn.variant_id is not distinct from src.variant_id
  )
  select jsonb_build_object(
           'items', coalesce(jsonb_agg(to_jsonb(fin) - 'already' order by fin.description) filter (where fin.qty > 0), '[]'::jsonb),
           'value', coalesce(sum(fin.qty * coalesce(fin.unit_price, 0)) filter (where fin.qty > 0), 0),
           'already', coalesce(sum(fin.already), 0))
    from fin;
$$;
revoke all on function _remito_lines(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.remito_issue(p_id uuid, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant   uuid;
  v_ex       remitos;
  v_disp     dispatches;
  v_sale     record;
  v_store    uuid;
  v_kind     text;
  v_cfg      jsonb;
  v_point    remito_points;
  v_number   int;
  v_issuer   jsonb;
  v_cust     record;
  v_lines    jsonb;
  v_items    jsonb;
  v_value    numeric;
  v_cot      text := _remito_text(p_data, 'cot_number', 40);
  v_jur      text;
  v_cuit     text := nullif(regexp_replace(coalesce(p_data ->> 'carrier_cuit', ''), '\D', '', 'g'), '');
  v_recv     text;
  v_show     boolean;
begin
  if p_id is null or jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'invalid_remito';
  end if;
  select * into v_ex from remitos where id = p_id;
  if v_ex.id is not null then
    if v_ex.tenant_id is distinct from current_tenant_id() then
      raise exception 'remito_not_found';
    end if;
    perform _remito_assert(v_ex.store_id);
    return jsonb_build_object('id', v_ex.id, 'pto_vta', v_ex.pto_vta, 'number', v_ex.number, 'already', true);
  end if;

  -- Origen: la entrega (sale de la sucursal que arma) o la venta.
  if nullif(p_data ->> 'dispatch_id', '') is not null then
    select * into v_disp from dispatches
     where id = (p_data ->> 'dispatch_id')::uuid and tenant_id = current_tenant_id() and deleted_at is null
     for update;
    if v_disp.id is null then
      raise exception 'dispatch_not_found';
    end if;
    if v_disp.status = 'cancelado' then
      raise exception 'dispatch_cancelled';
    end if;
    v_store := v_disp.store_id;
  elsif nullif(p_data ->> 'sale_id', '') is not null then
    v_store := null;
  else
    raise exception 'invalid_remito';
  end if;
  -- La venta bloqueada: dos remitos a la vez no reparten lo mismo (A13).
  select s.id, s.store_id, s.status, s.customer_id, s.number into v_sale
    from sales s
   where s.id = coalesce(v_disp.sale_id, (p_data ->> 'sale_id')::uuid) and s.tenant_id = current_tenant_id()
   for update;
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'sale_not_completed';
  end if;
  v_store := coalesce(v_store, v_sale.store_id);
  v_tenant := _remito_assert(v_store);
  v_cfg := remito_config(v_tenant);

  v_kind := coalesce(nullif(p_data ->> 'kind', ''), case when v_disp.delivery_type = 'envio' then 'envio' else 'entrega' end);
  if v_kind not in ('entrega', 'envio') then
    raise exception 'invalid_kind';
  end if;
  v_jur := coalesce(nullif(p_data ->> 'cot_jurisdiction', ''), v_cfg ->> 'cot_jurisdiction');
  if v_jur not in ('pba', 'caba', 'otra') then
    raise exception 'invalid_cot_jurisdiction';
  end if;
  if v_cot is not null and v_cot !~ '^[0-9A-Za-z-]{6,40}$' then
    raise exception 'invalid_cot';
  end if;
  if v_cuit is not null and v_cuit !~ '^[0-9]{11}$' then
    raise exception 'invalid_carrier_cuit';
  end if;
  v_show := coalesce(case when p_data ->> 'show_prices' in ('true', 'false') then (p_data ->> 'show_prices')::boolean end,
                     (v_cfg ->> 'show_prices')::boolean);

  if exists (
    select 1 from jsonb_to_recordset(coalesce(p_data -> 'items', '[]'::jsonb)) as x(product_id uuid, variant_id uuid, qty numeric)
     where coalesce(x.qty, 0) <= 0
  ) then
    raise exception 'invalid_qty';
  end if;
  -- Ítems: los de la entrega (venta partida), los de la venta (entrega de H32
  -- o venta suelta) o el subconjunto pedido, sin lo que ya está en otro
  -- remito activo de la venta. Precio unitario neto de la venta.
  v_lines := _remito_lines(v_sale.id, v_disp.id, p_data -> 'items');
  v_items := v_lines -> 'items';
  v_value := (v_lines ->> 'value')::numeric;
  if jsonb_array_length(v_items) = 0 then
    if (v_lines ->> 'already')::numeric > 0 then
      raise exception 'remito_already_covered';
    end if;
    raise exception 'remito_empty';
  end if;
  if nullif(p_data ->> 'declared_value', '') is not null then
    v_value := round((p_data ->> 'declared_value')::numeric, 2);
    if v_value < 0 then
      raise exception 'invalid_declared_value';
    end if;
  end if;

  -- Emisor (foto) y receptor (por defecto, el cliente de la venta).
  select jsonb_build_object(
           'legal_name', b.legal_name, 'trade_name', b.trade_name, 'cuit', b.cuit, 'iva_condition', b.iva_condition,
           'iibb', b.iibb, 'activity_start', b.activity_start, 'address', b.address, 'phone', b.phone,
           'logo_url', b.logo_url)
    into v_issuer
    from tenant_branding b where b.tenant_id = v_tenant;
  v_issuer := coalesce(v_issuer, '{}'::jsonb) || (
    select jsonb_build_object('store_name', st.name,
                              'store_address', concat_ws(', ', nullif(st.address, ''), nullif(st.city, ''), nullif(st.province, '')))
      from stores st where st.id = v_store);
  select c.name, nullif(btrim(concat_ws(' ', c.document_type, c.document_number)), '') as doc, c.iva_condition, c.address
    into v_cust
    from customers c where c.id = v_sale.customer_id;
  v_recv := coalesce(_remito_text(p_data, 'receiver_name', 120), v_disp.pickup_name, v_cust.name, v_disp.customer_name);
  if v_recv is null then
    raise exception 'receiver_required';
  end if;

  -- Número del punto de venta interno de la sucursal.
  perform pg_advisory_xact_lock(hashtext('remito_number:' || v_tenant::text));
  select * into v_point from remito_points where store_id = v_store and deleted_at is null;
  if v_point.id is null then
    insert into remito_points (tenant_id, store_id, pto_vta)
    values (v_tenant, v_store,
            coalesce((select max(p.pto_vta) from remito_points p where p.tenant_id = v_tenant and p.deleted_at is null), 0) + 1)
    returning * into v_point;
  end if;
  update remito_points set last_number = last_number + 1 where id = v_point.id returning last_number into v_number;

  insert into remitos (
    id, tenant_id, store_id, point_id, pto_vta, number, kind, dispatch_id, sale_id, issuer,
    receiver_name, receiver_doc, receiver_iva, receiver_address, delivery_address, packages, weight_kg,
    declared_value, show_prices, carrier_name, carrier_cuit, vehicle_plate, driver_name,
    cot_number, cot_jurisdiction, cot_valid_until, cot_source, notes, legend
  ) values (
    p_id, v_tenant, v_store, v_point.id, v_point.pto_vta, v_number, v_kind, v_disp.id, v_sale.id, v_issuer,
    v_recv,
    coalesce(_remito_text(p_data, 'receiver_doc', 40), v_cust.doc),
    coalesce(_remito_text(p_data, 'receiver_iva', 40), v_cust.iva_condition),
    coalesce(_remito_text(p_data, 'receiver_address', 300), v_cust.address),
    coalesce(_remito_text(p_data, 'delivery_address', 300), v_disp.ship_address),
    greatest(1, least(coalesce(nullif(p_data ->> 'packages', '')::int, 1), 9999)),
    nullif(p_data ->> 'weight_kg', '')::numeric,
    v_value, v_show,
    _remito_text(p_data, 'carrier_name', 120), v_cuit,
    upper(_remito_text(p_data, 'vehicle_plate', 20)), _remito_text(p_data, 'driver_name', 120),
    v_cot, v_jur, nullif(p_data ->> 'cot_valid_until', '')::date, case when v_cot is not null then 'manual' end,
    _remito_text(p_data, 'notes', 500), v_cfg ->> 'legend'
  );

  insert into remito_items (tenant_id, remito_id, store_id, product_id, variant_id, description, sku, unit, qty, unit_price, sort)
  select v_tenant, p_id, v_store, x.product_id, x.variant_id, left(x.description, 300), x.sku, coalesce(x.unit, 'un'),
         x.qty, x.unit_price, (row_number() over (order by x.description, x.sku))::int
    from jsonb_to_recordset(v_items) as x(product_id uuid, variant_id uuid, description text, sku text,
                                         unit text, qty numeric, unit_price numeric);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'remitos', p_id, 'remito_issued',
          jsonb_build_object('pto_vta', v_point.pto_vta, 'number', v_number, 'kind', v_kind, 'dispatch_id', v_disp.id,
                             'sale_id', v_sale.id, 'declared_value', v_value, 'cot_number', v_cot,
                             'cot_jurisdiction', v_jur, 'items', jsonb_array_length(v_items)),
          v_store);

  return jsonb_build_object('id', p_id, 'pto_vta', v_point.pto_vta, 'number', v_number,
                            'cot_required', remito_cot_required((v_cfg ->> 'cot_threshold')::numeric, v_jur, v_value)
                                            and v_cot is null);
end;
$function$;

-- Vista previa: renglones, valor y si pide COT, antes de emitir (A9). No escribe.
create or replace function public.remito_preview(p_data jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_disp  dispatches;
  v_sale  record;
  v_store uuid;
  v_cfg   jsonb;
  v_lines jsonb;
  v_jur   text;
  v_value numeric;
begin
  if jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'invalid_remito';
  end if;
  if nullif(p_data ->> 'dispatch_id', '') is not null then
    select * into v_disp from dispatches
     where id = (p_data ->> 'dispatch_id')::uuid and tenant_id = current_tenant_id() and deleted_at is null;
    if v_disp.id is null then
      raise exception 'dispatch_not_found';
    end if;
    v_store := v_disp.store_id;
  elsif nullif(p_data ->> 'sale_id', '') is null then
    raise exception 'invalid_remito';
  end if;
  select s.id, s.store_id, s.status into v_sale
    from sales s
   where s.id = coalesce(v_disp.sale_id, (p_data ->> 'sale_id')::uuid) and s.tenant_id = current_tenant_id();
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  v_store := coalesce(v_store, v_sale.store_id);
  v_cfg := remito_config(_remito_assert(v_store));
  v_jur := coalesce(nullif(p_data ->> 'cot_jurisdiction', ''), v_cfg ->> 'cot_jurisdiction');
  v_lines := _remito_lines(v_sale.id, v_disp.id, p_data -> 'items');
  v_value := coalesce(nullif(p_data ->> 'declared_value', '')::numeric, (v_lines ->> 'value')::numeric);
  return jsonb_build_object(
    'items', v_lines -> 'items',
    'declared_value', v_value,
    'already', (v_lines ->> 'already')::numeric,
    'sale_status', v_sale.status,
    'cot_jurisdiction', v_jur,
    'cot_threshold', (v_cfg ->> 'cot_threshold')::numeric,
    'cot_required', coalesce(remito_cot_required((v_cfg ->> 'cot_threshold')::numeric, v_jur, v_value), false));
end;
$$;
revoke all on function public.remito_preview(jsonb) from public, anon;
grant execute on function public.remito_preview(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- K) A7: cobrar un pedido de delivery que todavía no salió no lo entrega
-- -----------------------------------------------------------------------------
create or replace function trg_delivery_orders_paid_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- create_sale enlaza la venta y marca 'entregado'. Sólo vale si el pedido ya
  -- estaba en la calle (delivery en camino) o listo para retirar (take away y
  -- mostrador). Si no, queda en su estado y se entrega desde el tablero. Los
  -- pedidos de apps (canales) siguen su propio circuito.
  if old.sale_id is null and new.sale_id is not null
     and new.status = 'entregado' and old.status not in ('entregado', 'cancelado')
     and not ((old.order_type = 'delivery' and old.status = 'en_camino')
              or (old.order_type <> 'delivery' and old.status = 'listo'))
     and not exists (select 1 from delivery_channel_orders c where c.delivery_order_id = new.id) then
    new.status := old.status;
  end if;
  return new;
end;
$$;
revoke all on function trg_delivery_orders_paid_status() from public, anon, authenticated;

drop trigger if exists delivery_orders_paid_status on delivery_orders;
create trigger delivery_orders_paid_status
  before update of sale_id, status on delivery_orders
  for each row execute function trg_delivery_orders_paid_status();

-- -----------------------------------------------------------------------------
-- L) Permisos de las RPC (mismos que antes)
-- -----------------------------------------------------------------------------
revoke all on function public._dispatch_lock(uuid) from public, anon, authenticated;
revoke all on function public.dispatch_cancel(uuid, text) from public, anon;
grant execute on function public.dispatch_cancel(uuid, text) to authenticated;
revoke all on function public.dispatch_create_for_sale(uuid, jsonb) from public, anon;
grant execute on function public.dispatch_create_for_sale(uuid, jsonb) to authenticated;
revoke all on function public.dispatch_ship(uuid, text, uuid) from public, anon;
grant execute on function public.dispatch_ship(uuid, text, uuid) to authenticated;
revoke all on function public.dispatch_deliver(uuid, text, text, text) from public, anon;
grant execute on function public.dispatch_deliver(uuid, text, text, text) to authenticated;
revoke all on function public.shipment_create(jsonb) from public, anon;
grant execute on function public.shipment_create(jsonb) to authenticated;
revoke all on function public.remito_issue(uuid, jsonb) from public, anon;
grant execute on function public.remito_issue(uuid, jsonb) to authenticated;
