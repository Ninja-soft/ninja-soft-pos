-- =============================================================================
-- 20261017140000_caja_propia_cobros_en_espera  (F17 · H114 · ADR-051 + ADR-048)
--
-- Caja propia y cobros en espera conviven:
--   · _pc_complete (copia EXACTA de 20261014100000_cobros_en_espera, la última
--     definición) marca la transacción con `ninja.pc_complete` = id del cobro
--     mientras llama a create_sale. Con esa marca:
--       - resolve_sale_shift acepta el turno destino aunque sea de otra persona
--         (el cobro se acredita en el turno abierto de su caja o sucursal, como
--         decide _pc_target_shift) y no evalúa el estado del personal de quien
--         lo estacionó (la plata ya entró: la venta no puede quedar colgada);
--       - el trigger de supervisor de `sales` no pide PIN por el descuento: se
--         exigió al estacionar (park_pending_charge corre _pc_dry_run, que pasa
--         por los mismos triggers con el token del header).
--   · _pc_dry_run (ninja.pc_dry_run) NO tiene excepción: estacionar exige caja
--     propia, personal activo y PIN como una venta normal.
--   · El cierre forzado (cash_force_close) pasa los cobros abiertos del turno a
--     la próxima apertura de esa caja ('carry') salvo que se pida 'cancel'.
-- =============================================================================

