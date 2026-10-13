-- =============================================================================
-- 20261030100200_cliente_360  (F9 · H31b · ADR-067)
--
-- Ficha del cliente 360: todo lo del cliente en una página, con consultas
-- rápidas por RPC y paginación por cursor.
--
--   A) customer_notes: notas internas del cliente (fijables, baja lógica).
--      RLS `tenant_id = current_tenant_id() or internal_scope()` (ADR-052).
--      Escritura sólo por customer_note_add / customer_note_delete
--      (auditadas).
--   B) Índices para leer por cliente (ventas, devoluciones, vales, cobros en
--      espera).
--   C) customer_360_summary(cliente, sucursal?): perfil, datos fiscales,
--      indicadores (total comprado, compras, ticket promedio, primera y última
--      compra, frecuencia, devoluciones, deuda y deuda vencida, saldo a favor,
--      cobros en espera), sucursal de alta y por sucursal, compras por mes
--      (12 meses), productos más comprados, medios de pago usados y el umbral
--      VIP del negocio (percentil 90 de lo comprado en 12 meses). Los
--      segmentos los arma el front con esos datos (lib/customers/c360.ts).
--   D) customer_360_timeline(cliente, tipos?, desde?, hasta?, sucursal?,
--      límite, cursor): línea de tiempo unificada de ventas, devoluciones,
--      movimientos de cuenta corriente, gestiones de cobranza, vales y saldo a
--      favor, cobros en espera, reintegros por Mercado Pago, contracargos y
--      devoluciones de MP y notas. Orden (fecha, id) descendente y cursor
--      (fecha, id) para la página siguiente. Cada rama trae como mucho
--      límite + 1 filas (índices por cliente), así que cuesta lo mismo en
--      clientes con mucha historia.
--
-- Seguridad (SECURITY DEFINER, todo validado acá):
--   • negocio del JWT (current_tenant_id) y membresía activa; el staff
--     interno no lee fichas de clientes por esta vía (ADR-052).
--   • alcance de sucursal: report_store_filter(sucursal) (lo mismo que los
--     reportes): ventas, devoluciones, cobros en espera y reintegros de otras
--     sucursales no se ven ni suman.
--   • contracargos y gestiones de cobranza sólo para dueño o encargado (como
--     sus tablas).
--   • gating real: tenant_has_feature_for(negocio, 'clientes_360').
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Notas internas
-- -----------------------------------------------------------------------------
create table if not exists customer_notes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 2000),
  pinned      boolean not null default false,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id) on delete set null
);
create index if not exists customer_notes_customer_idx
  on customer_notes (tenant_id, customer_id, created_at desc) where deleted_at is null;
create index if not exists customer_notes_created_by_idx on customer_notes (created_by) where created_by is not null;
create index if not exists customer_notes_deleted_by_idx on customer_notes (deleted_by) where deleted_by is not null;

drop trigger if exists set_updated_at_customer_notes on customer_notes;
create trigger set_updated_at_customer_notes
  before update on customer_notes
  for each row execute function set_updated_at();

alter table customer_notes enable row level security;
drop policy if exists customer_notes_select on customer_notes;
create policy customer_notes_select on customer_notes
  for select using (tenant_id = current_tenant_id() or internal_scope());
revoke insert, update, delete on customer_notes from anon, authenticated;
grant select on customer_notes to authenticated;

comment on table customer_notes is
  'ADR-067: notas internas del cliente (ficha 360). Escritura sólo por customer_note_add / customer_note_delete.';

