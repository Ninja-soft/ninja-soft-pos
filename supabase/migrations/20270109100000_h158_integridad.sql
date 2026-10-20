-- =============================================================================
-- 20270109100000_h158_integridad  (F24 · H158, ADR-171)
--
-- Integridad y seguridad que destapó la auditoría de InfoManager IM5:
--
--   A) Asistente IA con permisos. ai__query_catalog() pasa a filtrar el
--      catálogo por el usuario del JWT: sin la capacidad de una entidad, la
--      entidad no existe para ai_query (tampoco por ref); sin reports.costs,
--      products.cost no existe. La versión completa queda como
--      ai__query_catalog_full(). El mapa de permisos se genera desde
--      entityCapsForSql() (aiQuery.ts); un test compara ambos.
--   B) Factura de proveedor con pagos: no se anula ni cambia de proveedor,
--      tipo o moneda, y el total no baja de lo ya pagado, mientras tenga
--      imputaciones vigentes de una orden de pago (antes quedaban colgadas o
--      con saldo negativo).
--   C) Letra de la factura de compra validada en el servidor según la
--      condición de IVA del proveedor y la del negocio (antes sólo la sugería
--      el front).
--   D) Asiento de la venta con los impuestos de la venta (sale_tax_lines):
--      IVA por alícuota, percepciones a su pasivo, impuestos internos a
--      pagar y el neto a Ventas. Libro IVA Ventas (acc_vat_sales) igual. Sin
--      renglones de impuestos (ventas viejas), como antes.
--   E) Producto no bonificable (products.no_discount): no acepta descuento
--      manual por renglón y el descuento general de la venta no puede superar
--      lo bonificable. Las promociones y cupones siguen aplicando.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogo de ai_query filtrado por permisos
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'ai__query_catalog_full') then
    alter function public.ai__query_catalog() rename to ai__query_catalog_full;
  end if;
end;
$$;
revoke all on function public.ai__query_catalog_full() from public, anon;
grant execute on function public.ai__query_catalog_full() to authenticated, service_role;

-- GENERADO desde entityCapsForSql() (aiQuery.ts): no editar a mano.
create or replace function public.ai__query_entity_caps()
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select $caps${"entities":{"appointments":"sales.view","brands":"products.view","cash_movements":"cash.view","cash_shifts":"cash.view","cash_z_closures":"cash.view","cashier_profiles":"team.view","categories":"products.view","coupon_redemptions":"sales.view","coupons":"sales.view","customer_account_movements":"customers.view","customer_groups":"customers.view","customer_pack_credits":"customers.view","customers":"customers.view","delivery_order_items":"sales.view","delivery_orders":"sales.view","delivery_zones":"sales.view","dining_areas":"sales.view","dining_reservations":"sales.view","dining_tables":"sales.view","menus":"products.view","payment_plans":"sales.view","payments":"sales.view","plans":"billing.manage","price_list_items":"products.view","price_lists":"products.view","product_serials":"products.view","product_variants":"products.view","products":"products.view","professionals":"sales.view","promotions":"sales.view","return_reasons":"sales.view","sale_items":"sales.view","sale_returns":"sales.view","sales":"sales.view","service_packs":"products.view","stock_movements":"stock.view","store_credit_movements":"customers.view","store_credit_vouchers":"customers.view","subscription_addons":"billing.manage","subscriptions":"billing.manage","table_order_items":"sales.view","table_orders":"sales.view","tenant_payment_methods":"config.edit","tenant_users":"team.view","warranty_plans":"products.view"},"cost_cols":{"products":["cost"]},"costs_cap":"reports.costs"}$caps$::jsonb;
$fn$;
revoke all on function public.ai__query_entity_caps() from public, anon;
grant execute on function public.ai__query_entity_caps() to authenticated, service_role;

-- Lo que ve ai_query (SECURITY INVOKER): el catálogo menos lo que el usuario
-- del JWT no puede ver. Sin usuario (service_role) no queda nada: ai_query
-- sólo se usa con el JWT del usuario.
create or replace function public.ai__query_catalog()
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_cat  jsonb := public.ai__query_catalog_full();
  v_caps jsonb := public.ai__query_entity_caps();
  v_ent  text;
  v_cap  text;
  v_col  text;
  v_def  jsonb;
