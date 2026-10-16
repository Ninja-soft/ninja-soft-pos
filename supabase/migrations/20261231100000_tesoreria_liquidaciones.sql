-- =============================================================================
-- 20261231100000_tesoreria_liquidaciones  (F23 · H151 y deudas de ADR-158, ADR-162)
--
-- Liquidaciones a la billetera o al banco, retiros del cajón con destino y un
-- asiento por estado (no por existencia):
--
--   A) Destino de las acreditaciones: una billetera (provider_key) o un banco
--      con treasury_accounts.settlement_providers ("acá te depositan Payway").
--      treasury_settlement_dest() resuelve la cuenta por procesador y sucursal.
--   B) Movimientos con origen nuevos (no contabilizan por su cuenta, el asiento
--      es del documento): settlement_credit / settlement_credit_void (neto de
--      una línea conciliada), processor_debit / processor_debit_void
--      (contracargo o reclamo perdido después de acreditar), cash_drop /
--      cash_fund (retiro del cajón a una cuenta o fondo desde una cuenta),
--      cc_collection / cc_collection_void (cobro de cuenta corriente por
--      transferencia).
--   C) Asiento por estado: acc_post_state() deja UN asiento vigente por
--      documento; si el estado cambia (se desvincula, se ignora, cambia lo
--      devuelto, el contracargo va y vuelve) arma el contra-asiento y, si
--      corresponde, la versión nueva (T15, T16).
--   D) Liquidación: sólo las líneas conciliadas (matched) contabilizan y mueven
--      plata; "Aceptar la diferencia" (settlement_line_resolve 'accept_diff')
--      concilia una línea con diferencia de monto y la diferencia va a
--      "Diferencias de redondeo y conciliación". IVA de la comisión separado
--      (crédito fiscal si el negocio discrimina IVA, gasto 5.2.05 si no) y
--      fuera de las retenciones sufridas.
--   E) Contracargos por cambio de estado (perdido, ganado, perdido otra vez,
--      baja lógica) con su movimiento en la billetera si ya se había acreditado.
--   F) Retiros del cajón con destino (cash_movements.treasury_account_id):
--      el asiento va a la cuenta de destino, no a Fondos en tránsito.
--   G) Deudas de ADR-158: cobro de cuenta corriente por transferencia a su
--      cuenta (account_collect con p_transfer_account), fecha de Argentina en
--      el alta de pagos y órdenes de pago sin fecha.
--   H) Fuente de los asientos de liquidación por fecha
--      (acc_settlement_source_at); la elección es de 20261231100200 (H153).
--
-- Redefinidas a partir de su definición VIVA en producción (2026-10-15, con
-- ADR-158 aplicado): trg_treasury_accounts_normalize, treasury_movement_has_own_entry,
-- settlement_line_resolve, acc_template_extend, acc_sync_settlement_line,
-- acc_sync_payment_dispute, acc_sync_cash_movement, acc_sync_cc_movement,
-- acc_sync_tax_suffered, _tax_suffered_from_settlement, acc_entry_lookup,
-- treasury_account_link_transfer, treasury_position, account_collect (firma
-- nueva con un parámetro opcional al final), supplier_payment_create,
-- supplier_payment_order_create. NO toca create_sale ni ml_ingest_pack.
--
-- Seguridad: tenant_id + RLS con (select current_tenant_id()) y
-- (select internal_scope()); escrituras por RPC SECURITY DEFINER o triggers;
-- audit_logs. Sin datos que migrar: en producción no hay cuentas ni
-- movimientos de Tesorería ni asientos (auditoría ADR-150).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Destino de las acreditaciones.
-- -----------------------------------------------------------------------------
create or replace function treasury_provider_norm(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case x
           when 'prisma' then 'payway'
           when 'posnet' then 'fiserv'
           when 'clover' then 'fiserv'
           when 'uala' then 'ualabis'
           else x end
    from (select nullif(regexp_replace(regexp_replace(lower(btrim(coalesce(p, ''))), '_point$', ''),
                                       '[^a-z0-9_]', '_', 'g'), '') as x) t;
$$;

create or replace function treasury_provider_keys_ok(p text[])
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(bool_and(x ~ '^[a-z0-9_]{2,40}$'), true) and coalesce(array_length(p, 1), 0) <= 20
    from unnest(coalesce(p, '{}'::text[])) x;
$$;

alter table treasury_accounts add column if not exists settlement_providers text[] not null default '{}';
alter table treasury_accounts drop constraint if exists treasury_accounts_settlement_providers_check;
alter table treasury_accounts add constraint treasury_accounts_settlement_providers_check
  check (treasury_provider_keys_ok(settlement_providers));
comment on column treasury_accounts.settlement_providers is
  'ADR-162 (H151): procesadores que acreditan en este banco o billetera (además del provider_key de la billetera). Lo usa treasury_settlement_dest.';

-- Normalización (definición viva de ADR-158 + procesadores que acreditan acá).
create or replace function trg_treasury_accounts_normalize()
returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  new.cbu := nullif(regexp_replace(coalesce(new.cbu, ''), '\D', '', 'g'), '');
  new.alias := nullif(trim(coalesce(new.alias, '')), '');
  new.currency := upper(coalesce(new.currency, 'ARS'));
  new.provider_key := nullif(lower(trim(coalesce(new.provider_key, ''))), '');
  if new.kind in ('cash', 'pos_cash', 'receivable') then
    new.bank_name := null;
    new.cbu := null;
    new.alias := null;
    new.account_number := null;
  elsif new.kind = 'wallet' then
    new.bank_name := null;
    new.account_number := null;
  end if;
  if new.kind not in ('wallet', 'receivable') then
    new.provider_key := null;
  end if;
  if new.kind in ('bank', 'wallet') then
    new.settlement_providers := coalesce((
      select array_agg(distinct x order by x)
        from unnest(coalesce(new.settlement_providers, '{}'::text[])) u(v),
             lateral (select treasury_provider_norm(u.v) as x) n
       where x is not null and x is distinct from new.provider_key), '{}'::text[]);
  else
    new.settlement_providers := '{}'::text[];
  end if;
  return new;
end;
$$;

-- Cuenta de Tesorería donde acredita un procesador (billetera del procesador
-- o banco que lo tiene en settlement_providers), en pesos, abierta a esa fecha
-- y con la feature tesoreria. Primero la de la sucursal, después la del negocio.
create or replace function treasury_settlement_dest(p_tenant uuid, p_provider text, p_store uuid, p_date date)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ta.id
    from treasury_accounts ta
   where ta.tenant_id = p_tenant
     and ta.deleted_at is null
     and ta.is_active
     and ta.kind in ('wallet', 'bank')
     and ta.currency = 'ARS'
     and ((ta.kind = 'wallet' and ta.provider_key = treasury_provider_norm(p_provider))
          or treasury_provider_norm(p_provider) = any (ta.settlement_providers))
     and (ta.store_id is null or p_store is null or ta.store_id = p_store)
     and (p_date is null or ta.opening_date <= p_date)
     and tenant_has_feature_for(p_tenant, 'tesoreria')
   order by (ta.store_id is not distinct from p_store) desc, (ta.kind = 'wallet') desc, ta.created_at
   limit 1;
$$;
revoke all on function treasury_settlement_dest(uuid, text, uuid, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Movimientos con origen nuevos.
-- -----------------------------------------------------------------------------
alter table treasury_movements drop constraint if exists treasury_movements_type_check;
alter table treasury_movements add constraint treasury_movements_type_check
  check (type in ('deposit', 'withdrawal', 'transfer_in', 'transfer_out',
                  'supplier_payment', 'supplier_payment_void',
                  'cheque_deposit', 'cheque_debit', 'cheque_rejected',
                  'adjustment', 'other',
                  'sale_collection', 'sale_collection_void',
                  'settlement_credit', 'settlement_credit_void',
                  'processor_debit', 'processor_debit_void',
                  'cash_drop', 'cash_fund',
                  'cc_collection', 'cc_collection_void'));

drop index if exists treasury_movements_origin_uidx;
create unique index if not exists treasury_movements_origin_uidx
  on treasury_movements(reference_id, type)
  where type in ('sale_collection', 'sale_collection_void', 'cash_drop', 'cash_fund',
                 'cc_collection', 'cc_collection_void');
create index if not exists treasury_movements_reference_idx
  on treasury_movements(reference_id, type) where reference_id is not null;
create index if not exists treasury_movements_counterpart_idx
  on treasury_movements(counterpart_id) where counterpart_id is not null;

create or replace function treasury_movement_has_own_entry(p_type text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_type not in ('supplier_payment', 'supplier_payment_void', 'transfer_in',
                        'sale_collection', 'sale_collection_void',
                        'settlement_credit', 'settlement_credit_void',
                        'processor_debit', 'processor_debit_void',
                        'cash_drop', 'cash_fund',
                        'cc_collection', 'cc_collection_void');
$$;

drop trigger if exists acc_treasury_movements_ins on treasury_movements;
create constraint trigger acc_treasury_movements_ins
  after insert on treasury_movements
  deferrable initially deferred
  for each row when (treasury_movement_has_own_entry(new.type))
  execute function acc_source_trg('treasury_movement');

drop trigger if exists acc_treasury_movements_void on treasury_movements;
create constraint trigger acc_treasury_movements_void
  after update on treasury_movements
  deferrable initially deferred
  for each row when (old.voided_at is distinct from new.voided_at and treasury_movement_has_own_entry(new.type))
  execute function acc_source_trg('treasury_movement');

-- Movimiento vigente de un documento (el último de ese tipo sin contra-movimiento).
create or replace function _treasury_current_move(p_tenant uuid, p_reference uuid, p_type text)
returns treasury_movements
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.*
    from treasury_movements m
   where m.tenant_id = p_tenant and m.reference_id = p_reference and m.type = p_type and m.voided_at is null
     and not exists (select 1 from treasury_movements v
                      where v.counterpart_id = m.id and v.type = p_type || '_void' and v.voided_at is null)
   order by m.created_at desc
   limit 1;
$$;
revoke all on function _treasury_current_move(uuid, uuid, text) from public, anon, authenticated;

-- Deja el movimiento de un documento en el estado pedido: si el vigente no
-- coincide (cuenta o importe) lo compensa con un contra-movimiento '<tipo>_void'
-- y, si corresponde, suma el nuevo. Devuelve cuántos movimientos creó.
create or replace function _treasury_move_state(p_tenant uuid, p_type text, p_ref_type text, p_ref uuid,
                                                p_active boolean, p_account uuid, p_amount numeric, p_date date,
                                                p_description text, p_sale uuid default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cur  treasury_movements;
  v_n  int := 0;
  v_amt numeric := round(coalesce(p_amount, 0), 2);
begin
  perform pg_advisory_xact_lock(hashtext('treasury_state:' || p_type || ':' || p_ref::text));
  cur := _treasury_current_move(p_tenant, p_ref, p_type);
  if cur.id is not null and p_active and cur.account_id = p_account and cur.amount = v_amt then
    return 0;
  end if;
  if cur.id is not null then
    insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                    reference_type, reference_id, sale_id, counterpart_id, created_by)
    values (p_tenant, cur.account_id, greatest(acc_ar_date(now()), cur.movement_date), -cur.amount, p_type || '_void',
            left('Se deshizo: ' || coalesce(cur.description, p_description, ''), 300),
            p_ref_type, p_ref, cur.sale_id, cur.id, auth.uid());
    v_n := v_n + 1;
  end if;
  if p_active and v_amt <> 0 and p_account is not null then
    insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                    reference_type, reference_id, sale_id, created_by)
    values (p_tenant, p_account, coalesce(p_date, acc_ar_date(now())), v_amt, p_type, left(p_description, 300),
            p_ref_type, p_ref, p_sale, auth.uid());
    v_n := v_n + 1;
  end if;
  return v_n;
end;
$$;
revoke all on function _treasury_move_state(uuid, text, text, uuid, boolean, uuid, numeric, date, text, uuid)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Asiento por estado.
-- -----------------------------------------------------------------------------
-- ¿El asiento tiene las mismas cuentas e importes que las líneas pedidas?
create or replace function acc_lines_equal(p_entry uuid, p_lines jsonb)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with a as (
    select account_id as acc, round(sum(debit - credit), 2) as v
      from acc_entry_lines where entry_id = p_entry group by account_id
  ), b as (
    select nullif(e ->> 'a', '')::uuid as acc, round(sum(coalesce((e ->> 'v')::numeric, 0)), 2) as v
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e group by 1
  )
  select not exists (
    (select acc, v from a where v <> 0 except select acc, v from b where v <> 0)
    union all
    (select acc, v from b where v <> 0 except select acc, v from a where v <> 0)
  );
$$;
revoke all on function acc_lines_equal(uuid, jsonb) from public, anon, authenticated;

-- Un asiento vigente por documento y evento. Versiones: '<evento>', '<evento>#2',
-- ...; la reversión de cada versión es '<versión>:rev' (reversal_of). Si el
-- vigente coincide no hace nada; si no, lo revierte (con la fecha de hoy o la
-- del asiento, la mayor) y arma la versión nueva cuando p_active.
create or replace function acc_post_state(p_tenant uuid, p_type text, p_id uuid, p_event text, p_active boolean,
                                          p_date date, p_description text, p_store uuid, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cur acc_entries%rowtype;
  v_n   int := 1;
  v_ev  text := p_event;
begin
  perform pg_advisory_xact_lock(hashtext('acc_state:' || p_type || ':' || p_id::text));
  select e.* into v_cur
    from acc_entries e
   where e.tenant_id = p_tenant and e.source_type = p_type and e.source_id = p_id and e.deleted_at is null
     and e.reversal_of is null
     and (e.source_event = p_event or e.source_event like p_event || '#%')
     and not exists (select 1 from acc_entries r
                      where r.tenant_id = p_tenant and r.reversal_of = e.id and r.deleted_at is null)
   order by e.created_at desc, e.number desc
   limit 1;
  if v_cur.id is not null then
    if p_active and acc_lines_equal(v_cur.id, p_lines) then
      return v_cur.id;
    end if;
    perform acc_post(p_tenant, greatest(acc_ar_date(now()), v_cur.entry_date), p_type, p_id,
                     v_cur.source_event || ':rev', 'Reversión: ' || v_cur.description, v_cur.store_id,
                     acc_reverse_lines(v_cur.id), 'auto', v_cur.id);
  end if;
  if not coalesce(p_active, false) then
    return null;
  end if;
  while acc_entry_of(p_tenant, p_type, p_id, v_ev) is not null loop
    v_n := v_n + 1;
    v_ev := p_event || '#' || v_n;
  end loop;
  return acc_post(p_tenant, p_date, p_type, p_id, v_ev, p_description, p_store, p_lines);
end;
$$;
revoke all on function acc_post_state(uuid, text, uuid, text, boolean, date, text, uuid, jsonb)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Liquidaciones: IVA de la comisión, aceptar diferencia, asiento y
--    movimiento sólo para líneas conciliadas.
-- -----------------------------------------------------------------------------
alter table settlement_lines add column if not exists diff_accepted_at timestamptz;
alter table settlement_lines add column if not exists diff_accepted_by uuid;
comment on column settlement_lines.diff_accepted_at is
  'ADR-162 (H151): la diferencia de monto se aceptó y la línea cuenta como conciliada; la diferencia va a "Diferencias de redondeo y conciliación".';

-- ¿Este renglón del detalle de cargos es el IVA de la comisión? (código
-- 'iva_comision' del archivo, o un impuesto que dice IVA y no es percepción ni
-- retención).
create or replace function settlement_fee_item_is_vat(e jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(e ->> 'code', '') = 'iva_comision'
      or (coalesce(e ->> 'kind', '') = 'tax'
          and lower(coalesce(e ->> 'code', '') || ' ' || coalesce(e ->> 'label', '')) ~ '(^|[^a-z])iva'
          and lower(coalesce(e ->> 'code', '') || ' ' || coalesce(e ->> 'label', '')) !~ '(percep|retenc|reten|withholding)');
$$;

create or replace function settlement_fee_vat(p_detail jsonb)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select round(coalesce(sum(abs(coalesce((e ->> 'amount')::numeric, 0))), 0), 2)
    from jsonb_array_elements(case when jsonb_typeof(p_detail) = 'array' then p_detail else '[]'::jsonb end) e
   where settlement_fee_item_is_vat(e);
$$;

-- _tax_suffered_from_settlement: definición viva; el IVA de la comisión no es
-- un impuesto sufrido (es crédito fiscal de la factura del procesador).
create or replace function _tax_suffered_from_settlement(p_line uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sl settlement_lines%rowtype;
  v_home text;
  v_store uuid;
  v_c jsonb;
  v_n int := 0;
  v_date date;
  v_amt numeric;
  f record;
begin
  select * into sl from settlement_lines where id = p_line;
  if not found or sl.kind <> 'payment' or coalesce(sl.taxes, 0) = 0 then
    return 0;
  end if;
  v_home := _tax_settings_eff(sl.tenant_id) ->> 'iibb_jurisdiction';
  select s.store_id into v_store from sales s where s.id = sl.sale_id;
  v_store := coalesce(sl.scope_store_id, v_store);
  v_date := (sl.operation_at at time zone 'America/Argentina/Buenos_Aires')::date;

  if jsonb_typeof(sl.fee_detail) = 'array' and exists (
       select 1 from jsonb_array_elements(sl.fee_detail) e where e ->> 'kind' = 'tax') then
    for f in
      select e, o from jsonb_array_elements(sl.fee_detail) with ordinality as x(e, o)
       where e ->> 'kind' = 'tax'
    loop
      continue when settlement_fee_item_is_vat(f.e);
      v_amt := round(abs(coalesce((f.e ->> 'amount')::numeric, 0)), 2);
      continue when v_amt <= 0;
      v_c := _tax_suffered_classify_for(sl.tenant_id, concat_ws(' ', f.e ->> 'code', f.e ->> 'label'), v_home,
                                        'procesador', v_date);
      continue when (v_c ->> 'skip')::boolean;
      insert into tax_suffered_entries (tenant_id, store_id, tax, kind, regime, jurisdiction, origin, operation_date,
                                        period, amount, settlement_line_id, source_key, needs_review, notes)
      values (sl.tenant_id, v_store, v_c ->> 'tax', v_c ->> 'kind', v_c ->> 'regime', v_c ->> 'jurisdiction',
              'procesador', v_date, date_trunc('month', v_date)::date, v_amt, sl.id,
              'sl:' || sl.id::text || ':' || f.o::text, (v_c ->> 'needs_review')::boolean,
              left(sl.provider_key || ' · ' || coalesce(f.e ->> 'label', 'Impuesto'), 300))
      on conflict (tenant_id, source_key) where source_key is not null do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  elsif round(abs(sl.taxes), 2) - settlement_fee_vat(sl.fee_detail) > 0 then
    -- Sin detalle: el total de impuestos, para revisar.
    insert into tax_suffered_entries (tenant_id, store_id, tax, kind, regime, jurisdiction, origin, operation_date,
                                      period, amount, settlement_line_id, source_key, needs_review, notes)
    values (sl.tenant_id, v_store, 'otro', 'retencion', 'procesador', null, 'procesador', v_date,
            date_trunc('month', v_date)::date, round(abs(sl.taxes), 2) - settlement_fee_vat(sl.fee_detail), sl.id,
            'sl:' || sl.id::text || ':0', true,
            left(sl.provider_key || ' · Impuestos sin detalle', 300))
    on conflict (tenant_id, source_key) where source_key is not null do nothing;
    if found then v_n := v_n + 1; end if;
  end if;
  return v_n;
exception when others then
  -- Nunca frena la importación de la liquidación (p. ej. mes de IIBB ya
  -- liquidado): queda para la RPC de sincronización.
  return 0;
end;
$$;

-- settlement_line_resolve: definición viva + 'accept_diff' (aceptar la
-- diferencia de monto con motivo) y cualquier otro cambio la desarma.
create or replace function settlement_line_resolve(p_line_id uuid, p_action text, p_payment_id uuid default null,
                                                   p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _settlement_assert();
  v_uid    uuid := auth.uid();
  v_line   settlement_lines%rowtype;
  v_pay    record;
  v_diff   numeric;
  v_status text;
  v_marked boolean := false;
  v_prev   boolean := false;
begin
  select * into v_line from settlement_lines
   where id = p_line_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'line_not_found' using errcode = '42501';
  end if;

  if p_action = 'ignore' then
    if v_line.payment_id is not null and v_line.reconciled_payment then
      perform _settlement_mark_payment(v_tenant, v_line.payment_id, false, v_uid, v_line.id, 'settlement_manual');
    end if;
    update settlement_lines
       set match_status = 'ignored', reviewed_at = now(), reviewed_by = v_uid, reconciled_payment = false,
           diff_accepted_at = null, diff_accepted_by = null,
           review_note = nullif(left(btrim(coalesce(p_note, '')), 300), '')
     where id = v_line.id;
  elsif p_action = 'unignore' then
    update settlement_lines
       set match_status = case when payment_id is null then 'missing_in_pos'
                               when abs(coalesce(diff_amount, 0)) > 0.01 then 'amount_diff'
                               else 'matched' end,
           match_method = case when match_method = 'manual' then match_method end,
           reviewed_at = null, reviewed_by = null, review_note = null
     where id = v_line.id;
  elsif p_action = 'accept_diff' then
    if v_line.payment_id is null or v_line.match_status <> 'amount_diff' then
      raise exception 'line_not_amount_diff';
    end if;
    if char_length(btrim(coalesce(p_note, ''))) < 3 then
      raise exception 'reason_required';
    end if;
    v_marked := _settlement_mark_payment(v_tenant, v_line.payment_id, true, v_uid, v_line.id, 'settlement_manual');
    update settlement_lines
       set match_status = 'matched', match_method = 'manual', reconciled_payment = v_marked or reconciled_payment,
           diff_accepted_at = now(), diff_accepted_by = v_uid,
           reviewed_at = now(), reviewed_by = v_uid, review_note = left(btrim(p_note), 300)
     where id = v_line.id;
  elsif p_action = 'link' then
    if p_payment_id is null then
      raise exception 'invalid_args';
    end if;
    select p.id, p.amount, p.sale_id, s.status as sale_status
      into v_pay
      from payments p
      join sales s on s.id = p.sale_id
     where p.id = p_payment_id and p.tenant_id = v_tenant;
    if not found then
      raise exception 'payment_not_found' using errcode = '42501';
    end if;
    if exists (select 1 from settlement_lines
                where tenant_id = v_tenant and payment_id = p_payment_id and id <> v_line.id
                  and match_status <> 'ignored') then
      raise exception 'payment_already_linked';
    end if;
    v_diff := round((v_line.gross - v_line.refunded)
                    - case when v_pay.sale_status = 'voided' then 0 else v_pay.amount end, 2);
    v_status := case when abs(v_diff) > 0.01 then 'amount_diff' else 'matched' end;
    -- Lo que esta línea había marcado en otro cobro (o en este, si ya no cierra) se desmarca.
    v_prev := v_line.reconciled_payment;
    if v_prev and v_line.payment_id is not null
       and (v_line.payment_id <> p_payment_id or v_status <> 'matched') then
      perform _settlement_mark_payment(v_tenant, v_line.payment_id, false, v_uid, v_line.id, 'settlement_manual');
      v_prev := false;
    end if;
    if v_status = 'matched' then
      v_marked := _settlement_mark_payment(v_tenant, p_payment_id, true, v_uid, v_line.id, 'settlement_manual');
    end if;
    update settlement_lines
       set payment_id = p_payment_id, sale_id = v_pay.sale_id, match_status = v_status,
           match_method = 'manual', diff_amount = v_diff, matched_at = now(),
           reconciled_payment = v_marked or (v_prev and v_status = 'matched'),
           diff_accepted_at = null, diff_accepted_by = null,
           reviewed_at = now(), reviewed_by = v_uid,
           review_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 300), ''), review_note)
     where id = v_line.id;
  elsif p_action = 'unlink' then
    if v_line.payment_id is not null and v_line.reconciled_payment then
      perform _settlement_mark_payment(v_tenant, v_line.payment_id, false, v_uid, v_line.id, 'settlement_manual');
    end if;
    update settlement_lines
       set payment_id = null, sale_id = null, match_status = 'missing_in_pos', match_method = null,
           diff_amount = round(gross - refunded, 2), matched_at = null, reconciled_payment = false,
           diff_accepted_at = null, diff_accepted_by = null,
           reviewed_at = now(), reviewed_by = v_uid
     where id = v_line.id;
  else
    raise exception 'invalid_action';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, v_uid, 'settlement_lines', v_line.id, 'settlement_line_' || p_action,
          jsonb_build_object('match_status', v_line.match_status, 'payment_id', v_line.payment_id,
                             'diff_amount', v_line.diff_amount),
          jsonb_build_object('payment_id', coalesce(p_payment_id, v_line.payment_id), 'note', left(p_note, 300),
                             'provider', v_line.provider_key, 'external_id', v_line.external_id,
                             'gross', v_line.gross));

  return (select to_jsonb(l) - 'raw' from settlement_lines l where l.id = v_line.id);
end;
$$;
revoke all on function settlement_line_resolve(uuid, text, uuid, text) from public, anon;
grant execute on function settlement_line_resolve(uuid, text, uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Fuente de los asientos de liquidación por fecha (la elección es H153).
-- -----------------------------------------------------------------------------
alter table acc_settings add column if not exists settlement_source_from date;
alter table acc_settings add column if not exists settlement_source_before text not null default 'ninjapos';
alter table acc_settings drop constraint if exists acc_settings_settlement_source_before_check;
alter table acc_settings add constraint acc_settings_settlement_source_before_check
  check (settlement_source_before in ('ninjapos', 'nubceo'));
comment on column acc_settings.settlement_source_from is
  'ADR-162 (H153): desde qué día (primero de un mes abierto) vale settlement_source; antes vale settlement_source_before.';

create or replace function acc_settlement_source_at(p_tenant uuid, p_date date)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case when s.settlement_source_from is null or p_date is null or p_date >= s.settlement_source_from
                then s.settlement_source else s.settlement_source_before end
      from acc_settings s where s.tenant_id = p_tenant), 'ninjapos');
$$;
revoke all on function acc_settlement_source_at(uuid, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Plantilla: IVA de las comisiones (5.2.05) y sus mapeos.
-- -----------------------------------------------------------------------------
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
      ('iva_comision', 'gasto',     'iva_comisiones')
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

-- Asiento de una línea de liquidación (por estado). Vigente sólo si la línea
-- es un cobro acreditado y conciliado (o con la diferencia aceptada), con la
-- Contabilidad desde antes y NinjaPOS como fuente a esa fecha.
--   Debe: banco o billetera de destino (neto), comisión, IVA de la comisión,
--         impuestos y retenciones, diferencia.
--   Haber: el "a cobrar" del cobro: bruto menos devuelto, o el cobro del POS
--          si se aceptó la diferencia (sin residuo, T15).
create or replace function acc_sync_settlement_line(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sl       settlement_lines%rowtype;
  cfg      acc_settings%rowtype;
  p        payments%rowtype;
  s        sales%rowtype;
  v_store  uuid;
  v_prov   text;
  v_eff    numeric;
  v_fee    numeric;
  v_tax    numeric;
  v_vat    numeric;
  v_net    numeric;
  v_cobro  numeric;
  v_diff   numeric;
  v_date   date;
  v_dest   uuid;
  v_lines  jsonb := '[]'::jsonb;
  v_active boolean;
begin
  select * into sl from settlement_lines where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_date := acc_ar_date(coalesce(sl.release_date, sl.operation_at));
  v_active := sl.kind = 'payment' and sl.released and sl.payment_id is not null and sl.match_status = 'matched'
              and v_date >= cfg.start_date and acc_settlement_source_at(p_tenant, v_date) = 'ninjapos';
  if v_active then
    select * into p from payments where id = sl.payment_id and tenant_id = p_tenant;
    v_active := found;
  end if;
  if v_active then
    select * into s from sales where id = p.sale_id;
    v_eff := round(sl.gross - coalesce(sl.refunded, 0), 2);
    v_active := v_eff > 0;
  end if;

  if v_active then
    v_store := coalesce(sl.scope_store_id, s.store_id);
    v_prov := treasury_provider_norm(sl.provider_key);
    v_fee := round(abs(coalesce(sl.fee, 0)), 2);
    v_tax := round(abs(coalesce(sl.taxes, 0)), 2);
    v_vat := least(settlement_fee_vat(sl.fee_detail), v_tax);
    v_net := round(coalesce(sl.net, 0), 2);
    v_cobro := case when sl.diff_accepted_at is null then v_eff
                    when s.status = 'voided' then 0
                    else round(coalesce(p.amount, 0), 2) end;
    v_diff := v_cobro - v_fee - v_tax - v_net;
    v_dest := treasury_settlement_dest(p_tenant, sl.provider_key, v_store, v_date);

    v_lines := jsonb_build_array(
      acc_line(case when v_dest is not null then acc_treasury_account(p_tenant, v_dest)
                    else acc_account_for(p_tenant, 'acreditacion', v_prov, v_store) end,
               v_net, 'Neto acreditado'),
      acc_line(acc_account_for(p_tenant, 'comision_procesador', v_prov, v_store), v_fee, 'Comisión'));
    if v_vat > 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'iva_comision',
                                                     case when cfg.vat_mode = 'none' then 'gasto' else '*' end, v_store),
                                     v_vat, 'IVA de la comisión');
    end if;
    if v_tax - v_vat <> 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'impuestos_procesador', v_prov, v_store),
                                     v_tax - v_vat, 'Impuestos y retenciones');
    end if;
    if v_diff <> 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'diferencia_procesador', v_prov, v_store), v_diff,
                                     case when sl.diff_accepted_at is not null then 'Diferencia aceptada' else 'Diferencia' end);
    end if;
    if v_cobro <> 0 then
      v_lines := v_lines || acc_line(acc_payment_account(p_tenant, p, v_store), -v_cobro, 'Cobro liquidado');
    end if;
  end if;

  perform acc_post_state(p_tenant, 'settlement_line', sl.id, 'release', v_active, v_date,
                         'Acreditación ' || coalesce(treasury_provider_label(treasury_provider_norm(sl.provider_key)), sl.provider_key)
                           || coalesce(' · venta #' || s.number, ''),
                         v_store, v_lines);
