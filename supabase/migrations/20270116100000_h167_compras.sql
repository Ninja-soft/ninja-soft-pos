-- =============================================================================
-- 20270116100000_h167_compras  (F24 · H167, ADR-178)
--
-- Compras PRO (auditoría InfoManager IM5, cap. 04). OPTIONAL `compras`
-- (existe) para todo; la lectura con IA suma el ADDON `asistente_ia`
-- (tenant_has_feature_for, igual que ai_cover_image). Escritura siempre por
-- RPC SECURITY DEFINER con purchase_assert(true) (negocio, rol, plan) más la
-- capacidad purchases.manage (purchase_can_write()).
--
--   A) supplier_invoices: cae, cae_due y source (manual, arca, ia).
--   B) supplier_invoice_lines: renglones de la factura. 'item' (artículo que
--      también ingresa stock: se crea una recepción con purchase_receive, la
--      misma lógica de recibir, vinculada a la factura) y 'expense' (gasto
--      con cuenta contable imputable). supplier_invoice_save_full envuelve a
--      supplier_invoice_save (sin redefinirlo) y suma CAE y renglones.
--      acc_sync_supplier_invoice (definición viva de 20261029100200) imputa
--      cada gasto a su cuenta; sin renglones, igual que antes.
--   C) Import de "Mis Comprobantes Recibidos" de ARCA:
--      purchase_arca_import(p_rows, p_apply, ...). Cada fila corre en su
--      propio bloque: en la vista previa se deshace siempre (dry_run_ok) y
--      devuelve qué pasaría; al aplicar, las filas con error conocido (letra
--      que no corresponde, total que no suma, duplicada) se informan y no
--      cortan el lote. Idempotente: un comprobante ya cargado es 'skip'.
--      Crea el proveedor por CUIT si no existe (con los datos del padrón que
--      mande el front o la denominación del archivo).
--   D) Bandeja de facturas (fotos o PDF desde el celular): bucket privado
--      purchase-inbox (<negocio>/<archivo>) y purchase_invoice_inbox
--      (pending, processed, discarded). La Edge purchase_invoice_ocr lee el
--      archivo con la IA de la plataforma y guarda lo extraído; nunca graba
--      el comprobante (lo confirma una persona en el formulario).
--   E) NC y anticipos imputados a facturas concretas, por partes:
--      supplier_credit_applications (fuente: NC del proveedor o pago con saldo
--      sin imputar; destino: factura o ND). supplier_credit_apply (suelto) y
--      supplier_payment_order_create (definición viva de 20261231100000 +
--      credit_applications antes de imputar). supplier_invoice_open resta lo
--      aplicado; supplier_credit_open lista los créditos disponibles. El
--      guard de H158 (trg_supplier_invoice_paid_guard, definición viva) cuenta
--      también lo aplicado, y anular un pago libera lo aplicado con él.
--   F) Saldo inicial y ajustes manuales del proveedor:
--      supplier_account_adjustments (opening única por proveedor, adjustment
--      con signo), en supplier_account_entries (vista viva de 20261016100300)
--      y por lo tanto en saldos, aging y resumen de cuenta. Sin asiento
--      automático (deuda documentada en ADR-178: se registra con un asiento
--      manual; el saldo inicial ya está en el asiento de apertura).
--
-- RLS: tablas nuevas con tenant_id, select con (select current_tenant_id())
-- o (select internal_scope()); sin insert/update/delete directo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) CAE, vencimiento del CAE y origen del comprobante.
-- -----------------------------------------------------------------------------
alter table public.supplier_invoices add column if not exists cae text;
alter table public.supplier_invoices add column if not exists cae_due date;
alter table public.supplier_invoices add column if not exists source text not null default 'manual';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_invoices_cae_check') then
    alter table public.supplier_invoices add constraint supplier_invoices_cae_check
      check (cae is null or cae ~ '^\d{14}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'supplier_invoices_source_check') then
    alter table public.supplier_invoices add constraint supplier_invoices_source_check
      check (source in ('manual', 'arca', 'ia'));
  end if;
end;
$$;

comment on column public.supplier_invoices.cae is 'H167: CAE o CAI del comprobante del proveedor (14 dígitos).';
comment on column public.supplier_invoices.source is 'H167: manual, arca (import de Mis Comprobantes) o ia (lectura de foto o PDF).';

-- Clase y letra de un comprobante según el código de ARCA (tabla de tipos de
-- comprobante de WSFE). null = no es un comprobante de compra que se cargue
-- acá (recibos, tiques, liquidaciones).
create or replace function public.purchase_arca_cbte(p_code int)
returns table (kind text, letter text)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select k, l from (values
    (1, 'invoice', 'A'), (2, 'debit_note', 'A'), (3, 'credit_note', 'A'),
    (6, 'invoice', 'B'), (7, 'debit_note', 'B'), (8, 'credit_note', 'B'),
    (11, 'invoice', 'C'), (12, 'debit_note', 'C'), (13, 'credit_note', 'C'),
    (19, 'invoice', 'E'), (20, 'debit_note', 'E'), (21, 'credit_note', 'E'),
    (51, 'invoice', 'M'), (52, 'debit_note', 'M'), (53, 'credit_note', 'M'),
    (201, 'invoice', 'A'), (202, 'debit_note', 'A'), (203, 'credit_note', 'A'),
    (206, 'invoice', 'B'), (207, 'debit_note', 'B'), (208, 'credit_note', 'B'),
    (211, 'invoice', 'C'), (212, 'debit_note', 'C'), (213, 'credit_note', 'C')
  ) as t(code, k, l)
  where t.code = p_code;
$$;
grant execute on function public.purchase_arca_cbte(int) to authenticated, service_role;

-- Escritura de compras con la capacidad (además del rol y el plan).
create or replace function public._purchase_write_assert()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
begin
  if not purchase_can_write() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function public._purchase_write_assert() from public, anon;
grant execute on function public._purchase_write_assert() to authenticated;

-- -----------------------------------------------------------------------------
-- B) Renglones de la factura.
-- -----------------------------------------------------------------------------
create table if not exists public.supplier_invoice_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  invoice_id      uuid not null references public.supplier_invoices(id) on delete cascade,
  kind            text not null check (kind in ('item', 'expense')),
  product_id      uuid references public.products(id),
  variant_id      uuid references public.product_variants(id),
  description     text check (description is null or char_length(description) <= 200),
  qty             numeric(14,3) check (qty is null or qty > 0),
  unit_cost       numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  vat_rate        numeric(5,2) not null default 21 check (vat_rate in (0, 2.5, 5, 10.5, 21, 27)),
  net             numeric(14,2) not null check (net >= 0),
  account_id      uuid references public.acc_accounts(id),
  receipt_item_id uuid references public.goods_receipt_items(id),
  sort            int not null default 0,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint supplier_invoice_lines_item_check
    check (kind <> 'item' or (product_id is not null and qty is not null and unit_cost is not null)),
  constraint supplier_invoice_lines_expense_check
    check (kind <> 'expense' or nullif(btrim(coalesce(description, '')), '') is not null)
);

