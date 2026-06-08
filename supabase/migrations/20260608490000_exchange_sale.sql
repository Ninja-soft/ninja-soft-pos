-- =============================================================================
-- 20260608490000_exchange_sale  (F11 · H29 — CAMBIO con diferencia a cobrar)
-- -----------------------------------------------------------------------------
-- Cierra la pieza pendiente de H29: el CAMBIO de producto. El cliente trae una
-- venta, devuelve uno o más ítems y se lleva OTROS productos; la DIFERENCIA se
-- cobra o se reintegra en un solo flujo atómico y auditado.
--
-- CAMINO ELEGIDO: un único RPC `exchange_sale` que ORQUESTA las dos funciones
-- vivas en UNA transacción, SIN duplicar validaciones:
--   1) return_sale_v2(...)  → devuelve los ítems (motivo ⇒ destino de stock,
--      reingreso/auditoría), forzando reintegro 'store_credit' para que el valor
--      devuelto quede como CRÉDITO del cliente en el ledger store_credit_movements
--      (también emite el vale-comprobante de la devolución, con código).
--   2) create_sale(...)     → registra la venta NUEVA (descuenta stock vía la misma
--      lógica de siempre: variantes, kits, seriales, gating, redondeo), pagando
--      con: el CRÉDITO recién acreditado (medio 'store_credit', tope = total nuevo)
--      + los medios que elija el cajero para la DIFERENCIA (p_difference_payments).
--
-- Como ambas RPC son SECURITY INVOKER y exchange_sale también, todo corre con el
-- mismo current_tenant_id()/auth.uid() y dentro de la MISMA transacción: si la
-- venta nueva falla (p.ej. sin stock), la devolución y el crédito se revierten
-- por completo (atomicidad real). No se reescriben validaciones de stock/saldo:
-- se LLAMA a las funciones existentes.
--
-- DIFERENCIA = total_nuevos − valor_devuelto:
--   • > 0 (se lleva más caro): el valor devuelto se aplica como crédito y la
--     diferencia se cobra por p_difference_payments (efectivo/QR/tarjeta/…).
--   • < 0 (se lleva más barato): el SOBRANTE (valor_devuelto − total_nuevos) va a
--     EFECTIVO (sale de caja, se debita el crédito) o queda como VALE (saldo a
--     favor en el ledger), según p_surplus_to / la política del tenant.
--   • = 0 (cambio par): sin movimiento de dinero.
--
-- NOTA sobre política de devolución del tenant: para un CAMBIO el valor devuelto
-- es, por definición, crédito hacia la mercadería nueva, así que la pata de
-- devolución se fuerza a 'store_credit' aunque la política sea 'always_cash'
-- (esa política rige las devoluciones PURAS, no el crédito interno del cambio).
-- El destino del SOBRANTE sí respeta la política (always_cash ⇒ efectivo,
-- always_credit ⇒ vale) cuando el caller no lo fuerza.
-- =============================================================================

