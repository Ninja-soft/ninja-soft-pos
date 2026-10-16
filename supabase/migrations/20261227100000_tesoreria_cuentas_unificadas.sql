-- =============================================================================
-- 20261227100000_tesoreria_cuentas_unificadas  (F23 · H150 y H154, ADR-158)
--
-- Tesorería como el único lugar que dice dónde está la plata (ADR-150):
--
--   A) treasury_accounts con tipos nuevos:
--        pos_cash   cajón de cada caja registradora (una por caja, se crea
--                   sola, sólo lectura: el saldo sale del turno).
--        wallet     billetera de un procesador (Mercado Pago, Ualá Bis, MODO...).
--        receivable "a acreditar" por procesador o adquirente (virtual, sólo
--                   lectura: cobros con tarjeta, QR o billetera sin liquidar).
--      Además de cash (caja general) y bank. Saldo inicial, fecha de apertura y
--      moneda bloqueados cuando la cuenta ya tiene movimientos (T23).
--   B) treasury_account_transfer_accounts: una cuenta bancaria o billetera se
--      vincula a una o más cuentas de cobro por transferencia (reemplaza la
--      columna muerta transfer_account_id, que queda sin uso).
--   C) Cobros por transferencia a su cuenta: trigger diferido en payments y en
--      sales. Cada cobro por transferencia a una cuenta vinculada suma un
--      movimiento 'sale_collection' en esa cuenta; anular la venta suma un
--      'sale_collection_void' (contra-movimiento: no se pierde la conciliación
--      contra el extracto). Estos movimientos NO contabilizan por su cuenta:
--      el asiento lo arma la venta (ADR-150 punto 2).
--   D) Gastos (H154): treasury_movements.expense_account_id, receipt_number,
--      receipt_vat y proof_path (bucket privado treasury-proofs).
--   E) Fechas argentinas (T5, T22): cheque_transition y supplier_payment_void
--      sin fecha toman el día de Argentina, no el de UTC.
--   F) RPC de lectura: treasury_position (posición por cuenta con cajas del POS
--      y a acreditar), treasury_pending_collections (lo que falta acreditar),
--      treasury_accounts_sync, treasury_account_link_transfer.
--
-- Funciones redefinidas a partir de su definición VIVA en producción
-- (pg_get_functiondef, 2026-10-15): cheque_transition, supplier_payment_void,
-- treasury_movement_create, trg_treasury_accounts_normalize. NO toca
-- create_sale ni close_cash_shift.
--
-- Seguridad: tenant_id + RLS con (select current_tenant_id()) y
-- (select internal_scope()); escrituras por RPC SECURITY DEFINER con
-- treasury_assert() (dueño o encargado + feature tesoreria); audit_logs.
-- Sin migrar datos: en producción treasury_accounts y treasury_movements
-- tienen 0 filas (auditoría ADR-150).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Cuentas de dinero: tipos nuevos.
-- -----------------------------------------------------------------------------
alter table treasury_accounts drop constraint if exists treasury_accounts_kind_check;
alter table treasury_accounts add constraint treasury_accounts_kind_check
  check (kind in ('cash', 'bank', 'pos_cash', 'wallet', 'receivable'));

alter table treasury_accounts add column if not exists provider_key text;
-- La caja del POS es un reflejo de la caja registradora (sin movimientos
-- propios): si la caja se borra físicamente, la cuenta se va con ella.
alter table treasury_accounts add column if not exists cash_register_id uuid references cash_registers(id) on delete cascade;
alter table treasury_accounts add column if not exists is_system boolean not null default false;

alter table treasury_accounts drop constraint if exists treasury_accounts_provider_key_check;
alter table treasury_accounts add constraint treasury_accounts_provider_key_check
  check (provider_key is null or provider_key ~ '^[a-z0-9_]{2,40}$');
alter table treasury_accounts drop constraint if exists treasury_accounts_kind_shape;
alter table treasury_accounts add constraint treasury_accounts_kind_shape
  check ((kind = 'pos_cash') = (cash_register_id is not null)
         and (kind not in ('wallet', 'receivable') or provider_key is not null));

create unique index if not exists treasury_accounts_pos_cash_uidx
  on treasury_accounts(cash_register_id) where kind = 'pos_cash' and deleted_at is null;
create unique index if not exists treasury_accounts_receivable_uidx
  on treasury_accounts(tenant_id, provider_key) where kind = 'receivable' and deleted_at is null;
create index if not exists treasury_accounts_cash_register_idx
  on treasury_accounts(cash_register_id) where cash_register_id is not null;

comment on column treasury_accounts.transfer_account_id is
  'Sin uso desde ADR-158: el vínculo con las cuentas de cobro por transferencia vive en treasury_account_transfer_accounts. Se borra en una migración posterior.';
comment on column treasury_accounts.kind is
  'cash = caja general o fondo fijo; bank = cuenta bancaria; pos_cash = cajón de una caja registradora (sistema); wallet = billetera de un procesador; receivable = a acreditar de un procesador (sistema). ADR-158.';