comment on table public.supplier_invoice_lines is
  'H167 (ADR-178): renglones de la factura de compra. item = artículo recibido con la factura (recepción vinculada); expense = gasto con cuenta contable.';

create index if not exists supplier_invoice_lines_invoice_idx on public.supplier_invoice_lines (invoice_id, sort);
create index if not exists supplier_invoice_lines_tenant_idx on public.supplier_invoice_lines (tenant_id);

alter table public.supplier_invoice_lines enable row level security;
drop policy if exists supplier_invoice_lines_select on public.supplier_invoice_lines;
create policy supplier_invoice_lines_select on public.supplier_invoice_lines for select to authenticated
  using ((tenant_id = (select current_tenant_id())) or (select internal_scope()));
revoke all on public.supplier_invoice_lines from anon;
revoke insert, update, delete on public.supplier_invoice_lines from authenticated;
grant select on public.supplier_invoice_lines to authenticated;

-- Alta o edición del comprobante con CAE y renglones.
--   p: lo mismo que supplier_invoice_save + {cae?, cae_due?, source?}
--   p_lines: null = no tocar los renglones. [{kind, product_id?, variant_id?,
--            description?, qty?, unit_cost?, vat_rate?, net?, account_id?}]
--            Los artículos sólo en el alta: generan una recepción en
--            p_store_id con purchase_receive (stock, costos, lotes).
create or replace function public.supplier_invoice_save_full(
  p_id uuid, p jsonb, p_receipt_ids uuid[] default null, p_lines jsonb default null, p_store_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _purchase_write_assert();
  v_before  supplier_invoices;
  v_inv     supplier_invoices;
  v_id      uuid;
  v_l       record;
  v_sort    int := 0;
  v_net     numeric;
  v_sum     numeric := 0;
  v_items   jsonb := '[]'::jsonb;
  v_rec     uuid;
  v_cae     text := nullif(regexp_replace(coalesce(p ->> 'cae', ''), '\D', '', 'g'), '');
  v_source  text := coalesce(nullif(p ->> 'source', ''), 'manual');
  v_has_items boolean := false;
begin
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  if p_lines is not null then
    select exists (select 1 from jsonb_array_elements(p_lines) x where x ->> 'kind' = 'item') into v_has_items;
  end if;
  if p_id is not null then
    select * into v_before from supplier_invoices where id = p_id and tenant_id = v_tenant;
    if v_has_items then
      raise exception 'invoice_items_only_on_create';
    end if;
  end if;

  v_id := supplier_invoice_save(p_id, p, p_receipt_ids);

  update supplier_invoices
     set cae = v_cae,
         cae_due = (nullif(p ->> 'cae_due', ''))::date,
         source = case when p_id is null then v_source else source end
   where id = v_id
  returning * into v_inv;

  if p_lines is not null then
    update supplier_invoice_lines set deleted_at = now()
     where invoice_id = v_id and kind = 'expense' and deleted_at is null;
    select coalesce(max(sort), 0) into v_sort from supplier_invoice_lines where invoice_id = v_id;

    for v_l in
      select x.kind, x.product_id, x.variant_id, nullif(btrim(coalesce(x.description, '')), '') as description,
             x.qty, x.unit_cost, coalesce(x.vat_rate, 21) as vat_rate, x.net, x.account_id
        from jsonb_to_recordset(p_lines)
          as x(kind text, product_id uuid, variant_id uuid, description text, qty numeric, unit_cost numeric,
               vat_rate numeric, net numeric, account_id uuid)
    loop
      if v_l.kind not in ('item', 'expense') then
        raise exception 'invalid_lines';
      end if;
      if v_l.vat_rate not in (0, 2.5, 5, 10.5, 21, 27) then
        raise exception 'invalid_vat_rate';
      end if;
      if v_l.kind = 'item' then
        if v_l.product_id is null or coalesce(v_l.qty, 0) <= 0 or coalesce(v_l.unit_cost, -1) < 0 then
          raise exception 'invalid_lines';
        end if;
        v_net := round(v_l.qty * v_l.unit_cost, 2);
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'product_id', v_l.product_id, 'variant_id', v_l.variant_id, 'qty', v_l.qty, 'unit_cost', v_l.unit_cost));
      else
        v_net := round(coalesce(v_l.net, 0), 2);
        if v_net <= 0 or v_l.description is null then
          raise exception 'invalid_lines';
        end if;
        if v_l.account_id is not null and not exists (
          select 1 from acc_accounts a
           where a.id = v_l.account_id and a.tenant_id = v_tenant and a.deleted_at is null and a.imputable
        ) then
          raise exception 'account_not_imputable';
        end if;
      end if;
      v_sort := v_sort + 1;
      v_sum := v_sum + v_net;
      insert into supplier_invoice_lines (tenant_id, invoice_id, kind, product_id, variant_id, description, qty,
                                          unit_cost, vat_rate, net, account_id, sort)
      values (v_tenant, v_id, v_l.kind, v_l.product_id, v_l.variant_id, left(v_l.description, 200),
              case when v_l.kind = 'item' then v_l.qty end, case when v_l.kind = 'item' then v_l.unit_cost end,
              v_l.vat_rate, v_net, case when v_l.kind = 'expense' then v_l.account_id end, v_sort);
    end loop;

    -- Lo que suman los renglones no puede superar el neto del comprobante.
    select coalesce(sum(l.net), 0) into v_sum
      from supplier_invoice_lines l
     where l.invoice_id = v_id and l.deleted_at is null;
    if v_sum > v_inv.net_total + v_inv.exempt_amount + v_inv.non_taxed_amount + 0.01 then
      raise exception 'lines_exceed_invoice';
    end if;

    if jsonb_array_length(v_items) > 0 then
      if p_store_id is null then
        raise exception 'store_required';
      end if;
      v_rec := purchase_receive(null, p_store_id, v_inv.supplier_id, v_inv.issue_date, null, v_inv.currency,
                                v_inv.fx_rate, v_items, false,
                                'Factura ' || v_inv.letter || ' ' || lpad(v_inv.point_of_sale::text, 5, '0') || '-'
                                  || lpad(v_inv.number::text, 8, '0'));
      update goods_receipts set invoice_id = v_id where id = v_rec;
      -- Cada renglón con su ítem de la recepción (mismo orden).
      update supplier_invoice_lines l
         set receipt_item_id = ri.id
        from (select g.id, row_number() over (order by g.sort) as rn
                from goods_receipt_items g where g.receipt_id = v_rec) ri
        join (select l2.id, row_number() over (order by l2.sort) as rn
                from supplier_invoice_lines l2
               where l2.invoice_id = v_id and l2.kind = 'item' and l2.deleted_at is null) li on li.rn = ri.rn
       where l.id = li.id;
    end if;

    -- Edición que sólo cambia los gastos: el trigger del asiento no se
    -- dispara (no cambian los importes), se rehace acá.
    if p_id is not null and acc_tenant_active(v_tenant)
       and (v_before.total, v_before.vat_lines, v_before.other_taxes, v_before.issue_date, v_before.kind,
            v_before.fx_rate, v_before.supplier_id, v_before.letter, v_before.point_of_sale, v_before.number)
           is not distinct from
           (v_inv.total, v_inv.vat_lines, v_inv.other_taxes, v_inv.issue_date, v_inv.kind, v_inv.fx_rate,
            v_inv.supplier_id, v_inv.letter, v_inv.point_of_sale, v_inv.number) then
      perform acc_sync_safe(v_tenant, 'supplier_invoice', v_id, true);
    end if;

    perform purchase_log(v_tenant, 'invoice', v_id, 'lines_saved', 'posted', 'posted', null,
                         jsonb_build_object('lines', v_sort, 'receipt_id', v_rec, 'lines_net', v_sum));
  end if;
  return v_id;
