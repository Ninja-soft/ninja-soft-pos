-- =============================================================================
-- SEC-43 (ADR-187): clave de idempotencia en create_sale (deuda de ADR-098).
--
-- Si se corta la red DESPUÉS de que el servidor grabó la venta y ANTES de la
-- respuesta, el reintento del POS duplicaba la venta. Ahora el POS manda una
-- clave por cobro (p_client_request_id, uuid) y la reusa en los reintentos del
-- mismo cobro (online o guardado sin conexión): la segunda llamada devuelve la
-- venta ya grabada, sin volver a mover stock, caja, cupón, mesa ni nada. Si
-- la clave llega con otros datos (otro pago, otro carrito), falla con
-- sale_request_mismatch y el número de la venta ya registrada.
--
--   A) sales.client_request_id + índice único parcial por negocio y
--      sales.client_request_hash (huella de los datos del pedido).
--   B) Helpers internos (sin EXECUTE de clientes): _sale_request_replay
--      (lock por clave + búsqueda + control de huella), _sale_replay_result y
--      _sale_fulfilled_replay_result (rearman la respuesta desde las filas) y
--      _sale_request_plan_hash (huella de p_sale + p_plan de los wrappers).
--   C) create_sale: copia EXACTA de producción (pg_get_functiondef, igual a
--      20261219100100_precio_libre_editor_precios) con bloques marcados SEC-43
--      y un parámetro opcional más AL FINAL (p_client_request_id uuid default
--      null). Se borra la firma de 14 argumentos antes; los llamadores
--      internos (_channel_bill, _pc_complete, _pc_dry_run, exchange_sale) la
--      llaman con 14 argumentos y siguen resolviendo por el default.
--   D) pos_sale_create_fulfilled: copia EXACTA de producción (igual a
--      20261215100000_cobro_envio_costo); mira la clave ANTES de mover stock
--      entre sucursales.
--   E) pos_sale_create_delivery: copia EXACTA de producción (igual a
--      20261226100000_logistica_l1_direcciones); mira la clave ANTES de
--      guardar direcciones del cliente.
--   F) _offline_run_sale: copia EXACTA de producción (igual a
--      20261103200000_venta_offline); pasa la clave del payload offline
--      (client_request_id) a create_sale. Si la venta online ya había entrado,
--      la sincronización la reconoce y no duplica.
--
-- Carrera: dos envíos simultáneos con la misma clave se serializan con un
-- advisory lock por (negocio, clave) tomado antes de cualquier lock de fila o
-- efecto; el segundo encuentra la venta del primero y la devuelve. Además el
-- insert de la venta (lo primero que escribe create_sale) usa el índice único
-- como árbitro (on conflict do nothing): no hay efectos previos que deshacer.
-- Sin clave, todo es exactamente como antes. La clave es opcional: la API y
-- los clientes viejos no cambian.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Columnas e índice
-- -----------------------------------------------------------------------------
alter table public.sales add column if not exists client_request_id uuid;
alter table public.sales add column if not exists client_request_hash text;

comment on column public.sales.client_request_id is
  'SEC-43 (ADR-187): clave de idempotencia del cobro que mandó el POS. Única por negocio; el reintento con la misma clave devuelve esta venta.';
comment on column public.sales.client_request_hash is
  'SEC-43 (ADR-187): md5 del jsonb canónico de los datos del pedido (ítems, pagos, descuentos, promo, cupón, extras, cliente, origen o reparto). Un reintento con la misma clave y otra huella falla con sale_request_mismatch.';

create unique index if not exists sales_client_request_uniq
  on public.sales (tenant_id, client_request_id)
  where client_request_id is not null;

-- -----------------------------------------------------------------------------
-- B) Helpers internos
-- -----------------------------------------------------------------------------
-- Lock por (negocio, clave) y venta ya grabada con esa clave (null si no hay).
-- Con la misma clave y otra huella: sale_request_mismatch con el número de la
-- venta registrada (en el mensaje y en el detalle). Una venta sin huella
-- guardada no se compara.
create or replace function public._sale_request_replay(p_tenant uuid, p_req uuid, p_hash text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id     uuid;
  v_number bigint;
  v_hash   text;
begin
  if p_req is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtext('sale_request:' || p_tenant::text || ':' || p_req::text));
  select s.id, s.number, s.client_request_hash into v_id, v_number, v_hash
    from sales s
   where s.tenant_id = p_tenant and s.client_request_id = p_req;
  if v_id is not null and p_hash is not null and v_hash is not null and v_hash <> p_hash then
    raise exception 'sale_request_mismatch: %', v_number
      using detail = jsonb_build_object('sale_id', v_id, 'number', v_number)::text;
  end if;
  return v_id;
end;
$$;
revoke all on function public._sale_request_replay(uuid, uuid, text) from public, anon, authenticated;

