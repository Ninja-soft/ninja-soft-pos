-- =============================================================================
-- 20270117100000_h160_cobros  (F24 · H160 · ADR-179)
-- -----------------------------------------------------------------------------
-- Cobros ampliados:
--   A) Recibo de cuenta corriente con varios medios (account_collect_multi): una
--      línea por medio, un solo número de recibo, ajuste por redondeo dentro de
--      una tolerancia (pos_settings.receipt_rounding_tolerance) e idempotencia.
--      Cada línea es un movimiento 'payment' propio (receipt_parent_id = la
--      línea principal): la caja, la tesorería, la contabilidad y el reporte de
--      cobranzas siguen leyendo un medio por movimiento sin cambios.
--   B) Cheque y e-cheq de cliente como medio ('cheque', 'echeq') en el POS y en
--      el recibo: entran a la cartera de Tesorería (cheques third_party,
--      en_cartera). Gating real: payment_method_plan_key -> 'tesoreria'.
--      Contabilidad: el cobro va a "Otros medios de cobro a cobrar" (cobro '*')
--      y el cheque lo pasa a Valores a depositar (ADR-158, sin mapeos nuevos).
--   C) Retenciones sufridas dentro del recibo: línea 'retention' que cancela
--      deuda y se registra con tax_suffered_register (vínculo cc_movement_id).
--   D) Efectivo en dólares ('cash_usd', feature efectivo_usd): importe en pesos
--      en el pago, dólares y cotización en payments.metadata.usd, vuelto en
--      pesos como retiro del cajón y el esperado del arqueo en dólares.
--   E) Planes de tarjeta por día de la semana (payment_plans.weekdays).
--
-- Definiciones vivas copiadas: payment_method_plan_key (20270113100000_talo),
-- acc_template_extend y la lista de cam_method_check / payments_method_check,
-- acc_sync_cheque (20261227100100), cash_shift_expected_by_method
-- (20270110100000_h159_caja_pro). account_collect, create_sale y acc_sync_sale
-- NO se tocan: el POS usa triggers en payments.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Medios nuevos
-- -----------------------------------------------------------------------------
-- Copia de la lista más nueva (20261210100000_ualabis) + cheque, echeq, cash_usd.
alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash','debit','credit','transfer','qr','other','store_credit','account','directo','sena',
                    'plataforma', 'mercadolibre', 'ualabis', 'cheque', 'echeq', 'cash_usd'));

-- Medios de un movimiento de cuenta corriente (20261011200000) + cheque, echeq,
-- retention (línea de retención del recibo) y rounding (ajuste por redondeo).
alter table customer_account_movements drop constraint if exists cam_method_check;
alter table customer_account_movements add constraint cam_method_check check (
  method is null or method in ('cash', 'debit', 'credit', 'transfer', 'qr', 'other',
                               'cheque', 'echeq', 'retention', 'rounding'));

-- -----------------------------------------------------------------------------
-- 2) Columnas
-- -----------------------------------------------------------------------------
alter table customer_account_movements
  add column if not exists receipt_parent_id uuid references customer_account_movements(id);
comment on column customer_account_movements.receipt_parent_id is
  'H160: línea de un recibo con varios medios. La línea principal lleva receipt_no e idempotency_key; las demás apuntan a ella. Se anulan juntas.';
create index if not exists cam_receipt_parent_idx
  on customer_account_movements (receipt_parent_id) where receipt_parent_id is not null;

alter table cheques add column if not exists cc_movement_id uuid references customer_account_movements(id);
alter table cheques add column if not exists sale_payment_id uuid references payments(id);
comment on column cheques.cc_movement_id is 'H160: línea del recibo de cuenta corriente con la que entró el cheque.';
comment on column cheques.sale_payment_id is 'H160: pago de la venta del POS con el que entró el cheque.';
create index if not exists cheques_cc_movement_idx on cheques (cc_movement_id) where cc_movement_id is not null;
create index if not exists cheques_sale_payment_idx on cheques (sale_payment_id) where sale_payment_id is not null;

alter table pos_settings add column if not exists receipt_rounding_tolerance numeric not null default 10;
alter table pos_settings drop constraint if exists pos_settings_receipt_rounding_tolerance_check;
alter table pos_settings add constraint pos_settings_receipt_rounding_tolerance_check
  check (receipt_rounding_tolerance >= 0 and receipt_rounding_tolerance <= 1000);
comment on column pos_settings.receipt_rounding_tolerance is
  'H160: diferencia máxima en pesos entre lo imputado y los medios de un recibo que se ajusta como redondeo.';

-- 0 = domingo ... 6 = sábado (Date.getDay). null = todos los días.
alter table payment_plans add column if not exists weekdays smallint[];
alter table payment_plans drop constraint if exists payment_plans_weekdays_check;
alter table payment_plans add constraint payment_plans_weekdays_check
  check (weekdays is null or (cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]));
comment on column payment_plans.weekdays is
  'H160: días de la semana en que se ofrece el plan (0 domingo a 6 sábado, hora de Argentina). null = todos.';

-- -----------------------------------------------------------------------------
-- 3) Feature efectivo_usd (OPTIONAL, pagos)
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('efectivo_usd', 'Efectivo en dólares',
   'Cobrar en dólares en el POS con la cotización del día y el vuelto en pesos; el arqueo cuenta los dólares aparte',
   'pagos', false, 128)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('efectivo_usd', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'efectivo_usd');