end;
$$;
revoke all on function public.supplier_invoice_save_full(uuid, jsonb, uuid[], jsonb, uuid) from public, anon;
grant execute on function public.supplier_invoice_save_full(uuid, jsonb, uuid[], jsonb, uuid) to authenticated;

-- Asiento del comprobante: definición viva (20261029100200) + renglones de
-- gasto a su cuenta. El resto del neto va a 'compras' como antes.
create or replace function public.acc_sync_supplier_invoice(p_tenant uuid, p_id uuid, p_refresh boolean default false)
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
  v_exp numeric := 0;
  v_amt numeric;
  v_lines jsonb := '[]'::jsonb;
  e jsonb;
  l record;
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
    -- H167: gastos por renglón a su cuenta (nunca más que el neto).
    for l in
      select x.account_id, round(sum(x.net) * i.fx_rate, 2) as amt
        from supplier_invoice_lines x
       where x.invoice_id = i.id and x.kind = 'expense' and x.account_id is not null and x.deleted_at is null
       group by x.account_id
    loop
      v_amt := least(l.amt, greatest(v_total - v_others - v_exp, 0));
      if v_amt > 0 then
        v_lines := v_lines || acc_line(l.account_id, v_sign * v_amt, 'Gasto');
        v_exp := v_exp + v_amt;
      end if;
    end loop;
    v_lines := v_lines
      || acc_line(acc_account_for(p_tenant, 'compras', i.supplier_id::text, v_store), v_sign * (v_total - v_others - v_exp), 'Neto, exento y no gravado')
      || acc_line(acc_account_for(p_tenant, 'proveedores', i.supplier_id::text, v_store), -v_sign * v_total, v_sup);
    perform acc_post(p_tenant, i.issue_date, 'supplier_invoice', i.id, 'invoice', v_desc, v_store, v_lines);
  end if;

  if i.status = 'voided' then
    perform acc_post_reversal(p_tenant, 'supplier_invoice', i.id, 'invoice', 'void',
                              acc_ar_date(coalesce(i.voided_at, now())), 'Anulación ' || v_desc);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Import de "Mis Comprobantes Recibidos" de ARCA.
