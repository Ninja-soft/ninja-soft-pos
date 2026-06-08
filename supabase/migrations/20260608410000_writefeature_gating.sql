-- =============================================================================
-- 20260608410000_writefeature_gating
-- -----------------------------------------------------------------------------
-- Auditoría: varias features NO básicas de ESCRITURA se bloqueaban SOLO en la UI.
-- El backend no validaba `tenant_has_feature`, así que sorteando la UI (devtools
-- o llamando la RPC directo) se podían usar sin el plan. El comentario del código
-- afirmaba falsamente "el backend igual bloquea". Esta migración alinea la
-- realidad con el comentario: mueve el gate al BACKEND, imposible de saltear.
--
-- Cubre (todas son features is_basic=false en `features`, declaradas por plan en
-- plans.limits->modules):
--   1) create_sale:
--      • DESCUENTOS  → si p_discount_total>0 o hay descuento por línea y el tenant
--        no tiene 'descuentos' → raise 'feature_not_in_plan: descuentos'.
--      • GARANTÍAS   → si llega una prima de garantía (p_extras con kind='warranty'
--        y monto>0) y no tiene 'garantias' → raise 'feature_not_in_plan: garantias'.
--      • CUENTA CTE. → si la venta usa el medio 'account' (fiado) y no tiene
--        'cuenta_corriente' → raise 'feature_not_in_plan: cuenta_corriente'.
--   2) price_lists / price_list_items: trigger BEFORE INSERT/UPDATE que exige
--      'listas_precios' (la UI escribe directo a estas tablas; RLS ya acota a
--      owner/manager, este trigger agrega el gate de plan).
--
-- DE PASO (concurrencia, mismo dominio): correlativo de venta/devolución con
--   advisory lock por tenant (espeja next_product_plu) ANTES de max(number)+1,
--   en create_sale, return_sale_v2 y return_sale. Sin lock, dos operaciones
--   simultáneas del mismo tenant chocaban con el UNIQUE (tenant_id, number) y el
--   cajero veía un error.
--
-- promociones / grupos_clientes: NO tienen RPC ni escritura server-side gateable
--   hoy (promociones es UI sin persistencia propia; grupos_clientes escribe a la
--   tabla customer_groups vía RLS owner/manager, sin feature aún). Quedan UI-only
--   por ahora — NO se inventa enforcement que no aplica. (Anotado para revisión.)
--
-- Las tres funciones se RECREAN desde su definición VIVA (incluye el gating de
-- medios QR ya presente en create_sale) + los checks/lock nuevos. Se conserva
-- language/security invoker y `set search_path = public, pg_temp`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) create_sale — gating de descuentos / garantías / cuenta corriente + lock.
--    Nuevo parámetro OPCIONAL p_extras (jsonb, default '[]'): descriptor de los
--    extras del cobro (garantía extendida / recargos). Cada extra:
--      { "kind": "warranty"|"surcharge", "amount": <numeric> }
--    p_extras es SOLO señal de gating; los importes de los extras siguen llegando
--    como ítems de venta en p_items (no se duplican ni se altera el cálculo del
--    total), igual que hoy.
--
--    IMPORTANTE: la firma viva era de 5 args (sin p_extras). Agregar p_extras crea
--    un OVERLOAD nuevo y deja vivo el viejo de 5 args (ungated → bypass). Por eso
--    se DROPEA explícitamente el overload de 5 args antes de crear el de 6. Tras
--    el drop, los callers de 5 args resuelven al de 6 (p_extras default '[]') →
--    backward-compatible Y siempre gateado.
-- -----------------------------------------------------------------------------
drop function if exists public.create_sale(jsonb, jsonb, numeric, uuid, text);

