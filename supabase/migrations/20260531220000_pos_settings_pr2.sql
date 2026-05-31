-- =============================================================================
-- 20260531220000_pos_settings_pr2  (H30 PR2)
-- SKU automático al crear producto + motivo obligatorio en el cierre de caja
-- cuando la diferencia supera la tolerancia. Defaults conservadores: sin cambio
-- de comportamiento salvo que el dueño lo active.
-- =============================================================================

-- Flag para exigir motivo en el cierre de caja (la tolerancia ya existe).
alter table pos_settings
  add column if not exists require_close_reason boolean not null default false;

-- -----------------------------------------------------------------------------
-- SKU automático: si el producto entra sin SKU y el tenant tiene sku_auto,
-- genera prefijo + correlativo. security definer para leer pos_settings.
-- -----------------------------------------------------------------------------
create or replace function products_auto_sku()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auto   boolean;
  v_prefix text;
  v_seq    bigint;
begin
  if new.sku is not null and btrim(new.sku) <> '' then
    return new;
  end if;
  select sku_auto, sku_prefix into v_auto, v_prefix
  from pos_settings where tenant_id = new.tenant_id;
  if not coalesce(v_auto, false) then
    return new;
  end if;
  select coalesce(count(*), 0) + 1 into v_seq
  from products where tenant_id = new.tenant_id;
  new.sku := coalesce(v_prefix, '') || lpad(v_seq::text, 5, '0');
  return new;
end;
$$;

drop trigger if exists products_auto_sku_trg on products;
create trigger products_auto_sku_trg
  before insert on products
  for each row execute function products_auto_sku();

-- -----------------------------------------------------------------------------
-- close_cash_shift: exige motivo si la diferencia supera la tolerancia y el
-- tenant activó require_close_reason. Basada en la versión viva (Z-closures).
-- -----------------------------------------------------------------------------
create or replace function close_cash_shift(
  p_shift_id       uuid,
  p_closing_amount numeric,
  p_notes          text default null
)
returns numeric
language plpgsql
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
  v_req        boolean;
  v_tol        numeric;
begin
  select cs.opening_amount, cs.opened_at, cs.opened_by, cr.store_id
    into v_opening, v_opened_at, v_opened_by, v_store
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.id = p_shift_id and cs.tenant_id = current_tenant_id() and cs.status = 'open';
  if v_opening is null then
    raise exception 'shift_not_open';
  end if;

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

  -- Motivo obligatorio si la diferencia supera la tolerancia (si está activado).
  select require_close_reason, close_tolerance into v_req, v_tol
  from pos_settings where tenant_id = current_tenant_id();
  if coalesce(v_req, false)
     and abs(v_diff) > coalesce(v_tol, 0)
     and (p_notes is null or btrim(p_notes) = '') then
    raise exception 'close_needs_reason';
  end if;

  update cash_shifts
     set status = 'closed',
         closed_at = now(),
         closed_by = auth.uid(),
         expected_amount = v_expected,
         closing_amount = p_closing_amount,
         notes = p_notes
   where id = p_shift_id and tenant_id = current_tenant_id();

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