begin
  for v_ent, v_cap in select key, value #>> '{}' from jsonb_each(v_caps -> 'entities') loop
    if not coalesce(public.has_capability(v_cap), false) then
      v_cat := v_cat #- array['entities', v_ent];
    end if;
  end loop;
  if not coalesce(public.has_capability(v_caps ->> 'costs_cap'), false) then
    for v_ent, v_col in
      select c.key, x.value #>> '{}'
        from jsonb_each(v_caps -> 'cost_cols') c, jsonb_array_elements(c.value) x loop
      continue when (v_cat -> 'entities' -> v_ent) is null;
      v_cat := v_cat #- array['entities', v_ent, 'cols', v_col];
      v_def := v_cat -> 'entities' -> v_ent -> 'def';
      if jsonb_typeof(v_def) = 'array' then
        v_cat := jsonb_set(v_cat, array['entities', v_ent, 'def'],
                           coalesce((select jsonb_agg(d) from jsonb_array_elements(v_def) d
                                      where d #>> '{}' <> v_col), '[]'::jsonb));
      end if;
    end loop;
  end if;
  return v_cat;
end;
$fn$;
revoke all on function public.ai__query_catalog() from public, anon;
grant execute on function public.ai__query_catalog() to authenticated;

-- -----------------------------------------------------------------------------
-- B) Factura de proveedor con pagos imputados
-- -----------------------------------------------------------------------------
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

drop trigger if exists supplier_invoice_paid_guard on public.supplier_invoices;
create trigger supplier_invoice_paid_guard
  before update on public.supplier_invoices
  for each row execute function public.trg_supplier_invoice_paid_guard();

-- -----------------------------------------------------------------------------
-- C) Letra de la factura de compra según las condiciones de IVA
-- -----------------------------------------------------------------------------
-- Letras que puede emitir un proveedor a este negocio. null = sin control
-- (condición desconocida). Responsable inscripto a monotributista: A (RG 5003)
-- o B (comprobantes anteriores a la RG).
create or replace function public.supplier_invoice_letters(p_supplier_iva text, p_buyer_iva text)
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_supplier_iva = 'exterior' then array['E']
    when p_supplier_iva in ('monotributo', 'exento', 'no_alcanzado', 'no_responsable') then array['C']
    when p_supplier_iva = 'responsable_inscripto' then
      case
        when p_buyer_iva = 'responsable_inscripto' then array['A', 'M']
        when p_buyer_iva in ('monotributo', 'monotributo_social') then array['A', 'B']
        when p_buyer_iva in ('exento', 'no_alcanzado') then array['B']
        else array['A', 'B', 'M']
      end
    else null
  end;
$$;
grant execute on function public.supplier_invoice_letters(text, text) to authenticated, service_role;

create or replace function public.trg_supplier_invoice_letter()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sup  text;
  v_buy  text;
  v_ok   text[];
begin
  if tg_op = 'UPDATE' and new.letter is not distinct from old.letter
     and new.supplier_id is not distinct from old.supplier_id then
    return new;
  end if;
  select iva_condition into v_sup from suppliers where id = new.supplier_id;
  select iva_condition into v_buy from tax_settings where tenant_id = new.tenant_id;
  v_ok := supplier_invoice_letters(v_sup, v_buy);
  if v_ok is not null and not (new.letter = any (v_ok)) then
    raise exception 'invoice_letter_mismatch'
      using detail = 'Letras posibles: ' || array_to_string(v_ok, ', '), errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.trg_supplier_invoice_letter() from public, anon, authenticated;

drop trigger if exists supplier_invoice_letter on public.supplier_invoices;
create trigger supplier_invoice_letter
  before insert or update of letter, supplier_id on public.supplier_invoices
  for each row execute function public.trg_supplier_invoice_letter();

-- -----------------------------------------------------------------------------
-- D) Asiento de la venta e IVA Ventas con los impuestos de la venta
-- -----------------------------------------------------------------------------
-- Cuentas de la plantilla para lo que se cobra por cuenta de terceros en la
-- venta, para los negocios que ya tienen la contabilidad y para los nuevos
-- (se completan al primer asiento). No pisa cuentas ni mapeos existentes.
create or replace function public._acc_sales_tax_setup(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent uuid;
  v_next   int;
  r        record;
begin
  if not exists (select 1 from acc_accounts where tenant_id = p_tenant and deleted_at is null) then
    return;
  end if;
  select id into v_parent from acc_accounts
   where tenant_id = p_tenant and code = '2.1.02' and deleted_at is null;
  for r in select * from (values
             ('perc_iibb_practicadas', 'Percepciones de IIBB practicadas a depositar'),
             ('perc_iva_practicadas',  'Percepciones de IVA practicadas a depositar'),
             ('internos_a_pagar',      'Impuestos internos a pagar')) as t(skey, name) loop
    continue when exists (select 1 from acc_accounts
                           where tenant_id = p_tenant and system_key = r.skey and deleted_at is null);
    select coalesce(max(nullif(regexp_replace(code, '^2\.1\.02\.', ''), code)::int), 0) + 1 into v_next
      from acc_accounts
     where tenant_id = p_tenant and deleted_at is null and code ~ '^2\.1\.02\.[0-9]+$';
    insert into acc_accounts (tenant_id, code, name, kind, imputable, system_key, parent_id)
    values (p_tenant, '2.1.02.' || lpad(v_next::text, 2, '0'), r.name, 'pasivo', true, r.skey, v_parent);
  end loop;

  insert into acc_mappings (tenant_id, concept, qualifier, account_id)
  select p_tenant, m.concept, m.qualifier, a.id
    from (values
            ('percepcion_venta', '*',    'perc_iibb_practicadas'),
            ('percepcion_venta', 'iibb', 'perc_iibb_practicadas'),
            ('percepcion_venta', 'iva',  'perc_iva_practicadas'),
            ('internos_venta',   '*',    'internos_a_pagar')) as m(concept, qualifier, skey)
    join acc_accounts a on a.tenant_id = p_tenant and a.system_key = m.skey and a.deleted_at is null
   where not exists (select 1 from acc_mappings x
                      where x.tenant_id = p_tenant and x.concept = m.concept and x.qualifier = m.qualifier)
  on conflict do nothing;
end;
$$;
revoke all on function public._acc_sales_tax_setup(uuid) from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in select tenant_id from acc_settings loop
    perform _acc_sales_tax_setup(r.tenant_id);
  end loop;
end;
$$;

-- acc_sync_sale: definición viva (desde 20261227100100). Con renglones de
-- impuestos, el IVA, las percepciones y los internos salen de sale_tax_lines
-- y Ventas es el total menos esos impuestos (siempre balancea).
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
  v_taxes numeric := 0;
  p payments%rowtype;
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
      v_lines := v_lines || acc_line(acc_payment_account(p_tenant, p, s.store_id), p.amount, 'Cobro ' || p.method);
      v_paid := v_paid + p.amount;
      if p.method = 'cash' then
        v_cash_acc := acc_account_for(p_tenant, 'cobro', 'cash', s.store_id);
      end if;
    end loop;

    if coalesce(s.tip_amount, 0) > 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'propinas', '*', s.store_id), -s.tip_amount, 'Propina');
    end if;

    if cfg.vat_mode <> 'none'
       and exists (select 1 from sale_tax_lines t where t.sale_id = s.id and t.tenant_id = p_tenant) then
      perform _acc_sales_tax_setup(p_tenant);
      for v in
        select t.kind, t.tax, t.rate, round(sum(t.amount), 2) as amt
          from sale_tax_lines t
         where t.sale_id = s.id and t.tenant_id = p_tenant
         group by t.kind, t.tax, t.rate
         order by t.kind, t.rate desc loop
        continue when v.amt = 0;
        if v.kind = 'iva' then
          v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'iva_df', acc_rate_text(v.rate), s.store_id),
                                         -v.amt, 'IVA ' || acc_rate_text(v.rate) || ' %');
        elsif v.kind = 'internos' then
          v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'internos_venta', '*', s.store_id),
                                         -v.amt, 'Impuestos internos');
        else
          v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'percepcion_venta', v.tax, s.store_id),
                                         -v.amt, 'Percepción ' || upper(v.tax));
        end if;
        v_taxes := v_taxes + v.amt;
      end loop;
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'ventas', '*', s.store_id),
                                     -(round(s.total, 2) - v_taxes), 'Ventas');
    else
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
    end if;

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
revoke all on function acc_sync_sale(uuid, uuid) from public, anon, authenticated;

