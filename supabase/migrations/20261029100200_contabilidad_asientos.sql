-- =============================================================================
-- 20261029100200_contabilidad_asientos  (ADR-066 · F18/H109)
--
-- Contabilidad v1, parte 2: asientos.
--
--  A) Núcleo: acc_post (idempotente por origen: tabla + id + evento; netea
--     por cuenta y centro de costo; numera; si la fecha cae en un período
--     cerrado lo imputa al primer día del siguiente abierto), reversión de
--     renglones, IVA incluido por alícuota (espejo de lib/accounting/vat.ts).
--  B) Un armador por evento: venta (por medio de cobro, propina, vuelto,
--     IVA, CMV opcional) y su anulación; devolución; movimientos de cuenta
--     corriente (cobro, anulación, interés, condonación, ajustes); cierre de
--     caja (faltante o sobrante); ingresos y retiros manuales de caja;
--     comprobante de proveedor y su anulación; pago u orden de pago y su
--     anulación; movimiento de tesorería y su anulación; acreditación de la
--     liquidación de un procesador (comisión, impuestos, neto); contracargo o
--     devolución hecha desde el procesador.
--  C) acc_sync / acc_sync_safe: el despachador. Un error no frena nunca la
--     operación: queda en acc_issues para reintentar.
--  D) Triggers DEFERRABLE INITIALLY DEFERRED sobre las tablas existentes (se
--     ejecutan al commit, con los cobros y renglones ya insertados). No se
--     toca create_sale, close_cash_shift, _pc_complete ni el resolutor de
--     precios.
--  E) RPC: acc_generate (generar o regenerar un período), asientos manuales,
--     reversión, cierre y reapertura de período, problemas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Núcleo
-- -----------------------------------------------------------------------------
create or replace function acc_ar_date(p timestamptz)
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (p at time zone 'America/Argentina/Buenos_Aires')::date;
$$;

create or replace function acc_ar_start(p date)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select (p::timestamp at time zone 'America/Argentina/Buenos_Aires');
$$;

-- Primer día abierto desde p_date (si su mes está cerrado, el 1° del
-- siguiente mes abierto).
create or replace function acc_effective_date(p_tenant uuid, p_date date)
returns date
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v date := p_date;
  i int := 0;
begin
  while acc_period_is_closed(p_tenant, v) and i < 240 loop
    v := (date_trunc('month', v::timestamp) + interval '1 month')::date;
    i := i + 1;
  end loop;
  return v;
end;
$$;
revoke all on function acc_effective_date(uuid, date) from public, anon, authenticated;

-- Renglón: {a: cuenta, v: importe con signo (+ debe, - haber), cc?: centro de
-- costo, t?: texto}.
create or replace function acc_line(p_account uuid, p_amount numeric, p_text text default null, p_cc uuid default null)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('a', p_account, 'v', round(coalesce(p_amount, 0), 2), 't', p_text, 'cc', p_cc);
$$;

create or replace function acc_post(
  p_tenant uuid,
  p_date date,
  p_source_type text,
  p_source_id uuid,
  p_event text,
  p_description text,
  p_store uuid,
  p_lines jsonb,
  p_kind text default 'auto',
  p_reversal_of uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_date date;
  v_desc text := left(coalesce(nullif(btrim(p_description), ''), 'Asiento'), 300);
  v_norm jsonb;
  v_sum numeric;
  v_total numeric;
  v_num bigint;
  v_cc uuid;
begin
  if p_source_type is not null then
    select id into v_id from acc_entries
     where tenant_id = p_tenant and source_type = p_source_type and source_id = p_source_id
       and source_event = p_event and deleted_at is null;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  with raw as (
    select nullif(e ->> 'a', '')::uuid as a,
           nullif(e ->> 'cc', '')::uuid as cc,
           round(coalesce((e ->> 'v')::numeric, 0), 2) as v,
           nullif(e ->> 't', '') as t,
           o
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as x(e, o)
  ), agg as (
    select a, cc, sum(v) as v, min(o) as o,
           (array_agg(t order by o) filter (where t is not null))[1] as t
      from raw
     group by a, cc
  )
  select coalesce(jsonb_agg(jsonb_build_object('a', a, 'cc', cc, 'v', v, 't', t) order by (v < 0), o), '[]'::jsonb),
         coalesce(sum(v), 0),
         coalesce(sum(v) filter (where v > 0), 0)
    into v_norm, v_sum, v_total
    from agg
   where v <> 0;

  if exists (select 1 from jsonb_array_elements(v_norm) e where e ->> 'a' is null) then
    raise exception 'acc_line_without_account';
  end if;
  if jsonb_array_length(v_norm) = 0 then
    return null;
  end if;
  if v_sum <> 0 or jsonb_array_length(v_norm) < 2 then
    raise exception 'acc_entry_unbalanced: diferencia %', v_sum;
  end if;

  v_date := p_date;
  if p_kind = 'auto' then
    v_date := acc_effective_date(p_tenant, p_date);
    if v_date <> p_date then
      v_desc := left(v_desc || ' (fecha original ' || to_char(p_date, 'DD/MM/YYYY') || ', período cerrado)', 300);
    end if;
  elsif acc_period_is_closed(p_tenant, p_date) then
    raise exception 'acc_period_closed: %', to_char(p_date, 'MM/YYYY');
  end if;

  v_cc := acc_cost_center_for(p_tenant, p_store);

  perform pg_advisory_xact_lock(hashtext('acc_number:' || p_tenant::text));
  select coalesce(max(number), 0) + 1 into v_num from acc_entries where tenant_id = p_tenant;

  insert into acc_entries (tenant_id, number, entry_date, kind, source_type, source_id, source_event,
                           description, store_id, reversal_of, total)
  values (p_tenant, v_num, v_date, p_kind, p_source_type, p_source_id, p_event,
          v_desc, p_store, p_reversal_of, v_total)
  returning id into v_id;

  insert into acc_entry_lines (tenant_id, entry_id, line_no, account_id, cost_center_id, debit, credit, description)
  select p_tenant, v_id, o::int, (e ->> 'a')::uuid, coalesce(nullif(e ->> 'cc', '')::uuid, v_cc),
         greatest((e ->> 'v')::numeric, 0), greatest(-(e ->> 'v')::numeric, 0),
         left(nullif(e ->> 't', ''), 300)
    from jsonb_array_elements(v_norm) with ordinality as x(e, o);

  return v_id;
end;
$$;
revoke all on function acc_post(uuid, date, text, uuid, text, text, uuid, jsonb, text, uuid) from public, anon, authenticated;

-- Renglones invertidos de un asiento (para anulaciones y reversiones).
create or replace function acc_reverse_lines(p_entry uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('a', account_id, 'cc', cost_center_id,
                                               'v', credit - debit, 't', description) order by line_no),
                  '[]'::jsonb)
    from acc_entry_lines where entry_id = p_entry;