end;
$$;

-- Movimiento de Tesorería de una línea: el neto entra al banco o billetera de
-- destino con la fecha de acreditación; se deshace si deja de estar conciliada
-- o cambia el importe.
create or replace function treasury_sync_settlement(p_tenant uuid, p_line uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sl       settlement_lines%rowtype;
  v_date   date;
  v_store  uuid;
  v_num    bigint;
  v_dest   uuid;
  v_amt    numeric;
  v_active boolean;
begin
  select * into sl from settlement_lines where id = p_line and tenant_id = p_tenant;
  if not found then
    return 0;
  end if;
  v_date := acc_ar_date(coalesce(sl.release_date, sl.operation_at));
  select s.store_id, s.number into v_store, v_num from sales s where s.id = sl.sale_id;
  v_store := coalesce(sl.scope_store_id, v_store);
  v_amt := round(coalesce(sl.net, 0), 2);
  v_active := sl.kind = 'payment' and sl.released and sl.payment_id is not null and sl.match_status = 'matched'
              and v_amt > 0 and round(sl.gross - coalesce(sl.refunded, 0), 2) > 0;
  if v_active then
    v_dest := treasury_settlement_dest(p_tenant, sl.provider_key, v_store, v_date);
    v_active := v_dest is not null;
  end if;
  return _treasury_move_state(p_tenant, 'settlement_credit', 'settlement_line', sl.id, v_active, v_dest, v_amt, v_date,
                              'Acreditación ' || treasury_provider_label(treasury_provider_norm(sl.provider_key))
                                || coalesce(' · venta #' || v_num, '')
                                || coalesce(' · op. ' || nullif(btrim(sl.external_id), ''), ''),
                              sl.sale_id);
end;
$$;
revoke all on function treasury_sync_settlement(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Contracargos por estado.
-- -----------------------------------------------------------------------------
-- Línea acreditada y conciliada de un cobro (si la plata ya llegó).
create or replace function _settlement_released_line(p_tenant uuid, p_payment uuid)
returns settlement_lines
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sl.* from settlement_lines sl
   where sl.tenant_id = p_tenant and sl.payment_id = p_payment and sl.kind = 'payment'
     and sl.released and sl.match_status = 'matched'
   order by sl.release_date desc nulls last
   limit 1;
$$;
revoke all on function _settlement_released_line(uuid, uuid) from public, anon, authenticated;

-- Contracargo o reclamo perdido, o devolución desde el procesador. Vigente
-- mientras esté perdido y sin baja; perdido → ganado → perdido vuelve a
-- contabilizar (T16). Si el cobro ya se había acreditado, un contracargo o un
-- reclamo sale de la billetera o banco de destino; si no, del "a cobrar".
create or replace function acc_sync_payment_dispute(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d       payment_disputes%rowtype;
  cfg     acc_settings%rowtype;
  p       payments%rowtype;
  sl      settlement_lines%rowtype;
  v_store uuid;
  v_prov  text;
  v_cr    uuid;
  v_dest  uuid;
  v_lost  boolean;
  v_date  date;
  v_desc  text;
  v_lines jsonb;
begin
  select * into d from payment_disputes where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_date := acc_ar_date(coalesce(d.resolved_at, d.last_seen_at, d.occurred_at));
  v_lost := d.deleted_at is null and d.origin = 'provider' and d.status in ('lost', 'refunded')
            and coalesce(d.amount, 0) > 0 and v_date >= cfg.start_date;
  v_desc := case d.kind when 'chargeback' then 'Contracargo' when 'claim' then 'Reclamo perdido' else 'Devolución desde el procesador' end
            || ' · ' || d.provider_key || ' pago ' || d.provider_payment_id;

  if v_lost then
    v_prov := treasury_provider_norm(d.provider_key);
    if d.payment_id is not null then
      select * into p from payments where id = d.payment_id and tenant_id = p_tenant;
    end if;
    select store_id into v_store from sales where id = coalesce(d.sale_id, p.sale_id);
    v_store := coalesce(d.scope_store_id, v_store);
    if p.id is not null and d.kind in ('chargeback', 'claim') then
      sl := _settlement_released_line(p_tenant, p.id);
    end if;
    if sl.id is not null then
      v_dest := treasury_settlement_dest(p_tenant, sl.provider_key, v_store, v_date);
      v_cr := case when v_dest is not null then acc_treasury_account(p_tenant, v_dest)
                   else acc_account_for(p_tenant, 'acreditacion', v_prov, v_store) end;
    elsif p.id is not null then
      v_cr := acc_payment_account(p_tenant, p, v_store);
    else
      v_cr := acc_account_for(p_tenant, 'acreditacion', v_prov, v_store);
    end if;
    v_lines := jsonb_build_array(acc_line(acc_account_for(p_tenant, 'contracargos', v_prov, v_store), d.amount),
                                 acc_line(v_cr, -d.amount));
  end if;
  perform acc_post_state(p_tenant, 'payment_dispute', d.id, 'loss', v_lost, v_date, v_desc, v_store, v_lines);
end;
$$;

-- Movimiento del contracargo: sólo si el cobro ya se había acreditado en una
-- cuenta de Tesorería (la plata sale de ahí).
create or replace function treasury_sync_dispute(p_tenant uuid, p_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d        payment_disputes%rowtype;
  sl       settlement_lines%rowtype;
  v_store  uuid;
  v_date   date;
  v_dest   uuid;
  v_active boolean;
begin
  select * into d from payment_disputes where id = p_id and tenant_id = p_tenant;
  if not found then
    return 0;
  end if;
  v_date := acc_ar_date(coalesce(d.resolved_at, d.last_seen_at, d.occurred_at));
  v_active := d.deleted_at is null and d.origin = 'provider' and d.status in ('lost', 'refunded')
              and d.kind in ('chargeback', 'claim') and coalesce(d.amount, 0) > 0 and d.payment_id is not null;
  if v_active then
    sl := _settlement_released_line(p_tenant, d.payment_id);
    v_active := sl.id is not null;
  end if;
  if v_active then
    select store_id into v_store from sales where id = coalesce(d.sale_id, sl.sale_id);
    v_store := coalesce(d.scope_store_id, sl.scope_store_id, v_store);
    v_dest := treasury_settlement_dest(p_tenant, sl.provider_key, v_store, v_date);
    v_active := v_dest is not null;
  end if;
  return _treasury_move_state(p_tenant, 'processor_debit', 'payment_dispute', d.id, v_active, v_dest,
                              -round(coalesce(d.amount, 0), 2), v_date,
                              case d.kind when 'claim' then 'Reclamo perdido' else 'Contracargo' end
                                || ' · ' || treasury_provider_label(treasury_provider_norm(d.provider_key))
                                || ' pago ' || coalesce(d.provider_payment_id, ''),
                              coalesce(d.sale_id, sl.sale_id));
end;
$$;
revoke all on function treasury_sync_dispute(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) Retiros del cajón con destino.
-- -----------------------------------------------------------------------------
alter table cash_movements add column if not exists treasury_account_id uuid references treasury_accounts(id);
create index if not exists cash_movements_treasury_account_idx
  on cash_movements(treasury_account_id) where treasury_account_id is not null;
comment on column cash_movements.treasury_account_id is
  'ADR-162 (H151): cuenta de Tesorería (caja fuerte o banco) a la que va un retiro del cajón, o de la que sale un ingreso. El asiento va a esa cuenta en lugar de Fondos en tránsito y suma un movimiento cash_drop / cash_fund.';

-- Valida el destino: sólo en ingresos y retiros manuales, cuenta del negocio,
-- caja o banco en pesos, activa, abierta y con la feature tesoreria.
create or replace function trg_cash_movements_treasury_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ta treasury_accounts%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.treasury_account_id is distinct from old.treasury_account_id then
      raise exception 'cash_movement_immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.treasury_account_id is null then
    return new;
  end if;
  if new.type not in ('income', 'expense') or new.reference_id is not null then
    raise exception 'cash_destination_not_allowed';
  end if;
  select * into ta from treasury_accounts
   where id = new.treasury_account_id and tenant_id = new.tenant_id and deleted_at is null and is_active;
  if ta.id is null or ta.kind not in ('cash', 'bank') or ta.currency <> 'ARS'
     or ta.opening_date > acc_ar_date(now()) then
    raise exception 'cash_destination_invalid';
  end if;
  if not tenant_has_feature_for(new.tenant_id, 'tesoreria') then
    raise exception 'feature_not_in_plan: tesoreria';
  end if;
  return new;
end;
$$;

drop trigger if exists cash_movements_treasury_guard on cash_movements;
create trigger cash_movements_treasury_guard
  before insert or update of treasury_account_id on cash_movements
  for each row execute function trg_cash_movements_treasury_guard();

create or replace function treasury_sync_cash_movement(p_tenant uuid, p_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cm     cash_movements%rowtype;
  v_reg  text;
  v_type text;
begin
  select * into cm from cash_movements where id = p_id and tenant_id = p_tenant;
  if not found or cm.treasury_account_id is null or cm.type not in ('income', 'expense')
     or coalesce(cm.amount, 0) <= 0 then
    return 0;
  end if;
  select cr.name into v_reg from cash_shifts cs join cash_registers cr on cr.id = cs.cash_register_id
   where cs.id = cm.cash_shift_id;
  v_type := case when cm.type = 'expense' then 'cash_drop' else 'cash_fund' end;
  insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                  reference_type, reference_id, created_by)
  values (p_tenant, cm.treasury_account_id, acc_ar_date(cm.created_at),
          case when cm.type = 'expense' then 1 else -1 end * round(cm.amount, 2), v_type,
          left(case when cm.type = 'expense' then 'Retiro de ' else 'Fondo para ' end || coalesce(v_reg, 'la caja')
               || coalesce(' · ' || nullif(btrim(cm.reason), ''), ''), 300),
          'cash_movement', cm.id, cm.created_by)
  on conflict do nothing;
  return 1;
end;
$$;
revoke all on function treasury_sync_cash_movement(uuid, uuid) from public, anon, authenticated;

-- Destinos posibles de un retiro del cajón (lo puede leer el cajero: sólo
-- nombre y tipo). Vacío sin la feature tesoreria.
create or replace function treasury_drop_destinations()
returns table (id uuid, name text, kind text, store_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or stock_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'tesoreria') then
    return;
  end if;
  return query
    select ta.id, ta.name, ta.kind, ta.store_id
      from treasury_accounts ta
     where ta.tenant_id = v_tenant and ta.deleted_at is null and ta.is_active
       and ta.kind in ('cash', 'bank') and ta.currency = 'ARS' and ta.opening_date <= acc_ar_date(now())
     order by (ta.kind = 'cash') desc, ta.name;
end;
$$;
revoke all on function treasury_drop_destinations() from public, anon;
grant execute on function treasury_drop_destinations() to authenticated;

-- acc_sync_cash_movement: definición viva (ADR-158) + destino del retiro.
create or replace function acc_sync_cash_movement(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cm cash_movements%rowtype;
  cfg acc_settings%rowtype;
  d appointment_deposits%rowtype;
  v_store uuid;
  v_caja uuid;
  v_other uuid;
  v_amt numeric;
  v_in boolean;
  v_dest text;
begin
  select * into cm from cash_movements where id = p_id and tenant_id = p_tenant;
  if not found then
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

  -- Ingreso o retiro manual del cajón: contra la cuenta de destino si se eligió
  -- (caja fuerte o banco, ADR-162); si no, Fondos en tránsito como siempre.
  if cm.type in ('income', 'expense') and cm.reference_id is null then
    v_caja := acc_account_for(p_tenant, 'cobro', 'cash', v_store);
    if cm.treasury_account_id is not null then
      v_other := acc_treasury_account(p_tenant, cm.treasury_account_id);
      select name into v_dest from treasury_accounts where id = cm.treasury_account_id;
    else
      v_other := acc_account_for(p_tenant, 'caja_movimiento', cm.type, v_store);
    end if;
    perform acc_post(p_tenant, acc_ar_date(cm.created_at), 'cash_movement', cm.id, 'main',
      coalesce(nullif(btrim(cm.reason), ''), case cm.type when 'income' then 'Ingreso de caja' else 'Retiro de caja' end)
        || coalesce(case cm.type when 'income' then ' · desde ' else ' · a ' end || v_dest, ''),
      v_store,
      case cm.type when 'income' then
        jsonb_build_array(acc_line(v_caja, v_amt), acc_line(v_other, -v_amt))
      else
        jsonb_build_array(acc_line(v_other, v_amt), acc_line(v_caja, -v_amt))
      end);
    return;
  end if;

  -- Seña de un turno (ADR-082/088): cobrada o devuelta, con el medio de la seña.
  if cm.type not in ('income', 'expense', 'deposit_in', 'deposit_out') or cm.reference_id is null then
    return;
  end if;
  select * into d from appointment_deposits where id = cm.reference_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  v_store := coalesce(v_store, d.store_id);
  v_in := cm.type in ('income', 'deposit_in');
  v_caja := acc_account_for(p_tenant, 'cobro', acc_payment_qualifier(p_tenant, d.method, d.reference, null), v_store);
  v_other := acc_account_for(p_tenant, 'senas', '*', v_store);
  perform acc_post(p_tenant, acc_ar_date(cm.created_at), 'cash_movement', cm.id, 'main',
    case when v_in then 'Seña de turno' else 'Devolución de seña' end
      || coalesce(' · ' || nullif(btrim(cm.reason), ''), ''),
    v_store,
    case when v_in then
      jsonb_build_array(acc_line(v_caja, v_amt, 'Cobro ' || d.method), acc_line(v_other, -v_amt, 'Seña'))
    else
      jsonb_build_array(acc_line(v_other, v_amt, 'Seña'), acc_line(v_caja, -v_amt, 'Devolución ' || d.method))
    end);
end;
$$;

-- -----------------------------------------------------------------------------
-- G) Cobro de cuenta corriente por transferencia a su cuenta.
-- -----------------------------------------------------------------------------
alter table customer_account_movements add column if not exists transfer_account_id uuid references transfer_accounts(id);
comment on column customer_account_movements.transfer_account_id is
  'ADR-162: cuenta de cobro por transferencia de un cobro de cuenta corriente. Si está vinculada a un banco o billetera de Tesorería, suma ahí (cc_collection) y el asiento va a su cuenta contable.';

-- Cuenta de Tesorería vigente de una cuenta de cobro por transferencia.
create or replace function treasury_account_of_transfer(p_tenant uuid, p_transfer uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ta.id
    from treasury_account_transfer_accounts l
    join treasury_accounts ta on ta.id = l.treasury_account_id
   where l.tenant_id = p_tenant and l.deleted_at is null and l.transfer_account_id = p_transfer
     and ta.deleted_at is null
   limit 1;
$$;
revoke all on function treasury_account_of_transfer(uuid, uuid) from public, anon, authenticated;

-- Cuenta contable del cobro de un movimiento de cuenta corriente: la
-- transferencia a una cuenta vinculada (desde su fecha de apertura) va a la
-- cuenta de esa cuenta de Tesorería; el resto, por el mapeo 'cobro'.
create or replace function acc_cc_payment_account(p_tenant uuid, m customer_account_movements, p_store uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ta uuid;
begin
  if m.method = 'transfer' and m.transfer_account_id is not null then
    v_ta := treasury_account_of_transfer(p_tenant, m.transfer_account_id);
    if v_ta is not null and exists (
      select 1 from treasury_accounts ta where ta.id = v_ta and acc_ar_date(m.created_at) >= ta.opening_date) then
      return acc_treasury_account(p_tenant, v_ta);
    end if;
  end if;
  return acc_account_for(p_tenant, 'cobro', coalesce(m.method, 'other'), p_store);
end;
$$;
revoke all on function acc_cc_payment_account(uuid, customer_account_movements, uuid) from public, anon, authenticated;

create or replace function treasury_sync_cc_payment(p_tenant uuid, p_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m      customer_account_movements%rowtype;
  ta     treasury_accounts%rowtype;
  v_cust text;
  v_col  uuid;
  v_n    int := 0;
begin
  select * into m from customer_account_movements where id = p_id and tenant_id = p_tenant;
  if not found or m.kind <> 'payment' or m.method <> 'transfer' or m.transfer_account_id is null
     or coalesce(m.delta, 0) >= 0 or not tenant_has_feature_for(p_tenant, 'tesoreria') then
    return 0;
  end if;
  select * into ta from treasury_accounts where id = treasury_account_of_transfer(p_tenant, m.transfer_account_id);
  if ta.id is null or acc_ar_date(m.created_at) < ta.opening_date then
    return 0;
  end if;
  select name into v_cust from customers where id = m.customer_id;

  select id into v_col from treasury_movements where reference_id = m.id and type = 'cc_collection';
  if v_col is null then
    insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                    reference_type, reference_id, created_by)
    values (p_tenant, ta.id, acc_ar_date(m.created_at), round(-m.delta, 2), 'cc_collection',
            left('Cobro de cuenta corriente' || coalesce(' recibo #' || m.receipt_no, '') || coalesce(' · ' || v_cust, ''), 300),
            'cc_movement', m.id, m.created_by)
    on conflict do nothing
    returning id into v_col;
    if v_col is not null then
      v_n := v_n + 1;
    else
      select id into v_col from treasury_movements where reference_id = m.id and type = 'cc_collection';
    end if;
  end if;
  if m.voided_at is not null and v_col is not null
     and not exists (select 1 from treasury_movements where reference_id = m.id and type = 'cc_collection_void') then
    insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                    reference_type, reference_id, counterpart_id, created_by)
    select p_tenant, c.account_id, greatest(acc_ar_date(m.voided_at), c.movement_date), -c.amount, 'cc_collection_void',
           left('Anulación del cobro' || coalesce(' recibo #' || m.receipt_no, '') || coalesce(' · ' || v_cust, ''), 300),
           'cc_movement', m.id, c.id, auth.uid()
      from treasury_movements c where c.id = v_col
    on conflict do nothing;
    v_n := v_n + 1;
  end if;
  return v_n;
end;
$$;
revoke all on function treasury_sync_cc_payment(uuid, uuid) from public, anon, authenticated;

-- acc_sync_cc_movement: definición viva; el cobro por transferencia a su cuenta.
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

-- acc_sync_tax_suffered: definición viva; la reclasificación sale de la misma
-- cuenta en la que entró el cobro (banco de Tesorería si la transferencia
-- estaba vinculada).
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
      v_cr := acc_account_for(p_tenant, 'impuestos_procesador', treasury_provider_norm(sl.provider_key), v_store);
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
      v_cr := acc_payment_account(p_tenant, pm, v_store);
    elsif e.cc_movement_id is not null then
      select * into cm from customer_account_movements where id = e.cc_movement_id and tenant_id = p_tenant;
      if not found then return; end if;
      perform acc_sync_cc_movement(p_tenant, cm.id);
      if acc_entry_of(p_tenant, 'cc_movement', cm.id, 'main') is null then
        return;
      end if;
      v_store := coalesce(v_store, acc_shift_store(cm.cash_shift_id));
      v_cr := acc_cc_payment_account(p_tenant, cm, acc_shift_store(cm.cash_shift_id));
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

-- account_collect: definición viva + p_transfer_account (opcional, al final).
-- Se reemplaza la firma de 6 parámetros: las llamadas con nombre siguen igual.
drop function if exists account_collect(uuid, numeric, text, jsonb, text, text);
create or replace function account_collect(p_customer_id uuid, p_amount numeric, p_method text,
                                           p_allocations jsonb default null, p_idempotency_key text default null,
                                           p_note text default null, p_transfer_account uuid default null)
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
  v_ta      uuid;
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
  -- ADR-162: cuenta de cobro de la transferencia (sólo con medio transferencia).
  if p_transfer_account is not null and v_method = 'transfer' then
    select t.id into v_ta from transfer_accounts t
     where t.id = p_transfer_account and t.tenant_id = v_tenant and t.deleted_at is null;
    if v_ta is null then
      raise exception 'transfer_account_not_found';
    end if;
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
     idempotency_key, note, created_by, transfer_account_id)
  values
    (v_tenant, v_cust.id, 'payment', -v_amount, 'Cobro recibo #' || v_receipt, v_method, v_shift,
     v_receipt, v_key, nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), v_ta)
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
                             'chosen_allocations', p_allocations, 'transfer_account_id', v_ta));

  return account_payment_result(v_pay);
end;
$$;
revoke all on function account_collect(uuid, numeric, text, jsonb, text, text, uuid) from public, anon;
grant execute on function account_collect(uuid, numeric, text, jsonb, text, text, uuid) to authenticated;

-- Vincular una cuenta de cobro (definición viva de ADR-158): al vincular trae
-- también los cobros de cuenta corriente por transferencia (ADR-162).
create or replace function treasury_account_link_transfer(p_treasury uuid, p_transfer uuid, p_linked boolean)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  ta       treasury_accounts;
  tr       transfer_accounts%rowtype;
  v_prev   treasury_account_transfer_accounts%rowtype;
  v_n      int := 0;
  r        record;
begin
  ta := treasury_account_get(v_tenant, p_treasury);
  select * into tr from transfer_accounts
   where id = p_transfer and tenant_id = v_tenant and deleted_at is null;
  if tr.id is null then
    raise exception 'transfer_account_not_found';
  end if;
  select * into v_prev from treasury_account_transfer_accounts
   where transfer_account_id = tr.id and deleted_at is null;

  if not coalesce(p_linked, false) then
    if v_prev.id is not null and v_prev.treasury_account_id = ta.id then
      update treasury_account_transfer_accounts set deleted_at = now(), deleted_by = auth.uid() where id = v_prev.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
      values (v_tenant, auth.uid(), 'treasury_accounts', ta.id, 'treasury_transfer_unlinked',
              jsonb_build_object('transfer_account_id', tr.id));
    end if;
    return 0;
  end if;

  if ta.kind not in ('bank', 'wallet') then
    raise exception 'treasury_account_kind_not_linkable';
  end if;
  if upper(coalesce(tr.currency, 'ARS')) <> ta.currency then
    raise exception 'currency_mismatch';
  end if;
  if v_prev.id is not null and v_prev.treasury_account_id = ta.id then
    return 0;
  end if;
  if v_prev.id is not null then
    update treasury_account_transfer_accounts set deleted_at = now(), deleted_by = auth.uid() where id = v_prev.id;
  end if;
  insert into treasury_account_transfer_accounts (tenant_id, treasury_account_id, transfer_account_id)
  values (v_tenant, ta.id, tr.id);

  for r in
    select p.id from payments p
     where p.tenant_id = v_tenant and p.method = 'transfer'
       and p.metadata -> 'transfer' ->> 'account_id' = tr.id::text
       and p.created_at >= acc_ar_start(ta.opening_date)
     order by p.created_at
     limit 5000
  loop
    v_n := v_n + treasury_sync_payment(v_tenant, r.id);
  end loop;
  for r in
    select m.id from customer_account_movements m
     where m.tenant_id = v_tenant and m.kind = 'payment' and m.method = 'transfer'
       and m.transfer_account_id = tr.id and m.created_at >= acc_ar_start(ta.opening_date)
     order by m.created_at
     limit 5000
  loop
    v_n := v_n + treasury_sync_cc_payment(v_tenant, r.id);
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'treasury_accounts', ta.id, 'treasury_transfer_linked',
          case when v_prev.id is not null then jsonb_build_object('treasury_account_id', v_prev.treasury_account_id) end,
          jsonb_build_object('transfer_account_id', tr.id, 'movements', v_n));
  return v_n;
