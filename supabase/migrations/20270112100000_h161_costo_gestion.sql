-- =============================================================================
-- 20270112100000_h161_costo_gestion  (F24 · H161, ADR-174)
--
-- Costo en la venta y reportes de gestión (auditoría de InfoManager IM5):
--
--   A) sale_items.unit_cost: el costo del producto en el momento de vender
--      (trigger BEFORE INSERT). Las ventas anteriores se completan con el costo
--      de hoy marcadas como aproximadas (cost_source = 'backfill').
--      stock_movements.unit_cost igual, para valorizar los movimientos.
--   B) CMV del asiento de la venta y de la devolución, y el margen del
--      comparativo de sucursales, con el costo del renglón (antes: el costo de
--      hoy del producto, que cambia con cada compra).
--   C) Reportes de gestión (Reportes > Gestión):
--        report_collections      cobranzas de cuenta corriente por medio,
--                                persona y caja (reports.view).
--        report_stock_movements  movimientos de stock de todo el catálogo
--                                con filtros y kardex (stock.view).
--        report_dead_stock       mercadería parada: stock sin ventas en N
--                                días, valorizada (metricas_avanzadas; el
--                                valor a costo con reports.costs).
--        report_profitability    rentabilidad mes a mes: ventas netas, CMV,
--                                margen bruto y gastos, contra el período
--                                anterior (metricas_avanzadas + reports.costs).
--      Todos respetan las sucursales del usuario (report_store_filter).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Costo en el renglón y en el movimiento
-- -----------------------------------------------------------------------------
alter table public.sale_items add column if not exists unit_cost numeric(14, 4);
alter table public.sale_items add column if not exists cost_source text;
alter table public.stock_movements add column if not exists unit_cost numeric(14, 4);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sale_items_cost_source_check') then
    alter table public.sale_items add constraint sale_items_cost_source_check
      check (cost_source is null or cost_source in ('sale', 'backfill'));
  end if;
end;
$$;

comment on column public.sale_items.unit_cost is
  'H161: costo unitario del producto al vender (trigger). cost_source: sale (al vender) o backfill (aproximado, costo del día de la migración).';
comment on column public.stock_movements.unit_cost is
  'H161: costo unitario del producto al moverse el stock (trigger).';

create or replace function public.trg_sale_item_unit_cost()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.unit_cost is null and new.product_id is not null then
    select p.cost into new.unit_cost from products p where p.id = new.product_id;
    if new.unit_cost is not null then
      new.cost_source := 'sale';
    end if;
  elsif new.unit_cost is not null and new.cost_source is null then
    new.cost_source := 'sale';
  end if;
  return new;
end;
$$;
revoke all on function public.trg_sale_item_unit_cost() from public, anon, authenticated;

drop trigger if exists sale_item_unit_cost on public.sale_items;
create trigger sale_item_unit_cost
  before insert on public.sale_items
  for each row execute function public.trg_sale_item_unit_cost();

create or replace function public.trg_stock_movement_unit_cost()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.unit_cost is null and new.product_id is not null then
    select p.cost into new.unit_cost from products p where p.id = new.product_id;
  end if;
  return new;
end;
$$;
revoke all on function public.trg_stock_movement_unit_cost() from public, anon, authenticated;

drop trigger if exists stock_movement_unit_cost on public.stock_movements;
create trigger stock_movement_unit_cost
  before insert on public.stock_movements
  for each row execute function public.trg_stock_movement_unit_cost();

-- Ventas anteriores: costo de hoy, marcado como aproximado.
update public.sale_items si
   set unit_cost = p.cost, cost_source = 'backfill'
  from public.products p
 where p.id = si.product_id and si.unit_cost is null and p.cost is not null;

create index if not exists sale_items_product_tenant_idx on public.sale_items (tenant_id, product_id);
create index if not exists stock_movements_tenant_created_idx on public.stock_movements (tenant_id, created_at desc);
create index if not exists cam_tenant_kind_created_idx on public.customer_account_movements (tenant_id, kind, created_at)
  where kind = 'payment';