--    p_rows: [{_row, cbte_type, point_of_sale, number, issue_date, cae?,
--              issuer_cuit, issuer_name?, supplier_iva?, currency?, fx_rate?,
--              vat_lines, exempt_amount, non_taxed_amount, other_taxes, total}]
--    Clase y letra salen del código de ARCA en el servidor.
-- -----------------------------------------------------------------------------
create or replace function public.purchase_arca_import(
  p_rows jsonb, p_apply boolean default false, p_file_name text default null, p_create_suppliers boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _purchase_write_assert();
  v_buyer   text;
  r         jsonb;
  v_rowno   int;
  v_cuit    text;
  v_kind    text;
  v_letter  text;
  v_sup     suppliers;
  v_iva     text;
  v_new     boolean;
  v_id      uuid;
  v_ok      text[];
  v_msg     text;
  v_out     jsonb := '[]'::jsonb;
  v_created int := 0;
  v_skipped int := 0;
  v_errors  int := 0;
  v_sups    int := 0;
  v_cae     text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_rows';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'too_many_rows';
  end if;
  select iva_condition into v_buyer from tax_settings where tenant_id = v_tenant;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_rowno := coalesce((r ->> '_row')::int, 0);
    v_new := false;
    v_id := null;
    begin
      select k.kind, k.letter into v_kind, v_letter from purchase_arca_cbte((r ->> 'cbte_type')::int) k;
      if v_kind is null then
        raise exception 'arca_cbte_unsupported';
      end if;
      v_cuit := regexp_replace(coalesce(r ->> 'issuer_cuit', ''), '\D', '', 'g');
      if v_cuit !~ '^\d{11}$' or not cuit_is_valid(v_cuit) then
        raise exception 'arca_cuit_invalid';
      end if;
      select * into v_sup from suppliers
       where tenant_id = v_tenant and cuit = v_cuit and deleted_at is null
       order by created_at limit 1;
      if v_sup.id is null then
        if not p_create_suppliers then
          raise exception 'supplier_not_found';
        end if;
        v_iva := coalesce(nullif(r ->> 'supplier_iva', ''),
                          case v_letter when 'C' then 'monotributo' when 'E' then 'exterior'
                                        else 'responsable_inscripto' end);
        if v_iva not in ('responsable_inscripto', 'monotributo', 'exento', 'no_responsable', 'consumidor_final',
                         'no_alcanzado', 'exterior') then
          v_iva := 'responsable_inscripto';
        end if;
        insert into suppliers (tenant_id, name, cuit, iva_condition)
        values (v_tenant, left(coalesce(nullif(btrim(r ->> 'issuer_name'), ''), 'CUIT ' || v_cuit), 200), v_cuit, v_iva)
        returning * into v_sup;
        v_new := true;
      end if;
      v_ok := supplier_invoice_letters(v_sup.iva_condition, v_buyer);
      if v_ok is not null and not (v_letter = any (v_ok)) then
        raise exception 'invoice_letter_mismatch';
      end if;
      if exists (
        select 1 from supplier_invoices i
         where i.tenant_id = v_tenant and i.supplier_id = v_sup.id and i.kind = v_kind and i.letter = v_letter
           and i.point_of_sale = (r ->> 'point_of_sale')::int and i.number = (r ->> 'number')::bigint
           and i.status = 'posted'
      ) then
        raise exception 'invoice_duplicated';
      end if;

      v_id := supplier_invoice_save(null, jsonb_build_object(
        'supplier_id', v_sup.id, 'kind', v_kind, 'letter', v_letter,
        'point_of_sale', r -> 'point_of_sale', 'number', r -> 'number', 'issue_date', r ->> 'issue_date',
        'currency', coalesce(nullif(r ->> 'currency', ''), 'ARS'), 'fx_rate', coalesce(r -> 'fx_rate', '1'::jsonb),
        'vat_lines', coalesce(r -> 'vat_lines', '[]'::jsonb),
        'exempt_amount', coalesce(r -> 'exempt_amount', '0'::jsonb),
        'non_taxed_amount', coalesce(r -> 'non_taxed_amount', '0'::jsonb),
        'other_taxes', coalesce(r -> 'other_taxes', '[]'::jsonb),
        'total', r -> 'total',
        'notes', 'Importado de ARCA (Mis Comprobantes Recibidos)'), null);
      v_cae := nullif(regexp_replace(coalesce(r ->> 'cae', ''), '\D', '', 'g'), '');
      update supplier_invoices
         set source = 'arca', cae = case when v_cae ~ '^\d{14}$' then v_cae end
       where id = v_id;

      if not coalesce(p_apply, false) then
        raise exception 'dry_run_ok';
      end if;
      v_created := v_created + 1;
      if v_new then v_sups := v_sups + 1; end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'row', v_rowno, 'action', 'create', 'message', case when v_new then 'supplier_created' end,
        'invoice_id', v_id, 'supplier_id', v_sup.id, 'supplier_new', v_new));
    exception when others then
      v_msg := sqlerrm;
      if v_msg = 'dry_run_ok' then
        v_created := v_created + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'row', v_rowno, 'action', 'create', 'message', case when v_new then 'supplier_new' end,
          'supplier_new', v_new));
      elsif v_msg like '%invoice_duplicated%' then
        v_skipped := v_skipped + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_rowno, 'action', 'skip', 'message', 'duplicate'));
      else
        v_errors := v_errors + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_rowno, 'action', 'error', 'message', left(v_msg, 200)));
      end if;
    end;
  end loop;

  if coalesce(p_apply, false) then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'supplier_invoices', null, 'purchase_arca_import',
            jsonb_build_object('file_name', left(coalesce(p_file_name, ''), 200), 'created', v_created,
                               'skipped', v_skipped, 'errors', v_errors, 'suppliers_created', v_sups));
  end if;
  return jsonb_build_object('applied', coalesce(p_apply, false), 'created', v_created, 'updated', 0,
                            'skipped', v_skipped, 'errors', v_errors, 'suppliers_created', v_sups, 'rows', v_out);
