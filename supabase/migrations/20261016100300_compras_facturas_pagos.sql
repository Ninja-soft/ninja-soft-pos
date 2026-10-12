-- =============================================================================
-- 20261016100300_compras_facturas_pagos  (F18 · H101, ADR-050)
--
-- Comprobantes de compra (factura, nota de débito y nota de crédito del
-- proveedor), pagos a proveedores y cuenta corriente de proveedores.
--
-- • Comprobante: letra A / B / C / M / E, punto de venta + número, fecha,
--   vencimiento, neto por alícuota de IVA (vat_lines), exento, no gravado,
--   percepciones y otros tributos como líneas libres (other_taxes), total.
--   B y C no discriminan IVA. Se vincula a una o más recepciones (control de
--   dos vías: comprobante contra remito; la tercera vía, contra la OC, sale de
--   la recepción).
-- • Pago: medio, referencia, moneda y tipo de cambio, retenciones practicadas
--   como líneas libres (placeholder hasta H106). Cancela deuda por el importe
--   bruto (neto pagado + retenciones).
-- • Cuenta corriente: vistas con security_invoker (respetan la RLS). El saldo
--   va en pesos al tipo de cambio de cada comprobante; la diferencia de cambio
--   contable queda para H109. El aging (FIFO por vencimiento) es lógica pura en
--   lib/purchases/aging.ts.
-- • Anulación con motivo (nunca DELETE): el comprobante o pago queda 'voided'
--   y deja de contar.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Comprobantes de proveedor.
-- -----------------------------------------------------------------------------
create table if not exists supplier_invoices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  supplier_id       uuid not null references suppliers(id),
  kind              text not null default 'invoice' check (kind in ('invoice','debit_note','credit_note')),
  letter            text not null check (letter in ('A','B','C','M','E')),
  point_of_sale     int not null check (point_of_sale between 1 and 99999),
  number            bigint not null check (number between 1 and 99999999),
  issue_date        date not null,
  due_date          date,
  currency          text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  fx_rate           numeric(14,6) not null default 1 check (fx_rate > 0),
  vat_lines         jsonb not null default '[]'::jsonb check (jsonb_typeof(vat_lines) = 'array'),
  other_taxes       jsonb not null default '[]'::jsonb check (jsonb_typeof(other_taxes) = 'array'),
  net_total         numeric(14,2) not null default 0 check (net_total >= 0),
  vat_total         numeric(14,2) not null default 0 check (vat_total >= 0),
  exempt_amount     numeric(14,2) not null default 0 check (exempt_amount >= 0),
  non_taxed_amount  numeric(14,2) not null default 0 check (non_taxed_amount >= 0),
  other_taxes_total numeric(14,2) not null default 0 check (other_taxes_total >= 0),
  total             numeric(14,2) not null check (total > 0),
  order_id          uuid references purchase_orders(id),
  notes             text check (notes is null or char_length(notes) <= 1000),
  status            text not null default 'posted' check (status in ('posted','voided')),
  void_reason       text,
  voided_at         timestamptz,
  voided_by         uuid,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint supplier_invoices_due_after_issue check (due_date is null or due_date >= issue_date)
);

comment on table supplier_invoices is
  'Comprobantes de compra (F18/H101, ADR-050): factura, nota de débito y nota de crédito del proveedor.';
comment on column supplier_invoices.vat_lines is '[{rate, net, vat}] neto gravado e IVA por alícuota (sólo A y M).';
comment on column supplier_invoices.other_taxes is
  '[{kind, description, jurisdiction?, amount}] percepciones de IVA, IIBB, impuestos internos y otros tributos.';

create unique index if not exists supplier_invoices_doc_key
  on supplier_invoices(tenant_id, supplier_id, kind, letter, point_of_sale, number)
  where status = 'posted';
create index if not exists supplier_invoices_tenant_idx on supplier_invoices(tenant_id, issue_date desc);
create index if not exists supplier_invoices_supplier_idx on supplier_invoices(supplier_id, issue_date);

drop trigger if exists set_updated_at_supplier_invoices on supplier_invoices;
create trigger set_updated_at_supplier_invoices
  before update on supplier_invoices
  for each row execute function set_updated_at();

alter table goods_receipts add column if not exists invoice_id uuid references supplier_invoices(id);
create index if not exists goods_receipts_invoice_idx on goods_receipts(invoice_id);