-- ¿Miembro activo del negocio actual? (dueño siempre; el resto con estado activo)
create or replace function _c360_member(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tu.role from tenant_users tu
   where tu.tenant_id = p_tenant and tu.user_id = auth.uid() and tu.status = 'active'
   limit 1;
$$;
revoke all on function _c360_member(uuid) from public, anon, authenticated;

create or replace function _c360_assert(p_customer uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if _c360_member(v_tenant) is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if not tenant_has_feature_for(v_tenant, 'clientes_360') then
    raise exception 'feature_not_in_plan: clientes_360' using errcode = '42501';
  end if;
  if not exists (select 1 from customers c where c.id = p_customer and c.tenant_id = v_tenant) then
    raise exception 'customer_not_found';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _c360_assert(uuid) from public, anon, authenticated;

create or replace function customer_note_add(p_customer uuid, p_body text, p_pinned boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _c360_assert(p_customer);
  v_body   text := btrim(coalesce(p_body, ''));
  v_row    customer_notes%rowtype;
begin
  if char_length(v_body) < 1 then raise exception 'note_empty'; end if;
  if char_length(v_body) > 2000 then raise exception 'note_too_long'; end if;
  insert into customer_notes (tenant_id, customer_id, body, pinned, created_by)
  values (v_tenant, p_customer, v_body, coalesce(p_pinned, false), auth.uid())
  returning * into v_row;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'customers', p_customer, 'customer_note_added',
          jsonb_build_object('note_id', v_row.id, 'pinned', v_row.pinned, 'length', char_length(v_body)));
  return to_jsonb(v_row);
end;
$$;
revoke all on function customer_note_add(uuid, text, boolean) from public, anon;
grant execute on function customer_note_add(uuid, text, boolean) to authenticated;

-- Baja lógica: la autora o un dueño o encargado.
create or replace function customer_note_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_row    customer_notes%rowtype;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  select * into v_row from customer_notes
   where id = p_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then raise exception 'note_not_found'; end if;
  if v_row.created_by is distinct from auth.uid() and not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update customer_notes set deleted_at = now(), deleted_by = auth.uid() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'customers', v_row.customer_id, 'customer_note_deleted',
          jsonb_build_object('note_id', p_id, 'body', left(v_row.body, 200)));
end;
$$;
revoke all on function customer_note_delete(uuid) from public, anon;
grant execute on function customer_note_delete(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Índices por cliente
-- -----------------------------------------------------------------------------
create index if not exists sales_customer_created_idx
  on sales (tenant_id, customer_id, created_at desc) where customer_id is not null;
create index if not exists sale_returns_customer_idx
  on sale_returns (tenant_id, customer_id, created_at desc) where customer_id is not null;
create index if not exists store_credit_movements_customer_created_idx
  on store_credit_movements (tenant_id, customer_id, created_at desc);
create index if not exists cam_customer_created_idx
  on customer_account_movements (tenant_id, customer_id, created_at desc);
create index if not exists pending_charges_customer_idx
  on pending_charges (tenant_id, customer_id, created_at desc) where customer_id is not null;

-- -----------------------------------------------------------------------------
-- C) Resumen
-- -----------------------------------------------------------------------------
create or replace function customer_360_summary(p_customer uuid, p_store uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _c360_assert(p_customer);
  v_ids     uuid[] := report_store_filter(p_store);
  v_manager boolean := is_tenant_manager();
  v_today   date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_profile jsonb;
  v_kpis    jsonb;
  v_vip     numeric;
begin
  select to_jsonb(c) - 'account_config' - 'metadata'
         || jsonb_build_object(
              'group_name', g.name,
              'store_alta_name', st.name)
    into v_profile
    from customers c
    left join customer_groups g on g.id = c.group_id and g.tenant_id = v_tenant
    left join stores st on st.id = c.store_id_alta and st.tenant_id = v_tenant
   where c.id = p_customer and c.tenant_id = v_tenant;

  with s as (
    select sa.id, sa.total, sa.created_at
      from sales sa
     where sa.tenant_id = v_tenant and sa.customer_id = p_customer and sa.status = 'completed'
       and (v_ids is null or sa.store_id = any (v_ids))
  ),
  agg as (
    select count(*) as cnt, coalesce(sum(total), 0) as total,
           min(created_at) as first_at, max(created_at) as last_at,
           count(*) filter (where created_at >= now() - interval '90 days') as cnt_90,
           coalesce(sum(total) filter (where created_at >= now() - interval '365 days'), 0) as total_365
      from s
  ),
  ret as (
    select count(*) as cnt, coalesce(sum(r.total), 0) as total
      from sale_returns r
      join sales sa on sa.id = r.sale_id and sa.tenant_id = v_tenant
     where r.tenant_id = v_tenant
       and (r.customer_id = p_customer or sa.customer_id = p_customer)
       and (v_ids is null or sa.store_id = any (v_ids))
  ),
  acc as (
    select coalesce(round(sum(m.delta), 2), 0) as balance
      from customer_account_movements m
     where m.tenant_id = v_tenant and m.customer_id = p_customer and m.voided_at is null
  ),
  ovd as (
    select coalesce(round(sum(d.open_amount), 2), 0) as overdue,
           min(d.due_date) filter (where d.due_date >= v_today) as next_due
      from account_open_debits(v_tenant, p_customer) d
  ),
  ovd_late as (
    select coalesce(round(sum(d.open_amount), 2), 0) as overdue
      from account_open_debits(v_tenant, p_customer) d
     where d.due_date < v_today
  ),
  cr as (
    select coalesce(round(sum(m.delta), 2), 0) as balance
      from store_credit_movements m
     where m.tenant_id = v_tenant and m.customer_id = p_customer
  ),
  pc as (
    select count(*) as cnt, coalesce(sum(amount), 0) as total
      from pending_charges p
     where p.tenant_id = v_tenant and p.customer_id = p_customer and p.status = 'waiting'
       and (v_ids is null or p.store_id = any (v_ids))
  ),
  dis as (
    select count(*) as cnt
      from payment_disputes d
      join sales sa on sa.id = d.sale_id and sa.tenant_id = v_tenant
     where v_manager and d.tenant_id = v_tenant and sa.customer_id = p_customer
       and d.deleted_at is null and d.kind in ('chargeback', 'claim') and d.resolved_at is null
       and (v_ids is null or sa.store_id = any (v_ids))
  )
  select jsonb_build_object(
           'purchases', agg.cnt,
           'total', round(agg.total, 2),
           'avg_ticket', case when agg.cnt > 0 then round(agg.total / agg.cnt, 2) else 0 end,
           'first_at', agg.first_at,
           'last_at', agg.last_at,
           'days_since_last', case when agg.last_at is not null
                                   then (v_today - (agg.last_at at time zone 'America/Argentina/Buenos_Aires')::date) end,
           'frequency_days', case when agg.cnt > 1
                                  then round(extract(epoch from (agg.last_at - agg.first_at)) / 86400.0 / (agg.cnt - 1), 1) end,
           'purchases_90d', agg.cnt_90,
           'total_365d', round(agg.total_365, 2),
           'returns', ret.cnt,
           'returns_total', round(ret.total, 2),
           'account_balance', acc.balance,
           'account_overdue', ovd_late.overdue,
           'account_next_due', ovd.next_due,
           'credit_limit', (select credit_limit from customers where id = p_customer),
           'store_credit', cr.balance,
           'pending_charges', pc.cnt,
           'pending_charges_total', round(pc.total, 2),
           'open_disputes', dis.cnt)
    into v_kpis
    from agg, ret, acc, ovd, ovd_late, cr, pc, dis;

  -- Umbral VIP: percentil 90 de lo comprado por cliente en 12 meses (sólo
  -- clientes con compras; sin datos suficientes, null).
  select case when count(*) >= 10 then round(percentile_cont(0.9) within group (order by t.total)::numeric, 2) end
    into v_vip
    from (
      select sum(sa.total) as total
        from sales sa
       where sa.tenant_id = v_tenant and sa.customer_id is not null and sa.status = 'completed'
         and sa.created_at >= now() - interval '365 days'
         and (v_ids is null or sa.store_id = any (v_ids))
       group by sa.customer_id
    ) t;

  return jsonb_build_object(
    'profile', v_profile,
    'kpis', v_kpis,
    'vip_threshold', v_vip,
    'is_manager', v_manager,
    'by_store', coalesce((
      select jsonb_agg(jsonb_build_object(
               'store_id', st.id, 'name', st.name, 'count', x.cnt, 'total', round(x.total, 2),
               'avg_ticket', case when x.cnt > 0 then round(x.total / x.cnt, 2) else 0 end,
               'last_at', x.last_at)
               order by x.total desc)
        from (
          select sa.store_id, count(*) as cnt, sum(sa.total) as total, max(sa.created_at) as last_at
            from sales sa
           where sa.tenant_id = v_tenant and sa.customer_id = p_customer and sa.status = 'completed'
             and (v_ids is null or sa.store_id = any (v_ids))
           group by sa.store_id
        ) x
        join stores st on st.id = x.store_id), '[]'::jsonb),
    'monthly', coalesce((
      select jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM'), 'total', round(coalesce(x.total, 0), 2),
                                          'count', coalesce(x.cnt, 0))
                       order by m.month)
        from generate_series(date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires') - interval '11 months',
                             date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires'),
                             interval '1 month') as m(month)
        left join (
          select date_trunc('month', sa.created_at at time zone 'America/Argentina/Buenos_Aires') as month,
                 sum(sa.total) as total, count(*) as cnt
            from sales sa
           where sa.tenant_id = v_tenant and sa.customer_id = p_customer and sa.status = 'completed'
             and sa.created_at >= now() - interval '13 months'
             and (v_ids is null or sa.store_id = any (v_ids))
           group by 1
        ) x on x.month = m.month), '[]'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', y.product_id, 'name', y.name, 'qty', y.qty, 'total', y.total,
                                          'purchases', y.purchases)
                       order by y.total desc)
        from (
          select si.product_id, max(si.product_name) as name,
                 round(sum(si.quantity - coalesce(si.returned_qty, 0)), 3) as qty,
                 round(sum(si.subtotal * case when si.quantity > 0
                                              then (si.quantity - coalesce(si.returned_qty, 0)) / si.quantity
                                              else 1 end), 2) as total,
                 count(distinct si.sale_id) as purchases
            from sale_items si
            join sales sa on sa.id = si.sale_id
           where sa.tenant_id = v_tenant and sa.customer_id = p_customer and sa.status = 'completed'
             and (v_ids is null or sa.store_id = any (v_ids))
           group by si.product_id, case when si.product_id is null then si.product_name end
           order by 4 desc
           limit 10
        ) y), '[]'::jsonb),
    'payment_methods', coalesce((
      select jsonb_agg(jsonb_build_object('method', z.method, 'total', z.total, 'count', z.cnt) order by z.total desc)
        from (
          select p.method, round(sum(p.amount), 2) as total, count(*) as cnt
            from payments p
            join sales sa on sa.id = p.sale_id
           where sa.tenant_id = v_tenant and sa.customer_id = p_customer and sa.status = 'completed'
             and (v_ids is null or sa.store_id = any (v_ids))
           group by p.method
        ) z), '[]'::jsonb),
    'pinned_notes', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at,
                                          'created_by', n.created_by, 'author', u.full_name)
                       order by n.created_at desc)
        from customer_notes n
        left join public.users u on u.id = n.created_by
       where n.tenant_id = v_tenant and n.customer_id = p_customer and n.pinned and n.deleted_at is null), '[]'::jsonb)
  );
