-- =============================================================================
-- 20261022100300_tesoreria  (F18 · H111, ADR-059)
--
-- Tesorería básica (OPTIONAL tesoreria, Business+, requiere compras):
--   • treasury_accounts: caja general (kind 'cash') y bancos ('bank'), con
--     saldo inicial y sucursal opcional. transfer_account_id deja preparado
--     el vínculo con transfer_accounts (ADR-055, feat/transferencias-bancos):
--     cuando las dos ramas convivan, una cuenta bancaria de tesorería apunta a
--     la cuenta de cobro por transferencia (FK en una migración posterior).
--   • treasury_movements: libro de movimientos con signo (+ entra, − sale),
--     conciliación manual (marcar conciliado con referencia del extracto) y
--     anulación lógica de los movimientos manuales no conciliados.
--   • cheques: propios (los emite una orden de pago contra una cuenta
--     bancaria) y de terceros (en cartera; se endosan en una orden de pago o
--     se depositan). Estados (espejo puro en lib/treasury/cheques.ts):
--        en_cartera ─▶ entregado | depositado | rechazado
--        entregado  ─▶ depositado | rechazado | en_cartera (anulación de la OP)
--                      | anulado (cheque propio, anulación de la OP)
--        depositado ─▶ rechazado
--     Depositar uno de terceros suma en la cuenta; debitar uno propio
--     ("depositado" por el proveedor) resta; el rechazo de uno depositado
--     revierte el movimiento.
--   • treasury_balances: saldo y saldo conciliado por cuenta (vista con la RLS
--     de quien consulta).
--
-- Escrituras: cuentas por tabla (dueño o encargado con la feature); todo lo
-- demás por RPC SECURITY DEFINER con auditoría.
-- =============================================================================

-- Guard común de tesorería: negocio, dueño o encargado y plan.
create or replace function treasury_assert()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'tesoreria') then
    raise exception 'feature_not_in_plan: tesoreria';
  end if;
  return v_tenant;
end;
$$;
revoke all on function treasury_assert() from public, anon;
grant execute on function treasury_assert() to authenticated;

create or replace function treasury_can_write()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(stock_my_role() in ('owner', 'manager'), false)
     and tenant_has_feature_for(current_tenant_id(), 'tesoreria');
$$;
revoke all on function treasury_can_write() from public, anon;
grant execute on function treasury_can_write() to authenticated;

-- -----------------------------------------------------------------------------
-- A) Cuentas.
-- -----------------------------------------------------------------------------
create table if not exists treasury_accounts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  kind                text not null check (kind in ('cash', 'bank')),
  name                text not null check (char_length(trim(name)) between 1 and 80),
  store_id            uuid references stores(id),
  bank_name           text check (bank_name is null or char_length(bank_name) <= 80),
  account_number      text check (account_number is null or char_length(account_number) <= 40),
  cbu                 text check (cbu is null or cbu ~ '^\d{22}$'),
  alias               text check (alias is null or alias ~ '^[A-Za-z0-9.\-]{6,20}$'),
  currency            text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  opening_balance     numeric(14,2) not null default 0,
  opening_date        date not null default current_date,
  transfer_account_id uuid,
  is_active           boolean not null default true,
  notes               text check (notes is null or char_length(notes) <= 500),
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

comment on table treasury_accounts is
  'Cuentas de tesorería (F18/H111, ADR-059): caja general y bancos. transfer_account_id: vínculo futuro con transfer_accounts (ADR-055).';

create index if not exists treasury_accounts_tenant_idx on treasury_accounts(tenant_id) where deleted_at is null;

create or replace function trg_treasury_accounts_normalize()
returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  new.cbu := nullif(regexp_replace(coalesce(new.cbu, ''), '\D', '', 'g'), '');
  new.alias := nullif(trim(coalesce(new.alias, '')), '');
  new.currency := upper(coalesce(new.currency, 'ARS'));
  if new.kind = 'cash' then
    new.bank_name := null;
    new.cbu := null;
    new.alias := null;
    new.account_number := null;
  end if;
  return new;
