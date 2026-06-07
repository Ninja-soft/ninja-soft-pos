-- =============================================================================
-- 20260607180000_account_due_date  (H31 — F11)
-- Vencimiento por venta fiada: cada cargo de cuenta corriente nace con
-- due_date = fecha + plazo configurable del tenant (pos_settings.account_due_days,
-- default 30). El trigger payment_account_charge se reproduce completo con el
-- único agregado del cálculo/inserción de due_date.
-- =============================================================================

alter table pos_settings add column if not exists account_due_days int not null default 30;
alter table customer_account_movements add column if not exists due_date date;

create or replace function payment_account_charge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cust   uuid;
  v_tenant uuid;
  v_limit  numeric;
  v_debt   numeric;
  v_days   int;
begin
  if new.method <> 'account' then
    return new;
  end if;
  select customer_id, tenant_id into v_cust, v_tenant from sales where id = new.sale_id;
  if v_cust is null then
    raise exception 'account_needs_customer';
  end if;
  select coalesce(credit_limit, 0) into v_limit from customers where id = v_cust;
  select coalesce(sum(delta), 0) into v_debt
    from customer_account_movements where customer_id = v_cust;
  if v_limit > 0 and v_debt + new.amount > v_limit + 0.001 then
    raise exception 'credit_limit_exceeded';
  end if;

  -- H31: plazo del tenant (default 30 días) → vencimiento del cargo.
  select coalesce(account_due_days, 30) into v_days
    from pos_settings where tenant_id = v_tenant;
  if v_days is null then
    v_days := 30;
  end if;

  insert into customer_account_movements (tenant_id, customer_id, delta, reason, sale_id, due_date)
  values (v_tenant, v_cust, new.amount, 'Venta cuenta corriente', new.sale_id,
          current_date + v_days);
  return new;
end;
$$;