-- -----------------------------------------------------------------------------
-- 4) Gating: medio -> feature. Copia de 20270113100000_talo + cheque, echeq
--    (tesoreria) y cash_usd (efectivo_usd).
-- -----------------------------------------------------------------------------
create or replace function payment_method_plan_key(p_method text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_method, ''))
    when 'cash'              then 'efectivo'
    when 'efectivo'          then 'efectivo'
    when 'transfer'          then 'transferencia'
    when 'transferencia'     then 'transferencia'
    when 'mercadopago'       then 'mercado_pago'
    when 'mp'                then 'mercado_pago'
    when 'mercado_pago'      then 'mercado_pago'
    when 'mercadopago_point' then 'mercadopago_point'
    when 'modo'              then 'modo'
    when 'mobbex'            then 'mobbex'
    when 'payway'            then 'payway'
    when 'payway_point'      then 'payway_point'
    when 'getnet'            then 'getnet'
    when 'getnet_point'      then 'getnet_point'
    when 'fiserv'            then 'fiserv'
    when 'fiserv_point'      then 'fiserv_point'
    when 'pagos360'          then 'pagos360'
    when 'nave'              then 'nave'
    when 'nave_point'        then 'nave_point'
    when 'gocuotas'          then 'gocuotas'
    when 'directo'           then 'directo'
    when 'ualabis'           then 'ualabis'
    when 'viumi'             then 'viumi'
    when 'talo'              then 'talo'
    when 'account'           then 'cuenta_corriente'
    when 'cuenta_corriente'  then 'cuenta_corriente'
    when 'plataforma'        then 'canales_delivery'
    when 'mercadolibre'      then 'mercadolibre'
    when 'cheque'            then 'tesoreria'
    when 'echeq'             then 'tesoreria'
    when 'cash_usd'          then 'efectivo_usd'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5) Contabilidad