-- Huella de los wrappers con reparto: p_sale tal como llegó (sin la clave ni
-- lo que no define la venta: turno, notas, nombre de la promo, servicio) y el
-- plan de entregas que mandó el POS.
create or replace function public._sale_request_plan_hash(p_sale jsonb, p_plan jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select md5(jsonb_build_object(
           'sale', p_sale - 'p_client_request_id' - 'client_request_id' - 'p_cash_shift_id'
                          - 'p_notes' - 'p_promo_name' - 'p_service',
           'plan', coalesce(p_plan, 'null'::jsonb))::text);
$$;
revoke all on function public._sale_request_plan_hash(jsonb, jsonb) from public, anon, authenticated;

-- Mismas claves que el return de create_sale, más 'replayed': true.
-- offline_conflicts es null (sólo existe en la venta offline nueva). service
-- se rearma igual que _sale_apply_service lo devuelve: renglones de servicio
-- o con nota y, con servicios, el período y el vencimiento de la venta.
create or replace function public._sale_replay_result(p_tenant uuid, p_sale uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'sale_id', s.id, 'number', s.number, 'total', s.total,
           'tip', s.tip_amount, 'promo_discount', s.promo_discount,
           'promotions', coalesce((select jsonb_agg(jsonb_build_object(
               'id', sp.promotion_id, 'label', sp.label, 'kind', sp.kind, 'discount', sp.discount)
               order by sp.kind desc, sp.created_at)
             from sale_promotions sp where sp.sale_id = s.id), '[]'::jsonb),
           'coupon_discount', s.coupon_discount,
           'service', case
                        when s.service_from is not null then
                          jsonb_build_object('lines', l.n, 'service_from', s.service_from,
                                             'service_to', s.service_to, 'payment_due', s.payment_due)
                        when l.n > 0 then jsonb_build_object('lines', l.n)
                      end,
           'perception_total', s.perception_total, 'cbte_letter', s.cbte_letter,
           'offline_conflicts', null,
           'reserve_taken', coalesce((select a.after_data -> 'items' from audit_logs a
                                       where a.tenant_id = p_tenant and a.entity_type = 'sales'
                                         and a.entity_id = s.id and a.action = 'sale_from_reserve'
                                       limit 1), '[]'::jsonb),
           'deposit_applied', coalesce((select (a.after_data ->> 'deposit_applied')::numeric
                                          from appointments ap
                                          join audit_logs a on a.tenant_id = p_tenant
                                                           and a.entity_type = 'appointments'
                                                           and a.entity_id = ap.id
                                                           and a.action = 'appointment_charged'
                                         where ap.sale_id = s.id and ap.tenant_id = p_tenant
                                         limit 1), 0),
           'replayed', true)
    from sales s
    cross join lateral (
      select count(*)::int as n
        from sale_items si
       where si.sale_id = s.id and si.tenant_id = p_tenant
         and (si.line_note is not null or si.unit_label is not null)
    ) l
   where s.id = p_sale and s.tenant_id = p_tenant;
$$;
revoke all on function public._sale_replay_result(uuid, uuid) from public, anon, authenticated;

-- Lo mismo para pos_sale_create_fulfilled / _delivery: la venta y sus
-- entregas. El código de retiro no se puede volver a mostrar (sólo se guarda
-- su hash): pickup_code null y has_pickup_code dice si la entrega lo pide.
create or replace function public._sale_fulfilled_replay_result(p_tenant uuid, p_sale uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select _sale_replay_result(p_tenant, p_sale) || jsonb_build_object(
           'deliveries', coalesce((select jsonb_agg(jsonb_build_object(
               'id', d.id, 'number', d.number, 'part', d.part,
               'mode', case d.delivery_type when 'inmediato' then 'ahora' else d.delivery_type end,
               'origin_store_id', d.store_id, 'fulfillment_store_id', d.fulfillment_store_id,
               'pickup_code', null, 'has_pickup_code', d.pickup_code_hash is not null) order by d.part)
             from dispatches d where d.sale_id = p_sale and d.tenant_id = p_tenant), '[]'::jsonb),
           'fulfillment_id', (select d.fulfillment_id from dispatches d
                               where d.sale_id = p_sale and d.tenant_id = p_tenant
                               order by d.part limit 1));
$$;
revoke all on function public._sale_fulfilled_replay_result(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) create_sale (copia de producción + bloques SEC-43)
-- -----------------------------------------------------------------------------
drop function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid, jsonb);

create or replace function public.create_sale(p_items jsonb, p_payments jsonb, p_discount_total numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_extras jsonb DEFAULT '[]'::jsonb, p_table_order_id uuid DEFAULT NULL::uuid, p_delivery_order_id uuid DEFAULT NULL::uuid, p_promo_discount numeric DEFAULT 0, p_promo_id uuid DEFAULT NULL::uuid, p_promo_name text DEFAULT NULL::text, p_coupon_id uuid DEFAULT NULL::uuid, p_cash_shift_id uuid DEFAULT NULL::uuid, p_service jsonb DEFAULT NULL::jsonb, p_client_request_id uuid DEFAULT NULL::uuid)
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
  v_service     jsonb;  -- ADR-116: datos de servicio de la venta.
  -- ADR-151 >>>
  -- Precio a definir al cobrar: rango del producto y renglones cobrados así.
  v_or          record;
  v_obase       numeric;
  v_open_lines  jsonb := '[]'::jsonb;
  -- <<< ADR-151
  v_wl_plan     uuid;
  v_wl_months   int;
  v_wl_for      int;
  -- <<< ADR-096
  -- SEC-43 >>>
  -- Clave de idempotencia del cobro (ADR-187): venta ya grabada y huella del pedido.
  v_replay      uuid;
  v_req_hash    text;
  -- <<< SEC-43
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  perform assert_account_active(v_tenant);

  -- SEC-43 >>>
  -- Clave de idempotencia (ADR-187). El POS manda la misma clave en los
  -- reintentos del mismo cobro. Si la venta de este negocio con esa clave ya
  -- está grabada, se devuelve tal cual, sin tocar stock, caja ni nada más; con
  -- otra huella (otro carrito, otro pago) falla con sale_request_mismatch.
  -- _sale_request_replay toma un lock por (negocio, clave) ANTES de cualquier
  -- lock de fila o efecto: un envío simultáneo espera al primero y, si el
  -- primero confirmó, lee su venta (read committed: snapshot nuevo por sentencia).
  -- Los wrappers con reparto dejan su propia huella (p_sale + plan) en
  -- ninja.sale_request_hash; si no, es la de los argumentos de esta función
  -- (sin turno, notas, nombre de la promo ni servicio).
  if p_client_request_id is not null then
    v_req_hash := coalesce(nullif(current_setting('ninja.sale_request_hash', true), ''),
                           md5(jsonb_build_object(
                             'items', coalesce(p_items, '[]'::jsonb),
                             'payments', coalesce(p_payments, '[]'::jsonb),
                             'discount_total', coalesce(p_discount_total, 0),
                             'customer_id', p_customer_id,
                             'extras', coalesce(p_extras, '[]'::jsonb),
                             'table_order_id', p_table_order_id,
                             'delivery_order_id', p_delivery_order_id,
                             'promo_discount', coalesce(p_promo_discount, 0),
                             'promo_id', p_promo_id,
                             'coupon_id', p_coupon_id)::text));
    v_replay := _sale_request_replay(v_tenant, p_client_request_id, v_req_hash);
    if v_replay is not null then
      return _sale_replay_result(v_tenant, v_replay);
    end if;
  end if;
  -- <<< SEC-43

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
      -- ADR-151 >>>
      -- Precio libre: lo marca el producto (products.price_mode), nunca el POS.
      -- Vale el precio informado dentro del mínimo y el máximo; el de lista
      -- queda como sugerido en la auditoría. Regalos y packs siguen su camino.
      if nullif(v_j ->> 'gift_promo_id', '') is null and nullif(v_j ->> 'pack_credit_id', '') is null then
        select * into v_or from _open_price_range(v_tenant, v_pid);
        if v_or.o_open then
          v_obase := round(v_up - _sale_modifier_delta(v_tenant, v_pid, v_j -> 'modifiers'), 2);
          if not _open_price_ok(v_obase, v_or.o_min, v_or.o_max) then
            if v_offline then
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'open_price_out_of_range', 'product_id', v_pid, 'variant_id', v_vid,
                'min', v_or.o_min, 'max', v_or.o_max, 'received', v_obase));
            else
              raise exception using message = 'open_price_out_of_range:' || jsonb_build_object(
                'product_id', v_pid, 'variant_id', v_vid, 'min', v_or.o_min, 'max', v_or.o_max,
                'received', v_obase)::text, errcode = 'P0001';
            end if;
          end if;
          v_open_lines := v_open_lines || jsonb_build_array(jsonb_build_object(
            'index', v_i, 'product_id', v_pid, 'variant_id', v_vid, 'quantity', v_qty,
            'price', v_up, 'suggested', v_exp));
          v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', v_up, 'reason', null));
          continue;
        end if;
      end if;
      -- <<< ADR-151
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
                     iva_total, internal_tax_total, perception_total,
                     client_request_id, client_request_hash)  -- SEC-43
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
          coalesce((v_tax ->> 'internal_total')::numeric, 0), v_perc,
          p_client_request_id, v_req_hash)  -- SEC-43
  -- SEC-43 >>>
  -- Carrera que el lock de arriba no cubre (otro camino que grabe la clave):
  -- el índice sales_client_request_uniq decide. Sólo ese índice es árbitro;
  -- cualquier otra violación de unicidad sigue siendo error. Hasta acá no
  -- hubo stock, caja, cupón ni otros efectos de la venta que deshacer.
  on conflict (tenant_id, client_request_id) where client_request_id is not null do nothing
  -- <<< SEC-43
  returning id into v_sale_id;
  -- SEC-43 >>>
  if v_sale_id is null then
    v_replay := _sale_request_replay(v_tenant, p_client_request_id, v_req_hash);
    if v_replay is null then
      raise exception 'sale_request_conflict';
    end if;
    return _sale_replay_result(v_tenant, v_replay);
  end if;
  -- <<< SEC-43

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

  -- ADR-151 >>>
  -- Precio a definir al cobrar: qué se cobró y cuál era el sugerido.
  if jsonb_array_length(v_open_lines) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'sale_open_price',
            jsonb_build_object('sale_number', v_number, 'lines', v_open_lines));
  end if;
  -- <<< ADR-151

  -- ADR-116 >>>
  -- Servicios profesionales: descripción ampliada, aclaraciones y nota por
  -- renglón (mismo orden que p_items, por v_line_ids) y período del servicio
  -- y vencimiento del pago (concepto 2 o 3 de ARCA). Sin servicios ni notas
  -- no toca nada. Fecha de la venta en hora de Argentina (offline: la real).
  v_service := _sale_apply_service(v_tenant, v_sale_id, p_items, v_line_ids, p_service, v_now_ar::date);
  -- <<< ADR-116

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount, 'promo_discount', v_promo_disc,
                            'promotions', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', sp.promotion_id, 'label', sp.label, 'kind', sp.kind, 'discount', sp.discount)
                                order by sp.kind desc, sp.created_at)
                              from sale_promotions sp where sp.sale_id = v_sale_id), '[]'::jsonb),
                            'coupon_discount', v_coupon_disc,
                            'service', v_service,  -- ADR-116
                            'perception_total', v_perc, 'cbte_letter', v_tax ->> 'letter',
                            -- ADR-077: diferencias de la venta offline (null fuera de ese modo).
                            'offline_conflicts', case when v_offline then v_off_conf else null end,
                            -- ADR-088: aviso de lo que salió de la reserva y seña aplicada.
                            'reserve_taken', v_res_taken,
                            'deposit_applied', v_sena_exp);
