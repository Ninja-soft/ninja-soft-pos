-- =============================================================================
-- 20261109300200_asientos_impuestos_sujeto  (F18 · H106 / H109, ADR-095)
--
-- Asientos (motor de ADR-066) de las retenciones y percepciones sufridas y de
-- la liquidación mensual de IIBB.
--
--   A) Conceptos nuevos de mapeo, con reglas por defecto sobre las cuentas de
--      la plantilla comercial (por system_key) para los negocios que ya
--      tienen la contabilidad y para los nuevos (se completan al primer
--      asiento, sin recrear acc_install_template):
--        retencion_sufrida  calificador '<impuesto>' o 'iibb:<jurisdicción>':
--                           iibb → Percepciones de IIBB sufridas,
--                           iva → Percepciones de IVA sufridas,
--                           ganancias → Percepciones de Ganancias sufridas,
--                           * (SUSS, débitos y créditos, otros) →
--                           Retenciones e impuestos sufridos en cobros.
--        iibb_impuesto      Impuesto sobre los ingresos brutos (egreso).
--        iibb_a_pagar       Ingresos brutos a pagar.
--   B) acc_sync_tax_suffered: RECLASIFICA desde la cuenta donde el documento
--      vinculado dejó la plata que falta hacia la de retenciones sufridas del
--      impuesto (debe retención sufrida / haber cuenta del documento):
--        • línea de liquidación de procesador → impuestos_procesador (la
--          acreditación ya las llevó ahí, ADR-066);
--        • débito del banco (movimiento de tesorería) → tesoreria_mov del
--          tipo (contrapartida del retiro);
--        • cobro de una venta → cobro del medio (y adquirente) del cobro;
--        • cobro de cuenta corriente → cobro del medio del recibo.
--      Primero asegura el asiento del documento (idempotente); si el documento
--      todavía no tiene asiento (liquidación sin acreditar o sin conciliar) no
--      hace nada y lo trae el próximo "Generar". Sin documento vinculado, no
--      hay asiento (la UI lo avisa). Anular → contra-asiento.
--   C) acc_sync_iibb_liquidation: debe Impuesto IIBB (determinado) / haber
--      retención sufrida IIBB de la jurisdicción (lo usado del saldo a favor y
--      de las retenciones y percepciones del mes; lo de facturas de
--      proveedor, desde la cuenta de percepciones de compras) / haber IIBB a
--      pagar (saldo a pagar). Fecha: último día del mes liquidado. Anular →
--      contra-asiento.
--   D) acc_sync (despachador) RECREADO desde 20261029100200 (única
--      definición) con los dos orígenes nuevos; acc_generate RECREADO desde
--      20261029100200 (única definición) sumando los dos orígenes al rango.
--   E) Triggers diferidos (al commit; nunca frenan la operación).
--
-- Gating: los asientos sólo existen con la feature contabilidad
-- (acc_tenant_active, acc_assert); el registro sufrido y la liquidación,
-- con percepciones_retenciones.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Mapeos por defecto
-- -----------------------------------------------------------------------------
create or replace function _acc_tax_subject_mappings(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into acc_mappings (tenant_id, concept, qualifier, account_id)
  select p_tenant, m.concept, m.qualifier, a.id
    from (values
            ('retencion_sufrida', '*',         'ret_cobros'),
            ('retencion_sufrida', 'iibb',      'perc_iibb'),
            ('retencion_sufrida', 'iva',       'perc_iva'),
            ('retencion_sufrida', 'ganancias', 'perc_ganancias'),
            ('iibb_impuesto',     '*',         'iibb'),
            ('iibb_a_pagar',      '*',         'iibb_a_pagar')) as m(concept, qualifier, skey)
    join acc_accounts a on a.tenant_id = p_tenant and a.system_key = m.skey and a.deleted_at is null
   where not exists (select 1 from acc_mappings x
                      where x.tenant_id = p_tenant and x.concept = m.concept)
  on conflict do nothing;
end;
$$;
revoke all on function _acc_tax_subject_mappings(uuid) from public, anon, authenticated;

-- Negocios que ya tienen la contabilidad.
do $$
declare
  r record;
begin
  for r in select tenant_id from acc_settings loop
    perform _acc_tax_subject_mappings(r.tenant_id);
  end loop;
end $$;

-- Calificador de la cuenta de retenciones sufridas.
create or replace function acc_suffered_qualifier(p_tax text, p_jur text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_tax = 'iibb' and p_jur is not null then 'iibb:' || p_jur else coalesce(p_tax, 'otro') end;
$$;

-- -----------------------------------------------------------------------------
-- B) Retención o percepción sufrida
-- -----------------------------------------------------------------------------
create or replace function acc_sync_tax_suffered(p_tenant uuid, p_id uuid, p_refresh boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e tax_suffered_entries%rowtype;
  cfg acc_settings%rowtype;
  v_cr uuid;
  v_store uuid;
  v_desc text;
  sl settlement_lines%rowtype;
  mv treasury_movements%rowtype;
  ta treasury_accounts%rowtype;
  pm payments%rowtype;
  cm customer_account_movements%rowtype;
begin
  select * into e from tax_suffered_entries where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if e.operation_date < cfg.start_date then
    return;
  end if;
  perform _acc_tax_subject_mappings(p_tenant);

  if p_refresh then
    perform acc_unpost(p_tenant, 'tax_suffered', e.id, 'main', 'Retención sufrida actualizada');
  end if;

  v_desc := case e.kind when 'percepcion' then 'Percepción' when 'pago_a_cuenta' then 'Pago a cuenta' else 'Retención' end
            || ' sufrida ' || case e.tax when 'iibb' then 'IIBB' when 'iva' then 'IVA' when 'ganancias' then 'Ganancias'
                                         when 'suss' then 'SUSS' when 'debitos_creditos' then 'débitos y créditos'
                                         else 'otro impuesto' end
            || coalesce(' ' || e.jurisdiction, '')
            || case when e.regime in ('sircreb', 'sirtac') then ' ' || upper(e.regime) else '' end
            || coalesce(' cert. ' || e.certificate, '');

  if e.status = 'active' and acc_entry_of(p_tenant, 'tax_suffered', e.id, 'main') is null then
    v_store := e.store_id;
    if e.settlement_line_id is not null then
      select * into sl from settlement_lines where id = e.settlement_line_id and tenant_id = p_tenant;
      if not found then return; end if;
      perform acc_sync_settlement_line(p_tenant, sl.id);
      if acc_entry_of(p_tenant, 'settlement_line', sl.id, 'release') is null then
        return;
      end if;
      select coalesce(sl.scope_store_id, s.store_id) into v_store
        from payments p left join sales s on s.id = p.sale_id where p.id = sl.payment_id;
      v_cr := acc_account_for(p_tenant, 'impuestos_procesador', regexp_replace(lower(sl.provider_key), '_point$', ''), v_store);
    elsif e.treasury_movement_id is not null then
      select * into mv from treasury_movements where id = e.treasury_movement_id and tenant_id = p_tenant;
      if not found then return; end if;
      perform acc_sync_treasury_movement(p_tenant, mv.id);
      if acc_entry_of(p_tenant, 'treasury_movement', mv.id, 'movement') is null then
        return;
      end if;
      select * into ta from treasury_accounts where id = mv.account_id;
      v_store := coalesce(v_store, ta.store_id);
      v_cr := acc_account_for(p_tenant, 'tesoreria_mov', mv.type, ta.store_id);
    elsif e.payment_id is not null then
      select * into pm from payments where id = e.payment_id and tenant_id = p_tenant;
      if not found then return; end if;
      if acc_entry_of(p_tenant, 'sale', pm.sale_id, 'sale') is null then
        perform acc_sync_sale(p_tenant, pm.sale_id);
        if acc_entry_of(p_tenant, 'sale', pm.sale_id, 'sale') is null then
          return;
        end if;
      end if;
      select coalesce(v_store, s.store_id) into v_store from sales s where s.id = pm.sale_id;
      v_cr := acc_account_for(p_tenant, 'cobro', acc_payment_qualifier(p_tenant, pm.method, pm.reference, pm.card_voucher), v_store);
    elsif e.cc_movement_id is not null then
      select * into cm from customer_account_movements where id = e.cc_movement_id and tenant_id = p_tenant;
      if not found then return; end if;
      perform acc_sync_cc_movement(p_tenant, cm.id);
      if acc_entry_of(p_tenant, 'cc_movement', cm.id, 'main') is null then
        return;
      end if;
      v_store := coalesce(v_store, acc_shift_store(cm.cash_shift_id));
      v_cr := acc_account_for(p_tenant, 'cobro', coalesce(cm.method, 'other'), acc_shift_store(cm.cash_shift_id));
    else
      -- Sin documento vinculado: no hay de dónde reclasificar.
      return;
    end if;
    perform acc_post(p_tenant, e.operation_date, 'tax_suffered', e.id, 'main', v_desc, v_store,
                     jsonb_build_array(
                       acc_line(acc_account_for(p_tenant, 'retencion_sufrida', acc_suffered_qualifier(e.tax, e.jurisdiction), v_store),
                                e.amount, v_desc),
                       acc_line(v_cr, -e.amount)));
  end if;

  if e.status = 'voided' then
    perform acc_post_reversal(p_tenant, 'tax_suffered', e.id, 'main', 'void',
                              acc_ar_date(coalesce(e.voided_at, now())), 'Anulación ' || v_desc);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Liquidación de IIBB
-- -----------------------------------------------------------------------------
create or replace function acc_sync_iibb_liquidation(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l iibb_liquidations%rowtype;
  cfg acc_settings%rowtype;
  v_date date;
  v_compras numeric;
  v_from_compras numeric;
  v_desc text;
  v_jname text;
begin
  select * into l from iibb_liquidations where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_date := (l.period + interval '1 month' - interval '1 day')::date;
  if v_date < cfg.start_date then
    return;
  end if;
  perform _acc_tax_subject_mappings(p_tenant);
  select name into v_jname from tax_jurisdictions where code = l.jurisdiction;
  v_desc := 'Liquidación IIBB ' || coalesce(v_jname, l.jurisdiction) || ' ' || to_char(l.period, 'MM/YYYY');

  if acc_entry_of(p_tenant, 'iibb_liquidation', l.id, 'main') is null and l.determined > 0 then
    -- Lo usado sale primero del saldo a favor y de las sufridas registradas;
    -- lo que falte, de las percepciones de facturas de proveedor.
    v_compras := coalesce((l.snapshot -> 'deductions' ->> 'compras')::numeric, 0);
    v_from_compras := greatest(0, least(v_compras, l.used - (l.previous_credit + l.deductions_total - v_compras)));
    perform acc_post(p_tenant, v_date, 'iibb_liquidation', l.id, 'main', v_desc, null,
                     jsonb_build_array(
                       acc_line(acc_account_for(p_tenant, 'iibb_impuesto', l.jurisdiction, null), l.determined, 'Impuesto determinado'),
                       acc_line(acc_account_for(p_tenant, 'retencion_sufrida', 'iibb:' || l.jurisdiction, null),
                                -(l.used - v_from_compras), 'Saldo a favor y retenciones usadas'),
                       acc_line(acc_account_for(p_tenant, 'percepcion', 'percepcion_iibb', null),
                                -v_from_compras, 'Percepciones de compras usadas'),
                       acc_line(acc_account_for(p_tenant, 'iibb_a_pagar', l.jurisdiction, null), -l.to_pay, 'Saldo a pagar')));
  end if;

  if l.status = 'voided' then
    perform acc_post_reversal(p_tenant, 'iibb_liquidation', l.id, 'main', 'void',
                              acc_ar_date(coalesce(l.voided_at, now())), 'Anulación ' || v_desc);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- D) Despachador y generación (recreados desde 20261029100200)
-- -----------------------------------------------------------------------------
create or replace function acc_sync(p_tenant uuid, p_type text, p_id uuid, p_refresh boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case p_type
    when 'sale' then perform acc_sync_sale(p_tenant, p_id);
    when 'sale_return' then perform acc_sync_sale_return(p_tenant, p_id);
    when 'cc_movement' then perform acc_sync_cc_movement(p_tenant, p_id, p_refresh);
    when 'cash_shift' then perform acc_sync_cash_shift(p_tenant, p_id);
    when 'cash_movement' then perform acc_sync_cash_movement(p_tenant, p_id);
    when 'supplier_invoice' then perform acc_sync_supplier_invoice(p_tenant, p_id, p_refresh);
    when 'supplier_payment' then perform acc_sync_supplier_payment(p_tenant, p_id);
    when 'treasury_movement' then perform acc_sync_treasury_movement(p_tenant, p_id);
    when 'settlement_line' then perform acc_sync_settlement_line(p_tenant, p_id);
    when 'payment_dispute' then perform acc_sync_payment_dispute(p_tenant, p_id);
    when 'tax_suffered' then perform acc_sync_tax_suffered(p_tenant, p_id, p_refresh);
    when 'iibb_liquidation' then perform acc_sync_iibb_liquidation(p_tenant, p_id);
    else raise exception 'acc_source_unknown: %', p_type;
  end case;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'acc_sync_tax_suffered(uuid, uuid, boolean)', 'acc_sync_iibb_liquidation(uuid, uuid)',
    'acc_sync(uuid, text, uuid, boolean)', 'acc_suffered_qualifier(text, text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

create or replace function acc_generate(p_from date, p_to date, p_regenerate boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  cfg acc_settings%rowtype;
  v_from timestamptz;
  v_to timestamptz;
  v_deleted int := 0;
  v_before int;
  v_after int;
  v_failed int := 0;
  r record;
begin
  select * into cfg from acc_settings where tenant_id = v_tenant;
  if not found then
    raise exception 'acc_not_setup';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'acc_range_invalid';
  end if;
  v_from := acc_ar_start(p_from);
  v_to := acc_ar_start(p_to + 1);

  if p_regenerate then
    with del as (
      update acc_entries
         set deleted_at = now(), deleted_by = auth.uid(), delete_reason = 'Regeneración del período'
       where tenant_id = v_tenant and kind = 'auto' and deleted_at is null
         and entry_date between p_from and p_to
         and not acc_period_is_closed(v_tenant, entry_date)
      returning 1
    )
    select count(*) into v_deleted from del;
  end if;

  select count(*) into v_before from acc_entries where tenant_id = v_tenant and deleted_at is null;

  for r in
    select 'sale'::text as t, id from sales
     where tenant_id = v_tenant and status <> 'suspended'
       and ((created_at >= v_from and created_at < v_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 'sale_return', id from sale_returns
     where tenant_id = v_tenant and created_at >= v_from and created_at < v_to
    union all
    select 'cc_movement', id from customer_account_movements
     where tenant_id = v_tenant
       and (kind in ('payment', 'interest', 'interest_waiver', 'adjust_debit', 'adjust_credit')
            or (kind = 'charge' and sale_id is null))
       and ((created_at >= v_from and created_at < v_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 'cash_shift', id from cash_shifts
     where tenant_id = v_tenant and status = 'closed' and closed_at >= v_from and closed_at < v_to
    union all
    select 'cash_movement', id from cash_movements
     where tenant_id = v_tenant and type in ('income', 'expense') and reference_id is null
       and created_at >= v_from and created_at < v_to
    union all
    select 'supplier_invoice', id from supplier_invoices
     where tenant_id = v_tenant
       and ((issue_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 'supplier_payment', id from supplier_payments
     where tenant_id = v_tenant
       and ((paid_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 'treasury_movement', id from treasury_movements
     where tenant_id = v_tenant and type not in ('supplier_payment', 'supplier_payment_void', 'transfer_in')
       and ((movement_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 'settlement_line', id from settlement_lines
     where tenant_id = v_tenant and kind = 'payment' and released and payment_id is not null
       and coalesce(release_date, operation_at) >= v_from and coalesce(release_date, operation_at) < v_to
    union all
    select 'payment_dispute', id from payment_disputes
     where tenant_id = v_tenant and origin = 'provider'
       and coalesce(resolved_at, last_seen_at, occurred_at) >= v_from
       and coalesce(resolved_at, last_seen_at, occurred_at) < v_to
    -- Después de sus documentos (la reclasificación necesita el asiento del
    -- documento vinculado).
    union all
    select 'tax_suffered', id from tax_suffered_entries
     where tenant_id = v_tenant
       and ((operation_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 'iibb_liquidation', id from iibb_liquidations
     where tenant_id = v_tenant
       and (((period + interval '1 month' - interval '1 day')::date between p_from and p_to)
            or (voided_at >= v_from and voided_at < v_to))
  loop
    if not acc_sync_safe(v_tenant, r.t, r.id) then
      v_failed := v_failed + 1;
    end if;
  end loop;

  select count(*) into v_after from acc_entries where tenant_id = v_tenant and deleted_at is null;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'acc_entries', null, case when p_regenerate then 'acc_regenerate' else 'acc_generate' end,
          jsonb_build_object('from', p_from, 'to', p_to, 'deleted', v_deleted,
                             'created', v_after - v_before, 'failed', v_failed));
  return jsonb_build_object('deleted', v_deleted, 'created', v_after - v_before, 'failed', v_failed);
end;
$$;
revoke all on function acc_generate(date, date, boolean) from public, anon;
grant execute on function acc_generate(date, date, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Triggers (al commit; nunca frenan la operación)
-- -----------------------------------------------------------------------------
drop trigger if exists acc_tax_suffered_ins on tax_suffered_entries;
create constraint trigger acc_tax_suffered_ins after insert on tax_suffered_entries
  deferrable initially deferred for each row
  when (new.status = 'active')
  execute function acc_source_trg('tax_suffered');
drop trigger if exists acc_tax_suffered_void on tax_suffered_entries;
create constraint trigger acc_tax_suffered_void after update on tax_suffered_entries
  deferrable initially deferred for each row
  when (old.status is distinct from new.status)
  execute function acc_source_trg('tax_suffered');
drop trigger if exists acc_tax_suffered_edit on tax_suffered_entries;
create constraint trigger acc_tax_suffered_edit after update on tax_suffered_entries
  deferrable initially deferred for each row
  when (new.status = 'active' and old.status = 'active'
        and (old.tax, old.jurisdiction, old.store_id, old.payment_id, old.cc_movement_id, old.settlement_line_id,
             old.treasury_movement_id)
            is distinct from
            (new.tax, new.jurisdiction, new.store_id, new.payment_id, new.cc_movement_id, new.settlement_line_id,
             new.treasury_movement_id))
  execute function acc_source_trg('tax_suffered', 'refresh');

drop trigger if exists acc_iibb_liquidations_ins on iibb_liquidations;
create constraint trigger acc_iibb_liquidations_ins after insert on iibb_liquidations
  deferrable initially deferred for each row
  execute function acc_source_trg('iibb_liquidation');
drop trigger if exists acc_iibb_liquidations_void on iibb_liquidations;
create constraint trigger acc_iibb_liquidations_void after update on iibb_liquidations
  deferrable initially deferred for each row
  when (old.status is distinct from new.status)
  execute function acc_source_trg('iibb_liquidation');