end;
$$;

drop trigger if exists treasury_accounts_normalize on treasury_accounts;
create trigger treasury_accounts_normalize
  before insert or update on treasury_accounts
  for each row execute function trg_treasury_accounts_normalize();

drop trigger if exists set_updated_at_treasury_accounts on treasury_accounts;
create trigger set_updated_at_treasury_accounts
  before update on treasury_accounts
  for each row execute function set_updated_at();

alter table treasury_accounts enable row level security;

drop policy if exists treasury_accounts_select on treasury_accounts;
create policy treasury_accounts_select on treasury_accounts
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists treasury_accounts_insert on treasury_accounts;
create policy treasury_accounts_insert on treasury_accounts
  for insert with check (
    tenant_id = (select current_tenant_id()) and (select treasury_can_write())
    and (store_id is null or exists (
      select 1 from stores s where s.id = treasury_accounts.store_id and s.tenant_id = (select current_tenant_id())
    ))
  );

drop policy if exists treasury_accounts_update on treasury_accounts;
create policy treasury_accounts_update on treasury_accounts
  for update using (tenant_id = (select current_tenant_id()) and (select treasury_can_write()))
  with check (
    tenant_id = (select current_tenant_id()) and (select treasury_can_write())
    and (store_id is null or exists (
      select 1 from stores s where s.id = treasury_accounts.store_id and s.tenant_id = (select current_tenant_id())
    ))
  );
-- Sin DELETE: baja lógica.

drop trigger if exists audit_treasury_accounts on treasury_accounts;
create trigger audit_treasury_accounts
  after insert or update or delete on treasury_accounts
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- B) Cheques.
-- -----------------------------------------------------------------------------
create table if not exists cheques (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants(id) on delete cascade,
  kind                     text not null check (kind in ('own', 'third_party')),
  is_echeq                 boolean not null default false,
  number                   text not null check (char_length(trim(number)) between 1 and 30),
  bank_name                text check (bank_name is null or char_length(bank_name) <= 80),
  issue_date               date,
  payment_date             date not null,
  amount                   numeric(14,2) not null check (amount > 0),
  currency                 text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  drawer_name              text check (drawer_name is null or char_length(drawer_name) <= 120),
  drawer_cuit              text check (drawer_cuit is null or drawer_cuit ~ '^\d{11}$'),
  status                   text not null check (status in ('en_cartera','entregado','depositado','rechazado','anulado')),
  account_id               uuid references treasury_accounts(id),
  received_from_customer_id uuid references customers(id),
  received_from            text check (received_from is null or char_length(received_from) <= 120),
  delivered_to_supplier_id uuid references suppliers(id),
  payment_id               uuid,
  deposit_movement_id      uuid,
  deposited_at             date,
  rejected_at              date,
  reject_reason            text check (reject_reason is null or char_length(reject_reason) <= 300),
  notes                    text check (notes is null or char_length(notes) <= 500),
  created_by               uuid default auth.uid(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table cheques is
  'Cheques y e-cheqs propios y de terceros (F18/H111, ADR-059). Estados en lib/treasury/cheques.ts.';

create index if not exists cheques_tenant_status_idx on cheques(tenant_id, status, payment_date);
create index if not exists cheques_payment_idx on cheques(payment_id) where payment_id is not null;

drop trigger if exists set_updated_at_cheques on cheques;
create trigger set_updated_at_cheques
  before update on cheques
  for each row execute function set_updated_at();

alter table cheques enable row level security;
drop policy if exists cheques_select on cheques;
create policy cheques_select on cheques
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- Transición permitida (espejo de canChequeTransition).
create or replace function cheque_transition_ok(p_kind text, p_from text, p_to text)
returns boolean
language sql
immutable
as $$
  select case
    when p_from = 'en_cartera' then p_kind = 'third_party' and p_to in ('entregado', 'depositado', 'rechazado')
    when p_from = 'entregado'  then p_to in ('depositado', 'rechazado')
                                    or (p_kind = 'third_party' and p_to = 'en_cartera')
                                    or (p_kind = 'own' and p_to = 'anulado')
    when p_from = 'depositado' then p_to = 'rechazado'
    else false
  end;
$$;

-- -----------------------------------------------------------------------------
-- C) Movimientos.
-- -----------------------------------------------------------------------------
create table if not exists treasury_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  account_id     uuid not null references treasury_accounts(id),
  movement_date  date not null default current_date,
  amount         numeric(14,2) not null check (amount <> 0),
  type           text not null check (type in ('deposit','withdrawal','transfer_in','transfer_out',
                                               'supplier_payment','supplier_payment_void',
                                               'cheque_deposit','cheque_debit','cheque_rejected',
                                               'adjustment','other')),
  description    text check (description is null or char_length(description) <= 300),
  counterpart_id uuid,
  reference_type text,
  reference_id   uuid,
  cheque_id      uuid references cheques(id),
  reconciled_at  timestamptz,
  reconciled_by  uuid,
  statement_ref  text check (statement_ref is null or char_length(statement_ref) <= 80),
  voided_at      timestamptz,
  voided_by      uuid,
  void_reason    text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);