$$;
revoke all on function acc_reverse_lines(uuid) from public, anon, authenticated;

create or replace function acc_entry_of(p_tenant uuid, p_type text, p_id uuid, p_event text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from acc_entries
   where tenant_id = p_tenant and source_type = p_type and source_id = p_id
     and source_event = p_event and deleted_at is null;
$$;
revoke all on function acc_entry_of(uuid, text, uuid, text) from public, anon, authenticated;

-- Anulación automática: contra-asiento del principal (si existe y no está).
create or replace function acc_post_reversal(
  p_tenant uuid, p_type text, p_id uuid, p_main_event text, p_event text, p_date date, p_description text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_main acc_entries%rowtype;
begin
  select * into v_main from acc_entries
   where tenant_id = p_tenant and source_type = p_type and source_id = p_id
     and source_event = p_main_event and deleted_at is null;
  if not found then
    return null;
  end if;
  return acc_post(p_tenant, greatest(p_date, v_main.entry_date), p_type, p_id, p_event, p_description,
                  v_main.store_id, acc_reverse_lines(v_main.id), 'auto', v_main.id);
end;
$$;
revoke all on function acc_post_reversal(uuid, text, uuid, text, text, date, text) from public, anon, authenticated;

-- Al cambiar el documento: baja lógica del asiento si el período está abierto.
create or replace function acc_unpost(p_tenant uuid, p_type text, p_id uuid, p_event text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_e acc_entries%rowtype;
begin
  select * into v_e from acc_entries
   where tenant_id = p_tenant and source_type = p_type and source_id = p_id
     and source_event = p_event and deleted_at is null;
  if not found then
    return false;
  end if;
  if acc_period_is_closed(p_tenant, v_e.entry_date) then
    raise exception 'acc_period_closed_changed: el documento cambió después del cierre de %',
      to_char(v_e.entry_date, 'MM/YYYY');
  end if;
  update acc_entries set deleted_at = now(), deleted_by = auth.uid(), delete_reason = p_reason
   where id = v_e.id;
  return true;
end;
$$;
revoke all on function acc_unpost(uuid, text, uuid, text, text) from public, anon, authenticated;

-- IVA incluido por alícuota (espejo de splitVat en lib/accounting/vat.ts).
-- Reparte el total en proporción a los importes de cada alícuota (la última,
-- de mayor a menor, absorbe el redondeo) y separa el IVA de cada parte.
create or replace function acc_vat_split(p_total numeric, p_items jsonb, p_mode text, p_default_rate numeric)
returns table (rate numeric, gross numeric, net numeric, vat numeric)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_total numeric := round(coalesce(p_total, 0), 2);
  v_base numeric;
  v_left numeric;
  v_n int;
  v_i int := 0;
  g record;
  v_gross numeric;
begin
  if p_mode = 'none' then
    rate := 0; gross := v_total; net := v_total; vat := 0;
    return next;
    return;
  end if;
  select coalesce(sum(coalesce((e ->> 'amount')::numeric, 0)), 0), count(distinct coalesce((e ->> 'rate')::numeric, p_default_rate))
    into v_base, v_n
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e;
  if v_base <= 0 or v_n = 0 then
    rate := p_default_rate; gross := v_total;
    vat := round(v_total * p_default_rate / (100 + p_default_rate), 2);
    net := v_total - vat;
    return next;
    return;
  end if;
  v_left := v_total;
  for g in
    select coalesce((e ->> 'rate')::numeric, p_default_rate) as r,
           sum(coalesce((e ->> 'amount')::numeric, 0)) as amt
      from jsonb_array_elements(p_items) e
     group by 1
     order by 1 desc
  loop
    v_i := v_i + 1;
    if v_i = v_n then
      v_gross := v_left;
    else
      v_gross := round(v_total * g.amt / v_base, 2);
    end if;
    v_left := v_left - v_gross;
    rate := g.r;
    gross := v_gross;
    vat := round(v_gross * g.r / (100 + g.r), 2);
    net := v_gross - vat;
    return next;
  end loop;
end;
$$;

-- Calificador de un cobro: medio y, si se conoce, el adquirente o proveedor
-- ("credit:payway", "qr:mercadopago", "cash"). Sin sufijo _point.
create or replace function acc_payment_qualifier(p_tenant uuid, p_method text, p_reference text, p_voucher jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_provider text := lower(nullif(btrim(coalesce(p_voucher ->> 'adquirente', '')), ''));
begin
  if v_provider is null and p_reference ~ '^[0-9a-fA-F-]{36}$' then
    select lower(provider_key) into v_provider
      from mp_payment_intents where id = p_reference::uuid and tenant_id = p_tenant;
  end if;
  v_provider := regexp_replace(v_provider, '_point$', '');
  if v_provider = 'other' then
    v_provider := null;
  end if;
  return coalesce(nullif(p_method, ''), 'other') || coalesce(':' || v_provider, '');
end;
$$;
revoke all on function acc_payment_qualifier(uuid, text, text, jsonb) from public, anon, authenticated;

create or replace function acc_rate_text(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select trim_scale(p)::text;
$$;

create or replace function acc_shift_store(p_shift uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(cs.store_id, cr.store_id)
    from cash_shifts cs left join cash_registers cr on cr.id = cs.cash_register_id
   where cs.id = p_shift;
$$;
revoke all on function acc_shift_store(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Armadores por evento
-- -----------------------------------------------------------------------------

-- Venta: debe por cada cobro; haber ventas netas e IVA por alícuota, propina;
-- vuelto contra caja o redondeo; CMV al costo vigente si cmv_mode = perpetual.
create or replace function acc_sync_sale(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s sales%rowtype;
  cfg acc_settings%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_paid numeric := 0;
  v_cash_acc uuid;
  v_diff numeric;
  v_cost numeric;
  p record;
  v record;
  v_items jsonb;
begin
  select * into s from sales where id = p_id and tenant_id = p_tenant;
  if not found or s.status = 'suspended' then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if acc_ar_date(s.created_at) < cfg.start_date then
    return;
  end if;

  if acc_entry_of(p_tenant, 'sale', s.id, 'sale') is null then
    for p in select * from payments where sale_id = s.id and tenant_id = p_tenant order by created_at, id loop
      continue when coalesce(p.amount, 0) = 0;
      v_lines := v_lines || acc_line(
        acc_account_for(p_tenant, 'cobro', acc_payment_qualifier(p_tenant, p.method, p.reference, p.card_voucher), s.store_id),
        p.amount, 'Cobro ' || p.method);
      v_paid := v_paid + p.amount;
      if p.method = 'cash' then
        v_cash_acc := acc_account_for(p_tenant, 'cobro', 'cash', s.store_id);
      end if;
    end loop;

    if coalesce(s.tip_amount, 0) > 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'propinas', '*', s.store_id), -s.tip_amount, 'Propina');
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('amount', si.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
      into v_items
      from sale_items si left join products pr on pr.id = si.product_id
     where si.sale_id = s.id;
    for v in select * from acc_vat_split(s.total, v_items, cfg.vat_mode, cfg.default_vat_rate) loop
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'ventas', '*', s.store_id), -v.net, 'Ventas');
      if v.vat <> 0 then
        v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'iva_df', acc_rate_text(v.rate), s.store_id),
                                       -v.vat, 'IVA ' || acc_rate_text(v.rate) || ' %');
      end if;
    end loop;

    v_diff := round(v_paid - s.total - coalesce(s.tip_amount, 0), 2);
    if v_diff > 0 and v_cash_acc is not null then
      v_lines := v_lines || acc_line(v_cash_acc, -v_diff, 'Vuelto');
    elsif v_diff <> 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'redondeo', '*', s.store_id), -v_diff, 'Diferencia de cobro');
    end if;

    if cfg.cmv_mode = 'perpetual' then
      select round(coalesce(sum(si.quantity * coalesce(pr.cost, 0)), 0), 2) into v_cost
        from sale_items si join products pr on pr.id = si.product_id
       where si.sale_id = s.id;
      if v_cost > 0 then
        v_lines := v_lines
          || acc_line(acc_account_for(p_tenant, 'cmv', '*', s.store_id), v_cost, 'Costo de lo vendido')
          || acc_line(acc_account_for(p_tenant, 'mercaderias', '*', s.store_id), -v_cost, 'Salida de mercadería');
      end if;
    end if;

    perform acc_post(p_tenant, acc_ar_date(s.created_at), 'sale', s.id, 'sale',
                     'Venta #' || s.number, s.store_id, v_lines);
  end if;

  if s.status = 'voided' then
    perform acc_post_reversal(p_tenant, 'sale', s.id, 'sale', 'void',
                              acc_ar_date(coalesce(s.voided_at, now())), 'Anulación de la venta #' || s.number);
  end if;
end;
$$;

-- Devolución: debe devoluciones e IVA; haber cuenta corriente y medio de
-- reintegro (efectivo o saldo a favor). CMV inverso si perpetual y repone.
create or replace function acc_sync_sale_return(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r sale_returns%rowtype;
  s sales%rowtype;
  cfg acc_settings%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_items jsonb;
  v_acc numeric;
  v_rest numeric;
  v_cost numeric;
  v record;
begin
  select * into r from sale_returns where id = p_id and tenant_id = p_tenant;
  if not found or coalesce(r.total, 0) <= 0 then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if acc_ar_date(r.created_at) < cfg.start_date or acc_entry_of(p_tenant, 'sale_return', r.id, 'return') is not null then
    return;
  end if;
  select * into s from sales where id = r.sale_id;

  select coalesce(jsonb_agg(jsonb_build_object('amount', ri.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
    into v_items
    from sale_return_items ri
    join sale_items si on si.id = ri.sale_item_id
    left join products pr on pr.id = si.product_id
   where ri.return_id = r.id;
  for v in select * from acc_vat_split(r.total, v_items, cfg.vat_mode, cfg.default_vat_rate) loop
    v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'devoluciones_ventas', '*', s.store_id), v.net, 'Devolución');
    if v.vat <> 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'iva_df', acc_rate_text(v.rate), s.store_id),
                                     v.vat, 'IVA ' || acc_rate_text(v.rate) || ' %');
    end if;
  end loop;

  v_acc := least(coalesce(r.account_credited, 0), r.total);
  v_rest := r.total - v_acc;
  if v_acc > 0 then
    v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'cobro', 'account', s.store_id), -v_acc, 'A cuenta corriente');
  end if;
  if v_rest > 0 then
    v_lines := v_lines || acc_line(
      acc_account_for(p_tenant, 'cobro',
                      case r.refund_method when 'store_credit' then 'store_credit'
                                           when 'account' then 'account' else 'cash' end,
                      s.store_id),
      -v_rest, 'Reintegro');
  end if;

  if cfg.cmv_mode = 'perpetual' then
    select round(coalesce(sum(ri.quantity * coalesce(pr.cost, 0)), 0), 2) into v_cost
      from sale_return_items ri
      join sale_items si on si.id = ri.sale_item_id
      join products pr on pr.id = si.product_id
     where ri.return_id = r.id and ri.restock = 'stock';
    if v_cost > 0 then
      v_lines := v_lines
        || acc_line(acc_account_for(p_tenant, 'mercaderias', '*', s.store_id), v_cost, 'Reingreso de mercadería')
        || acc_line(acc_account_for(p_tenant, 'cmv', '*', s.store_id), -v_cost, 'Costo de lo devuelto');
    end if;
  end if;

  perform acc_post(p_tenant, acc_ar_date(r.created_at), 'sale_return', r.id, 'return',
                   'Devolución #' || r.number || ' de la venta #' || s.number, s.store_id, v_lines);