-- Normalización (definición viva + kinds nuevos): los datos bancarios sólo en
-- bancos; la billetera puede tener CVU y alias.
create or replace function trg_treasury_accounts_normalize()
returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  new.cbu := nullif(regexp_replace(coalesce(new.cbu, ''), '\D', '', 'g'), '');
  new.alias := nullif(trim(coalesce(new.alias, '')), '');
  new.currency := upper(coalesce(new.currency, 'ARS'));
  new.provider_key := nullif(lower(trim(coalesce(new.provider_key, ''))), '');
  if new.kind in ('cash', 'pos_cash', 'receivable') then
    new.bank_name := null;
    new.cbu := null;
    new.alias := null;
    new.account_number := null;
  elsif new.kind = 'wallet' then
    new.bank_name := null;
    new.account_number := null;
  end if;
  if new.kind not in ('wallet', 'receivable') then
    new.provider_key := null;
  end if;
  return new;
end;
$$;

-- Guardas: las cuentas de sistema no se crean ni se editan desde el cliente, el
-- tipo no cambia y el saldo inicial queda fijo cuando hay movimientos (T23).
create or replace function trg_treasury_accounts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if v_client then
      if new.kind in ('pos_cash', 'receivable') then
        raise exception 'treasury_system_account' using errcode = '42501';
      end if;
      new.is_system := false;
    end if;
    return new;
  end if;

  if new.kind is distinct from old.kind then
    raise exception 'treasury_kind_immutable' using errcode = 'check_violation';
  end if;
  if v_client and (old.is_system or new.is_system is distinct from old.is_system) then
    if new.is_system is distinct from old.is_system
       or new.name is distinct from old.name
       or new.store_id is distinct from old.store_id
       or new.currency is distinct from old.currency
       or new.opening_balance is distinct from old.opening_balance
       or new.opening_date is distinct from old.opening_date
       or new.provider_key is distinct from old.provider_key
       or new.cash_register_id is distinct from old.cash_register_id
       or new.deleted_at is distinct from old.deleted_at then
      raise exception 'treasury_system_account' using errcode = '42501';
    end if;
  end if;
  if (new.opening_balance is distinct from old.opening_balance
      or new.opening_date is distinct from old.opening_date
      or new.currency is distinct from old.currency)
     and exists (select 1 from treasury_movements m where m.account_id = old.id) then
    raise exception 'treasury_opening_locked' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists treasury_accounts_guard on treasury_accounts;
create trigger treasury_accounts_guard
  before insert or update on treasury_accounts
  for each row execute function trg_treasury_accounts_guard();

-- -----------------------------------------------------------------------------
-- A.1) Cajas del POS: una cuenta pos_cash por caja registradora.
-- -----------------------------------------------------------------------------
create or replace function _treasury_ensure_pos_cash(p_register uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r  cash_registers%rowtype;
  v  uuid;
begin
  select * into r from cash_registers where id = p_register;
  if r.id is null then
    return null;
  end if;
  select id into v from treasury_accounts
   where cash_register_id = r.id and kind = 'pos_cash' and deleted_at is null;
  if r.deleted_at is not null then
    if v is not null then
      update treasury_accounts set deleted_at = now(), is_active = false where id = v;
    end if;
    return v;
  end if;
  if v is null then
    insert into treasury_accounts (tenant_id, kind, name, store_id, cash_register_id, is_system, currency,
                                   opening_balance, opening_date)
    values (r.tenant_id, 'pos_cash', left(r.name, 80), r.store_id, r.id, true, 'ARS', 0,
            (now() at time zone 'America/Argentina/Buenos_Aires')::date)
    returning id into v;
  else
    update treasury_accounts
       set name = left(r.name, 80), store_id = r.store_id, is_active = r.is_active
     where id = v
       and (name is distinct from left(r.name, 80) or store_id is distinct from r.store_id
            or is_active is distinct from r.is_active);
  end if;
  return v;
end;
$$;
revoke all on function _treasury_ensure_pos_cash(uuid) from public, anon, authenticated;

create or replace function trg_cash_registers_treasury()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform _treasury_ensure_pos_cash(new.id);
  exception when others then
    -- Nunca frena el alta o la edición de una caja.
    null;
  end;
  return null;
end;
$$;

drop trigger if exists cash_registers_treasury on cash_registers;
create trigger cash_registers_treasury
  after insert or update of name, store_id, is_active, deleted_at on cash_registers
  for each row execute function trg_cash_registers_treasury();

-- Cajas existentes (6 en producción).
do $$
declare
  r record;
begin
  for r in select id from cash_registers loop
    perform _treasury_ensure_pos_cash(r.id);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- A.2) Procesadores: clave y nombre del "a acreditar" de cada cobro.