-- -----------------------------------------------------------------------------
-- Plantilla (definición viva de 20261231100000 + cobro en dólares a Caja).
create or replace function acc_template_extend(p_tenant uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r   record;
  v_n int := 0;
begin
  if not exists (select 1 from acc_accounts where tenant_id = p_tenant and deleted_at is null) then
    return 0;
  end if;
  for r in
    select * from (values
      ('1.1.01.07', 'Billeteras virtuales',                          'activo', 'billeteras'),
      ('1.1.02.06', 'Ualá Bis, MODO y otros procesadores a cobrar',  'activo', 'procesadores_a_cobrar'),
      ('1.1.02.07', 'Mercado Libre a cobrar',                        'activo', 'ml_a_cobrar'),
      ('1.1.02.08', 'Plataformas de delivery a cobrar',              'activo', 'plataformas_a_cobrar'),
      ('2.1.03.04', 'Señas recibidas de clientes',                   'pasivo', 'senas'),
      ('5.2.05',    'IVA sobre comisiones de procesadores',          'egreso', 'iva_comisiones')
    ) as t(code, name, kind, skey)
  loop
    if not exists (select 1 from acc_accounts
                    where tenant_id = p_tenant and system_key = r.skey and deleted_at is null) then
      insert into acc_accounts (tenant_id, code, name, kind, imputable, system_key, parent_id)
      select p_tenant, r.code, r.name, r.kind, true, r.skey,
             (select a.id from acc_accounts a
               where a.tenant_id = p_tenant and a.deleted_at is null
                 and a.code = regexp_replace(r.code, '\.[0-9]+$', ''))
       where not exists (select 1 from acc_accounts x
                          where x.tenant_id = p_tenant and x.code = r.code and x.deleted_at is null);
      if found then
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  insert into acc_mappings (tenant_id, concept, qualifier, account_id)
  select p_tenant, m.concept, m.qualifier, a.id
    from (values
      ('cobro', 'sena',             'senas'),
      ('cobro', 'plataforma',       'plataformas_a_cobrar'),
      ('cobro', 'mercadolibre',     'ml_a_cobrar'),
      ('cobro', 'ualabis',          'procesadores_a_cobrar'),
      ('cobro', '*:ualabis',        'procesadores_a_cobrar'),
      ('cobro', '*:modo',           'procesadores_a_cobrar'),
      ('cobro', '*:naranjax',       'procesadores_a_cobrar'),
      ('senas', '*',                'senas'),
      ('tesoreria_apertura', '*',   'rna'),
      ('tesoreria', 'wallet',       'billeteras'),
      ('tesoreria', 'pos_cash',     'caja'),
      ('acreditacion', 'ualabis',   'billeteras'),
      ('acreditacion', 'modo',      'billeteras'),
      ('acreditacion', 'naranjax',  'billeteras'),
      ('cheque_cartera', '*',       'valores_a_depositar'),
      ('cheque_recibido', '*',      'otros_a_cobrar'),
      -- ADR-162: IVA de la comisión. Discrimina IVA: crédito fiscal; si no, gasto.
      ('iva_comision', '*',         'iva_cf'),
      ('iva_comision', 'gasto',     'iva_comisiones'),
      -- H160: los dólares en efectivo entran a la caja (por el importe en pesos).
      ('cobro', 'cash_usd',         'caja')
    ) as m(concept, qualifier, skey)
    join acc_accounts a on a.tenant_id = p_tenant and a.system_key = m.skey and a.deleted_at is null
  on conflict do nothing;
  return v_n;
end;
$$;
revoke all on function acc_template_extend(uuid) from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in select distinct tenant_id from acc_accounts where deleted_at is null loop
    perform acc_template_extend(r.tenant_id);
  end loop;
end;
$$;

-- acc_sync_cheque: definición viva (20261227100100) + el cheque de terceros
-- anulado con el recibo o la venta revierte su ingreso a cartera.
create or replace function acc_sync_cheque(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c      cheques%rowtype;
  cfg    acc_settings%rowtype;
  v_amt  numeric;
  v_lbl  text;
  v_date date;
  v_meth text;
  v_cr   uuid;
begin
  select * into c from cheques where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_lbl := case when c.is_echeq then 'E-cheq ' else 'Cheque ' end || c.number || coalesce(' ' || c.bank_name, '');

  if c.kind = 'third_party' then
    v_date := acc_ar_date(c.created_at);
    if v_date >= cfg.start_date and c.status <> 'anulado'
       and acc_entry_of(p_tenant, 'cheque', c.id, 'receive') is null then
      v_amt := round(c.amount * acc_fx_rate(p_tenant, c.currency, v_date), 2);
      perform acc_post(p_tenant, v_date, 'cheque', c.id, 'receive',
                       'Cheque recibido · ' || v_lbl || coalesce(' · ' || coalesce(c.drawer_name, c.received_from), ''),
                       null,
                       jsonb_build_array(
                         acc_line(acc_account_for(p_tenant, 'cheque_cartera', '*', null), v_amt, v_lbl),
                         acc_line(acc_account_for(p_tenant, 'cheque_recibido',
                                                  case when c.received_from_customer_id is not null then 'customer' else '*' end,
                                                  null), -v_amt)));
    end if;
    if c.status = 'rechazado' and c.deposit_movement_id is null
       and acc_entry_of(p_tenant, 'cheque', c.id, 'receive') is not null
       and acc_entry_of(p_tenant, 'cheque', c.id, 'reject') is null then
      v_date := coalesce(c.rejected_at, acc_ar_date(now()));
      v_amt := round(c.amount * acc_fx_rate(p_tenant, c.currency, v_date), 2);
      v_cr := case when c.delivered_to_supplier_id is not null
                   then acc_account_for(p_tenant, 'proveedores', c.delivered_to_supplier_id::text, null)
                   else acc_account_for(p_tenant, 'cheque_cartera', '*', null) end;
      perform acc_post(p_tenant, v_date, 'cheque', c.id, 'reject', 'Cheque rechazado · ' || v_lbl, null,
                       jsonb_build_array(
                         acc_line(acc_account_for(p_tenant, 'tesoreria_mov', 'cheque_rejected', null), v_amt, v_lbl),
                         acc_line(v_cr, -v_amt)));
    end if;
    -- H160: anulado con el recibo o la venta que lo trajo.
    if c.status = 'anulado'
       and acc_entry_of(p_tenant, 'cheque', c.id, 'receive') is not null
       and acc_entry_of(p_tenant, 'cheque', c.id, 'void') is null then
      perform acc_post_reversal(p_tenant, 'cheque', c.id, 'receive', 'void', acc_ar_date(c.updated_at),
                                'Anulación · ' || v_lbl);
    end if;
  elsif c.status = 'rechazado' and c.deposit_movement_id is null and c.delivered_to_supplier_id is not null
        and c.payment_id is not null
        and acc_entry_of(p_tenant, 'supplier_payment', c.payment_id, 'payment') is not null
        and acc_entry_of(p_tenant, 'cheque', c.id, 'reject') is null then
    select l.method into v_meth from supplier_payment_lines l where l.cheque_id = c.id limit 1;
    v_date := coalesce(c.rejected_at, acc_ar_date(now()));
    v_amt := round(c.amount * acc_fx_rate(p_tenant, c.currency, v_date), 2);
    perform acc_post(p_tenant, v_date, 'cheque', c.id, 'reject', 'Cheque propio rechazado · ' || v_lbl, null,
                     jsonb_build_array(
                       acc_line(acc_account_for(p_tenant, 'pago', coalesce(v_meth, 'cheque_propio'), null), v_amt, v_lbl),
                       acc_line(acc_account_for(p_tenant, 'proveedores', c.delivered_to_supplier_id::text, null), -v_amt)));
  end if;
end;
$$;
revoke all on function acc_sync_cheque(uuid, uuid) from public, anon, authenticated;

-- acc_sync_cc_movement: definición viva (20261231100000) + el ajuste por
-- redondeo de un recibo (method 'rounding') va a "Diferencias de redondeo".
create or replace function acc_sync_cc_movement(p_tenant uuid, p_id uuid, p_refresh boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m customer_account_movements%rowtype;
  cfg acc_settings%rowtype;
  v_store uuid;
  v_cust text;
  v_deu uuid;
  v_lines jsonb;
  v_amt numeric;
  v_desc text;
begin
  select * into m from customer_account_movements where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if acc_ar_date(m.created_at) < cfg.start_date then
    return;
  end if;
  if m.kind = 'charge' and m.sale_id is not null then
    return;
  end if;
  if m.kind not in ('payment', 'interest', 'interest_waiver', 'adjust_debit', 'adjust_credit', 'charge') then
    return;
  end if;

  if p_refresh then
    perform acc_unpost(p_tenant, 'cc_movement', m.id, 'main', 'Importe actualizado');
  end if;

  v_store := acc_shift_store(m.cash_shift_id);
  select name into v_cust from customers where id = m.customer_id;
  v_deu := acc_account_for(p_tenant, 'cobro', 'account', v_store);
  v_amt := abs(coalesce(m.delta, 0));

  if acc_entry_of(p_tenant, 'cc_movement', m.id, 'main') is null and v_amt > 0 then
    case m.kind
      when 'payment' then
        v_desc := 'Cobro de cuenta corriente' || coalesce(' recibo #' || m.receipt_no, '');
        v_lines := jsonb_build_array(
          acc_line(acc_cc_payment_account(p_tenant, m, v_store), v_amt, 'Cobro ' || coalesce(m.method, '')),
          acc_line(v_deu, -v_amt, 'Deudores'));
      when 'interest' then
        v_desc := 'Interés de cuenta corriente';
        v_lines := jsonb_build_array(acc_line(v_deu, v_amt), acc_line(acc_account_for(p_tenant, 'intereses_cc', '*', v_store), -v_amt));
      when 'interest_waiver' then
        v_desc := 'Condonación de interés';
        v_lines := jsonb_build_array(acc_line(acc_account_for(p_tenant, 'intereses_cc', '*', v_store), v_amt), acc_line(v_deu, -v_amt));
      when 'adjust_credit' then
        if m.method = 'rounding' then
          v_desc := 'Redondeo del recibo';
          v_lines := jsonb_build_array(acc_line(acc_account_for(p_tenant, 'redondeo', '*', v_store), v_amt), acc_line(v_deu, -v_amt));
        else
          v_desc := 'Ajuste a favor del cliente';
          v_lines := jsonb_build_array(acc_line(acc_account_for(p_tenant, 'ajustes_cc', '*', v_store), v_amt), acc_line(v_deu, -v_amt));
        end if;
      else
        if m.method = 'rounding' then
          v_desc := 'Redondeo del recibo';
          v_lines := jsonb_build_array(acc_line(v_deu, v_amt), acc_line(acc_account_for(p_tenant, 'redondeo', '*', v_store), -v_amt));
        else
          v_desc := case m.kind when 'charge' then 'Cargo manual en cuenta corriente' else 'Ajuste en contra del cliente' end;
          v_lines := jsonb_build_array(acc_line(v_deu, v_amt), acc_line(acc_account_for(p_tenant, 'ajustes_cc', '*', v_store), -v_amt));
        end if;
    end case;
    perform acc_post(p_tenant, acc_ar_date(m.created_at), 'cc_movement', m.id, 'main',
                     v_desc || coalesce(' · ' || v_cust, ''), v_store, v_lines);
  end if;

  if m.voided_at is not null then
    perform acc_post_reversal(p_tenant, 'cc_movement', m.id, 'main', 'void', acc_ar_date(m.voided_at),
                              'Anulación de movimiento de cuenta corriente' || coalesce(' · ' || v_cust, ''));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6) Arqueo: esperado por medio (definición viva de H159). Las retenciones del
--    recibo no se cuentan y los dólares se esperan en dólares.
-- -----------------------------------------------------------------------------
create or replace function public.cash_shift_expected_by_method(p_tenant uuid, p_shift_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(m, round(t, 2)), '{}'::jsonb)
    from (
      select m, sum(t) as t
        from (
          select payment_method as m,
                 sum(case when type = 'sale' then amount when type = 'sale_void' then -amount else 0 end) as t
            from cash_movements
           where cash_shift_id = p_shift_id and tenant_id = p_tenant
             and payment_method is not null and payment_method not in ('cash', 'account', 'store_credit', 'cash_usd')
           group by payment_method
          union all
          select a.method, sum(-a.delta)
            from customer_account_movements a
           where a.cash_shift_id = p_shift_id and a.tenant_id = p_tenant
             and a.kind = 'payment' and a.voided_at is null
             and a.method is not null and a.method not in ('cash', 'account', 'store_credit', 'retention')
           group by a.method
          union all
          -- H160: dólares recibidos (en dólares) de las ventas vigentes del turno.
          select 'cash_usd', sum(round(coalesce((p.metadata -> 'usd' ->> 'amount')::numeric, 0), 2))
            from payments p
            join sales s on s.id = p.sale_id
           where s.cash_shift_id = p_shift_id and s.tenant_id = p_tenant
             and s.status <> 'voided' and p.method = 'cash_usd'
        ) x
       where t is not null
       group by m
      having round(sum(t), 2) <> 0
    ) y;
$$;
revoke all on function public.cash_shift_expected_by_method(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7) Cotización del dólar para el POS: la del negocio (fx_rates, la manual
--    primero) o la oficial de la plataforma (compra; si no hay, venta).
-- -----------------------------------------------------------------------------
create or replace function usd_quote_for(p_tenant uuid, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rate numeric;
  v_src  text;
  v_date date;
begin
  select r.rate, r.source, r.rate_date into v_rate, v_src, v_date
    from fx_rates r
   where r.tenant_id = p_tenant and r.currency = 'USD' and r.rate_date <= p_date and r.rate > 0
   order by r.rate_date desc, (r.source = 'manual') desc
   limit 1;
  if v_rate is not null then
    return jsonb_build_object('rate', v_rate, 'source', 'negocio', 'date', v_date);
  end if;
  select coalesce(f.compra, f.venta), f.rate_date into v_rate, v_date
    from platform_fx_rates f
   where f.casa = 'oficial' and f.deleted_at is null and f.rate_date <= p_date
   order by f.rate_date desc, (f.source = 'manual') desc
   limit 1;
  if v_rate is null or v_rate <= 0 then
    return null;
  end if;
  return jsonb_build_object('rate', v_rate, 'source', 'oficial', 'date', v_date);
end;
$$;
revoke all on function usd_quote_for(uuid, date) from public, anon, authenticated;

create or replace function pos_usd_quote()
returns jsonb
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
  return usd_quote_for(v_tenant, acc_ar_date(now()));
end;
$$;
revoke all on function pos_usd_quote() from public, anon;
grant execute on function pos_usd_quote() to authenticated;

-- -----------------------------------------------------------------------------
-- 8) POS: cheque, e-cheq y dólares en payments (sin tocar create_sale).
--    El POS manda los datos en card_voucher (como la transferencia, ADR-055):
--      cheque / echeq: card_voucher.cheque = {number, bank_name?, payment_date,
--                       issue_date?, drawer_name?, drawer_cuit?}
--      cash_usd:       card_voucher.usd = {amount, rate}
--    El BEFORE los valida, los pasa a metadata y limpia card_voucher; el AFTER
--    da de alta el cheque en cartera o registra el vuelto en pesos.
-- -----------------------------------------------------------------------------
create or replace function trg_payments_h160_extras()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c     jsonb;
  v_cuit  text;
  v_pd    date;
  v_id    date;
  v_usd   numeric;
  v_rate  numeric;
  v_ars   numeric;
  v_quote jsonb;
begin
  if new.method in ('cheque', 'echeq') then
    v_c := coalesce(new.card_voucher -> 'cheque', new.metadata -> 'cheque');
    if v_c is null or jsonb_typeof(v_c) <> 'object' or nullif(btrim(coalesce(v_c ->> 'number', '')), '') is null then
      raise exception 'cheque_data_required' using errcode = 'check_violation';
    end if;
    begin
      v_pd := (nullif(v_c ->> 'payment_date', ''))::date;
      v_id := (nullif(v_c ->> 'issue_date', ''))::date;
    exception when others then
      raise exception 'cheque_invalid_date' using errcode = 'check_violation';
    end;
    if v_pd is null then
      raise exception 'payment_date_required' using errcode = 'check_violation';
    end if;
    if char_length(btrim(v_c ->> 'number')) > 30 then
      raise exception 'cheque_invalid_number' using errcode = 'check_violation';
    end if;
    v_cuit := nullif(regexp_replace(coalesce(v_c ->> 'drawer_cuit', ''), '\D', '', 'g'), '');
    if v_cuit is not null and not cuit_is_valid(v_cuit) then
      raise exception 'invalid_cuit' using errcode = 'check_violation';
    end if;
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('cheque', jsonb_build_object(
      'number', btrim(v_c ->> 'number'),
      'bank_name', nullif(btrim(left(coalesce(v_c ->> 'bank_name', ''), 80)), ''),
      'payment_date', v_pd,
      'issue_date', v_id,
      'drawer_name', nullif(btrim(left(coalesce(v_c ->> 'drawer_name', ''), 120)), ''),
      'drawer_cuit', v_cuit,
      'is_echeq', new.method = 'echeq'));
    new.card_voucher := '{}'::jsonb;
  elsif new.method = 'cash_usd' then
    v_c := coalesce(new.card_voucher -> 'usd', new.metadata -> 'usd');
    v_usd := round(coalesce((nullif(v_c ->> 'amount', ''))::numeric, 0), 2);
    v_rate := round(coalesce((nullif(v_c ->> 'rate', ''))::numeric, 0), 4);
    if v_usd <= 0 or v_rate <= 0 or v_rate > 1000000 then
      raise exception 'usd_data_required' using errcode = 'check_violation';
    end if;
    v_ars := round(v_usd * v_rate, 2);
    if v_ars < round(coalesce(new.amount, 0), 2) - 0.01 then
      raise exception 'usd_insufficient' using errcode = 'check_violation';
    end if;
    v_quote := usd_quote_for(new.tenant_id, acc_ar_date(now()));
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('usd', jsonb_build_object(
      'amount', v_usd,
      'rate', v_rate,
      'ars_value', v_ars,
      'change_ars', greatest(0, round(v_ars - coalesce(new.amount, 0), 2)),
      'quote', v_quote));
    new.card_voucher := '{}'::jsonb;
  end if;
  return new;
end;
$$;
revoke all on function trg_payments_h160_extras() from public, anon, authenticated;

-- "payments_aa_": corre antes que los demás BEFORE INSERT (orden alfabético).
drop trigger if exists payments_aa_h160_extras on payments;
create trigger payments_aa_h160_extras
  before insert on payments
  for each row when (new.method in ('cheque', 'echeq', 'cash_usd'))
  execute function trg_payments_h160_extras();

create or replace function trg_payments_h160_after()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s       record;
  v_c     jsonb;
  v_chg   numeric;
begin
  select sa.id, sa.number, sa.customer_id, sa.cash_shift_id, c.name as customer_name
    into s
    from sales sa left join customers c on c.id = sa.customer_id
   where sa.id = new.sale_id;

  if new.method in ('cheque', 'echeq') then
    v_c := new.metadata -> 'cheque';
    insert into cheques (tenant_id, kind, is_echeq, number, bank_name, issue_date, payment_date, amount,
                         drawer_name, drawer_cuit, status, received_from_customer_id, received_from,
                         sale_payment_id, notes, created_by)
    values (new.tenant_id, 'third_party', new.method = 'echeq', v_c ->> 'number', v_c ->> 'bank_name',
            (v_c ->> 'issue_date')::date, (v_c ->> 'payment_date')::date, round(new.amount, 2),
            v_c ->> 'drawer_name', v_c ->> 'drawer_cuit', 'en_cartera', s.customer_id,
            left(s.customer_name, 120), new.id,
            'Cobro de la venta #' || coalesce(s.number::text, ''), auth.uid());
  elsif new.method = 'cash_usd' then
    v_chg := round(coalesce((new.metadata -> 'usd' ->> 'change_ars')::numeric, 0), 2);
    if v_chg > 0 and s.cash_shift_id is not null then
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id, created_by)
      values (new.tenant_id, s.cash_shift_id, 'expense', v_chg, 'cash',
              'Vuelto en pesos de un cobro en dólares · venta #' || coalesce(s.number::text, ''),
              new.sale_id, auth.uid());
    end if;
  end if;
  return null;
end;
$$;
revoke all on function trg_payments_h160_after() from public, anon, authenticated;

drop trigger if exists payments_h160_after on payments;
create trigger payments_h160_after
  after insert on payments
  for each row when (new.method in ('cheque', 'echeq', 'cash_usd'))
  execute function trg_payments_h160_after();

-- Venta anulada: el cheque en cartera se anula (si ya se depositó o entregó,
-- no se puede anular la venta) y el vuelto en pesos vuelve al cajón si el
-- turno de la venta sigue abierto.
create or replace function trg_sales_h160_void()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p     record;
  v_chg numeric;
begin
  if exists (select 1 from cheques c join payments p on p.id = c.sale_payment_id
              where p.sale_id = new.id and c.status not in ('en_cartera', 'anulado')) then
    raise exception 'sale_cheque_used' using errcode = 'check_violation';
  end if;
  update cheques c set status = 'anulado'
    from payments p
   where p.id = c.sale_payment_id and p.sale_id = new.id and c.status = 'en_cartera';

  for p in select * from payments where sale_id = new.id and method = 'cash_usd' loop
    v_chg := round(coalesce((p.metadata -> 'usd' ->> 'change_ars')::numeric, 0), 2);
    if v_chg > 0 and exists (select 1 from cash_shifts where id = new.cash_shift_id and status = 'open') then
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id, created_by)
      values (new.tenant_id, new.cash_shift_id, 'income', v_chg, 'cash',
              'Vuelto en pesos devuelto · anulación de la venta #' || new.number, new.id, auth.uid());
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function trg_sales_h160_void() from public, anon, authenticated;