end;
$$;
revoke all on function customer_360_summary(uuid, uuid) from public, anon;
grant execute on function customer_360_summary(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Línea de tiempo
--    Tipos: sale, return, account, collection, store_credit, pending_charge,
--           mp_refund, dispute, note.
-- -----------------------------------------------------------------------------
create or replace function customer_360_timeline(
  p_customer  uuid,
  p_kinds     text[]      default null,
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_store     uuid        default null,
  p_limit     int         default 50,
  p_before_at timestamptz default null,
  p_before_id uuid        default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _c360_assert(p_customer);
  v_ids     uuid[] := report_store_filter(p_store);
  v_manager boolean := is_tenant_manager();
  v_lim     int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_items   jsonb;
  v_n       int;
  v_last    jsonb;
begin
  with ev as (
    -- Ventas (completas y anuladas).
    (select 'sale'::text as kind, s.status as sub, s.id, s.created_at as at, s.total as amount,
            s.number::text as ref, s.status as status, s.store_id, s.id as sale_id,
            (select string_agg(distinct p.method, ', ') from payments p where p.sale_id = s.id) as detail
       from sales s
      where s.tenant_id = v_tenant and s.customer_id = p_customer
        and (p_kinds is null or 'sale' = any (p_kinds))
        and (v_ids is null or s.store_id = any (v_ids))
        and (p_from is null or s.created_at >= p_from) and (p_to is null or s.created_at < p_to)
        and (p_before_at is null or (s.created_at, s.id) < (p_before_at, p_before_id))
      order by s.created_at desc, s.id desc
      limit v_lim + 1)
    union all
    -- Devoluciones (del cliente o de sus ventas).
    (select 'return', r.refund_method, r.id, r.created_at, -r.total,
            r.number::text, r.refund_method, s.store_id, r.sale_id,
            coalesce(r.reason, '') || case when r.mp_refund_amount > 0
                                           then ' · Mercado Pago ' || _ars(r.mp_refund_amount) else '' end
       from sale_returns r
       join sales s on s.id = r.sale_id and s.tenant_id = v_tenant
      where r.tenant_id = v_tenant and (r.customer_id = p_customer or s.customer_id = p_customer)
        and (p_kinds is null or 'return' = any (p_kinds))
        and (v_ids is null or s.store_id = any (v_ids))
        and (p_from is null or r.created_at >= p_from) and (p_to is null or r.created_at < p_to)
        and (p_before_at is null or (r.created_at, r.id) < (p_before_at, p_before_id))
      order by r.created_at desc, r.id desc
      limit v_lim + 1)
    union all
    -- Cuenta corriente: cargos, cobros, intereses, ajustes y reversas.
    (select 'account', m.kind, m.id, m.created_at, m.delta,
            coalesce(m.receipt_no::text, ''), case when m.voided_at is not null then 'voided' else 'ok' end,
            null::uuid, m.sale_id,
            coalesce(m.note, m.reason, '') || case when m.method is not null then ' · ' || m.method else '' end
       from customer_account_movements m
      where m.tenant_id = v_tenant and m.customer_id = p_customer
        and (p_kinds is null or 'account' = any (p_kinds))
        and p_store is null
        and (p_from is null or m.created_at >= p_from) and (p_to is null or m.created_at < p_to)
        and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))
      order by m.created_at desc, m.id desc
      limit v_lim + 1)
    union all
    -- Gestión de cobranza (notas, promesas, tareas, recordatorios): encargados.
    (select 'collection', a.type, a.id, a.created_at, coalesce(a.promise_amount, 0),
            coalesce(to_char(a.promise_date, 'DD/MM/YYYY'), ''), a.status, null::uuid, null::uuid,
            coalesce(a.body, '')
       from account_collection_items a
      where v_manager and a.tenant_id = v_tenant and a.customer_id = p_customer and a.deleted_at is null
        and (p_kinds is null or 'collection' = any (p_kinds))
        and p_store is null
        and (p_from is null or a.created_at >= p_from) and (p_to is null or a.created_at < p_to)
        and (p_before_at is null or (a.created_at, a.id) < (p_before_at, p_before_id))
      order by a.created_at desc, a.id desc
      limit v_lim + 1)
    union all
    -- Vales y saldo a favor.
    (select 'store_credit', case when m.delta >= 0 then 'credit' else 'debit' end, m.id, m.created_at, m.delta,
            '', 'ok', null::uuid, null::uuid, coalesce(m.reason, '')
       from store_credit_movements m
      where m.tenant_id = v_tenant and m.customer_id = p_customer
        and (p_kinds is null or 'store_credit' = any (p_kinds))
        and p_store is null
        and (p_from is null or m.created_at >= p_from) and (p_to is null or m.created_at < p_to)
        and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))
      order by m.created_at desc, m.id desc
      limit v_lim + 1)
    union all
    -- Cobros en espera.
    (select 'pending_charge', pc.channel, pc.id, pc.created_at, pc.amount,
            '', pc.status, pc.store_id, pc.sale_id, pc.provider_key
       from pending_charges pc
      where pc.tenant_id = v_tenant and pc.customer_id = p_customer
        and (p_kinds is null or 'pending_charge' = any (p_kinds))
        and (v_ids is null or pc.store_id = any (v_ids))
        and (p_from is null or pc.created_at >= p_from) and (p_to is null or pc.created_at < p_to)
        and (p_before_at is null or (pc.created_at, pc.id) < (p_before_at, p_before_id))
      order by pc.created_at desc, pc.id desc
      limit v_lim + 1)
    union all
    -- Reintegros por Mercado Pago (H21h).
    (select 'mp_refund', mr.status, mr.id, mr.created_at, -mr.amount,
            coalesce(mr.mp_refund_id, ''), mr.status, mr.store_id, mr.sale_id,
            coalesce(mr.error_code, mr.fallback_method, '')
       from mp_refunds mr
       join sales s on s.id = mr.sale_id and s.tenant_id = v_tenant
      where mr.tenant_id = v_tenant and s.customer_id = p_customer
        and (p_kinds is null or 'mp_refund' = any (p_kinds))
        and (v_ids is null or s.store_id = any (v_ids))
        and (p_from is null or mr.created_at >= p_from) and (p_to is null or mr.created_at < p_to)
        and (p_before_at is null or (mr.created_at, mr.id) < (p_before_at, p_before_id))
      order by mr.created_at desc, mr.id desc
      limit v_lim + 1)
    union all
    -- Contracargos, reclamos y devoluciones de Mercado Pago (ADR-064): encargados.
    (select 'dispute', d.kind, d.id, d.first_seen_at, -d.amount,
            coalesce(d.provider_case_id, d.provider_payment_id), d.status, s.store_id, d.sale_id,
            d.origin
       from payment_disputes d
       join sales s on s.id = d.sale_id and s.tenant_id = v_tenant
      where v_manager and d.tenant_id = v_tenant and s.customer_id = p_customer and d.deleted_at is null
        and (p_kinds is null or 'dispute' = any (p_kinds))
        and (v_ids is null or s.store_id = any (v_ids))
        and (p_from is null or d.first_seen_at >= p_from) and (p_to is null or d.first_seen_at < p_to)
        and (p_before_at is null or (d.first_seen_at, d.id) < (p_before_at, p_before_id))
      order by d.first_seen_at desc, d.id desc
      limit v_lim + 1)
    union all
    -- Notas internas.
    (select 'note', case when n.pinned then 'pinned' else 'note' end, n.id, n.created_at, 0::numeric,
            coalesce(u.full_name, ''), 'ok', null::uuid, null::uuid, n.body
       from customer_notes n
       left join public.users u on u.id = n.created_by
      where n.tenant_id = v_tenant and n.customer_id = p_customer and n.deleted_at is null
        and (p_kinds is null or 'note' = any (p_kinds))
        and (p_from is null or n.created_at >= p_from) and (p_to is null or n.created_at < p_to)
        and (p_before_at is null or (n.created_at, n.id) < (p_before_at, p_before_id))
      order by n.created_at desc, n.id desc
      limit v_lim + 1)
  ),
  page as (
    select ev.*, st.name as store_name
      from ev
      left join stores st on st.id = ev.store_id
     order by ev.at desc, ev.id desc
     limit v_lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', p.kind, 'sub', p.sub, 'id', p.id, 'at', p.at, 'amount', round(coalesce(p.amount, 0), 2),
           'ref', p.ref, 'status', p.status, 'store_id', p.store_id, 'store_name', p.store_name,
           'sale_id', p.sale_id, 'detail', nullif(p.detail, ''))
           order by p.at desc, p.id desc), '[]'::jsonb),
         count(*)
    into v_items, v_n
    from page p;

  -- Hay más: se corta en el límite y el cursor es la última fila mostrada.
  if v_n > v_lim then
    v_items := (select jsonb_agg(e order by o) from jsonb_array_elements(v_items) with ordinality as x(e, o) where o <= v_lim);
    v_last := v_items -> (v_lim - 1);
    return jsonb_build_object('items', v_items,
                              'next_cursor', jsonb_build_object('at', v_last -> 'at', 'id', v_last -> 'id'));
  end if;
  return jsonb_build_object('items', v_items, 'next_cursor', null);
end;
$$;
revoke all on function customer_360_timeline(uuid, text[], timestamptz, timestamptz, uuid, int, timestamptz, uuid) from public, anon;
grant execute on function customer_360_timeline(uuid, text[], timestamptz, timestamptz, uuid, int, timestamptz, uuid) to authenticated;