create or replace function public.exchange_sale(
  p_sale_id             uuid,
  p_return_items        jsonb,                       -- [{sale_item_id, quantity}]
  p_new_items           jsonb,                       -- ítems de la venta nueva (formato create_sale)
  p_difference_payments jsonb   default '[]'::jsonb, -- medios para la diferencia (>0): [{method, amount, reference}]
  p_reason_id           uuid    default null,        -- motivo (fija destino de stock de lo devuelto)
  p_new_discount        numeric default 0,           -- descuento global de la venta nueva
  p_customer_id         uuid    default null,        -- cliente (si la venta no tenía)
  p_allowed_branch_ids  uuid[]  default null,        -- scoping de sucursales del vale de devolución
  p_surplus_to          text    default null,        -- 'cash' | 'store_credit' (sobrante si diff<0); null = política
  p_notes               text    default null,        -- nota de la venta nueva
  p_extras              jsonb   default '[]'::jsonb   -- señal de gating de la venta nueva (garantía/recargo)
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_tenant    uuid := current_tenant_id();
  v_sale      record;
  v_customer  uuid;
  v_policy    text := 'cashier_choice';
  v_round     numeric := 0;
  v_role      text;
  v_max_disc  numeric := 100;
  -- Devolución (pata 1)
  v_ret_res   jsonb;
  v_returned  numeric := 0;
  v_ret_id    uuid;
  v_ret_num   bigint;
  v_voucher   text;
  -- Venta nueva (pata 2)
  v_new_subtotal numeric := 0;
  v_line_disc    numeric := 0;
  v_new_total    numeric := 0;
  v_credit_applied numeric := 0;
  v_diff_paid    numeric := 0;
  v_payments     jsonb;
  v_sale_res     jsonb;
  v_new_sale_id  uuid;
  v_new_number   bigint;
  -- Diferencia / sobrante
  v_difference numeric := 0;
  v_surplus    numeric := 0;
  v_surplus_to text;
  v_store      uuid;
  v_shift      uuid;
  v_it         record;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;

  -- La venta de origen debe existir y ser devolvible (mismo criterio que return_sale_v2).
  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;

  -- Un cambio necesita cliente: el crédito de lo devuelto se aplica a la compra
  -- nueva (y un sobrante eventual queda como saldo a favor del cliente).
  v_customer := coalesce(v_sale.customer_id, p_customer_id);
  if v_customer is null then raise exception 'exchange_needs_customer'; end if;

  -- Debe haber ítems nuevos: si no, es una devolución pura (usar return_sale_v2).
  if p_new_items is null or jsonb_array_length(p_new_items) = 0 then
    raise exception 'exchange_needs_new_items';
  end if;

  -- Política + redondeo del tenant (para dimensionar el split y el sobrante).
  select coalesce(return_policy, 'cashier_choice'), coalesce(rounding_multiple, 0)
    into v_policy, v_round
  from pos_settings where tenant_id = v_tenant;
  if not found then v_policy := 'cashier_choice'; v_round := 0; end if;

  -- Tope de descuento del rol (espeja create_sale: se valida igual adentro, pero
  -- damos un error claro y temprano si la venta nueva excede el tope).
  select role into v_role from tenant_users
   where tenant_id = v_tenant and user_id = auth.uid() and status = 'active' limit 1;
  select coalesce((max_discount ->> coalesce(v_role, 'cashier'))::numeric, 100)
    into v_max_disc from pos_settings where tenant_id = v_tenant;
  if v_max_disc is null then v_max_disc := 100; end if;

  -- ── Total de la venta NUEVA (idéntica fórmula que create_sale) ──────────────
  -- Solo para DIMENSIONAR el pago con crédito; create_sale recalcula de forma
  -- autoritativa y rechaza si los números no cierran. No se duplica validación.
  for v_it in
    select * from jsonb_to_recordset(p_new_items)
      as x(unit_price numeric, quantity numeric, discount numeric)
  loop
    v_new_subtotal := v_new_subtotal
      + (coalesce(v_it.unit_price, 0) * coalesce(v_it.quantity, 0))
      - coalesce(v_it.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_it.discount, 0);
  end loop;
  if v_new_subtotal <= 0 then raise exception 'empty_sale'; end if;
  if coalesce(p_new_discount, 0) < 0 then raise exception 'invalid_discount'; end if;
  if coalesce(p_new_discount, 0) > 0
     and (p_new_discount / v_new_subtotal * 100) > v_max_disc + 0.001 then
    raise exception 'discount_exceeds_limit';
  end if;

  v_new_total := v_new_subtotal - coalesce(p_new_discount, 0);
  if v_round > 0 then
    v_new_total := round(v_new_total / v_round) * v_round;
  end if;
  -- ────────────────────────────────────────────────────────────────────────────

  -- ── PATA 1: DEVOLUCIÓN → crédito al cliente (reuso total de return_sale_v2) ──
  -- Se fuerza 'store_credit': el valor devuelto debe quedar como crédito para
  -- aplicarlo a la compra nueva. return_sale_v2 valida cantidades/destino de
  -- stock/reingreso/auditoría y emite el vale-comprobante de la devolución.
  v_ret_res := public.return_sale_v2(
    p_sale_id            => p_sale_id,
    p_items              => p_return_items,
    p_reason_id          => p_reason_id,
    p_refund             => 'store_credit',
    p_customer_id        => v_customer,
    p_allowed_branch_ids => p_allowed_branch_ids
  );
  v_returned := coalesce((v_ret_res ->> 'total')::numeric, 0);
  v_ret_id   := (v_ret_res ->> 'return_id')::uuid;
  v_ret_num  := (v_ret_res ->> 'number')::bigint;
  v_voucher  := v_ret_res ->> 'voucher_code';
  if v_returned <= 0 then raise exception 'empty_return'; end if;

  -- Crédito aplicable a la venta nueva: nunca más que su total.
  v_credit_applied := least(v_returned, v_new_total);
  v_difference := round(v_new_total - v_returned, 2);  -- >0 cobra, <0 sobra, =0 par

  -- ── PATA 2: VENTA NUEVA (reuso total de create_sale) ────────────────────────
  -- Pagos = crédito recién acreditado (medio 'store_credit', tope = total nuevo)
  -- + los medios que el cajero eligió para la diferencia. create_sale valida el
  -- saldo del ledger (que ahora incluye el crédito), lo descuenta, cobra el resto
  -- y rechaza si paid<total. NO se duplica nada del cálculo de la venta.
  v_payments := '[]'::jsonb;
  if v_credit_applied > 0 then
    v_payments := v_payments || jsonb_build_array(
      jsonb_build_object('method', 'store_credit', 'amount', v_credit_applied)
    );
  end if;
  -- Diferencia: solo se exige cobrar si la venta nueva es más cara que lo devuelto.
  if v_difference > 0.001 then
    -- Anexa los medios de la diferencia (efectivo/QR/tarjeta/…) tal cual.
    v_payments := v_payments || coalesce(p_difference_payments, '[]'::jsonb);
    select coalesce(sum((p ->> 'amount')::numeric), 0) into v_diff_paid
      from jsonb_array_elements(coalesce(p_difference_payments, '[]'::jsonb)) p;
    if v_diff_paid + v_credit_applied < v_new_total - 0.001 then
      raise exception 'insufficient_difference';
    end if;
  end if;

  v_sale_res := public.create_sale(
    p_items          => p_new_items,
    p_payments       => v_payments,
    p_discount_total => coalesce(p_new_discount, 0),
    p_customer_id    => v_customer,
    p_notes          => coalesce(p_notes, 'Cambio s/ venta #' || v_sale.number),
    p_extras         => coalesce(p_extras, '[]'::jsonb)
  );
  v_new_sale_id := (v_sale_res ->> 'sale_id')::uuid;
  v_new_number  := (v_sale_res ->> 'number')::bigint;
  v_new_total   := coalesce((v_sale_res ->> 'total')::numeric, v_new_total);
  -- Recalcula crédito/diferencia con el total AUTORITATIVO de create_sale.
  v_credit_applied := least(v_returned, v_new_total);
  v_difference := round(v_new_total - v_returned, 2);

  -- ── SOBRANTE (diferencia < 0): el cliente se lleva algo más barato ──────────
  -- Queda crédito sin usar = v_returned − v_new_total. Destino: efectivo (sale de
  -- caja y se debita el ledger) o vale (queda como saldo a favor, ya en el ledger
  -- desde la devolución). El caller manda p_surplus_to; si no, lo decide la política.
  v_surplus := round(v_returned - v_new_total, 2);
  if v_surplus > 0.001 then
    v_surplus_to := lower(coalesce(nullif(btrim(p_surplus_to), ''),
      case v_policy when 'always_cash' then 'cash'
                    when 'always_credit' then 'store_credit'
                    else 'store_credit' end));
    if v_surplus_to not in ('cash', 'store_credit') then
      v_surplus_to := 'store_credit';
    end if;
    -- La política manda sobre la elección del caller cuando la fija.
    if v_policy = 'always_cash' then v_surplus_to := 'cash';
    elsif v_policy = 'always_credit' then v_surplus_to := 'store_credit';
    end if;

    if v_surplus_to = 'cash' then
      -- Reintegro en efectivo del sobrante: exige caja abierta. Debita el ledger
      -- (el crédito de la devolución ya no queda como saldo, se paga en mano).
      select id into v_store from stores
       where tenant_id = v_tenant and deleted_at is null
       order by is_default desc, created_at limit 1;
      select cs.id into v_shift from cash_shifts cs
        join cash_registers cr on cr.id = cs.cash_register_id
       where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
       order by cs.opened_at desc limit 1;
      if v_shift is null then raise exception 'no_open_shift'; end if;

      insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
      values (v_shift, 'expense', v_surplus, 'cash',
              'Sobrante cambio (dev #' || v_ret_num || ' → venta #' || v_new_number || ')', v_ret_id);

      insert into store_credit_movements (customer_id, delta, reason, sale_return_id)
      values (v_customer, -v_surplus,
              'Sobrante cambio devuelto en efectivo (venta #' || v_new_number || ')', v_ret_id);
    end if;
    -- Si es 'store_credit', no se hace nada: el sobrante ya vive como saldo a
    -- favor en el ledger (acreditado por la devolución), respaldado por su vale.
  end if;

  -- ── Auditoría del CAMBIO: enlaza devolución + venta nueva + diferencia ──────
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'sales', v_new_sale_id, 'exchange_created',
    jsonb_build_object(
      'origin_sale_id', p_sale_id, 'origin_sale_number', v_sale.number,
      'return_id', v_ret_id, 'return_number', v_ret_num, 'voucher_code', v_voucher,
      'new_sale_id', v_new_sale_id, 'new_sale_number', v_new_number,
      'returned', v_returned, 'new_total', v_new_total,
      'credit_applied', v_credit_applied, 'difference', v_difference,
      'difference_charged', case when v_difference > 0 then v_difference else 0 end,
      'surplus', case when v_surplus > 0 then v_surplus else 0 end,
      'surplus_to', case when v_surplus > 0.001 then v_surplus_to else null end,
      'customer_id', v_customer));

  return jsonb_build_object(
    'return_id', v_ret_id,
    'return_number', v_ret_num,
    'voucher_code', v_voucher,
    'sale_id', v_new_sale_id,
    'sale_number', v_new_number,
    'returned', v_returned,
    'new_total', v_new_total,
    'credit_applied', v_credit_applied,
    'difference', v_difference,
    'surplus', case when v_surplus > 0 then v_surplus else 0 end,
    'surplus_to', case when v_surplus > 0.001 then v_surplus_to else null end
  );
end;
$function$;

revoke all on function public.exchange_sale(uuid, jsonb, jsonb, jsonb, uuid, numeric, uuid, uuid[], text, text, jsonb) from public, anon;
grant execute on function public.exchange_sale(uuid, jsonb, jsonb, jsonb, uuid, numeric, uuid, uuid[], text, text, jsonb) to authenticated;
