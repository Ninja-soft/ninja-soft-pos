-- =============================================================================
-- 20261011200100_cuenta_corriente_v2_rpc  (H31 · Cuenta corriente v2: lógica)
--
-- Parte 2 de 3. Todas las escrituras del ledger pasan por acá (security
-- definer + chequeo de tenant, rol, plan y audit_logs).
--
-- Lógica ESPEJO de lib/account/*.ts (mismos casos en tests/unit/account-*.ts):
--   account_due_date / account_add_months   ↔ terms.ts
--   account_interest_calc                    ↔ interest.ts (accrueInterest)
--   account_reconcile (orden de imputación)  ↔ allocation.ts (defaultOrder)
--   account_aging (tramos)                   ↔ aging.ts
--
-- Casos fijos (los mismos que los tests):
--   due(2026-10-11, días 30)                         = 2026-11-10
--   due(2026-10-25, corte 25 / vto 10)               = 2026-11-10
--   due(2026-10-26, corte 25 / vto 10)               = 2026-12-10
--   cuotas(100, 3)                                   = 33.33 / 33.33 / 33.34
--   interés mensual simple 3%, vto 10/10, gracia 5:
--     al 16/10 → período 2026-10-16, 1 unidad, 30.00 sobre 1000
--     al 20/11 → período 2026-11-16, 2 unidades, 60.00
--   compuesto 2 unidades sobre 1000 al 3% = 60.90
--   tope 50% con 490 liquidados → 10.00
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Fechas y plazos
-- -----------------------------------------------------------------------------

-- Suma meses recortando el día al último del mes (31/01 + 1 → 28/02). Con
-- p_day fija el día destino (también recortado).
create or replace function account_add_months(p_date date, p_months int, p_day int default null)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_first date;
  v_last  int;
begin
  v_first := (date_trunc('month', p_date::timestamp) + make_interval(months => p_months))::date;
  v_last  := extract(day from (v_first + interval '1 month' - interval '1 day'))::int;
  return v_first + (least(coalesce(p_day, extract(day from p_date)::int), v_last) - 1);
end;
$$;

-- Vencimiento de una compra a cuenta según los plazos (config.terms).
create or replace function account_due_date(p_date date, p_terms jsonb)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_mode   text := coalesce(p_terms ->> 'mode', 'days');
  v_cutoff int  := coalesce((p_terms ->> 'cutoff_day')::int, 25);
  v_dueday int  := coalesce((p_terms ->> 'due_day')::int, 10);
  v_days   int  := greatest(0, coalesce((p_terms ->> 'days')::int, 30));
begin
  if v_mode = 'monthly_cutoff' then
    return account_add_months(
      p_date,
      case when extract(day from p_date)::int <= v_cutoff then 1 else 2 end,
      v_dueday);
  end if;
  return p_date + v_days;
end;
$$;

-- Hoy en Argentina (los vencimientos son fechas de negocio locales).
create or replace function account_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (now() at time zone 'America/Argentina/Buenos_Aires')::date;
$$;

-- -----------------------------------------------------------------------------
-- 2) Saldos, partidas abiertas y créditos sin imputar
-- -----------------------------------------------------------------------------

-- Débitos (cargo / interés / ajuste débito) con saldo abierto.
-- abierto = monto − imputaciones vigentes − reversas/condonaciones hijas.
create or replace function account_open_debits(p_tenant uuid, p_customer uuid default null)
returns table (
  id uuid, customer_id uuid, kind text, due_date date, created_at timestamptz,
  sale_id uuid, installment_no int, installments int, parent_id uuid,
  amount numeric, open_amount numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id, m.customer_id, m.kind, m.due_date, m.created_at,
         m.sale_id, m.installment_no, m.installments, m.parent_id,
         m.delta as amount,
         round(m.delta
           - coalesce((select sum(a.amount) from customer_account_allocations a
                        where a.charge_id = m.id and a.released_at is null), 0)
           + coalesce((select sum(ch.delta) from customer_account_movements ch
                        where ch.parent_id = m.id and ch.voided_at is null
                          and ch.kind in ('reversal', 'interest_waiver')), 0), 2) as open_amount
    from customer_account_movements m
   where m.tenant_id = p_tenant
     and (p_customer is null or m.customer_id = p_customer)
     and m.kind in ('charge', 'interest', 'adjust_debit')
     and m.voided_at is null
     and round(m.delta
           - coalesce((select sum(a.amount) from customer_account_allocations a
                        where a.charge_id = m.id and a.released_at is null), 0)
           + coalesce((select sum(ch.delta) from customer_account_movements ch
                        where ch.parent_id = m.id and ch.voided_at is null
                          and ch.kind in ('reversal', 'interest_waiver')), 0), 2) > 0;
$$;
revoke all on function account_open_debits(uuid, uuid) from public, anon, authenticated;
grant execute on function account_open_debits(uuid, uuid) to service_role;

-- Créditos imputables (cobros y ajustes crédito) con remanente sin imputar.
create or replace function account_unapplied_credits(p_tenant uuid, p_customer uuid)
returns table (id uuid, created_at timestamptz, unapplied numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id, m.created_at,
         round(-m.delta - coalesce((select sum(a.amount) from customer_account_allocations a
                                     where a.payment_id = m.id and a.released_at is null), 0), 2)
    from customer_account_movements m
   where m.tenant_id = p_tenant and m.customer_id = p_customer
     and m.kind in ('payment', 'adjust_credit')
     and m.voided_at is null
     and round(-m.delta - coalesce((select sum(a.amount) from customer_account_allocations a
                                     where a.payment_id = m.id and a.released_at is null), 0), 2) > 0;
$$;
revoke all on function account_unapplied_credits(uuid, uuid) from public, anon, authenticated;
grant execute on function account_unapplied_credits(uuid, uuid) to service_role;

create or replace function account_balance(p_customer uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(round(sum(delta), 2), 0)
    from customer_account_movements
   where customer_id = p_customer and voided_at is null;
$$;
revoke all on function account_balance(uuid) from public, anon, authenticated;
grant execute on function account_balance(uuid) to service_role;

-- Imputa todos los créditos con remanente (del más viejo al más nuevo) a los
-- débitos abiertos en el orden por defecto: interés más viejo primero, luego
-- cargos por vencimiento (FIFO). ESPEJO de defaultOrder() en allocation.ts.
create or replace function account_reconcile(p_customer uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  c        record;
  d        record;
  v_left   numeric;
  v_take   numeric;
begin
  select tenant_id into v_tenant from customers where id = p_customer;
  if v_tenant is null then
    return;
  end if;
  for c in
    select * from account_unapplied_credits(v_tenant, p_customer) order by created_at, id
  loop
    v_left := c.unapplied;
    for d in
      select * from account_open_debits(v_tenant, p_customer) od
       order by (od.kind <> 'interest'),
                case when od.kind = 'interest' then od.created_at end,
                od.due_date nulls last, od.created_at, od.id
    loop
      exit when v_left <= 0;
      -- El open del cursor se calculó al empezar este crédito; lo imputado a
      -- este débito por créditos anteriores ya está descontado.
      v_take := least(v_left, d.open_amount);
      if v_take > 0 then
        insert into customer_account_allocations (tenant_id, payment_id, charge_id, amount, created_by)
        values (v_tenant, c.id, d.id, v_take, auth.uid());
        v_left := v_left - v_take;
      end if;
    end loop;
  end loop;
end;
$$;
revoke all on function account_reconcile(uuid) from public, anon, authenticated;
grant execute on function account_reconcile(uuid) to service_role;

-- Reversa (total o parcial) de un débito. Si con la reversa lo imputado supera
-- el débito, libera imputaciones (las más nuevas primero) para que ese crédito
-- vuelva a estar disponible (account_reconcile lo reimputa). Devuelve lo
-- revertido.
create or replace function account_reverse_debit(
  p_debit uuid, p_amount numeric, p_reason text, p_kind text default 'reversal'
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d     customer_account_movements%rowtype;
  v_room  numeric;
  v_amt   numeric;
  v_over  numeric;
  a       record;
begin
  if p_kind not in ('reversal', 'interest_waiver') then
    raise exception 'invalid_kind';
  end if;
  select * into v_d from customer_account_movements where id = p_debit;
  if not found or v_d.kind not in ('charge', 'interest', 'adjust_debit') or v_d.voided_at is not null then
    return 0;
  end if;

  v_room := v_d.delta + coalesce((select sum(ch.delta) from customer_account_movements ch
                                   where ch.parent_id = v_d.id and ch.voided_at is null
                                     and ch.kind in ('reversal', 'interest_waiver')), 0);
  v_amt := round(least(greatest(coalesce(p_amount, 0), 0), v_room), 2);
  if v_amt <= 0 then
    return 0;
  end if;

  insert into customer_account_movements
    (tenant_id, customer_id, kind, delta, parent_id, sale_id, reason, note, created_by)
  values
    (v_d.tenant_id, v_d.customer_id, p_kind, -v_amt, v_d.id, v_d.sale_id,
     case p_kind when 'reversal' then 'Reversa' else 'Condonación de interés' end,
     p_reason, auth.uid());

  v_over := round(
      coalesce((select sum(x.amount) from customer_account_allocations x
                 where x.charge_id = v_d.id and x.released_at is null), 0)
    - (v_room - v_amt), 2);
  for a in
    select * from customer_account_allocations
     where charge_id = v_d.id and released_at is null
     order by created_at desc, id desc
  loop
    exit when v_over <= 0;
    update customer_account_allocations set released_at = now() where id = a.id;
    if a.amount > v_over then
      insert into customer_account_allocations (tenant_id, payment_id, charge_id, amount, created_by)
      values (a.tenant_id, a.payment_id, a.charge_id, a.amount - v_over, auth.uid());
      v_over := 0;
    else
      v_over := v_over - a.amount;
    end if;
  end loop;

  return v_amt;
end;
$$;
revoke all on function account_reverse_debit(uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function account_reverse_debit(uuid, numeric, text, text) to service_role;

-- Rol activo del usuario en el tenant actual (null si no es miembro).
create or replace function account_my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from tenant_users
   where tenant_id = current_tenant_id() and user_id = auth.uid() and status = 'active'
   limit 1;
$$;
revoke all on function account_my_role() from public, anon;
grant execute on function account_my_role() to authenticated;

-- Guard común de las RPC de lectura/escritura: tenant, cuenta activa y plan.
create or replace function account_assert(p_feature text default 'cuenta_corriente')
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if account_my_role() is null and not coalesce(is_internal(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;
  if p_feature <> 'cuenta_corriente' and not tenant_has_feature_for(v_tenant, p_feature) then
    raise exception 'feature_not_in_plan: %', p_feature;
  end if;
  return v_tenant;
end;
$$;
revoke all on function account_assert(text) from public, anon;
grant execute on function account_assert(text) to authenticated;

-- Días de mora de la partida abierta más vieja (0 si no hay vencida).
create or replace function account_max_days_overdue(p_tenant uuid, p_customer uuid, p_as_of date)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(max(greatest(p_as_of - od.due_date, 0)), 0)::int
    from account_open_debits(p_tenant, p_customer) od
   where od.due_date is not null;
$$;
revoke all on function account_max_days_overdue(uuid, uuid, date) from public, anon, authenticated;
grant execute on function account_max_days_overdue(uuid, uuid, date) to service_role;

-- -----------------------------------------------------------------------------
-- 3) Cargo por venta a cuenta (REEMPLAZO de payment_account_charge)
--    Cambios vs 20260607180000:
--    - FOR UPDATE del cliente: dos ventas simultáneas ya no pasan el límite.
--    - Vencimiento según la config efectiva (días o corte mensual).
--    - Cuotas: payments.reference puede traer {"installments": N} → N cargos.
--    - Bloqueo por mora (blocking.overdue_days) y por estado 'blocked'; override
--      sólo de dueño/encargado con motivo ({"override_reason": "..."}) → audit.
--    - Gating real con tenant_has_feature_for (además del trigger de payments).
--    - Aplica anticipos (saldo a favor) a los cargos nuevos.
-- -----------------------------------------------------------------------------
create or replace function payment_account_charge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale     record;
  v_cust     customers%rowtype;
  v_cfg      jsonb;
  v_ref      jsonb;
  v_n        int := 1;
  v_override text;
  v_balance  numeric;
  v_days     int;
  v_block    text;
  v_first    date;
  v_due      date;
  v_cents    bigint;
  v_base     bigint;
  v_amt      numeric;
  v_dues     jsonb := '[]'::jsonb;
  i          int;
begin
  if new.method <> 'account' then
    return new;
  end if;

  select s.id, s.customer_id, s.tenant_id, s.number into v_sale from sales s where s.id = new.sale_id;
  if v_sale.customer_id is null then
    raise exception 'account_needs_customer';
  end if;
  if not tenant_has_feature_for(v_sale.tenant_id, 'cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;
  if coalesce(new.amount, 0) <= 0 then
    raise exception 'invalid_amount';
  end if;

  -- Fin de la carrera: lock del cliente durante toda la transacción de la venta.
  select * into v_cust from customers
   where id = v_sale.customer_id and tenant_id = v_sale.tenant_id
   for update;
  if not found then
    raise exception 'customer_not_found';
  end if;

  v_cfg := account_effective_config(v_cust.id);

  begin
    if new.reference is not null and left(btrim(new.reference), 1) = '{' then
      v_ref := new.reference::jsonb;
    end if;
  exception when others then
    v_ref := null;
  end;
  v_n := greatest(1, coalesce((v_ref ->> 'installments')::int, 1));
  v_override := nullif(btrim(coalesce(v_ref ->> 'override_reason', '')), '');

  -- Límite de crédito (0 = sin límite). Sin override: es una decisión de riesgo.
  v_balance := account_balance(v_cust.id);
  if coalesce(v_cust.credit_limit, 0) > 0
     and v_balance + new.amount > v_cust.credit_limit + 0.001 then
    raise exception 'credit_limit_exceeded';
  end if;

  -- Bloqueo por estado manual o por mora.
  if v_cust.credit_status = 'blocked' then
    v_block := 'account_blocked';
  elsif (v_cfg -> 'blocking' ->> 'overdue_days') is not null then
    v_days := account_max_days_overdue(v_sale.tenant_id, v_cust.id, account_today());
    if v_days > (v_cfg -> 'blocking' ->> 'overdue_days')::int then
      v_block := 'account_overdue_blocked';
    end if;
  end if;
  if v_block is not null then
    if v_override is not null
       and coalesce((v_cfg -> 'blocking' ->> 'allow_manager_override')::boolean, true)
       and is_tenant_manager() then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
      values (v_sale.tenant_id, auth.uid(), 'customers', v_cust.id, 'account_block_override', v_override,
              jsonb_build_object('block', v_block, 'sale_id', v_sale.id, 'amount', new.amount,
                                 'days_overdue', v_days, 'balance', v_balance));
    else
      raise exception '%', v_block;
    end if;
  end if;

  -- Cuotas.
  if v_n > 1 then
    if not coalesce((v_cfg -> 'installments' ->> 'enabled')::boolean, false)
       or v_n > coalesce((v_cfg -> 'installments' ->> 'max')::int, 1) then
      raise exception 'installments_not_allowed';
    end if;
  end if;

  v_first := account_due_date(account_today(), v_cfg -> 'terms');
  v_cents := round(new.amount * 100)::bigint;
  v_base  := v_cents / v_n;
  for i in 1..v_n loop
    v_amt := (case when i = v_n then v_cents - v_base * (v_n - 1) else v_base end)::numeric / 100;
    if coalesce(v_cfg -> 'terms' ->> 'mode', 'days') = 'monthly_cutoff' then
      v_due := account_add_months(v_first, i - 1);
    else
      v_due := v_first + (i - 1) * greatest(1, coalesce((v_cfg -> 'installments' ->> 'interval_days')::int, 30));
    end if;
    insert into customer_account_movements
      (tenant_id, customer_id, kind, delta, reason, sale_id, due_date, installment_no, installments, created_by)
    values
      (v_sale.tenant_id, v_cust.id, 'charge', v_amt,
       'Venta #' || v_sale.number || case when v_n > 1 then ' · cuota ' || i || '/' || v_n else '' end,
       v_sale.id, v_due,
       case when v_n > 1 then i else null end,
       case when v_n > 1 then v_n else null end,
       auth.uid());
    v_dues := v_dues || jsonb_build_object('installment_no', i, 'amount', v_amt, 'due_date', v_due);
  end loop;

  -- Anticipos (saldo a favor) se aplican a los cargos nuevos.
  perform account_reconcile(v_cust.id);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_sale.tenant_id, auth.uid(), 'customers', v_cust.id, 'account_charge',
          jsonb_build_object('sale_id', v_sale.id, 'sale_number', v_sale.number,
                             'amount', new.amount, 'installments', v_n, 'schedule', v_dues));
  return new;
end;
$$;
revoke all on function payment_account_charge() from public, anon, authenticated;
-- El trigger payments_account_charge (AFTER INSERT on payments) ya existe y
-- apunta a esta función: no hace falta recrearlo.

-- -----------------------------------------------------------------------------
-- 4) Cobro: account_collect
-- -----------------------------------------------------------------------------
create or replace function account_payment_result(p_payment uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'payment_id', m.id,
    'receipt_no', m.receipt_no,
    'amount', -m.delta,
    'method', m.method,
    'created_at', m.created_at,
    'customer_id', m.customer_id,
    'customer_name', c.name,
    'note', m.note,
    'balance', account_balance(m.customer_id),
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'charge_id', a.charge_id, 'amount', a.amount,
               'reason', d.reason, 'kind', d.kind, 'due_date', d.due_date) order by a.created_at, a.id)
        from customer_account_allocations a
        join customer_account_movements d on d.id = a.charge_id
       where a.payment_id = m.id and a.released_at is null), '[]'::jsonb),
    'unapplied', round(-m.delta - coalesce((select sum(a.amount) from customer_account_allocations a
                                              where a.payment_id = m.id and a.released_at is null), 0), 2)
  )
  from customer_account_movements m
  join customers c on c.id = m.customer_id
  where m.id = p_payment;
$$;
revoke all on function account_payment_result(uuid) from public, anon, authenticated;
grant execute on function account_payment_result(uuid) to service_role;

-- Turno abierto de la sucursal por defecto (mismo criterio que create_sale).
create or replace function account_open_shift(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select cs.id
    from cash_shifts cs
    join cash_registers cr on cr.id = cs.cash_register_id
   where cs.tenant_id = p_tenant and cs.status = 'open'
     and cr.store_id = (select s.id from stores s
                         where s.tenant_id = p_tenant and s.deleted_at is null
                         order by s.is_default desc, s.created_at limit 1)
   order by cs.opened_at desc
   limit 1;
$$;
revoke all on function account_open_shift(uuid) from public, anon, authenticated;
grant execute on function account_open_shift(uuid) to service_role;

-- account_collect(cliente, monto, medio, imputación?, idempotencia?, nota?)
--  · Rol: cajero con caja abierta, o dueño/encargado (caja opcional salvo
--    efectivo).
--  · Imputación: la elegida ([{id, amount}] sobre débitos abiertos) y el resto
--    por defecto (interés más viejo, luego FIFO por vencimiento). Lo que sobra
--    queda como saldo a favor.
--  · Caja: efectivo → cash_movements 'income' (entra al arqueo); otros medios →
--    'account_payment'. Ambos en el turno abierto y en el Z.
--  · Recibo correlativo por tenant (advisory lock). Idempotente por clave.
create or replace function account_collect(
  p_customer_id     uuid,
  p_amount          numeric,
  p_method          text,
  p_allocations     jsonb default null,
  p_idempotency_key text  default null,
  p_note            text  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid;
  v_role    text;
  v_cust    customers%rowtype;
  v_amount  numeric := round(coalesce(p_amount, 0), 2);
  v_method  text := lower(coalesce(p_method, ''));
  v_key     text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_existing uuid;
  v_shift   uuid;
  v_receipt bigint;
  v_pay     uuid;
  v_sum     numeric := 0;
  v_open    numeric;
  a         record;
begin
  v_tenant := account_assert('cuenta_corriente');
  perform assert_account_active(v_tenant);
  v_role := account_my_role();
  if coalesce(v_role, '') not in ('owner', 'manager', 'cashier') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_method not in ('cash', 'debit', 'credit', 'transfer', 'qr', 'other') then
    raise exception 'invalid_method';
  end if;
  perform assert_payment_method_allowed(v_method, v_tenant);
  if v_amount <= 0 then
    raise exception 'invalid_amount';
  end if;

  select * into v_cust from customers
   where id = p_customer_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'customer_not_found';
  end if;

  -- Idempotencia (después del lock: el segundo intento espera y ve el primero).
  if v_key is not null then
    select id into v_existing from customer_account_movements
     where tenant_id = v_tenant and idempotency_key = v_key;
    if v_existing is not null then
      return account_payment_result(v_existing) || jsonb_build_object('idempotent', true);
    end if;
  end if;

  v_shift := account_open_shift(v_tenant);
  if v_shift is null and (v_role = 'cashier' or v_method = 'cash') then
    raise exception 'no_open_shift';
  end if;

  perform pg_advisory_xact_lock(hashtext('account_receipt:' || v_tenant::text));
  select coalesce(max(receipt_no), 0) + 1 into v_receipt
    from customer_account_movements where tenant_id = v_tenant;

  insert into customer_account_movements
    (tenant_id, customer_id, kind, delta, reason, method, cash_shift_id, receipt_no,
     idempotency_key, note, created_by)
  values
    (v_tenant, v_cust.id, 'payment', -v_amount, 'Cobro recibo #' || v_receipt, v_method, v_shift,
     v_receipt, v_key, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_pay;

  -- Imputación elegida.
  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' then
    for a in
      select (x ->> 'id')::uuid as id, round((x ->> 'amount')::numeric, 2) as amount
        from jsonb_array_elements(p_allocations) x
    loop
      continue when coalesce(a.amount, 0) <= 0;
      select od.open_amount into v_open from account_open_debits(v_tenant, v_cust.id) od where od.id = a.id;
      if v_open is null then
        raise exception 'allocation_unknown_item';
      end if;
      if a.amount > v_open then
        raise exception 'allocation_exceeds_open';
      end if;
      if v_sum + a.amount > v_amount then
        raise exception 'allocation_exceeds_payment';
      end if;
      insert into customer_account_allocations (tenant_id, payment_id, charge_id, amount, created_by)
      values (v_tenant, v_pay, a.id, a.amount, auth.uid());
      v_sum := v_sum + a.amount;
    end loop;
  end if;

  -- El resto (y cualquier anticipo previo) por el orden por defecto.
  perform account_reconcile(v_cust.id);

  if v_shift is not null then
    insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id, created_by)
    values (v_tenant, v_shift,
            case when v_method = 'cash' then 'income' else 'account_payment' end,
            v_amount, v_method,
            'Cobro cuenta corriente · recibo #' || v_receipt || ' · ' || v_cust.name,
            v_pay, auth.uid());
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'customer_account_movements', v_pay, 'account_collect',
          jsonb_build_object('customer_id', v_cust.id, 'amount', v_amount, 'method', v_method,
                             'receipt_no', v_receipt, 'cash_shift_id', v_shift,
                             'chosen_allocations', p_allocations));

  return account_payment_result(v_pay);
end;
$$;
revoke all on function account_collect(uuid, numeric, text, jsonb, text, text) from public, anon;
grant execute on function account_collect(uuid, numeric, text, jsonb, text, text) to authenticated;

-- Anulación de un cobro (cargado mal): dueño/encargado. Baja lógica del
-- movimiento, libera sus imputaciones y registra el contramovimiento de caja.
create or replace function account_void_payment(p_movement_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_m      customer_account_movements%rowtype;
  v_shift  uuid;
begin
  v_tenant := account_assert('cuenta_corriente');
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;

  select * into v_m from customer_account_movements
   where id = p_movement_id and tenant_id = v_tenant and kind = 'payment';
  if not found then
    raise exception 'movement_not_found';
  end if;
  if v_m.voided_at is not null then
    raise exception 'already_voided';
  end if;
  perform 1 from customers where id = v_m.customer_id for update;

  -- Caja: el turno original si sigue abierto; si no, el abierto actual.
  select id into v_shift from cash_shifts where id = v_m.cash_shift_id and status = 'open';
  if v_shift is null then
    v_shift := account_open_shift(v_tenant);
  end if;
  if v_shift is null and v_m.method = 'cash' then
    raise exception 'no_open_shift';
  end if;

  update customer_account_movements
     set voided_at = now(), voided_by = auth.uid(),
         note = coalesce(note || ' · ', '') || 'Anulado: ' || btrim(p_reason)
   where id = v_m.id;
  update customer_account_allocations set released_at = now()
   where payment_id = v_m.id and released_at is null;

  if v_shift is not null and v_m.cash_shift_id is not null then
    insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id, created_by)
    values (v_tenant, v_shift,
            case when v_m.method = 'cash' then 'expense' else 'account_payment_void' end,
            -v_m.delta, v_m.method, 'Anulación cobro cuenta corriente · recibo #' || v_m.receipt_no,
            v_m.id, auth.uid());
  end if;

  perform account_reconcile(v_m.customer_id);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, before_data)
  values (v_tenant, auth.uid(), 'customer_account_movements', v_m.id, 'account_payment_voided', p_reason,
          jsonb_build_object('amount', -v_m.delta, 'method', v_m.method, 'receipt_no', v_m.receipt_no,
                             'customer_id', v_m.customer_id));
  return jsonb_build_object('ok', true, 'balance', account_balance(v_m.customer_id));
end;
$$;
revoke all on function account_void_payment(uuid, text) from public, anon;
grant execute on function account_void_payment(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 5) Punitorios
-- -----------------------------------------------------------------------------

-- Períodos empezados desde p_start hasta p_as_of (inclusive) e inicio del último.
create or replace function account_periods_started(
  p_start date, p_as_of date, p_period text, out o_count int, out o_last date
)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  k int := 0;
begin
  if p_as_of is null or p_as_of < p_start then
    o_count := 0;
    o_last := null;
    return;
  end if;
  if p_period = 'daily' then
    o_count := (p_as_of - p_start) + 1;
    o_last := p_as_of;
    return;
  end if;
  while account_add_months(p_start, k + 1) <= p_as_of and k < 1200 loop
    k := k + 1;
  end loop;
  o_count := k + 1;
  o_last := account_add_months(p_start, k);
end;
$$;

-- ESPEJO de accrueInterest() (lib/account/interest.ts).
create or replace function account_interest_calc(
  p_as_of date, p_due date, p_original numeric, p_outstanding numeric,
  p_unpaid_interest numeric, p_posted numeric, p_last_period date, p_cfg jsonb,
  out o_period date, out o_units int, out o_amount numeric
)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_rate   numeric := coalesce((p_cfg ->> 'rate_pct')::numeric, 0) / 100;
  v_period text := coalesce(p_cfg ->> 'period', 'monthly');
  v_grace  int := greatest(0, coalesce((p_cfg ->> 'grace_days')::int, 0));
  v_cap    numeric := (p_cfg ->> 'cap_pct')::numeric;
  v_min    numeric := coalesce((p_cfg ->> 'min_amount')::numeric, 0);
  v_start  date;
  v_now    record;
  v_done   int := 0;
  v_amt    numeric;
begin
  o_period := null; o_units := null; o_amount := null;
  if not coalesce((p_cfg ->> 'enabled')::boolean, false) or v_rate <= 0 then return; end if;
  if coalesce(p_outstanding, 0) <= 0.004 or p_due is null then return; end if;

  v_start := p_due + v_grace + 1;
  select * into v_now from account_periods_started(v_start, p_as_of, v_period);
  if v_now.o_count = 0 then return; end if;
  if p_last_period is not null then
    select o_count into v_done from account_periods_started(v_start, p_last_period, v_period);
  end if;
  if v_now.o_count - v_done <= 0 then return; end if;

  o_units := v_now.o_count - v_done;
  if coalesce(p_cfg ->> 'method', 'simple') = 'compound' then
    v_amt := (p_outstanding + greatest(coalesce(p_unpaid_interest, 0), 0)) * (power(1 + v_rate, o_units) - 1);
  else
    v_amt := p_outstanding * v_rate * o_units;
  end if;
  v_amt := round(v_amt, 2);
  if v_cap is not null and v_cap >= 0 then
    v_amt := least(v_amt, round(p_original * v_cap / 100 - coalesce(p_posted, 0), 2));
  end if;
  if v_amt <= 0.004 or v_amt < v_min then
    o_units := null;
    return;
  end if;
  o_period := v_now.o_last;
  o_amount := v_amt;
end;
$$;

-- ESPEJO de accrueDailyInterest() (lib/account/interest.ts). Tasa diaria: UN
-- movimiento por cargo y MES CALENDARIO. Devuelve, por mes, el monto a SUMAR al
-- movimiento de ese mes (o a crear) y hasta qué día cubre. Casos (tests):
--   1000 al 0,1% diario, vto 10/10, gracia 5, al 20/10 -> (2026-10-01, 20/10, 5 días, 5)
--   al día siguiente (accrued_through 20/10)           -> (2026-10-01, 21/10, 1, 1)
--   corrida atrasada al 03/11 desde cero                -> oct 16 días 16 + nov 3 días 3
--   mínimo: se mide contra el total del mes; un mes cerrado que no llega pasa
--   sus días al mes siguiente.
create or replace function account_interest_daily_calc(
  p_as_of date, p_due date, p_original numeric, p_outstanding numeric,
  p_unpaid_interest numeric, p_posted numeric, p_accrued_through date,
  p_existing numeric, p_cfg jsonb
)
returns table (o_period date, o_through date, o_units int, o_amount numeric)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_rate     numeric := coalesce((p_cfg ->> 'rate_pct')::numeric, 0) / 100;
  v_grace    int := greatest(0, coalesce((p_cfg ->> 'grace_days')::int, 0));
  v_cap      numeric := (p_cfg ->> 'cap_pct')::numeric;
  v_min      numeric := coalesce((p_cfg ->> 'min_amount')::numeric, 0);
  v_compound boolean := coalesce(p_cfg ->> 'method', 'simple') = 'compound';
  v_room     numeric;
  v_unpaid   numeric := greatest(coalesce(p_unpaid_interest, 0), 0);
  v_existing numeric := coalesce(p_existing, 0);
  v_from     date;
  v_end      date;
  v_units    int;
  v_raw      numeric;
  v_amt      numeric;
  v_carry    numeric := 0;
  v_carry_u  int := 0;
begin
  if not coalesce((p_cfg ->> 'enabled')::boolean, false) or v_rate <= 0 then return; end if;
  if coalesce(p_outstanding, 0) <= 0.004 or p_due is null or p_as_of is null then return; end if;

  v_from := p_due + v_grace + 1;
  if p_accrued_through is not null and p_accrued_through + 1 > v_from then
    v_from := p_accrued_through + 1;
  end if;
  if v_cap is not null and v_cap >= 0 then
    v_room := round(p_original * v_cap / 100 - coalesce(p_posted, 0), 2);
  end if;

  while v_from <= p_as_of loop
    v_end := least((date_trunc('month', v_from) + interval '1 month - 1 day')::date, p_as_of);
    v_units := v_end - v_from + 1;
    if v_compound then
      v_raw := (p_outstanding + v_unpaid) * (power(1 + v_rate, v_units) - 1);
    else
      v_raw := p_outstanding * v_rate * v_units;
    end if;
    v_raw := round(v_raw + v_carry, 2);
    v_amt := case when v_room is null then v_raw else least(v_raw, v_room) end;
    exit when v_amt <= 0.004;
    if v_existing + v_amt < v_min then
      exit when v_end >= p_as_of;
      v_carry := v_raw;
      v_carry_u := v_carry_u + v_units;
    else
      o_period := date_trunc('month', v_from)::date;
      o_through := v_end;
      o_units := v_units + v_carry_u;
      o_amount := v_amt;
      return next;
      if v_room is not null then v_room := v_room - v_amt; end if;
      v_unpaid := v_unpaid + v_amt;
      v_carry := 0;
      v_carry_u := 0;
    end if;
    v_existing := 0;
    v_from := v_end + 1;
  end loop;
end;
$$;

-- Devengo de punitorios. Cron diario (pg_cron, sin auth → todos los tenants con
-- cc_punitorios); un dueño/encargado puede correrlo a mano para su negocio.
-- Idempotente: único por (cargo, período). Tasa mensual: un movimiento por
-- período. Tasa diaria: un movimiento por cargo y mes calendario que se
-- actualiza (upsert) día a día; accrued_through evita sumar dos veces el mismo día.
create or replace function account_accrue_interest(p_as_of date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_as_of   date := coalesce(p_as_of, account_today());
  v_only    uuid;
  t         record;
  c         record;
  d         record;
  v_cfg     jsonb;
  v_last_c  uuid;
  v_posted  numeric;
  v_unpaid  numeric;
  v_lastp   date;
  v_calc    record;
  v_count   int;
  v_total   numeric;
  v_all     int := 0;
  v_id      uuid;
  v_through date;
  v_from0   date;
  v_exist   numeric;
  b         record;
begin
  if auth.uid() is not null then
    v_only := account_assert('cc_punitorios');
    if not is_tenant_manager() then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  for t in
    select distinct m.tenant_id
      from customer_account_movements m
     where m.kind = 'charge' and m.voided_at is null
       and (v_only is null or m.tenant_id = v_only)
  loop
    continue when not (tenant_has_feature_for(t.tenant_id, 'cuenta_corriente')
                       and tenant_has_feature_for(t.tenant_id, 'cc_punitorios'));
    v_count := 0;
    v_total := 0;
    v_last_c := null;

    for d in
      select od.* from account_open_debits(t.tenant_id, null) od
       where od.kind = 'charge' and od.due_date is not null and od.due_date < v_as_of
       order by od.customer_id, od.due_date, od.id
    loop
      if v_last_c is distinct from d.customer_id then
        if v_last_c is not null then
          perform account_reconcile(v_last_c);
        end if;
        v_last_c := d.customer_id;
        perform 1 from customers where id = d.customer_id for update;
        v_cfg := account_effective_config(d.customer_id) -> 'interest';
      end if;
      continue when not coalesce((v_cfg ->> 'enabled')::boolean, false);

      select coalesce(sum(i.delta), 0), max(i.period), max(i.accrued_through)
        into v_posted, v_lastp, v_through
        from customer_account_movements i
       where i.parent_id = d.id and i.kind = 'interest' and i.voided_at is null;
      select coalesce(sum(oi.open_amount), 0) into v_unpaid
        from account_open_debits(t.tenant_id, d.customer_id) oi
       where oi.kind = 'interest' and oi.parent_id = d.id;

      if coalesce(v_cfg ->> 'period', 'monthly') = 'daily' then
        -- Lo ya liquidado en el mes del primer día a devengar (para el mínimo).
        v_from0 := d.due_date + greatest(0, coalesce((v_cfg ->> 'grace_days')::int, 0)) + 1;
        if v_through is not null and v_through + 1 > v_from0 then
          v_from0 := v_through + 1;
        end if;
        select coalesce(sum(i.delta), 0) into v_exist
          from customer_account_movements i
         where i.parent_id = d.id and i.kind = 'interest' and i.voided_at is null
           and i.period = date_trunc('month', v_from0)::date;

        for b in
          select * from account_interest_daily_calc(
            v_as_of, d.due_date, d.amount, d.open_amount, v_unpaid, v_posted, v_through, v_exist, v_cfg)
        loop
          v_id := null;
          insert into customer_account_movements as m
            (tenant_id, customer_id, kind, delta, parent_id, sale_id, period, accrued_through,
             due_date, reason, note)
          values
            (t.tenant_id, d.customer_id, 'interest', b.o_amount, d.id, d.sale_id, b.o_period, b.o_through,
             v_as_of, 'Punitorio',
             (v_cfg ->> 'rate_pct') || '% diario '
               || case when v_cfg ->> 'method' = 'compound' then 'compuesto' else 'simple' end
               || ' sobre ' || d.open_amount)
          on conflict (parent_id, period) where kind = 'interest'
          do update set delta = m.delta + excluded.delta,
                        accrued_through = excluded.accrued_through,
                        note = excluded.note
           where m.voided_at is null
             and coalesce(m.accrued_through, m.period - 1) < excluded.accrued_through
          returning m.id into v_id;

          if v_id is not null then
            v_count := v_count + 1;
            v_total := v_total + b.o_amount;
          end if;
        end loop;
        continue;
      end if;

      select * into v_calc from account_interest_calc(
        v_as_of, d.due_date, d.amount, d.open_amount, v_unpaid, v_posted, v_lastp, v_cfg);
      continue when v_calc.o_amount is null;

      v_id := null;
      insert into customer_account_movements
        (tenant_id, customer_id, kind, delta, parent_id, sale_id, period, due_date, reason, note)
      values
        (t.tenant_id, d.customer_id, 'interest', v_calc.o_amount, d.id, d.sale_id, v_calc.o_period, v_as_of,
         'Punitorio',
         v_calc.o_units || ' mes(es) al ' || (v_cfg ->> 'rate_pct') || '% '
           || case when v_cfg ->> 'method' = 'compound' then 'compuesto' else 'simple' end
           || ' sobre ' || d.open_amount)
      on conflict (parent_id, period) where kind = 'interest' do nothing
      returning id into v_id;

      if v_id is not null then
        v_count := v_count + 1;
        v_total := v_total + v_calc.o_amount;
      end if;
    end loop;
    if v_last_c is not null then
      perform account_reconcile(v_last_c);
    end if;

    if v_count > 0 then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, action, after_data)
      values (t.tenant_id, auth.uid(), 'customer_account_movements', 'account_interest_accrued',
              jsonb_build_object('as_of', v_as_of, 'movements', v_count, 'total', v_total));
    end if;
    v_all := v_all + v_count;
  end loop;

  return jsonb_build_object('as_of', v_as_of, 'movements', v_all);
end;
$$;
revoke all on function account_accrue_interest(date) from public, anon;
grant execute on function account_accrue_interest(date) to authenticated, service_role;

-- Condonación (total o parcial) de un interés: dueño/encargado, con motivo.
create or replace function account_waive_interest(p_movement_id uuid, p_amount numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_m      customer_account_movements%rowtype;
  v_open   numeric;
  v_amt    numeric := round(coalesce(p_amount, 0), 2);
  v_done   numeric;
begin
  v_tenant := account_assert('cc_punitorios');
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_m from customer_account_movements
   where id = p_movement_id and tenant_id = v_tenant and kind = 'interest' and voided_at is null;
  if not found then
    raise exception 'movement_not_found';
  end if;
  perform 1 from customers where id = v_m.customer_id for update;

  select od.open_amount into v_open from account_open_debits(v_tenant, v_m.customer_id) od where od.id = v_m.id;
  if v_amt <= 0 or v_amt > coalesce(v_open, 0) then
    raise exception 'invalid_amount';
  end if;

  v_done := account_reverse_debit(v_m.id, v_amt, btrim(p_reason), 'interest_waiver');

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'customer_account_movements', v_m.id, 'account_interest_waived', p_reason,
          jsonb_build_object('amount', v_done, 'customer_id', v_m.customer_id, 'interest', v_m.delta));
  return jsonb_build_object('ok', true, 'waived', v_done, 'balance', account_balance(v_m.customer_id));
end;
$$;
revoke all on function account_waive_interest(uuid, numeric, text) from public, anon;
grant execute on function account_waive_interest(uuid, numeric, text) to authenticated;

-- Ajuste manual (nota de débito / crédito interna): dueño/encargado, con motivo.
create or replace function account_adjust(
  p_customer_id uuid, p_kind text, p_amount numeric, p_reason text, p_due_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_amt    numeric := round(coalesce(p_amount, 0), 2);
  v_id     uuid;
begin
  v_tenant := account_assert('cuenta_corriente');
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kind not in ('adjust_debit', 'adjust_credit') then
    raise exception 'invalid_kind';
  end if;
  if v_amt <= 0 then
    raise exception 'invalid_amount';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  perform 1 from customers where id = p_customer_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found then
    raise exception 'customer_not_found';
  end if;

  insert into customer_account_movements
    (tenant_id, customer_id, kind, delta, reason, note, due_date, created_by)
  values
    (v_tenant, p_customer_id, p_kind,
     case when p_kind = 'adjust_debit' then v_amt else -v_amt end,
     case when p_kind = 'adjust_debit' then 'Ajuste débito' else 'Ajuste crédito' end,
     btrim(p_reason),
     case when p_kind = 'adjust_debit' then coalesce(p_due_date, account_today()) else null end,
     auth.uid())
  returning id into v_id;

  perform account_reconcile(p_customer_id);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'customer_account_movements', v_id, 'account_adjust', p_reason,
          jsonb_build_object('customer_id', p_customer_id, 'kind', p_kind, 'amount', v_amt,
                             'due_date', p_due_date));
  return jsonb_build_object('ok', true, 'movement_id', v_id, 'balance', account_balance(p_customer_id));
end;
$$;
revoke all on function account_adjust(uuid, text, numeric, text, date) from public, anon;
grant execute on function account_adjust(uuid, text, numeric, text, date) to authenticated;

-- -----------------------------------------------------------------------------
-- 6) Lecturas: estado de cuenta, aging, info para el POS
-- -----------------------------------------------------------------------------

create or replace function account_statement(
  p_customer_id uuid, p_from date default null, p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid;
  v_cust    customers%rowtype;
  v_today   date := account_today();
  v_from    date;
  v_to      date := coalesce(p_to, account_today());
  v_cfg     jsonb;
  v_balance numeric;
  v_open    jsonb;
  v_mov     jsonb;
  v_opening numeric;
  v_items   jsonb;
begin
  v_tenant := account_assert('cuenta_corriente');
  select * into v_cust from customers where id = p_customer_id and tenant_id = v_tenant;
  if not found then
    raise exception 'customer_not_found';
  end if;
  v_cfg := account_effective_config(v_cust.id);
  v_balance := account_balance(v_cust.id);
  v_from := coalesce(p_from, (select min((m.created_at at time zone 'America/Argentina/Buenos_Aires')::date)
                                from customer_account_movements m where m.customer_id = v_cust.id), v_today);

  with mv as (
    select m.*,
           sum(case when m.voided_at is null then m.delta else 0 end)
             over (order by m.created_at, m.period nulls first, m.id) as running,
           (m.created_at at time zone 'America/Argentina/Buenos_Aires')::date as local_date
      from customer_account_movements m
     where m.tenant_id = v_tenant and m.customer_id = v_cust.id
  )
  select
    coalesce((select running - case when voided_at is null then delta else 0 end
                from mv where local_date >= v_from order by created_at, period nulls first, id limit 1),
             (select running from mv order by created_at desc, period desc nulls last, id desc limit 1), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'kind', kind, 'delta', delta, 'reason', reason, 'note', note,
      'created_at', created_at, 'due_date', due_date, 'sale_id', sale_id,
      'installment_no', installment_no, 'installments', installments, 'parent_id', parent_id,
      'method', method, 'receipt_no', receipt_no, 'period', period, 'accrued_through', accrued_through,
      'voided_at', voided_at, 'running', round(running, 2)) order by created_at, period nulls first, id)
      filter (where local_date between v_from and v_to), '[]'::jsonb)
    into v_opening, v_mov
  from mv;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', od.id, 'kind', od.kind, 'reason', m.reason, 'due_date', od.due_date,
           'created_at', od.created_at, 'amount', od.amount, 'open', od.open_amount,
           'sale_id', od.sale_id, 'installment_no', od.installment_no, 'installments', od.installments,
           'parent_id', od.parent_id, 'period', m.period, 'accrued_through', m.accrued_through,
           'days_overdue', greatest(v_today - od.due_date, 0))
           order by (od.kind <> 'interest'), od.due_date nulls last, od.created_at, od.id), '[]'::jsonb)
    into v_open
    from account_open_debits(v_tenant, v_cust.id) od
    join customer_account_movements m on m.id = od.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'type', i.type, 'body', i.body, 'promise_date', i.promise_date,
           'promise_amount', i.promise_amount, 'status', i.status, 'due_at', i.due_at,
           'assignee', i.assignee, 'done_at', i.done_at, 'channel', i.channel,
           'created_at', i.created_at, 'created_by', i.created_by) order by i.created_at desc), '[]'::jsonb)
    into v_items
    from (select * from account_collection_items
           where tenant_id = v_tenant and customer_id = v_cust.id and deleted_at is null
           order by created_at desc limit 100) i;

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_cust.id, 'name', v_cust.name, 'email', v_cust.email, 'phone', v_cust.phone,
      'document_type', v_cust.document_type, 'document_number', v_cust.document_number,
      'credit_limit', v_cust.credit_limit, 'credit_status', v_cust.credit_status,
      'collector_user_id', v_cust.collector_user_id, 'account_config', v_cust.account_config,
      'group_id', v_cust.group_id),
    'config', v_cfg,
    'as_of', v_today,
    'from', v_from,
    'to', v_to,
    'balance', v_balance,
    'available', case when coalesce(v_cust.credit_limit, 0) > 0
                      then greatest(v_cust.credit_limit - v_balance, 0) else null end,
    'opening_balance', round(v_opening, 2),
    'movements', v_mov,
    'open_items', v_open,
    'overdue', coalesce((select sum((x ->> 'open')::numeric) from jsonb_array_elements(v_open) x
                          where (x ->> 'days_overdue')::int > 0), 0),
    'interest_open', coalesce((select sum((x ->> 'open')::numeric) from jsonb_array_elements(v_open) x
                                where x ->> 'kind' = 'interest'), 0),
    'max_days_overdue', coalesce((select max((x ->> 'days_overdue')::int) from jsonb_array_elements(v_open) x), 0),
    'items', v_items
  );
end;
$$;
revoke all on function account_statement(uuid, date, date) from public, anon;
grant execute on function account_statement(uuid, date, date) to authenticated;

-- Aging server-side por VENCIMIENTO (reemplaza el cálculo en el cliente).
-- Tramos (ESPEJO de aging.ts): current (no vencido) / 1-30 / 31-60 / 61-90 / 90+.
create or replace function account_aging(p_as_of date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_as_of  date := coalesce(p_as_of, account_today());
  v_rows   jsonb;
  v_totals jsonb;
  v_month  date := date_trunc('month', coalesce(p_as_of, account_today())::timestamp)::date;
begin
  v_tenant := account_assert('cuenta_corriente');

  with od as (
    select o.*, greatest(v_as_of - o.due_date, 0) as days
      from account_open_debits(v_tenant, null) o
  ),
  per as (
    select od.customer_id,
           sum(od.open_amount) as total,
           sum(od.open_amount) filter (where od.days = 0) as not_due,
           sum(od.open_amount) filter (where od.days between 1 and 30) as d1_30,
           sum(od.open_amount) filter (where od.days between 31 and 60) as d31_60,
           sum(od.open_amount) filter (where od.days between 61 and 90) as d61_90,
           sum(od.open_amount) filter (where od.days > 90) as d90_plus,
           sum(od.open_amount) filter (where od.kind = 'interest') as interest,
           max(od.days) as max_days,
           min(od.due_date) filter (where od.days > 0) as oldest_due,
           min(od.due_date) filter (where od.days = 0) as next_due
      from od group by od.customer_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'customer_id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email,
           'credit_status', c.credit_status, 'credit_limit', c.credit_limit,
           'collector_user_id', c.collector_user_id,
           'balance', account_balance(c.id),
           'total', round(p.total, 2),
           'current', round(coalesce(p.not_due, 0), 2),
           'd1_30', round(coalesce(p.d1_30, 0), 2),
           'd31_60', round(coalesce(p.d31_60, 0), 2),
           'd61_90', round(coalesce(p.d61_90, 0), 2),
           'd90_plus', round(coalesce(p.d90_plus, 0), 2),
           'overdue', round(p.total - coalesce(p.not_due, 0), 2),
           'interest', round(coalesce(p.interest, 0), 2),
           'max_days_overdue', coalesce(p.max_days, 0),
           'oldest_due', p.oldest_due,
           'next_due', p.next_due,
           'last_payment_at', (select max(m.created_at) from customer_account_movements m
                                where m.customer_id = c.id and m.kind = 'payment' and m.voided_at is null),
           'promise', (select jsonb_build_object('id', i.id, 'date', i.promise_date, 'amount', i.promise_amount,
                                                 'broken', i.promise_date < v_as_of)
                         from account_collection_items i
                        where i.customer_id = c.id and i.type = 'promise' and i.status = 'open'
                          and i.deleted_at is null
                        order by i.promise_date limit 1),
           'open_tasks', (select count(*) from account_collection_items i
                           where i.customer_id = c.id and i.type = 'task' and i.status = 'open'
                             and i.deleted_at is null))
           order by (p.total - coalesce(p.not_due, 0)) desc, coalesce(p.max_days, 0) desc, p.total desc), '[]'::jsonb)
    into v_rows
    from per p join customers c on c.id = p.customer_id;

  select jsonb_build_object(
           'total', round(coalesce(sum(od.open_amount), 0), 2),
           'current', round(coalesce(sum(od.open_amount) filter (where od.days = 0), 0), 2),
           'd1_30', round(coalesce(sum(od.open_amount) filter (where od.days between 1 and 30), 0), 2),
           'd31_60', round(coalesce(sum(od.open_amount) filter (where od.days between 31 and 60), 0), 2),
           'd61_90', round(coalesce(sum(od.open_amount) filter (where od.days between 61 and 90), 0), 2),
           'd90_plus', round(coalesce(sum(od.open_amount) filter (where od.days > 90), 0), 2),
           'overdue', round(coalesce(sum(od.open_amount) filter (where od.days > 0), 0), 2),
           'due_next_7', round(coalesce(sum(od.open_amount) filter (
               where od.due_date between v_as_of and v_as_of + 7), 0), 2),
           'customers', count(distinct od.customer_id),
           'customers_overdue', count(distinct od.customer_id) filter (where od.days > 0))
    into v_totals
    from (select o.*, greatest(v_as_of - o.due_date, 0) as days
            from account_open_debits(v_tenant, null) o) od;

  v_totals := v_totals || jsonb_build_object(
    'interest_month', coalesce((select round(sum(m.delta), 2) from customer_account_movements m
                                 where m.tenant_id = v_tenant and m.kind = 'interest' and m.voided_at is null
                                   and m.created_at >= v_month), 0),
    'collected_month', coalesce((select round(-sum(m.delta), 2) from customer_account_movements m
                                  where m.tenant_id = v_tenant and m.kind = 'payment' and m.voided_at is null
                                    and m.created_at >= v_month), 0));

  return jsonb_build_object('as_of', v_as_of, 'totals', v_totals, 'customers', v_rows);
end;
$$;
revoke all on function account_aging(date) from public, anon;
grant execute on function account_aging(date) to authenticated;

-- Lo que necesita el POS al elegir "Cuenta corriente": saldo, disponible,
-- vencido, cuotas permitidas y si está bloqueado (y si quien cobra puede
-- autorizar igual).
create or replace function account_pos_info(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid;
  v_cust    customers%rowtype;
  v_cfg     jsonb;
  v_balance numeric;
  v_days    int;
  v_overdue numeric;
  v_block   text;
begin
  v_tenant := account_assert('cuenta_corriente');
  select * into v_cust from customers where id = p_customer_id and tenant_id = v_tenant;
  if not found then
    raise exception 'customer_not_found';
  end if;
  v_cfg := account_effective_config(v_cust.id);
  v_balance := account_balance(v_cust.id);
  v_days := account_max_days_overdue(v_tenant, v_cust.id, account_today());
  select coalesce(sum(od.open_amount), 0) into v_overdue
    from account_open_debits(v_tenant, v_cust.id) od where od.due_date < account_today();

  if v_cust.credit_status = 'blocked' then
    v_block := 'account_blocked';
  elsif (v_cfg -> 'blocking' ->> 'overdue_days') is not null
        and v_days > (v_cfg -> 'blocking' ->> 'overdue_days')::int then
    v_block := 'account_overdue_blocked';
  end if;

  return jsonb_build_object(
    'balance', v_balance,
    'credit_limit', v_cust.credit_limit,
    'available', case when coalesce(v_cust.credit_limit, 0) > 0
                      then greatest(v_cust.credit_limit - v_balance, 0) else null end,
    'overdue', v_overdue,
    'max_days_overdue', v_days,
    'credit_status', v_cust.credit_status,
    'blocked', v_block,
    'override_allowed', coalesce((v_cfg -> 'blocking' ->> 'allow_manager_override')::boolean, true),
    'can_override', is_tenant_manager(),
    'installments', v_cfg -> 'installments',
    'terms', v_cfg -> 'terms',
    'first_due', account_due_date(account_today(), v_cfg -> 'terms'));
end;
$$;
revoke all on function account_pos_info(uuid) from public, anon;
grant execute on function account_pos_info(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 7) Configuración (negocio y cliente)
-- -----------------------------------------------------------------------------
create or replace function account_save_settings(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_before jsonb;
begin
  v_tenant := account_assert('cuenta_corriente');
  if not is_tenant_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_config is null or not account_config_valid(p_config) then
    raise exception 'invalid_account_config';
  end if;
  select account_config into v_before from pos_settings where tenant_id = v_tenant;
  insert into pos_settings (tenant_id, account_config)
  values (v_tenant, p_config)
  on conflict (tenant_id) do update set account_config = excluded.account_config;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'pos_settings', v_tenant, 'account_settings_changed', v_before, p_config);
  return account_jsonb_merge(account_config_default(), p_config);
end;
$$;
revoke all on function account_save_settings(jsonb) from public, anon;
grant execute on function account_save_settings(jsonb) to authenticated;

-- Condiciones propias del cliente (override de config, límite, estado,
-- cobrador). La auditoría la escribe el guard de customers.
create or replace function account_set_customer_terms(
  p_customer_id uuid, p_config jsonb, p_credit_limit numeric, p_credit_status text, p_collector uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  v_tenant := account_assert('cuenta_corriente');
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_config is not null and not account_config_valid(p_config) then
    raise exception 'invalid_account_config';
  end if;
  if coalesce(p_credit_status, 'ok') not in ('ok', 'watch', 'blocked') then
    raise exception 'invalid_credit_status';
  end if;
  if coalesce(p_credit_limit, 0) < 0 then
    raise exception 'invalid_amount';
  end if;
  if p_collector is not null and not exists (
    select 1 from tenant_users where tenant_id = v_tenant and user_id = p_collector and status = 'active'
  ) then
    raise exception 'collector_not_member';
  end if;
  if p_collector is not null and not tenant_has_feature_for(v_tenant, 'cc_cobranza') then
    raise exception 'feature_not_in_plan: cc_cobranza';
  end if;

  update customers
     set account_config = case when p_config = '{}'::jsonb then null else p_config end,
         credit_limit = coalesce(p_credit_limit, 0),
         credit_status = coalesce(p_credit_status, 'ok'),
         collector_user_id = p_collector
   where id = p_customer_id and tenant_id = v_tenant;
  if not found then
    raise exception 'customer_not_found';
  end if;
  return jsonb_build_object('ok', true, 'config', account_effective_config(p_customer_id));
end;
$$;
revoke all on function account_set_customer_terms(uuid, jsonb, numeric, text, uuid) from public, anon;
grant execute on function account_set_customer_terms(uuid, jsonb, numeric, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 8) Cobranza: notas, promesas, tareas, registro de WhatsApp
-- -----------------------------------------------------------------------------
create or replace function account_add_collection_item(
  p_customer_id    uuid,
  p_type           text,
  p_body           text default null,
  p_promise_date   date default null,
  p_promise_amount numeric default null,
  p_due_at         timestamptz default null,
  p_assignee       uuid default null,
  p_channel        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_id     uuid;
begin
  v_tenant := account_assert('cc_cobranza');
  if coalesce(account_my_role(), '') not in ('owner', 'manager', 'cashier') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_type not in ('note', 'promise', 'task', 'reminder_log') then
    raise exception 'invalid_type';
  end if;
  -- Desde la UI sólo se registra el recordatorio manual por WhatsApp; los de
  -- email los registra la Edge Function account_reminders.
  if p_type = 'reminder_log' and coalesce(p_channel, '') <> 'whatsapp' then
    raise exception 'invalid_channel';
  end if;
  if p_type = 'promise' and (p_promise_date is null or coalesce(p_promise_amount, 0) <= 0) then
    raise exception 'promise_needs_date_and_amount';
  end if;
  if p_type in ('note', 'task') and nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'body_required';
  end if;
  if p_assignee is not null and not exists (
    select 1 from tenant_users where tenant_id = v_tenant and user_id = p_assignee and status = 'active'
  ) then
    raise exception 'assignee_not_member';
  end if;
  if not exists (select 1 from customers where id = p_customer_id and tenant_id = v_tenant) then
    raise exception 'customer_not_found';
  end if;

  insert into account_collection_items
    (tenant_id, customer_id, type, body, promise_date, promise_amount, due_at, assignee, channel,
     status, created_by)
  values
    (v_tenant, p_customer_id, p_type, nullif(btrim(coalesce(p_body, '')), ''), p_promise_date,
     p_promise_amount, p_due_at, p_assignee, p_channel,
     case when p_type = 'reminder_log' then 'sent' when p_type = 'note' then 'done' else 'open' end,
     auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'account_collection_items', v_id, 'collection_item_created',
          jsonb_build_object('customer_id', p_customer_id, 'type', p_type, 'promise_date', p_promise_date,
                             'promise_amount', p_promise_amount, 'assignee', p_assignee, 'channel', p_channel));
  return v_id;
end;
$$;
revoke all on function account_add_collection_item(uuid, text, text, date, numeric, timestamptz, uuid, text) from public, anon;
grant execute on function account_add_collection_item(uuid, text, text, date, numeric, timestamptz, uuid, text) to authenticated;

-- Cambia el estado de una promesa/tarea (cumplida, incumplida, hecha,
-- cancelada) o la da de baja (lógica).
create or replace function account_update_collection_item(p_id uuid, p_status text, p_delete boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_it     account_collection_items%rowtype;
begin
  v_tenant := account_assert('cc_cobranza');
  if coalesce(account_my_role(), '') not in ('owner', 'manager', 'cashier') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_it from account_collection_items
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'item_not_found';
  end if;

  if coalesce(p_delete, false) then
    update account_collection_items set deleted_at = now() where id = p_id;
  else
    if p_status not in ('open', 'done', 'kept', 'broken', 'cancelled') then
      raise exception 'invalid_status';
    end if;
    update account_collection_items
       set status = p_status,
           done_at = case when p_status = 'open' then null else now() end
     where id = p_id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'account_collection_items', p_id,
          case when coalesce(p_delete, false) then 'collection_item_deleted' else 'collection_item_updated' end,
          jsonb_build_object('status', v_it.status),
          jsonb_build_object('status', p_status, 'deleted', coalesce(p_delete, false)));
end;
$$;
revoke all on function account_update_collection_item(uuid, text, boolean) from public, anon;
grant execute on function account_update_collection_item(uuid, text, boolean) to authenticated;

-- Candidatos a recordatorio automático (los usa la Edge account_reminders con
-- service_role). Por tenant con cc_cobranza: deuda abierta agrupada por
-- vencimiento, con email, a `before_days` del vencimiento o `after_days`
-- después. Excluye lo ya enviado (dedupe_key en account_collection_items).
create or replace function account_reminder_candidates(p_as_of date default null)
returns table (
  tenant_id uuid, customer_id uuid, customer_name text, email text,
  kind text, days int, due_date date, amount numeric, balance numeric, dedupe_key text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_as_of date := coalesce(p_as_of, account_today());
  t       record;
  r       record;
  v_cfg   jsonb;
begin
  for t in
    select distinct m.tenant_id as tid
      from customer_account_movements m
     where m.kind in ('charge', 'adjust_debit', 'interest') and m.voided_at is null
  loop
    continue when not (tenant_has_feature_for(t.tid, 'cuenta_corriente')
                       and tenant_has_feature_for(t.tid, 'cc_cobranza'));
    for r in
      select od.customer_id as cid, od.due_date as due, round(sum(od.open_amount), 2) as amt
        from account_open_debits(t.tid, null) od
       where od.due_date is not null
       group by od.customer_id, od.due_date
    loop
      select c.name, c.email into customer_name, email
        from customers c where c.id = r.cid and c.deleted_at is null;
      continue when email is null or btrim(email) = '';
      v_cfg := account_effective_config(r.cid) -> 'reminders';
      tenant_id := t.tid;
      customer_id := r.cid;
      due_date := r.due;
      amount := r.amt;
      balance := account_balance(r.cid);
      if (r.due - v_as_of) > 0
         and exists (select 1 from jsonb_array_elements(coalesce(v_cfg -> 'before_days', '[]'::jsonb)) x
                      where (x #>> '{}')::int = r.due - v_as_of) then
        kind := 'before';
        days := r.due - v_as_of;
      elsif (v_as_of - r.due) > 0
         and exists (select 1 from jsonb_array_elements(coalesce(v_cfg -> 'after_days', '[]'::jsonb)) x
                      where (x #>> '{}')::int = v_as_of - r.due) then
        kind := 'after';
        days := v_as_of - r.due;
      else
        continue;
      end if;
      dedupe_key := kind || ':' || days || ':' || r.due;
      continue when exists (select 1 from account_collection_items i
                             where i.tenant_id = t.tid and i.customer_id = r.cid
                               and i.dedupe_key = account_reminder_candidates.dedupe_key);
      return next;
    end loop;
  end loop;
end;
$$;
revoke all on function account_reminder_candidates(date) from public, anon, authenticated;
grant execute on function account_reminder_candidates(date) to service_role;

-- -----------------------------------------------------------------------------
-- 9) Backfill de imputaciones históricas (FIFO, igual que el cálculo viejo del
--    front) para que aging y estado de cuenta arranquen consistentes.
-- -----------------------------------------------------------------------------
do $backfill$
declare
  r record;
begin
  for r in select distinct customer_id from customer_account_movements loop
    perform account_reconcile(r.customer_id);
  end loop;
end;
$backfill$;

-- -----------------------------------------------------------------------------
-- 10) Cron diario de punitorios (pg_cron; sin pg_cron se omite).
--     06:17 UTC = 03:17 AR: corre de madrugada y con la fecha local correcta.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'account-accrue-interest') then
      perform cron.unschedule('account-accrue-interest');
    end if;
    perform cron.schedule('account-accrue-interest', '17 6 * * *', 'select account_accrue_interest();');
  else
    raise notice 'pg_cron no disponible; se omite el job de punitorios.';
  end if;
end;
$cron$;

-- -----------------------------------------------------------------------------
-- 11) Cron diario de recordatorios de cobranza: POST a la Edge account_reminders
--     (mismo patrón que dispatch-system-emails: secreto de platform_secrets
--     'internal_cron' en X-Cron-Secret, leído en cada corrida; nada en git).
--     12:07 UTC = 09:07 AR (hora razonable para recibir un recordatorio).
-- -----------------------------------------------------------------------------
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/account_reminders';
  v_cmd text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el job de recordatorios.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el job de recordatorios.';
    return;
  end if;

  v_cmd := format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := '{"mode":"cron"}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$, v_url);

  if exists (select 1 from cron.job where jobname = 'account-reminders') then
    perform cron.unschedule('account-reminders');
  end if;
  perform cron.schedule('account-reminders', '7 12 * * *', v_cmd);
end;
$cron$;