-- -----------------------------------------------------------------------------
-- B) Pagos a proveedores.
-- -----------------------------------------------------------------------------
create table if not exists supplier_payments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  number             int not null,
  supplier_id        uuid not null references suppliers(id),
  paid_date          date not null default current_date,
  method             text not null check (method in ('efectivo','transferencia','cheque','echeq',
                                                     'tarjeta','deposito','otro')),
  reference          text check (reference is null or char_length(reference) <= 120),
  currency           text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  fx_rate            numeric(14,6) not null default 1 check (fx_rate > 0),
  amount             numeric(14,2) not null check (amount > 0),
  withholdings       jsonb not null default '[]'::jsonb check (jsonb_typeof(withholdings) = 'array'),
  withholdings_total numeric(14,2) not null default 0 check (withholdings_total >= 0),
  net_paid           numeric(14,2) not null check (net_paid >= 0),
  notes              text check (notes is null or char_length(notes) <= 1000),
  status             text not null default 'posted' check (status in ('posted','voided')),
  void_reason        text,
  voided_at          timestamptz,
  voided_by          uuid,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint supplier_payments_tenant_number_key unique (tenant_id, number),
  constraint supplier_payments_net check (net_paid + withholdings_total = amount)
);

comment on column supplier_payments.amount is 'Deuda cancelada (neto pagado + retenciones) en la moneda del pago.';
comment on column supplier_payments.withholdings is
  '[{kind, description?, certificate?, amount}] retenciones practicadas (placeholder hasta F18/H106).';

create index if not exists supplier_payments_tenant_idx on supplier_payments(tenant_id, paid_date desc);
create index if not exists supplier_payments_supplier_idx on supplier_payments(supplier_id, paid_date);

drop trigger if exists set_updated_at_supplier_payments on supplier_payments;
create trigger set_updated_at_supplier_payments
  before update on supplier_payments
  for each row execute function set_updated_at();

alter table supplier_invoices enable row level security;
alter table supplier_payments enable row level security;