-- -----------------------------------------------------------------------------
-- Procesador o adquirente de un cobro que se liquida después (tarjeta, QR,
-- billetera, plataforma). null = el cobro no pasa por "a acreditar" (efectivo,
-- transferencia, cuenta corriente, saldo a favor, seña).
create or replace function treasury_payment_provider(p_tenant uuid, p_method text, p_reference text, p_voucher jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text;
  v_p text;
begin
  if p_method is null or p_method not in ('debit', 'credit', 'qr', 'directo', 'ualabis', 'mercadolibre', 'plataforma') then
    return null;
  end if;
  if p_method in ('ualabis', 'mercadolibre', 'plataforma', 'directo') then
    return p_method;
  end if;
  v_q := acc_payment_qualifier(p_tenant, p_method, p_reference, p_voucher);
  v_p := nullif(split_part(v_q, ':', 2), '');
  if v_p is not null then
    v_p := regexp_replace(lower(v_p), '[^a-z0-9_]', '_', 'g');
    if v_p = 'prisma' then v_p := 'payway'; end if;
    if v_p = 'posnet' then v_p := 'fiserv'; end if;
    return left(v_p, 40);
  end if;
  return case when p_method = 'qr' then 'qr' else 'tarjetas' end;
end;
$$;
revoke all on function treasury_payment_provider(uuid, text, text, jsonb) from public, anon, authenticated;

create or replace function treasury_provider_label(p_provider text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_provider
    when 'mercadopago' then 'Mercado Pago'
    when 'payway' then 'Payway'
    when 'fiserv' then 'Fiserv'
    when 'getnet' then 'Getnet'
    when 'nave' then 'Nave'
    when 'ualabis' then 'Ualá Bis'
    when 'modo' then 'MODO'
    when 'naranjax' then 'Naranja X'
    when 'personalpay' then 'Personal Pay'
    when 'mobbex' then 'Mobbex'
    when 'mercadolibre' then 'Mercado Libre'
    when 'plataforma' then 'Plataformas de delivery'
    when 'directo' then 'Directo'
    when 'qr' then 'QR sin procesador'
    when 'tarjetas' then 'Tarjetas sin adquirente'
    else initcap(replace(coalesce(p_provider, 'otro'), '_', ' '))
  end;
$$;

-- -----------------------------------------------------------------------------
-- B) Vínculo con las cuentas de cobro por transferencia.
-- -----------------------------------------------------------------------------
create table if not exists treasury_account_transfer_accounts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  treasury_account_id uuid not null references treasury_accounts(id),
  transfer_account_id uuid not null references transfer_accounts(id),
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid
);

comment on table treasury_account_transfer_accounts is
  'ADR-158: qué cuenta de Tesorería (banco o billetera) recibe lo que se cobra por transferencia a cada cuenta de cobro. Una cuenta de cobro, una sola cuenta de Tesorería vigente. Escritura por treasury_account_link_transfer.';

create unique index if not exists treasury_account_transfer_accounts_uidx
  on treasury_account_transfer_accounts(transfer_account_id) where deleted_at is null;
create index if not exists treasury_account_transfer_accounts_tenant_idx
  on treasury_account_transfer_accounts(tenant_id) where deleted_at is null;
create index if not exists treasury_account_transfer_accounts_treasury_idx
  on treasury_account_transfer_accounts(treasury_account_id);

alter table treasury_account_transfer_accounts enable row level security;
drop policy if exists treasury_account_transfer_accounts_select on treasury_account_transfer_accounts;
create policy treasury_account_transfer_accounts_select on treasury_account_transfer_accounts
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on treasury_account_transfer_accounts from anon, authenticated;
grant select on treasury_account_transfer_accounts to authenticated;

-- Cuenta de Tesorería vigente de un cobro por transferencia (null si no hay).
create or replace function treasury_account_of_payment(p_tenant uuid, p_metadata jsonb)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ta.id
    from treasury_account_transfer_accounts l
    join treasury_accounts ta on ta.id = l.treasury_account_id
   where l.tenant_id = p_tenant
     and l.deleted_at is null
     and l.transfer_account_id = nullif(p_metadata -> 'transfer' ->> 'account_id', '')::uuid
     and ta.deleted_at is null
   limit 1;