end;
$$;

-- Cuenta corriente: cobro (y su anulación), interés, condonación, ajustes y
-- cargos manuales. Los cargos de una venta y las reversas salen de la venta.
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
          acc_line(acc_account_for(p_tenant, 'cobro', coalesce(m.method, 'other'), v_store), v_amt, 'Cobro ' || coalesce(m.method, '')),
          acc_line(v_deu, -v_amt, 'Deudores'));
      when 'interest' then
        v_desc := 'Interés de cuenta corriente';
        v_lines := jsonb_build_array(acc_line(v_deu, v_amt), acc_line(acc_account_for(p_tenant, 'intereses_cc', '*', v_store), -v_amt));
      when 'interest_waiver' then
        v_desc := 'Condonación de interés';
        v_lines := jsonb_build_array(acc_line(acc_account_for(p_tenant, 'intereses_cc', '*', v_store), v_amt), acc_line(v_deu, -v_amt));
      when 'adjust_credit' then
        v_desc := 'Ajuste a favor del cliente';
        v_lines := jsonb_build_array(acc_line(acc_account_for(p_tenant, 'ajustes_cc', '*', v_store), v_amt), acc_line(v_deu, -v_amt));
      else
        v_desc := case m.kind when 'charge' then 'Cargo manual en cuenta corriente' else 'Ajuste en contra del cliente' end;
        v_lines := jsonb_build_array(acc_line(v_deu, v_amt), acc_line(acc_account_for(p_tenant, 'ajustes_cc', '*', v_store), -v_amt));
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

