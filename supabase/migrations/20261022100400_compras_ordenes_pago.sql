-- =============================================================================
-- 20261022100400_compras_ordenes_pago  (F18 · H101 + H106 + H111, ADR-059)
--
-- Órdenes de pago: pagan uno o varios comprobantes del proveedor (imputación),
-- admiten pagos parciales y lo no imputado queda a cuenta (anticipo). La OP es
-- un supplier_payments con kind = 'order' (misma numeración OP- y misma cuenta
-- corriente) más:
--   • supplier_payment_lines: medios. Efectivo de la caja propia (retiro en el
--     turno abierto de quien paga, con las reglas de propiedad de ADR-051 y el
--     PIN de retiro si la política lo pide), transferencia desde una cuenta
--     bancaria de tesorería, cheque propio o e-cheq (nace 'entregado'), cheque
--     de terceros en cartera (se endosa: pasa a 'entregado'), depósito, tarjeta
--     u otro. Mover una cuenta o un cheque exige la feature tesoreria; sin ella
--     la transferencia queda sólo con su referencia (igual que v1).
--   • withholdings (jsonb existente): retenciones practicadas de IVA,
--     Ganancias e IIBB con n° de certificado (placeholder hasta H106).
--   • supplier_payment_allocations: imputación en pesos a facturas y notas de
--     débito vigentes del proveedor, nunca más que su saldo abierto ni más que
--     el total de la OP. Espejo puro en lib/purchases/paymentOrders.ts.
-- Anular una OP (supplier_payment_void, recreada) libera la imputación,
-- devuelve el efectivo a la caja propia abierta de quien anula (ingreso),
-- revierte los movimientos de tesorería, vuelve a cartera los cheques de
-- terceros endosados y anula los propios. Un cheque ya depositado o rechazado
-- bloquea la anulación.
--
-- Además:
--   • supplier_invoice_open: saldo abierto por comprobante (vista con la RLS de
--     quien consulta).
--   • treasury_receivables: deuda de clientes en cuenta corriente por
--     vencimiento, para el flujo de fondos proyectado.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Cabecera, medios e imputación.
-- -----------------------------------------------------------------------------
alter table supplier_payments add column if not exists kind text not null default 'simple';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_payments_kind_check') then
    alter table supplier_payments add constraint supplier_payments_kind_check check (kind in ('simple', 'order'));
  end if;
end $$;

alter table supplier_payments drop constraint if exists supplier_payments_method_check;
alter table supplier_payments add constraint supplier_payments_method_check
  check (method in ('efectivo','transferencia','cheque','echeq','tarjeta','deposito','otro','mixto'))
  not valid;

create table if not exists supplier_payment_lines (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  payment_id           uuid not null references supplier_payments(id) on delete cascade,
  method               text not null check (method in ('efectivo','transferencia','cheque_propio','cheque_tercero',
                                                       'echeq','deposito','tarjeta','otro')),
  amount               numeric(14,2) not null check (amount > 0),
  reference            text check (reference is null or char_length(reference) <= 120),
  cash_shift_id        uuid references cash_shifts(id),
  cash_movement_id     uuid,
  treasury_account_id  uuid references treasury_accounts(id),
  treasury_movement_id uuid references treasury_movements(id),
  cheque_id            uuid references cheques(id),
  sort                 int not null default 0,
  created_at           timestamptz not null default now()
);

create index if not exists supplier_payment_lines_payment_idx on supplier_payment_lines(payment_id, sort);
create index if not exists supplier_payment_lines_tenant_idx on supplier_payment_lines(tenant_id);

create table if not exists supplier_payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  payment_id  uuid not null references supplier_payments(id) on delete cascade,
  invoice_id  uuid not null references supplier_invoices(id),
  amount      numeric(14,2) not null check (amount > 0),
  created_at  timestamptz not null default now(),
  released_at timestamptz
);

comment on table supplier_payment_allocations is
  'Imputación de una orden de pago a comprobantes del proveedor, en pesos (F18, ADR-059). released_at = liberada por anulación.';

create index if not exists supplier_payment_allocations_payment_idx on supplier_payment_allocations(payment_id);
create index if not exists supplier_payment_allocations_invoice_idx
  on supplier_payment_allocations(invoice_id) where released_at is null;