drop trigger if exists sales_h160_void on sales;
create trigger sales_h160_void
  after update of status on sales
  for each row
  when (new.status = 'voided' and old.status is distinct from 'voided')
  execute function trg_sales_h160_void();

-- -----------------------------------------------------------------------------
-- 9) Recibo con varios medios
-- -----------------------------------------------------------------------------
-- Resultado de un recibo (todas sus líneas). Compatible con account_payment_result.
create or replace function account_receipt_result(p_main uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ls as (
    select m.* from customer_account_movements m
     where m.id = p_main or m.receipt_parent_id = p_main
  )
  select account_payment_result(p_main) || jsonb_build_object(
    'amount', (select coalesce(round(sum(-delta), 2), 0) from ls where kind = 'payment'),
    'rounding', (select coalesce(round(sum(-delta), 2), 0) from ls where method = 'rounding'),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ls.id, 'kind', ls.kind, 'method', ls.method, 'amount', round(-ls.delta, 2),
               'cheque_id', (select c.id from cheques c where c.cc_movement_id = ls.id limit 1),
               'suffered_id', (select e.id from tax_suffered_entries e
                                where e.cc_movement_id = ls.id and e.status = 'active' limit 1))
             order by (ls.id <> p_main), ls.method)
        from ls), '[]'::jsonb),
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'charge_id', a.charge_id, 'amount', a.amount,
               'reason', d.reason, 'kind', d.kind, 'due_date', d.due_date) order by a.created_at, a.id)
        from customer_account_allocations a
        join customer_account_movements d on d.id = a.charge_id
       where a.payment_id in (select id from ls) and a.released_at is null), '[]'::jsonb),
    'unapplied', (select coalesce(round(sum(-ls.delta - coalesce((
                    select sum(a.amount) from customer_account_allocations a
                     where a.payment_id = ls.id and a.released_at is null), 0)), 2), 0)
                    from ls where ls.kind in ('payment', 'adjust_credit')));