-- acc_sync_sale: definición viva (desde 20270109100000) con el CMV del renglón.
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
      -- H161: el costo guardado en el renglón al vender (no el de hoy).
      select round(coalesce(sum(si.quantity * coalesce(si.unit_cost, pr.cost, 0)), 0), 2) into v_cost
        from sale_items si left join products pr on pr.id = si.product_id
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

-- acc_sync_sale_return: definición viva (desde 20261217100100) con el costo del renglón.
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
                                           when 'account' then 'account'
                                           when 'mercadopago' then '*:mercadopago'
                                           else 'cash' end,
                      s.store_id),
      -v_rest, case when r.refund_method = 'mercadopago' then 'Reintegro por Mercado Pago' else 'Reintegro' end);
  end if;

  if cfg.cmv_mode = 'perpetual' then
    -- H161: el costo con el que salió (el del renglón de la venta).
    select round(coalesce(sum(ri.quantity * coalesce(si.unit_cost, pr.cost, 0)), 0), 2) into v_cost
      from sale_return_items ri
      join sale_items si on si.id = ri.sale_item_id
      left join products pr on pr.id = si.product_id
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
revoke all on function acc_sync_sale_return(uuid, uuid) from public, anon, authenticated;

-- branch_compare_report: definición viva (desde 20261020140000) con el costo del renglón.
create or replace function branch_compare_report(
  p_from      timestamptz,
  p_to        timestamptz,
  p_store_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_scope  uuid[];
  v_ids    uuid[];
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if p_to - p_from > interval '400 days' then
    raise exception 'range_too_long' using errcode = '22023';
  end if;

  if p_store_ids is not null and cardinality(p_store_ids) > 0 then
    foreach v_id in array p_store_ids loop
      if not exists (select 1 from stores where id = v_id and tenant_id = v_tenant)
         or not coalesce(user_can_access_store(v_id), false) then
        raise exception 'forbidden' using errcode = '42501';
      end if;
    end loop;
    select array_agg(distinct x) into v_ids from unnest(p_store_ids) x;
  else
    v_scope := report_store_filter(null);
    select coalesce(array_agg(s.id order by s.is_default desc, s.sort, s.created_at), '{}'::uuid[])
      into v_ids
      from stores s
     where s.tenant_id = v_tenant
       and (v_scope is null or s.id = any (v_scope))
       and (s.deleted_at is null
            or exists (select 1 from sales sa
                        where sa.tenant_id = v_tenant and sa.store_id = s.id
                          and sa.created_at >= p_from and sa.created_at < p_to));
  end if;

  if cardinality(v_ids) > 1 and not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
    raise exception 'feature_not_in_plan: multi_sucursal' using errcode = '42501';
  end if;

  return (
    with st as (
      select s.id, s.name, s.short_name, s.color, s.is_default, s.sort, s.created_at,
             (s.deleted_at is not null) as archived
        from stores s
       where s.tenant_id = v_tenant and s.id = any (v_ids)
    ),
    sl as (
      select sa.id, sa.store_id, sa.total, sa.status, sa.created_at, sa.customer_id
        from sales sa
       where sa.tenant_id = v_tenant
         and sa.store_id = any (v_ids)
         and sa.created_at >= p_from and sa.created_at < p_to
    ),
    done as (select * from sl where status = 'completed'),
    k as (
      select d.store_id,
             count(*) as cnt,
             coalesce(sum(d.total), 0) as total
        from done d group by d.store_id
    ),
    voids as (
      select store_id, count(*) as cnt, coalesce(sum(total), 0) as total
        from sl where status = 'voided' group by store_id
    ),
    items as (
      select d.store_id,
             coalesce(sum(si.quantity), 0) as qty,
             coalesce(sum(si.subtotal), 0) as amount,
             coalesce(sum(si.subtotal) filter (where coalesce(si.unit_cost, pr.cost) > 0), 0) as amount_with_cost,
             coalesce(sum(si.quantity * coalesce(si.unit_cost, pr.cost)) filter (where coalesce(si.unit_cost, pr.cost) > 0), 0) as cost
        from done d
        join sale_items si on si.sale_id = d.id
        left join products pr on pr.id = si.product_id
       group by d.store_id
    ),
    rets as (
      select sa.store_id, count(*) as cnt, coalesce(sum(r.total), 0) as total
        from sale_returns r
        join sales sa on sa.id = r.sale_id
       where r.tenant_id = v_tenant
         and sa.store_id = any (v_ids)
         and r.created_at >= p_from and r.created_at < p_to
       group by sa.store_id
    ),
    pays as (
      select d.store_id, p.method, coalesce(sum(p.amount), 0) as total, count(*) as cnt
        from done d join payments p on p.sale_id = d.id
       group by d.store_id, p.method
    ),
    days as (
      select d.store_id,
             to_char((d.created_at at time zone 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') as day,
             coalesce(sum(d.total), 0) as total, count(*) as cnt
        from done d group by 1, 2
    ),
    zs as (
      select z.store_id, count(*) as cnt,
             coalesce(sum(z.difference), 0) as diff,
             coalesce(sum(abs(z.difference)), 0) as diff_abs,
             count(*) filter (where z.difference <> 0) as with_diff
        from cash_z_closures z
       where z.tenant_id = v_tenant and z.store_id = any (v_ids)
         and z.closed_at >= p_from and z.closed_at < p_to
       group by z.store_id
    ),
    cust as (
      select d.store_id,
             count(distinct d.customer_id) as buyers,
             count(distinct d.customer_id) filter (where exists (
               select 1 from sales prev
                where prev.tenant_id = v_tenant and prev.customer_id = d.customer_id
                  and prev.status = 'completed' and prev.created_at < p_from)) as returning_buyers
        from done d where d.customer_id is not null
       group by d.store_id
    ),
    alta as (
      select c.store_id_alta as store_id, count(*) as cnt
        from customers c
       where c.tenant_id = v_tenant and c.store_id_alta = any (v_ids)
         and c.created_at >= p_from and c.created_at < p_to and c.deleted_at is null
       group by c.store_id_alta
    ),
    rs as (
      select st.*,
             coalesce(k.cnt, 0) as cnt,
             coalesce(k.total, 0) as total,
             coalesce(i.qty, 0) as qty,
             coalesce(i.amount, 0) as amount,
             coalesce(i.amount_with_cost, 0) as amount_with_cost,
             coalesce(i.cost, 0) as cost,
             coalesce(v.cnt, 0) as voids_count,
             coalesce(v.total, 0) as voids_total,
             coalesce(r.cnt, 0) as returns_count,
             coalesce(r.total, 0) as returns_total,
             coalesce(z.cnt, 0) as z_count,
             coalesce(z.diff, 0) as cash_diff,
             coalesce(z.diff_abs, 0) as cash_diff_abs,
             coalesce(z.with_diff, 0) as z_with_diff,
             coalesce(c.buyers, 0) as buyers,
             coalesce(c.returning_buyers, 0) as returning_buyers,
             coalesce(a.cnt, 0) as new_customers
        from st
        left join k on k.store_id = st.id
        left join items i on i.store_id = st.id
        left join voids v on v.store_id = st.id
        left join rets r on r.store_id = st.id
        left join zs z on z.store_id = st.id
        left join cust c on c.store_id = st.id
        left join alta a on a.store_id = st.id
    )
    select jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'stores', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'store_id', x.id, 'name', x.name, 'short_name', x.short_name, 'color', x.color,
                 'archived', x.archived,
                 'total', x.total, 'count', x.cnt,
                 'avg_ticket', case when x.cnt > 0 then round(x.total / x.cnt, 2) else 0 end,
                 'items_qty', x.qty,
                 'voids_count', x.voids_count, 'voids_total', x.voids_total,
                 'returns_count', x.returns_count, 'returns_total', x.returns_total,
                 'net_total', x.total - x.returns_total,
                 'margin', x.amount_with_cost - x.cost,
                 'margin_pct', case when x.amount_with_cost > 0
                                    then round((x.amount_with_cost - x.cost) / x.amount_with_cost * 100, 1) end,
                 'cost_coverage_pct', case when x.amount > 0
                                           then round(x.amount_with_cost / x.amount * 100, 1) else 0 end,
                 'z_count', x.z_count, 'cash_diff', x.cash_diff, 'cash_diff_abs', x.cash_diff_abs,
                 'z_with_diff', x.z_with_diff,
                 'buyers', x.buyers, 'returning_buyers', x.returning_buyers,
                 'new_customers', x.new_customers,
                 'by_method', coalesce((
                    select jsonb_agg(jsonb_build_object('method', p.method, 'total', p.total, 'count', p.cnt)
                                     order by p.total desc)
                      from pays p where p.store_id = x.id), '[]'::jsonb),
                 'by_day', coalesce((
                    select jsonb_agg(jsonb_build_object('day', d.day, 'total', d.total, 'count', d.cnt)
                                     order by d.day)
                      from days d where d.store_id = x.id), '[]'::jsonb))
                 order by x.is_default desc, x.sort, x.created_at)
          from rs x), '[]'::jsonb),
      'totals', (
        select jsonb_build_object(
                 'total', coalesce(sum(x.total), 0),
                 'count', coalesce(sum(x.cnt), 0),
                 'avg_ticket', case when coalesce(sum(x.cnt), 0) > 0
                                    then round(sum(x.total) / sum(x.cnt), 2) else 0 end,
                 'items_qty', coalesce(sum(x.qty), 0),
                 'returns_total', coalesce(sum(x.returns_total), 0),
                 'voids_total', coalesce(sum(x.voids_total), 0),
                 'margin', coalesce(sum(x.amount_with_cost - x.cost), 0),
                 'margin_pct', case when coalesce(sum(x.amount_with_cost), 0) > 0
                                    then round(sum(x.amount_with_cost - x.cost) / sum(x.amount_with_cost) * 100, 1) end,
                 'cost_coverage_pct', case when coalesce(sum(x.amount), 0) > 0
                                           then round(sum(x.amount_with_cost) / sum(x.amount) * 100, 1) else 0 end,
                 'cash_diff', coalesce(sum(x.cash_diff), 0),
                 'new_customers', coalesce(sum(x.new_customers), 0))
          from rs x)
    )
  );