create index if not exists supplier_payment_allocations_tenant_idx on supplier_payment_allocations(tenant_id);

alter table cheques drop constraint if exists cheques_payment_fkey;
alter table cheques add constraint cheques_payment_fkey foreign key (payment_id) references supplier_payments(id);

alter table supplier_payment_lines enable row level security;
alter table supplier_payment_allocations enable row level security;

drop policy if exists supplier_payment_lines_select on supplier_payment_lines;
create policy supplier_payment_lines_select on supplier_payment_lines
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists supplier_payment_allocations_select on supplier_payment_allocations;
create policy supplier_payment_allocations_select on supplier_payment_allocations
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- Saldo abierto de cada comprobante de deuda (en pesos al TC del comprobante).
create or replace view supplier_invoice_open
with (security_invoker = true) as
  select i.tenant_id, i.id as invoice_id, i.supplier_id, i.kind, i.letter, i.point_of_sale, i.number,
         i.issue_date, coalesce(i.due_date, i.issue_date) as due_date, i.currency, i.fx_rate,
         round(i.total * i.fx_rate, 2) as amount_ars,
         coalesce(sum(a.amount), 0)::numeric(14,2) as allocated_ars,
         (round(i.total * i.fx_rate, 2) - coalesce(sum(a.amount), 0))::numeric(14,2) as open_ars
    from supplier_invoices i
    left join supplier_payment_allocations a on a.invoice_id = i.id and a.released_at is null
   where i.status = 'posted' and i.kind in ('invoice', 'debit_note')
   group by i.id;

revoke all on supplier_invoice_open from anon;
grant select on supplier_invoice_open to authenticated;

-- Retención: kind, certificado y monto (lista blanca de jurisdicción libre).
create or replace function purchase_withholdings_total(p_wh jsonb)
returns numeric
language plpgsql
immutable
as $$
declare
  v_line record;
  v_tot  numeric := 0;
begin
  if p_wh is null then
    return 0;
  end if;
  if jsonb_typeof(p_wh) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  for v_line in
    select x.kind, x.certificate, x.amount
      from jsonb_to_recordset(p_wh) as x(kind text, certificate text, amount numeric)
  loop
    if coalesce(v_line.amount, 0) < 0 then
      raise exception 'invalid_amount';
    end if;
    if v_line.kind is null or v_line.kind not in ('ganancias', 'iva', 'iibb', 'suss', 'otro') then
      raise exception 'invalid_withholding';
    end if;
    if char_length(coalesce(v_line.certificate, '')) > 40 then
      raise exception 'invalid_withholding';
    end if;
    v_tot := v_tot + round(coalesce(v_line.amount, 0), 2);
  end loop;
  return v_tot;
end;
$$;

