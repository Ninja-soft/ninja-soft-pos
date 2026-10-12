-- =============================================================================
-- 20261011200200_cuenta_corriente_v2_reversas  (H31 · Cuenta corriente v2)
--
-- Parte 3 de 3. Corrige el BUG de datos: anular / devolver una venta hecha en
-- cuenta corriente NO revertía la deuda.
--
--  A) account_reverse_sale(): reversa (total o parcial) de los cargos de una
--     venta, de la última cuota a la primera; en la anulación también condona
--     los punitorios abiertos de esos cargos. Libera imputaciones si hace falta
--     y reimputa el crédito liberado (account_reconcile).
--  B) Anulación (void_sale, SECURITY INVOKER, no se redefine): trigger AFTER
--     UPDATE OF status en sales → reversa total.
--  C) Devoluciones: return_sale y return_sale_v2 se reproducen COMPLETAS desde
--     su última versión (20260608690000_account_enforcement_qr_validate). Único
--     cambio: la parte de lo devuelto que se pagó con cuenta corriente vuelve a
--     la cuenta (reversa) en vez de salir en efectivo, y se acepta el reintegro
--     'account' (todo a la cuenta). El vale (store_credit) queda igual.
--  D) Cambio (exchange_sale) NO se redefine: fuerza 'store_credit' en la
--     devolución y aplica ese crédito a la mercadería nueva, así que la deuda
--     original sigue correspondiendo (el cliente se lleva otra cosa por el mismo
--     valor). Ver ADR-037.
--  E) close_cash_shift se reproduce completa (última versión:
--     20260531220000_pos_settings_pr2) agregando al Z los cobros de cuenta
--     corriente del turno por medio (cash_z_closures.account_collected).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Reversa de los cargos de una venta
-- -----------------------------------------------------------------------------
create or replace function account_reverse_sale(
  p_sale_id uuid, p_amount numeric, p_reason text, p_waive_interest boolean default false
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_left  numeric := coalesce(p_amount, 1e15);
  v_total numeric := 0;
  v_done  numeric;
  v_cust  uuid;
  v_tenant uuid;
  ch      record;
  it      record;
begin
  select m.customer_id, m.tenant_id into v_cust, v_tenant
    from customer_account_movements m
   where m.sale_id = p_sale_id and m.kind = 'charge'
   limit 1;
  if v_cust is null then
    return 0;
  end if;
  perform 1 from customers where id = v_cust for update;

  for ch in
    select * from customer_account_movements m
     where m.sale_id = p_sale_id and m.kind = 'charge' and m.voided_at is null
     order by coalesce(m.installment_no, 1) desc, m.created_at desc, m.id desc
  loop
    exit when v_left <= 0;
    v_done := account_reverse_debit(ch.id, v_left, p_reason, 'reversal');
    v_total := v_total + v_done;
    v_left := v_left - v_done;

    if p_waive_interest then
      for it in
        select od.id, od.open_amount from account_open_debits(v_tenant, v_cust) od
         where od.kind = 'interest' and od.parent_id = ch.id
      loop
        perform account_reverse_debit(it.id, it.open_amount, p_reason, 'interest_waiver');
      end loop;
    end if;
  end loop;

  perform account_reconcile(v_cust);

  if v_total > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
    values (v_tenant, auth.uid(), 'sales', p_sale_id, 'account_sale_reversed', p_reason,
            jsonb_build_object('customer_id', v_cust, 'amount', v_total,
                               'interest_waived', p_waive_interest));
  end if;
  return v_total;
end;
$$;
revoke all on function account_reverse_sale(uuid, numeric, text, boolean) from public, anon, authenticated;
grant execute on function account_reverse_sale(uuid, numeric, text, boolean) to service_role;

-- Parte de una devolución que vuelve a la cuenta corriente.
--  · p_all = false (reintegro en efectivo): lo pagado con cuenta en esa venta,
--    proporcional (cuenta / total de la venta), con tope en lo que la venta
--    todavía tiene cargado en la cuenta.
--  · p_all = true (reintegro 'account'): todo lo devuelto; si supera lo
--    cargado de la venta, el excedente queda como saldo a favor (ajuste crédito).
-- Devuelve el monto acreditado en la cuenta.
create or replace function account_return_credit(
  p_sale_id uuid, p_total numeric, p_all boolean, p_reason text
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale     sales%rowtype;
  v_acc_paid numeric;
  v_net      numeric;
  v_share    numeric;
  v_rev      numeric := 0;
  v_cust     uuid;
begin
  select * into v_sale from sales where id = p_sale_id;
  select coalesce(sum(amount), 0) into v_acc_paid
    from payments where sale_id = p_sale_id and method = 'account';
  if v_acc_paid <= 0 then
    if p_all then
      raise exception 'refund_account_not_allowed';
    end if;
    return 0;
  end if;

  select coalesce(sum(m.delta), 0)
         + coalesce((select sum(r.delta) from customer_account_movements r
                      join customer_account_movements c2 on c2.id = r.parent_id
                     where c2.sale_id = p_sale_id and c2.kind = 'charge'
                       and r.kind = 'reversal' and r.voided_at is null), 0)
    into v_net
    from customer_account_movements m
   where m.sale_id = p_sale_id and m.kind = 'charge' and m.voided_at is null;
  v_net := greatest(coalesce(v_net, 0), 0);
  select m.customer_id into v_cust
    from customer_account_movements m
   where m.sale_id = p_sale_id and m.kind = 'charge'
   limit 1;

  if p_all then
    v_share := round(p_total, 2);
  else
    v_share := least(round(p_total * v_acc_paid / nullif(v_sale.total, 0), 2), v_net);
  end if;
  if coalesce(v_share, 0) <= 0 then
    return 0;
  end if;

  if v_net > 0 then
    v_rev := account_reverse_sale(p_sale_id, least(v_share, v_net), p_reason, false);
  end if;

  if p_all and v_share - v_rev > 0.004 then
    v_cust := coalesce(v_cust, v_sale.customer_id);
    insert into customer_account_movements (tenant_id, customer_id, kind, delta, sale_id, reason, note, created_by)
    values (v_sale.tenant_id, v_cust, 'adjust_credit', -(v_share - v_rev), p_sale_id,
            'Devolución a cuenta', p_reason, auth.uid());
    perform account_reconcile(v_cust);
    return v_share;
  end if;
  return v_rev;
end;
$$;
revoke all on function account_return_credit(uuid, numeric, boolean, text) from public, anon, authenticated;
grant execute on function account_return_credit(uuid, numeric, boolean, text) to service_role;

-- -----------------------------------------------------------------------------
-- B) Anulación de venta → reversa total (+ condonación de punitorios abiertos)
-- -----------------------------------------------------------------------------
create or replace function trg_sales_account_void()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from customer_account_movements
              where sale_id = new.id and tenant_id = new.tenant_id and kind = 'charge') then
    perform account_reverse_sale(new.id, null, 'Anulación venta #' || new.number, true);
  end if;
  return new;
