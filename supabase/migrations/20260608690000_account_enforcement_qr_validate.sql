-- =============================================================================
-- 20260608690000_account_enforcement_qr_validate
--   FIX de cobros críticos (server-side):
--
--   BUG A — Acceso NO atado al pago en el SERVER.
--     La suspensión/cancelación/trial-vencido sólo se aplicaba en React
--     (AppShell · SuspendedGate). create_sale / open_cash_shift / devoluciones
--     NUNCA chequeaban tenants.status → un miembro activo de un tenant bloqueado
--     vendía por RPC directa. Se agrega assert_account_active(p_tenant) y se
--     llama al inicio de las RPC que permiten OPERAR.
--
--     Política (espejo del contrato del dunning, ver 20260608350000):
--       active     → OPERA.
--       trial      → OPERA mientras trial_ends_at >= now() (o sin fecha).
--       past_due   → OPERA (en gracia de 3 días; bloquear acá sería un 🔴 inverso
--                    a quien está pagando / en gracia).
--       suspended  → BLOQUEA (pasó la gracia sin pagar).
--       cancelled  → BLOQUEA (trial vencido sin conversión / baja).
--     Sólo se bloquean estados claramente NO-pagos. subscription_blocked() cubre
--     únicamente 'suspended' (y lee subscriptions, no tenants), por lo que NO
--     alcanza para cancelled/trial-vencido → implementamos el chequeo conservador
--     directamente sobre tenants.status (fuente role-agnóstica, la misma que lee
--     accountStatus.ts en el front).
--
--   BUG B — Monto QR client-controlled + idempotencia QR inerte.
--     create_sale ya resolvía el intent y anclaba sale_id, pero NO exigía
--     intent.status='approved' ni comparaba el monto de las líneas qr contra
--     intent.amount → un cliente podía mandar un reference de un intent pending o
--     con un monto inflado. Se agrega: por cada intent resuelto, exigir
--     status='approved' (qr_not_approved) y intent.amount >= suma de las líneas
--     qr que apuntan a ese intent, con tolerancia de centavos (qr_amount_mismatch).
--     Se mantiene la idempotencia existente (sale_id ya seteado / reference ya
--     anclada → qr_already_charged) y el anclaje de sale_id al crear la venta.
--     Red de seguridad: índice UNIQUE parcial sobre payments(tenant_id, reference)
--     para qr → dos ventas no pueden anclar el mismo intent ni por carrera.
--
--   El front (QrCheckoutModal + pos/page.tsx) ahora pasa SIEMPRE el intent id
--   (uuid) como reference de la línea qr (antes pasaba el mp_payment_id numérico,
--   que NUNCA matcheaba el regex uuid → la validación quedaba inerte).
--
--   ⚠ create_sale / open_cash_shift / return_sale / return_sale_v2 se reproducen
--   COMPLETAS (preservando mesa atómica, idempotencia QR, extras tip/professional/
--   warranty/pack/modifiers, redondeo, descuento de stock y gating). El ÚNICO
--   cambio en cada una es agregar el chequeo de cuenta (y, en create_sale, la
--   validación de estado/monto del intent qr).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Guard de cuenta: lanza 'account_inactive' si el tenant está bloqueado por
--    falta de pago. Conservador: SOLO suspended / cancelled / trial vencido.
--    NO bloquea active ni past_due (gracia). NULL → no bloquea (sin tenant
--    resuelto cada RPC ya lanza 'no_tenant' por su cuenta).
-- -----------------------------------------------------------------------------
create or replace function assert_account_active(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_trial_ends timestamptz;
begin
  if p_tenant is null then
    return;
  end if;

  select t.status, t.trial_ends_at
    into v_status, v_trial_ends
  from tenants t
  where t.id = p_tenant;

  if not found then
    return;
  end if;

  -- Estados claramente NO-pagos: bloqueo. (active / past_due NO entran acá.)
  if v_status in ('suspended', 'cancelled')
     or (v_status = 'trial'
         and v_trial_ends is not null
         and v_trial_ends < now()) then
    raise exception 'account_inactive' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function assert_account_active(uuid) from public, anon;
grant execute on function assert_account_active(uuid) to authenticated;

comment on function assert_account_active(uuid) is
  'Lanza account_inactive si el tenant está bloqueado por falta de pago '
  '(suspended / cancelled / trial vencido). active y past_due (gracia) NO se '
  'bloquean. Se llama al inicio de create_sale, open_cash_shift y las RPC de '
  'devolución que permiten operar.';

-- -----------------------------------------------------------------------------
-- 2) open_cash_shift: guard de cuenta antes de abrir caja.
-- -----------------------------------------------------------------------------
create or replace function open_cash_shift(
  p_register_id uuid,
  p_opening_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_shift_id uuid;
begin
  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);

  if exists (
    select 1 from cash_shifts
    where cash_register_id = p_register_id
      and tenant_id = v_tenant
      and status = 'open'
  ) then
    raise exception 'shift_already_open';
  end if;

  insert into cash_shifts (cash_register_id, opening_amount, status)
  values (p_register_id, p_opening_amount, 'open')
  returning id into v_shift_id;

  return v_shift_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3) create_sale: guard de cuenta + validación de estado/monto del intent QR.