comment on table treasury_movements is
  'Movimientos de tesorería con signo (+ entra, − sale). Conciliación manual y anulación lógica (F18/H111, ADR-059).';

create index if not exists treasury_movements_account_idx
  on treasury_movements(account_id, movement_date desc, created_at desc);
create index if not exists treasury_movements_tenant_idx on treasury_movements(tenant_id, movement_date desc);
create index if not exists treasury_movements_reference_idx on treasury_movements(reference_id)
  where reference_id is not null;

alter table treasury_movements enable row level security;
drop policy if exists treasury_movements_select on treasury_movements;
create policy treasury_movements_select on treasury_movements
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

alter table cheques drop constraint if exists cheques_deposit_movement_fkey;
alter table cheques add constraint cheques_deposit_movement_fkey
  foreign key (deposit_movement_id) references treasury_movements(id);

-- Cuenta del negocio, activa.
create or replace function treasury_account_get(p_tenant uuid, p_id uuid)
returns treasury_accounts
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v treasury_accounts;
begin
  select * into v from treasury_accounts
   where id = p_id and tenant_id = p_tenant and deleted_at is null and is_active;
  if v.id is null then
    raise exception 'treasury_account_not_found';
  end if;
  return v;
end;
$$;
revoke all on function treasury_account_get(uuid, uuid) from public, anon, authenticated;