-- Cierre de caja: diferencia del arqueo contra la caja de la sucursal.
create or replace function acc_sync_cash_shift(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sh cash_shifts%rowtype;
  cfg acc_settings%rowtype;
  v_store uuid;
  v_caja uuid;
  v_reg text;
begin
  select * into sh from cash_shifts where id = p_id and tenant_id = p_tenant;
  if not found or sh.status <> 'closed' or sh.closed_at is null or coalesce(sh.difference, 0) = 0 then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if acc_ar_date(sh.closed_at) < cfg.start_date then
    return;
  end if;
  v_store := acc_shift_store(sh.id);
  v_caja := acc_account_for(p_tenant, 'cobro', 'cash', v_store);
  select name into v_reg from cash_registers where id = sh.cash_register_id;
  perform acc_post(p_tenant, acc_ar_date(sh.closed_at), 'cash_shift', sh.id, 'close',
    case when sh.difference < 0 then 'Faltante de caja' else 'Sobrante de caja' end || coalesce(' · ' || v_reg, ''),
    v_store,
    case when sh.difference < 0 then
      jsonb_build_array(acc_line(acc_account_for(p_tenant, 'faltante_caja', '*', v_store), -sh.difference),
                        acc_line(v_caja, sh.difference))
    else
      jsonb_build_array(acc_line(v_caja, sh.difference),
                        acc_line(acc_account_for(p_tenant, 'sobrante_caja', '*', v_store), -sh.difference))
    end);
end;
$$;

-- Ingresos y retiros manuales de caja (sin documento vinculado).
create or replace function acc_sync_cash_movement(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cm cash_movements%rowtype;
  cfg acc_settings%rowtype;
  v_store uuid;
  v_caja uuid;
  v_other uuid;
  v_amt numeric;
begin
  select * into cm from cash_movements where id = p_id and tenant_id = p_tenant;
  if not found or cm.type not in ('income', 'expense') or cm.reference_id is not null then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if acc_ar_date(cm.created_at) < cfg.start_date then
    return;
  end if;
  v_amt := abs(coalesce(cm.amount, 0));
  if v_amt = 0 then
    return;
  end if;
  v_store := acc_shift_store(cm.cash_shift_id);
  v_caja := acc_account_for(p_tenant, 'cobro', 'cash', v_store);
  v_other := acc_account_for(p_tenant, 'caja_movimiento', cm.type, v_store);
  perform acc_post(p_tenant, acc_ar_date(cm.created_at), 'cash_movement', cm.id, 'main',
    coalesce(nullif(btrim(cm.reason), ''), case cm.type when 'income' then 'Ingreso de caja' else 'Retiro de caja' end),
    v_store,
    case cm.type when 'income' then
      jsonb_build_array(acc_line(v_caja, v_amt), acc_line(v_other, -v_amt))
    else
      jsonb_build_array(acc_line(v_other, v_amt), acc_line(v_caja, -v_amt))
    end);
end;
$$;

-- Comprobante de proveedor: compras (neto, exento, no gravado e internos),
-- IVA crédito fiscal por alícuota, percepciones; haber proveedores. NC al
-- revés. En moneda extranjera, al tipo de cambio del comprobante.
create or replace function acc_sync_supplier_invoice(p_tenant uuid, p_id uuid, p_refresh boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i supplier_invoices%rowtype;
  cfg acc_settings%rowtype;
  v_sup text;
  v_store uuid;
  v_sign int;
  v_total numeric;
  v_others numeric := 0;
  v_amt numeric;
  v_lines jsonb := '[]'::jsonb;
  e jsonb;
  v_desc text;
begin
  select * into i from supplier_invoices where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if i.issue_date < cfg.start_date then
    return;
  end if;
  if p_refresh and i.status = 'posted' then
    perform acc_unpost(p_tenant, 'supplier_invoice', i.id, 'invoice', 'Comprobante editado');
  end if;

  select name into v_sup from suppliers where id = i.supplier_id;
  select store_id into v_store from purchase_orders where id = i.order_id;
  v_desc := case i.kind when 'credit_note' then 'NC' when 'debit_note' then 'ND' else 'Factura' end
            || ' ' || i.letter || ' ' || lpad(i.point_of_sale::text, 5, '0') || '-' || lpad(i.number::text, 8, '0')
            || coalesce(' · ' || v_sup, '');

  if acc_entry_of(p_tenant, 'supplier_invoice', i.id, 'invoice') is null then
    v_sign := case when i.kind = 'credit_note' then -1 else 1 end;
    v_total := round(i.total * i.fx_rate, 2);
    for e in select * from jsonb_array_elements(i.vat_lines) loop
      v_amt := round(coalesce((e ->> 'vat')::numeric, 0) * i.fx_rate, 2);
      if v_amt <> 0 then
        v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'iva_cf', acc_rate_text((e ->> 'rate')::numeric), v_store),
                                       v_sign * v_amt, 'IVA ' || acc_rate_text((e ->> 'rate')::numeric) || ' %');
        v_others := v_others + v_amt;
      end if;
    end loop;
    for e in select * from jsonb_array_elements(i.other_taxes) loop
      v_amt := round(coalesce((e ->> 'amount')::numeric, 0) * i.fx_rate, 2);
      if v_amt <> 0 then
        v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'percepcion', coalesce(e ->> 'kind', 'otro'), v_store),
                                       v_sign * v_amt, coalesce(nullif(e ->> 'description', ''), e ->> 'kind'));
        v_others := v_others + v_amt;
      end if;
    end loop;
    v_lines := v_lines
      || acc_line(acc_account_for(p_tenant, 'compras', i.supplier_id::text, v_store), v_sign * (v_total - v_others), 'Neto, exento y no gravado')
      || acc_line(acc_account_for(p_tenant, 'proveedores', i.supplier_id::text, v_store), -v_sign * v_total, v_sup);
    perform acc_post(p_tenant, i.issue_date, 'supplier_invoice', i.id, 'invoice', v_desc, v_store, v_lines);
  end if;

  if i.status = 'voided' then
    perform acc_post_reversal(p_tenant, 'supplier_invoice', i.id, 'invoice', 'void',
                              acc_ar_date(coalesce(i.voided_at, now())), 'Anulación ' || v_desc);
  end if;
end;
$$;

