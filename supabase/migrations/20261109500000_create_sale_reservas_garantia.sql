-- =============================================================================
-- 20261109500000_create_sale_reservas_garantia.sql  (ADR-096 · F16 H77 · F14 H64)
--
-- Paga dos deudas que dejaron ADR-091 y ADR-092 porque exigían tocar
-- create_sale. create_sale se recrea copiando COMPLETA su definición más nueva
-- (20261108600000_perf_f4_create_sale_tenant, ADR-093, verificado con grep
-- sobre todas las migraciones), con la misma firma. Todo lo agregado va entre
-- las marcas "-- ADR-096 >>>" y "-- <<< ADR-096" (o en líneas que dicen
-- ADR-096): fuera de esas marcas el texto es idéntico al de ADR-093
-- (tests/unit/createSaleDeudas.test.ts lo compara). return_sale_v2 no cambia.
--
-- A) Reservas de stock (ADR-091). Con la feature `reservas_stock`:
--    • La venta de mostrador no consume lo reservado por otra reserva. Por
--      cada línea con stock (y cada componente de un kit), si el negocio no
--      permite vender sin stock: disponible = stock de la sucursal del turno
--      (product_stock; el salón si la sucursal tiene depósitos, ADR-088)
--      menos lo reservado vigente de la sucursal. Si no alcanza:
--      `insufficient_stock_reserved` (offline, ADR-077: se vende igual y queda
--      el conflicto `negative_stock_reserved`). Sin reservas vigentes de ese
--      ítem no se mira nada nuevo.
--    • La venta puede ENTREGAR una reserva: extra {kind: 'reservation', id}.
--      La reserva tiene que ser de la sucursal del turno, estar vigente y con
--      la identidad del cliente validada en las últimas 2 horas
--      (stock_reservation_pickup_verify: código, documento o encargado con
--      motivo, con los mismos 5 intentos que la entrega). Su propia cantidad
--      no cuenta como reservada (sin doble descuento: el stock baja una sola
--      vez, con la venta), la venta tiene que cubrir sus renglones y la
--      reserva queda entregada con esa venta en la MISMA transacción.
--    • Mismo lock por sucursal que stock_reservation_create: una reserva y
--      una venta simultáneas no comprometen el mismo disponible.
--    Sin la feature: comportamiento idéntico (un extra 'reservation' se
--    rechaza con feature_not_in_plan).
--
-- B) Garantía extendida enlazada (ADR-092). La línea de garantía (sin
--    producto) puede traer `warranty_plan_id` y `warranty_for` (índice en
--    p_items de la línea que cubre). create_sale guarda en sale_items
--    `warranty_plan_id`, `warranty_for_item_id` y `warranty_months` (meses
--    del plan al vender). serial_lookup usa ese vínculo y, para ventas sin
--    vínculo (las viejas), sigue con el nombre de la línea.
--
-- Seguridad: sin policies nuevas (las columnas nuevas heredan las de
-- sale_items y stock_reservations); índice en cada FK nueva; tenant_id
-- explícito en todo insert (P8 de scripts/db-audit-perf.mjs); audit_logs sólo
-- recibe inserts.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A.1) Identidad validada para entregar desde el POS.
-- -----------------------------------------------------------------------------
alter table stock_reservations
  add column if not exists pickup_verified_at  timestamptz,
  add column if not exists pickup_verified_by  uuid references public.users(id),
  add column if not exists pickup_verified_via text
    check (pickup_verified_via is null or pickup_verified_via in ('code', 'doc', 'override'));

create index if not exists stock_reservations_pickup_verified_by_idx
  on stock_reservations(pickup_verified_by) where pickup_verified_by is not null;

-- Valida la identidad del cliente (código o documento; sin ellos, dueño o
-- encargado con motivo) y deja la reserva lista para cobrarse en el POS.
-- Mismas reglas que stock_reservation_deliver: un código mal tipeado NO lanza
-- excepción para que el intento fallido quede contado. Devuelve la reserva
-- con sus renglones para cargarlos en el carrito.
create or replace function stock_reservation_pickup_verify(
  p_id              uuid,
  p_code            text default null,
  p_customer_doc    text default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_res      stock_reservations;
  v_tenant   uuid;
  v_role     text := stock_my_role();
  v_doc      text := nullif(regexp_replace(coalesce(p_customer_doc, ''), '\D', '', 'g'), '');
  v_override text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_ok_code  boolean := false;
  v_ok_doc   boolean := false;
  v_via      text;
begin
  select * into v_res from stock_reservations where id = p_id and tenant_id = current_tenant_id() for update;
  if v_res.id is null then
    raise exception 'reservation_not_found';
  end if;
  v_tenant := stock_reservation_assert(v_res.store_id, null);
  if not coalesce(user_can_access_store(v_res.store_id), false) then
    -- Retira el cliente en la sucursal de la reserva: cobra quien está ahí.
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_res.status in ('reservada', 'preparada') and v_res.expires_at <= now() then
    perform stock_reservations_expire_due(v_tenant);
    raise exception 'reservation_expired';
  end if;
  if v_res.status not in ('reservada', 'preparada') then
    raise exception 'invalid_status: %', v_res.status;
  end if;

  if v_res.failed_attempts < 5 and nullif(btrim(coalesce(p_code, '')), '') is not null then
    v_ok_code := stock_reservation_code_hash(v_res.id, p_code) = v_res.pickup_code_hash;
  end if;
  if v_doc is not null and v_res.customer_doc is not null then
    v_ok_doc := v_doc = v_res.customer_doc;
  end if;
  if not (v_ok_code or v_ok_doc) then
    if v_override is not null then
      if v_role not in ('owner', 'manager') then
        raise exception 'override_requires_manager' using errcode = '42501';
      end if;
    else
      update stock_reservations set failed_attempts = failed_attempts + 1 where id = p_id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, auth.uid(), 'stock_reservations', p_id, 'stock_reservation_pickup_failed',
              jsonb_build_object('failed_attempts', v_res.failed_attempts + 1));
      return jsonb_build_object(
        'ok', false,
        'error', case when v_res.failed_attempts + 1 >= 5 then 'pickup_code_locked' else 'pickup_code_invalid' end,
        'attempts_left', greatest(5 - (v_res.failed_attempts + 1), 0));
    end if;
  end if;
  v_via := case when v_ok_code then 'code' when v_ok_doc then 'doc' else 'override' end;

  update stock_reservations
     set pickup_verified_at = now(), pickup_verified_by = auth.uid(), pickup_verified_via = v_via,
         override_reason = case when v_via = 'override' then left(v_override, 300) else null end
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason, store_id)
  values (v_tenant, auth.uid(), 'stock_reservations', p_id, 'stock_reservation_pickup_verified',
          jsonb_build_object('verified_by', v_via, 'number', v_res.number),
          case when v_via = 'override' then v_override else null end, v_res.store_id);

  return jsonb_build_object(
    'ok', true,
    'id', v_res.id,
    'number', v_res.number,
    'store_id', v_res.store_id,
    'customer_id', v_res.customer_id,
    'customer_name', v_res.customer_name,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', i.product_id, 'variant_id', i.variant_id, 'product_name', i.product_name,
               'variant_label', i.variant_label, 'sku', i.sku, 'unit', i.unit, 'qty', i.qty,
               'unit_price', i.unit_price)
             order by i.sort)
        from stock_reservation_items i
       where i.reservation_id = p_id), '[]'::jsonb));