end;
$$;
revoke all on function branch_compare_report(timestamptz, timestamptz, uuid[]) from public, anon;
grant execute on function branch_compare_report(timestamptz, timestamptz, uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Reportes de gestión
-- -----------------------------------------------------------------------------
create or replace function public._report_guard(p_cap text, p_feature text default null)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not coalesce(has_capability(p_cap), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_feature is not null and not tenant_has_feature_for(v_tenant, p_feature) then
    raise exception 'feature_not_in_plan: %', p_feature using errcode = 'check_violation';
  end if;
  return v_tenant;
end;
$$;
revoke all on function public._report_guard(text, text) from public, anon;
grant execute on function public._report_guard(text, text) to authenticated;

-- Cobranzas de cuenta corriente del período: por medio, por persona y por caja,
-- más el detalle (últimos 500). Sin anulados. Con sucursal elegida o alcance
-- parcial, sólo los cobros hechos en un turno de esas sucursales.
create or replace function public.report_collections(p_from timestamptz, p_to timestamptz, p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _report_guard('reports.view');
  v_ids    uuid[];
  v_out    jsonb;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'invalid_range';
  end if;
  v_ids := report_store_filter(p_store_id);
  with m as (
    select m.id, m.created_at, round(-m.delta, 2) as amount, coalesce(m.method, 'other') as method,
           m.created_by, m.receipt_no, m.customer_id, cs.cash_register_id, cs.store_id
      from customer_account_movements m
      left join cash_shifts cs on cs.id = m.cash_shift_id
     where m.tenant_id = v_tenant and m.kind = 'payment' and m.voided_at is null
       and m.created_at >= p_from and m.created_at < p_to
       and (v_ids is null or cs.store_id = any (v_ids))
  ),
  bm as (
    select method, round(sum(amount), 2) as amount, count(*) as n from m group by method
  ),
  bu as (
    select m.created_by, coalesce(nullif(btrim(u.full_name), ''), u.email, 'Sin usuario') as name,
           round(sum(m.amount), 2) as amount, count(*) as n
      from m left join users u on u.id = m.created_by
     group by m.created_by, u.full_name, u.email
  ),
  br as (
    select m.cash_register_id, coalesce(cr.name, 'Sin caja') as name, round(sum(m.amount), 2) as amount, count(*) as n
      from m left join cash_registers cr on cr.id = m.cash_register_id
     group by m.cash_register_id, cr.name
  ),
  det as (
    select m.*, c.name as customer_name, coalesce(nullif(btrim(u.full_name), ''), u.email) as user_name,
           cr.name as register_name
      from m
      left join customers c on c.id = m.customer_id
      left join users u on u.id = m.created_by
      left join cash_registers cr on cr.id = m.cash_register_id
     order by m.created_at desc
     limit 500
  )
  select jsonb_build_object(
    'total', coalesce((select round(sum(amount), 2) from m), 0),
    'count', (select count(*) from m),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'amount', amount, 'count', n)
                                            order by amount desc) from bm), '[]'::jsonb),
    'by_user', coalesce((select jsonb_agg(jsonb_build_object('user_id', created_by, 'name', name, 'amount', amount, 'count', n)
                                          order by amount desc) from bu), '[]'::jsonb),
    'by_register', coalesce((select jsonb_agg(jsonb_build_object('register_id', cash_register_id, 'name', name,
                                                                 'amount', amount, 'count', n)
                                              order by amount desc) from br), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'id', id, 'created_at', created_at, 'amount', amount, 'method', method,
               'receipt_no', receipt_no, 'customer_id', customer_id, 'customer_name', customer_name,
               'user_name', user_name, 'register_name', register_name) order by created_at desc) from det), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;