-- Alta de movimiento interno (lo usan las RPC de tesorería y de órdenes de pago).
create or replace function _treasury_move(
  p_tenant uuid, p_account uuid, p_date date, p_amount numeric, p_type text, p_description text,
  p_reference_type text default null, p_reference_id uuid default null, p_cheque uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                  reference_type, reference_id, cheque_id, created_by)
  values (p_tenant, p_account, coalesce(p_date, current_date), round(p_amount, 2), p_type,
          nullif(trim(coalesce(p_description, '')), ''), p_reference_type, p_reference_id, p_cheque, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function _treasury_move(uuid, uuid, date, numeric, text, text, text, uuid, uuid)
  from public, anon, authenticated;

-- Movimiento manual: depósito / ingreso (+), retiro / gasto (−), ajuste (±).
-- p: {account_id, type: deposit|withdrawal|adjustment|other, amount > 0,
--     direction?: in|out (ajuste y otro), date?, description?}
create or replace function treasury_movement_create(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  v_acc    treasury_accounts;
  v_type   text := coalesce(p ->> 'type', 'other');
  v_amount numeric := round(coalesce((p ->> 'amount')::numeric, 0), 2);
  v_sign   int;
  v_id     uuid;
begin
  v_acc := treasury_account_get(v_tenant, (p ->> 'account_id')::uuid);
  if v_type not in ('deposit', 'withdrawal', 'adjustment', 'other') then
    raise exception 'invalid_movement_type';
  end if;
  if v_amount <= 0 then
    raise exception 'invalid_amount';
  end if;
  v_sign := case v_type
              when 'deposit' then 1
              when 'withdrawal' then -1
              else case when coalesce(p ->> 'direction', 'in') = 'out' then -1 else 1 end
            end;
  if v_type in ('adjustment', 'other') and nullif(trim(coalesce(p ->> 'description', '')), '') is null then
    raise exception 'reason_required';
  end if;
  v_id := _treasury_move(v_tenant, v_acc.id, (nullif(p ->> 'date', ''))::date, v_sign * v_amount, v_type,
                         p ->> 'description');
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'treasury_movements', v_id, 'treasury_movement_created',
          jsonb_build_object('account_id', v_acc.id, 'type', v_type, 'amount', v_sign * v_amount,
                             'description', p ->> 'description'));
  return v_id;
end;
$$;
revoke all on function treasury_movement_create(jsonb) from public, anon;
grant execute on function treasury_movement_create(jsonb) to authenticated;

-- Transferencia entre cuentas (dos movimientos enlazados).
create or replace function treasury_transfer(
  p_from uuid, p_to uuid, p_amount numeric, p_date date default null, p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  v_a      treasury_accounts;
  v_b      treasury_accounts;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_out    uuid;
  v_in     uuid;
begin
  v_a := treasury_account_get(v_tenant, p_from);
  v_b := treasury_account_get(v_tenant, p_to);
  if v_a.id = v_b.id then
    raise exception 'same_account';
  end if;
  if v_amount <= 0 then
    raise exception 'invalid_amount';
  end if;
  if v_a.currency <> v_b.currency then
    raise exception 'currency_mismatch';
  end if;
  v_out := _treasury_move(v_tenant, v_a.id, p_date, -v_amount, 'transfer_out',
                          coalesce(nullif(trim(coalesce(p_description, '')), ''), 'Transferencia a ' || v_b.name));
  v_in := _treasury_move(v_tenant, v_b.id, p_date, v_amount, 'transfer_in',
                         coalesce(nullif(trim(coalesce(p_description, '')), ''), 'Transferencia desde ' || v_a.name));
  update treasury_movements set counterpart_id = v_in where id = v_out;
  update treasury_movements set counterpart_id = v_out where id = v_in;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'treasury_movements', v_out, 'treasury_transfer',
          jsonb_build_object('from', v_a.id, 'to', v_b.id, 'amount', v_amount));
  return v_out;
end;
$$;
revoke all on function treasury_transfer(uuid, uuid, numeric, date, text) from public, anon;
grant execute on function treasury_transfer(uuid, uuid, numeric, date, text) to authenticated;

-- Anular un movimiento manual no conciliado (una transferencia anula las dos patas).
create or replace function treasury_movement_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  v_m      treasury_movements;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_m from treasury_movements where id = p_id and tenant_id = v_tenant for update;
  if v_m.id is null then
    raise exception 'movement_not_found';
  end if;
  if v_m.voided_at is not null then
    raise exception 'movement_voided';
  end if;
  if v_m.type not in ('deposit', 'withdrawal', 'adjustment', 'other', 'transfer_in', 'transfer_out') then
    raise exception 'movement_not_manual';
  end if;
  if v_m.reconciled_at is not null or exists (
    select 1 from treasury_movements c where c.id = v_m.counterpart_id and c.reconciled_at is not null
  ) then
    raise exception 'movement_reconciled';
  end if;
  update treasury_movements
     set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
   where id = v_m.id or (v_m.counterpart_id is not null and id = v_m.counterpart_id);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, reason)
  values (v_tenant, auth.uid(), 'treasury_movements', v_m.id, 'treasury_movement_voided', to_jsonb(v_m),
          trim(p_reason));
end;
$$;
revoke all on function treasury_movement_void(uuid, text) from public, anon;
grant execute on function treasury_movement_void(uuid, text) to authenticated;