end;
$function$;

-- Mismos grants que producción: authenticated y service_role (los llamadores
-- internos), nunca anon.
revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid, jsonb, uuid) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid, jsonb, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- D) pos_sale_create_fulfilled (copia de producción + bloques SEC-43)
-- -----------------------------------------------------------------------------
create or replace function public.pos_sale_create_fulfilled(p_sale jsonb, p_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_role     text := stock_my_role();
  v_shift    uuid;
  v_store    uuid;
  v_cfg      jsonb;
  v_dels     jsonb := coalesce(p_plan -> 'deliveries', '[]'::jsonb);
  v_d        jsonb;
  v_i        jsonb;
  v_n        int;
  v_idx      int;
  v_mode     text;
  v_origin   uuid;
  v_ful      uuid;
  v_src      uuid;
  v_vid      uuid;
  v_vlabel   text;
  v_vsku     text;
  v_wh       warehouses;
  v_whid     uuid;
  v_prod     record;
  v_qty      numeric;
  v_avail    numeric;
  v_ref      uuid := gen_random_uuid();
  v_sold     jsonb;
  v_rows     jsonb := '[]'::jsonb;
  v_drows    jsonb;
  v_res      jsonb;
  v_sale     uuid;
  v_sale_no  bigint;
  v_cname    text;
  v_pickup   text;
  v_addr     text;
  v_disp     uuid;
  v_number   int;
  v_code     text;
  v_out      jsonb := '[]'::jsonb;
  v_cross    jsonb := '[]'::jsonb;
  v_local    jsonb := '[]'::jsonb;
  v_parts    int;
  v_part     int := 0;
  v_now_idx  int;
  r          record;
  -- ADR-146: costo de envío como renglón "Envío" de la venta.
  v_fee      numeric := 0;
  v_items    jsonb;
  v_extras   jsonb;
  -- SEC-43 >>>
  v_req      uuid;
  v_req_hash text;
  v_replay   uuid;
  -- <<< SEC-43
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'entregas_remitos') then
    raise exception 'feature_not_in_plan: entregas_remitos' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_sale) is distinct from 'object' or jsonb_typeof(v_dels) is distinct from 'array' then
    raise exception 'invalid_plan';
  end if;
  v_n := jsonb_array_length(v_dels);
  if v_n < 1 or v_n > 10 then
    raise exception 'invalid_plan';
  end if;
  -- ADR-146: costo de envío opcional. Sólo con una entrega por envío; el
  -- renglón lo arma el servidor (el POS no lo manda como ítem).
  if nullif(btrim(coalesce(p_plan ->> 'shipping_fee', '')), '') is not null then
    begin
      v_fee := round((p_plan ->> 'shipping_fee')::numeric, 2);
    exception when others then
      raise exception 'invalid_shipping_fee';
    end;
    if v_fee is null or v_fee < 0 or v_fee > 100000000 then
      raise exception 'invalid_shipping_fee';
    end if;
    if v_fee > 0 and not exists (
      select 1 from jsonb_array_elements(v_dels) d where d ->> 'mode' = 'envio'
    ) then
      raise exception 'shipping_fee_requires_envio';
    end if;
  end if;
  if nullif(p_sale ->> 'p_table_order_id', '') is not null or nullif(p_sale ->> 'p_delivery_order_id', '') is not null
     or exists (select 1 from jsonb_array_elements(coalesce(p_sale -> 'p_extras', '[]'::jsonb)) e
                 where lower(coalesce(e ->> 'kind', '')) = 'reservation') then
    raise exception 'fulfillment_not_for_orders';
  end if;

  -- SEC-43 >>>
  -- Clave de idempotencia del cobro (ADR-187), la misma que create_sale.
  -- Se mira ANTES de mover stock entre sucursales: el reintento de una venta
  -- ya grabada devuelve la venta y sus entregas, sin efectos. La huella es
  -- la del pedido que mandó el POS (p_sale + plan), o la que dejó
  -- pos_sale_create_delivery; create_sale la guarda en la venta.
  begin
    v_req := nullif(coalesce(p_sale ->> 'p_client_request_id', p_sale ->> 'client_request_id'), '')::uuid;
  exception when others then
    raise exception 'invalid_client_request_id';
  end;
  if v_req is not null then
    v_req_hash := coalesce(nullif(current_setting('ninja.sale_request_hash', true), ''),
                           _sale_request_plan_hash(p_sale, p_plan));
    perform set_config('ninja.sale_request_hash', v_req_hash, true);
    v_replay := _sale_request_replay(v_tenant, v_req, v_req_hash);
    if v_replay is not null then
      return _sale_fulfilled_replay_result(v_tenant, v_replay);
    end if;
  end if;
  -- <<< SEC-43

  select r2.o_shift_id, r2.o_store_id into v_shift, v_store
    from resolve_sale_shift(nullif(p_sale ->> 'p_cash_shift_id', '')::uuid, true) r2;
  if v_store is null then
    raise exception 'no_open_shift';
  end if;
  v_cfg := pos_order_config(v_tenant);

  -- Lo vendido por producto y variante (sin servicios ni ítems libres).
  select coalesce(jsonb_agg(jsonb_build_object('product_id', s.product_id, 'variant_id', s.variant_id, 'qty', s.qty)), '[]'::jsonb)
    into v_sold
    from (
      select x.product_id, x.variant_id, sum(x.quantity) as qty
        from jsonb_to_recordset(coalesce(p_sale -> 'p_items', '[]'::jsonb)) as x(product_id uuid, variant_id uuid, quantity numeric)
        join products p on p.id = x.product_id and p.tenant_id = v_tenant and p.deleted_at is null
       where x.product_id is not null and not coalesce(p.is_service, false) and coalesce(x.quantity, 0) > 0
       group by x.product_id, x.variant_id
    ) s;

  -- Validación del plan.
  for v_idx in 0 .. v_n - 1 loop
    v_d := v_dels -> v_idx;
    v_mode := v_d ->> 'mode';
    if v_mode is null or v_mode not in ('ahora', 'retiro', 'envio') then
      raise exception 'invalid_delivery_mode';
    end if;
    if jsonb_typeof(v_d -> 'items') is distinct from 'array' or jsonb_array_length(v_d -> 'items') = 0 then
      raise exception 'delivery_empty';
    end if;
    v_origin := null;
    v_drows := '[]'::jsonb;
    for v_i in select * from jsonb_array_elements(v_d -> 'items') loop
      v_qty := nullif(v_i ->> 'qty', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'invalid_qty';
      end if;
      v_vid := nullif(v_i ->> 'variant_id', '')::uuid;
      select p.id, p.name, p.sku, coalesce(p.unit, 'un') as unit, coalesce(p.is_kit, false) as is_kit,
             coalesce(p.track_stock, true) as track, coalesce(p.is_service, false) as is_service,
             coalesce(p.has_variants, false) as has_variants
        into v_prod
        from products p
       where p.id = nullif(v_i ->> 'product_id', '')::uuid and p.tenant_id = v_tenant and p.deleted_at is null;
      if v_prod.id is null or v_prod.is_service or not exists (
        select 1 from jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid)
         where s.product_id = v_prod.id and s.variant_id is not distinct from v_vid
      ) then
        raise exception 'delivery_item_not_in_sale';
      end if;
      if v_prod.has_variants and v_vid is null then
        raise exception 'variant_required';
      end if;
      v_src := coalesce(nullif(v_i ->> 'source_store_id', '')::uuid, v_store);
      if v_origin is null then
        v_origin := v_src;
      elsif v_origin <> v_src then
        raise exception 'delivery_mixed_origin';
      end if;

      v_whid := null;
      if nullif(v_i ->> 'source_warehouse_id', '') is not null then
        select * into v_wh from warehouses w
         where w.id = (v_i ->> 'source_warehouse_id')::uuid and w.tenant_id = v_tenant and w.deleted_at is null;
        if v_wh.id is null or v_wh.store_id <> v_src then
          raise exception 'source_not_available';
        end if;
        if not v_wh.sellable then
          raise exception 'source_not_sellable';
        end if;
        -- El salón propio no se mueve: lo descuenta create_sale.
        if not (v_wh.kind = 'principal' and v_src = v_store) then
          v_whid := v_wh.id;
        end if;
      end if;

      if v_src <> v_store then
        if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
          raise exception 'feature_not_in_plan: stock_sucursales' using errcode = 'check_violation';
        end if;
        if not tenant_has_feature_for(v_tenant, 'depositos') then
          raise exception 'feature_not_in_plan: depositos' using errcode = 'check_violation';
        end if;
        if v_prod.is_kit or not v_prod.track then
          raise exception 'kit_cross_store';
        end if;
        if v_whid is null then
          select w.id into v_whid from warehouses w
           where w.store_id = v_src and w.kind = 'principal' and w.deleted_at is null;
        end if;
        if v_whid is null or not exists (
          select 1 from warehouse_store_links l
           where l.warehouse_id = v_whid and l.store_id = v_store and l.deleted_at is null
        ) or not exists (select 1 from warehouses w where w.id = v_whid and w.sellable) then
          raise exception 'source_not_available';
        end if;
      elsif v_whid is not null then
        if not tenant_has_feature_for(v_tenant, 'depositos') then
          raise exception 'feature_not_in_plan: depositos' using errcode = 'check_violation';
        end if;
        if v_prod.is_kit or not v_prod.track then
          raise exception 'kit_cross_store';
        end if;
      end if;

      v_vlabel := null;
      v_vsku := null;
      if v_vid is not null then
        select v.option1 || coalesce(' / ' || v.option2, ''), v.sku into v_vlabel, v_vsku
          from product_variants v where v.id = v_vid and v.product_id = v_prod.id;
      end if;
      v_drows := v_drows || jsonb_build_array(jsonb_build_object(
        'd', v_idx, 'mode', v_mode, 'origin', v_src, 'product_id', v_prod.id, 'variant_id', v_vid,
        'qty', v_qty, 'src_store', v_src, 'src_wh', v_whid, 'name', v_prod.name,
        'variant_label', v_vlabel, 'sku', coalesce(v_vsku, v_prod.sku), 'unit', v_prod.unit));
    end loop;

    -- Modalidad y lugar de entrega.
    if v_mode = 'ahora' then
      if v_origin <> v_store then
        raise exception 'ahora_requires_local';
      end if;
      v_ful := v_store;
      v_now_idx := v_idx;
    else
      if not tenant_has_feature_for(v_tenant, 'pedidos_despacho') then
        raise exception 'feature_not_in_plan: pedidos_despacho' using errcode = 'check_violation';
      end if;
      if not coalesce((v_cfg -> 'delivery_types' -> v_mode ->> 'enabled')::boolean, false) then
        raise exception 'delivery_type_disabled: %', v_mode;
      end if;
      if v_mode = 'envio' then
        v_ful := v_origin;
        if char_length(btrim(coalesce(v_d ->> 'ship_address', ''))) < 5 then
          raise exception 'ship_address_required';
        end if;
      else
        v_ful := coalesce(nullif(v_d ->> 'fulfillment_store_id', '')::uuid, v_origin);
        if not exists (select 1 from stores s where s.id = v_ful and s.tenant_id = v_tenant and s.deleted_at is null) then
          raise exception 'store_not_found';
        end if;
        if v_ful <> v_origin and not coalesce((v_cfg -> 'delivery_types' -> 'retiro' ->> 'cross_branch')::boolean, false) then
          raise exception 'cross_branch_not_allowed: retiro';
        end if;
      end if;
    end if;
    v_rows := v_rows || (select jsonb_agg(x || jsonb_build_object('ful', v_ful)) from jsonb_array_elements(v_drows) x);
  end loop;

  -- La suma por producto no supera lo vendido.
  if exists (
    select 1
      from (select fp.product_id, fp.variant_id, sum(fp.qty) as q
              from jsonb_to_recordset(v_rows) as fp(product_id uuid, variant_id uuid, qty numeric)
             group by 1, 2) p
      left join jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid, qty numeric)
        on s.product_id = p.product_id and s.variant_id is not distinct from p.variant_id
     where p.q > coalesce(s.qty, 0)
  ) then
    raise exception 'delivery_qty_mismatch';
  end if;

  -- Lo no asignado: parte "retira ahora" desde la sucursal de la venta.
  select coalesce(jsonb_agg(jsonb_build_object(
           'mode', 'ahora', 'origin', v_store, 'ful', v_store, 'product_id', s.product_id, 'variant_id', s.variant_id,
           'qty', s.qty - coalesce(a.q, 0), 'src_store', v_store, 'src_wh', null, 'name', pr.name,
           'variant_label', v.option1 || coalesce(' / ' || v.option2, ''), 'sku', coalesce(v.sku, pr.sku),
           'unit', coalesce(pr.unit, 'un'))), '[]'::jsonb)
    into v_drows
    from jsonb_to_recordset(v_sold) as s(product_id uuid, variant_id uuid, qty numeric)
    join products pr on pr.id = s.product_id
    left join product_variants v on v.id = s.variant_id
    left join (select fp.product_id, fp.variant_id, sum(fp.qty) as q
                 from jsonb_to_recordset(v_rows) as fp(product_id uuid, variant_id uuid, qty numeric)
                group by 1, 2) a on a.product_id = s.product_id and a.variant_id is not distinct from s.variant_id
   where s.qty > coalesce(a.q, 0);
  if jsonb_array_length(v_drows) > 0 then
    if v_now_idx is null then
      v_now_idx := v_n;
    end if;
    v_rows := v_rows || (select jsonb_agg(x || jsonb_build_object('d', v_now_idx)) from jsonb_array_elements(v_drows) x);
  end if;

  -- Mover el stock de los orígenes al salón de la sucursal de la venta. Orden
  -- fijo (sucursal, depósito, producto) para no cruzar locks con otra venta.
  for r in
    select fp.src_store, fp.src_wh, fp.product_id, fp.variant_id, sum(fp.qty) as qty, min(fp.name) as name
      from jsonb_to_recordset(v_rows) as fp(src_store uuid, src_wh uuid, product_id uuid, variant_id uuid, qty numeric, name text)
     where fp.src_store <> v_store or fp.src_wh is not null
     group by fp.src_store, fp.src_wh, fp.product_id, fp.variant_id
     order by fp.src_store, fp.src_wh nulls first, fp.product_id, fp.variant_id nulls first
  loop
    perform pg_advisory_xact_lock(hashtext('stock_reservation:' || r.src_store::text));
    if exists (select 1 from warehouses w where w.id = r.src_wh and w.kind <> 'principal') then
      select ws.qty into v_avail from warehouse_stock ws
       where ws.warehouse_id = r.src_wh and ws.product_id = r.product_id
         and ws.variant_id is not distinct from r.variant_id
       for update;
      if coalesce(v_avail, 0) < r.qty then
        raise exception 'insufficient_source_stock: %', r.name;
      end if;
      update warehouse_stock set qty = qty - r.qty
       where warehouse_id = r.src_wh and product_id = r.product_id and variant_id is not distinct from r.variant_id;
    else
      -- Salón de otra sucursal: sin lo reservado.
      perform 1 from product_stock ps
        where ps.store_id = r.src_store and ps.product_id = r.product_id and ps.variant_id is not distinct from r.variant_id
        for update;
      v_avail := warehouse_principal_qty(r.src_store, r.product_id, r.variant_id)
                 - stock_reserved_qty(r.src_store, r.product_id, r.variant_id, null);
      if v_avail < r.qty then
        raise exception 'insufficient_source_stock: %', r.name;
      end if;
    end if;
    if r.src_store <> v_store then
      perform transfer_move_stock(v_tenant, r.src_store, r.product_id, r.variant_id, -r.qty, 'transfer_out', v_ref,
                                  'Venta en otra sucursal (ADR-136)');
      perform transfer_move_stock(v_tenant, v_store, r.product_id, r.variant_id, r.qty, 'transfer_in', v_ref,
                                  'Venta de stock de otra sucursal (ADR-136)');
      v_cross := v_cross || jsonb_build_array(jsonb_build_object(
        'product_id', r.product_id, 'variant_id', r.variant_id, 'qty', r.qty,
        'store_id', r.src_store, 'warehouse_id', r.src_wh));
    else
      v_local := v_local || jsonb_build_array(jsonb_build_object(
        'product_id', r.product_id, 'variant_id', r.variant_id, 'qty', r.qty, 'warehouse_id', r.src_wh));
    end if;
  end loop;

  -- ADR-146: el envío entra como renglón sin producto al final. Para
  -- create_sale es un monto con explicación (recargo), no una venta libre:
  -- no pide el permiso de venta libre ni su tope.
  v_items  := coalesce(p_sale -> 'p_items', '[]'::jsonb);
  v_extras := coalesce(p_sale -> 'p_extras', '[]'::jsonb);
  if v_fee > 0 then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', null, 'name', 'Envío', 'quantity', 1, 'unit_price', v_fee, 'discount', 0));
    v_extras := v_extras || jsonb_build_array(jsonb_build_object('kind', 'surcharge', 'amount', v_fee));
  end if;

  -- La venta, igual que siempre.
  v_res := create_sale(
    p_items           => v_items,
    p_payments        => coalesce(p_sale -> 'p_payments', '[]'::jsonb),
    p_discount_total  => coalesce(nullif(p_sale ->> 'p_discount_total', '')::numeric, 0),
    p_customer_id     => nullif(p_sale ->> 'p_customer_id', '')::uuid,
    p_notes           => p_sale ->> 'p_notes',
    p_extras          => v_extras,
    p_promo_discount  => coalesce(nullif(p_sale ->> 'p_promo_discount', '')::numeric, 0),
    p_promo_id        => nullif(p_sale ->> 'p_promo_id', '')::uuid,
    p_promo_name      => p_sale ->> 'p_promo_name',
    p_coupon_id       => nullif(p_sale ->> 'p_coupon_id', '')::uuid,
    p_cash_shift_id   => v_shift,
    p_service         => case when jsonb_typeof(p_sale -> 'p_service') = 'object' then p_sale -> 'p_service' end,
    p_client_request_id => v_req  -- SEC-43
  );
  perform set_config('ninja.sale_request_hash', '', true);  -- SEC-43
  v_sale := (v_res ->> 'sale_id')::uuid;
  select s.number, c.name into v_sale_no, v_cname
    from sales s left join customers c on c.id = s.customer_id
   where s.id = v_sale;

  -- Una entrega por parte; la de "ahora" primero.
  select count(distinct fp.d) into v_parts from jsonb_to_recordset(v_rows) as fp(d int);
  for r in
    select fp.d, min(fp.mode) as mode, min(fp.origin::text)::uuid as origin, min(fp.ful::text)::uuid as ful
      from jsonb_to_recordset(v_rows) as fp(d int, mode text, origin uuid, ful uuid)
     group by fp.d
     order by (min(fp.mode) = 'ahora') desc, fp.d
  loop
    v_part := v_part + 1;
    v_d := case when r.d < jsonb_array_length(v_dels) then v_dels -> r.d else '{}'::jsonb end;
    v_pickup := left(nullif(btrim(coalesce(v_d ->> 'pickup_name', '')), ''), 120);
    v_addr := left(nullif(btrim(coalesce(v_d ->> 'ship_address', '')), ''), 300);
    if r.mode = 'retiro' then
      v_pickup := coalesce(v_pickup, v_cname);
      if v_pickup is null then
        raise exception 'pickup_name_required';
      end if;
    end if;
    perform pg_advisory_xact_lock(hashtext('dispatch_number:' || v_tenant::text));
    select coalesce(max(number), 0) + 1 into v_number from dispatches where tenant_id = v_tenant;
    insert into dispatches (
      tenant_id, number, sale_id, store_id, fulfillment_store_id, sale_store_id, delivery_type, status,
      customer_name, pickup_name, ship_address, notes, part, parts_total, fulfillment_id, created_by,
      delivered_by, delivered_at, delivered_to
    ) values (
      v_tenant, v_number, v_sale, r.origin, r.ful, v_store,
      case r.mode when 'ahora' then 'inmediato' else r.mode end,
      case when r.mode = 'ahora' then 'entregado' else 'pendiente' end,
      left(coalesce(v_cname, v_pickup), 120), v_pickup, case when r.mode = 'envio' then v_addr end,
      left(nullif(btrim(coalesce(v_d ->> 'notes', '')), ''), 500), v_part, v_parts, v_ref, auth.uid(),
      case when r.mode = 'ahora' then auth.uid() end,
      case when r.mode = 'ahora' then now() end,
      case when r.mode = 'ahora' then left(coalesce(v_cname, 'Cliente en el mostrador'), 120) end
    )
    returning id into v_disp;

    insert into dispatch_items (
      tenant_id, dispatch_id, sale_id, store_id, fulfillment_store_id, sale_store_id, product_id, variant_id,
      product_name, variant_label, sku, unit, qty, source_store_id, source_warehouse_id, sort
    )
    select v_tenant, v_disp, v_sale, r.origin, r.ful, v_store, fp.product_id, fp.variant_id,
           fp.name, fp.variant_label, fp.sku, fp.unit, sum(fp.qty), fp.src_store, fp.src_wh,
           (row_number() over (order by fp.name, fp.variant_label))::int
      from jsonb_to_recordset(v_rows) as fp(d int, product_id uuid, variant_id uuid, name text, variant_label text,
                                            sku text, unit text, qty numeric, src_store uuid, src_wh uuid)
     where fp.d = r.d
     group by fp.product_id, fp.variant_id, fp.name, fp.variant_label, fp.sku, fp.unit, fp.src_store, fp.src_wh;

    v_code := null;
    if r.mode = 'retiro' and coalesce((v_cfg -> 'delivery_types' -> 'retiro' ->> 'pickup_code')::boolean, false) then
      v_code := otp_random_digits(6);
      update dispatches set pickup_code_hash = stock_reservation_code_hash(v_disp, v_code) where id = v_disp;
    end if;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'dispatches', v_disp, 'dispatch_created',
            jsonb_build_object('number', v_number, 'sale_id', v_sale, 'delivery_type', r.mode,
                               'part', v_part, 'parts_total', v_parts, 'origin_store_id', r.origin,
                               'fulfillment_store_id', r.ful, 'fulfillment_id', v_ref),
            r.origin);

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_disp, 'number', v_number, 'part', v_part, 'mode', r.mode,
      'origin_store_id', r.origin, 'fulfillment_store_id', r.ful, 'pickup_code', v_code));
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_delivery_split',
          jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'parts', v_parts, 'shipping_fee', v_fee,
                             'deliveries', (select jsonb_agg(x - 'pickup_code') from jsonb_array_elements(v_out) x)),
          v_store);
  if jsonb_array_length(v_cross) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_cross_store',
            jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'lines', v_cross), v_store);
  end if;
  if jsonb_array_length(v_local) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale, 'sale_from_warehouse',
            jsonb_build_object('sale_number', v_sale_no, 'fulfillment_id', v_ref, 'lines', v_local), v_store);
  end if;

  return v_res || jsonb_build_object('deliveries', v_out, 'fulfillment_id', v_ref);