$$;
revoke all on function account_receipt_result(uuid) from public, anon, authenticated;

-- p_lines: [{kind?: 'payment' (default) | 'retention', amount,
--            payment: method (cash|debit|credit|transfer|qr|other|cheque|echeq),
--                     reference?, transfer_account_id?,
--                     cheque?: {number, bank_name?, payment_date, issue_date?, drawer_name?, drawer_cuit?},
--            retention: tax (iibb|iva|ganancias|suss), jurisdiction? (iibb), certificate?, agent_cuit?}]
-- p_total: lo que cancela el recibo (null = la suma de las líneas). La
-- diferencia con las líneas, hasta pos_settings.receipt_rounding_tolerance, va
-- como ajuste 'rounding'.
create or replace function account_collect_multi(p_customer_id uuid, p_lines jsonb, p_total numeric default null,
                                                 p_allocations jsonb default null, p_idempotency_key text default null,
                                                 p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid;
  v_role     text;
  v_cust     customers%rowtype;
  v_key      text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_note     text := nullif(btrim(left(coalesce(p_note, ''), 300)), '');
  v_existing uuid;
  v_shift    uuid;
  v_receipt  bigint;
  v_main     uuid;
  v_id       uuid;
  v_n        int;
  v_sum      numeric := 0;
  v_total    numeric;
  v_diff     numeric;
  v_tol      numeric;
  v_has_cash boolean := false;
  v_has_ret  boolean := false;
  v_kind     text;
  v_method   text;
  v_amt      numeric;
  v_ta       uuid;
  v_c        jsonb;
  v_cuit     text;
  v_pd       date;
  v_tax      text;
  v_today    date := acc_ar_date(now());
  v_credits  uuid[] := '{}';
  v_out      jsonb := '[]'::jsonb;
  v_alloc    numeric := 0;
  v_open     numeric;
  v_left     numeric;
  v_cap      numeric;
  v_take     numeric;
  v_label    text;
  l          record;
  a          record;
  i          int;
begin
  v_tenant := account_assert('cuenta_corriente');
  perform assert_account_active(v_tenant);
  v_role := account_my_role();
  if coalesce(v_role, '') not in ('owner', 'manager', 'cashier') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'receipt_lines_required';
  end if;
  v_n := jsonb_array_length(p_lines);
  if v_n > 20 then
    raise exception 'receipt_too_many_lines';
  end if;

  -- Validación de todas las líneas antes de escribir.
  for l in select x from jsonb_array_elements(p_lines) x loop
    if jsonb_typeof(l.x) <> 'object' then
      raise exception 'invalid_line';
    end if;
    v_kind := coalesce(nullif(l.x ->> 'kind', ''), 'payment');
    begin
      v_amt := round(coalesce((nullif(l.x ->> 'amount', ''))::numeric, 0), 2);
    exception when others then
      raise exception 'invalid_amount';
    end;
    if v_amt <= 0 or v_amt > 100000000000 then
      raise exception 'invalid_amount';
    end if;
    if v_kind = 'payment' then
      v_method := lower(coalesce(l.x ->> 'method', ''));
      if v_method not in ('cash', 'debit', 'credit', 'transfer', 'qr', 'other', 'cheque', 'echeq') then
        raise exception 'invalid_method';
      end if;
      -- cheque / echeq -> feature tesoreria (payment_method_plan_key).
      perform assert_payment_method_allowed(v_method, v_tenant);
      if v_method = 'cash' then
        v_has_cash := true;
      end if;
      if v_method in ('cheque', 'echeq') then
        v_c := l.x -> 'cheque';
        if v_c is null or jsonb_typeof(v_c) <> 'object' or nullif(btrim(coalesce(v_c ->> 'number', '')), '') is null
           or char_length(btrim(v_c ->> 'number')) > 30 then
          raise exception 'cheque_data_required';
        end if;
        begin
          v_pd := (nullif(v_c ->> 'payment_date', ''))::date;
          perform (nullif(v_c ->> 'issue_date', ''))::date;
        exception when others then
          raise exception 'cheque_invalid_date';
        end;
        if v_pd is null then
          raise exception 'payment_date_required';
        end if;
        v_cuit := nullif(regexp_replace(coalesce(v_c ->> 'drawer_cuit', ''), '\D', '', 'g'), '');
        if v_cuit is not null and not cuit_is_valid(v_cuit) then
          raise exception 'invalid_cuit';
        end if;
      end if;
    elsif v_kind = 'retention' then
      v_tax := lower(coalesce(l.x ->> 'tax', ''));
      if v_tax not in ('iibb', 'iva', 'ganancias', 'suss') then
        raise exception 'suffered_invalid_tax';
      end if;
      if v_tax = 'iibb' and nullif(l.x ->> 'jurisdiction', '') is null then
        raise exception 'suffered_jurisdiction_required';
      end if;
      v_has_ret := true;
    else
      raise exception 'invalid_line';
    end if;
    v_sum := v_sum + v_amt;
  end loop;
  if v_has_ret and v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_total := round(coalesce(p_total, v_sum), 2);
  if v_total <= 0 then
    raise exception 'invalid_amount';
  end if;
  v_diff := round(v_total - v_sum, 2);
  select ps.receipt_rounding_tolerance into v_tol from pos_settings ps where ps.tenant_id = v_tenant;
  v_tol := coalesce(v_tol, 10);
  if abs(v_diff) > v_tol then
    raise exception 'receipt_mismatch';
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
      return account_receipt_result(v_existing) || jsonb_build_object('idempotent', true);
    end if;
  end if;

  v_shift := account_open_shift(v_tenant);
  if v_shift is null and (v_role = 'cashier' or v_has_cash) then
    raise exception 'no_open_shift';
  end if;

  perform pg_advisory_xact_lock(hashtext('account_receipt:' || v_tenant::text));
  select coalesce(max(receipt_no), 0) + 1 into v_receipt
    from customer_account_movements where tenant_id = v_tenant;

  -- Primero los medios y después las retenciones; la primera línea es la
  -- principal (número de recibo, clave de idempotencia y nota).
  for l in
    select x, ord from jsonb_array_elements(p_lines) with ordinality t(x, ord)
     order by (coalesce(nullif(x ->> 'kind', ''), 'payment') = 'retention'), ord
  loop
    v_kind := coalesce(nullif(l.x ->> 'kind', ''), 'payment');
    v_amt := round((l.x ->> 'amount')::numeric, 2);
    v_method := case when v_kind = 'retention' then 'retention' else lower(l.x ->> 'method') end;
    v_ta := null;
    if v_method = 'transfer' and nullif(l.x ->> 'transfer_account_id', '') is not null then
      select t.id into v_ta from transfer_accounts t
       where t.id::text = l.x ->> 'transfer_account_id' and t.tenant_id = v_tenant and t.deleted_at is null;
      if v_ta is null then
        raise exception 'transfer_account_not_found';
      end if;
    end if;
    v_label := case v_method
                 when 'cash' then 'efectivo' when 'debit' then 'débito' when 'credit' then 'crédito'
                 when 'transfer' then 'transferencia' when 'qr' then 'QR' when 'cheque' then 'cheque'
                 when 'echeq' then 'e-cheq' when 'retention' then 'retención ' || upper(l.x ->> 'tax')
                 else 'otro' end;

    insert into customer_account_movements
      (tenant_id, customer_id, kind, delta, reason, method, cash_shift_id, receipt_no,
       idempotency_key, note, created_by, transfer_account_id, receipt_parent_id)
    values
      (v_tenant, v_cust.id, 'payment', -v_amt,
       'Cobro recibo #' || v_receipt || case when v_n > 1 then ' · ' || v_label else '' end,
       v_method,
       case when v_kind = 'retention' then null else v_shift end,
       case when v_main is null then v_receipt end,
       case when v_main is null then v_key end,
       case when v_main is null then v_note
            else nullif(btrim(left(coalesce(l.x ->> 'reference', ''), 120)), '') end,
       auth.uid(), v_ta, v_main)
    returning id into v_id;
    if v_main is null then
      v_main := v_id;
    end if;
    v_credits := v_credits || v_id;

    if v_method in ('cheque', 'echeq') then
      v_c := l.x -> 'cheque';
      insert into cheques (tenant_id, kind, is_echeq, number, bank_name, issue_date, payment_date, amount,
                           drawer_name, drawer_cuit, status, received_from_customer_id, received_from,
                           cc_movement_id, notes, created_by)
      values (v_tenant, 'third_party', v_method = 'echeq', btrim(v_c ->> 'number'),
              nullif(btrim(left(coalesce(v_c ->> 'bank_name', ''), 80)), ''),
              (nullif(v_c ->> 'issue_date', ''))::date, (v_c ->> 'payment_date')::date, v_amt,
              nullif(btrim(left(coalesce(v_c ->> 'drawer_name', ''), 120)), ''),
              nullif(regexp_replace(coalesce(v_c ->> 'drawer_cuit', ''), '\D', '', 'g'), ''),
              'en_cartera', v_cust.id, left(v_cust.name, 120), v_id,
              'Recibo de cuenta corriente #' || v_receipt, auth.uid());
    end if;

    if v_kind = 'retention' then
      -- Misma validación y permisos que el alta manual (taxes.manage y la
      -- feature percepciones_retenciones).
      perform tax_suffered_register(jsonb_build_object(
        'tax', lower(l.x ->> 'tax'),
        'kind', 'retencion',
        'regime', 'general',
        'jurisdiction', nullif(l.x ->> 'jurisdiction', ''),
        'origin', 'cliente',
        'operation_date', v_today,
        'amount', v_amt,
        'certificate', nullif(btrim(coalesce(l.x ->> 'certificate', '')), ''),
        'agent_cuit', nullif(regexp_replace(coalesce(l.x ->> 'agent_cuit', ''), '\D', '', 'g'), ''),
        'agent_name', left(v_cust.name, 120),
        'cc_movement_id', v_id,
        'notes', 'Recibo de cuenta corriente #' || v_receipt));
    elsif v_shift is not null then
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id, created_by)
      values (v_tenant, v_shift,
              case when v_method = 'cash' then 'income' else 'account_payment' end,
              v_amt, v_method,
              'Cobro cuenta corriente · recibo #' || v_receipt || ' · ' || v_cust.name,
              v_id, auth.uid());
    end if;
    v_out := v_out || jsonb_build_object('id', v_id, 'method', v_method, 'amount', v_amt);
  end loop;

  -- Ajuste por redondeo: de menos, a favor del cliente; de más, en contra.
  if v_diff <> 0 then
    insert into customer_account_movements
      (tenant_id, customer_id, kind, delta, reason, method, due_date, note, created_by, receipt_parent_id)
    values
      (v_tenant, v_cust.id, case when v_diff > 0 then 'adjust_credit' else 'adjust_debit' end, -v_diff,
       'Redondeo recibo #' || v_receipt, 'rounding', case when v_diff < 0 then v_today end, null,
       auth.uid(), v_main)
    returning id into v_id;
    if v_diff > 0 then
      v_credits := v_credits || v_id;
    end if;
  end if;

  -- Imputación elegida, repartida entre las líneas del recibo en orden.
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
      if v_alloc + a.amount > v_total then
        raise exception 'allocation_exceeds_payment';
      end if;
      v_left := a.amount;
      for i in 1 .. coalesce(array_length(v_credits, 1), 0) loop
        exit when v_left <= 0;
        select round(-m.delta - coalesce((select sum(x.amount) from customer_account_allocations x
                                           where x.payment_id = m.id and x.released_at is null), 0), 2)
          into v_cap
          from customer_account_movements m where m.id = v_credits[i];
        continue when coalesce(v_cap, 0) <= 0;
        v_take := least(v_cap, v_left);
        insert into customer_account_allocations (tenant_id, payment_id, charge_id, amount, created_by)
        values (v_tenant, v_credits[i], a.id, v_take, auth.uid());
        v_left := v_left - v_take;
      end loop;
      if v_left > 0 then
        raise exception 'allocation_exceeds_payment';
      end if;
      v_alloc := v_alloc + a.amount;
    end loop;
  end if;

  -- El resto (y cualquier anticipo previo) por el orden por defecto.
  perform account_reconcile(v_cust.id);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'customer_account_movements', v_main, 'account_collect_multi',
          jsonb_build_object('customer_id', v_cust.id, 'total', v_total, 'lines_total', v_sum,
                             'rounding', v_diff, 'receipt_no', v_receipt, 'cash_shift_id', v_shift,
                             'lines', v_out, 'chosen_allocations', p_allocations));

  return account_receipt_result(v_main);