end;
$$;
revoke all on function trg_sales_account_void() from public, anon, authenticated;

drop trigger if exists sales_account_void on sales;
create trigger sales_account_void
  after update of status on sales
  for each row
  when (new.status = 'voided' and old.status is distinct from 'voided')
  execute function trg_sales_account_void();

-- -----------------------------------------------------------------------------
-- C) Devoluciones (reproducidas completas; cambios marcados "CC v2")
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
  -- CC v2: parte acreditada en la cuenta corriente.
  v_acc    numeric := 0;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  -- CC v2: se acepta el reintegro a la cuenta corriente.
  if p_refund not in ('cash','store_credit','account') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;
  if p_refund = 'store_credit' and v_sale.customer_id is null then
    raise exception 'store_credit_needs_customer';
  end if;
  if p_refund = 'account' and v_sale.customer_id is null then
    raise exception 'account_needs_customer';
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

  -- CC v2: lo pagado con cuenta corriente vuelve a la cuenta (no en efectivo);
  -- con reintegro 'account' vuelve todo a la cuenta.
  if p_refund in ('cash', 'account') then
    v_acc := account_return_credit(p_sale_id, v_total, p_refund = 'account',
                                   'Devolución #' || v_number || ' venta #' || v_sale.number);
    update sale_returns
       set account_credited = v_acc,
           refund_method = case when p_refund = 'account' or v_acc >= v_total then 'account' else refund_method end
     where id = v_ret;
  end if;

  if p_refund = 'cash' then
    if v_total - v_acc > 0 then
      insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
      values (v_shift, 'expense', v_total - v_acc, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
    end if;
  elsif p_refund = 'store_credit' then
    insert into store_credit_movements (customer_id, delta, reason, sale_return_id)
    values (v_sale.customer_id, v_total, 'Devolución venta #' || v_sale.number, v_ret);
  end if;

  return jsonb_build_object('return_id', v_ret, 'number', v_number, 'total', v_total,
                            'account_credited', v_acc,
                            'cash_refund', case when p_refund = 'cash' then v_total - v_acc else 0 end);
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
  -- CC v2: parte acreditada en la cuenta corriente.
  v_acc      numeric := 0;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- BUG A — no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  -- CC v2: se acepta el reintegro a la cuenta corriente.
  if p_refund not in ('cash','store_credit','account') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;

  select coalesce(return_policy, 'cashier_choice'), voucher_validity_months
    into v_policy, v_validity
  from pos_settings where tenant_id = v_tenant;
  if not found then v_policy := 'cashier_choice'; end if;

  v_refund := p_refund;
  -- CC v2: el reintegro a la cuenta corriente (cancelar deuda) no lo pisa la
  -- política de devoluciones (que rige efectivo vs vale).
  if v_refund <> 'account' then
    if v_policy = 'always_credit' then v_refund := 'store_credit';
    elsif v_policy = 'always_cash' then v_refund := 'cash';
    end if;
  end if;

  v_customer := coalesce(v_sale.customer_id, p_customer_id);
  if v_refund = 'store_credit' and v_customer is null then
    raise exception 'store_credit_needs_customer';
  end if;
  if v_refund = 'account' and v_sale.customer_id is null then
    raise exception 'account_needs_customer';
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

  -- CC v2: lo pagado con cuenta corriente vuelve a la cuenta (no en efectivo);
  -- con reintegro 'account' vuelve todo a la cuenta. El vale no cambia (el
  -- cambio de mercadería lo usa y la deuda original sigue correspondiendo).
  if v_refund in ('cash', 'account') then
    v_acc := account_return_credit(p_sale_id, v_total, v_refund = 'account',
                                   'Devolución #' || v_number || ' venta #' || v_sale.number);
    update sale_returns
       set account_credited = v_acc,
           refund_method = case when v_refund = 'account' or v_acc >= v_total then 'account' else refund_method end
     where id = v_ret;
  end if;

  if v_refund = 'cash' then
    if v_total - v_acc > 0 then
      insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
      values (v_shift, 'expense', v_total - v_acc, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
    end if;
  elsif v_refund = 'store_credit' then
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
    'voucher_code', v_voucher_code, 'voucher_expires_at', v_expires,
    'account_credited', v_acc,
    'cash_refund', case when v_refund = 'cash' then v_total - v_acc else 0 end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- E) close_cash_shift (reproducida completa; cambio marcado "CC v2")
-- -----------------------------------------------------------------------------
create or replace function close_cash_shift(
  p_shift_id       uuid,
  p_closing_amount numeric,
  p_notes          text default null
)
returns numeric
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening    numeric;
  v_expected   numeric;
  v_diff       numeric;
  v_store      uuid;
  v_opened_at  timestamptz;
  v_opened_by  uuid;
  v_znum       bigint;
  v_sales_count   integer;
  v_sales_total   numeric;
  v_disc_total    numeric;
  v_voids_count   integer;
  v_voids_total   numeric;
  v_cash_in    numeric;
  v_cash_out   numeric;
  v_breakdown  jsonb;
  v_req        boolean;
  v_tol        numeric;
  v_account    jsonb;
begin
  select cs.opening_amount, cs.opened_at, cs.opened_by, cr.store_id
    into v_opening, v_opened_at, v_opened_by, v_store
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.id = p_shift_id and cs.tenant_id = current_tenant_id() and cs.status = 'open';
  if v_opening is null then
    raise exception 'shift_not_open';
  end if;

  select v_opening
       + coalesce(sum(case when type = 'income' then amount
                           when type = 'expense' then -amount
                           when type = 'sale' and payment_method = 'cash' then amount
                           when type = 'sale_void' and payment_method = 'cash' then -amount
                           else 0 end), 0)
    into v_expected
  from cash_movements
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  v_diff := p_closing_amount - v_expected;

  -- Motivo obligatorio si la diferencia supera la tolerancia (si está activado).
  select require_close_reason, close_tolerance into v_req, v_tol
  from pos_settings where tenant_id = current_tenant_id();
  if coalesce(v_req, false)
     and abs(v_diff) > coalesce(v_tol, 0)
     and (p_notes is null or btrim(p_notes) = '') then
    raise exception 'close_needs_reason';
  end if;

  update cash_shifts
     set status = 'closed',
         closed_at = now(),
         closed_by = auth.uid(),
         expected_amount = v_expected,
         closing_amount = p_closing_amount,
         notes = p_notes
   where id = p_shift_id and tenant_id = current_tenant_id();

  select count(*) filter (where status = 'completed'),
         coalesce(sum(total) filter (where status = 'completed'), 0),
         coalesce(sum(discount_total) filter (where status = 'completed'), 0),
         count(*) filter (where status = 'voided'),
         coalesce(sum(total) filter (where status = 'voided'), 0)
    into v_sales_count, v_sales_total, v_disc_total, v_voids_count, v_voids_total
  from sales
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  select coalesce(sum(amount) filter (where type = 'income'), 0),
         coalesce(sum(amount) filter (where type = 'expense'), 0)
    into v_cash_in, v_cash_out
  from cash_movements
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  select coalesce(jsonb_object_agg(payment_method, t), '{}'::jsonb)
    into v_breakdown
  from (
    select payment_method, sum(amount) as t
    from cash_movements
    where cash_shift_id = p_shift_id and tenant_id = current_tenant_id()
      and type = 'sale' and payment_method is not null
    group by payment_method
  ) s;

  -- CC v2: cobros de cuenta corriente del turno por medio (los de efectivo ya
  -- están en cash_in y en el esperado; acá se informan todos).
  select coalesce(jsonb_object_agg(method, t), '{}'::jsonb)
    into v_account
  from (
    select m.method, round(sum(-m.delta), 2) as t
    from customer_account_movements m
    where m.cash_shift_id = p_shift_id and m.tenant_id = current_tenant_id()
      and m.kind = 'payment' and m.voided_at is null and m.method is not null
    group by m.method
  ) a;

  select coalesce(max(z_number), 0) + 1 into v_znum
  from cash_z_closures where tenant_id = current_tenant_id();

  insert into cash_z_closures (
    store_id, cash_shift_id, z_number, opened_at, closed_at, opened_by, closed_by,
    opening_amount, closing_amount, expected_amount, difference,
    sales_count, sales_total, discounts_total, voids_count, voids_total,
    cash_in, cash_out, payment_breakdown, account_collected
  ) values (
    v_store, p_shift_id, v_znum, v_opened_at, now(), v_opened_by, auth.uid(),
    v_opening, p_closing_amount, v_expected, v_diff,
    v_sales_count, v_sales_total, v_disc_total, v_voids_count, v_voids_total,
    v_cash_in, v_cash_out, v_breakdown, v_account
  )
  on conflict (cash_shift_id) do nothing;

  return v_diff;
end;
$$;