end;
$$;
revoke all on function stock_reservation_pickup_verify(uuid, text, text, text) from public, anon;
grant execute on function stock_reservation_pickup_verify(uuid, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- A.2) Lo que falta para vender una cantidad sin tocar lo reservado de otras
--      reservas. 0 si no hay reservas vigentes del ítem en la sucursal (nada
--      nuevo que mirar) o si alcanza. p_salon: la sucursal tiene depósitos y
--      la venta mira el salón (ADR-088). p_exclude: la reserva que se entrega.
-- -----------------------------------------------------------------------------
create or replace function _sale_reserved_short(
  p_store   uuid,
  p_product uuid,
  p_variant uuid,
  p_qty     numeric,
  p_salon   boolean,
  p_exclude uuid
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_reserved numeric;
  v_base     numeric;
begin
  if coalesce(p_qty, 0) <= 0 then return 0; end if;
  v_reserved := stock_reserved_qty(p_store, p_product, p_variant, p_exclude);
  if v_reserved <= 0 then return 0; end if;
  if p_salon then
    v_base := warehouse_principal_qty(p_store, p_product, p_variant);
  else
    v_base := coalesce((select ps.qty from product_stock ps
                         where ps.store_id = p_store and ps.product_id = p_product
                           and ps.variant_id is not distinct from p_variant), 0);
  end if;
  return greatest(p_qty - (v_base - v_reserved), 0);
end;
$$;
revoke all on function _sale_reserved_short(uuid, uuid, uuid, numeric, boolean, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B.1) Vínculo explícito de la garantía extendida.
-- -----------------------------------------------------------------------------
alter table sale_items
  add column if not exists warranty_plan_id     uuid references warranty_plans(id) on delete set null,
  add column if not exists warranty_for_item_id uuid references sale_items(id) on delete set null,
  add column if not exists warranty_months      int check (warranty_months is null or warranty_months >= 0);

comment on column sale_items.warranty_for_item_id is
  'ADR-096: línea de garantía extendida → línea (producto o serie) que cubre. Lo manda el POS; null en ventas viejas (serial_lookup cae al nombre de la línea).';

create index if not exists sale_items_warranty_plan_idx
  on sale_items(warranty_plan_id) where warranty_plan_id is not null;
create index if not exists sale_items_warranty_for_idx
  on sale_items(warranty_for_item_id) where warranty_for_item_id is not null;

-- -----------------------------------------------------------------------------
-- C) create_sale (copia completa de ADR-093 + bloques ADR-096)
-- -----------------------------------------------------------------------------
create or replace function public.create_sale(p_items jsonb, p_payments jsonb, p_discount_total numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_extras jsonb DEFAULT '[]'::jsonb, p_table_order_id uuid DEFAULT NULL::uuid, p_delivery_order_id uuid DEFAULT NULL::uuid, p_promo_discount numeric DEFAULT 0, p_promo_id uuid DEFAULT NULL::uuid, p_promo_name text DEFAULT NULL::text, p_coupon_id uuid DEFAULT NULL::uuid, p_cash_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_subtotal numeric := 0;
  v_total    numeric;
  v_total_pre numeric;
  v_paid     numeric := 0;
  v_sale_id  uuid;
  v_item     record;
  v_pay      record;
  v_comp     record;
  v_pname    text;
  v_psku     text;
  v_is_kit   boolean;
  v_track    boolean;
  v_has_variants boolean;
  v_variant  record;
  v_serial   text;
  v_role     text;
  v_max_disc numeric := 100;
  v_round    numeric := 0;
  v_allow_neg boolean := true;
  -- F17 · H92/H94 (ADR-049): settings efectivos y stock por sucursal.
  v_reg        uuid;
  v_eff        jsonb;
  v_branch_stk boolean := false;
  v_disc_pct numeric;
  v_pallow   boolean;
  v_stock    numeric;
  v_sc_total numeric := 0;
  v_sc_bal   numeric;
  v_pay_feat text;
  v_line_disc numeric := 0;
  v_warranty_prima numeric := 0;
  v_tip_amount numeric := 0;
  v_tip_method text;
  v_professional uuid;
  v_pack     record;
  v_pcredit  record;
  v_pk       service_packs%rowtype;
  v_has_pack_session boolean := false;
  v_table_order table_orders%rowtype;
  v_delivery_order delivery_orders%rowtype;
  v_delivery_fee numeric := 0;
  v_intent   record;
  v_qr_ref   uuid;
  v_qr_sum   numeric;
  v_qr_plain boolean := false;
  v_promo_disc numeric := 0;
  v_coupon_disc numeric := 0;
  v_coupon   coupons%rowtype;
  -- F18 · H100 (ADR-056): precio autoritativo.
  v_pc          boolean := coalesce(current_setting('ninja.pc_complete', true), '') <> '';
  v_i           int;
  v_j           jsonb;
  v_pid         uuid;
  v_vid         uuid;
  v_qty         numeric;
  v_up          numeric;
  v_ldisc       numeric;
  v_exp         numeric;
  v_ok          boolean;
  v_amt         numeric;
  v_k           int;
  v_reason      text;
  v_dev         numeric;
  v_max_dev     numeric := 0;
  v_pool_extra  numeric[] := '{}';
  v_pool_pack   numeric[] := '{}';
  v_pool_order  numeric[] := '{}';
  v_pack_creds  text[] := '{}';
  v_prices      jsonb := '[]'::jsonb;
  v_mismatch    jsonb := '[]'::jsonb;
  v_overrides   jsonb := '[]'::jsonb;
  v_free_total  numeric := 0;
  v_free_any    boolean := false;
  v_free_cap    numeric;
  v_price_sup   uuid;
  v_n           int := 0;
  -- F18 · H103-H105 (ADR-068): desglose fiscal y percepciones.
  v_tax_in      jsonb := '[]'::jsonb;
  v_tax         jsonb;
  v_tl          jsonb;
  v_perc        numeric := 0;
  v_total_np    numeric;
  -- ADR-077: venta offline que se sincroniza (GUC sólo de _offline_run_sale).
  v_offline     boolean := coalesce(current_setting('ninja.offline_sync', true), '') <> '';
  v_off_conf    jsonb := '[]'::jsonb;
  -- F9 (ADR-074): motor de promociones autoritativo.
  -- ADR-077: offline, las promos se evalúan a la hora real de la venta
  -- (ninja.offline_sold_at, sólo de _offline_run_sale), no a la de la sincronización.
  v_now_ar      timestamp := (case when v_offline
                                   then coalesce(nullif(current_setting('ninja.offline_sold_at', true), '')::timestamptz, now())
                                   else now() end) at time zone 'America/Argentina/Buenos_Aires';
  v_promo_lines jsonb := '[]'::jsonb;
  v_promo_ctx   jsonb;
  v_promo_eval  jsonb := jsonb_build_object('discount', 0, 'applied', '[]'::jsonb, 'gifts', '[]'::jsonb);
  v_promo_calc  numeric := 0;
  v_promo_label text;
  v_promo_first uuid;
  v_promo_left  numeric;
  v_ap          jsonb;
  v_gift        jsonb;
  -- ADR-088: depósitos (ADR-085), seña del turno (ADR-082) y promo por línea (ADR-074).
  v_wh_on       boolean := false;
  v_from_res    boolean := false;
  v_wr          jsonb;
  v_res_taken   jsonb := '[]'::jsonb;
  v_appt_id     uuid;
  v_appt        appointments%rowtype;
  v_sena_paid   numeric := 0;
  v_sena_avail  numeric := 0;
  v_sena_exp    numeric := 0;
  v_sena_left   numeric;
  v_dep         record;
  v_promo_line  numeric[] := '{}';
  v_pl          numeric;
  -- ADR-096 >>>
  -- Reservas de stock (ADR-091) y garantía extendida enlazada (ADR-092).
  v_resv_on     boolean := false;
  v_resv_id     uuid;
  v_resv_n      int := 0;
  v_resv        stock_reservations%rowtype;
  v_resv_short  numeric;
  v_line_id     uuid;
  v_line_ids    uuid[] := '{}';
  v_wl_plan     uuid;
  v_wl_months   int;
  v_wl_for      int;
  -- <<< ADR-096
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  perform assert_account_active(v_tenant);

  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
  end if;

  if p_table_order_id is not null then
    select * into v_table_order from table_orders
     where id = p_table_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'table_order_not_open';
    end if;
    if v_table_order.status <> 'abierta' or v_table_order.sale_id is not null then
      raise exception 'table_order_not_open';
    end if;
  end if;

  if p_delivery_order_id is not null then
    select * into v_delivery_order from delivery_orders
     where id = p_delivery_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'delivery_order_not_open';
    end if;
    if v_delivery_order.sale_id is not null
       or v_delivery_order.status in ('entregado','cancelado')
       or v_delivery_order.deleted_at is not null then
      raise exception 'delivery_order_not_open';
    end if;
    v_delivery_fee := greatest(coalesce(v_delivery_order.delivery_fee, 0), 0);
  end if;

  -- ADR-088 (ADR-082): cobro de un turno (extra {kind: 'appointment', id}). Se
  -- bloquea el turno y sus señas (dos cobros simultáneos no pasan) y se lee la
  -- seña disponible. Un pago 'sena' sólo vale con el turno.
  select nullif(e.id, '')::uuid into v_appt_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
   where lower(coalesce(e.kind, '')) = 'appointment'
     and e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   limit 1;
  if exists (select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(method text, amount numeric)
              where x.method = 'sena' and coalesce(x.amount, 0) < 0) then
    raise exception 'invalid_payment';
  end if;
  select coalesce(sum(coalesce(x.amount, 0)), 0) into v_sena_paid
    from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(method text, amount numeric)
   where x.method = 'sena';
  if v_appt_id is not null then
    select * into v_appt from appointments
     where id = v_appt_id and tenant_id = v_tenant
     for update;
    if not found then raise exception 'appointment_not_found'; end if;
    if v_appt.sale_id is not null then raise exception 'appointment_already_charged'; end if;
    if v_appt.status = 'cancelado' then raise exception 'appointment_not_active'; end if;
    perform 1 from appointment_deposits d
      where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held'
      for update;
    select coalesce(sum(d.amount - d.applied_amount - d.refunded_amount), 0) into v_sena_avail
      from appointment_deposits d
     where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held';
  elsif v_sena_paid <> 0 then
    raise exception 'deposit_needs_appointment';
  end if;

  -- F17 · H90: la sucursal sale del turno de caja (el que manda el POS o el
  -- inferido), no de la sucursal default. Con una sola sucursal es lo de siempre.
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, true) r;
  if v_shift is null then
    if not exists (select 1 from stores where tenant_id = v_tenant and deleted_at is null) then
      raise exception 'no_store';
    end if;
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;
  -- F17 · H91: el rol puede estar pisado en esta sucursal (tope de descuento).
  v_role := coalesce(user_store_role(v_store), v_role);

  -- F17 · H92 (ADR-049): descuento máximo, redondeo y venta sin stock salen
  -- de la configuración EFECTIVA de la sucursal y la caja del turno
  -- (negocio ← grupo ← sucursal ← caja). Sin overrides es pos_settings.
  select cs.cash_register_id into v_reg from cash_shifts cs where cs.id = v_shift;
  v_eff := _effective_config(v_tenant, 'pos_settings', '', v_store, v_reg) -> 'value';
  v_max_disc  := coalesce((v_eff -> 'max_discount' ->> coalesce(v_role, 'cashier'))::numeric, 100);
  v_round     := coalesce((v_eff ->> 'rounding_multiple')::numeric, 0);
  v_allow_neg := coalesce((v_eff ->> 'allow_negative_stock')::boolean, true);
  -- Stock por sucursal (ADR-046): con la feature y 2+ sucursales, sin venta en
  -- negativo también se controla el saldo de ESTA sucursal, no sólo el total.
  v_branch_stk := tenant_has_feature_for(v_tenant, 'stock_sucursales')
                  and (select count(*) from stores st
                        where st.tenant_id = v_tenant and st.deleted_at is null) > 1;
  -- ADR-088 (ADR-085): con la feature y depósitos en la sucursal del turno, la
  -- venta mira el salón (principal). Sin depósitos, nada cambia.
  v_wh_on := tenant_has_feature_for(v_tenant, 'depositos')
             and exists (select 1 from warehouses w
                          where w.store_id = v_store and w.tenant_id = v_tenant
                            and w.deleted_at is null and w.kind <> 'principal');
  if v_wh_on then
    v_from_res := coalesce((select ps.sell_from_reserve from pos_settings ps where ps.tenant_id = v_tenant), false);
  end if;

  -- ADR-096 >>>
  -- Reservas de stock (ADR-091). Con la feature, lo reservado vigente de la
  -- sucursal no se vende en el mostrador (se valida por línea más abajo) y la
  -- venta puede entregar una reserva (extra {kind: 'reservation', id}). Mismo
  -- lock por sucursal que stock_reservation_create. Sin la feature, nada cambia.
  select count(*), (max(e.id) filter (
           where e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))::uuid
    into v_resv_n, v_resv_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
   where lower(coalesce(e.kind, '')) = 'reservation';
  v_resv_on := tenant_has_feature_for(v_tenant, 'reservas_stock');
  if v_resv_n > 0 and not v_resv_on then
    raise exception 'feature_not_in_plan: reservas_stock';
  end if;
  if v_resv_n > 1 then
    raise exception 'one_reservation_per_sale';
  end if;
  if v_resv_n = 1 and v_resv_id is null then
    raise exception 'reservation_not_found';
  end if;
  if v_resv_on then
    perform pg_advisory_xact_lock(hashtext('stock_reservation:' || v_store::text));
  end if;
  if v_resv_id is not null then
    select * into v_resv from stock_reservations
     where id = v_resv_id and tenant_id = v_tenant
     for update;
    if not found then raise exception 'reservation_not_found'; end if;
    if v_resv.status not in ('reservada', 'preparada') then raise exception 'reservation_not_open'; end if;
    if v_resv.expires_at <= now() then raise exception 'reservation_expired'; end if;
    if v_resv.store_id <> v_store then raise exception 'reservation_wrong_store'; end if;
    -- La identidad del cliente se valida antes (stock_reservation_pickup_verify,
    -- con los intentos contados): el POS carga la reserva después de eso.
    if v_resv.pickup_verified_at is null or v_resv.pickup_verified_at < now() - interval '2 hours' then
      raise exception 'reservation_not_verified';
    end if;
  end if;
  -- <<< ADR-096

  -- F18 · H100 (ADR-056): el servidor manda en el precio. El cobro en espera que
  -- se acredita (ninja.pc_complete) usa el snapshot ya validado al estacionar.
  if not v_pc then
    if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
      raise exception 'invalid_items';
    end if;

    -- Montos sin producto que ya tienen explicación: recargo y garantía (van como
    -- ítem y como extra), packs vendidos (precio del pack) e ítems libres de la
    -- mesa o el delivery que se cobra (los valida el trigger al cargarlos).
    select coalesce(array_agg(round(e.amount, 2)), '{}') into v_pool_extra
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, amount numeric)
     where lower(coalesce(e.kind, '')) in ('warranty', 'surcharge') and coalesce(e.amount, 0) > 0;
    select coalesce(array_agg(sp.price), '{}') into v_pool_pack
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
      join service_packs sp on sp.id::text = e.id and sp.tenant_id = v_tenant and sp.deleted_at is null
     where lower(coalesce(e.kind, '')) = 'pack';
    select coalesce(array_agg(e.id), '{}') into v_pack_creds
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
     where lower(coalesce(e.kind, '')) = 'pack_session' and e.id is not null;
    if p_table_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from table_order_items i
       where i.order_id = p_table_order_id and i.tenant_id = v_tenant and i.product_id is null;
    elsif p_delivery_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from delivery_order_items i
       where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant and i.product_id is null;
    end if;

    for v_i in 0 .. coalesce(jsonb_array_length(p_items), 0) - 1 loop
      v_j     := p_items -> v_i;
      v_qty   := coalesce((v_j ->> 'quantity')::numeric, 0);
      v_up    := coalesce((v_j ->> 'unit_price')::numeric, 0);
      v_ldisc := coalesce((v_j ->> 'discount')::numeric, 0);
      if v_qty <= 0 then raise exception 'invalid_quantity'; end if;
      if v_up < 0 or v_ldisc < 0 then raise exception 'invalid_price'; end if;
      v_pid := nullif(v_j ->> 'product_id', '')::uuid;

      if v_pid is null then
        v_amt := round(v_up * v_qty, 2);
        v_k := _amount_index(v_pool_extra, v_amt);
        if v_k > 0 then
          v_pool_extra := v_pool_extra[1:v_k - 1] || v_pool_extra[v_k + 1:];
        else
          v_k := _amount_index(v_pool_pack, v_amt);
          if v_k > 0 then
            v_pool_pack := v_pool_pack[1:v_k - 1] || v_pool_pack[v_k + 1:];
          else
            v_k := _amount_index(v_pool_order, v_amt);
            if v_k > 0 then
              v_pool_order := v_pool_order[1:v_k - 1] || v_pool_order[v_k + 1:];
            else
              v_free_any := true;
              v_free_total := v_free_total + greatest(v_amt - v_ldisc, 0);
            end if;
          end if;
        end if;
        v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', null));
        continue;
      end if;

      v_vid := nullif(v_j ->> 'variant_id', '')::uuid;
      v_exp := _resolve_unit_price(v_tenant, v_pid, v_vid, v_qty, p_customer_id, v_store, null, now());
      if v_exp is null then raise exception 'product_not_found'; end if;
      v_exp := round(v_exp + _sale_modifier_delta(v_tenant, v_pid, v_j -> 'modifiers'), 2);
      v_ok := abs(v_up - v_exp) <= 0.01;
      v_reason := null;

      -- Regalo de una promo y línea cubierta por una sesión de pack: van a $0.
      if not v_ok and v_up = 0 and nullif(v_j ->> 'gift_promo_id', '') is not null then
        v_ok := exists (select 1 from promotions pr
                         where pr.id::text = v_j ->> 'gift_promo_id' and pr.tenant_id = v_tenant
                           and pr.deleted_at is null);
      end if;
      if not v_ok and v_up = 0 and nullif(v_j ->> 'pack_credit_id', '') is not null then
        v_ok := (v_j ->> 'pack_credit_id') = any (v_pack_creds);
      end if;
      -- Mesa o delivery que se cobra: vale el precio guardado al cargar el ítem.
      if not v_ok and p_table_order_id is not null then
        v_ok := exists (select 1 from table_order_items i
                         where i.order_id = p_table_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;
      if not v_ok and p_delivery_order_id is not null then
        v_ok := exists (select 1 from delivery_order_items i
                         where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;

      if not v_ok then
        if coalesce((v_j ->> 'price_override')::boolean, false) then
          v_reason := nullif(btrim(coalesce(v_j ->> 'override_reason', '')), '');
          if v_reason is null or char_length(v_reason) < 3 then
            raise exception 'price_override_reason_required';
          end if;
          v_reason := left(v_reason, 200);
          v_dev := case when v_exp > 0 then round(abs(v_up - v_exp) / v_exp * 100, 2) else 100 end;
          v_max_dev := greatest(v_max_dev, v_dev);
          v_overrides := v_overrides || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'price', v_up,
            'quantity', v_qty, 'deviation_pct', v_dev, 'reason', v_reason));
        else
          v_mismatch := v_mismatch || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'received', v_up));
        end if;
      end if;
      v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', v_exp, 'reason', v_reason));
    end loop;

    -- Primero el precio: el POS refresca y el cajero vuelve a cobrar.
    -- ADR-077: offline se respeta el precio cobrado y queda el conflicto.
    if jsonb_array_length(v_mismatch) > 0 then
      if v_offline then
        v_off_conf := v_off_conf || (select coalesce(jsonb_agg(m || jsonb_build_object('kind', 'price_changed')), '[]'::jsonb)
                                       from jsonb_array_elements(v_mismatch) as m);
      else
        raise exception using message = 'price_mismatch:' || jsonb_build_object('items', v_mismatch)::text,
                              errcode = 'P0001';
      end if;
    end if;

    -- Venta libre (monto manual sin producto): flag efectivo y tope por rol.
    if v_free_any then
      if not coalesce((v_eff ->> 'allow_free_sale')::boolean, true) then
        raise exception 'free_sale_not_allowed';
      end if;
      v_free_cap := (v_eff -> 'max_free_sale' ->> coalesce(v_role, 'cashier'))::numeric;
      if v_free_cap is not null and v_free_total > v_free_cap + 0.01 then
        raise exception 'free_sale_exceeds_limit';
      end if;
    end if;

    -- Cambio manual de precio: supervisor, o PIN si la política lo pide.
    if jsonb_array_length(v_overrides) > 0 then
      if is_supervisor(v_tenant, auth.uid()) then
        v_price_sup := auth.uid();
      elsif pin_action_required(v_tenant, 'cambio_precio', v_max_dev) then
        v_price_sup := require_supervisor('cambio_precio', v_max_dev, null);
      end if;
    end if;
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    v_subtotal := v_subtotal
      + (coalesce(v_item.unit_price, 0) * coalesce(v_item.quantity, 0))
      - coalesce(v_item.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_item.discount, 0);
  end loop;

  select exists (
    select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text)
    where lower(coalesce(e.kind,'')) = 'pack_session'
  ) into v_has_pack_session;

  if v_subtotal < 0 or (v_subtotal = 0 and not v_has_pack_session) then
    raise exception 'empty_sale';
  end if;

  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'tip'
                           then coalesce(e.amount, 0) else 0 end), 0),
         max(case when lower(coalesce(e.kind,'')) = 'tip' then e.method end)
    into v_tip_amount, v_tip_method
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric, method text);
  if v_tip_amount < 0 then
    raise exception 'invalid_tip';
  end if;
  if v_tip_amount > 0 and v_tip_method is null then
    v_tip_method := 'cash';
  end if;

  select (e.id)::uuid into v_professional
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, id text)
  where lower(coalesce(e.kind,'')) = 'professional'
    and e.id is not null
  order by (e.id)::uuid
  limit 1;
  if v_professional is not null then
    if not exists (
      select 1 from professionals
      where id = v_professional and tenant_id = v_tenant
        and deleted_at is null and is_active
    ) then
      v_professional := null;
    end if;
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
         as e(kind text)
       where lower(coalesce(e.kind,'')) in ('pack','pack_session')
     )
     and p_customer_id is null then
    raise exception 'pack_needs_customer';
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
         as p(method text, amount numeric)
       where p.method = 'account' and coalesce(p.amount, 0) > 0
     )
     and not tenant_has_feature('cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;

  if coalesce(p_discount_total, 0) > 0 and v_subtotal > 0 then
    v_disc_pct := coalesce(p_discount_total, 0) / v_subtotal * 100;
    if v_disc_pct > v_max_disc + 0.001 then
      raise exception 'discount_exceeds_limit';
    end if;
  end if;

  -- F9 (ADR-074): promociones calculadas en el servidor, ANTES del cupón, los
  -- impuestos y las percepciones (los recargos de cuotas llegan como ítem sin
  -- producto y no reciben promos). Mismo motor que el POS (lib/promotions/
  -- engine.ts): si el descuento que manda el POS no coincide, se rechaza con
  -- promo_mismatch y el POS vuelve a calcular. No pasa por el gating de
  -- 'descuentos' ni por el tope por rol (una promo no es descuento manual).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id',
           'category_id', p.category_id,
           'brand_id', p.brand_id,
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'line_total', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                               - coalesce((x.v ->> 'discount')::numeric, 0), 2),
           'excluded', (nullif(x.v ->> 'gift_promo_id', '') is not null
                        or nullif(x.v ->> 'pack_credit_id', '') is not null)) order by x.i), '[]'::jsonb)
    into v_promo_lines
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i)
    left join products p on p.id::text = x.v ->> 'product_id' and p.tenant_id = v_tenant;

  v_promo_ctx := jsonb_build_object(
    'weekday', extract(dow from v_now_ar)::int,
    'minutes', (extract(hour from v_now_ar) * 60 + extract(minute from v_now_ar))::int,
    'date', to_char(v_now_ar, 'YYYY-MM-DD'),
    'store_id', v_store,
    'price_list_id', _promo_sale_list(v_tenant, p_customer_id, v_store),
    'customer_id', p_customer_id,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                          'method', x.method,
                          'card_brand', x.card_voucher ->> 'marca',
                          'bank', x.card_voucher ->> 'banco',
                          'ineligible', coalesce(x.promo_ineligible, false))), '[]'::jsonb)
                   from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
                     as x(method text, amount numeric, card_voucher jsonb, promo_ineligible boolean)
                  where coalesce(x.amount, 0) > 0));

  -- Topes de uso: un cobro a la vez por promo con tope (sin pasarse).
  perform pg_advisory_xact_lock(hashtext('promo_use:' || pr.id::text))
     from promotions pr
    where pr.tenant_id = v_tenant and pr.deleted_at is null and pr.is_active
      and (pr.max_uses_total is not null or pr.max_uses_per_customer is not null)
    order by pr.id;

  v_promo_eval := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);
  -- El cupón es excluyente con las promos de descuento (los regalos conviven).
  if p_coupon_id is not null then
    v_promo_eval := v_promo_eval || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb);
  end if;
  v_promo_calc := least(coalesce((v_promo_eval ->> 'discount')::numeric, 0),
                        greatest(v_subtotal - coalesce(p_discount_total, 0), 0));

  if v_pc then
    -- Cobro en espera acreditado: vale el monto validado en el ensayo (como el
    -- precio). Si el motor ya no da lo mismo (cambió la hora), queda una sola
    -- fila con la promo que se mandó.
    v_promo_disc := least(greatest(coalesce(p_promo_discount, 0), 0),
                          greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
    if abs(v_promo_calc - v_promo_disc) > 0.01 then
      v_promo_eval := v_promo_eval || jsonb_build_object('applied',
        case when v_promo_disc > 0 then jsonb_build_array(jsonb_build_object(
               'id', p_promo_id, 'name', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'label', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'discount', v_promo_disc, 'lines', '[]'::jsonb))
             else '[]'::jsonb end);
    end if;
  else
    if coalesce(p_promo_discount, 0) > 0 and not tenant_has_feature_for(v_tenant, 'promociones') then
      raise exception 'feature_not_in_plan: promociones';
    end if;
    -- Borde de una franja (happy hour, cambio de día): el POS calculó con su
    -- reloj hasta 5 minutos antes (por ejemplo, un QR que tardó en pagarse).
    if abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      v_promo_ctx := v_promo_ctx || jsonb_build_object(
        'weekday', extract(dow from v_now_ar - interval '5 minutes')::int,
        'minutes', (extract(hour from v_now_ar - interval '5 minutes') * 60
                    + extract(minute from v_now_ar - interval '5 minutes'))::int,
        'date', to_char(v_now_ar - interval '5 minutes', 'YYYY-MM-DD'));
      v_gift := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);
      if p_coupon_id is not null then
        v_gift := v_gift || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb);
      end if;
      if abs(greatest(coalesce(p_promo_discount, 0), 0)
             - least(coalesce((v_gift ->> 'discount')::numeric, 0),
                     greatest(v_subtotal - coalesce(p_discount_total, 0), 0))) <= 0.01 then
        v_promo_eval := v_gift;
        v_promo_calc := least(coalesce((v_gift ->> 'discount')::numeric, 0),
                              greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
      end if;
    end if;
    if v_offline and abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      -- ADR-077: la promo se recalculó al sincronizar y no da lo mismo (venció,
      -- se editó, se agotó el tope...). Se respeta lo cobrado, como el precio,
      -- con una sola fila de la promo que mandó el POS, y queda el conflicto
      -- 'promo_changed' para revisión.
      v_promo_disc := least(greatest(coalesce(p_promo_discount, 0), 0),
                            greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
      v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
        'kind', 'promo_changed',
        'promo_id', p_promo_id,
        'promo_name', nullif(btrim(coalesce(p_promo_name, '')), ''),
        'charged', v_promo_disc,
        'expected', v_promo_calc,
        'expected_applied', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'label',
                                                                          'discount', (a ->> 'discount')::numeric))
                                        from jsonb_array_elements(v_promo_eval -> 'applied') a), '[]'::jsonb)));
      v_promo_eval := v_promo_eval || jsonb_build_object('applied',
        case when v_promo_disc > 0 then jsonb_build_array(jsonb_build_object(
               'id', p_promo_id, 'name', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'label', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'discount', v_promo_disc, 'lines', '[]'::jsonb))
             else '[]'::jsonb end);
      v_promo_calc := v_promo_disc;
    end if;
    if abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      raise exception using
        message = 'promo_mismatch:' || jsonb_build_object(
          'expected', v_promo_calc,
          'received', coalesce(p_promo_discount, 0),
          'applied', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'label',
                                                                  'discount', (a ->> 'discount')::numeric))
                                 from jsonb_array_elements(v_promo_eval -> 'applied') a), '[]'::jsonb))::text,
        errcode = 'P0001';
    end if;
    v_promo_disc := v_promo_calc;
    -- Regalos: cada línea a $0 con gift_promo_id tiene que salir del motor
    -- (misma promo, mismo producto, sin pasarse de la cantidad).
    for v_gift in
      select x.v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as x(v)
       where nullif(x.v ->> 'gift_promo_id', '') is not null
    loop
      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_promo_eval -> 'gifts', '[]'::jsonb)) g
         where g ->> 'id' = v_gift ->> 'gift_promo_id'
           and g ->> 'product_id' = v_gift ->> 'product_id'
           and coalesce((v_gift ->> 'quantity')::numeric, 0) <= coalesce((g ->> 'qty')::numeric, 0)
           and coalesce((v_gift ->> 'unit_price')::numeric, 0) = 0) then
        if v_offline and coalesce((v_gift ->> 'unit_price')::numeric, 0) = 0 then
          -- ADR-077: regalo entregado sin conexión que el motor ya no da: se
          -- respeta lo entregado y queda el conflicto 'promo_changed'.
          v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
            'kind', 'promo_changed', 'gift', true,
            'promo_id', v_gift ->> 'gift_promo_id', 'product_id', v_gift ->> 'product_id',
            'quantity', v_gift -> 'quantity'));
        else
          raise exception 'promo_gift_invalid';
        end if;
      end if;
    end loop;
  end if;

  select string_agg(coalesce(nullif(a ->> 'label', ''), a ->> 'name'), ' + ' order by o),
         (array_agg(nullif(a ->> 'id', '')::uuid order by o))[1]
    into v_promo_label, v_promo_first
    from jsonb_array_elements(coalesce(v_promo_eval -> 'applied', '[]'::jsonb)) with ordinality as t(a, o);

  -- Cupón (F9 · H54): lock de la fila + validación + cómputo AUTORITATIVO. Bypass
  -- del gating de 'descuentos' y del tope por rol (un cupón no es descuento manual),
  -- igual que la promo. El registro del canje se hace tras insertar la venta.
  if p_coupon_id is not null then
    select * into v_coupon from coupons
      where id = p_coupon_id and tenant_id = v_tenant and deleted_at is null
      for update;
    if not found then raise exception 'coupon_not_found'; end if;
    if not v_coupon.is_active then raise exception 'coupon_inactive'; end if;
    if v_coupon.valid_from is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date < v_coupon.valid_from then
      raise exception 'coupon_not_yet_valid';
    end if;
    if v_coupon.valid_to is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date > v_coupon.valid_to then
      raise exception 'coupon_expired';
    end if;
    if v_subtotal < coalesce(v_coupon.min_amount, 0) then
      raise exception 'coupon_min_amount';
    end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
      raise exception 'coupon_usage_exceeded';
    end if;
    if v_coupon.max_per_customer is not null then
      if p_customer_id is null then raise exception 'coupon_needs_customer'; end if;
      if (select count(*) from coupon_redemptions
            where coupon_id = v_coupon.id and customer_id = p_customer_id)
         >= v_coupon.max_per_customer then
        raise exception 'coupon_customer_exceeded';
      end if;
    end if;
    v_coupon_disc := case when v_coupon.discount_type = 'percent'
                          then v_subtotal * coalesce(v_coupon.discount_value, 0) / 100
                          else coalesce(v_coupon.discount_value, 0) end;
    v_coupon_disc := least(
      greatest(v_coupon_disc, 0),
      greatest(v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc, 0)
    );
  end if;

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc - v_coupon_disc;

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  if v_delivery_fee > 0 then
    v_subtotal := v_subtotal + v_delivery_fee;
    v_total    := v_total + v_delivery_fee;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
    if v_pay.method = 'store_credit' then
      v_sc_total := v_sc_total + coalesce(v_pay.amount, 0);
    end if;
  end loop;

  -- F18 · H103-H105 (ADR-068): desglose fiscal. Una línea por ítem en el orden
  -- de p_items (el mismo índice que sale_items) y el envío al final; el total
  -- sin percepciones se reparte entre ellas (descuentos, promo, cupón y
  -- redondeo quedan dentro de cada ítem). Las percepciones se suman al total
  -- y el pago tiene que cubrirlas (el POS las muestra con sale_tax_preview).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id', 'variant_id', x.v ->> 'variant_id',
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'gross', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                          - coalesce((x.v ->> 'discount')::numeric, 0), 2)) order by x.i), '[]'::jsonb)
    into v_tax_in
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i);
  if v_delivery_fee > 0 then
    v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object('product_id', null, 'quantity', 1, 'gross', v_delivery_fee));
  end if;
  v_total_np := v_total;
  v_tax := _sale_tax_compute(v_tenant, p_customer_id, v_tax_in, v_total_np, now());
  v_perc := coalesce((v_tax ->> 'perception_total')::numeric, 0);
  -- Cobro en espera que se acredita: la plata ya entró por el monto del ensayo.
  -- Si una percepción nueva (padrón cambiado en el medio) no está cubierta, no
  -- se percibe y queda el aviso en la venta.
  if v_perc > 0 and v_pc and v_paid < v_total_np + v_perc + v_tip_amount - 0.001 then
    v_tax := v_tax || jsonb_build_object(
      'perceptions', '[]'::jsonb, 'perception_total', 0,
      'warnings', coalesce(v_tax -> 'warnings', '[]'::jsonb) || jsonb_build_array('perception_skipped_pending_charge'));
    v_perc := 0;
  end if;
  v_total := v_total_np + v_perc;

  -- ADR-088 (ADR-082): la seña cubre hasta el total. El POS la manda como pago
  -- 'sena' por exactamente eso: de menos se cobraría dos veces; de más, no hay.
  if v_appt_id is not null and (v_sena_avail > 0 or v_sena_paid > 0) then
    v_sena_exp := round(least(v_sena_avail, v_total), 2);
    if abs(v_sena_paid - v_sena_exp) > 0.01 then
      raise exception using
        message = 'deposit_mismatch:' || jsonb_build_object('expected', v_sena_exp, 'received', v_sena_paid)::text,
        errcode = 'P0001';
    end if;
  end if;

  if v_paid < v_total + v_tip_amount then
    raise exception 'insufficient_payment';
  end if;
  if v_sc_total > v_total + 0.001 then
    raise exception 'store_credit_exceeds_total';
  end if;

  if v_sc_total > 0 then
    if p_customer_id is null then
      raise exception 'store_credit_needs_customer';
    end if;
    select coalesce(sum(delta), 0) into v_sc_bal
    from store_credit_movements
    where tenant_id = v_tenant and customer_id = p_customer_id;
    if v_sc_bal < v_sc_total - 0.001 then
      raise exception 'insufficient_store_credit';
    end if;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text)
  loop
    if v_pay.method = 'qr' then
      v_qr_ref := null;
      if v_pay.reference is not null
         and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
        select pi.id, pi.provider_key, pi.sale_id, pi.status, pi.amount
          into v_intent
        from mp_payment_intents pi
        where pi.id = v_pay.reference::uuid
          and pi.tenant_id = v_tenant
        limit 1;
        if found then
          v_qr_ref := v_intent.id;
        end if;
      end if;

      if v_qr_ref is not null then
        if v_intent.status <> 'approved' then
          raise exception 'qr_not_approved';
        end if;
        if v_intent.sale_id is not null then
          raise exception 'qr_already_charged';
        end if;
        if exists (
          select 1 from payments pmt
          join sales s on s.id = pmt.sale_id and s.tenant_id = v_tenant
          where pmt.method = 'qr' and pmt.reference = v_qr_ref::text
        ) then
          raise exception 'qr_already_charged';
        end if;
        select coalesce(sum(coalesce(q.amount, 0)), 0) into v_qr_sum
        from jsonb_to_recordset(p_payments)
          as q(method text, amount numeric, reference text)
        where q.method = 'qr'
          and q.reference is not null
          and q.reference ~ '^[0-9a-fA-F-]{36}$'
          and q.reference::uuid = v_qr_ref;
        if v_qr_sum > coalesce(v_intent.amount, 0) + 0.01 then
          raise exception 'qr_amount_mismatch';
        end if;
        v_pay_feat := case v_intent.provider_key
                        when 'mercadopago' then 'mercado_pago'
                        when 'mobbex'      then 'mobbex'
                        when 'modo'        then 'modo'
                        when 'pagos360'    then 'pagos360'
                        else null
                      end;
        if v_pay_feat is not null and not tenant_has_feature(v_pay_feat) then
          raise exception 'method_not_in_plan';
        end if;
      else
        v_qr_plain := true;
      end if;
    end if;
  end loop;

  if v_qr_plain
     and not (
       tenant_has_feature('mercado_pago')
       or tenant_has_feature('mobbex')
       or tenant_has_feature('modo')
       or tenant_has_feature('pagos360')
     ) then
    raise exception 'qr_not_allowed';
  end if;

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  -- ADR-093: tenant_id explícito (sin DEFAULT current_tenant_id() por fila).
  insert into sales (tenant_id, store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method,
                     promo_id, promo_name, promo_discount,
                     coupon_id, coupon_code, coupon_discount,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total)
  values (v_tenant, v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total_np,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0) + v_perc,
          v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end,
          case when v_promo_disc > 0 then v_promo_first else null end,
          case when v_promo_disc > 0 then left(v_promo_label, 200) else null end,
          v_promo_disc,
          case when v_coupon_disc > 0 then p_coupon_id else null end,
          case when v_coupon_disc > 0 then v_coupon.code else null end,
          v_coupon_disc,
          v_tax ->> 'letter',
          jsonb_build_object('emitter', v_tax -> 'emitter', 'receptor', v_tax -> 'receptor',
                             'requires_identification', v_tax -> 'requires_identification',
                             'warnings', v_tax -> 'warnings'),
          coalesce((v_tax ->> 'net_taxed')::numeric, 0), coalesce((v_tax ->> 'net_exempt')::numeric, 0),
          coalesce((v_tax ->> 'net_untaxed')::numeric, 0), coalesce((v_tax ->> 'iva_total')::numeric, 0),
          coalesce((v_tax ->> 'internal_total')::numeric, 0), v_perc)
  returning id into v_sale_id;

  -- ADR-068: AlicIva, tributo de internos y percepciones de la venta.
  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, rate_code, rate, base, amount, arca_id, source)
  select v_tenant, v_sale_id, 'iva', 'iva', x.code, x.rate, x.base, x.amount, x.arca_id, 'product'
    from jsonb_to_recordset(coalesce(v_tax -> 'iva', '[]'::jsonb))
      as x(code text, rate numeric, base numeric, amount numeric, arca_id int);
  if coalesce((v_tax ->> 'internal_total')::numeric, 0) > 0 then
    insert into sale_tax_lines (tenant_id, sale_id, kind, tax, base, amount, arca_id, source, name)
    values (v_tenant, v_sale_id, 'internos', 'internos', coalesce((v_tax ->> 'internal_base')::numeric, 0),
            (v_tax ->> 'internal_total')::numeric, 4, 'product', 'Impuestos internos');
  end if;
  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, jurisdiction, rate, base, amount, arca_id,
                              regime_id, source, name)
  select v_tenant, v_sale_id, 'perception', x.tax, x.jurisdiction, x.rate, x.base, x.amount, x.arca_tributo_id,
         x.regime_id, x.source, x.name
    from jsonb_to_recordset(coalesce(v_tax -> 'perceptions', '[]'::jsonb))
      as x(tax text, jurisdiction text, rate numeric, base numeric, amount numeric, arca_tributo_id int,
           regime_id uuid, source text, name text);

  -- Registro del canje del cupón (F9 · H54): consume un uso + traza. Atómico:
  -- la fila ya está bloqueada (FOR UPDATE arriba), así que dos cobros simultáneos
  -- no pueden pasar el tope.
  if p_coupon_id is not null and v_coupon_disc > 0 then
    update coupons set used_count = used_count + 1, updated_at = now()
     where id = p_coupon_id and tenant_id = v_tenant;
    insert into coupon_redemptions (tenant_id, coupon_id, sale_id, customer_id, discount)
    values (v_tenant, p_coupon_id, v_sale_id, p_customer_id, v_coupon_disc);
  end if;

  -- F9 (ADR-074): cada promo aplicada, con su reparto por línea. Si el total
  -- quedó acotado por el descuento manual, se descuenta de las últimas.
  v_promo_left := v_promo_disc;
  for v_ap in
    select a from jsonb_array_elements(coalesce(v_promo_eval -> 'applied', '[]'::jsonb)) a
  loop
    v_amt := least(coalesce((v_ap ->> 'discount')::numeric, 0), v_promo_left);
    exit when v_amt <= 0;
    insert into sale_promotions (tenant_id, sale_id, promotion_id, name, label, kind, discount,
                                 customer_id, store_id, detail)
    values (v_tenant, v_sale_id,
            (select pr.id from promotions pr where pr.id::text = v_ap ->> 'id' and pr.tenant_id = v_tenant),
            coalesce(v_ap ->> 'name', 'Promoción'), coalesce(nullif(v_ap ->> 'label', ''), v_ap ->> 'name', 'Promoción'),
            'discount', v_amt, p_customer_id, v_store,
            jsonb_build_object('lines', coalesce(v_ap -> 'lines', '[]'::jsonb), 'stackable', v_ap -> 'stackable'));
    v_promo_left := v_promo_left - v_amt;
    -- ADR-088 (ADR-074): reparto por línea (índice de p_items), acotado como
    -- la fila si el descuento manual dejó menos. Lo usa la devolución parcial.
    if coalesce((v_ap ->> 'discount')::numeric, 0) > 0 and jsonb_typeof(v_ap -> 'lines') = 'array' then
      for v_i in 0 .. jsonb_array_length(v_ap -> 'lines') - 1 loop
        v_pl := round(coalesce((v_ap -> 'lines' ->> v_i)::numeric, 0) * v_amt / (v_ap ->> 'discount')::numeric, 2);
        if v_pl > 0 then
          v_promo_line[v_i + 1] := coalesce(v_promo_line[v_i + 1], 0) + v_pl;
        end if;
      end loop;
    end if;
  end loop;
  -- Regalos entregados (valor de lista de lo regalado, para el rendimiento).
  insert into sale_promotions (tenant_id, sale_id, promotion_id, name, label, kind, discount,
                               customer_id, store_id, detail)
  select v_tenant, v_sale_id, pr.id, pr.name, coalesce(nullif(btrim(coalesce(pr.ticket_label, '')), ''), pr.name),
         'gift',
         round(coalesce((v_prices -> (x.i - 1)::int ->> 'list_price')::numeric, 0)
               * coalesce((x.v ->> 'quantity')::numeric, 0), 2),
         p_customer_id, v_store,
         jsonb_build_object('product_id', x.v ->> 'product_id', 'quantity', x.v -> 'quantity')
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i)
    join promotions pr on pr.id::text = x.v ->> 'gift_promo_id' and pr.tenant_id = v_tenant
   where nullif(x.v ->> 'gift_promo_id', '') is not null;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, modifiers jsonb,
           quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      if coalesce(v_has_variants, false) then
        if v_item.variant_id is null then
          raise exception 'variant_required';
        end if;
        select * into v_variant from product_variants
         where id = v_item.variant_id and product_id = v_item.product_id
           and tenant_id = v_tenant and deleted_at is null;
        if not found then
          raise exception 'variant_not_found';
        end if;
        v_pname := v_pname || ' · ' || v_variant.option1
                   || coalesce(' / ' || v_variant.option2, '');
      elsif v_item.variant_id is not null then
        raise exception 'variant_not_allowed';
      end if;
    else
      v_pname  := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku   := null;
      v_is_kit := false;
      v_track  := false;
      v_has_variants := false;
    end if;

    v_serial := nullif(btrim(coalesce(v_item.serial, '')), '');

    -- ADR-056: precio de lista calculado y motivo del cambio manual (mismo orden
    -- que p_items; vacío en el cobro en espera acreditado).
    -- ADR-068: alícuota, precio final repartido, neto, IVA e internos.
    v_tl := v_tax -> 'lines' -> v_n;
    -- ADR-093: tenant_id explícito.
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            list_price, price_override_reason,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount,
                            promo_discount)
    values (v_tenant, v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb),
            (v_prices -> v_n ->> 'list_price')::numeric,
            v_prices -> v_n ->> 'reason',
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric,
            -- ADR-088 (ADR-074): parte de la promo de esta línea.
            coalesce(v_promo_line[v_n + 1], 0))
    returning id into v_line_id;  -- ADR-096: id de la línea (vínculo de la garantía).
    v_line_ids := v_line_ids || v_line_id;  -- ADR-096
    v_n := v_n + 1;

    if v_item.product_id is not null then
      if v_is_kit then
        for v_comp in
          select pkc.component_product_id, pkc.quantity,
                 pr.stock as comp_stock, pr.allow_negative as comp_allow, pr.track_stock as comp_track
          from product_kit_components pkc
          join products pr on pr.id = pkc.component_product_id and pr.tenant_id = v_tenant
          where pkc.kit_product_id = v_item.product_id and pkc.tenant_id = v_tenant
        loop
          if v_comp.comp_track then
            if not coalesce(v_comp.comp_allow, v_allow_neg)
               and v_comp.comp_stock < (v_item.quantity * v_comp.quantity) then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_comp.comp_allow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_comp.component_product_id
                                and ps.variant_id is null), 0) < (v_item.quantity * v_comp.quantity) then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-096 >>>
            -- ADR-091: lo reservado por otras reservas de la sucursal no se vende.
            if v_resv_on and not coalesce(v_comp.comp_allow, v_allow_neg) then
              v_resv_short := _sale_reserved_short(v_store, v_comp.component_product_id, null, v_item.quantity * v_comp.quantity,
                                                   v_wh_on and not v_from_res, v_resv_id);
              if v_resv_short > 0 then
                -- ADR-077: offline se vende igual y queda el conflicto.
                if not v_offline then raise exception 'insufficient_stock_reserved'; end if;
                v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                  'kind', 'negative_stock_reserved', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                  'quantity', v_item.quantity));
              end if;
            end if;
            -- <<< ADR-096
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_comp.component_product_id, null,
                                       v_item.quantity * v_comp.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_comp.comp_allow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id = v_variant.id), 0) < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-096 >>>
            -- ADR-091: lo reservado por otras reservas de la sucursal no se vende.
            if v_resv_on and not coalesce(v_pallow, v_allow_neg) then
              v_resv_short := _sale_reserved_short(v_store, v_item.product_id, v_variant.id, v_item.quantity,
                                                   v_wh_on and not v_from_res, v_resv_id);
              if v_resv_short > 0 then
                -- ADR-077: offline se vende igual y queda el conflicto.
                if not v_offline then raise exception 'insufficient_stock_reserved'; end if;
                v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                  'kind', 'negative_stock_reserved', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                  'quantity', v_item.quantity));
              end if;
            end if;
            -- <<< ADR-096
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_item.product_id, v_variant.id, v_item.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_pallow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id is null), 0) < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-096 >>>
            -- ADR-091: lo reservado por otras reservas de la sucursal no se vende.
            if v_resv_on and not coalesce(v_pallow, v_allow_neg) then
              v_resv_short := _sale_reserved_short(v_store, v_item.product_id, null, v_item.quantity,
                                                   v_wh_on and not v_from_res, v_resv_id);
              if v_resv_short > 0 then
                -- ADR-077: offline se vende igual y queda el conflicto.
                if not v_offline then raise exception 'insufficient_stock_reserved'; end if;
                v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                  'kind', 'negative_stock_reserved', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                  'quantity', v_item.quantity));
              end if;
            end if;
            -- <<< ADR-096
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_item.product_id, null, v_item.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_pallow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            -- ADR-093: tenant_id explícito.
            insert into product_serials (tenant_id, product_id, serial, status, sale_id)
            values (v_tenant, v_item.product_id, v_serial, 'sold', v_sale_id)
            on conflict (product_id, serial) do update
              set status = 'sold', sale_id = v_sale_id;
          end if;
        end if;
      end if;
    end if;
  end loop;

  -- ADR-096 >>>
  -- ADR-092: garantía extendida enlazada a la línea que cubre. La línea de la
  -- garantía (sin producto) trae warranty_plan_id y warranty_for (índice en
  -- p_items de una línea con producto). Offline (ADR-077) un vínculo inválido
  -- no frena la sincronización: la línea queda sin vínculo, como antes.
  for v_i in 0 .. coalesce(jsonb_array_length(p_items), 0) - 1 loop
    v_j := p_items -> v_i;
    continue when nullif(v_j ->> 'warranty_plan_id', '') is null;
    if not tenant_has_feature('garantias') then
      raise exception 'feature_not_in_plan: garantias';
    end if;
    v_wl_plan := null;
    v_wl_months := null;
    v_wl_for := case when (v_j ->> 'warranty_for') ~ '^[0-9]{1,5}$' then (v_j ->> 'warranty_for')::int end;
    select wp.id, wp.months into v_wl_plan, v_wl_months
      from warranty_plans wp
     where wp.id::text = v_j ->> 'warranty_plan_id' and wp.tenant_id = v_tenant;
    if v_wl_plan is null or v_wl_for is null or v_wl_for = v_i
       or v_wl_for >= jsonb_array_length(p_items)
       or nullif(v_j ->> 'product_id', '') is not null
       or nullif(p_items -> v_wl_for ->> 'product_id', '') is null then
      if v_offline then continue; end if;
      raise exception 'warranty_link_invalid';
    end if;
    update sale_items
       set warranty_plan_id = v_wl_plan, warranty_for_item_id = v_line_ids[v_wl_for + 1],
           warranty_months = v_wl_months
     where id = v_line_ids[v_i + 1] and tenant_id = v_tenant;
  end loop;

  -- ADR-091: la venta entrega la reserva. Tiene que cubrir sus renglones; la
  -- reserva queda entregada con esta venta en la misma transacción. Su propia
  -- cantidad no contó como reservada al validar el stock (sin doble descuento).
  if v_resv_id is not null then
    if exists (
      select 1 from stock_reservation_items i
       where i.reservation_id = v_resv_id
         and i.qty > coalesce((select sum(si.quantity) from sale_items si
                                where si.sale_id = v_sale_id and si.product_id = i.product_id
                                  and si.variant_id is not distinct from i.variant_id), 0)) then
      raise exception 'reservation_items_mismatch';
    end if;
    update stock_reservations
       set status = 'entregada', sale_id = v_sale_id, delivered_by = auth.uid(), delivered_at = now()
     where id = v_resv_id and tenant_id = v_tenant;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data, reason, store_id)
    values (v_tenant, auth.uid(), 'stock_reservations', v_resv_id, 'stock_reservation_delivered',
            jsonb_build_object('status', v_resv.status),
            jsonb_build_object('status', 'entregada', 'sale_id', v_sale_id, 'sale_number', v_number,
                               'verified_by', v_resv.pickup_verified_via, 'source', 'pos'),
            v_resv.override_reason, v_store);
  end if;
  -- <<< ADR-096

  -- ADR-056: cambio manual de precio, con quién lo autorizó.
  if jsonb_array_length(v_overrides) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            reason, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'price_override',
            v_overrides -> 0 ->> 'reason',
            jsonb_build_object('sale_number', v_number, 'items', v_overrides,
                               'max_deviation_pct', v_max_dev, 'supervisor_id', v_price_sup),
            v_store);
  end if;

  -- ADR-088 (ADR-085): lo que se vendió de la reserva porque el salón no alcanzaba.
  if jsonb_array_length(v_res_taken) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'sale_from_reserve',
            jsonb_build_object('sale_number', v_number, 'items', v_res_taken), v_store);
  end if;

  if v_delivery_fee > 0 then
    v_tl := v_tax -> 'lines' -> v_n;
    -- ADR-093: tenant_id explícito.
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale_id, null, null, 'Costo de envío', null, null,
            1, v_delivery_fee, 0, v_delivery_fee, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    -- ADR-093: tenant_id explícito en pagos, caja y saldo a favor.
    insert into payments (tenant_id, sale_id, method, amount, reference, card_voucher)
    values (v_tenant, v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
            coalesce(v_pay.card_voucher, '{}'::jsonb));

    if v_pay.method = 'qr'
       and v_pay.reference is not null
       and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
      update mp_payment_intents
         set sale_id = v_sale_id, updated_at = now()
       where id = v_pay.reference::uuid
         and tenant_id = v_tenant
         and sale_id is null;
    end if;

    insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reference_id)
    values (v_tenant, v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (tenant_id, customer_id, delta, reason)
      values (v_tenant, p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  -- ADR-088 (ADR-082): la seña se aplica (la plata ya entró a la caja al
  -- cobrarla) y el turno queda enlazado a la venta en esta misma transacción.
  if v_appt_id is not null then
    v_sena_left := v_sena_exp;
    for v_dep in
      select d.id, d.amount, d.applied_amount, d.refunded_amount
        from appointment_deposits d
       where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held'
       order by d.created_at, d.id
    loop
      exit when v_sena_left <= 0;
      v_amt := least(v_dep.amount - v_dep.applied_amount - v_dep.refunded_amount, v_sena_left);
      continue when v_amt <= 0;
      update appointment_deposits
         set applied_amount = applied_amount + v_amt,
             sale_id = v_sale_id,
             status = _appointment_deposit_status(amount, applied_amount + v_amt, refunded_amount)
       where id = v_dep.id;
      v_sena_left := v_sena_left - v_amt;
    end loop;

    update appointments
       set sale_id = v_sale_id, status = 'realizado', updated_at = now()
     where id = v_appt_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'appointments', v_appt_id, 'appointment_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'deposit_applied', v_sena_exp, 'deposit_available', v_sena_avail),
            v_store);
  end if;

  for v_pack in
    select (e.id)::uuid as pack_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack' and e.id is not null
  loop
    select * into v_pk from service_packs
     where id = v_pack.pack_id and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'pack_not_found';
    end if;
    -- ADR-093: tenant_id explícito.
    insert into customer_pack_credits (
      tenant_id, customer_id, pack_id, pack_name, product_id,
      sessions_total, sessions_used, expires_at, sale_id
    )
    values (
      v_tenant, p_customer_id, v_pk.id, v_pk.name, v_pk.product_id,
      v_pk.sessions, 0,
      case when v_pk.validity_days is not null
           then now() + make_interval(days => v_pk.validity_days) else null end,
      v_sale_id
    );
  end loop;

  for v_pack in
    select (e.id)::uuid as credit_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack_session' and e.id is not null
  loop
    select * into v_pcredit from customer_pack_credits
     where id = v_pack.credit_id and tenant_id = v_tenant
       and customer_id = p_customer_id
     for update;
    if not found then
      raise exception 'pack_credit_not_found';
    end if;
    if v_pcredit.sessions_used >= v_pcredit.sessions_total then
      raise exception 'pack_no_sessions_left';
    end if;
    if v_pcredit.expires_at is not null and v_pcredit.expires_at < now() then
      raise exception 'pack_expired';
    end if;

    update customer_pack_credits
       set sessions_used = sessions_used + 1
     where id = v_pcredit.id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_tenant, auth.uid(), 'customer_pack_credits', v_pcredit.id, 'pack_session_used',
            jsonb_build_object('sessions_used', v_pcredit.sessions_used,
                               'sessions_total', v_pcredit.sessions_total),
            jsonb_build_object('sessions_used', v_pcredit.sessions_used + 1,
                               'sessions_total', v_pcredit.sessions_total,
                               'sale_id', v_sale_id, 'sale_number', v_number));
  end loop;

  if p_table_order_id is not null then
    update table_orders
       set sale_id = v_sale_id, status = 'cobrada', updated_at = now()
     where id = p_table_order_id and tenant_id = v_tenant;

    update dining_tables
       set status = 'libre', current_order_id = null, waiter_user_id = null
     where id = v_table_order.table_id and tenant_id = v_tenant
       and current_order_id = p_table_order_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'table_orders', p_table_order_id, 'table_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'table_id', v_table_order.table_id));
  end if;

  if p_delivery_order_id is not null then
    update delivery_orders
       set sale_id = v_sale_id, status = 'entregado', updated_at = now()
     where id = p_delivery_order_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'delivery_orders', p_delivery_order_id, 'delivery_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'order_type', v_delivery_order.order_type,
                               'delivery_fee', v_delivery_fee));
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount, 'promo_discount', v_promo_disc,
                            'promotions', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', sp.promotion_id, 'label', sp.label, 'kind', sp.kind, 'discount', sp.discount)
                                order by sp.kind desc, sp.created_at)
                              from sale_promotions sp where sp.sale_id = v_sale_id), '[]'::jsonb),
                            'coupon_discount', v_coupon_disc,
                            'perception_total', v_perc, 'cbte_letter', v_tax ->> 'letter',
                            -- ADR-077: diferencias de la venta offline (null fuera de ese modo).
                            'offline_conflicts', case when v_offline then v_off_conf else null end,
                            -- ADR-088: aviso de lo que salió de la reserva y seña aplicada.
                            'reserve_taken', v_res_taken,
                            'deposit_applied', v_sena_exp);
