-- =============================================================================
-- 20261029100300_contabilidad_libros  (ADR-066 · F18/H109)
--
-- Contabilidad v1, parte 3: libros y reportes.
--
--  A) Vista acc_journal_lines (security_invoker: hereda la RLS de las tablas)
--     para Libro Diario, Mayor, asientos y exports. Sólo asientos vigentes.
--  B) acc_trial_balance: balance de sumas y saldos por cuenta imputable con
--     saldo anterior (patrimoniales desde el inicio; resultados desde el
--     comienzo del ejercicio). El árbol y el estado de resultados se arman en
--     lib/accounting/journal.ts.
--  C) acc_vat_sales y acc_vat_purchases: resúmenes de IVA Ventas y Compras
--     con lo que hay hoy (IVA incluido por alícuota del producto; el motor de
--     impuestos de H103 los va a enriquecer cambiando acc_vat_split / la
--     fuente de alícuotas, sin tocar las pantallas).
-- =============================================================================

create or replace view acc_journal_lines
with (security_invoker = true)
as
select l.id,
       l.tenant_id,
       l.entry_id,
       e.number,
       e.official_number,
       e.entry_date,
       e.period,
       e.kind,
       e.source_type,
       e.source_id,
       e.source_event,
       e.description as entry_description,
       e.store_id,
       e.reversal_of,
       e.reversed_by,
       l.line_no,
       l.account_id,
       a.code as account_code,
       a.name as account_name,
       a.external_code as account_external_code,
       a.kind as account_kind,
       l.cost_center_id,
       c.code as cost_center_code,
       c.name as cost_center_name,
       l.debit,
       l.credit,
       l.description
  from acc_entry_lines l
  join acc_entries e on e.id = l.entry_id and e.deleted_at is null
  join acc_accounts a on a.id = l.account_id
  left join acc_cost_centers c on c.id = l.cost_center_id;

grant select on acc_journal_lines to authenticated, service_role;

create or replace function acc_fiscal_year_start(p_tenant uuid, p_date date)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select make_date(
           case when extract(month from p_date) >= coalesce(s.fiscal_year_start_month, 1)
                then extract(year from p_date)::int else extract(year from p_date)::int - 1 end,
           coalesce(s.fiscal_year_start_month, 1), 1)
    from (select 1) x
    left join acc_settings s on s.tenant_id = p_tenant;
$$;
revoke all on function acc_fiscal_year_start(uuid, date) from public, anon, authenticated;