end;
$$;
revoke all on function treasury_account_link_transfer(uuid, uuid, boolean) from public, anon;
grant execute on function treasury_account_link_transfer(uuid, uuid, boolean) to authenticated;

-- Elegir qué procesadores acreditan en un banco o billetera. Trae las
-- liquidaciones conciliadas de esos procesadores desde la fecha de apertura.
create or replace function treasury_account_set_settlement(p_account uuid, p_providers text[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  ta       treasury_accounts;
  v_before text[];
  v_n      int := 0;
  r        record;
begin
  ta := treasury_account_get(v_tenant, p_account);
  if ta.kind not in ('bank', 'wallet') then
    raise exception 'treasury_account_kind_not_linkable';
  end if;
  if not treasury_provider_keys_ok(coalesce(p_providers, '{}'::text[])) then
    raise exception 'invalid_providers';
  end if;
  v_before := ta.settlement_providers;
  update treasury_accounts set settlement_providers = coalesce(p_providers, '{}'::text[]) where id = ta.id
  returning * into ta;

  for r in
    select sl.id from settlement_lines sl
     where sl.tenant_id = v_tenant and sl.kind = 'payment' and sl.released and sl.match_status = 'matched'
       and coalesce(sl.release_date, sl.operation_at) >= acc_ar_start(ta.opening_date)
       and (treasury_provider_norm(sl.provider_key) = any (ta.settlement_providers || v_before)
            or (ta.kind = 'wallet' and treasury_provider_norm(sl.provider_key) = ta.provider_key))
     order by coalesce(sl.release_date, sl.operation_at)
     limit 5000
  loop
    v_n := v_n + treasury_sync_settlement(v_tenant, r.id);
    if acc_tenant_active(v_tenant) then
      perform acc_sync_safe(v_tenant, 'settlement_line', r.id);
    end if;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'treasury_accounts', ta.id, 'treasury_settlement_providers_set',
          jsonb_build_object('settlement_providers', v_before),
          jsonb_build_object('settlement_providers', ta.settlement_providers, 'movements', v_n));
  return v_n;
end;
$$;
revoke all on function treasury_account_set_settlement(uuid, text[]) from public, anon;
grant execute on function treasury_account_set_settlement(uuid, text[]) to authenticated;

-- -----------------------------------------------------------------------------
-- Triggers diferidos de los documentos (nunca frenan la operación).
-- -----------------------------------------------------------------------------
create or replace function treasury_doc_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    case tg_argv[0]
      when 'settlement_line' then
        -- Corte rápido: sin cuentas de destino ni movimientos previos, nada.
        if exists (select 1 from treasury_accounts ta
                    where ta.tenant_id = new.tenant_id and ta.deleted_at is null
                      and (ta.kind = 'wallet' or (ta.kind = 'bank' and ta.settlement_providers <> '{}'::text[])))
           or exists (select 1 from treasury_movements m where m.reference_id = new.id and m.type = 'settlement_credit') then
          perform treasury_sync_settlement(new.tenant_id, new.id);
        end if;
      when 'payment_dispute' then
        if new.payment_id is not null then
          perform treasury_sync_dispute(new.tenant_id, new.id);
        end if;
      when 'cash_movement' then
        perform treasury_sync_cash_movement(new.tenant_id, new.id);
      when 'cc_movement' then
        perform treasury_sync_cc_payment(new.tenant_id, new.id);
    end case;
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, auth.uid(),
            case tg_argv[0] when 'settlement_line' then 'settlement_lines' when 'payment_dispute' then 'payment_disputes'
                            when 'cash_movement' then 'cash_movements' else 'customer_account_movements' end,
            new.id, 'treasury_sync_failed', jsonb_build_object('error', left(sqlerrm, 500)));
  end;
  return null;