end;
$function$;

revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- B.2) serial_lookup con el vínculo explícito (misma firma y salida que
--      20261109200400 más `extended_link`: 'explicit', 'name' o null).
--      Primero la garantía enlazada a ESTA línea. Si la venta no tiene ningún
--      vínculo (ventas viejas o cobros que no lo mandan), sigue el nombre de la
--      línea ("Garantía <plan>"), como antes.
-- -----------------------------------------------------------------------------
create or replace function serial_lookup(p_serial text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _serial_assert(false);
  v_s      text := upper(btrim(coalesce(p_serial, '')));
  v_today  date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_out    jsonb;
begin
  if char_length(v_s) < 3 then raise exception 'serial_too_short'; end if;

  with sold as (
    select si.id as line_id, si.sale_id, si.product_id, si.product_name, si.serial,
           si.quantity, si.returned_qty,
           s.number, s.status as sale_status, s.store_id, s.customer_id, s.created_at,
           (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date as sale_date,
           coalesce(p.warranty_months, 0) as mf_months
      from sale_items si
      join sales s on s.id = si.sale_id
      left join products p on p.id = si.product_id
     where si.tenant_id = v_tenant and si.serial is not null and upper(btrim(si.serial)) = v_s
     order by s.created_at desc
     limit 10
  ),
  enriched as (
    select so.*,
           coalesce(xl.label, ext.label) as ext_label,
           coalesce(xl.months, ext.months, 0) as ext_months,
           case when xl.months is not null then 'explicit'
                when ext.months is not null then 'name' end as ext_link,
           st.name as store_name, c.name as customer_name
      from sold so
      -- ADR-096: garantía enlazada a esta línea (meses guardados al vender).
      left join lateral (
        select coalesce(wp.label, regexp_replace(gi.product_name, '^Garant[^ ]* ', '')) as label,
               coalesce(gi.warranty_months, wp.months, 0) as months
          from sale_items gi
          left join warranty_plans wp on wp.id = gi.warranty_plan_id
         where gi.sale_id = so.sale_id and gi.warranty_for_item_id = so.line_id
         order by coalesce(gi.warranty_months, wp.months, 0) desc
         limit 1
      ) xl on true
      -- Fallback por nombre: sólo si la venta no tiene ningún vínculo explícito.
      left join lateral (
        select wp.label, wp.months
          from sale_items gi
          join warranty_plans wp on wp.tenant_id = v_tenant
           and gi.product_name ilike ('Garant%' || wp.label)
         where gi.sale_id = so.sale_id and gi.product_id is null
           and not exists (select 1 from sale_items gx
                            where gx.sale_id = so.sale_id and gx.warranty_for_item_id is not null)
         order by wp.months desc
         limit 1
      ) ext on true
      left join stores st on st.id = so.store_id
      left join customers c on c.id = so.customer_id
  ),
  dated as (
    select e.*,
           case when e.mf_months + e.ext_months > 0
                then (e.sale_date + make_interval(months => e.mf_months + e.ext_months))::date end as until,
           case when e.mf_months > 0
                then (e.sale_date + make_interval(months => e.mf_months))::date end as mf_until
      from enriched e
  )
  select jsonb_build_object(
    'serial', v_s,
    'sales', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id', d.line_id, 'sale_id', d.sale_id, 'sale_number', d.number,
               'sale_status', d.sale_status, 'sold_at', d.created_at, 'sale_date', d.sale_date,
               'product_id', d.product_id, 'product_name', d.product_name, 'serial', d.serial,
               'returned', coalesce(d.returned_qty, 0) >= d.quantity,
               'store_id', d.store_id, 'store_name', d.store_name,
               'customer_id', d.customer_id, 'customer_name', d.customer_name,
               'manufacturer_months', d.mf_months, 'manufacturer_until', d.mf_until,
               'extended_label', d.ext_label, 'extended_months', d.ext_months,
               'extended_link', d.ext_link,
               'warranty_until', d.until,
               'in_warranty', d.sale_status = 'completed'
                              and coalesce(d.returned_qty, 0) < d.quantity
                              and d.until is not null and d.until >= v_today)
             order by d.created_at desc)
        from dated d), '[]'::jsonb),
    'in_stock', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', ps.product_id, 'product_name', p.name,
                                          'serial', ps.serial, 'status', ps.status))
        from product_serials ps
        join products p on p.id = ps.product_id
       where ps.tenant_id = v_tenant and upper(btrim(ps.serial)) = v_s and ps.status = 'in_stock'), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(to_jsonb(cl) order by cl.created_at desc)
        from serial_warranty_claims cl
       where cl.tenant_id = v_tenant and upper(cl.serial) = v_s), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function serial_lookup(text) from public, anon;
grant execute on function serial_lookup(text) to authenticated;
