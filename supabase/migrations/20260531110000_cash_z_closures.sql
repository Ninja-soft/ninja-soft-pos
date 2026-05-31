-- =============================================================================
-- 20260531110000_cash_z_closures
-- Cierres Z (H30b): al cerrar un turno se genera un cierre Z inmutable con el
-- snapshot consolidado del turno. Append-only: hay policy de SELECT e INSERT por
-- tenant, pero NO de UPDATE/DELETE → no se puede modificar ni borrar.
-- close_cash_shift arma el snapshot y lo inserta (idempotente por turno).
-- =============================================================================

create table if not exists cash_z_closures (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id         uuid,
  cash_shift_id    uuid not null unique references cash_shifts(id) on delete cascade,
  z_number         bigint not null,
  opened_at        timestamptz,
  closed_at        timestamptz not null default now(),
  opened_by        uuid references public.users(id),
  closed_by        uuid references public.users(id),
  opening_amount   numeric(12,2) not null default 0,
  closing_amount   numeric(12,2) not null default 0,
  expected_amount  numeric(12,2) not null default 0,
  difference       numeric(12,2) not null default 0,
  sales_count      integer not null default 0,
  sales_total      numeric(12,2) not null default 0,
  discounts_total  numeric(12,2) not null default 0,
  voids_count      integer not null default 0,
  voids_total      numeric(12,2) not null default 0,
  cash_in          numeric(12,2) not null default 0,
  cash_out         numeric(12,2) not null default 0,
  payment_breakdown jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists czc_tenant_idx on cash_z_closures(tenant_id, z_number desc);

alter table cash_z_closures enable row level security;
-- Lectura por tenant; inserción por tenant (la hace close_cash_shift). Sin
-- UPDATE/DELETE: el Z es inmutable.
create policy czc_select on cash_z_closures
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy czc_insert on cash_z_closures
  for insert with check (tenant_id = current_tenant_id());

create or replace function close_cash_shift(
  p_shift_id       uuid,
  p_closing_amount numeric,
  p_notes          text default null
)
returns numeric  -- diferencia (closing - expected)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_opening    numeric;
  v_expected   numeric;
  v_diff       numeric;
  v_store      uuid;
  v_opened_at  timestamptz;
  v_opened_by  uuid;
  v_znum       bigint;
  v_sales_count   integer;
  v_sales_total   numeric;
  v_disc_total    numeric;
  v_voids_count   integer;
  v_voids_total   numeric;
  v_cash_in    numeric;
  v_cash_out   numeric;
  v_breakdown  jsonb;
begin
  select cs.opening_amount, cs.opened_at, cs.opened_by, cr.store_id
    into v_opening, v_opened_at, v_opened_by, v_store
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.id = p_shift_id and cs.tenant_id = current_tenant_id() and cs.status = 'open';
  if v_opening is null then
    raise exception 'shift_not_open';
  end if;

  -- Efectivo esperado = apertura + ingresos − egresos + ventas cash − anulaciones cash.
  select v_opening
       + coalesce(sum(case when type = 'income' then amount
                           when type = 'expense' then -amount
                           when type = 'sale' and payment_method = 'cash' then amount
                           when type = 'sale_void' and payment_method = 'cash' then -amount
                           else 0 end), 0)
    into v_expected
  from cash_movements
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  v_diff := p_closing_amount - v_expected;

  update cash_shifts
     set status = 'closed',
         closed_at = now(),
         closed_by = auth.uid(),
         expected_amount = v_expected,
         closing_amount = p_closing_amount,
         notes = p_notes
   where id = p_shift_id and tenant_id = current_tenant_id();

  -- ---------- Snapshot consolidado del turno (Cierre Z) ----------
  select count(*) filter (where status = 'completed'),
         coalesce(sum(total) filter (where status = 'completed'), 0),
         coalesce(sum(discount_total) filter (where status = 'completed'), 0),
         count(*) filter (where status = 'voided'),
         coalesce(sum(total) filter (where status = 'voided'), 0)
    into v_sales_count, v_sales_total, v_disc_total, v_voids_count, v_voids_total
  from sales
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  select coalesce(sum(amount) filter (where type = 'income'), 0),
         coalesce(sum(amount) filter (where type = 'expense'), 0)
    into v_cash_in, v_cash_out
  from cash_movements
  where cash_shift_id = p_shift_id and tenant_id = current_tenant_id();

  select coalesce(jsonb_object_agg(payment_method, t), '{}'::jsonb)
    into v_breakdown
  from (
    select payment_method, sum(amount) as t
    from cash_movements
    where cash_shift_id = p_shift_id and tenant_id = current_tenant_id()
      and type = 'sale' and payment_method is not null
    group by payment_method
  ) s;

  select coalesce(max(z_number), 0) + 1 into v_znum
  from cash_z_closures where tenant_id = current_tenant_id();

  insert into cash_z_closures (
    store_id, cash_shift_id, z_number, opened_at, closed_at, opened_by, closed_by,
    opening_amount, closing_amount, expected_amount, difference,
    sales_count, sales_total, discounts_total, voids_count, voids_total,
    cash_in, cash_out, payment_breakdown
  ) values (
    v_store, p_shift_id, v_znum, v_opened_at, now(), v_opened_by, auth.uid(),
    v_opening, p_closing_amount, v_expected, v_diff,
    v_sales_count, v_sales_total, v_disc_total, v_voids_count, v_voids_total,
    v_cash_in, v_cash_out, v_breakdown
  )
  on conflict (cash_shift_id) do nothing;

  return v_diff;
end;
$$;

revoke execute on function close_cash_shift(uuid, numeric, text) from public, anon;
grant  execute on function close_cash_shift(uuid, numeric, text) to authenticated;