end;
$$;
revoke all on function public.purchase_arca_import(jsonb, boolean, text, boolean) from public, anon;
grant execute on function public.purchase_arca_import(jsonb, boolean, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Bandeja de facturas para leer con IA.
-- -----------------------------------------------------------------------------
create table if not exists public.purchase_invoice_inbox (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  storage_path  text not null unique,
  file_name     text not null check (char_length(file_name) between 1 and 200),
  mime_type     text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes    bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  note          text check (note is null or char_length(note) <= 300),
  status        text not null default 'pending' check (status in ('pending', 'processed', 'discarded')),
  extracted     jsonb,
  extracted_at  timestamptz,
  ai_provider   text,
  invoice_id    uuid references public.supplier_invoices(id),
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  processed_at  timestamptz,
  processed_by  uuid
);

comment on table public.purchase_invoice_inbox is
  'H167 (ADR-178): fotos y PDF de facturas de compra subidos (también desde el celular) para leer con IA y cargar después.';

create index if not exists purchase_invoice_inbox_tenant_idx
  on public.purchase_invoice_inbox (tenant_id, status, created_at desc);
create index if not exists purchase_invoice_inbox_invoice_idx
  on public.purchase_invoice_inbox (invoice_id) where invoice_id is not null;

alter table public.purchase_invoice_inbox enable row level security;
drop policy if exists purchase_invoice_inbox_select on public.purchase_invoice_inbox;
create policy purchase_invoice_inbox_select on public.purchase_invoice_inbox for select to authenticated
  using ((tenant_id = (select current_tenant_id())) or (select internal_scope()));
revoke all on public.purchase_invoice_inbox from anon;
revoke insert, update, delete on public.purchase_invoice_inbox from authenticated;
grant select on public.purchase_invoice_inbox to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('purchase-inbox', 'purchase-inbox', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "purchase_inbox_read" on storage.objects;
drop policy if exists "purchase_inbox_write" on storage.objects;
create policy "purchase_inbox_read" on storage.objects for select to authenticated
  using (bucket_id = 'purchase-inbox'
         and (storage.foldername(name))[1] = (select current_tenant_id())::text
         and (select purchase_can_write()));
create policy "purchase_inbox_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'purchase-inbox'
              and (storage.foldername(name))[1] = (select current_tenant_id())::text
              and (select purchase_can_write()));

-- Registra un archivo ya subido a purchase-inbox/<negocio>/...
create or replace function public.purchase_inbox_add(
  p_path text, p_file_name text, p_mime_type text, p_size_bytes bigint, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _purchase_write_assert();
  v_path   text := btrim(coalesce(p_path, ''));
  v_meta   jsonb;
  v_id     uuid;
begin
  if v_path not like v_tenant::text || '/%' or position('..' in v_path) > 0 then
    raise exception 'inbox_bad_path';
  end if;
  select o.metadata into v_meta from storage.objects o where o.bucket_id = 'purchase-inbox' and o.name = v_path;
  if not found then
    raise exception 'inbox_not_uploaded';
  end if;
  if (select count(*) from purchase_invoice_inbox where tenant_id = v_tenant and status = 'pending') >= 200 then
    raise exception 'inbox_full';
  end if;
  insert into purchase_invoice_inbox (tenant_id, storage_path, file_name, mime_type, size_bytes, note, created_by)
  values (v_tenant, v_path, left(coalesce(nullif(btrim(p_file_name), ''), 'factura'), 200),
          coalesce(nullif(v_meta ->> 'mimetype', ''), p_mime_type),
          coalesce(nullif(v_meta ->> 'size', '')::bigint, p_size_bytes),
          nullif(left(btrim(coalesce(p_note, '')), 300), ''), auth.uid())
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'purchase_invoice_inbox', v_id, 'purchase_inbox_added',
          jsonb_build_object('file_name', p_file_name, 'size_bytes', p_size_bytes));
  return v_id;
end;
$$;
revoke all on function public.purchase_inbox_add(text, text, text, bigint, text) from public, anon;
grant execute on function public.purchase_inbox_add(text, text, text, bigint, text) to authenticated;

-- Cambia el estado: processed (con el comprobante cargado), discarded o
-- pending (volver a la bandeja). El archivo queda en storage.
create or replace function public.purchase_inbox_set_status(p_id uuid, p_status text, p_invoice_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _purchase_write_assert();
  v_row    purchase_invoice_inbox;
begin
  if p_status not in ('pending', 'processed', 'discarded') then
    raise exception 'invalid_status';
  end if;
  select * into v_row from purchase_invoice_inbox where id = p_id and tenant_id = v_tenant for update;
  if v_row.id is null then
    raise exception 'inbox_not_found';
  end if;
  if p_invoice_id is not null and not exists (
    select 1 from supplier_invoices where id = p_invoice_id and tenant_id = v_tenant
  ) then
    raise exception 'invoice_not_found';
  end if;
  update purchase_invoice_inbox
     set status = p_status,
         invoice_id = case when p_status = 'processed' then coalesce(p_invoice_id, invoice_id) else invoice_id end,
         processed_at = case when p_status = 'pending' then null else now() end,
         processed_by = case when p_status = 'pending' then null else auth.uid() end
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'purchase_invoice_inbox', p_id, 'purchase_inbox_' || p_status,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', p_status, 'invoice_id', p_invoice_id));
end;
$$;
revoke all on function public.purchase_inbox_set_status(uuid, text, uuid) from public, anon;
grant execute on function public.purchase_inbox_set_status(uuid, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- E) NC y anticipos aplicados a comprobantes concretos.
-- -----------------------------------------------------------------------------
create table if not exists public.supplier_credit_applications (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  supplier_id       uuid not null references public.suppliers(id),
  source_invoice_id uuid references public.supplier_invoices(id),
  source_payment_id uuid references public.supplier_payments(id),
  invoice_id        uuid not null references public.supplier_invoices(id),
  payment_id        uuid references public.supplier_payments(id),
  amount            numeric(14,2) not null check (amount > 0),
  notes             text check (notes is null or char_length(notes) <= 300),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  released_at       timestamptz,
  released_by       uuid,
  release_reason    text,
  constraint supplier_credit_applications_source_check
    check ((source_invoice_id is null) <> (source_payment_id is null))
);

comment on table public.supplier_credit_applications is
  'H167 (ADR-178): nota de crédito o anticipo (pago sin imputar) aplicado a una factura o ND, en pesos. payment_id = OP en la que se aplicó. released_at = desaplicada.';

create index if not exists supplier_credit_applications_invoice_idx
  on public.supplier_credit_applications (invoice_id) where released_at is null;
create index if not exists supplier_credit_applications_src_inv_idx
  on public.supplier_credit_applications (source_invoice_id) where source_invoice_id is not null;
create index if not exists supplier_credit_applications_src_pay_idx
  on public.supplier_credit_applications (source_payment_id) where source_payment_id is not null;
create index if not exists supplier_credit_applications_payment_idx
  on public.supplier_credit_applications (payment_id) where payment_id is not null;
create index if not exists supplier_credit_applications_tenant_idx
  on public.supplier_credit_applications (tenant_id, supplier_id);

alter table public.supplier_credit_applications enable row level security;
drop policy if exists supplier_credit_applications_select on public.supplier_credit_applications;
create policy supplier_credit_applications_select on public.supplier_credit_applications for select to authenticated
  using ((tenant_id = (select current_tenant_id())) or (select internal_scope()));
revoke all on public.supplier_credit_applications from anon;
revoke insert, update, delete on public.supplier_credit_applications from authenticated;
grant select on public.supplier_credit_applications to authenticated;

-- Saldo abierto de una factura o ND en pesos: total menos pagos imputados y
-- créditos aplicados.
create or replace function public.supplier_doc_open_ars(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select round(i.total * i.fx_rate, 2)
         - coalesce((select sum(a.amount) from supplier_payment_allocations a
                      where a.invoice_id = i.id and a.released_at is null), 0)
         - coalesce((select sum(c.amount) from supplier_credit_applications c
                      where c.invoice_id = i.id and c.released_at is null), 0)
    from supplier_invoices i
   where i.id = p_invoice;
$$;
revoke all on function public.supplier_doc_open_ars(uuid) from public, anon, authenticated;

-- Saldo disponible de un crédito: NC (total) o pago (lo no imputado).
create or replace function public.supplier_credit_available_ars(p_source_invoice uuid, p_source_payment uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_source_invoice is not null then (
      select round(i.total * i.fx_rate, 2)
             - coalesce((select sum(c.amount) from supplier_credit_applications c
                          where c.source_invoice_id = i.id and c.released_at is null), 0)
        from supplier_invoices i where i.id = p_source_invoice)
    else (
      select round(p.amount * p.fx_rate, 2)
             - coalesce((select sum(a.amount) from supplier_payment_allocations a
                          where a.payment_id = p.id and a.released_at is null), 0)
             - coalesce((select sum(c.amount) from supplier_credit_applications c
                          where c.source_payment_id = p.id and c.released_at is null), 0)
        from supplier_payments p where p.id = p_source_payment)
  end;
$$;
revoke all on function public.supplier_credit_available_ars(uuid, uuid) from public, anon, authenticated;

-- Aplica créditos. p_items: [{source_type: 'credit_note'|'payment',
-- source_id, invoice_id, amount}]. Parcial: nunca más que lo disponible del
-- crédito ni que el saldo del comprobante. Devuelve el total aplicado.
create or replace function public._supplier_credit_apply(
  p_tenant uuid, p_supplier uuid, p_items jsonb, p_payment uuid default null, p_notes text default null)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_it    record;
  v_src   supplier_invoices;
  v_pay   supplier_payments;
  v_inv   supplier_invoices;
  v_avail numeric;
  v_open  numeric;
  v_total numeric := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  for v_it in
    select x.source_type, x.source_id, x.invoice_id, round(coalesce(x.amount, 0), 2) as amount
      from jsonb_to_recordset(p_items) as x(source_type text, source_id uuid, invoice_id uuid, amount numeric)
  loop
    continue when v_it.amount = 0;
    if v_it.amount < 0 then
      raise exception 'invalid_amount';
    end if;
    v_src := null; v_pay := null;
    if v_it.source_type = 'credit_note' then
      select * into v_src from supplier_invoices
       where id = v_it.source_id and tenant_id = p_tenant for update;
      if v_src.id is null or v_src.status <> 'posted' or v_src.kind <> 'credit_note' or v_src.supplier_id <> p_supplier then
        raise exception 'credit_not_available';
      end if;
      v_avail := supplier_credit_available_ars(v_src.id, null);
    elsif v_it.source_type = 'payment' then
      if v_it.source_id = p_payment then
        raise exception 'credit_not_available';
      end if;
      select * into v_pay from supplier_payments
       where id = v_it.source_id and tenant_id = p_tenant for update;
      if v_pay.id is null or v_pay.status <> 'posted' or v_pay.supplier_id <> p_supplier then
        raise exception 'credit_not_available';
      end if;
      v_avail := supplier_credit_available_ars(null, v_pay.id);
    else
      raise exception 'invalid_lines';
    end if;
    if v_it.amount > coalesce(v_avail, 0) + 0.005 then
      raise exception 'credit_exceeds_available';
    end if;

    select * into v_inv from supplier_invoices
     where id = v_it.invoice_id and tenant_id = p_tenant for update;
    if v_inv.id is null or v_inv.status <> 'posted' or v_inv.supplier_id <> p_supplier
       or v_inv.kind not in ('invoice', 'debit_note') then
      raise exception 'invoice_not_allocatable';
    end if;
    v_open := supplier_doc_open_ars(v_inv.id);
    if v_it.amount > v_open + 0.005 then
      raise exception 'allocation_exceeds_open';
    end if;

    insert into supplier_credit_applications (tenant_id, supplier_id, source_invoice_id, source_payment_id,
                                              invoice_id, payment_id, amount, notes, created_by)
    values (p_tenant, p_supplier, v_src.id, v_pay.id, v_inv.id, p_payment, v_it.amount,
            nullif(left(btrim(coalesce(p_notes, '')), 300), ''), auth.uid());
    v_total := v_total + v_it.amount;
  end loop;
  return v_total;
end;
$$;
revoke all on function public._supplier_credit_apply(uuid, uuid, jsonb, uuid, text) from public, anon, authenticated;

-- Aplicación suelta (sin plata de por medio).
create or replace function public.supplier_credit_apply(p_supplier_id uuid, p_items jsonb, p_notes text default null)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _purchase_write_assert();
  v_total  numeric;
begin
  if not exists (select 1 from suppliers where id = p_supplier_id and tenant_id = v_tenant and deleted_at is null) then
    raise exception 'supplier_not_found';
  end if;
  v_total := _supplier_credit_apply(v_tenant, p_supplier_id, p_items, null, p_notes);
  if v_total <= 0 then
    raise exception 'invalid_amount';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (v_tenant, auth.uid(), 'suppliers', p_supplier_id, 'supplier_credit_applied',
          jsonb_build_object('items', p_items, 'total', v_total), nullif(btrim(coalesce(p_notes, '')), ''));
  return v_total;
end;
$$;
revoke all on function public.supplier_credit_apply(uuid, jsonb, text) from public, anon;
grant execute on function public.supplier_credit_apply(uuid, jsonb, text) to authenticated;

create or replace function public.supplier_credit_unapply(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _purchase_write_assert();
  v_row    supplier_credit_applications;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_row from supplier_credit_applications where id = p_id and tenant_id = v_tenant for update;
  if v_row.id is null or v_row.released_at is not null then
    raise exception 'application_not_found';
  end if;
  update supplier_credit_applications
     set released_at = now(), released_by = auth.uid(), release_reason = left(btrim(p_reason), 300)
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, reason)
  values (v_tenant, auth.uid(), 'suppliers', v_row.supplier_id, 'supplier_credit_unapplied',
          to_jsonb(v_row), btrim(p_reason));
end;
$$;
revoke all on function public.supplier_credit_unapply(uuid, text) from public, anon;
grant execute on function public.supplier_credit_unapply(uuid, text) to authenticated;

-- Anular un pago libera lo que se aplicó con él (en la OP o como anticipo).
create or replace function public.trg_supplier_payment_release_credits()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update supplier_credit_applications
     set released_at = now(), released_by = auth.uid(), release_reason = 'Pago anulado'
   where (payment_id = new.id or source_payment_id = new.id) and released_at is null;
  return null;
end;
$$;
revoke all on function public.trg_supplier_payment_release_credits() from public, anon, authenticated;

drop trigger if exists supplier_payment_release_credits on public.supplier_payments;
create trigger supplier_payment_release_credits
  after update of status on public.supplier_payments
  for each row when (old.status = 'posted' and new.status = 'voided')
  execute function public.trg_supplier_payment_release_credits();

-- Guard de H158 (definición viva de 20270109100000) + créditos aplicados: una
-- factura con NC o anticipo aplicado no se anula ni baja de lo aplicado, y una
-- NC aplicada no se anula ni baja de lo aplicado (desaplicar primero).
create or replace function public.trg_supplier_invoice_paid_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paid numeric;
begin
  if old.status <> 'posted' then
    return new;
  end if;
  select coalesce(sum(a.amount), 0) into v_paid
    from supplier_payment_allocations a
   where a.invoice_id = old.id and a.released_at is null;
  v_paid := v_paid + coalesce((select sum(c.amount) from supplier_credit_applications c
                                where (c.invoice_id = old.id or c.source_invoice_id = old.id)
                                  and c.released_at is null), 0);
  if v_paid <= 0 then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.supplier_id is distinct from old.supplier_id
     or new.kind is distinct from old.kind
     or new.currency is distinct from old.currency
     or round(new.total * new.fx_rate, 2) < v_paid - 0.005 then
    raise exception 'invoice_has_payments'
      using detail = 'Pagado ' || v_paid::text, errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.trg_supplier_invoice_paid_guard() from public, anon, authenticated;

-- Saldo abierto por comprobante (definición viva de 20261022100400): resta
-- también los créditos aplicados. credited_ars al final (columna nueva).
create or replace view public.supplier_invoice_open
with (security_invoker = true) as
  select i.tenant_id, i.id as invoice_id, i.supplier_id, i.kind, i.letter, i.point_of_sale, i.number,
         i.issue_date, coalesce(i.due_date, i.issue_date) as due_date, i.currency, i.fx_rate,
         round(i.total * i.fx_rate, 2) as amount_ars,
         coalesce(sum(a.amount), 0)::numeric(14,2) as allocated_ars,
         (round(i.total * i.fx_rate, 2) - coalesce(sum(a.amount), 0)
          - coalesce((select sum(c.amount) from supplier_credit_applications c
                       where c.invoice_id = i.id and c.released_at is null), 0))::numeric(14,2) as open_ars,
         coalesce((select sum(c.amount) from supplier_credit_applications c
                    where c.invoice_id = i.id and c.released_at is null), 0)::numeric(14,2) as credited_ars
    from supplier_invoices i
    left join supplier_payment_allocations a on a.invoice_id = i.id and a.released_at is null
   where i.status = 'posted' and i.kind in ('invoice', 'debit_note')
   group by i.id;

revoke all on public.supplier_invoice_open from anon;
grant select on public.supplier_invoice_open to authenticated;

-- Créditos disponibles para aplicar: NC vigentes y pagos con saldo sin imputar.
create or replace view public.supplier_credit_open
with (security_invoker = true) as
  select x.* from (
    select i.tenant_id, i.supplier_id, 'credit_note'::text as source_type, i.id as source_id,
           'NC ' || i.letter || ' ' || lpad(i.point_of_sale::text, 5, '0') || '-' || lpad(i.number::text, 8, '0') as label,
           i.issue_date as doc_date,
           round(i.total * i.fx_rate, 2) as amount_ars,
           coalesce((select sum(c.amount) from supplier_credit_applications c
                      where c.source_invoice_id = i.id and c.released_at is null), 0)::numeric(14,2) as applied_ars,
           (round(i.total * i.fx_rate, 2)
            - coalesce((select sum(c.amount) from supplier_credit_applications c
                         where c.source_invoice_id = i.id and c.released_at is null), 0))::numeric(14,2) as available_ars
      from supplier_invoices i
     where i.status = 'posted' and i.kind = 'credit_note'
    union all
    select p.tenant_id, p.supplier_id, 'payment', p.id,
           'OP-' || lpad(p.number::text, 6, '0'),
           p.paid_date,
           round(p.amount * p.fx_rate, 2),
           (coalesce((select sum(a.amount) from supplier_payment_allocations a
                       where a.payment_id = p.id and a.released_at is null), 0)
            + coalesce((select sum(c.amount) from supplier_credit_applications c
                         where c.source_payment_id = p.id and c.released_at is null), 0))::numeric(14,2),
           (round(p.amount * p.fx_rate, 2)
            - coalesce((select sum(a.amount) from supplier_payment_allocations a
                         where a.payment_id = p.id and a.released_at is null), 0)
            - coalesce((select sum(c.amount) from supplier_credit_applications c
                         where c.source_payment_id = p.id and c.released_at is null), 0))::numeric(14,2)
      from supplier_payments p
     where p.status = 'posted'
  ) x
  where x.available_ars > 0.004;

revoke all on public.supplier_credit_open from anon;
grant select on public.supplier_credit_open to authenticated;


-- Orden de pago: definición viva (20261231100000_tesoreria_liquidaciones) +
-- credit_applications [{source_type, source_id, invoice_id, amount}] y el
-- saldo abierto con los créditos aplicados (supplier_doc_open_ars).
create or replace function public.supplier_payment_order_create(p jsonb)
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
  v_credit   numeric := 0;
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
  if p -> 'credit_applications' is not null and jsonb_typeof(p -> 'credit_applications') <> 'array' then
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

  -- H167: notas de crédito y anticipos aplicados a comprobantes concretos,
  -- antes de imputar el pago (bajan el saldo que se puede imputar).
  if p -> 'credit_applications' is not null then
    v_credit := _supplier_credit_apply(v_tenant, v_sup.id, p -> 'credit_applications', v_pay, null);
  end if;

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
    v_open := supplier_doc_open_ars(v_inv.id);
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
                                          'agent_retentions', v_agent, 'credit_applied', v_credit));
  if v_agent and jsonb_array_length(v_issued) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'tax_withholdings', v_pay, 'tax_withholdings_issued',
            jsonb_build_object('payment', v_label, 'supplier_id', v_sup.id, 'retentions', v_issued,
                               'total', (v_calc ->> 'total')::numeric));
  end if;
  return v_pay;
end;
$function$;
revoke all on function public.supplier_payment_order_create(jsonb) from public, anon;
grant execute on function public.supplier_payment_order_create(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Saldo inicial y ajustes manuales en la cuenta del proveedor.
--    sign = 1 aumenta lo que le debemos; -1 lo baja (saldo a favor).
-- -----------------------------------------------------------------------------
create table if not exists public.supplier_account_adjustments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),
  kind        text not null check (kind in ('opening', 'adjustment')),
  sign        smallint not null check (sign in (1, -1)),
  amount      numeric(14,2) not null check (amount > 0),
  adj_date    date not null,
  due_date    date,
  reason      text not null check (char_length(btrim(reason)) between 3 and 300),
  status      text not null default 'posted' check (status in ('posted', 'voided')),
  void_reason text,
  voided_at   timestamptz,
  voided_by   uuid,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  constraint supplier_account_adjustments_due check (due_date is null or due_date >= adj_date)
);