--    (Reproducida completa; preserva mesa atómica, extras, redondeo, stock y
--    gating. Cambios marcados con BUG A / BUG B.)
-- -----------------------------------------------------------------------------
create or replace function create_sale(
  p_items jsonb,
  p_payments jsonb,
  p_discount_total numeric default 0,
  p_customer_id uuid default null,
  p_notes text default null,
  p_extras jsonb default '[]'::jsonb,
  p_table_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  -- BUG 1 — cobro de mesa atómico
  v_table_order table_orders%rowtype;
  -- BUG 3 — idempotencia QR por intent
  v_intent   record;
  v_qr_ref   uuid;
  -- BUG B — monto qr por intent (suma de las líneas qr que apuntan al intent)
  v_qr_sum   numeric;
  -- BUG 7 — gating de qr sin intent (proveedor QR cualquiera)
  v_qr_plain boolean := false;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);

  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
  end if;

  -- BUG 1 — Cobro de mesa atómico: tomar el pedido FOR UPDATE y validar ANTES de
  -- crear nada. Dos pestañas concurrentes con la misma mesa: la 2ª espera el lock
  -- y luego ve sale_id/status ya cambiados → 'table_order_not_open'. La mesa se
  -- libera al final, en la misma transacción (sin close_dining_table aparte).
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

  select id into v_store
  from stores
  where tenant_id = v_tenant and deleted_at is null
  order by is_default desc, created_at
  limit 1;
  if v_store is null then
    raise exception 'no_store';
  end if;

  select cs.id into v_shift
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
  order by cs.opened_at desc
  limit 1;
  if v_shift is null then
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;

  select coalesce((ps.max_discount ->> coalesce(v_role, 'cashier'))::numeric, 100),
         coalesce(ps.rounding_multiple, 0),
         coalesce(ps.allow_negative_stock, true)
    into v_max_disc, v_round, v_allow_neg
  from pos_settings ps
  where ps.tenant_id = v_tenant;
  if not found then
    v_max_disc := 100; v_round := 0; v_allow_neg := true;
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

  -- BUG 22 — profesional determinístico: order by estable (e.id), sin depender
  -- del orden de jsonb_to_recordset. Un solo profesional atribuible por venta.
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

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0);

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
    if v_pay.method = 'store_credit' then
      v_sc_total := v_sc_total + coalesce(v_pay.amount, 0);
    end if;
  end loop;
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

  -- ── Gating / idempotencia / validación de pagos QR (BUG 3 + BUG 7 + BUG B) ──
  -- Se evalúa ANTES de crear la venta para no insertar nada si se rechaza.
  -- Por cada pago method='qr':
  --   * Con reference de intent válido (uuid que matchea mp_payment_intents):
  --       - el intent debe ser del tenant, estar 'approved' (BUG B) y no haber
  --         cobrado ya (sale_id null / reference no anclada → idempotencia BUG 3).
  --       - intent.amount debe cubrir la suma de las líneas qr que lo referencian
  --         (BUG B: el monto no es client-controlled; tolerancia de centavos).
  --       - además se gatea por la feature del proveedor del intent.
  --   * Sin reference de intent válido (p. ej. línea qr de "dividir cuenta"):
  --       - se gatea contra CUALQUIER feature de proveedor QR del plan; sin
  --         ninguna activa → 'qr_not_allowed'.
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
        -- BUG B — el intent debe estar acreditado: un reference de un intent
        -- pending/rejected no registra un cobro como pagado.
        if v_intent.status <> 'approved' then
          raise exception 'qr_not_approved';
        end if;
        -- BUG 3 — idempotencia: el intent ya cobró (sale_id seteado) o su
        -- reference ya está anclada a un payment qr de otra venta del tenant.
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
        -- BUG B — el monto cobrado no lo decide el cliente: el intent acreditado
        -- debe cubrir la suma de TODAS las líneas qr que apuntan a este intent
        -- (tolerancia de 1 centavo por redondeos).
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
        -- Gating por proveedor del intent (igual que antes).
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
        -- BUG 7 — qr sin intent (split / terminal): gatear contra cualquier
        -- proveedor QR del plan. Se marca para evaluar una sola vez abajo.
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

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end)
  returning id into v_sale_id;

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
        v_pname := v_pname || ' — ' || v_variant.option1
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

    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb));

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
              raise exception 'insufficient_stock';
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            insert into stock_movements (product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            insert into product_serials (product_id, serial, status, sale_id)
            values (v_item.product_id, v_serial, 'sold', v_sale_id)
            on conflict (product_id, serial) do update
              set status = 'sold', sale_id = v_sale_id;
          end if;
        end if;
      end if;
    end if;
  end loop;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    -- El gating/idempotencia/validación de qr ya se resolvió arriba (antes del
    -- insert de la venta). Acá solo se persiste el pago y, si es qr con intent,
    -- se ancla el intent a esta venta (BUG 3: cierra la ventana de doble cobro
    -- por reference).
    insert into payments (sale_id, method, amount, reference, card_voucher)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
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

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (customer_id, delta, reason)
      values (p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

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
    insert into customer_pack_credits (
      customer_id, pack_id, pack_name, product_id,
      sessions_total, sessions_used, expires_at, sale_id
    )
    values (
      p_customer_id, v_pk.id, v_pk.name, v_pk.product_id,
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

  -- BUG 1 — Cierre atómico de la mesa (efectos foldeados de close_dining_table):
  -- enlaza la venta al pedido, lo marca 'cobrada' y libera la mesa. El pedido ya
  -- fue tomado FOR UPDATE arriba, así que ninguna otra sesión pudo cobrarlo.
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

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4) Devoluciones: guard de cuenta. (Reproducidas completas; preservan todo, el
--    único cambio es el perform assert_account_active tras el chequeo de tenant.)
-- -----------------------------------------------------------------------------
create or replace function return_sale(
  p_sale_id uuid,
  p_items jsonb,
  p_reason text default null,
  p_refund text default 'cash'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_sale   record;
  v_store  uuid;
  v_shift  uuid;
  v_number bigint;
  v_total  numeric := 0;
  v_ret    uuid;
  v_it     record;
  v_si     record;
  v_unit   numeric;
  v_qty    numeric;
  v_line   numeric;
  v_restock text;
  v_ratio  numeric := 1;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  if p_refund not in ('cash','store_credit') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;
  if p_refund = 'store_credit' and v_sale.customer_id is null then
    raise exception 'store_credit_needs_customer';
  end if;

  if v_sale.subtotal is not null and v_sale.subtotal > 0 then
    v_ratio := v_sale.total / v_sale.subtotal;
  end if;

  select id into v_store from stores
   where tenant_id = v_tenant and deleted_at is null
   order by is_default desc, created_at limit 1;

  if p_refund = 'cash' then
    select cs.id into v_shift from cash_shifts cs
      join cash_registers cr on cr.id = cs.cash_register_id
     where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
     order by cs.opened_at desc limit 1;
    if v_shift is null then raise exception 'no_open_shift'; end if;
  end if;

  -- Correlativo de devolución con advisory lock por tenant.
  perform pg_advisory_xact_lock(hashtext('sale_return_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  insert into sale_returns (sale_id, customer_id, number, reason, refund_method, total)
  values (p_sale_id, v_sale.customer_id, v_number, p_reason, p_refund, 0)
  returning id into v_ret;

  for v_it in
    select * from jsonb_to_recordset(p_items)
      as x(sale_item_id uuid, quantity numeric, restock text)
  loop
    v_qty := coalesce(v_it.quantity, 0);
    if v_qty <= 0 then continue; end if;

    select * into v_si from sale_items
      where id = v_it.sale_item_id and sale_id = p_sale_id
      for update;
    if not found then raise exception 'item_not_found'; end if;
    if v_qty > (v_si.quantity - coalesce(v_si.returned_qty, 0)) then
      raise exception 'qty_exceeds';
    end if;

    v_unit := case when v_si.quantity > 0 then v_si.subtotal / v_si.quantity else v_si.unit_price end;
    v_line := round(v_unit * v_qty * v_ratio, 2);
    v_total := v_total + v_line;
    v_restock := coalesce(v_it.restock, 'stock');
    if v_restock not in ('stock','review','discard') then v_restock := 'stock'; end if;

    insert into sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, subtotal, restock)
    values (v_ret, v_si.id, v_si.product_id, v_qty, v_unit, v_line, v_restock);

    update sale_items set returned_qty = coalesce(returned_qty, 0) + v_qty where id = v_si.id;

    if v_restock = 'stock' and v_si.product_id is not null then
      if v_si.variant_id is not null then
        update product_variants pv set stock = pv.stock + v_qty, updated_at = now()
          where pv.id = v_si.variant_id and pv.tenant_id = v_tenant
            and exists (select 1 from products p where p.id = v_si.product_id and p.tenant_id = v_tenant and p.track_stock);
        insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id)
        select v_tenant, v_si.product_id, v_si.variant_id, v_store, v_qty, 'return', v_ret
        where exists (select 1 from products p where p.id = v_si.product_id and p.tenant_id = v_tenant and p.track_stock);
      else
        update products set stock = stock + v_qty, updated_at = now()
          where id = v_si.product_id and tenant_id = v_tenant and track_stock;
        insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
        select v_tenant, v_si.product_id, v_store, v_qty, 'return', v_ret
        where exists (select 1 from products where id = v_si.product_id and tenant_id = v_tenant and track_stock);
      end if;
    end if;
  end loop;

  if v_total <= 0 then raise exception 'empty_return'; end if;
  update sale_returns set total = v_total where id = v_ret;

  if p_refund = 'cash' then
    insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
    values (v_shift, 'expense', v_total, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
  else
    insert into store_credit_movements (customer_id, delta, reason, sale_return_id)
    values (v_sale.customer_id, v_total, 'Devolución venta #' || v_sale.number, v_ret);
  end if;

  return jsonb_build_object('return_id', v_ret, 'number', v_number, 'total', v_total);
end;
$$;

create or replace function return_sale_v2(
  p_sale_id uuid,
  p_items jsonb,
  p_reason_id uuid default null,
  p_refund text default 'cash',
  p_customer_id uuid default null,
  p_allowed_branch_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_sale     record;
  v_reason   record;
  v_dest     text := 'resale';
  v_reason_label text;
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_total    numeric := 0;
  v_ret      uuid;
  v_it       record;
  v_si       record;
  v_unit     numeric;
  v_qty      numeric;
  v_line     numeric;
  v_ratio    numeric := 1;
  v_policy   text := 'cashier_choice';
  v_validity int;
  v_refund   text;
  v_customer uuid;
  v_voucher_id uuid;
  v_voucher_code text;
  v_expires  timestamptz;
  v_restock  text;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  if p_refund not in ('cash','store_credit') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;

  select coalesce(return_policy, 'cashier_choice'), voucher_validity_months
    into v_policy, v_validity
  from pos_settings where tenant_id = v_tenant;
  if not found then v_policy := 'cashier_choice'; end if;

  v_refund := p_refund;
  if v_policy = 'always_credit' then v_refund := 'store_credit';
  elsif v_policy = 'always_cash' then v_refund := 'cash';
  end if;

  v_customer := coalesce(v_sale.customer_id, p_customer_id);
  if v_refund = 'store_credit' and v_customer is null then
    raise exception 'store_credit_needs_customer';
  end if;

  if p_reason_id is not null then
    select * into v_reason from return_reasons
      where id = p_reason_id and tenant_id = v_tenant and deleted_at is null;
    if found then
      v_dest := coalesce(v_reason.stock_destination, 'resale');
      v_reason_label := v_reason.label;
    end if;
  end if;
  v_restock := case v_dest
                 when 'resale' then 'stock'
                 when 'warehouse' then 'review'
                 when 'review' then 'review'
                 else 'discard'
               end;

  if v_sale.subtotal is not null and v_sale.subtotal > 0 then
    v_ratio := v_sale.total / v_sale.subtotal;
  end if;

  select id into v_store from stores
   where tenant_id = v_tenant and deleted_at is null
   order by is_default desc, created_at limit 1;

  if v_refund = 'cash' then
    select cs.id into v_shift from cash_shifts cs
      join cash_registers cr on cr.id = cs.cash_register_id
     where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
     order by cs.opened_at desc limit 1;
    if v_shift is null then raise exception 'no_open_shift'; end if;
  end if;

  -- Correlativo de devolución con advisory lock por tenant.
  perform pg_advisory_xact_lock(hashtext('sale_return_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  insert into sale_returns (sale_id, customer_id, number, reason, refund_method, total)
  values (p_sale_id, v_customer, v_number, v_reason_label, v_refund, 0)
  returning id into v_ret;

  for v_it in
    select * from jsonb_to_recordset(p_items) as x(sale_item_id uuid, quantity numeric)
  loop
    v_qty := coalesce(v_it.quantity, 0);
    if v_qty <= 0 then continue; end if;

    select * into v_si from sale_items
      where id = v_it.sale_item_id and sale_id = p_sale_id for update;
    if not found then raise exception 'item_not_found'; end if;
    if v_qty > (v_si.quantity - coalesce(v_si.returned_qty, 0)) then
      raise exception 'qty_exceeds';
    end if;

    v_unit := case when v_si.quantity > 0 then v_si.subtotal / v_si.quantity else v_si.unit_price end;
    v_line := round(v_unit * v_qty * v_ratio, 2);
    v_total := v_total + v_line;

    insert into sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, subtotal, restock)
    values (v_ret, v_si.id, v_si.product_id, v_qty, v_unit, v_line, v_restock);

    update sale_items set returned_qty = coalesce(returned_qty, 0) + v_qty where id = v_si.id;

    if v_dest = 'resale' and v_si.product_id is not null then
      update products set stock = stock + v_qty, updated_at = now()
        where id = v_si.product_id and tenant_id = v_tenant and track_stock;
      if found then
        insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
        values (v_tenant, v_si.product_id, v_store, v_qty, 'return', v_ret);
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
        values (v_tenant, auth.uid(), 'stock_movements', v_si.product_id, 'return_restock',
          jsonb_build_object('return_id', v_ret, 'product_id', v_si.product_id,
            'qty', v_qty, 'destination', v_dest));
      end if;
    end if;
  end loop;

  if v_total <= 0 then raise exception 'empty_return'; end if;
  update sale_returns set total = v_total where id = v_ret;

  if v_refund = 'cash' then
    insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
    values (v_shift, 'expense', v_total, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
  else
    v_expires := case when v_validity is not null
                      then now() + make_interval(months => v_validity)
                      else null end;
    v_voucher_code := gen_voucher_code();
    insert into store_credit_vouchers
      (tenant_id, code, amount, customer_id, status, expires_at, allowed_branch_ids, sale_return_id)
    values
      (v_tenant, v_voucher_code, v_total, v_customer, 'active', v_expires, p_allowed_branch_ids, v_ret)
    returning id into v_voucher_id;

    insert into store_credit_movements (customer_id, delta, reason, sale_return_id, voucher_id)
    values (v_customer, v_total, 'Vale ' || v_voucher_code || ' (dev #' || v_number || ')', v_ret, v_voucher_id);

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'store_credit_vouchers', v_voucher_id, 'voucher_issued',
      jsonb_build_object('code', v_voucher_code, 'amount', v_total, 'customer_id', v_customer,
        'expires_at', v_expires, 'allowed_branch_ids', p_allowed_branch_ids, 'return_id', v_ret));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'sale_returns', v_ret, 'return_created',
    jsonb_build_object('number', v_number, 'sale_id', p_sale_id, 'total', v_total,
      'refund', v_refund, 'reason_id', p_reason_id, 'stock_destination', v_dest));

  return jsonb_build_object(
    'return_id', v_ret, 'number', v_number, 'total', v_total,
    'refund', v_refund, 'stock_destination', v_dest,
    'voucher_code', v_voucher_code, 'voucher_expires_at', v_expires
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 5) Red de seguridad QR (BUG B / BUG 3): un intent no puede anclar dos ventas
--    ni por carrera. Índice UNIQUE parcial sobre payments(tenant_id, reference)
--    para method='qr'. Verificado: sin duplicados existentes.
-- -----------------------------------------------------------------------------
create unique index if not exists payments_qr_reference_uniq
  on payments (tenant_id, reference)
  where method = 'qr' and reference is not null;