create or replace function _pc_complete(
  p_id     uuid,
  p_actor  uuid default null,
  p_source text default 'system',
  p_force  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c       pending_charges%rowtype;
  v_i       record;
  v_shift   uuid;
  v_items   jsonb;
  v_extras  jsonb;
  v_diff    numeric;
  v_res     jsonb;
  v_msg     text;
  v_actor   uuid;
  v_prev_claims text;
  v_prev_claim  text;
  v_prev_sub    text;
  v_sale_number bigint;
begin
  select * into v_c from pending_charges where id = p_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_c.status = 'completed' then
    return jsonb_build_object('status', 'completed', 'sale_id', v_c.sale_id, 'number', v_c.sale_number);
  end if;
  if v_c.status not in ('waiting', 'paid') then
    return jsonb_build_object('status', v_c.status);
  end if;
  if v_c.needs_review and not p_force then
    return jsonb_build_object('status', v_c.status, 'error', 'needs_review');
  end if;

  select id, status, amount, sale_id, provider_key, mp_payment_id
    into v_i
    from mp_payment_intents
   where id = v_c.intent_id and tenant_id = v_c.tenant_id
   for update;
  if not found or v_i.status <> 'approved' then
    return jsonb_build_object('status', v_c.status);
  end if;

  -- La venta ya existe (p. ej. la registró el POS antes de estacionar).
  if v_i.sale_id is not null then
    select number into v_sale_number from sales where id = v_i.sale_id;
    update pending_charges
       set status = 'completed', sale_id = v_i.sale_id, sale_number = v_sale_number,
           completed_at = coalesce(completed_at, now()),
           paid_at = coalesce(paid_at, now()), paid_amount = coalesce(paid_amount, v_i.amount),
           last_error = null, version = version + 1
     where id = v_c.id;
    perform _pc_event(v_c.tenant_id, v_c.id, 'completed',
                      jsonb_build_object('sale_id', v_i.sale_id, 'number', v_sale_number, 'source', p_source, 'existing', true),
                      p_actor);
    return jsonb_build_object('status', 'completed', 'sale_id', v_i.sale_id, 'number', v_sale_number);
  end if;

  if v_c.status = 'waiting' then
    update pending_charges
       set status = 'paid', paid_at = now(), paid_amount = v_i.amount, version = version + 1
     where id = v_c.id;
    perform _pc_event(v_c.tenant_id, v_c.id, 'paid',
                      jsonb_build_object('amount', v_i.amount, 'provider', v_i.provider_key,
                                         'payment_id', v_i.mp_payment_id, 'source', p_source),
                      p_actor);
    v_c.status := 'paid';
  end if;

  v_shift := _pc_target_shift(v_c);
  if v_shift is null then
    update pending_charges
       set last_error = 'no_open_shift', attempts = attempts + 1, last_attempt_at = now()
     where id = v_c.id;
    return jsonb_build_object('status', 'paid', 'error', 'no_open_shift');
  end if;

  -- Monto: el del intent (verificado por la Edge contra el proveedor).
  v_items  := coalesce(v_c.sale_args -> 'items', '[]'::jsonb);
  v_extras := coalesce(v_c.sale_args -> 'extras', '[]'::jsonb);
  v_diff   := round(v_i.amount - v_c.amount, 2);
  if v_diff > 0.01 then
    -- Cuotas con recargo elegidas por el cliente en el checkout (Payway).
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', null, 'name', 'Recargo cuotas', 'quantity', 1,
      'unit_price', v_diff, 'discount', 0));
    v_extras := v_extras || jsonb_build_array(jsonb_build_object('kind', 'surcharge', 'amount', v_diff));
  elsif v_diff < -0.01 then
    update pending_charges
       set last_error = 'amount_mismatch', needs_review = true,
           attempts = attempts + 1, last_attempt_at = now()
     where id = v_c.id;
    perform _pc_event(v_c.tenant_id, v_c.id, 'completion_failed',
                      jsonb_build_object('error', 'amount_mismatch', 'paid', v_i.amount, 'expected', v_c.amount),
                      p_actor);
    return jsonb_build_object('status', 'paid', 'error', 'amount_mismatch');
  end if;

  -- Claims de la transacción → usuario y negocio del cobro.
  v_actor := coalesce(p_actor, v_c.created_by);
  v_prev_claims := current_setting('request.jwt.claims', true);
  v_prev_claim  := current_setting('request.jwt.claim', true);
  v_prev_sub    := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub', v_actor,
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('current_tenant_id', v_c.tenant_id)
    )::text, true);

  -- ADR-051 (H114): marca de completitud de cobro en espera. resolve_sale_shift
  -- y los triggers de supervisor la reconocen: el turno destino puede ser de
  -- otra persona y el PIN (si hacía falta) ya se pidió al estacionar.
  perform set_config('ninja.pc_complete', v_c.id::text, true);
  begin
    v_res := create_sale(
      p_items          := v_items,
      p_payments       := jsonb_build_array(jsonb_build_object(
                            'method', 'qr', 'amount', v_i.amount, 'reference', v_i.id::text)),
      p_discount_total := coalesce((v_c.sale_args ->> 'discount_total')::numeric, 0),
      p_customer_id    := nullif(v_c.sale_args ->> 'customer_id', '')::uuid,
      p_notes          := nullif(v_c.sale_args ->> 'notes', ''),
      p_extras         := v_extras,
      p_promo_discount := coalesce((v_c.sale_args ->> 'promo_discount')::numeric, 0),
      p_promo_id       := nullif(v_c.sale_args ->> 'promo_id', '')::uuid,
      p_promo_name     := nullif(v_c.sale_args ->> 'promo_name', ''),
      p_coupon_id      := nullif(v_c.sale_args ->> 'coupon_id', '')::uuid,
      p_cash_shift_id  := v_shift
    );
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform set_config('ninja.pc_complete', '', true);
    perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);
    perform set_config('request.jwt.claim', coalesce(v_prev_claim, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
    update pending_charges
       set last_error = left(v_msg, 300), attempts = attempts + 1, last_attempt_at = now(),
           version = version + 1
     where id = v_c.id;
    perform _pc_event(v_c.tenant_id, v_c.id, 'completion_failed',
                      jsonb_build_object('error', left(v_msg, 300), 'source', p_source), p_actor);
    -- Primer fallo: aviso para que alguien lo resuelva.
    if v_c.attempts = 0 and v_msg <> 'no_open_shift' then
      perform _pc_notify(v_c, 'warning', 'Cobro pagado sin venta',
        'El cliente pagó ' || _pc_money(v_i.amount)
          || ' pero la venta no se pudo registrar (' || left(v_msg, 80) || '). Revisalo en Cobros en espera.');
    end if;
    return jsonb_build_object('status', 'paid', 'error', left(v_msg, 300));
  end;

  perform set_config('ninja.pc_complete', '', true);
  perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);
  perform set_config('request.jwt.claim', coalesce(v_prev_claim, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);

  update pending_charges
     set status = 'completed', sale_id = (v_res ->> 'sale_id')::uuid,
         sale_number = (v_res ->> 'number')::bigint, completed_at = now(),
         cash_shift_id = v_shift, carry_over = false,
         last_error = null, needs_review = false, attempts = attempts + 1, last_attempt_at = now(),
         version = version + 1
   where id = v_c.id;

  perform _pc_event(v_c.tenant_id, v_c.id, 'completed',
                    jsonb_build_object('sale_id', v_res ->> 'sale_id', 'number', v_res -> 'number',
                                       'total', v_res -> 'total', 'shift_id', v_shift,
                                       'source', p_source, 'forced', p_force),
                    p_actor);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_c.tenant_id, v_actor, 'pending_charges', v_c.id, 'pending_charge_completed',
          jsonb_build_object('sale_id', v_res ->> 'sale_id', 'number', v_res -> 'number',
                             'amount', v_i.amount, 'intent_id', v_i.id, 'shift_id', v_shift,
                             'source', p_source, 'forced', p_force));
  perform _pc_notify(v_c, 'success', 'Cobro acreditado',
    'Venta #' || (v_res ->> 'number') || ' por ' || _pc_money(v_i.amount)
      || coalesce(' de ' || v_c.customer_name, '') || '. Ya podés imprimir el ticket.');

  return jsonb_build_object('status', 'completed', 'sale_id', v_res ->> 'sale_id',
                            'number', (v_res ->> 'number')::bigint, 'total', v_res -> 'total');
end;
$$;
revoke all on function _pc_complete(uuid, uuid, text, boolean) from public, anon, authenticated;