revoke all on function public.report_collections(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.report_collections(timestamptz, timestamptz, uuid) to authenticated;

-- Movimientos de stock de todo el catálogo (o de un producto, con saldo
-- corrido: kardex). El costo, sólo con reports.costs.
create or replace function public.report_stock_movements(
  p_from       timestamptz,
  p_to         timestamptz,
  p_store_id   uuid default null,
  p_product_id uuid default null,
  p_reason     text default null,
  p_limit      int default 200,
  p_offset     int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _report_guard('stock.view');
  v_ids     uuid[];
  v_costs   boolean := coalesce(has_capability('reports.costs'), false);
  v_limit   int := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_offset  int := greatest(coalesce(p_offset, 0), 0);
  v_opening numeric;
  v_out     jsonb;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'invalid_range';
  end if;
  if p_reason is not null and p_reason !~ '^[a-z_]{2,30}$' then raise exception 'invalid_reason'; end if;
  v_ids := report_store_filter(p_store_id);
  if p_product_id is not null then
    select coalesce(sum(sm.delta), 0) into v_opening
      from stock_movements sm
     where sm.tenant_id = v_tenant and sm.product_id = p_product_id and sm.created_at < p_from
       and (v_ids is null or sm.store_id = any (v_ids));
  end if;
  with mv as (
    select sm.*
      from stock_movements sm
     where sm.tenant_id = v_tenant
       and sm.created_at >= p_from and sm.created_at < p_to
       and (v_ids is null or sm.store_id = any (v_ids))
       and (p_product_id is null or sm.product_id = p_product_id)
       and (p_reason is null or sm.reason = p_reason)
  ),
  numbered as (
    select mv.*,
           case when p_product_id is not null
                then v_opening + sum(mv.delta) over (order by mv.created_at, mv.id rows unbounded preceding)
           end as balance
      from mv
  ),
  page as (
    select n.*, p.name as product_name, p.sku, st.name as store_name,
           coalesce(nullif(btrim(u.full_name), ''), u.email) as user_name
      from numbered n
      left join products p on p.id = n.product_id
      left join stores st on st.id = n.store_id
      left join users u on u.id = n.created_by
     order by n.created_at desc, n.id desc
     limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total_count', (select count(*) from mv),
    'in', coalesce((select sum(delta) from mv where delta > 0), 0),
    'out', coalesce((select -sum(delta) from mv where delta < 0), 0),
    'opening', v_opening,
    'closing', case when p_product_id is not null then v_opening + coalesce((select sum(delta) from mv), 0) end,
    'by_reason', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'count', n, 'qty', q) order by n desc)
                             from (select reason, count(*) as n, sum(delta) as q from mv group by reason) r), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'id', id, 'created_at', created_at, 'product_id', product_id, 'product_name', product_name, 'sku', sku,
               'store_name', store_name, 'delta', delta, 'reason', reason, 'loss_reason', loss_reason, 'notes', notes,
               'reference_id', reference_id, 'user_name', user_name, 'balance', balance,
               'unit_cost', case when v_costs then unit_cost end)
             order by created_at desc, id desc) from page), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;