end;
$$;

drop trigger if exists treasury_settlement_lines_sync on settlement_lines;
create constraint trigger treasury_settlement_lines_sync
  after insert or update on settlement_lines
  deferrable initially deferred
  for each row when (new.kind = 'payment')
  execute function treasury_doc_trg('settlement_line');

drop trigger if exists treasury_payment_disputes_sync on payment_disputes;
create constraint trigger treasury_payment_disputes_sync
  after insert or update on payment_disputes
  deferrable initially deferred
  for each row when (new.origin = 'provider' and new.kind in ('chargeback', 'claim'))
  execute function treasury_doc_trg('payment_dispute');

drop trigger if exists treasury_cash_movements_sync on cash_movements;
create constraint trigger treasury_cash_movements_sync
  after insert on cash_movements
  deferrable initially deferred
  for each row when (new.treasury_account_id is not null)
  execute function treasury_doc_trg('cash_movement');

drop trigger if exists treasury_cc_movements_sync on customer_account_movements;
create constraint trigger treasury_cc_movements_sync
  after insert or update of voided_at on customer_account_movements
  deferrable initially deferred
  for each row when (new.kind = 'payment' and new.method = 'transfer' and new.transfer_account_id is not null)
  execute function treasury_doc_trg('cc_movement');

-- Asientos de liquidaciones y contracargos: ahora por estado, así que se
-- re-evalúan cuando cambia cualquier dato que los define.
drop trigger if exists acc_settlement_lines_ins on settlement_lines;
create constraint trigger acc_settlement_lines_ins
  after insert on settlement_lines
  deferrable initially deferred
  for each row when (new.kind = 'payment' and new.released and new.payment_id is not null)
  execute function acc_source_trg('settlement_line');