$$;
revoke all on function treasury_account_of_payment(uuid, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Movimientos con origen y gastos.
-- -----------------------------------------------------------------------------
alter table treasury_movements drop constraint if exists treasury_movements_type_check;
alter table treasury_movements add constraint treasury_movements_type_check
  check (type in ('deposit', 'withdrawal', 'transfer_in', 'transfer_out',
                  'supplier_payment', 'supplier_payment_void',
                  'cheque_deposit', 'cheque_debit', 'cheque_rejected',
                  'adjustment', 'other',
                  'sale_collection', 'sale_collection_void'));

alter table treasury_movements add column if not exists sale_id uuid references sales(id);
alter table treasury_movements add column if not exists expense_account_id uuid references acc_accounts(id);
alter table treasury_movements add column if not exists receipt_number text;
alter table treasury_movements add column if not exists receipt_vat numeric(14,2);
alter table treasury_movements add column if not exists proof_path text;

alter table treasury_movements drop constraint if exists treasury_movements_receipt_check;
alter table treasury_movements add constraint treasury_movements_receipt_check
  check ((receipt_number is null or char_length(receipt_number) <= 40)
         and (receipt_vat is null or receipt_vat >= 0)
         and (proof_path is null or char_length(proof_path) <= 300));

create unique index if not exists treasury_movements_origin_uidx
  on treasury_movements(reference_id, type) where type in ('sale_collection', 'sale_collection_void');
create index if not exists treasury_movements_sale_idx on treasury_movements(sale_id) where sale_id is not null;
create index if not exists treasury_movements_expense_account_idx
  on treasury_movements(expense_account_id) where expense_account_id is not null;

comment on column treasury_movements.sale_id is
  'ADR-158: venta de origen de un cobro por transferencia (sale_collection / sale_collection_void).';
comment on column treasury_movements.expense_account_id is
  'ADR-158 (H154): cuenta de gasto (acc_accounts, egreso) de un retiro que es un gasto; el asiento va contra ella.';

-- Las cuentas de sistema (cajas del POS y a acreditar) no tienen movimientos:
-- su saldo sale del turno o de los cobros sin liquidar. Cubre toda vía de alta
-- (movimiento manual, transferencia, orden de pago, cheque).
create or replace function trg_treasury_movements_account_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from treasury_accounts a
              where a.id = new.account_id and a.kind in ('pos_cash', 'receivable')) then
    raise exception 'treasury_system_account' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists treasury_movements_account_guard on treasury_movements;
create trigger treasury_movements_account_guard
  before insert on treasury_movements
  for each row execute function trg_treasury_movements_account_guard();

-- ¿El movimiento arma su propio asiento? Los que nacen de otro documento no:
-- el asiento lo arma el documento (venta, orden de pago) y la otra pata de una
-- transferencia entre cuentas va en el asiento de la que sale.
create or replace function treasury_movement_has_own_entry(p_type text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_type not in ('supplier_payment', 'supplier_payment_void', 'transfer_in',
                        'sale_collection', 'sale_collection_void');
$$;

-- Cobro por transferencia de una venta → movimiento en la cuenta vinculada.
-- Idempotente (índice único por cobro y tipo). Sólo con la feature tesoreria
-- y desde la fecha de apertura de la cuenta.
create or replace function treasury_sync_payment(p_tenant uuid, p_payment uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p     payments%rowtype;
  s     sales%rowtype;
  ta    treasury_accounts%rowtype;
  v_acc uuid;
  v_n   int := 0;
  v_lbl text;
  v_col uuid;
begin
  select * into p from payments where id = p_payment and tenant_id = p_tenant;
  if p.id is null or p.method <> 'transfer' or coalesce(p.amount, 0) = 0 or p.sale_id is null then
    return 0;
  end if;
  v_acc := treasury_account_of_payment(p_tenant, p.metadata);
  if v_acc is null or not tenant_has_feature_for(p_tenant, 'tesoreria') then
    return 0;
  end if;
  select * into s from sales where id = p.sale_id;
  if s.id is null or s.status = 'suspended' then
    return 0;
  end if;
  select * into ta from treasury_accounts where id = v_acc;
  if acc_ar_date(p.created_at) < ta.opening_date then
    return 0;
  end if;
  v_lbl := 'Venta #' || s.number || coalesce(' · op. ' || nullif(btrim(p.reference), ''), '');

  select id into v_col from treasury_movements where reference_id = p.id and type = 'sale_collection';
  if v_col is null then
    insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                    reference_type, reference_id, sale_id, created_by)
    values (p_tenant, ta.id, acc_ar_date(p.created_at), round(p.amount, 2), 'sale_collection',
            left('Cobro por transferencia · ' || v_lbl, 300), 'payment', p.id, s.id, auth.uid())
    on conflict do nothing
    returning id into v_col;
    if v_col is not null then
      v_n := v_n + 1;
    else
      select id into v_col from treasury_movements where reference_id = p.id and type = 'sale_collection';
    end if;
  end if;

  if s.status = 'voided' and v_col is not null
     and not exists (select 1 from treasury_movements where reference_id = p.id and type = 'sale_collection_void') then
    insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                    reference_type, reference_id, sale_id, counterpart_id, created_by)
    select p_tenant, c.account_id, acc_ar_date(coalesce(s.voided_at, now())), -c.amount, 'sale_collection_void',
           left('Anulación de la venta #' || s.number, 300), 'payment', p.id, s.id, c.id, auth.uid()
      from treasury_movements c where c.id = v_col
    on conflict do nothing;
    v_n := v_n + 1;
  end if;
  return v_n;
end;
$$;
revoke all on function treasury_sync_payment(uuid, uuid) from public, anon, authenticated;