end;
$function$;

revoke all on function public.pos_sale_create_fulfilled(jsonb, jsonb) from public, anon;
grant execute on function public.pos_sale_create_fulfilled(jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- E) pos_sale_create_delivery (copia de producción + bloques SEC-43)
-- -----------------------------------------------------------------------------
create or replace function public.pos_sale_create_delivery(p_sale jsonb, p_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_customer uuid;
  v_dels     jsonb := coalesce(p_plan -> 'deliveries', '[]'::jsonb);
  v_plan     jsonb := p_plan;
  v_d        jsonb;
  v_idx      int;
  v_addr     customer_addresses;
  v_ship     jsonb;
  v_addr_id  uuid;
  v_envio    jsonb := '[]'::jsonb;
  v_res      jsonb;
  v_k        int := 0;
  v_e        jsonb;
  r          jsonb;
  -- SEC-43 >>>
  v_req      uuid;
  v_req_hash text;
  v_replay   uuid;
  -- <<< SEC-43
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if stock_my_role() is null or stock_my_role() = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_sale) is distinct from 'object' or jsonb_typeof(v_dels) is distinct from 'array'
     or jsonb_array_length(v_dels) > 10 then
    raise exception 'invalid_plan';
  end if;
  begin
    v_customer := nullif(p_sale ->> 'p_customer_id', '')::uuid;
  exception when others then
    raise exception 'customer_not_found';
  end;

  -- SEC-43 >>>
  -- Clave de idempotencia del cobro (ADR-187). Se mira ANTES de guardar
  -- direcciones en el cliente: el reintento de una venta ya grabada devuelve
  -- la venta y sus entregas sin escribir nada (ni direcciones, ni ship_to,
  -- ni auditoría). La huella (p_sale + plan tal como llegó) queda en
  -- ninja.sale_request_hash para pos_sale_create_fulfilled y create_sale.
  begin
    v_req := nullif(coalesce(p_sale ->> 'p_client_request_id', p_sale ->> 'client_request_id'), '')::uuid;
  exception when others then
    raise exception 'invalid_client_request_id';
  end;
  if v_req is not null then
    v_req_hash := _sale_request_plan_hash(p_sale, p_plan);
    perform set_config('ninja.sale_request_hash', v_req_hash, true);
    v_replay := _sale_request_replay(v_tenant, v_req, v_req_hash);
    if v_replay is not null then
      return _sale_fulfilled_replay_result(v_tenant, v_replay);
    end if;
  end if;
  -- <<< SEC-43

  for v_idx in 0 .. jsonb_array_length(v_dels) - 1 loop
    v_d := v_dels -> v_idx;
    if v_d ->> 'mode' is distinct from 'envio' then
      continue;
    end if;
    if v_customer is null then
      raise exception 'customer_required_for_shipping' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from customers c
                    where c.id = v_customer and c.tenant_id = v_tenant and c.deleted_at is null) then
      raise exception 'customer_not_found';
    end if;
    v_ship := null;
    v_addr_id := null;
    if nullif(v_d ->> 'address_id', '') is not null then
      if not tenant_has_feature_for(v_tenant, 'direcciones_geo') then
        raise exception 'feature_not_in_plan: direcciones_geo' using errcode = 'check_violation';
      end if;
      select * into v_addr from customer_addresses a
       where a.id = (v_d ->> 'address_id')::uuid and a.tenant_id = v_tenant
         and a.customer_id = v_customer and a.deleted_at is null;
      if v_addr.id is null then
        raise exception 'address_not_found';
      end if;
      v_addr_id := v_addr.id;
      v_ship := _customer_address_snapshot(v_addr);
    elsif jsonb_typeof(v_d -> 'ship_to') = 'object' then
      if not tenant_has_feature_for(v_tenant, 'direcciones_geo') then
        raise exception 'feature_not_in_plan: direcciones_geo' using errcode = 'check_violation';
      end if;
      v_ship := _ship_to_clean(v_d -> 'ship_to');
      if coalesce((v_d ->> 'save_to_customer')::boolean, false) then
        perform _customer_address_assert(v_tenant);
        v_addr := _customer_address_insert(v_tenant, v_customer, v_ship,
                                           coalesce((v_d ->> 'make_default')::boolean, false));
        v_addr_id := v_addr.id;
      end if;
    end if;
    -- El texto de la entrega sale de la dirección estructurada si no vino.
    if v_ship is not null and char_length(btrim(coalesce(v_d ->> 'ship_address', ''))) < 5 then
      v_plan := jsonb_set(v_plan, array['deliveries', v_idx::text, 'ship_address'], to_jsonb(_ship_to_text(v_ship)));
    end if;
    v_envio := v_envio || jsonb_build_array(jsonb_build_object('address_id', v_addr_id, 'ship_to', v_ship));
  end loop;

  v_res := pos_sale_create_fulfilled(p_sale, v_plan);

  -- pos_sale_create_fulfilled devuelve las entregas por envío en el orden del
  -- plan: la k-ésima es la k-ésima entrega por envío pedida.
  for r in select x from jsonb_array_elements(coalesce(v_res -> 'deliveries', '[]'::jsonb)) x loop
    if r ->> 'mode' is distinct from 'envio' then
      continue;
    end if;
    v_e := v_envio -> v_k;
    v_k := v_k + 1;
    if v_e is null or (v_e -> 'ship_to') is null or jsonb_typeof(v_e -> 'ship_to') = 'null' then
      continue;
    end if;
    update dispatches
       set address_id = nullif(v_e ->> 'address_id', '')::uuid, ship_to = v_e -> 'ship_to'
     where id = (r ->> 'id')::uuid and tenant_id = v_tenant;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'dispatches', (r ->> 'id')::uuid, 'dispatch_address_set',
            jsonb_build_object('address_id', v_e ->> 'address_id', 'text', _ship_to_text(v_e -> 'ship_to'),
                               'geo_quality', v_e -> 'ship_to' ->> 'geo_quality', 'sale_id', v_res ->> 'sale_id'));
  end loop;

  return v_res;