-- acc_vat_sales: definición viva (desde 20261029100300). Ventas y
-- anulaciones con renglones de IVA toman neto e IVA de sale_tax_lines (las
-- percepciones y los internos no son IVA); el resto, como antes.
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
           s.id as sale_ref, s.total as tot,
           (select coalesce(jsonb_agg(jsonb_build_object('amount', si.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
              from sale_items si left join products pr on pr.id = si.product_id where si.sale_id = s.id) as items
      from sales s
     where s.tenant_id = v_tenant and s.status in ('completed', 'voided')
       and s.created_at >= acc_ar_start(p_from) and s.created_at < acc_ar_start(p_to + 1)
    union all
    select acc_ar_date(s.voided_at), s.store_id, 'anulacion', -1, s.id, s.id, s.total,
           (select coalesce(jsonb_agg(jsonb_build_object('amount', si.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
              from sale_items si left join products pr on pr.id = si.product_id where si.sale_id = s.id)
      from sales s
     where s.tenant_id = v_tenant and s.status = 'voided'
       and s.voided_at >= acc_ar_start(p_from) and s.voided_at < acc_ar_start(p_to + 1)
    union all
    select acc_ar_date(r.created_at), s.store_id, 'devolucion', -1, r.id, null::uuid, r.total,
           (select coalesce(jsonb_agg(jsonb_build_object('amount', ri.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
              from sale_return_items ri
              join sale_items si on si.id = ri.sale_item_id
              left join products pr on pr.id = si.product_id
             where ri.return_id = r.id)
      from sale_returns r join sales s on s.id = r.sale_id
     where r.tenant_id = v_tenant
       and r.created_at >= acc_ar_start(p_from) and r.created_at < acc_ar_start(p_to + 1)
  ),
  tagged as (
    select docs.*,
           (cfg.vat_mode <> 'none' and docs.sale_ref is not null
            and exists (select 1 from sale_tax_lines t
                         where t.sale_id = docs.sale_ref and t.tenant_id = v_tenant and t.kind = 'iva')) as by_lines
      from docs
  ),
  split as (
    select tg.d, tg.st, tg.k, tg.sg, tg.doc, round(t.rate, 2) as r,
           sum(t.base) as n, sum(t.amount) as v, sum(t.base + t.amount) as g
      from tagged tg
      join sale_tax_lines t on t.sale_id = tg.sale_ref and t.tenant_id = v_tenant and t.kind = 'iva'
     where tg.by_lines
     group by tg.d, tg.st, tg.k, tg.sg, tg.doc, round(t.rate, 2)
    union all
    select tg.d, tg.st, tg.k, tg.sg, tg.doc, round(x.rate, 2), x.net, x.vat, x.gross
      from tagged tg
      cross join lateral acc_vat_split(tg.tot, tg.items, cfg.vat_mode, cfg.default_vat_rate) x
     where not tg.by_lines
  )
  select split.d, split.st, split.k, split.r,
         sum(split.sg * split.n)::numeric, sum(split.sg * split.v)::numeric, sum(split.sg * split.g)::numeric,
         count(distinct split.doc)
    from split
   group by split.d, split.st, split.k, split.r
   order by split.d, split.k, split.r desc;
end;
$$;
revoke all on function acc_vat_sales(date, date) from public, anon;
grant execute on function acc_vat_sales(date, date) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Producto no bonificable
-- -----------------------------------------------------------------------------
alter table public.products add column if not exists no_discount boolean not null default false;
comment on column public.products.no_discount is
  'H158: no acepta descuento manual (renglón ni general); promociones y cupones sí.';

create or replace function public.trg_sale_item_no_discount()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.discount, 0) > 0 and new.product_id is not null
     and exists (select 1 from products p where p.id = new.product_id and p.no_discount) then
    raise exception 'product_not_discountable'
      using detail = new.product_name, errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.trg_sale_item_no_discount() from public, anon, authenticated;

drop trigger if exists sale_item_no_discount on public.sale_items;
create trigger sale_item_no_discount
  before insert on public.sale_items
  for each row execute function public.trg_sale_item_no_discount();

-- El descuento general se reparte sobre lo bonificable: al cerrar la
-- transacción (los renglones ya están), no puede superarlo.
create or replace function public.trg_sale_discount_bonificable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok numeric;
begin
  if coalesce(new.discount_total, 0) <= 0 then
    return null;
  end if;
  if not exists (select 1 from sale_items si join products p on p.id = si.product_id
                  where si.sale_id = new.id and p.no_discount) then
    return null;
  end if;
  select coalesce(sum(si.subtotal), 0) into v_ok
    from sale_items si left join products p on p.id = si.product_id
   where si.sale_id = new.id and not coalesce(p.no_discount, false);
  if new.discount_total > v_ok + 0.01 then
    raise exception 'discount_not_discountable'
      using detail = 'Bonificable ' || v_ok::text, errcode = 'P0001';
  end if;
  return null;
end;
$$;
revoke all on function public.trg_sale_discount_bonificable() from public, anon, authenticated;

drop trigger if exists sale_discount_bonificable on public.sales;
create constraint trigger sale_discount_bonificable
  after insert on public.sales
  deferrable initially deferred
  for each row when (coalesce(new.discount_total, 0) > 0)
  execute function public.trg_sale_discount_bonificable();