-- Trigger diferido: nunca frena la venta. Corte rápido para los negocios sin
-- cuentas de cobro vinculadas (una búsqueda por índice).
create or replace function treasury_source_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if not exists (select 1 from treasury_account_transfer_accounts l
                  where l.tenant_id = new.tenant_id and l.deleted_at is null) then
    return null;
  end if;
  begin
    if tg_argv[0] = 'payment' then
      perform treasury_sync_payment(new.tenant_id, new.id);
    else
      for r in select id from payments where sale_id = new.id and tenant_id = new.tenant_id and method = 'transfer' loop
        perform treasury_sync_payment(new.tenant_id, r.id);
      end loop;
    end if;
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, auth.uid(), case when tg_argv[0] = 'payment' then 'payments' else 'sales' end,
            new.id, 'treasury_sync_failed', jsonb_build_object('error', left(sqlerrm, 500)));
  end;
  return null;
end;
$$;

drop trigger if exists treasury_payments_sync on payments;
create constraint trigger treasury_payments_sync
  after insert on payments
  deferrable initially deferred
  for each row when (new.method = 'transfer')
  execute function treasury_source_trg('payment');

drop trigger if exists treasury_sales_sync on sales;
create constraint trigger treasury_sales_sync
  after update on sales
  deferrable initially deferred
  for each row when (old.status is distinct from new.status)
  execute function treasury_source_trg('sale');

-- Vincular o desvincular una cuenta de cobro por transferencia. Al vincular
-- trae los cobros desde la fecha de apertura de la cuenta de Tesorería.
create or replace function treasury_account_link_transfer(p_treasury uuid, p_transfer uuid, p_linked boolean)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  ta       treasury_accounts;
  tr       transfer_accounts%rowtype;
  v_prev   treasury_account_transfer_accounts%rowtype;
  v_n      int := 0;
  r        record;
begin
  ta := treasury_account_get(v_tenant, p_treasury);
  select * into tr from transfer_accounts
   where id = p_transfer and tenant_id = v_tenant and deleted_at is null;
  if tr.id is null then
    raise exception 'transfer_account_not_found';
  end if;
  select * into v_prev from treasury_account_transfer_accounts
   where transfer_account_id = tr.id and deleted_at is null;

  if not coalesce(p_linked, false) then
    if v_prev.id is not null and v_prev.treasury_account_id = ta.id then
      update treasury_account_transfer_accounts set deleted_at = now(), deleted_by = auth.uid() where id = v_prev.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
      values (v_tenant, auth.uid(), 'treasury_accounts', ta.id, 'treasury_transfer_unlinked',
              jsonb_build_object('transfer_account_id', tr.id));
    end if;
    return 0;
  end if;

  if ta.kind not in ('bank', 'wallet') then
    raise exception 'treasury_account_kind_not_linkable';
  end if;
  if upper(coalesce(tr.currency, 'ARS')) <> ta.currency then
    raise exception 'currency_mismatch';
  end if;
  if v_prev.id is not null and v_prev.treasury_account_id = ta.id then
    return 0;
  end if;
  if v_prev.id is not null then
    update treasury_account_transfer_accounts set deleted_at = now(), deleted_by = auth.uid() where id = v_prev.id;
  end if;
  insert into treasury_account_transfer_accounts (tenant_id, treasury_account_id, transfer_account_id)
  values (v_tenant, ta.id, tr.id);

  for r in
    select p.id from payments p
     where p.tenant_id = v_tenant and p.method = 'transfer'
       and p.metadata -> 'transfer' ->> 'account_id' = tr.id::text
       and p.created_at >= acc_ar_start(ta.opening_date)
     order by p.created_at
     limit 5000
  loop
    v_n := v_n + treasury_sync_payment(v_tenant, r.id);
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'treasury_accounts', ta.id, 'treasury_transfer_linked',
          case when v_prev.id is not null then jsonb_build_object('treasury_account_id', v_prev.treasury_account_id) end,
          jsonb_build_object('transfer_account_id', tr.id, 'movements', v_n));
  return v_n;
end;
$$;
revoke all on function treasury_account_link_transfer(uuid, uuid, boolean) from public, anon;
grant execute on function treasury_account_link_transfer(uuid, uuid, boolean) to authenticated;