-- Sumas y saldos. opening = saldo (debe - haber) antes de p_from.
create or replace function acc_trial_balance(p_from date, p_to date, p_store uuid default null)
returns table (
  account_id uuid,
  code text,
  name text,
  kind text,
  parent_id uuid,
  imputable boolean,
  external_code text,
  opening numeric,
  debit numeric,
  credit numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_fy date;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'acc_range_invalid';
  end if;
  v_fy := acc_fiscal_year_start(v_tenant, p_from);
  return query
  with mv as (
    select l.account_id,
           sum(case when e.entry_date < p_from
                     and (a.kind in ('activo', 'pasivo', 'patrimonio') or e.entry_date >= v_fy)
                    then l.debit - l.credit else 0 end) as opening,
           sum(case when e.entry_date between p_from and p_to then l.debit else 0 end) as debit,
           sum(case when e.entry_date between p_from and p_to then l.credit else 0 end) as credit
      from acc_entry_lines l
      join acc_entries e on e.id = l.entry_id and e.deleted_at is null
      join acc_accounts a on a.id = l.account_id
      left join acc_cost_centers c on c.id = l.cost_center_id
     where l.tenant_id = v_tenant
       and e.entry_date <= p_to
       and (p_store is null or e.store_id = p_store or c.store_id = p_store)
     group by l.account_id
  )
  select a.id, a.code, a.name, a.kind, a.parent_id, a.imputable, a.external_code,
         coalesce(mv.opening, 0)::numeric, coalesce(mv.debit, 0)::numeric, coalesce(mv.credit, 0)::numeric
    from acc_accounts a
    left join mv on mv.account_id = a.id
   where a.tenant_id = v_tenant and (a.deleted_at is null or mv.account_id is not null)
   order by a.code;
end;
$$;
revoke all on function acc_trial_balance(date, date, uuid) from public, anon;
grant execute on function acc_trial_balance(date, date, uuid) to authenticated;

-- IVA Ventas: por día, sucursal, tipo (venta, anulación, devolución) y alícuota.
create or replace function acc_vat_sales(p_from date, p_to date)
returns table (
  day date,
  store_id uuid,
  kind text,
  rate numeric,
  net numeric,
  vat numeric,
  gross numeric,
  docs bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  cfg acc_settings%rowtype;
begin
  select * into cfg from acc_settings where tenant_id = v_tenant;
  if not found then
    raise exception 'acc_not_setup';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'acc_range_invalid';
  end if;
  return query
  with docs as (
    select acc_ar_date(s.created_at) as d, s.store_id as st, 'venta'::text as k, 1 as sg, s.id as doc,
           s.total as tot,
           (select coalesce(jsonb_agg(jsonb_build_object('amount', si.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
              from sale_items si left join products pr on pr.id = si.product_id where si.sale_id = s.id) as items
      from sales s
     where s.tenant_id = v_tenant and s.status in ('completed', 'voided')
       and s.created_at >= acc_ar_start(p_from) and s.created_at < acc_ar_start(p_to + 1)
    union all
    select acc_ar_date(s.voided_at), s.store_id, 'anulacion', -1, s.id, s.total,
           (select coalesce(jsonb_agg(jsonb_build_object('amount', si.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
              from sale_items si left join products pr on pr.id = si.product_id where si.sale_id = s.id)
      from sales s
     where s.tenant_id = v_tenant and s.status = 'voided'
       and s.voided_at >= acc_ar_start(p_from) and s.voided_at < acc_ar_start(p_to + 1)
    union all
    select acc_ar_date(r.created_at), s.store_id, 'devolucion', -1, r.id, r.total,
           (select coalesce(jsonb_agg(jsonb_build_object('amount', ri.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
              from sale_return_items ri
              join sale_items si on si.id = ri.sale_item_id
              left join products pr on pr.id = si.product_id
             where ri.return_id = r.id)
      from sale_returns r join sales s on s.id = r.sale_id
     where r.tenant_id = v_tenant
       and r.created_at >= acc_ar_start(p_from) and r.created_at < acc_ar_start(p_to + 1)
  )
  select docs.d, docs.st, docs.k, v.rate,
         sum(docs.sg * v.net)::numeric, sum(docs.sg * v.vat)::numeric, sum(docs.sg * v.gross)::numeric,
         count(distinct docs.doc)
    from docs
    cross join lateral acc_vat_split(docs.tot, docs.items, cfg.vat_mode, cfg.default_vat_rate) v
   group by docs.d, docs.st, docs.k, v.rate
   order by docs.d, docs.k, v.rate desc;
end;
$$;
revoke all on function acc_vat_sales(date, date) from public, anon;
grant execute on function acc_vat_sales(date, date) to authenticated;

-- IVA Compras: un renglón por comprobante vigente, en pesos (al tipo de
-- cambio del comprobante); las notas de crédito restan.
create or replace function acc_vat_purchases(p_from date, p_to date)
returns table (
  invoice_id uuid,
  issue_date date,
  supplier_name text,
  supplier_cuit text,
  supplier_iva text,
  kind text,
  letter text,
  point_of_sale int,
  number bigint,
  vat_lines jsonb,
  net_total numeric,
  vat_total numeric,
  exempt numeric,
  non_taxed numeric,
  perc_iva numeric,
  perc_iibb numeric,
  perc_ganancias numeric,
  internos numeric,
  otros numeric,
  total numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'acc_range_invalid';
  end if;
  return query
  select i.id, i.issue_date, s.name, s.cuit, s.iva_condition, i.kind, i.letter, i.point_of_sale, i.number,
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'rate', (e ->> 'rate')::numeric,
                    'net', round(sg.v * coalesce((e ->> 'net')::numeric, 0) * i.fx_rate, 2),
                    'vat', round(sg.v * coalesce((e ->> 'vat')::numeric, 0) * i.fx_rate, 2))), '[]'::jsonb)
            from jsonb_array_elements(i.vat_lines) e),
         round(sg.v * i.net_total * i.fx_rate, 2),
         round(sg.v * i.vat_total * i.fx_rate, 2),
         round(sg.v * i.exempt_amount * i.fx_rate, 2),
         round(sg.v * i.non_taxed_amount * i.fx_rate, 2),
         round(sg.v * coalesce((select sum((e ->> 'amount')::numeric) from jsonb_array_elements(i.other_taxes) e
                                  where e ->> 'kind' = 'percepcion_iva'), 0) * i.fx_rate, 2),
         round(sg.v * coalesce((select sum((e ->> 'amount')::numeric) from jsonb_array_elements(i.other_taxes) e
                                  where e ->> 'kind' = 'percepcion_iibb'), 0) * i.fx_rate, 2),
         round(sg.v * coalesce((select sum((e ->> 'amount')::numeric) from jsonb_array_elements(i.other_taxes) e
                                  where e ->> 'kind' = 'percepcion_ganancias'), 0) * i.fx_rate, 2),
         round(sg.v * coalesce((select sum((e ->> 'amount')::numeric) from jsonb_array_elements(i.other_taxes) e
                                  where e ->> 'kind' = 'impuesto_interno'), 0) * i.fx_rate, 2),
         round(sg.v * coalesce((select sum((e ->> 'amount')::numeric) from jsonb_array_elements(i.other_taxes) e
                                  where coalesce(e ->> 'kind', 'otro') not in
                                        ('percepcion_iva', 'percepcion_iibb', 'percepcion_ganancias', 'impuesto_interno')), 0)
               * i.fx_rate, 2),
         round(sg.v * i.total * i.fx_rate, 2)
    from supplier_invoices i
    join suppliers s on s.id = i.supplier_id
    cross join lateral (select case when i.kind = 'credit_note' then -1 else 1 end as v) sg
   where i.tenant_id = v_tenant and i.status = 'posted'
     and i.issue_date between p_from and p_to
   order by i.issue_date, s.name, i.point_of_sale, i.number;
end;
$$;
revoke all on function acc_vat_purchases(date, date) from public, anon;
grant execute on function acc_vat_purchases(date, date) to authenticated;

-- Resumen por mes para la pantalla de cierres: estado, asientos, total y
-- problemas abiertos con fecha en el mes. Incluye los meses con asientos y
-- los últimos p_months.
create or replace function acc_periods_overview(p_months int default 18)
returns table (
  period date,
  status text,
  entries bigint,
  total numeric,
  closed_at timestamptz,
  closed_by uuid,
  reopened_at timestamptz,
  reopen_reason text,
  notes text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
begin
  return query
  with months as (
    select (date_trunc('month', current_date::timestamp) - make_interval(months => g))::date as p
      from generate_series(0, greatest(least(coalesce(p_months, 18), 120), 1) - 1) g
    union
    select distinct e.period from acc_entries e where e.tenant_id = v_tenant and e.deleted_at is null
    union
    select ap.period from acc_periods ap where ap.tenant_id = v_tenant
  ), agg as (
    select e.period as p, count(*) as n, coalesce(sum(e.total), 0) as t
      from acc_entries e
     where e.tenant_id = v_tenant and e.deleted_at is null
     group by e.period
  )
  select m.p, coalesce(ap.status, 'open'), coalesce(agg.n, 0), coalesce(agg.t, 0)::numeric,
         ap.closed_at, ap.closed_by, ap.reopened_at, ap.reopen_reason, ap.notes
    from months m
    left join agg on agg.p = m.p
    left join acc_periods ap on ap.tenant_id = v_tenant and ap.period = m.p
   order by m.p desc;
end;
$$;
revoke all on function acc_periods_overview(int) from public, anon;
grant execute on function acc_periods_overview(int) to authenticated;