-- Pago u orden de pago: debe proveedores; haber cada medio (tesorería,
-- efectivo de la caja, cheques) y las retenciones practicadas.
create or replace function acc_sync_supplier_payment(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sp supplier_payments%rowtype;
  cfg acc_settings%rowtype;
  v_sup text;
  v_lines jsonb := '[]'::jsonb;
  v_credits numeric := 0;
  v_amt numeric;
  v_acc uuid;
  l record;
  ta treasury_accounts%rowtype;
  e jsonb;
  v_desc text;
  v_has_lines boolean;
begin
  select * into sp from supplier_payments where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if sp.paid_date < cfg.start_date then
    return;
  end if;
  select name into v_sup from suppliers where id = sp.supplier_id;
  v_desc := case when sp.kind = 'order' then 'Orden de pago OP-' || sp.number else 'Pago a proveedor N° ' || sp.number end
            || coalesce(' · ' || v_sup, '');

  if acc_entry_of(p_tenant, 'supplier_payment', sp.id, 'payment') is null then
    v_has_lines := exists (select 1 from supplier_payment_lines where payment_id = sp.id);
    if v_has_lines then
      for l in select * from supplier_payment_lines where payment_id = sp.id order by sort, created_at loop
        v_amt := round(l.amount * sp.fx_rate, 2);
        if l.treasury_account_id is not null and l.method in ('transferencia', 'deposito') then
          select * into ta from treasury_accounts where id = l.treasury_account_id;
          v_acc := acc_account_for(p_tenant, 'tesoreria', ta.kind || ':' || ta.id::text, ta.store_id);
        else
          v_acc := acc_account_for(p_tenant, 'pago', l.method, acc_shift_store(l.cash_shift_id));
        end if;
        v_lines := v_lines || acc_line(v_acc, -v_amt, coalesce(l.reference, l.method));
        v_credits := v_credits + v_amt;
      end loop;
    else
      v_amt := round(sp.net_paid * sp.fx_rate, 2);
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'pago', sp.method, null), -v_amt, coalesce(sp.reference, sp.method));
      v_credits := v_credits + v_amt;
    end if;
    for e in select * from jsonb_array_elements(sp.withholdings) loop
      v_amt := round(coalesce((e ->> 'amount')::numeric, 0) * sp.fx_rate, 2);
      if v_amt <> 0 then
        v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'retencion_practicada', coalesce(e ->> 'kind', 'otro'), null),
                                       -v_amt, 'Retención ' || coalesce(e ->> 'kind', '') || coalesce(' cert. ' || nullif(e ->> 'certificate', ''), ''));
        v_credits := v_credits + v_amt;
      end if;
    end loop;
    v_lines := acc_line(acc_account_for(p_tenant, 'proveedores', sp.supplier_id::text, null), v_credits, v_sup) || v_lines;
    perform acc_post(p_tenant, sp.paid_date, 'supplier_payment', sp.id, 'payment', v_desc, null, v_lines);
  end if;

  if sp.status = 'voided' then
    perform acc_post_reversal(p_tenant, 'supplier_payment', sp.id, 'payment', 'void',
                              acc_ar_date(coalesce(sp.voided_at, now())), 'Anulación ' || v_desc);
  end if;
end;
$$;