end;
$function$;

revoke all on function public.pos_sale_create_delivery(jsonb, jsonb) from public, anon;
grant execute on function public.pos_sale_create_delivery(jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- F) _offline_run_sale (copia de producción + bloques SEC-43)
-- -----------------------------------------------------------------------------
create or replace function public._offline_run_sale(p_payload jsonb, p_shift uuid, p_client_sale_id uuid, p_sold_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_res   jsonb;
  v_sale  uuid;
  v_err   text;
  v_state text;
  -- SEC-43 >>>
  v_req   uuid;
  -- <<< SEC-43
begin
  perform set_config('ninja.offline_sync', '1', true);
  perform set_config('ninja.offline_sold_at', coalesce(p_sold_at::text, ''), true);
  begin
    -- SEC-43 >>>
    -- La clave del cobro online que falló por un corte (ADR-187): si esa
    -- venta sí había entrado, create_sale la devuelve (replayed) y no duplica.
    v_req := nullif(p_payload ->> 'client_request_id', '')::uuid;
    -- <<< SEC-43
    v_res := create_sale(
      p_items             => coalesce(p_payload -> 'items', '[]'::jsonb),
      p_payments          => coalesce(p_payload -> 'payments', '[]'::jsonb),
      p_discount_total    => coalesce(_offline_num(p_payload ->> 'discount_total'), 0),
      p_customer_id       => nullif(p_payload ->> 'customer_id', '')::uuid,
      p_notes             => nullif(p_payload ->> 'notes', ''),
      p_extras            => coalesce(p_payload -> 'extras', '[]'::jsonb),
      p_table_order_id    => null,
      p_delivery_order_id => null,
      p_promo_discount    => coalesce(_offline_num(p_payload ->> 'promo_discount'), 0),
      p_promo_id          => nullif(p_payload ->> 'promo_id', '')::uuid,
      p_promo_name        => nullif(p_payload ->> 'promo_name', ''),
      p_coupon_id         => null,
      p_cash_shift_id     => p_shift,
      p_client_request_id => v_req);  -- SEC-43
    v_sale := (v_res ->> 'sale_id')::uuid;
    -- SEC-43 >>>
    -- Una venta online ya grabada (replay) no se marca como offline.
    if not coalesce((v_res ->> 'replayed')::boolean, false) then
    -- <<< SEC-43
    update sales
       set offline_sold_at = p_sold_at, offline_client_id = p_client_sale_id
     where id = v_sale and tenant_id = current_tenant_id();
    end if;  -- SEC-43
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    v_err := sqlerrm;
  end;
  perform set_config('ninja.offline_sync', '', true);
  perform set_config('ninja.offline_sold_at', '', true);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', left(v_err, 500), 'sqlstate', v_state);
  end if;
  return jsonb_build_object('ok', true, 'result', v_res);
end;
$function$;

revoke all on function public._offline_run_sale(jsonb, uuid, uuid, timestamptz) from public, anon, authenticated;