-- Conciliación manual: marcar o desmarcar movimientos contra el extracto.
create or replace function treasury_reconcile(p_ids uuid[], p_reconciled boolean, p_statement_ref text default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  v_n      int;
begin
  update treasury_movements
     set reconciled_at = case when p_reconciled then now() else null end,
         reconciled_by = case when p_reconciled then auth.uid() else null end,
         statement_ref = case when p_reconciled then nullif(trim(coalesce(p_statement_ref, '')), '') else null end
   where tenant_id = v_tenant and id = any (coalesce(p_ids, '{}'::uuid[])) and voided_at is null;
  get diagnostics v_n = row_count;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'treasury_movements', v_tenant,
          case when p_reconciled then 'treasury_reconciled' else 'treasury_unreconciled' end,
          jsonb_build_object('ids', to_jsonb(p_ids), 'count', v_n, 'statement_ref', p_statement_ref));
  return v_n;
end;
$$;
revoke all on function treasury_reconcile(uuid[], boolean, text) from public, anon;
grant execute on function treasury_reconcile(uuid[], boolean, text) to authenticated;

-- Saldos por cuenta.
create or replace view treasury_balances
with (security_invoker = true) as
  select a.tenant_id, a.id as account_id, a.kind, a.name, a.currency, a.store_id, a.is_active,
         (a.opening_balance + coalesce(sum(m.amount) filter (where m.voided_at is null), 0))::numeric(14,2)
           as balance,
         (a.opening_balance + coalesce(sum(m.amount) filter (where m.voided_at is null
                                                              and m.reconciled_at is not null), 0))::numeric(14,2)
           as reconciled_balance,
         count(m.id) filter (where m.voided_at is null and m.reconciled_at is null)::int as unreconciled_count,
         max(m.movement_date) filter (where m.voided_at is null) as last_movement
    from treasury_accounts a
    left join treasury_movements m on m.account_id = a.id
   where a.deleted_at is null
   group by a.tenant_id, a.id, a.kind, a.name, a.currency, a.store_id, a.is_active, a.opening_balance;

revoke all on treasury_balances from anon;
grant select on treasury_balances to authenticated;

-- -----------------------------------------------------------------------------
-- D) Cheques de terceros en cartera y transiciones manuales.
-- -----------------------------------------------------------------------------
-- p: {number, bank_name?, issue_date?, payment_date, amount, drawer_name?,
--     drawer_cuit?, customer_id?, received_from?, is_echeq?, notes?}
create or replace function cheque_register(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  v_id     uuid;
  v_cust   uuid := (nullif(p ->> 'customer_id', ''))::uuid;
  v_cuit   text := nullif(regexp_replace(coalesce(p ->> 'drawer_cuit', ''), '\D', '', 'g'), '');
begin
  if v_cust is not null and not exists (select 1 from customers where id = v_cust and tenant_id = v_tenant) then
    raise exception 'customer_not_found';
  end if;
  if v_cuit is not null and not cuit_is_valid(v_cuit) then
    raise exception 'invalid_cuit';
  end if;
  if coalesce((p ->> 'amount')::numeric, 0) <= 0 then
    raise exception 'invalid_amount';
  end if;
  if nullif(p ->> 'payment_date', '') is null then
    raise exception 'payment_date_required';
  end if;
  insert into cheques (tenant_id, kind, is_echeq, number, bank_name, issue_date, payment_date, amount,
                       drawer_name, drawer_cuit, status, received_from_customer_id, received_from, notes,
                       created_by)
  values (v_tenant, 'third_party', coalesce((p ->> 'is_echeq')::boolean, false), trim(p ->> 'number'),
          nullif(trim(coalesce(p ->> 'bank_name', '')), ''), (nullif(p ->> 'issue_date', ''))::date,
          (p ->> 'payment_date')::date, round((p ->> 'amount')::numeric, 2),
          nullif(trim(coalesce(p ->> 'drawer_name', '')), ''), v_cuit, 'en_cartera', v_cust,
          nullif(trim(coalesce(p ->> 'received_from', '')), ''), nullif(trim(coalesce(p ->> 'notes', '')), ''),
          auth.uid())
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'cheques', v_id, 'cheque_registered', p);
  return v_id;