drop trigger if exists acc_settlement_lines_upd on settlement_lines;
create constraint trigger acc_settlement_lines_upd
  after update on settlement_lines
  deferrable initially deferred
  for each row when (new.kind = 'payment' and (
       old.released is distinct from new.released
    or old.payment_id is distinct from new.payment_id
    or old.match_status is distinct from new.match_status
    or old.diff_accepted_at is distinct from new.diff_accepted_at
    or old.gross is distinct from new.gross
    or old.refunded is distinct from new.refunded
    or old.fee is distinct from new.fee
    or old.taxes is distinct from new.taxes
    or old.net is distinct from new.net
    or old.release_date is distinct from new.release_date
    or old.fee_detail is distinct from new.fee_detail))
  execute function acc_source_trg('settlement_line');

drop trigger if exists acc_payment_disputes_upd on payment_disputes;
create constraint trigger acc_payment_disputes_upd
  after update on payment_disputes
  deferrable initially deferred
  for each row when (new.origin = 'provider' and (
       old.status is distinct from new.status
    or old.deleted_at is distinct from new.deleted_at
    or old.amount is distinct from new.amount))
  execute function acc_source_trg('payment_dispute');

-- -----------------------------------------------------------------------------
-- "Ver asiento" de los movimientos con origen nuevos (definición viva + tipos).
-- -----------------------------------------------------------------------------
create or replace function acc_entry_lookup(p_source_type text, p_source_id uuid)
returns table (id uuid, number bigint, entry_date date, description text, source_type text, source_id uuid,
               source_event text, total numeric, kind text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_type   text := p_source_type;
  v_id     uuid := p_source_id;
  mv       treasury_movements%rowtype;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not acc_can_read() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_source_type = 'treasury_movement' then
    select * into mv from treasury_movements m where m.id = p_source_id and m.tenant_id = v_tenant;
    if mv.type in ('sale_collection', 'sale_collection_void') then
      v_type := 'sale';
      v_id := mv.sale_id;
    elsif mv.type in ('supplier_payment', 'supplier_payment_void') then
      v_type := 'supplier_payment';
      v_id := mv.reference_id;
    elsif mv.type = 'transfer_in' then
      v_id := mv.counterpart_id;
    elsif mv.type in ('settlement_credit', 'settlement_credit_void') then
      v_type := 'settlement_line';
      v_id := mv.reference_id;
    elsif mv.type in ('processor_debit', 'processor_debit_void') then
      v_type := 'payment_dispute';
      v_id := mv.reference_id;
    elsif mv.type in ('cash_drop', 'cash_fund') then
      v_type := 'cash_movement';
      v_id := mv.reference_id;
    elsif mv.type in ('cc_collection', 'cc_collection_void') then
      v_type := 'cc_movement';
      v_id := mv.reference_id;
    end if;
  end if;
  return query
    select e.id, e.number, e.entry_date, e.description, e.source_type, e.source_id, e.source_event, e.total, e.kind
      from acc_entries e
     where e.tenant_id = v_tenant and e.deleted_at is null
       and ((e.source_type = v_type and e.source_id = v_id)
            or (p_source_type = 'cheque' and e.source_type = 'treasury_movement'
                and e.source_id in (select m.id from treasury_movements m
                                     where m.tenant_id = v_tenant and m.cheque_id = p_source_id)))
     order by e.entry_date, e.number;
end;
$$;
revoke all on function acc_entry_lookup(text, uuid) from public, anon;
grant execute on function acc_entry_lookup(text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Posición (definición viva de ADR-158) + procesadores que acreditan en cada
-- cuenta.
-- -----------------------------------------------------------------------------
create or replace function treasury_position()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
begin
  return coalesce((
    with acc as (
      select a.* from treasury_accounts a where a.tenant_id = v_tenant and a.deleted_at is null
    ), mv as (
      select m.account_id,
             coalesce(sum(m.amount) filter (where m.voided_at is null), 0) as total,
             coalesce(sum(m.amount) filter (where m.voided_at is null and m.reconciled_at is not null), 0) as rec,
             count(*) filter (where m.voided_at is null and m.reconciled_at is null)::int as unrec,
             max(m.movement_date) filter (where m.voided_at is null) as last_date
        from treasury_movements m
       where m.tenant_id = v_tenant
       group by m.account_id
    ), pend as (
      select t.provider_key, sum(t.amount) as amount, count(*)::int as n,
             min(acc_ar_date(t.created_at)) as oldest
        from _treasury_pending(v_tenant) t
       group by t.provider_key
    ), pos as (
      select a.id as account_id, o.id as open_shift, o.opened_at, o.opening_amount,
             (select coalesce(sum(case when cm.type = 'income' then cm.amount
                                       when cm.type = 'expense' then -cm.amount
                                       when cm.type = 'sale' and cm.payment_method = 'cash' then cm.amount
                                       when cm.type = 'sale_void' and cm.payment_method = 'cash' then -cm.amount
                                       else 0 end), 0)
                from cash_movements cm where cm.cash_shift_id = o.id) as delta,
             c.closing_amount, c.closed_at
        from acc a
        left join lateral (
          select cs.id, cs.opened_at, cs.opening_amount from cash_shifts cs
           where cs.cash_register_id = a.cash_register_id and cs.status = 'open'
           order by cs.opened_at desc limit 1) o on true
        left join lateral (
          select cs.closing_amount, cs.closed_at from cash_shifts cs
           where cs.cash_register_id = a.cash_register_id and cs.status = 'closed'
           order by cs.closed_at desc limit 1) c on true
       where a.kind = 'pos_cash'
    ), links as (
      select l.treasury_account_id,
             jsonb_agg(jsonb_build_object('id', t.id, 'bank_name', t.bank_name, 'alias', t.alias,
                                          'holder_name', t.holder_name) order by t.sort, t.bank_name) as items
        from treasury_account_transfer_accounts l
        join transfer_accounts t on t.id = l.transfer_account_id
       where l.tenant_id = v_tenant and l.deleted_at is null
       group by l.treasury_account_id
    ), ledger as (
      select distinct on (split_part(m.qualifier, ':', 2))
             split_part(m.qualifier, ':', 2) as account_ref,
             jsonb_build_object('id', aa.id, 'code', aa.code, 'name', aa.name) as obj
        from acc_mappings m
        join acc_accounts aa on aa.id = m.account_id and aa.deleted_at is null
       where m.tenant_id = v_tenant and m.concept = 'tesoreria' and m.qualifier like '%:%'
       order by split_part(m.qualifier, ':', 2), (m.store_id is null) desc
    )
    select jsonb_agg(jsonb_build_object(
             'account_id', a.id,
             'kind', a.kind,
             'name', a.name,
             'currency', a.currency,
             'store_id', a.store_id,
             'provider_key', a.provider_key,
             'cash_register_id', a.cash_register_id,
             'is_active', a.is_active,
             'is_system', a.is_system,
             'settlement_providers', to_jsonb(a.settlement_providers),
             'balance', round(case
                 when a.kind = 'pos_cash' then
                   case when p.open_shift is not null then p.opening_amount + p.delta else coalesce(p.closing_amount, 0) end
                 when a.kind = 'receivable' then coalesce(pe.amount, 0)
                 else a.opening_balance + coalesce(mv.total, 0) end, 2),
             'reconciled_balance', round(case when a.kind in ('pos_cash', 'receivable') then 0
                                              else a.opening_balance + coalesce(mv.rec, 0) end, 2),
             'unreconciled_count', coalesce(mv.unrec, 0),
             'last_movement', mv.last_date,
             'detail', case
                 when a.kind = 'pos_cash' then jsonb_build_object(
                   'shift_open', p.open_shift is not null, 'opened_at', p.opened_at,
                   'closed_at', p.closed_at, 'counted', p.closing_amount)
                 when a.kind = 'receivable' then jsonb_build_object(
                   'pending_count', coalesce(pe.n, 0), 'oldest_date', pe.oldest)
                 else '{}'::jsonb end,
             'transfer_accounts', coalesce(l.items, '[]'::jsonb),
             'ledger_account', lg.obj
           ) order by case a.kind when 'pos_cash' then 1 when 'cash' then 2 when 'bank' then 3
                                  when 'wallet' then 4 else 5 end, a.name)
      from acc a
      left join mv on mv.account_id = a.id
      left join pos p on p.account_id = a.id
      left join pend pe on a.kind = 'receivable' and pe.provider_key = a.provider_key
      left join links l on l.treasury_account_id = a.id
      left join ledger lg on lg.account_ref = a.id::text
  ), '[]'::jsonb);
end;
$$;
revoke all on function treasury_position() from public, anon;
grant execute on function treasury_position() to authenticated;

-- -----------------------------------------------------------------------------
-- Fecha de Argentina en el alta de pagos y órdenes de pago sin fecha (deuda de
-- ADR-158). Definiciones vivas; sólo cambia current_date por el día de
-- Argentina.
-- -----------------------------------------------------------------------------
create or replace function supplier_payment_create(p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant uuid := purchase_assert(true);
  v_sup    uuid;
  v_cur    text := upper(coalesce(nullif(p ->> 'currency', ''), 'ARS'));
  v_fx     numeric;
  v_net    numeric := round(coalesce((p ->> 'net_paid')::numeric, 0), 2);
  v_wh     jsonb := coalesce(p -> 'withholdings', '[]'::jsonb);
  v_whtot  numeric := 0;
  v_line   record;
  v_number int;
  v_id     uuid;
begin
  select id into v_sup from suppliers
   where id = (p ->> 'supplier_id')::uuid and tenant_id = v_tenant and deleted_at is null;
  if v_sup is null then
    raise exception 'supplier_not_found';
  end if;
  v_fx := case when v_cur = 'ARS' then 1 else coalesce((p ->> 'fx_rate')::numeric, 0) end;
  if v_fx <= 0 then
    raise exception 'invalid_fx_rate';
  end if;
  if jsonb_typeof(v_wh) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  for v_line in select x.amount from jsonb_to_recordset(v_wh) as x(amount numeric) loop
    if coalesce(v_line.amount, 0) < 0 then
      raise exception 'invalid_amount';
    end if;
    v_whtot := v_whtot + round(coalesce(v_line.amount, 0), 2);
  end loop;
  if v_net < 0 or v_net + v_whtot <= 0 then
    raise exception 'invalid_amount';
  end if;

  perform pg_advisory_xact_lock(hashtext('supplier_payment_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from supplier_payments where tenant_id = v_tenant;

  insert into supplier_payments (tenant_id, number, supplier_id, paid_date, method, reference, currency, fx_rate,
                                 amount, withholdings, withholdings_total, net_paid, notes, created_by)
  values (v_tenant, v_number, v_sup, coalesce((nullif(p ->> 'paid_date', ''))::date, (now() at time zone 'America/Argentina/Buenos_Aires')::date),
          coalesce(p ->> 'method', 'transferencia'), nullif(trim(coalesce(p ->> 'reference', '')), ''),
          v_cur, v_fx, v_net + v_whtot, v_wh, v_whtot, v_net,
          nullif(trim(coalesce(p ->> 'notes', '')), ''), auth.uid())
  returning id into v_id;

  perform purchase_log(v_tenant, 'payment', v_id, 'created', null, 'posted', null,
                       jsonb_build_object('number', v_number, 'supplier_id', v_sup, 'amount', v_net + v_whtot,
                                          'net_paid', v_net, 'withholdings_total', v_whtot, 'currency', v_cur));
  return v_id;
end;
$function$;

create or replace function supplier_payment_order_create(p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant   uuid := purchase_assert(true);
  v_tes      boolean;
  v_sup      suppliers;
  v_date     date := coalesce((nullif(p ->> 'paid_date', ''))::date, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  v_wh       jsonb := coalesce(p -> 'withholdings', '[]'::jsonb);
  v_whtot    numeric;
  v_net      numeric := 0;
  v_alloc    numeric := 0;
  v_line     record;
  v_al       record;
  v_open     numeric;
  v_inv      supplier_invoices;
  v_number   int;
  v_pay      uuid := gen_random_uuid();
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
  -- retenciones como agente (ADR-079)
  v_agent    boolean := coalesce((p ->> 'agent_retentions')::boolean, false);
  v_opts     jsonb := coalesce(p -> 'retention_options', '{}'::jsonb);
  v_calc     jsonb;
  v_rl       jsonb;
  v_cert     int;
  v_certtxt  text;
  v_whid     uuid;
  v_agentsnap jsonb;
  v_subjsnap jsonb;
  v_regs     jsonb := '[]'::jsonb;
  v_issued   jsonb := '[]'::jsonb;
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
  if jsonb_typeof(v_wh) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  v_tes := tenant_has_feature_for(v_tenant, 'tesoreria');

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

  -- Retenciones como agente: el servidor las calcula (las del cliente con
  -- regime_id se descartan) y numera los certificados.
  if v_agent then
    if not tenant_has_feature_for(v_tenant, 'percepciones_retenciones') then
      raise exception 'feature_not_in_plan: percepciones_retenciones' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtext('tax_wh_supplier:' || v_sup.id::text));
    v_wh := coalesce((select jsonb_agg(x) from jsonb_array_elements(v_wh) x
                       where coalesce(x ->> 'regime_id', '') = ''), '[]'::jsonb);
    v_calc := _tax_retention_compute(
      v_tenant, v_sup.id,
      _tax_retention_bases(v_tenant, v_sup.id, p -> 'allocations', v_net + purchase_withholdings_total(v_wh)),
      v_date, v_opts - 'save_profile', null);
    if p ? 'agent_expected_total'
       and abs((v_calc ->> 'total')::numeric - coalesce((p ->> 'agent_expected_total')::numeric, 0)) > 0.009 then
      raise exception 'retentions_changed';
    end if;
    if coalesce((v_opts ->> 'save_profile')::boolean, false) then
      insert into supplier_tax_profiles as t (tenant_id, supplier_id, ganancias_condition, ganancias_concept, suss_code)
      values (v_tenant, v_sup.id, v_calc -> 'supplier' ->> 'ganancias_condition',
              v_calc -> 'supplier' ->> 'ganancias_concept', v_calc -> 'supplier' ->> 'suss_code')
      on conflict (tenant_id, supplier_id) do update
        set ganancias_condition = excluded.ganancias_condition,
            ganancias_concept = excluded.ganancias_concept,
            suss_code = excluded.suss_code;
    end if;
    if (v_calc ->> 'total')::numeric > 0 then
      v_agentsnap := _tax_ret_agent_snapshot(v_tenant);
      if nullif(v_agentsnap ->> 'cuit', '') is null then
        raise exception 'agent_cuit_missing';
      end if;
    end if;
    v_subjsnap := jsonb_build_object(
      'name', v_sup.name, 'cuit', v_sup.cuit, 'address', v_sup.address, 'city', v_sup.city,
      'province', v_sup.province, 'iva_condition', v_sup.iva_condition,
      'ganancias_condition', v_calc -> 'supplier' ->> 'ganancias_condition');
    for v_rl in select * from jsonb_array_elements(v_calc -> 'lines') loop
      continue when not ((v_rl ->> 'applies')::boolean or (v_rl ->> 'accumulates')::boolean);
      v_cert := null; v_certtxt := null;
      v_whid := gen_random_uuid();
      if (v_rl ->> 'applies')::boolean then
        perform pg_advisory_xact_lock(hashtext('tax_wh_cert:' || (v_rl ->> 'regime_id')));
        select coalesce(max(w.certificate_number), 0) + 1 into v_cert
          from tax_withholdings w
         where w.tenant_id = v_tenant and w.regime_id = (v_rl ->> 'regime_id')::uuid;
        v_certtxt := case v_rl ->> 'tax' when 'ganancias' then 'GAN' when 'iva' then 'IVA' when 'suss' then 'SUSS'
                                        else 'IIBB' || coalesce(v_rl ->> 'jurisdiction', '') end
                     || '-' || lpad(v_cert::text, 8, '0');
        v_wh := v_wh || jsonb_build_array(jsonb_build_object(
          'kind', v_rl ->> 'tax',
          'description', left(coalesce(v_rl ->> 'name', '') || coalesce(' · ' || (v_rl ->> 'concept_name'), ''), 120),
          'certificate', v_certtxt, 'amount', (v_rl ->> 'amount')::numeric,
          'regime_id', v_rl ->> 'regime_id', 'withholding_id', v_whid,
          'jurisdiction', v_rl ->> 'jurisdiction', 'base', (v_rl ->> 'base')::numeric,
          'rate', (v_rl ->> 'rate')::numeric));
        v_issued := v_issued || jsonb_build_array(jsonb_build_object(
          'certificate', v_certtxt, 'tax', v_rl ->> 'tax', 'amount', (v_rl ->> 'amount')::numeric));
      end if;
      v_regs := v_regs || jsonb_build_array(v_rl || jsonb_build_object(
        'id', v_whid, 'certificate_number', v_cert, 'certificate', v_certtxt));
    end loop;
  end if;

  v_whtot := purchase_withholdings_total(v_wh);
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

  insert into supplier_payments (id, tenant_id, number, supplier_id, paid_date, method, reference, currency, fx_rate,
                                 amount, withholdings, withholdings_total, net_paid, notes, kind, created_by)
  values (v_pay, v_tenant, v_number, v_sup.id, v_date, v_method, null, 'ARS', 1, v_net + v_whtot, v_wh, v_whtot, v_net,
          nullif(trim(coalesce(p ->> 'notes', '')), ''), 'order', auth.uid());

  -- Registro de retenciones (con la OP ya creada).
  for v_rl in select * from jsonb_array_elements(v_regs) loop
    insert into tax_withholdings (
      id, tenant_id, payment_id, payment_number, payment_total, supplier_id, regime_id, tax, jurisdiction,
      date, period, concept_code, concept_name, condition, payment_base, prior_base, accumulated_base,
      non_taxable_min, taxable_base, month_total, prior_withheld, rate, rate_source, exemption_pct, amount, reason,
      certificate_number, certificate, sicore_tax_code, sicore_regime_code, agent_snapshot, subject_snapshot)
    values (
      (v_rl ->> 'id')::uuid, v_tenant, v_pay, v_number, v_net + v_whtot, v_sup.id, (v_rl ->> 'regime_id')::uuid,
      v_rl ->> 'tax', v_rl ->> 'jurisdiction', v_date, date_trunc('month', v_date)::date,
      v_rl ->> 'concept_code', v_rl ->> 'concept_name', v_rl ->> 'condition',
      coalesce((v_rl ->> 'base')::numeric, 0), coalesce((v_rl ->> 'prior_base')::numeric, 0),
      coalesce((v_rl ->> 'accumulated_base')::numeric, 0), coalesce((v_rl ->> 'non_taxable_min')::numeric, 0),
      coalesce((v_rl ->> 'taxable_base')::numeric, 0), coalesce((v_rl ->> 'month_total')::numeric, 0),
      coalesce((v_rl ->> 'prior_withheld')::numeric, 0), (v_rl ->> 'rate')::numeric, v_rl ->> 'rate_source',
      coalesce((v_rl ->> 'exemption_pct')::numeric, 0),
      case when (v_rl ->> 'applies')::boolean then (v_rl ->> 'amount')::numeric else 0 end,
      v_rl ->> 'reason', (v_rl ->> 'certificate_number')::int, v_rl ->> 'certificate',
      (v_rl ->> 'sicore_tax_code')::int, v_rl ->> 'sicore_regime_code',
      coalesce(v_agentsnap, '{}'::jsonb) || jsonb_build_object('agent_number', v_rl ->> 'agent_number'),
      v_subjsnap);
  end loop;

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
                                          'on_account', v_net + v_whtot - v_alloc, 'method', v_method,
                                          'agent_retentions', v_agent));
  if v_agent and jsonb_array_length(v_issued) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'tax_withholdings', v_pay, 'tax_withholdings_issued',
            jsonb_build_object('payment', v_label, 'supplier_id', v_sup.id, 'retentions', v_issued,
                               'total', (v_calc ->> 'total')::numeric));
  end if;
  return v_pay;
end;
$function$;