revoke all on function public.report_stock_movements(timestamptz, timestamptz, uuid, uuid, text, int, int) from public, anon;
grant execute on function public.report_stock_movements(timestamptz, timestamptz, uuid, uuid, text, int, int) to authenticated;

-- Mercadería parada: productos con stock que no se venden hace N días (o
-- nunca), con los días sin salida y el valor a precio (y a costo con
-- reports.costs). Con sucursal, el stock de esas sucursales.
create or replace function public.report_dead_stock(p_days int default 90, p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _report_guard('reports.view', 'metricas_avanzadas');
  v_ids    uuid[];
  v_costs  boolean := coalesce(has_capability('reports.costs'), false);
  v_days   int := least(greatest(coalesce(p_days, 90), 1), 3650);
  v_out    jsonb;
begin
  v_ids := report_store_filter(p_store_id);
  with stockq as (
    select p.id, p.name, p.sku, p.price, p.cost, p.category_id,
           case when v_ids is null then p.stock
                else coalesce((select sum(ps.qty) from product_stock ps
                                where ps.product_id = p.id and ps.store_id = any (v_ids)), 0) end as qty
      from products p
     where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active
       and coalesce(p.track_stock, true) and not coalesce(p.is_kit, false)
  ),
  last_sale as (
    select si.product_id, max(sa.created_at) as at
      from sale_items si
      join sales sa on sa.id = si.sale_id
     where si.tenant_id = v_tenant and sa.status = 'completed'
       and (v_ids is null or sa.store_id = any (v_ids))
     group by si.product_id
  ),
  dead as (
    select s.*, ls.at as last_sale_at,
           case when ls.at is null then null
                else (current_date - (ls.at at time zone 'America/Argentina/Buenos_Aires')::date) end as days
      from stockq s
      left join last_sale ls on ls.product_id = s.id
     where s.qty > 0
       and (ls.at is null or ls.at < now() - make_interval(days => v_days))
  )
  select jsonb_build_object(
    'days', v_days,
    'count', (select count(*) from dead),
    'never_sold', (select count(*) from dead where last_sale_at is null),
    'value_price', coalesce((select round(sum(qty * coalesce(price, 0)), 2) from dead), 0),
    'value_cost', case when v_costs then coalesce((select round(sum(qty * coalesce(cost, 0)), 2) from dead), 0) end,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'product_id', d.id, 'name', d.name, 'sku', d.sku, 'category', c.name, 'qty', d.qty,
               'last_sale_at', d.last_sale_at, 'days', d.days,
               'value_price', round(d.qty * coalesce(d.price, 0), 2),
               'value_cost', case when v_costs then round(d.qty * coalesce(d.cost, 0), 2) end)
             order by d.qty * coalesce(d.price, 0) desc)
             from (select * from dead order by qty * coalesce(price, 0) desc limit 1000) d
             left join categories c on c.id = d.category_id), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;