end;
$$;
revoke all on function account_collect_multi(uuid, jsonb, numeric, jsonb, text, text) from public, anon;
grant execute on function account_collect_multi(uuid, jsonb, numeric, jsonb, text, text) to authenticated;

-- Anulación: una línea sola no se anula (se anula el recibo, desde la línea
-- principal con account_void_payment). Al anular, cada línea suelta sus
-- imputaciones, devuelve la caja, anula el cheque en cartera y la retención.
create or replace function trg_cam_receipt_line_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.voided_at is null and new.voided_at is not null and new.receipt_parent_id is not null
     and not exists (select 1 from customer_account_movements p
                      where p.id = new.receipt_parent_id and p.voided_at is not null) then
    raise exception 'receipt_void_whole';
  end if;
  return new;
end;
$$;
revoke all on function trg_cam_receipt_line_guard() from public, anon, authenticated;

drop trigger if exists cam_receipt_line_guard on customer_account_movements;
create trigger cam_receipt_line_guard
  before update of voided_at on customer_account_movements
  for each row when (new.receipt_parent_id is not null)
  execute function trg_cam_receipt_line_guard();

create or replace function trg_cam_receipt_void()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ch      record;
  v_shift uuid;
  v_rcpt  text;
begin
  -- Cheque de la línea: sólo si sigue en cartera.
  if exists (select 1 from cheques c where c.cc_movement_id = new.id and c.status not in ('en_cartera', 'anulado')) then
    raise exception 'receipt_cheque_used';
  end if;
  update cheques set status = 'anulado' where cc_movement_id = new.id and status = 'en_cartera';

  -- Retención de la línea del recibo (no las vinculadas a mano a un cobro común).
  if new.method = 'retention' then
    update tax_suffered_entries
       set status = 'voided', voided_at = now(), voided_by = auth.uid(),
           void_reason = left('Anulación del recibo de cuenta corriente', 300)
     where cc_movement_id = new.id and status = 'active';
  end if;

  -- Línea principal: anula las demás líneas del recibo.
  if new.receipt_parent_id is null then
    v_rcpt := coalesce(new.receipt_no::text, '');
    for ch in
      select * from customer_account_movements
       where receipt_parent_id = new.id and voided_at is null
    loop
      update customer_account_movements
         set voided_at = new.voided_at, voided_by = new.voided_by,
             note = coalesce(note || ' · ', '') || 'Anulado con el recibo'
       where id = ch.id;
      update customer_account_allocations set released_at = now()
       where (payment_id = ch.id or charge_id = ch.id) and released_at is null;
      if ch.kind = 'payment' and ch.cash_shift_id is not null then
        select id into v_shift from cash_shifts where id = ch.cash_shift_id and status = 'open';
        if v_shift is null then
          v_shift := account_open_shift(new.tenant_id);
        end if;
        if v_shift is null and ch.method = 'cash' then
          raise exception 'no_open_shift';
        end if;
        if v_shift is not null then
          insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id, created_by)
          values (new.tenant_id, v_shift,
                  case when ch.method = 'cash' then 'expense' else 'account_payment_void' end,
                  -ch.delta, ch.method, 'Anulación cobro cuenta corriente · recibo #' || v_rcpt,
                  ch.id, auth.uid());
        end if;
        v_shift := null;
      end if;
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function trg_cam_receipt_void() from public, anon, authenticated;

drop trigger if exists cam_receipt_void on customer_account_movements;
create trigger cam_receipt_void
  after update of voided_at on customer_account_movements
  for each row when (old.voided_at is null and new.voided_at is not null
                     and (new.receipt_parent_id is not null or new.method in ('cheque', 'echeq', 'retention')
                          or new.receipt_no is not null))
  execute function trg_cam_receipt_void();