-- Movimiento manual (definición viva + gasto con cuenta, comprobante y adjunto).
-- p: {account_id, type: deposit|withdrawal|adjustment|other, amount > 0,
--     direction?: in|out, date?, description?,
--     withdrawal: expense_account_id?, receipt_number?, receipt_vat?, proof_path?}
create or replace function treasury_movement_create(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := treasury_assert();
  v_acc     treasury_accounts;
  v_type    text := coalesce(p ->> 'type', 'other');
  v_amount  numeric := round(coalesce((p ->> 'amount')::numeric, 0), 2);
  v_sign    int;
  v_id      uuid;
  v_expense uuid := nullif(p ->> 'expense_account_id', '')::uuid;
  v_receipt text := nullif(btrim(coalesce(p ->> 'receipt_number', '')), '');
  v_vat     numeric := round(nullif(p ->> 'receipt_vat', '')::numeric, 2);
  v_proof   text := nullif(btrim(coalesce(p ->> 'proof_path', '')), '');
begin
  v_acc := treasury_account_get(v_tenant, (p ->> 'account_id')::uuid);
  if v_acc.kind in ('pos_cash', 'receivable') then
    raise exception 'treasury_system_account';
  end if;
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

  -- Gasto (H154): sólo en retiros.
  if v_type <> 'withdrawal' then
    v_expense := null;
    v_receipt := null;
    v_vat := null;
    v_proof := null;
  end if;
  if v_expense is not null and not exists (
    select 1 from acc_accounts a
     where a.id = v_expense and a.tenant_id = v_tenant and a.deleted_at is null
       and a.imputable and a.is_active and a.kind = 'egreso') then
    raise exception 'expense_account_invalid';
  end if;
  if v_vat is not null and (v_vat < 0 or v_vat >= v_amount) then
    raise exception 'receipt_vat_invalid';
  end if;
  if v_vat = 0 then
    v_vat := null;
  end if;
  if v_receipt is not null and char_length(v_receipt) > 40 then
    raise exception 'receipt_number_invalid';
  end if;
  if v_proof is not null and v_proof !~ ('^' || v_tenant::text || '/[A-Za-z0-9._-]{1,200}$') then
    raise exception 'proof_path_invalid';
  end if;

  v_id := _treasury_move(v_tenant, v_acc.id, (nullif(p ->> 'date', ''))::date, v_sign * v_amount, v_type,
                         p ->> 'description');
  if v_expense is not null or v_receipt is not null or v_vat is not null or v_proof is not null then
    update treasury_movements
       set expense_account_id = v_expense, receipt_number = v_receipt, receipt_vat = v_vat, proof_path = v_proof
     where id = v_id;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'treasury_movements', v_id, 'treasury_movement_created',
          jsonb_build_object('account_id', v_acc.id, 'type', v_type, 'amount', v_sign * v_amount,
                             'description', p ->> 'description', 'expense_account_id', v_expense,
                             'receipt_number', v_receipt, 'receipt_vat', v_vat, 'proof_path', v_proof));
  return v_id;
end;
$$;
revoke all on function treasury_movement_create(jsonb) from public, anon;
grant execute on function treasury_movement_create(jsonb) to authenticated;

-- Comprobantes de gastos (bucket privado, carpeta = negocio).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('treasury-proofs', 'treasury-proofs', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "treasury_proofs_read" on storage.objects;
drop policy if exists "treasury_proofs_write" on storage.objects;
create policy "treasury_proofs_read" on storage.objects for select to authenticated
  using (bucket_id = 'treasury-proofs'
         and (storage.foldername(name))[1] = (select current_tenant_id())::text
         and (select stock_my_role()) in ('owner', 'manager'));
create policy "treasury_proofs_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'treasury-proofs'
              and (storage.foldername(name))[1] = (select current_tenant_id())::text
              and (select treasury_can_write()));

-- -----------------------------------------------------------------------------
-- E) Fechas argentinas (T5, T22).
-- -----------------------------------------------------------------------------
-- cheque_transition: definición viva; sin fecha toma el día de Argentina.
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
  v_date   date := coalesce((nullif(p ->> 'date', ''))::date,
                            (now() at time zone 'America/Argentina/Buenos_Aires')::date);
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

-- supplier_payment_void: definición viva; el contra-movimiento con la fecha de
-- Argentina.
create or replace function supplier_payment_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := purchase_assert(true);
  v_pay    supplier_payments;
  v_line   supplier_payment_lines;
  v_ch     cheques;
  v_shift  uuid;
  v_label  text;
  v_tm     treasury_movements;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_pay from supplier_payments where id = p_id and tenant_id = v_tenant for update;
  if v_pay.id is null then
    raise exception 'payment_not_found';
  end if;
  if v_pay.status <> 'posted' then
    raise exception 'payment_voided';
  end if;
  v_label := 'OP-' || lpad(v_pay.number::text, 6, '0');

  -- Cheques: ninguno puede estar depositado o rechazado.
  if exists (
    select 1 from supplier_payment_lines l join cheques c on c.id = l.cheque_id
     where l.payment_id = v_pay.id and c.status not in ('entregado')
  ) then
    raise exception 'payment_cheque_used';
  end if;

  for v_line in select * from supplier_payment_lines where payment_id = v_pay.id order by sort loop
    if v_line.cash_movement_id is not null then
      -- El efectivo vuelve a la caja propia abierta de quien anula.
      v_shift := (select cs.id from cash_shifts cs
                   where cs.tenant_id = v_tenant and cs.status = 'open' and cs.opened_by = auth.uid()
                   order by (cs.id = v_line.cash_shift_id) desc, cs.opened_at desc limit 1);
      if v_shift is null then
        raise exception 'cash_shift_required';
      end if;
      perform assert_shift_owner(v_shift, 'cash_in');
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id,
                                  created_by)
      values (v_tenant, v_shift, 'income', v_line.amount, 'cash', 'Anulación ' || v_label, v_pay.id, auth.uid());
    end if;

    if v_line.treasury_movement_id is not null then
      select * into v_tm from treasury_movements where id = v_line.treasury_movement_id;
      perform _treasury_move(v_tenant, v_tm.account_id,
                             (now() at time zone 'America/Argentina/Buenos_Aires')::date, -v_tm.amount,
                             'supplier_payment_void', 'Anulación ' || v_label, 'supplier_payment', v_pay.id);
    end if;

    if v_line.cheque_id is not null then
      select * into v_ch from cheques where id = v_line.cheque_id for update;
      if v_ch.kind = 'third_party' then
        update cheques set status = 'en_cartera', delivered_to_supplier_id = null, payment_id = null
         where id = v_ch.id;
      else
        update cheques set status = 'anulado' where id = v_ch.id;
      end if;
    end if;
  end loop;

  update supplier_payment_allocations set released_at = now()
   where payment_id = v_pay.id and released_at is null;

  update supplier_payments
     set status = 'voided', void_reason = trim(p_reason), voided_at = now(), voided_by = auth.uid()
   where id = p_id;
  perform purchase_log(v_tenant, 'payment', p_id, 'voided', 'posted', 'voided', p_reason,
                       jsonb_build_object('amount', v_pay.amount, 'kind', v_pay.kind));