comment on table public.supplier_account_adjustments is
  'H167 (ADR-178): saldo inicial (uno por proveedor) y ajustes manuales de la cuenta corriente del proveedor, con motivo y auditoría. Sin asiento automático.';

create unique index if not exists supplier_account_adjustments_opening_key
  on public.supplier_account_adjustments (tenant_id, supplier_id) where kind = 'opening' and status = 'posted';
create index if not exists supplier_account_adjustments_supplier_idx
  on public.supplier_account_adjustments (supplier_id, adj_date);
create index if not exists supplier_account_adjustments_tenant_idx
  on public.supplier_account_adjustments (tenant_id, adj_date desc);

alter table public.supplier_account_adjustments enable row level security;
drop policy if exists supplier_account_adjustments_select on public.supplier_account_adjustments;
create policy supplier_account_adjustments_select on public.supplier_account_adjustments for select to authenticated
  using ((tenant_id = (select current_tenant_id())) or (select internal_scope()));
revoke all on public.supplier_account_adjustments from anon;
revoke insert, update, delete on public.supplier_account_adjustments from authenticated;
grant select on public.supplier_account_adjustments to authenticated;

-- p: {supplier_id, kind, sign, amount, adj_date?, due_date?, reason}
create or replace function public.supplier_adjustment_create(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _purchase_write_assert();
  v_sup    uuid;
  v_kind   text := coalesce(p ->> 'kind', 'adjustment');
  v_sign   int := coalesce((p ->> 'sign')::int, 1);
  v_amt    numeric := round(coalesce((p ->> 'amount')::numeric, 0), 2);
  v_date   date := coalesce((nullif(p ->> 'adj_date', ''))::date,
                            (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  v_reason text := btrim(coalesce(p ->> 'reason', ''));
  v_id     uuid;
begin
  select id into v_sup from suppliers
   where id = (p ->> 'supplier_id')::uuid and tenant_id = v_tenant and deleted_at is null;
  if v_sup is null then
    raise exception 'supplier_not_found';
  end if;
  if v_kind not in ('opening', 'adjustment') or v_sign not in (1, -1) then
    raise exception 'invalid_adjustment';
  end if;
  if v_amt <= 0 then
    raise exception 'invalid_amount';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  if v_kind = 'opening' and exists (
    select 1 from supplier_account_adjustments
     where tenant_id = v_tenant and supplier_id = v_sup and kind = 'opening' and status = 'posted'
  ) then
    raise exception 'opening_exists';
  end if;
  insert into supplier_account_adjustments (tenant_id, supplier_id, kind, sign, amount, adj_date, due_date, reason,
                                            created_by)
  values (v_tenant, v_sup, v_kind, v_sign, v_amt, v_date, (nullif(p ->> 'due_date', ''))::date, left(v_reason, 300),
          auth.uid())
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (v_tenant, auth.uid(), 'supplier_account_adjustments', v_id, 'supplier_adjustment_created',
          jsonb_build_object('supplier_id', v_sup, 'kind', v_kind, 'sign', v_sign, 'amount', v_amt, 'date', v_date),
          v_reason);
  return v_id;
end;
$$;
revoke all on function public.supplier_adjustment_create(jsonb) from public, anon;
grant execute on function public.supplier_adjustment_create(jsonb) to authenticated;

create or replace function public.supplier_adjustment_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _purchase_write_assert();
  v_row    supplier_account_adjustments;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_row from supplier_account_adjustments where id = p_id and tenant_id = v_tenant for update;
  if v_row.id is null then
    raise exception 'adjustment_not_found';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'adjustment_voided';
  end if;
  update supplier_account_adjustments
     set status = 'voided', void_reason = left(btrim(p_reason), 300), voided_at = now(), voided_by = auth.uid()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, reason)
  values (v_tenant, auth.uid(), 'supplier_account_adjustments', p_id, 'supplier_adjustment_voided',
          to_jsonb(v_row), btrim(p_reason));
end;
$$;
revoke all on function public.supplier_adjustment_void(uuid, text) from public, anon;
grant execute on function public.supplier_adjustment_void(uuid, text) to authenticated;

-- Cuenta corriente (definición viva de 20261016100300) + saldo inicial y
-- ajustes. Mismas columnas: supplier_balances no cambia.
create or replace view public.supplier_account_entries
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
   where p.status = 'posted'
  union all
  select a.tenant_id, a.supplier_id, a.id, a.kind,
         case when a.kind = 'opening' then 'Saldo inicial' else 'Ajuste' end || ' · ' || left(a.reason, 60),
         a.adj_date, coalesce(a.due_date, a.adj_date), 'ARS'::text, 1::numeric(14,6),
         (a.sign * a.amount)::numeric, round(a.sign * a.amount, 2), a.created_at
    from supplier_account_adjustments a
   where a.status = 'posted';

revoke all on public.supplier_account_entries from anon;
grant select on public.supplier_account_entries to authenticated;