revoke all on function public.report_dead_stock(int, uuid) from public, anon;
grant execute on function public.report_dead_stock(int, uuid) to authenticated;

-- Rentabilidad mes a mes (hora argentina): ventas, impuestos de la venta,
-- devoluciones, costo de lo vendido (costo del renglón), margen bruto, gastos
-- de Tesorería con cuenta de gasto (sólo sin filtro de sucursal: son del
-- negocio) y resultado. Más el mismo cálculo del período anterior parejo.
create or replace function public.report_profitability(p_from date, p_to date, p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _report_guard('reports.costs', 'metricas_avanzadas');
  v_ids    uuid[];
  v_tz     constant text := 'America/Argentina/Buenos_Aires';
  v_len    int;
  v_pfrom  date;
  v_pto    date;
  v_out    jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then raise exception 'invalid_range'; end if;
  v_ids := report_store_filter(p_store_id);
  v_len := p_to - p_from + 1;
  v_pto := p_from - 1;
  v_pfrom := p_from - v_len;

  with per as (
    select 'current'::text as k, p_from as f, p_to as t
    union all select 'previous', v_pfrom, v_pto
  ),
  s as (
    select per.k, sa.id, sa.total, date_trunc('month', sa.created_at at time zone v_tz)::date as m
      from per
      join sales sa on sa.tenant_id = v_tenant and sa.status = 'completed'
       and sa.created_at >= (per.f::timestamp at time zone v_tz)
       and sa.created_at < ((per.t + 1)::timestamp at time zone v_tz)
       and (v_ids is null or sa.store_id = any (v_ids))
  ),
  taxes as (
    select s.id, coalesce(sum(t.amount), 0) as tax
      from s join sale_tax_lines t on t.sale_id = s.id and t.tenant_id = v_tenant
     group by s.id
  ),
  cogs as (
    select s.id,
           coalesce(sum(si.quantity * coalesce(si.unit_cost, pr.cost, 0)), 0) as cmv,
           coalesce(sum(si.subtotal), 0) as items_amount,
           coalesce(sum(si.subtotal) filter (where coalesce(si.unit_cost, pr.cost) > 0), 0) as items_with_cost,
           bool_or(si.cost_source = 'backfill') as approx
      from s join sale_items si on si.sale_id = s.id
      left join products pr on pr.id = si.product_id
     group by s.id
  ),
  rets as (
    select per.k, date_trunc('month', r.created_at at time zone v_tz)::date as m,
           r.total, coalesce((select sum(ri.quantity * coalesce(si.unit_cost, pr.cost, 0))
                                from sale_return_items ri
                                join sale_items si on si.id = ri.sale_item_id
                                left join products pr on pr.id = si.product_id
                               where ri.return_id = r.id), 0) as cost_back
      from per
      join sale_returns r on r.tenant_id = v_tenant
       and r.created_at >= (per.f::timestamp at time zone v_tz)
       and r.created_at < ((per.t + 1)::timestamp at time zone v_tz)
      join sales sa on sa.id = r.sale_id and (v_ids is null or sa.store_id = any (v_ids))
  ),
  exp as (
    select per.k, date_trunc('month', tm.movement_date)::date as m, tm.amount
      from per
      join treasury_movements tm on tm.tenant_id = v_tenant and v_ids is null
       and tm.type = 'withdrawal' and tm.expense_account_id is not null and tm.voided_at is null
       and tm.movement_date between per.f and per.t
  ),
  months as (
    select k, m from s union select k, m from rets union select k, m from exp
  ),
  agg as (
    select mo.k, mo.m,
           coalesce((select sum(s.total) from s where s.k = mo.k and s.m = mo.m), 0) as sales,
           coalesce((select sum(tx.tax) from s join taxes tx on tx.id = s.id where s.k = mo.k and s.m = mo.m), 0) as taxes,
           coalesce((select sum(c.cmv) from s join cogs c on c.id = s.id where s.k = mo.k and s.m = mo.m), 0) as cmv,
           coalesce((select sum(c.items_amount) from s join cogs c on c.id = s.id where s.k = mo.k and s.m = mo.m), 0) as items_amount,
           coalesce((select sum(c.items_with_cost) from s join cogs c on c.id = s.id where s.k = mo.k and s.m = mo.m), 0) as items_with_cost,
           coalesce((select bool_or(c.approx) from s join cogs c on c.id = s.id where s.k = mo.k and s.m = mo.m), false) as approx,
           coalesce((select sum(r.total) from rets r where r.k = mo.k and r.m = mo.m), 0) as returns,
           coalesce((select sum(r.cost_back) from rets r where r.k = mo.k and r.m = mo.m), 0) as cost_back,
           coalesce((select sum(e.amount) from exp e where e.k = mo.k and e.m = mo.m), 0) as expenses,
           (select count(*) from s where s.k = mo.k and s.m = mo.m) as sales_count
      from months mo
  ),
  rowsj as (
    select k, jsonb_agg(jsonb_build_object(
             'month', to_char(m, 'YYYY-MM'),
             'sales', round(sales, 2),
             'taxes', round(taxes, 2),
             'net_sales', round(sales - taxes, 2),
             'returns', round(returns, 2),
             'cmv', round(cmv - cost_back, 2),
             'gross_margin', round(sales - taxes - returns - (cmv - cost_back), 2),
             'expenses', round(expenses, 2),
             'result', round(sales - taxes - returns - (cmv - cost_back) - expenses, 2),
             'sales_count', sales_count,
             'cost_coverage_pct', case when items_amount > 0 then round(items_with_cost / items_amount * 100, 1) end,
             'approx', approx) order by m) as j,
           round(sum(sales), 2) as sales, round(sum(taxes), 2) as taxes, round(sum(returns), 2) as returns,
           round(sum(cmv - cost_back), 2) as cmv, round(sum(expenses), 2) as expenses,
           sum(items_amount) as items_amount, sum(items_with_cost) as items_with_cost, bool_or(approx) as approx,
           sum(sales_count) as sales_count
      from agg group by k
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'previous_from', v_pfrom, 'previous_to', v_pto,
    'expenses_included', v_ids is null,
    'months', coalesce((select j from rowsj where k = 'current'), '[]'::jsonb),
    'totals', (select jsonb_build_object('sales', sales, 'taxes', taxes, 'net_sales', sales - taxes, 'returns', returns,
                                         'cmv', cmv, 'gross_margin', sales - taxes - returns - cmv, 'expenses', expenses,
                                         'result', sales - taxes - returns - cmv - expenses, 'sales_count', sales_count,
                                         'cost_coverage_pct', case when items_amount > 0 then round(items_with_cost / items_amount * 100, 1) end,
                                         'approx', approx)
                 from rowsj where k = 'current'),
    'previous', (select jsonb_build_object('sales', sales, 'net_sales', sales - taxes, 'cmv', cmv,
                                           'gross_margin', sales - taxes - returns - cmv, 'expenses', expenses,
                                           'result', sales - taxes - returns - cmv - expenses)
                   from rowsj where k = 'previous'))
    into v_out;
  return v_out;
end;
$$;
revoke all on function public.report_profitability(date, date, uuid) from public, anon;
grant execute on function public.report_profitability(date, date, uuid) to authenticated;