end;
$$;
revoke all on function supplier_payment_void(uuid, text) from public, anon;
grant execute on function supplier_payment_void(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Lecturas: posición, a acreditar y alta de las cuentas de sistema.
-- -----------------------------------------------------------------------------
-- Cobros sin liquidar (a acreditar) de los últimos 180 días: con procesador,
-- de ventas completadas, sin conciliar y sin línea de liquidación acreditada.
create or replace function _treasury_pending(p_tenant uuid)
returns table (payment_id uuid, sale_id uuid, sale_number bigint, method text, provider_key text,
               amount numeric, created_at timestamptz, store_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.id, x.sale_id, x.number, x.method, x.prov, x.amount, x.created_at, x.store_id
    from (
      select p.id, p.sale_id, s.number, p.method,
             treasury_payment_provider(p_tenant, p.method, p.reference, p.card_voucher) as prov,
             p.amount, p.created_at, s.store_id
        from payments p
        join sales s on s.id = p.sale_id and s.status = 'completed'
       where p.tenant_id = p_tenant
         and p.created_at >= now() - interval '180 days'
         and p.method in ('debit', 'credit', 'qr', 'directo', 'ualabis', 'mercadolibre', 'plataforma')
         and p.reconciled_at is null
         and coalesce(p.amount, 0) > 0
         and not exists (select 1 from settlement_lines sl
                          where sl.payment_id = p.id and sl.tenant_id = p_tenant and sl.released)
    ) x
   where x.prov is not null;
$$;
revoke all on function _treasury_pending(uuid) from public, anon, authenticated;

create or replace function treasury_pending_collections(p_provider text default null)
returns table (payment_id uuid, sale_id uuid, sale_number bigint, method text, provider_key text,
               amount numeric, created_at timestamptz, store_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
begin
  return query
    select t.payment_id, t.sale_id, t.sale_number, t.method, t.provider_key, round(t.amount, 2), t.created_at, t.store_id
      from _treasury_pending(v_tenant) t
     where p_provider is null or t.provider_key = p_provider
     order by t.created_at desc
     limit 500;
end;
$$;
revoke all on function treasury_pending_collections(text) from public, anon;
grant execute on function treasury_pending_collections(text) to authenticated;

-- Crea las cajas del POS y los "a acreditar" que falten. Devuelve cuántas creó.
create or replace function treasury_accounts_sync()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
  v_n      int := 0;
  r        record;
begin
  for r in
    select cr.id from cash_registers cr
     where cr.tenant_id = v_tenant and cr.deleted_at is null
       and not exists (select 1 from treasury_accounts ta
                        where ta.cash_register_id = cr.id and ta.kind = 'pos_cash' and ta.deleted_at is null)
  loop
    perform _treasury_ensure_pos_cash(r.id);
    v_n := v_n + 1;
  end loop;

  for r in
    select distinct t.provider_key from _treasury_pending(v_tenant) t
     where not exists (select 1 from treasury_accounts ta
                        where ta.tenant_id = v_tenant and ta.kind = 'receivable'
                          and ta.provider_key = t.provider_key and ta.deleted_at is null)
  loop
    insert into treasury_accounts (tenant_id, kind, name, provider_key, is_system, currency, opening_balance, opening_date)
    values (v_tenant, 'receivable', left('A acreditar ' || treasury_provider_label(r.provider_key), 80),
            r.provider_key, true, 'ARS', 0, (now() at time zone 'America/Argentina/Buenos_Aires')::date)
    on conflict do nothing;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function treasury_accounts_sync() from public, anon;
grant execute on function treasury_accounts_sync() to authenticated;

-- Posición: una fila por cuenta con su saldo. Bancos, cajas generales y
-- billeteras: saldo inicial + movimientos. Cajas del POS: esperado del turno
-- abierto o contado del último cierre. A acreditar: cobros sin liquidar
-- (estimado de los últimos 180 días).
create or replace function treasury_position()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
begin
  return coalesce((
    with acc as (
      select a.* from treasury_accounts a where a.tenant_id = v_tenant and a.deleted_at is null
    ), mv as (
      select m.account_id,
             coalesce(sum(m.amount) filter (where m.voided_at is null), 0) as total,
             coalesce(sum(m.amount) filter (where m.voided_at is null and m.reconciled_at is not null), 0) as rec,
             count(*) filter (where m.voided_at is null and m.reconciled_at is null)::int as unrec,
             max(m.movement_date) filter (where m.voided_at is null) as last_date
        from treasury_movements m
       where m.tenant_id = v_tenant
       group by m.account_id
    ), pend as (
      select t.provider_key, sum(t.amount) as amount, count(*)::int as n,
             min(acc_ar_date(t.created_at)) as oldest
        from _treasury_pending(v_tenant) t
       group by t.provider_key
    ), pos as (
      select a.id as account_id, o.id as open_shift, o.opened_at, o.opening_amount,
             (select coalesce(sum(case when cm.type = 'income' then cm.amount
                                       when cm.type = 'expense' then -cm.amount
                                       when cm.type = 'sale' and cm.payment_method = 'cash' then cm.amount
                                       when cm.type = 'sale_void' and cm.payment_method = 'cash' then -cm.amount
                                       else 0 end), 0)
                from cash_movements cm where cm.cash_shift_id = o.id) as delta,
             c.closing_amount, c.closed_at
        from acc a
        left join lateral (
          select cs.id, cs.opened_at, cs.opening_amount from cash_shifts cs
           where cs.cash_register_id = a.cash_register_id and cs.status = 'open'
           order by cs.opened_at desc limit 1) o on true
        left join lateral (
          select cs.closing_amount, cs.closed_at from cash_shifts cs
           where cs.cash_register_id = a.cash_register_id and cs.status = 'closed'
           order by cs.closed_at desc limit 1) c on true
       where a.kind = 'pos_cash'
    ), links as (
      select l.treasury_account_id,
             jsonb_agg(jsonb_build_object('id', t.id, 'bank_name', t.bank_name, 'alias', t.alias,
                                          'holder_name', t.holder_name) order by t.sort, t.bank_name) as items
        from treasury_account_transfer_accounts l
        join transfer_accounts t on t.id = l.transfer_account_id
       where l.tenant_id = v_tenant and l.deleted_at is null
       group by l.treasury_account_id
    ), ledger as (
      select distinct on (split_part(m.qualifier, ':', 2))
             split_part(m.qualifier, ':', 2) as account_ref,
             jsonb_build_object('id', aa.id, 'code', aa.code, 'name', aa.name) as obj
        from acc_mappings m
        join acc_accounts aa on aa.id = m.account_id and aa.deleted_at is null
       where m.tenant_id = v_tenant and m.concept = 'tesoreria' and m.qualifier like '%:%'
       order by split_part(m.qualifier, ':', 2), (m.store_id is null) desc
    )
    select jsonb_agg(jsonb_build_object(
             'account_id', a.id,
             'kind', a.kind,
             'name', a.name,
             'currency', a.currency,
             'store_id', a.store_id,
             'provider_key', a.provider_key,
             'cash_register_id', a.cash_register_id,
             'is_active', a.is_active,
             'is_system', a.is_system,
             'balance', round(case
                 when a.kind = 'pos_cash' then
                   case when p.open_shift is not null then p.opening_amount + p.delta else coalesce(p.closing_amount, 0) end
                 when a.kind = 'receivable' then coalesce(pe.amount, 0)
                 else a.opening_balance + coalesce(mv.total, 0) end, 2),
             'reconciled_balance', round(case when a.kind in ('pos_cash', 'receivable') then 0
                                              else a.opening_balance + coalesce(mv.rec, 0) end, 2),
             'unreconciled_count', coalesce(mv.unrec, 0),
             'last_movement', mv.last_date,
             'detail', case
                 when a.kind = 'pos_cash' then jsonb_build_object(
                   'shift_open', p.open_shift is not null, 'opened_at', p.opened_at,
                   'closed_at', p.closed_at, 'counted', p.closing_amount)
                 when a.kind = 'receivable' then jsonb_build_object(
                   'pending_count', coalesce(pe.n, 0), 'oldest_date', pe.oldest)
                 else '{}'::jsonb end,
             'transfer_accounts', coalesce(l.items, '[]'::jsonb),
             'ledger_account', lg.obj
           ) order by case a.kind when 'pos_cash' then 1 when 'cash' then 2 when 'bank' then 3
                                  when 'wallet' then 4 else 5 end, a.name)
      from acc a
      left join mv on mv.account_id = a.id
      left join pos p on p.account_id = a.id
      left join pend pe on a.kind = 'receivable' and pe.provider_key = a.provider_key
      left join links l on l.treasury_account_id = a.id
      left join ledger lg on lg.account_ref = a.id::text
  ), '[]'::jsonb);
end;
$$;
revoke all on function treasury_position() from public, anon;
grant execute on function treasury_position() to authenticated;