-- -----------------------------------------------------------------------------
-- B) Alta de la orden de pago.
--    p: {supplier_id, paid_date?, notes?,
--        lines: [{method, amount, reference?, treasury_account_id?,
--                 cash_shift_id?, cheque_id? (terceros),
--                 cheque?: {number, bank_name?, issue_date?, payment_date}}],
--        withholdings: [{kind, description?, certificate?, amount}],
--        allocations: [{invoice_id, amount}]}
-- -----------------------------------------------------------------------------
create or replace function supplier_payment_order_create(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := purchase_assert(true);
  v_tes      boolean;
  v_sup      suppliers;
  v_date     date := coalesce((nullif(p ->> 'paid_date', ''))::date, current_date);
  v_wh       jsonb := coalesce(p -> 'withholdings', '[]'::jsonb);
  v_whtot    numeric;
  v_net      numeric := 0;
  v_alloc    numeric := 0;
  v_line     record;
  v_al       record;
  v_open     numeric;
  v_inv      supplier_invoices;
  v_number   int;
  v_pay      uuid;
  v_label    text;
  v_methods  text[] := '{}';
  v_method   text;
  v_shift    uuid;
  v_cash     uuid;
  v_acc      treasury_accounts;
  v_tmov     uuid;
  v_cheque   uuid;
  v_ch       cheques;
  v_sort     int := 0;
begin
  select * into v_sup from suppliers
   where id = (p ->> 'supplier_id')::uuid and tenant_id = v_tenant and deleted_at is null;
  if v_sup.id is null then
    raise exception 'supplier_not_found';
  end if;
  if p -> 'lines' is null or jsonb_typeof(p -> 'lines') <> 'array' then
    raise exception 'invalid_lines';
  end if;
  if p -> 'allocations' is not null and jsonb_typeof(p -> 'allocations') <> 'array' then
    raise exception 'invalid_lines';
  end if;
  v_tes := tenant_has_feature_for(v_tenant, 'tesoreria');
  v_whtot := purchase_withholdings_total(v_wh);

  for v_line in
    select x.method, round(coalesce(x.amount, 0), 2) as amount
      from jsonb_to_recordset(p -> 'lines') as x(method text, amount numeric)
  loop
    if v_line.amount <= 0 then
      raise exception 'invalid_amount';
    end if;
    v_net := v_net + v_line.amount;
    if not v_line.method = any (v_methods) then
      v_methods := v_methods || v_line.method;
    end if;
  end loop;
  if v_net + v_whtot <= 0 then
    raise exception 'invalid_amount';
  end if;

  v_method := case
    when array_length(v_methods, 1) is null then 'otro'
    when array_length(v_methods, 1) > 1 then 'mixto'
    when v_methods[1] in ('cheque_propio', 'cheque_tercero') then 'cheque'
    else v_methods[1]
  end;

  perform pg_advisory_xact_lock(hashtext('supplier_payment_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from supplier_payments where tenant_id = v_tenant;
  v_label := 'OP-' || lpad(v_number::text, 6, '0');

  insert into supplier_payments (tenant_id, number, supplier_id, paid_date, method, reference, currency, fx_rate,
                                 amount, withholdings, withholdings_total, net_paid, notes, kind, created_by)
  values (v_tenant, v_number, v_sup.id, v_date, v_method, null, 'ARS', 1, v_net + v_whtot, v_wh, v_whtot, v_net,
          nullif(trim(coalesce(p ->> 'notes', '')), ''), 'order', auth.uid())
  returning id into v_pay;

  -- Medios.
  for v_line in
    select x.method, round(coalesce(x.amount, 0), 2) as amount,
           nullif(trim(coalesce(x.reference, '')), '') as reference,
           x.treasury_account_id, x.cash_shift_id, x.cheque_id, x.cheque
      from jsonb_to_recordset(p -> 'lines')
        as x(method text, amount numeric, reference text, treasury_account_id uuid, cash_shift_id uuid,
             cheque_id uuid, cheque jsonb)
  loop
    v_shift := null; v_cash := null; v_tmov := null; v_cheque := null; v_acc := null;

    if v_line.method = 'efectivo' then
      -- Retiro de la caja propia: el turno abierto de quien paga (ADR-051).
      v_shift := coalesce(v_line.cash_shift_id, (
        select cs.id from cash_shifts cs
         where cs.tenant_id = v_tenant and cs.status = 'open' and cs.opened_by = auth.uid()
         order by cs.opened_at desc limit 1));
      if v_shift is null then
        raise exception 'cash_shift_required';
      end if;
      perform assert_staff_operational();
      perform assert_shift_owner(v_shift, 'cash_out');
      perform require_supervisor('cash_out', v_line.amount, v_shift);
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id,
                                  created_by)
      values (v_tenant, v_shift, 'expense', v_line.amount, 'cash',
              'Orden de pago ' || v_label || ' · ' || v_sup.name, v_pay, auth.uid())
      returning id into v_cash;

    elsif v_line.method in ('transferencia', 'deposito') and v_line.treasury_account_id is not null then
      if not v_tes then
        raise exception 'feature_not_in_plan: tesoreria';
      end if;
      v_acc := treasury_account_get(v_tenant, v_line.treasury_account_id);
      v_tmov := _treasury_move(v_tenant, v_acc.id, v_date, -v_line.amount, 'supplier_payment',
                               'Orden de pago ' || v_label || ' · ' || v_sup.name, 'supplier_payment', v_pay);

    elsif v_line.method in ('cheque_propio', 'echeq') then
      if not v_tes then
        raise exception 'feature_not_in_plan: tesoreria';
      end if;
      v_acc := treasury_account_get(v_tenant, v_line.treasury_account_id);
      if v_acc.kind <> 'bank' then
        raise exception 'bank_account_required';
      end if;
      if v_line.cheque is null or nullif(trim(coalesce(v_line.cheque ->> 'number', '')), '') is null
         or nullif(v_line.cheque ->> 'payment_date', '') is null then
        raise exception 'cheque_data_required';
      end if;
      insert into cheques (tenant_id, kind, is_echeq, number, bank_name, issue_date, payment_date, amount, status,
                           account_id, delivered_to_supplier_id, payment_id, created_by)
      values (v_tenant, 'own', v_line.method = 'echeq', trim(v_line.cheque ->> 'number'),
              coalesce(nullif(trim(coalesce(v_line.cheque ->> 'bank_name', '')), ''), v_acc.bank_name),
              coalesce((nullif(v_line.cheque ->> 'issue_date', ''))::date, v_date),
              (v_line.cheque ->> 'payment_date')::date, v_line.amount, 'entregado', v_acc.id, v_sup.id, v_pay,
              auth.uid())
      returning id into v_cheque;

    elsif v_line.method = 'cheque_tercero' then
      if not v_tes then
        raise exception 'feature_not_in_plan: tesoreria';
      end if;
      select * into v_ch from cheques
       where id = v_line.cheque_id and tenant_id = v_tenant
       for update;
      if v_ch.id is null then
        raise exception 'cheque_not_found';
      end if;
      if v_ch.kind <> 'third_party' or v_ch.status <> 'en_cartera' then
        raise exception 'cheque_not_available';
      end if;
      if abs(v_ch.amount - v_line.amount) > 0.004 then
        raise exception 'cheque_amount_mismatch';
      end if;
      update cheques set status = 'entregado', delivered_to_supplier_id = v_sup.id, payment_id = v_pay
       where id = v_ch.id;
      v_cheque := v_ch.id;

    elsif v_line.method not in ('transferencia', 'deposito', 'tarjeta', 'otro') then
      raise exception 'invalid_payment_method';
    end if;

    v_sort := v_sort + 1;
    insert into supplier_payment_lines (tenant_id, payment_id, method, amount, reference, cash_shift_id,
                                        cash_movement_id, treasury_account_id, treasury_movement_id, cheque_id, sort)
    values (v_tenant, v_pay, v_line.method, v_line.amount, v_line.reference, v_shift, v_cash, v_acc.id, v_tmov,
            v_cheque, v_sort);
  end loop;

  -- Imputación.
  for v_al in
    select x.invoice_id, round(coalesce(x.amount, 0), 2) as amount
      from jsonb_to_recordset(coalesce(p -> 'allocations', '[]'::jsonb)) as x(invoice_id uuid, amount numeric)
  loop
    continue when v_al.amount = 0;
    if v_al.amount < 0 then
      raise exception 'invalid_amount';
    end if;
    select * into v_inv from supplier_invoices
     where id = v_al.invoice_id and tenant_id = v_tenant
     for update;
    if v_inv.id is null or v_inv.status <> 'posted' or v_inv.supplier_id <> v_sup.id
       or v_inv.kind not in ('invoice', 'debit_note') then
      raise exception 'invoice_not_allocatable';
    end if;
    select round(v_inv.total * v_inv.fx_rate, 2) - coalesce(sum(a.amount), 0) into v_open
      from supplier_payment_allocations a
     where a.invoice_id = v_inv.id and a.released_at is null;
    if v_al.amount > v_open + 0.005 then
      raise exception 'allocation_exceeds_open';
    end if;
    insert into supplier_payment_allocations (tenant_id, payment_id, invoice_id, amount)
    values (v_tenant, v_pay, v_inv.id, v_al.amount);
    v_alloc := v_alloc + v_al.amount;
  end loop;
  if v_alloc > v_net + v_whtot + 0.005 then
    raise exception 'allocation_exceeds_payment';
  end if;

  perform purchase_log(v_tenant, 'payment', v_pay, 'created', null, 'posted', p ->> 'notes',
                       jsonb_build_object('number', v_number, 'supplier_id', v_sup.id, 'kind', 'order',
                                          'amount', v_net + v_whtot, 'net_paid', v_net,
                                          'withholdings_total', v_whtot, 'allocated', v_alloc,
                                          'on_account', v_net + v_whtot - v_alloc, 'method', v_method));
  return v_pay;
end;
$$;
revoke all on function supplier_payment_order_create(jsonb) from public, anon;
grant execute on function supplier_payment_order_create(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Anulación (recreada desde 20261016100300): libera la imputación y
--    revierte efectivo, tesorería y cheques.
-- -----------------------------------------------------------------------------
create or replace function supplier_payment_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_pay    supplier_payments;
  v_line   supplier_payment_lines;
  v_ch     cheques;
  v_shift  uuid;
  v_label  text;
  v_tm     treasury_movements;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_pay from supplier_payments where id = p_id and tenant_id = v_tenant for update;
  if v_pay.id is null then
    raise exception 'payment_not_found';
  end if;
  if v_pay.status <> 'posted' then
    raise exception 'payment_voided';
  end if;
  v_label := 'OP-' || lpad(v_pay.number::text, 6, '0');

  -- Cheques: ninguno puede estar depositado o rechazado.
  if exists (
    select 1 from supplier_payment_lines l join cheques c on c.id = l.cheque_id
     where l.payment_id = v_pay.id and c.status not in ('entregado')
  ) then
    raise exception 'payment_cheque_used';
  end if;

  for v_line in select * from supplier_payment_lines where payment_id = v_pay.id order by sort loop
    if v_line.cash_movement_id is not null then
      -- El efectivo vuelve a la caja propia abierta de quien anula.
      v_shift := (select cs.id from cash_shifts cs
                   where cs.tenant_id = v_tenant and cs.status = 'open' and cs.opened_by = auth.uid()
                   order by (cs.id = v_line.cash_shift_id) desc, cs.opened_at desc limit 1);
      if v_shift is null then
        raise exception 'cash_shift_required';
      end if;
      perform assert_shift_owner(v_shift, 'cash_in');
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id,
                                  created_by)
      values (v_tenant, v_shift, 'income', v_line.amount, 'cash', 'Anulación ' || v_label, v_pay.id, auth.uid());
    end if;

    if v_line.treasury_movement_id is not null then
      select * into v_tm from treasury_movements where id = v_line.treasury_movement_id;
      perform _treasury_move(v_tenant, v_tm.account_id, current_date, -v_tm.amount, 'supplier_payment_void',
                             'Anulación ' || v_label, 'supplier_payment', v_pay.id);
    end if;

    if v_line.cheque_id is not null then
      select * into v_ch from cheques where id = v_line.cheque_id for update;
      if v_ch.kind = 'third_party' then
        update cheques set status = 'en_cartera', delivered_to_supplier_id = null, payment_id = null
         where id = v_ch.id;
      else
        update cheques set status = 'anulado' where id = v_ch.id;
      end if;
    end if;
  end loop;

  update supplier_payment_allocations set released_at = now()
   where payment_id = v_pay.id and released_at is null;

  update supplier_payments
     set status = 'voided', void_reason = trim(p_reason), voided_at = now(), voided_by = auth.uid()
   where id = p_id;
  perform purchase_log(v_tenant, 'payment', p_id, 'voided', 'posted', 'voided', p_reason,
                       jsonb_build_object('amount', v_pay.amount, 'kind', v_pay.kind));
end;
$$;
revoke all on function supplier_payment_void(uuid, text) from public, anon;
grant execute on function supplier_payment_void(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Flujo de fondos: deuda de clientes en cuenta corriente por vencimiento
--    (los comprobantes de proveedor y los cheques los arma el cliente con
--    supplier_invoice_open, la imputación y cheques).
-- -----------------------------------------------------------------------------
create or replace function treasury_receivables(p_to date)
returns table (due_date date, amount numeric, docs int)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
begin
  return query
    with debits as (
      select m.id, coalesce(m.due_date, (m.created_at at time zone 'America/Argentina/Buenos_Aires')::date) as due,
             m.delta - coalesce((select sum(a.amount) from customer_account_allocations a
                                  where a.charge_id = m.id and a.released_at is null), 0) as open
        from customer_account_movements m
       where m.tenant_id = v_tenant
         and m.kind in ('charge', 'interest', 'adjust_debit')
         and m.voided_at is null
         and m.delta > 0
    )
    select d.due, round(sum(d.open), 2), count(*)::int
      from debits d
     where d.open > 0.004 and d.due <= p_to
     group by d.due
     order by d.due;
end;
$$;
revoke all on function treasury_receivables(date) from public, anon;
grant execute on function treasury_receivables(date) to authenticated;