drop policy if exists supplier_invoices_select on supplier_invoices;
create policy supplier_invoices_select on supplier_invoices
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists supplier_payments_select on supplier_payments;
create policy supplier_payments_select on supplier_payments
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- -----------------------------------------------------------------------------
-- C) RPC: comprobante (alta y edición).
--    p: {supplier_id, kind, letter, point_of_sale, number, issue_date,
--        due_date?, currency?, fx_rate?, vat_lines: [{rate, net, vat}],
--        exempt_amount?, non_taxed_amount?, other_taxes: [{kind, description,
--        jurisdiction?, amount}], total, order_id?, notes?}
--    p_receipt_ids: recepciones que factura (del mismo proveedor).
-- -----------------------------------------------------------------------------
create or replace function supplier_invoice_save(p_id uuid, p jsonb, p_receipt_ids uuid[] default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := purchase_assert(true);
  v_sup      suppliers;
  v_before   supplier_invoices;
  v_inv      supplier_invoices;
  v_letter   text := upper(coalesce(p ->> 'letter', ''));
  v_kind     text := coalesce(p ->> 'kind', 'invoice');
  v_cur      text := upper(coalesce(nullif(p ->> 'currency', ''), 'ARS'));
  v_fx       numeric;
  v_issue    date := (p ->> 'issue_date')::date;
  v_due      date;
  v_net      numeric := 0;
  v_vat      numeric := 0;
  v_other    numeric := 0;
  v_exempt   numeric := round(coalesce((p ->> 'exempt_amount')::numeric, 0), 2);
  v_nontax   numeric := round(coalesce((p ->> 'non_taxed_amount')::numeric, 0), 2);
  v_total    numeric := round(coalesce((p ->> 'total')::numeric, 0), 2);
  v_vatlines jsonb := coalesce(p -> 'vat_lines', '[]'::jsonb);
  v_others   jsonb := coalesce(p -> 'other_taxes', '[]'::jsonb);
  v_line     record;
begin
  select * into v_sup from suppliers
   where id = (p ->> 'supplier_id')::uuid and tenant_id = v_tenant and deleted_at is null;
  if v_sup.id is null then
    raise exception 'supplier_not_found';
  end if;
  if v_issue is null then
    raise exception 'issue_date_required';
  end if;
  v_due := coalesce((nullif(p ->> 'due_date', ''))::date, v_issue + v_sup.payment_terms_days);
  v_fx := case when v_cur = 'ARS' then 1 else coalesce((p ->> 'fx_rate')::numeric, 0) end;
  if v_fx <= 0 then
    raise exception 'invalid_fx_rate';
  end if;
  if jsonb_typeof(v_vatlines) <> 'array' or jsonb_typeof(v_others) <> 'array' then
    raise exception 'invalid_lines';
  end if;

  for v_line in
    select x.rate, x.net, x.vat from jsonb_to_recordset(v_vatlines) as x(rate numeric, net numeric, vat numeric)
  loop
    if v_line.rate is null or v_line.rate not in (0, 2.5, 5, 10.5, 21, 27) then
      raise exception 'invalid_vat_rate';
    end if;
    if coalesce(v_line.net, 0) < 0 or coalesce(v_line.vat, 0) < 0 then
      raise exception 'invalid_amount';
    end if;
    v_net := v_net + round(coalesce(v_line.net, 0), 2);
    v_vat := v_vat + round(coalesce(v_line.vat, 0), 2);
  end loop;
  for v_line in
    select x.amount from jsonb_to_recordset(v_others) as x(amount numeric)
  loop
    if coalesce(v_line.amount, 0) < 0 then
      raise exception 'invalid_amount';
    end if;
    v_other := v_other + round(coalesce(v_line.amount, 0), 2);
  end loop;

  -- B y C no discriminan IVA: el importe va como neto.
  if v_letter in ('B', 'C') and v_vat > 0 then
    raise exception 'vat_not_discriminated';
  end if;
  if abs((v_net + v_vat + v_exempt + v_nontax + v_other) - v_total) > 0.01 then
    raise exception 'total_mismatch';
  end if;

  if p_id is null then
    insert into supplier_invoices (tenant_id, supplier_id, kind, letter, point_of_sale, number, issue_date,
                                   due_date, currency, fx_rate, vat_lines, other_taxes, net_total, vat_total,
                                   exempt_amount, non_taxed_amount, other_taxes_total, total, order_id, notes,
                                   created_by)
    values (v_tenant, v_sup.id, v_kind, v_letter, (p ->> 'point_of_sale')::int, (p ->> 'number')::bigint,
            v_issue, v_due, v_cur, v_fx, v_vatlines, v_others, v_net, v_vat, v_exempt, v_nontax, v_other,
            v_total, (nullif(p ->> 'order_id', ''))::uuid, nullif(trim(coalesce(p ->> 'notes', '')), ''),
            auth.uid())
    returning * into v_inv;
  else
    select * into v_before from supplier_invoices
     where id = p_id and tenant_id = v_tenant
     for update;
    if v_before.id is null then
      raise exception 'invoice_not_found';
    end if;
    if v_before.status <> 'posted' then
      raise exception 'invoice_voided';
    end if;
    update supplier_invoices
       set supplier_id = v_sup.id, kind = v_kind, letter = v_letter,
           point_of_sale = (p ->> 'point_of_sale')::int, number = (p ->> 'number')::bigint,
           issue_date = v_issue, due_date = v_due, currency = v_cur, fx_rate = v_fx,
           vat_lines = v_vatlines, other_taxes = v_others, net_total = v_net, vat_total = v_vat,
           exempt_amount = v_exempt, non_taxed_amount = v_nontax, other_taxes_total = v_other,
           total = v_total, order_id = (nullif(p ->> 'order_id', ''))::uuid,
           notes = nullif(trim(coalesce(p ->> 'notes', '')), '')
     where id = p_id
    returning * into v_inv;
    update goods_receipts set invoice_id = null where invoice_id = v_inv.id;
  end if;

  if v_inv.order_id is not null and not exists (
    select 1 from purchase_orders where id = v_inv.order_id and tenant_id = v_tenant and supplier_id = v_sup.id
  ) then
    raise exception 'order_not_found';
  end if;

  if p_receipt_ids is not null and array_length(p_receipt_ids, 1) > 0 then
    if exists (
      select 1 from unnest(p_receipt_ids) rid
       where not exists (
         select 1 from goods_receipts g
          where g.id = rid and g.tenant_id = v_tenant and g.deleted_at is null
            and (g.supplier_id is null or g.supplier_id = v_sup.id)
            and (g.invoice_id is null or g.invoice_id = v_inv.id)
       )
    ) then
      raise exception 'receipt_not_linkable';
    end if;
    update goods_receipts
       set invoice_id = v_inv.id, supplier_id = coalesce(supplier_id, v_sup.id)
     where id = any (p_receipt_ids) and tenant_id = v_tenant;
  end if;

  perform purchase_log(v_tenant, 'invoice', v_inv.id, case when p_id is null then 'created' else 'updated' end,
                       null, 'posted', null,
                       jsonb_build_object('letter', v_letter, 'kind', v_kind, 'point_of_sale', v_inv.point_of_sale,
                                          'number', v_inv.number, 'total', v_total, 'currency', v_cur,
                                          'before', case when p_id is null then null else to_jsonb(v_before) end));
  return v_inv.id;
exception
  when unique_violation then
    raise exception 'invoice_duplicated';
end;
$$;
revoke all on function supplier_invoice_save(uuid, jsonb, uuid[]) from public, anon;
grant execute on function supplier_invoice_save(uuid, jsonb, uuid[]) to authenticated;

create or replace function supplier_invoice_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_inv    supplier_invoices;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_inv from supplier_invoices where id = p_id and tenant_id = v_tenant for update;
  if v_inv.id is null then
    raise exception 'invoice_not_found';
  end if;
  if v_inv.status <> 'posted' then
    raise exception 'invoice_voided';
  end if;
  update supplier_invoices
     set status = 'voided', void_reason = trim(p_reason), voided_at = now(), voided_by = auth.uid()
   where id = p_id;
  update goods_receipts set invoice_id = null where invoice_id = p_id;
  perform purchase_log(v_tenant, 'invoice', p_id, 'voided', 'posted', 'voided', p_reason,
                       jsonb_build_object('total', v_inv.total));
end;
$$;
revoke all on function supplier_invoice_void(uuid, text) from public, anon;
grant execute on function supplier_invoice_void(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- D) RPC: pagos.
--    p: {supplier_id, paid_date?, method, reference?, currency?, fx_rate?,
--        net_paid, withholdings: [{kind, description?, certificate?, amount}],
--        notes?}
-- -----------------------------------------------------------------------------
create or replace function supplier_payment_create(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  values (v_tenant, v_number, v_sup, coalesce((nullif(p ->> 'paid_date', ''))::date, current_date),
          coalesce(p ->> 'method', 'transferencia'), nullif(trim(coalesce(p ->> 'reference', '')), ''),
          v_cur, v_fx, v_net + v_whtot, v_wh, v_whtot, v_net,
          nullif(trim(coalesce(p ->> 'notes', '')), ''), auth.uid())
  returning id into v_id;

  perform purchase_log(v_tenant, 'payment', v_id, 'created', null, 'posted', null,
                       jsonb_build_object('number', v_number, 'supplier_id', v_sup, 'amount', v_net + v_whtot,
                                          'net_paid', v_net, 'withholdings_total', v_whtot, 'currency', v_cur));
  return v_id;
end;
$$;
revoke all on function supplier_payment_create(jsonb) from public, anon;
grant execute on function supplier_payment_create(jsonb) to authenticated;

create or replace function supplier_payment_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_pay    supplier_payments;
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
  update supplier_payments
     set status = 'voided', void_reason = trim(p_reason), voided_at = now(), voided_by = auth.uid()
   where id = p_id;
  perform purchase_log(v_tenant, 'payment', p_id, 'voided', 'posted', 'voided', p_reason,
                       jsonb_build_object('amount', v_pay.amount));
end;
$$;
revoke all on function supplier_payment_void(uuid, text) from public, anon;
grant execute on function supplier_payment_void(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Cuenta corriente (vistas con la RLS de quien consulta).
--    amount_ars > 0 = deuda con el proveedor; < 0 = pago o nota de crédito.
-- -----------------------------------------------------------------------------
create or replace view supplier_account_entries
with (security_invoker = true) as
  select i.tenant_id, i.supplier_id, i.id as doc_id,
         i.kind as entry_type,
         i.letter || ' ' || lpad(i.point_of_sale::text, 5, '0') || '-' || lpad(i.number::text, 8, '0') as doc_label,
         i.issue_date as doc_date,
         coalesce(i.due_date, i.issue_date) as due_date,
         i.currency,
         i.fx_rate,
         case when i.kind = 'credit_note' then -i.total else i.total end as amount,
         round(case when i.kind = 'credit_note' then -i.total else i.total end * i.fx_rate, 2) as amount_ars,
         i.created_at
    from supplier_invoices i
   where i.status = 'posted'
  union all
  select p.tenant_id, p.supplier_id, p.id, 'payment',
         'OP-' || lpad(p.number::text, 6, '0'),
         p.paid_date, p.paid_date, p.currency, p.fx_rate,
         -p.amount, round(-p.amount * p.fx_rate, 2), p.created_at
    from supplier_payments p
   where p.status = 'posted';

create or replace view supplier_balances
with (security_invoker = true) as
  select s.tenant_id, s.id as supplier_id,
         coalesce(sum(e.amount_ars), 0)::numeric(14,2) as balance_ars,
         coalesce(sum(e.amount_ars) filter (where e.amount_ars > 0), 0)::numeric(14,2) as debit_ars,
         coalesce(-sum(e.amount_ars) filter (where e.amount_ars < 0), 0)::numeric(14,2) as credit_ars,
         coalesce(sum(e.amount) filter (where e.currency = s.currency), 0)::numeric(14,2) as balance_currency,
         s.currency,
         min(e.due_date) filter (where e.amount_ars > 0) as oldest_due,
         max(e.doc_date) as last_movement
    from suppliers s
    left join supplier_account_entries e on e.supplier_id = s.id
   where s.deleted_at is null
   group by s.tenant_id, s.id, s.currency;

revoke all on supplier_account_entries from anon;
grant select on supplier_account_entries to authenticated;
revoke all on supplier_balances from anon;
grant select on supplier_balances to authenticated;