create or replace function public.create_sale(
  p_items          jsonb,
  p_payments       jsonb,
  p_discount_total numeric default 0,
  p_customer_id    uuid    default null,
  p_notes          text    default null,
  p_extras         jsonb   default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
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
  v_line_disc numeric := 0;       -- suma de descuentos por línea (gating)
  v_warranty_prima numeric := 0;  -- suma de primas de garantía en p_extras (gating)
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
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

  if v_subtotal <= 0 then
    raise exception 'empty_sale';
  end if;

  -- ── Gating server-side: DESCUENTOS (#1) ───────────────────────────────────
  -- Si la venta trae descuento (global o por línea) y el plan no incluye
  -- 'descuentos', se rechaza aunque la UI lo haya permitido. La UI ya esconde el
  -- campo de descuento sin la feature; este es el cierre real en el backend.
  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;
  -- ──────────────────────────────────────────────────────────────────────────

  -- ── Gating server-side: GARANTÍAS (#1) ────────────────────────────────────
  -- La prima de garantía extendida llega como ítem de venta (importe) + un
  -- descriptor en p_extras (kind='warranty'). Si hay prima y el plan no incluye
  -- 'garantias', se rechaza. (Los recargos de medio/plan — kind='surcharge' — no
  -- se gatean: son operativos, no una feature de plan.)
  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;
  -- ──────────────────────────────────────────────────────────────────────────

  -- ── Gating server-side: CUENTA CORRIENTE (#1) ─────────────────────────────
  -- El medio 'account' (fiado) deja deuda del cliente (customer_account_movements
  -- vía trigger). Si el plan no incluye 'cuenta_corriente', se rechaza la venta
  -- antes de tocar pagos.
  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
         as p(method text, amount numeric)
       where p.method = 'account' and coalesce(p.amount, 0) > 0
     )
     and not tenant_has_feature('cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;
  -- ──────────────────────────────────────────────────────────────────────────

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
  if v_paid < v_total then
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

  -- ── Correlativo con advisory lock (#2) ─────────────────────────────────────
  -- Serializa la asignación del número de venta por tenant DENTRO de la
  -- transacción: dos ventas concurrentes del mismo tenant no calculan el mismo
  -- max(number)+1 y ya no chocan con UNIQUE (tenant_id, number). Espeja el patrón
  -- de next_product_plu.
  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;
  -- ──────────────────────────────────────────────────────────────────────────

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes)
  returning id into v_sale_id;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      -- H10: validación de variante. Productos con variantes exigen variant_id
      -- válido; productos sin variantes rechazan variant_id.
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
                            quantity, unit_price, discount, subtotal)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0));

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
            -- H10: stock contra la variante; allow_negative del padre.
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
      as x(method text, amount numeric, reference text)
  loop
    -- ── Gating server-side de medios de pago (#8) ──────────────────────────────
    -- Un medio cuya feature no está incluida en el plan se rechaza, aunque el
    -- cliente lo haya forzado. Solo se gatean los medios con feature: efectivo y
    -- transferencia son básicos; débito/crédito por terminal son genéricos. Para
    -- 'qr' el proveedor real (MP/MODO/Mobbex) se resuelve por el intent
    -- referenciado (payments.reference = mp_payment_intents.id).
    if v_pay.method = 'qr' then
      v_pay_feat := null;
      if v_pay.reference is not null
         and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
        select case pi.provider_key
                 when 'mercadopago' then 'mercado_pago'
                 when 'mobbex'      then 'mobbex'
                 when 'modo'        then 'modo'
                 else null
               end
          into v_pay_feat
        from mp_payment_intents pi
        where pi.id = v_pay.reference::uuid
          and pi.tenant_id = v_tenant
        limit 1;
      end if;
      if v_pay_feat is not null and not tenant_has_feature(v_pay_feat) then
        raise exception 'method_not_in_plan';
      end if;
    end if;
    -- ───────────────────────────────────────────────────────────────────────────

    insert into payments (sale_id, method, amount, reference)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference);

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (customer_id, delta, reason)
      values (p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total);
end;
$function$;

-- Mantiene los grants previos del RPC create_sale (la nueva firma de 6 args es
-- el mismo objeto recreado; reafirmamos los permisos por claridad).
revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 2) return_sale_v2 — correlativo de devolución con advisory lock (#2).
--    Recreada desde su definición viva + lock antes de max(number)+1.
-- -----------------------------------------------------------------------------
create or replace function public.return_sale_v2(
  p_sale_id            uuid,
  p_items              jsonb,
  p_reason_id          uuid    default null,
  p_refund             text    default 'cash',
  p_customer_id        uuid    default null,
  p_allowed_branch_ids uuid[]  default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
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

  -- ── Correlativo con advisory lock (#2) ─────────────────────────────────────
  -- Serializa el número de devolución por tenant: dos devoluciones concurrentes
  -- del mismo tenant ya no chocan con UNIQUE (tenant_id, number) de sale_returns.
  perform pg_advisory_xact_lock(hashtext('sale_return_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  -- ──────────────────────────────────────────────────────────────────────────
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
$function$;
revoke all on function public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[]) from public, anon;
grant execute on function public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- 2b) return_sale (v1, legado) — mismo advisory lock en el correlativo.
--     Recreada desde su definición viva + lock. Sigue usada por flujos antiguos.
-- -----------------------------------------------------------------------------
create or replace function public.return_sale(
  p_sale_id uuid,
  p_items   jsonb,
  p_reason  text default null,
  p_refund  text default 'cash'
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
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
  if p_refund not in ('cash','store_credit') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;
  if p_refund = 'store_credit' and v_sale.customer_id is null then
    raise exception 'store_credit_needs_customer';
  end if;

  -- Proporción real pagada (refleja descuento global + redondeo absorbido).
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

  -- ── Correlativo con advisory lock (#2) ─────────────────────────────────────
  -- Espeja el lock de return_sale_v2 / next_product_plu: serializa el número de
  -- devolución por tenant para no chocar con UNIQUE (tenant_id, number).
  perform pg_advisory_xact_lock(hashtext('sale_return_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  -- ──────────────────────────────────────────────────────────────────────────
  insert into sale_returns (sale_id, customer_id, number, reason, refund_method, total)
  values (p_sale_id, v_sale.customer_id, v_number, p_reason, p_refund, 0)
  returning id into v_ret;

  for v_it in
    select * from jsonb_to_recordset(p_items)
      as x(sale_item_id uuid, quantity numeric, restock text)
  loop
    v_qty := coalesce(v_it.quantity, 0);
    if v_qty <= 0 then continue; end if;

    -- Lock de la línea para serializar devoluciones concurrentes.
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
        -- H10: repone a la variante (respeta track_stock del padre).
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
$function$;
revoke all on function public.return_sale(uuid, jsonb, text, text) from public, anon;
grant execute on function public.return_sale(uuid, jsonb, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3) Listas de precios — gating server-side de ESCRITURA (#1).
--    La UI escribe DIRECTO a price_lists / price_list_items (no hay RPC), así que
--    el gate real va en un trigger BEFORE INSERT/UPDATE. RLS ya acota a
--    owner/manager del tenant; este trigger agrega el requisito de plan
--    'listas_precios'. Se resuelve por NEW.tenant_id (no por el JWT) para cubrir
--    también escrituras service_role.
-- -----------------------------------------------------------------------------
create or replace function trg_assert_price_lists_feature()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not tenant_has_feature_for(new.tenant_id, 'listas_precios') then
    raise exception 'feature_not_in_plan: listas_precios'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_assert_price_lists_feature() from public, anon;

drop trigger if exists price_lists_assert_feature on price_lists;
create trigger price_lists_assert_feature
  before insert or update on price_lists
  for each row execute function trg_assert_price_lists_feature();

drop trigger if exists price_list_items_assert_feature on price_list_items;
create trigger price_list_items_assert_feature
  before insert or update on price_list_items
  for each row execute function trg_assert_price_lists_feature();
