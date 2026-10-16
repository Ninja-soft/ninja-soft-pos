-- =============================================================================
-- 20261231100200_nubceo_contabilidad  (F23 · H153, ADR-162)
--
-- NubCeo dentro de la Contabilidad, con una sola fuente para los asientos de
-- liquidación (T3, T9):
--
--   A) Elegir la fuente (acc_settlement_source_set): 'ninjapos' (por defecto:
--      acc_sync_settlement_line desde la conciliación propia; los asientos de
--      NubCeo se ven como control) o 'nubceo' (los asientos de liquidación que
--      devuelve NubCeo entran al Diario y la conciliación propia no arma
--      nada). Vale desde el primer día de un mes abierto, sin meses cerrados
--      después; al cambiar se dan de baja los asientos de liquidación de los
--      dos orígenes desde esa fecha y se rehacen por lotes
--      (acc_settlement_source_resync). Auditado.
--      SUPUESTO (el dueño no respondió §9 de 46-tesoreria.md): todos los
--      negocios quedan en NinjaPOS; NubCeo es opcional y lo elige el dueño.
--   B) Tabla de equivalencias nubceo_account_map: código (y subcuenta) de
--      NubCeo → cuenta imputable de nuestro plan. nubceo_account_map_set
--      (auditada) y nubceo_ledger_accounts (cuentas que trajo NubCeo, con o
--      sin equivalencia).
--   C) acc_sync_nubceo_ledger: cada asiento de NubCeo de categoría
--      'settlement' entra al Diario como source_type = 'nubceo_ledger' (uno
--      por cabecera, por estado: si NubCeo lo cambia o lo borra, contra-asiento)
--      sólo con la fuente NubCeo a esa fecha, todas sus cuentas con
--      equivalencia y debe = haber. Si no, queda en Contabilidad > Resumen
--      (acc_issues) con el motivo. Signo: importe positivo = Debe (supuesto,
--      §9 pregunta 2).
--   D) Estado de conciliación de NubCeo por venta: nubceo_sync.reconciled_*;
--      lo escribe la Edge nubceo_sync (acción reconciliation_pull y una vuelta
--      diaria) con nubceo_reconciliation_apply (service_role).
--
-- Redefinidas a partir de su definición VIVA en producción (ADR-158
-- aplicado): acc_sync, acc_generate, nubceo_any_due. NO toca create_sale ni
-- ml_ingest_pack.
-- Seguridad: tenant_id + RLS initplan; staff sólo internal_scope().
-- =============================================================================

-- -----------------------------------------------------------------------------
-- B) Equivalencias de cuentas.
-- -----------------------------------------------------------------------------
create table if not exists nubceo_account_map (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  nubceo_code     text not null check (char_length(nubceo_code) between 1 and 100),
  nubceo_subcode  text not null default '' check (char_length(nubceo_subcode) <= 100),
  nubceo_name     text check (nubceo_name is null or char_length(nubceo_name) <= 200),
  account_id      uuid not null references acc_accounts(id),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid(),
  deleted_at      timestamptz,
  deleted_by      uuid
);
comment on table nubceo_account_map is
  'ADR-162 (H153): equivalencia de una cuenta (y subcuenta; vacía = cualquiera) de NubCeo con una cuenta imputable del plan del negocio. Escritura por nubceo_account_map_set.';
create unique index if not exists nubceo_account_map_uidx
  on nubceo_account_map(tenant_id, nubceo_code, nubceo_subcode) where deleted_at is null;
create index if not exists nubceo_account_map_account_idx on nubceo_account_map(account_id);

alter table nubceo_account_map enable row level security;
drop policy if exists nubceo_account_map_select on nubceo_account_map;
create policy nubceo_account_map_select on nubceo_account_map
  for select using ((tenant_id = (select current_tenant_id()) and (select nubceo_can_view()))
                    or (select internal_scope()));
revoke insert, update, delete on nubceo_account_map from anon, authenticated;
grant select on nubceo_account_map to authenticated;