-- Movimiento de tesorería: cuenta de tesorería contra la contrapartida del
-- tipo (o la otra cuenta en las transferencias). Los de órdenes de pago salen
-- de la orden.
create or replace function acc_sync_treasury_movement(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  mv treasury_movements%rowtype;
  cfg acc_settings%rowtype;
  ta treasury_accounts%rowtype;
  tb treasury_accounts%rowtype;
  v_a uuid;
  v_b uuid;
  v_desc text;
begin
  select * into mv from treasury_movements where id = p_id and tenant_id = p_tenant;
  if not found or mv.type in ('supplier_payment', 'supplier_payment_void', 'transfer_in') then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if mv.movement_date < cfg.start_date then
    return;
  end if;
  select * into ta from treasury_accounts where id = mv.account_id;
  v_desc := case mv.type
              when 'deposit' then 'Depósito o ingreso'
              when 'withdrawal' then 'Retiro o gasto'
              when 'transfer_out' then 'Transferencia entre cuentas'
              when 'cheque_deposit' then 'Depósito de cheque'
              when 'cheque_debit' then 'Débito de cheque propio'
              when 'cheque_rejected' then 'Cheque rechazado'
              when 'adjustment' then 'Ajuste de tesorería'
              else 'Movimiento de tesorería' end
            || ' · ' || ta.name || coalesce(' · ' || nullif(btrim(mv.description), ''), '');

  if acc_entry_of(p_tenant, 'treasury_movement', mv.id, 'movement') is null then
    v_a := acc_account_for(p_tenant, 'tesoreria', ta.kind || ':' || ta.id::text, ta.store_id);
    if mv.type = 'transfer_out' then
      select t.* into tb from treasury_movements c join treasury_accounts t on t.id = c.account_id
       where c.id = mv.counterpart_id;
      if tb.id is null then
        raise exception 'acc_transfer_without_counterpart';
      end if;
      v_b := acc_account_for(p_tenant, 'tesoreria', tb.kind || ':' || tb.id::text, tb.store_id);
    else
      v_b := acc_account_for(p_tenant, 'tesoreria_mov', mv.type, ta.store_id);
    end if;
    perform acc_post(p_tenant, mv.movement_date, 'treasury_movement', mv.id, 'movement', v_desc, ta.store_id,
                     jsonb_build_array(acc_line(v_a, mv.amount, ta.name), acc_line(v_b, -mv.amount)));
  end if;

  if mv.voided_at is not null then
    perform acc_post_reversal(p_tenant, 'treasury_movement', mv.id, 'movement', 'void',
                              acc_ar_date(mv.voided_at), 'Anulación ' || v_desc);
  end if;
end;
$$;

-- Liquidación de un procesador: al acreditarse, cancela lo cobrado (bruto
-- menos devuelto) contra comisión, impuestos y neto acreditado.
create or replace function acc_sync_settlement_line(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sl settlement_lines%rowtype;
  cfg acc_settings%rowtype;
  p payments%rowtype;
  s sales%rowtype;
  v_store uuid;
  v_prov text;
  v_eff numeric;
  v_fee numeric;
  v_tax numeric;
  v_net numeric;
  v_diff numeric;
  v_date date;
  v_lines jsonb;
begin
  select * into sl from settlement_lines where id = p_id and tenant_id = p_tenant;
  if not found or sl.kind <> 'payment' or not sl.released or sl.payment_id is null then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_date := acc_ar_date(coalesce(sl.release_date, sl.operation_at));
  if v_date < cfg.start_date or acc_entry_of(p_tenant, 'settlement_line', sl.id, 'release') is not null then
    return;
  end if;
  select * into p from payments where id = sl.payment_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into s from sales where id = p.sale_id;
  v_store := coalesce(sl.scope_store_id, s.store_id);
  v_prov := regexp_replace(lower(sl.provider_key), '_point$', '');
  v_eff := round(sl.gross - coalesce(sl.refunded, 0), 2);
  if v_eff <= 0 then
    return;
  end if;
  v_fee := round(abs(coalesce(sl.fee, 0)), 2);
  v_tax := round(abs(coalesce(sl.taxes, 0)), 2);
  v_net := round(coalesce(sl.net, 0), 2);
  v_diff := v_eff - v_fee - v_tax - v_net;
  v_lines := jsonb_build_array(
    acc_line(acc_account_for(p_tenant, 'acreditacion', v_prov, v_store), v_net, 'Neto acreditado'),
    acc_line(acc_account_for(p_tenant, 'comision_procesador', v_prov, v_store), v_fee, 'Comisión'),
    acc_line(acc_account_for(p_tenant, 'impuestos_procesador', v_prov, v_store), v_tax, 'Impuestos y retenciones'),
    acc_line(acc_account_for(p_tenant, 'diferencia_procesador', v_prov, v_store), v_diff, 'Diferencia'),
    acc_line(acc_account_for(p_tenant, 'cobro', acc_payment_qualifier(p_tenant, p.method, p.reference, p.card_voucher), v_store),
             -v_eff, 'Cobro liquidado'));
  perform acc_post(p_tenant, v_date, 'settlement_line', sl.id, 'release',
                   'Acreditación ' || sl.provider_key || coalesce(' · venta #' || s.number, ''), v_store, v_lines);
end;
$$;

-- Contracargo perdido o devolución hecha desde el procesador.
create or replace function acc_sync_payment_dispute(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d payment_disputes%rowtype;
  cfg acc_settings%rowtype;
  p payments%rowtype;
  v_store uuid;
  v_prov text;
  v_cr uuid;
  v_lost boolean;
  v_date date;
  v_desc text;
begin
  select * into d from payment_disputes where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_lost := d.deleted_at is null and d.origin = 'provider' and d.status in ('lost', 'refunded') and coalesce(d.amount, 0) > 0;
  v_date := acc_ar_date(coalesce(d.resolved_at, d.last_seen_at, d.occurred_at));
  v_desc := case d.kind when 'chargeback' then 'Contracargo' when 'claim' then 'Reclamo perdido' else 'Devolución desde el procesador' end
            || ' · ' || d.provider_key || ' pago ' || d.provider_payment_id;

  if v_lost and v_date >= cfg.start_date and acc_entry_of(p_tenant, 'payment_dispute', d.id, 'loss') is null then
    v_prov := regexp_replace(lower(d.provider_key), '_point$', '');
    if d.payment_id is not null then
      select * into p from payments where id = d.payment_id and tenant_id = p_tenant;
    end if;
    select store_id into v_store from sales where id = coalesce(d.sale_id, p.sale_id);
    v_store := coalesce(d.scope_store_id, v_store);
    if p.id is not null then
      v_cr := acc_account_for(p_tenant, 'cobro', acc_payment_qualifier(p_tenant, p.method, p.reference, p.card_voucher), v_store);
    else
      v_cr := acc_account_for(p_tenant, 'acreditacion', v_prov, v_store);
    end if;
    perform acc_post(p_tenant, v_date, 'payment_dispute', d.id, 'loss', v_desc, v_store,
                     jsonb_build_array(acc_line(acc_account_for(p_tenant, 'contracargos', v_prov, v_store), d.amount),
                                       acc_line(v_cr, -d.amount)));
  elsif not v_lost then
    perform acc_post_reversal(p_tenant, 'payment_dispute', d.id, 'loss', 'loss_reversal',
                              acc_ar_date(now()), 'Reversión: ' || v_desc);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Despachador
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
    else raise exception 'acc_source_unknown: %', p_type;
  end case;
end;
$$;

-- Nunca falla: el error queda en acc_issues (y se marca resuelto al andar).
create or replace function acc_sync_safe(p_tenant uuid, p_type text, p_id uuid, p_refresh boolean default false)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_msg text;
begin
  begin
    perform acc_sync(p_tenant, p_type, p_id, p_refresh);
  exception when others then
    v_msg := left(sqlerrm, 500);
    insert into acc_issues (tenant_id, source_type, source_id, message, event_date)
    values (p_tenant, p_type, p_id, v_msg, current_date)
    on conflict (tenant_id, source_type, source_id) do update
       set message = excluded.message, attempts = acc_issues.attempts + 1, updated_at = now(),
           resolved_at = null, dismissed_at = null, dismissed_by = null;
    return false;
  end;
  update acc_issues set resolved_at = now(), updated_at = now()
   where tenant_id = p_tenant and source_type = p_type and source_id = p_id and resolved_at is null;
  return true;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'acc_sync_sale(uuid, uuid)', 'acc_sync_sale_return(uuid, uuid)', 'acc_sync_cc_movement(uuid, uuid, boolean)',
    'acc_sync_cash_shift(uuid, uuid)', 'acc_sync_cash_movement(uuid, uuid)',
    'acc_sync_supplier_invoice(uuid, uuid, boolean)', 'acc_sync_supplier_payment(uuid, uuid)',
    'acc_sync_treasury_movement(uuid, uuid)', 'acc_sync_settlement_line(uuid, uuid)',
    'acc_sync_payment_dispute(uuid, uuid)', 'acc_sync(uuid, text, uuid, boolean)',
    'acc_sync_safe(uuid, text, uuid, boolean)', 'acc_shift_store(uuid)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- D) Triggers (al commit; nunca frenan la operación)
-- -----------------------------------------------------------------------------
create or replace function acc_source_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Negocios sin contabilidad: una búsqueda por clave primaria y nada más.
  if not acc_tenant_active(new.tenant_id) then
    return null;
  end if;
  begin
    perform acc_sync_safe(new.tenant_id, tg_argv[0], new.id, coalesce(tg_argv[1], '') = 'refresh');
  exception when others then
    null;
  end;
  return null;
end;
$$;
revoke all on function acc_source_trg() from public, anon, authenticated;

-- Ventas
drop trigger if exists acc_sales_ins on sales;
create constraint trigger acc_sales_ins after insert on sales
  deferrable initially deferred for each row
  when (new.status <> 'suspended')
  execute function acc_source_trg('sale');
drop trigger if exists acc_sales_upd on sales;
create constraint trigger acc_sales_upd after update on sales
  deferrable initially deferred for each row
  when (old.status is distinct from new.status)
  execute function acc_source_trg('sale');

-- Devoluciones
drop trigger if exists acc_sale_returns_ins on sale_returns;
create constraint trigger acc_sale_returns_ins after insert on sale_returns
  deferrable initially deferred for each row
  execute function acc_source_trg('sale_return');

-- Cuenta corriente
drop trigger if exists acc_cam_ins on customer_account_movements;
create constraint trigger acc_cam_ins after insert on customer_account_movements
  deferrable initially deferred for each row
  when (new.kind in ('payment', 'interest', 'interest_waiver', 'adjust_debit', 'adjust_credit')
        or (new.kind = 'charge' and new.sale_id is null))
  execute function acc_source_trg('cc_movement');
drop trigger if exists acc_cam_void on customer_account_movements;
create constraint trigger acc_cam_void after update on customer_account_movements
  deferrable initially deferred for each row
  when (old.voided_at is distinct from new.voided_at)
  execute function acc_source_trg('cc_movement');
drop trigger if exists acc_cam_amount on customer_account_movements;
create constraint trigger acc_cam_amount after update on customer_account_movements
  deferrable initially deferred for each row
  when (old.delta is distinct from new.delta and new.voided_at is null)
  execute function acc_source_trg('cc_movement', 'refresh');

-- Caja
drop trigger if exists acc_cash_shifts_close on cash_shifts;
create constraint trigger acc_cash_shifts_close after update on cash_shifts
  deferrable initially deferred for each row
  when (new.status = 'closed' and old.status is distinct from new.status)
  execute function acc_source_trg('cash_shift');
drop trigger if exists acc_cash_movements_ins on cash_movements;
create constraint trigger acc_cash_movements_ins after insert on cash_movements
  deferrable initially deferred for each row
  when (new.type in ('income', 'expense') and new.reference_id is null)
  execute function acc_source_trg('cash_movement');

-- Compras y pagos
drop trigger if exists acc_supplier_invoices_ins on supplier_invoices;
create constraint trigger acc_supplier_invoices_ins after insert on supplier_invoices
  deferrable initially deferred for each row
  execute function acc_source_trg('supplier_invoice');
drop trigger if exists acc_supplier_invoices_status on supplier_invoices;
create constraint trigger acc_supplier_invoices_status after update on supplier_invoices
  deferrable initially deferred for each row
  when (old.status is distinct from new.status)
  execute function acc_source_trg('supplier_invoice');
drop trigger if exists acc_supplier_invoices_edit on supplier_invoices;
create constraint trigger acc_supplier_invoices_edit after update on supplier_invoices
  deferrable initially deferred for each row
  when (new.status = 'posted' and old.status = 'posted'
        and (old.total, old.vat_lines, old.other_taxes, old.issue_date, old.kind, old.fx_rate, old.supplier_id,
             old.letter, old.point_of_sale, old.number)
            is distinct from
            (new.total, new.vat_lines, new.other_taxes, new.issue_date, new.kind, new.fx_rate, new.supplier_id,
             new.letter, new.point_of_sale, new.number))
  execute function acc_source_trg('supplier_invoice', 'refresh');
drop trigger if exists acc_supplier_payments_ins on supplier_payments;
create constraint trigger acc_supplier_payments_ins after insert on supplier_payments
  deferrable initially deferred for each row
  execute function acc_source_trg('supplier_payment');
drop trigger if exists acc_supplier_payments_status on supplier_payments;
create constraint trigger acc_supplier_payments_status after update on supplier_payments
  deferrable initially deferred for each row
  when (old.status is distinct from new.status)
  execute function acc_source_trg('supplier_payment');

-- Tesorería
drop trigger if exists acc_treasury_movements_ins on treasury_movements;
create constraint trigger acc_treasury_movements_ins after insert on treasury_movements
  deferrable initially deferred for each row
  when (new.type not in ('supplier_payment', 'supplier_payment_void', 'transfer_in'))
  execute function acc_source_trg('treasury_movement');
drop trigger if exists acc_treasury_movements_void on treasury_movements;
create constraint trigger acc_treasury_movements_void after update on treasury_movements
  deferrable initially deferred for each row
  when (old.voided_at is distinct from new.voided_at
        and new.type not in ('supplier_payment', 'supplier_payment_void', 'transfer_in'))
  execute function acc_source_trg('treasury_movement');

-- Procesadores y contracargos
drop trigger if exists acc_settlement_lines_ins on settlement_lines;
create constraint trigger acc_settlement_lines_ins after insert on settlement_lines
  deferrable initially deferred for each row
  when (new.released and new.payment_id is not null and new.kind = 'payment')
  execute function acc_source_trg('settlement_line');
drop trigger if exists acc_settlement_lines_upd on settlement_lines;
create constraint trigger acc_settlement_lines_upd after update on settlement_lines
  deferrable initially deferred for each row
  when (new.released and new.payment_id is not null and new.kind = 'payment'
        and (old.released is distinct from new.released or old.payment_id is distinct from new.payment_id))
  execute function acc_source_trg('settlement_line');
drop trigger if exists acc_payment_disputes_ins on payment_disputes;
create constraint trigger acc_payment_disputes_ins after insert on payment_disputes
  deferrable initially deferred for each row
  when (new.origin = 'provider' and new.status in ('lost', 'refunded'))
  execute function acc_source_trg('payment_dispute');
drop trigger if exists acc_payment_disputes_upd on payment_disputes;
create constraint trigger acc_payment_disputes_upd after update on payment_disputes
  deferrable initially deferred for each row
  when (old.status is distinct from new.status and new.origin = 'provider')
  execute function acc_source_trg('payment_dispute');

-- -----------------------------------------------------------------------------
-- E) RPC
-- -----------------------------------------------------------------------------

-- Genera lo que falte de un rango (idempotente). Con p_regenerate da de baja
-- (lógica) los asientos automáticos del rango en períodos abiertos y los
-- vuelve a armar con los mapeos de hoy.
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

-- Asiento manual (o de apertura).
--   p: {date, description, store_id?, kind?: manual|opening,
--       lines: [{account_id, cost_center_id?, debit, credit, description?}]}
create or replace function acc_entry_manual_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_date date := (p ->> 'date')::date;
  v_desc text := btrim(coalesce(p ->> 'description', ''));
  v_kind text := coalesce(nullif(p ->> 'kind', ''), 'manual');
  v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_lines jsonb := '[]'::jsonb;
  l jsonb;
  v_d numeric;
  v_c numeric;
  v_id uuid;
begin
  if not exists (select 1 from acc_settings where tenant_id = v_tenant) then
    raise exception 'acc_not_setup';
  end if;
  if v_date is null or v_desc = '' then
    raise exception 'acc_entry_required';
  end if;
  if v_kind not in ('manual', 'opening') then
    raise exception 'acc_entry_kind_invalid';
  end if;
  if v_store is not null and not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_d := round(coalesce((l ->> 'debit')::numeric, 0), 2);
    v_c := round(coalesce((l ->> 'credit')::numeric, 0), 2);
    if v_d < 0 or v_c < 0 or (v_d > 0 and v_c > 0) then
      raise exception 'acc_line_invalid';
    end if;
    continue when v_d = 0 and v_c = 0;
    if not exists (select 1 from acc_accounts
                    where id = (l ->> 'account_id')::uuid and tenant_id = v_tenant
                      and imputable and is_active and deleted_at is null) then
      raise exception 'acc_account_not_imputable';
    end if;
    if nullif(l ->> 'cost_center_id', '') is not null
       and not exists (select 1 from acc_cost_centers where id = (l ->> 'cost_center_id')::uuid and tenant_id = v_tenant) then
      raise exception 'acc_cost_center_invalid';
    end if;
    v_lines := v_lines || acc_line((l ->> 'account_id')::uuid, v_d - v_c, l ->> 'description',
                                   nullif(l ->> 'cost_center_id', '')::uuid);
  end loop;
  v_id := acc_post(v_tenant, v_date, null, null, null, v_desc, v_store, v_lines, v_kind);
  if v_id is null then
    raise exception 'acc_entry_empty';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'acc_entries', v_id, 'acc_entry_manual_created', p);
  return v_id;
end;
$$;
revoke all on function acc_entry_manual_save(jsonb) from public, anon;
grant execute on function acc_entry_manual_save(jsonb) to authenticated;

-- Contra-asiento de un asiento manual o de apertura (los automáticos se
-- corrigen desde el documento o regenerando el período).
create or replace function acc_entry_reverse(p_id uuid, p_reason text, p_date date default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  e acc_entries%rowtype;
  v_rev uuid;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'reason_required';
  end if;
  select * into e from acc_entries where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'acc_entry_not_found';
  end if;
  if e.kind not in ('manual', 'opening') then
    raise exception 'acc_entry_auto_reverse';
  end if;
  if e.reversed_by is not null then
    raise exception 'acc_entry_already_reversed';
  end if;
  v_rev := acc_post(v_tenant, coalesce(p_date, current_date), 'acc_entry', e.id, 'reverse',
                    'Reversión del asiento N° ' || e.number || ': ' || btrim(p_reason), e.store_id,
                    acc_reverse_lines(e.id), 'reversal', e.id);
  update acc_entries set reversed_by = v_rev where id = e.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'acc_entries', e.id, 'acc_entry_reversed', p_reason,
          jsonb_build_object('reversal_id', v_rev));
  return v_rev;
end;
$$;
revoke all on function acc_entry_reverse(uuid, text, date) from public, anon;
grant execute on function acc_entry_reverse(uuid, text, date) to authenticated;

-- Cierre mensual: numera el Diario (correlativo por ejercicio) y bloquea el
-- período. Exige que los anteriores con asientos estén cerrados.
create or replace function acc_period_close(p_period date, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  cfg acc_settings%rowtype;
  v_p date := (date_trunc('month', p_period::timestamp))::date;
  v_fy date;
  v_base bigint;
  v_count int;
  v_total numeric;
  v_issues int;
begin
  select * into cfg from acc_settings where tenant_id = v_tenant;
  if not found then
    raise exception 'acc_not_setup';
  end if;
  if v_p >= (date_trunc('month', current_date::timestamp))::date then
    raise exception 'acc_period_not_ended';
  end if;
  if acc_period_is_closed(v_tenant, v_p) then
    raise exception 'acc_period_already_closed';
  end if;
  if exists (select 1 from acc_entries e
              where e.tenant_id = v_tenant and e.deleted_at is null and e.period < v_p
                and not acc_period_is_closed(v_tenant, e.period)) then
    raise exception 'acc_previous_period_open';
  end if;

  v_fy := make_date(case when extract(month from v_p) >= cfg.fiscal_year_start_month
                         then extract(year from v_p)::int else extract(year from v_p)::int - 1 end,
                    cfg.fiscal_year_start_month, 1);
  select coalesce(max(official_number), 0) into v_base
    from acc_entries
   where tenant_id = v_tenant and deleted_at is null and period >= v_fy and period < v_p;

  with numbered as (
    select id, row_number() over (order by entry_date, number) + v_base as n
      from acc_entries
     where tenant_id = v_tenant and period = v_p and deleted_at is null
  )
  update acc_entries e set official_number = numbered.n
    from numbered where e.id = numbered.id;

  select count(*), coalesce(sum(total), 0) into v_count, v_total
    from acc_entries where tenant_id = v_tenant and period = v_p and deleted_at is null;
  select count(*) into v_issues
    from acc_issues where tenant_id = v_tenant and resolved_at is null and dismissed_at is null;

  insert into acc_periods (tenant_id, period, status, closed_at, closed_by, notes)
  values (v_tenant, v_p, 'closed', now(), auth.uid(), nullif(btrim(coalesce(p_notes, '')), ''))
  on conflict (tenant_id, period) do update
     set status = 'closed', closed_at = now(), closed_by = auth.uid(),
         notes = coalesce(excluded.notes, acc_periods.notes), updated_at = now();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'acc_periods', null, 'acc_period_closed',
          jsonb_build_object('period', v_p, 'entries', v_count, 'total', v_total, 'open_issues', v_issues));
  return jsonb_build_object('entries', v_count, 'total', v_total, 'open_issues', v_issues);
end;
$$;
revoke all on function acc_period_close(date, text) from public, anon;
grant execute on function acc_period_close(date, text) to authenticated;

-- Reapertura: sólo el dueño, con motivo, y sólo el último período cerrado.
create or replace function acc_period_reopen(p_period date, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_p date := (date_trunc('month', p_period::timestamp))::date;
begin
  if coalesce(stock_my_role(), '') <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'reason_required';
  end if;
  if not acc_period_is_closed(v_tenant, v_p) then
    raise exception 'acc_period_not_closed';
  end if;
  if exists (select 1 from acc_periods where tenant_id = v_tenant and period > v_p and status = 'closed') then
    raise exception 'acc_later_period_closed';
  end if;
  update acc_periods
     set status = 'open', reopened_at = now(), reopened_by = auth.uid(),
         reopen_reason = btrim(p_reason), updated_at = now()
   where tenant_id = v_tenant and period = v_p;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'acc_periods', null, 'acc_period_reopened', p_reason,
          jsonb_build_object('period', v_p));
end;
$$;
revoke all on function acc_period_reopen(date, text) from public, anon;
grant execute on function acc_period_reopen(date, text) to authenticated;

-- Problemas: reintentar o descartar.
create or replace function acc_issue_retry(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  i acc_issues%rowtype;
begin
  select * into i from acc_issues where id = p_id and tenant_id = v_tenant;
  if not found then
    raise exception 'acc_issue_not_found';
  end if;
  return acc_sync_safe(v_tenant, i.source_type, i.source_id);
end;
$$;
revoke all on function acc_issue_retry(uuid) from public, anon;
grant execute on function acc_issue_retry(uuid) to authenticated;

create or replace function acc_issue_dismiss(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
begin
  update acc_issues set dismissed_at = now(), dismissed_by = auth.uid(), updated_at = now()
   where id = p_id and tenant_id = v_tenant;
  if not found then
    raise exception 'acc_issue_not_found';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action)
  values (v_tenant, auth.uid(), 'acc_issues', p_id, 'acc_issue_dismissed');
end;
$$;
revoke all on function acc_issue_dismiss(uuid) from public, anon;
grant execute on function acc_issue_dismiss(uuid) to authenticated;
