-- =============================================================================
-- 20260601130000_customer_account  (H31 — cuenta corriente)
-- Medio de pago "Cuenta corriente": deja deuda del cliente. Sin tocar
-- create_sale: un trigger en payments registra la deuda cuando method='account'
-- (chequea límite y aborta la venta si lo supera).
-- =============================================================================
alter table customers add column if not exists credit_limit numeric not null default 0;

-- Movimientos de cuenta corriente. delta > 0 = deuda (venta fiada);
-- delta < 0 = pago/cancelación. Saldo (deuda) = sum(delta).
create table if not exists customer_account_movements (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  delta       numeric(12,2) not null,
  reason      text,
  sale_id     uuid,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references public.users(id)
);
create index if not exists cust_account_idx on customer_account_movements(tenant_id, customer_id);
alter table customer_account_movements enable row level security;
create policy cust_account_select on customer_account_movements
  for select using (tenant_id = current_tenant_id() or is_internal());
-- Pagos manuales de deuda (delta<0) por owner/manager; los cargos los hace el trigger.
create policy cust_account_write on customer_account_movements
  for insert with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role in ('owner','manager')));

-- 'account' como medio de pago.
alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash','debit','credit','transfer','qr','other','store_credit','account'));

-- Trigger: al insertar un pago 'account', registra la deuda (con límite).
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
  insert into customer_account_movements (tenant_id, customer_id, delta, reason, sale_id)
  values (v_tenant, v_cust, new.amount, 'Venta cuenta corriente', new.sale_id);
  return new;
end;
$$;

drop trigger if exists payments_account_charge on payments;
create trigger payments_account_charge
  after insert on payments
  for each row execute function payment_account_charge();