end;
$$;
revoke all on function cheque_register(jsonb) from public, anon;
grant execute on function cheque_register(jsonb) to authenticated;

-- Transiciones manuales: depositar (terceros, a una cuenta bancaria), debitar
-- (propio, "depositado" por quien lo cobró) y rechazar. Entregar, volver a
-- cartera y anular los maneja la orden de pago.
-- p: {account_id?, date?, reason?}
create or replace function cheque_transition(p_id uuid, p_to text, p jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  v_c      cheques;
  v_acc    treasury_accounts;
  v_date   date := coalesce((nullif(p ->> 'date', ''))::date, current_date);
  v_mov    uuid;
  v_label  text;
begin
  select * into v_c from cheques where id = p_id and tenant_id = v_tenant for update;
  if v_c.id is null then
    raise exception 'cheque_not_found';
  end if;
  if p_to in ('entregado', 'en_cartera', 'anulado') then
    raise exception 'cheque_transition_via_payment';
  end if;
  if not cheque_transition_ok(v_c.kind, v_c.status, p_to) then
    raise exception 'invalid_cheque_transition: % -> %', v_c.status, p_to;
  end if;
  v_label := case when v_c.is_echeq then 'E-cheq ' else 'Cheque ' end || v_c.number
             || coalesce(' ' || v_c.bank_name, '');

  if p_to = 'depositado' then
    if v_c.kind = 'third_party' then
      v_acc := treasury_account_get(v_tenant, (p ->> 'account_id')::uuid);
      if v_acc.kind <> 'bank' then
        raise exception 'bank_account_required';
      end if;
      v_mov := _treasury_move(v_tenant, v_acc.id, v_date, v_c.amount, 'cheque_deposit',
                              'Depósito ' || v_label, 'cheque', v_c.id, v_c.id);
      update cheques set status = 'depositado', account_id = v_acc.id, deposited_at = v_date,
                         deposit_movement_id = v_mov
       where id = v_c.id;
    else
      if v_c.account_id is null then
        raise exception 'bank_account_required';
      end if;
      v_mov := _treasury_move(v_tenant, v_c.account_id, v_date, -v_c.amount, 'cheque_debit',
                              'Débito ' || v_label, 'cheque', v_c.id, v_c.id);
      update cheques set status = 'depositado', deposited_at = v_date, deposit_movement_id = v_mov
       where id = v_c.id;
    end if;
  elsif p_to = 'rechazado' then
    if nullif(trim(coalesce(p ->> 'reason', '')), '') is null then
      raise exception 'reason_required';
    end if;
    -- Rechazo de uno ya depositado o debitado: revierte el movimiento.
    if v_c.status = 'depositado' and v_c.deposit_movement_id is not null then
      perform _treasury_move(v_tenant, v_c.account_id, v_date,
                             -(select amount from treasury_movements where id = v_c.deposit_movement_id),
                             'cheque_rejected', 'Rechazo ' || v_label, 'cheque', v_c.id, v_c.id);
    end if;
    update cheques set status = 'rechazado', rejected_at = v_date, reject_reason = trim(p ->> 'reason')
     where id = v_c.id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'cheques', v_c.id, 'cheque_' || p_to,
          jsonb_build_object('status', v_c.status),
          jsonb_build_object('status', p_to, 'account_id', coalesce(v_acc.id, v_c.account_id),
                             'payment_id', v_c.payment_id, 'supplier_id', v_c.delivered_to_supplier_id),
          p ->> 'reason');
end;
$$;
revoke all on function cheque_transition(uuid, text, jsonb) from public, anon;
grant execute on function cheque_transition(uuid, text, jsonb) to authenticated;