-- Cuenta de nuestro plan para una cuenta de NubCeo (la de la subcuenta exacta
-- primero, después la de la cuenta con cualquier subcuenta).
create or replace function nubceo_account_for(p_tenant uuid, p_code text, p_subcode text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.account_id
    from nubceo_account_map m
    join acc_accounts a on a.id = m.account_id and a.deleted_at is null and a.imputable and a.is_active
   where m.tenant_id = p_tenant and m.deleted_at is null
     and m.nubceo_code = btrim(coalesce(p_code, ''))
     and m.nubceo_subcode in (btrim(coalesce(p_subcode, '')), '')
   order by (m.nubceo_subcode = '') asc
   limit 1;
$$;
revoke all on function nubceo_account_for(uuid, text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Asiento de NubCeo al Diario.
-- -----------------------------------------------------------------------------
create or replace function acc_sync_nubceo_ledger(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  h        nubceo_ledger_headers%rowtype;
  cfg      acc_settings%rowtype;
  e        record;
  v_acc    uuid;
  v_lines  jsonb := '[]'::jsonb;
  v_sum    numeric := 0;
  v_active boolean;
  v_missing text;
begin
  select * into h from nubceo_ledger_headers where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_active := coalesce(h.category, '') = 'settlement' and not h.deleted_in_nubceo
              and h.entry_date >= cfg.start_date and upper(coalesce(h.currency, 'ARS')) = 'ARS'
              and acc_settlement_source_at(p_tenant, h.entry_date) = 'nubceo';
  if v_active then
    for e in
      select * from nubceo_ledger_entries where header_id = h.id and tenant_id = p_tenant order by position
    loop
      continue when coalesce(e.amount, 0) = 0;
      v_acc := nubceo_account_for(p_tenant, e.account_code, e.subaccount_code);
      if v_acc is null then
        v_missing := coalesce(v_missing || ', ', '')
                     || coalesce(nullif(btrim(e.account_code), ''), '?')
                     || coalesce('/' || nullif(btrim(e.subaccount_code), ''), '')
                     || coalesce(' ' || nullif(btrim(e.account_name), ''), '');
        continue;
      end if;
      -- Supuesto (ADR-162): importe positivo = Debe.
      v_lines := v_lines || acc_line(v_acc, e.amount,
                                     left(coalesce(nullif(btrim(e.account_name), ''), e.account_code), 300));
      v_sum := v_sum + round(e.amount, 2);
    end loop;
    if v_missing is not null then
      raise exception 'nubceo_account_unmapped: %', left(v_missing, 400);
    end if;
    if round(v_sum, 2) <> 0 then
      raise exception 'nubceo_entry_unbalanced: diferencia %', round(v_sum, 2);
    end if;
  end if;
  perform acc_post_state(p_tenant, 'nubceo_ledger', h.id, 'import', v_active, h.entry_date,
                         'NubCeo · liquidación' || coalesce(' N° ' || nullif(btrim(h.number), ''), ''),
                         null, v_lines);
end;
$$;

drop trigger if exists acc_nubceo_ledger_headers_sync on nubceo_ledger_headers;
create constraint trigger acc_nubceo_ledger_headers_sync
  after insert or update on nubceo_ledger_headers
  deferrable initially deferred
  for each row
  execute function acc_source_trg('nubceo_ledger');

-- Despachador (definición viva de ADR-158 + NubCeo).
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
    when 'treasury_account' then perform acc_sync_treasury_opening(p_tenant, p_id, p_refresh);
    when 'cheque' then perform acc_sync_cheque(p_tenant, p_id);
    when 'settlement_line' then perform acc_sync_settlement_line(p_tenant, p_id);
    when 'payment_dispute' then perform acc_sync_payment_dispute(p_tenant, p_id);
    when 'tax_suffered' then perform acc_sync_tax_suffered(p_tenant, p_id, p_refresh);
    when 'iibb_liquidation' then perform acc_sync_iibb_liquidation(p_tenant, p_id);
    when 'nubceo_ledger' then perform acc_sync_nubceo_ledger(p_tenant, p_id);
    else raise exception 'acc_source_unknown: %', p_type;
  end case;
end;
$$;

-- acc_generate: definición viva (ADR-158). Cambios: las líneas de liquidación
-- se listan aunque ya no estén vinculadas si tienen asientos (para rehacerlas
-- por estado) y se suman los asientos de NubCeo.
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

  create temporary table if not exists acc_gen_docs (ord int, t text, id uuid) on commit drop;
  truncate acc_gen_docs;
  insert into acc_gen_docs (ord, t, id)
    select 1, 'sale', id from sales
     where tenant_id = v_tenant and status <> 'suspended'
       and ((created_at >= v_from and created_at < v_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 2, 'sale_return', id from sale_returns
     where tenant_id = v_tenant and created_at >= v_from and created_at < v_to
    union all
    select 3, 'cc_movement', id from customer_account_movements
     where tenant_id = v_tenant
       and (kind in ('payment', 'interest', 'interest_waiver', 'adjust_debit', 'adjust_credit')
            or (kind = 'charge' and sale_id is null))
       and ((created_at >= v_from and created_at < v_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 4, 'cash_shift', id from cash_shifts
     where tenant_id = v_tenant and status = 'closed' and closed_at >= v_from and closed_at < v_to
    union all
    select 5, 'cash_movement', cm.id from cash_movements cm
     where cm.tenant_id = v_tenant and cm.created_at >= v_from and cm.created_at < v_to
       and ((cm.type in ('income', 'expense') and cm.reference_id is null)
            or (cm.type in ('income', 'expense', 'deposit_in', 'deposit_out')
                and exists (select 1 from appointment_deposits d where d.id = cm.reference_id and d.tenant_id = v_tenant)))
    union all
    select 6, 'supplier_invoice', id from supplier_invoices
     where tenant_id = v_tenant
       and ((issue_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 7, 'supplier_payment', id from supplier_payments
     where tenant_id = v_tenant
       and ((paid_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 8, 'treasury_account', id from treasury_accounts
     where tenant_id = v_tenant and kind in ('cash', 'bank', 'wallet') and opening_balance <> 0
       and opening_date between p_from and p_to
    union all
    select 9, 'cheque', id from cheques
     where tenant_id = v_tenant
       and ((created_at >= v_from and created_at < v_to) or (rejected_at between p_from and p_to))
    union all
    select 10, 'treasury_movement', id from treasury_movements
     where tenant_id = v_tenant and treasury_movement_has_own_entry(type)
       and ((movement_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 11, 'settlement_line', sl.id from settlement_lines sl
     where sl.tenant_id = v_tenant and sl.kind = 'payment'
       and (sl.payment_id is not null
            or exists (select 1 from acc_entries e where e.tenant_id = v_tenant and e.source_type = 'settlement_line'
                                                    and e.source_id = sl.id and e.deleted_at is null))
       and coalesce(sl.release_date, sl.operation_at) >= v_from and coalesce(sl.release_date, sl.operation_at) < v_to
    union all
    select 12, 'payment_dispute', id from payment_disputes
     where tenant_id = v_tenant and origin = 'provider'
       and coalesce(resolved_at, last_seen_at, occurred_at) >= v_from
       and coalesce(resolved_at, last_seen_at, occurred_at) < v_to
    union all
    select 12, 'nubceo_ledger', id from nubceo_ledger_headers
     where tenant_id = v_tenant and entry_date between p_from and p_to
    -- Después de sus documentos (la reclasificación necesita el asiento del
    -- documento vinculado).
    union all
    select 13, 'tax_suffered', id from tax_suffered_entries
     where tenant_id = v_tenant
       and ((operation_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 14, 'iibb_liquidation', id from iibb_liquidations
     where tenant_id = v_tenant
       and (((period + interval '1 month' - interval '1 day')::date between p_from and p_to)
            or (voided_at >= v_from and voided_at < v_to));

  if p_regenerate then
    with del as (
      update acc_entries e
         set deleted_at = now(), deleted_by = auth.uid(), delete_reason = 'Regeneración del período'
        from acc_gen_docs d
       where e.tenant_id = v_tenant and e.kind = 'auto' and e.deleted_at is null
         and e.source_type = d.t and e.source_id = d.id
         and not acc_period_is_closed(v_tenant, e.entry_date)
      returning 1
    )
    select count(*) into v_deleted from del;
  end if;

  select count(*) into v_before from acc_entries where tenant_id = v_tenant and deleted_at is null;

  for r in select t, id from acc_gen_docs order by ord loop
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

-- Reintentar los asientos de NubCeo que quedaron con problema (después de
-- cargar una equivalencia).
create or replace function _nubceo_ledger_retry(p_tenant uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r   record;
  v_n int := 0;
begin
  for r in
    select i.source_id from acc_issues i
     where i.tenant_id = p_tenant and i.source_type = 'nubceo_ledger' and i.resolved_at is null
     order by i.event_date
     limit 2000
  loop
    if acc_sync_safe(p_tenant, 'nubceo_ledger', r.source_id) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function _nubceo_ledger_retry(uuid) from public, anon, authenticated;

-- Guardar (o borrar con p_account null) una equivalencia. Reintenta los
-- asientos de NubCeo que estaban esperando cuentas.
create or replace function nubceo_account_map_set(p_code text, p_subcode text, p_account uuid, p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_code   text := btrim(coalesce(p_code, ''));
  v_sub    text := btrim(coalesce(p_subcode, ''));
  v_prev   nubceo_account_map%rowtype;
  v_retry  int := 0;
begin
  if v_code = '' or char_length(v_code) > 100 or char_length(v_sub) > 100 then
    raise exception 'invalid_code';
  end if;
  if p_account is not null and not exists (
    select 1 from acc_accounts a
     where a.id = p_account and a.tenant_id = v_tenant and a.deleted_at is null and a.imputable and a.is_active) then
    raise exception 'acc_account_not_imputable';
  end if;
  select * into v_prev from nubceo_account_map
   where tenant_id = v_tenant and nubceo_code = v_code and nubceo_subcode = v_sub and deleted_at is null;
  if v_prev.id is not null and p_account is not null and v_prev.account_id = p_account then
    return jsonb_build_object('id', v_prev.id, 'retried', 0);
  end if;
  if v_prev.id is not null then
    update nubceo_account_map set deleted_at = now(), deleted_by = auth.uid() where id = v_prev.id;
  end if;
  if p_account is not null then
    insert into nubceo_account_map (tenant_id, nubceo_code, nubceo_subcode, nubceo_name, account_id)
    values (v_tenant, v_code, v_sub, left(nullif(btrim(coalesce(p_name, '')), ''), 200), p_account);
    v_retry := _nubceo_ledger_retry(v_tenant);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'nubceo_account_map', v_prev.id,
          case when p_account is null then 'nubceo_account_unmapped' else 'nubceo_account_mapped' end,
          case when v_prev.id is not null then jsonb_build_object('account_id', v_prev.account_id) end,
          jsonb_build_object('code', v_code, 'subcode', v_sub, 'account_id', p_account, 'retried', v_retry));
  return jsonb_build_object('retried', v_retry);
end;
$$;
revoke all on function nubceo_account_map_set(text, text, uuid, text) from public, anon;
grant execute on function nubceo_account_map_set(text, text, uuid, text) to authenticated;

-- Cuentas que usan los asientos de liquidación de NubCeo, con su equivalencia.
create or replace function nubceo_ledger_accounts()
returns table (nubceo_code text, nubceo_subcode text, nubceo_name text, entries int, amount numeric,
               account_id uuid, account_code text, account_name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(false);
begin
  return query
    with used as (
      select btrim(coalesce(e.account_code, '')) as c, btrim(coalesce(e.subaccount_code, '')) as sc,
             max(coalesce(nullif(btrim(e.subaccount_name), ''), e.account_name)) as nm,
             count(*)::int as n, round(sum(abs(e.amount)), 2) as amt
        from nubceo_ledger_entries e
        join nubceo_ledger_headers h on h.id = e.header_id
       where e.tenant_id = v_tenant and coalesce(h.category, '') = 'settlement' and not h.deleted_in_nubceo
       group by 1, 2
    )
    select u.c, u.sc, u.nm, u.n, u.amt, a.id, a.code, a.name
      from used u
      left join acc_accounts a on a.id = nubceo_account_for(v_tenant, u.c, u.sc)
     where u.c <> ''
     order by (a.id is null) desc, u.c, u.sc;
end;
$$;
revoke all on function nubceo_ledger_accounts() from public, anon;
grant execute on function nubceo_ledger_accounts() to authenticated;

-- -----------------------------------------------------------------------------
-- A) Elegir la fuente de los asientos de liquidación.
-- -----------------------------------------------------------------------------
create or replace function acc_settlement_source_resync(p_offset int default 0)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  cfg      acc_settings%rowtype;
  v_batch  constant int := 1500;
  v_n      int := 0;
  v_failed int := 0;
  r        record;
begin
  select * into cfg from acc_settings where tenant_id = v_tenant;
  if not found then
    raise exception 'acc_not_setup';
  end if;
  if cfg.settlement_source_from is null then
    return jsonb_build_object('processed', 0, 'failed', 0, 'more', false);
  end if;
  for r in
    select t, id from (
      select 'settlement_line'::text as t, sl.id, coalesce(sl.release_date, sl.operation_at) as at
        from settlement_lines sl
       where sl.tenant_id = v_tenant and sl.kind = 'payment' and sl.payment_id is not null and sl.released
         and coalesce(sl.release_date, sl.operation_at) >= acc_ar_start(cfg.settlement_source_from)
      union all
      select 'nubceo_ledger', h.id, acc_ar_start(h.entry_date)
        from nubceo_ledger_headers h
       where h.tenant_id = v_tenant and h.entry_date >= cfg.settlement_source_from
    ) d
     order by at, id
     offset greatest(coalesce(p_offset, 0), 0)
     limit v_batch
  loop
    v_n := v_n + 1;
    if not acc_sync_safe(v_tenant, r.t, r.id) then
      v_failed := v_failed + 1;
    end if;
  end loop;
  return jsonb_build_object('processed', v_n, 'failed', v_failed, 'more', v_n = v_batch,
                            'next_offset', greatest(coalesce(p_offset, 0), 0) + v_n);
end;
$$;
revoke all on function acc_settlement_source_resync(int) from public, anon;
grant execute on function acc_settlement_source_resync(int) to authenticated;

create or replace function acc_settlement_source_set(p_source text, p_from date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := acc_assert();
  cfg       acc_settings%rowtype;
  v_from    date := (date_trunc('month', p_from::timestamp))::date;
  v_before  text;
  v_deleted int := 0;
begin
  if p_source not in ('ninjapos', 'nubceo') then
    raise exception 'invalid_source';
  end if;
  select * into cfg from acc_settings where tenant_id = v_tenant for update;
  if not found then
    raise exception 'acc_not_setup';
  end if;
  if p_from is null or p_from <> v_from then
    raise exception 'acc_source_from_not_month_start';
  end if;
  if p_source = 'nubceo' and not tenant_has_feature_for(v_tenant, 'integracion_nubceo') then
    raise exception 'feature_not_in_plan: integracion_nubceo';
  end if;
  if exists (select 1 from acc_periods p
              where p.tenant_id = v_tenant and p.status = 'closed' and p.period >= v_from) then
    raise exception 'acc_period_closed: %', to_char(v_from, 'MM/YYYY');
  end if;
  if acc_settlement_source_at(v_tenant, v_from) = p_source
     and (cfg.settlement_source_from is null or cfg.settlement_source_from <= v_from) then
    return jsonb_build_object('changed', false, 'source', p_source, 'from', v_from);
  end if;
  v_before := acc_settlement_source_at(v_tenant, v_from - 1);

  update acc_settings
     set settlement_source = p_source, settlement_source_from = v_from, settlement_source_before = v_before,
         updated_at = now(), updated_by = auth.uid()
   where tenant_id = v_tenant;

  -- Desde esa fecha, nada de los dos orígenes queda en el Diario: el resync
  -- rearma lo que corresponde a la fuente nueva.
  with del as (
    update acc_entries e
       set deleted_at = now(), deleted_by = auth.uid(), delete_reason = 'Cambio de la fuente de los asientos de liquidación'
     where e.tenant_id = v_tenant and e.kind = 'auto' and e.deleted_at is null
       and e.source_type in ('settlement_line', 'nubceo_ledger')
       and e.entry_date >= v_from
       and not acc_period_is_closed(v_tenant, e.entry_date)
    returning 1
  )
  select count(*) into v_deleted from del;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'acc_settings', null, 'acc_settlement_source_changed',
          jsonb_build_object('source', cfg.settlement_source, 'from', cfg.settlement_source_from,
                             'before', cfg.settlement_source_before),
          jsonb_build_object('source', p_source, 'from', v_from, 'before', v_before, 'deleted_entries', v_deleted));
  return jsonb_build_object('changed', true, 'source', p_source, 'from', v_from, 'deleted_entries', v_deleted)
         || acc_settlement_source_resync(0);
end;
$$;
revoke all on function acc_settlement_source_set(text, date) from public, anon;
grant execute on function acc_settlement_source_set(text, date) to authenticated;

-- Lectura de la configuración de la fuente (para la pantalla de Mapeos).
create or replace function acc_settlement_source_info()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  cfg      acc_settings%rowtype;
begin
  if v_tenant is null or not acc_can_read() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into cfg from acc_settings where tenant_id = v_tenant;
  return jsonb_build_object(
    'source', coalesce(cfg.settlement_source, 'ninjapos'),
    'from', cfg.settlement_source_from,
    'before', coalesce(cfg.settlement_source_before, 'ninjapos'),
    'nubceo_feature', tenant_has_feature_for(v_tenant, 'integracion_nubceo'),
    'nubceo_configured', exists (select 1 from nubceo_settings s where s.tenant_id = v_tenant),
    'first_open_month', (select coalesce(
        (select (max(p.period) + interval '1 month')::date from acc_periods p
          where p.tenant_id = v_tenant and p.status = 'closed'),
        (date_trunc('month', coalesce(cfg.start_date, acc_ar_date(now()))::timestamp))::date)),
    'nubceo_headers', (select count(*) from nubceo_ledger_headers h
                        where h.tenant_id = v_tenant and coalesce(h.category, '') = 'settlement'),
    'nubceo_in_journal', (select count(*) from acc_entries e
                           where e.tenant_id = v_tenant and e.source_type = 'nubceo_ledger' and e.deleted_at is null
                             and e.reversal_of is null),
    'nubceo_issues', (select count(*) from acc_issues i
                       where i.tenant_id = v_tenant and i.source_type = 'nubceo_ledger'
                         and i.resolved_at is null and i.dismissed_at is null));
end;
$$;
revoke all on function acc_settlement_source_info() from public, anon;
grant execute on function acc_settlement_source_info() to authenticated;

-- -----------------------------------------------------------------------------
-- D) Estado de conciliación de NubCeo por venta.
-- -----------------------------------------------------------------------------
alter table nubceo_sync add column if not exists reconciled_status text;
alter table nubceo_sync add column if not exists reconciled_at timestamptz;
alter table nubceo_sync add column if not exists reconciled_checked_at timestamptz;
alter table nubceo_sync add column if not exists reconciled_detail jsonb;
alter table nubceo_sync drop constraint if exists nubceo_sync_reconciled_status_check;
alter table nubceo_sync add constraint nubceo_sync_reconciled_status_check
  check (reconciled_status is null or reconciled_status in ('reconciled', 'pending', 'difference'));
create index if not exists nubceo_sync_venta_idx on nubceo_sync(tenant_id, venta_id);
comment on column nubceo_sync.reconciled_status is
  'ADR-162 (H153): lo que NubCeo dice de la venta enviada: reconciled (conciliada), pending, difference (con diferencia). Lo escribe la Edge nubceo_sync.';

alter table nubceo_settings add column if not exists reconciliation_last_pull_at timestamptz;
alter table nubceo_settings add column if not exists reconciliation_last_message text;

-- p_rows: [{venta_id, status: reconciled|pending|difference, reconciled_at?, detail?}]
create or replace function nubceo_reconciliation_apply(p_tenant uuid, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'invalid_rows';
  end if;
  with src as (
    select left(r ->> 'venta_id', 200) as venta_id,
           case when r ->> 'status' in ('reconciled', 'pending', 'difference') then r ->> 'status' end as status,
           case when coalesce(r ->> 'reconciled_at', '') ~ '^\d{4}-\d{2}-\d{2}' then (r ->> 'reconciled_at')::timestamptz end as at,
           case when jsonb_typeof(r -> 'detail') = 'object' then r -> 'detail' end as detail
      from jsonb_array_elements(p_rows) r
  ), upd as (
    update nubceo_sync s
       set reconciled_status = src.status, reconciled_at = src.at, reconciled_detail = src.detail,
           reconciled_checked_at = now(), updated_at = now()
      from src
     where s.tenant_id = p_tenant and s.venta_id = src.venta_id and src.status is not null
       and (s.reconciled_status is distinct from src.status or s.reconciled_at is distinct from src.at
            or s.reconciled_detail is distinct from src.detail)
    returning 1
  )
  select count(*) into v_n from upd;
  return v_n;
end;
$$;
revoke all on function nubceo_reconciliation_apply(uuid, jsonb) from public, anon, authenticated;
grant execute on function nubceo_reconciliation_apply(uuid, jsonb) to service_role;

-- Negocios para la vuelta diaria del estado de conciliación.
create or replace function nubceo_reconciliation_due(p_limit int default 5)
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.tenant_id from nubceo_settings s
   where s.enabled and not s.simulate
     and tenant_has_feature_for(s.tenant_id, 'integracion_nubceo')
     and (s.reconciliation_last_pull_at is null or s.reconciliation_last_pull_at < now() - interval '20 hours')
   order by s.reconciliation_last_pull_at nulls first
   limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;
revoke all on function nubceo_reconciliation_due(int) from public, anon, authenticated;
grant execute on function nubceo_reconciliation_due(int) to service_role;

-- nubceo_any_due (definición viva) + la vuelta diaria del estado de
-- conciliación: sin esto el cron no llama a la Edge si no hay envíos.
create or replace function nubceo_any_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from nubceo_settings s
     where (s.paused_until is null or s.paused_until <= now())
       and ((s.enabled and coalesce(s.next_run_at, '-infinity') <= now())
            or (s.ledger_auto and coalesce(s.ledger_last_import_at, '-infinity') <= now() - interval '6 hours')
            or (s.enabled and not s.simulate
                and coalesce(s.reconciliation_last_pull_at, '-infinity') < now() - interval '20 hours')));
$$;

-- Resumen por estado (para la pantalla de NubCeo).
create or replace function nubceo_reconciliation_counts(p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(false);
begin
  return (
    select jsonb_build_object(
             'reconciled', count(*) filter (where s.reconciled_status = 'reconciled'),
             'pending', count(*) filter (where s.reconciled_status = 'pending'),
             'difference', count(*) filter (where s.reconciled_status = 'difference'),
             'unknown', count(*) filter (where s.reconciled_status is null),
             'last_pull', (select n.reconciliation_last_pull_at from nubceo_settings n where n.tenant_id = v_tenant))
      from nubceo_sync s
     where s.tenant_id = v_tenant and s.status = 'synced' and s.kind = 'sale'
       and (p_from is null or s.sale_date >= p_from) and (p_to is null or s.sale_date < p_to));
end;
$$;
revoke all on function nubceo_reconciliation_counts(timestamptz, timestamptz) from public, anon;
grant execute on function nubceo_reconciliation_counts(timestamptz, timestamptz) to authenticated;
