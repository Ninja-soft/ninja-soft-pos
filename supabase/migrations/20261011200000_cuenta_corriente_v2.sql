-- =============================================================================
-- 20261011200000_cuenta_corriente_v2  (H31 · Cuenta corriente v2: esquema)
--
-- Spec: docs/specs/cuenta-corriente-v2.md · ADR-037.
-- Parte 1 de 3 (esquema). La 2 (20261011200100) define las RPC y el trigger de
-- cargo; la 3 (20261011200200) las reversas por anulación/devolución y el Z.
--
-- Qué hace:
--  A) Ledger customer_account_movements: tipo de movimiento (`kind`) con
--     backfill por signo, cuotas, padre (interés/condonación/reversa → cargo),
--     medio y caja del cobro, recibo correlativo, idempotencia, nota, período
--     de interés, anulación lógica. CHECK de signo coherente con `kind`.
--  B) customer_account_allocations: imputación de cobros/créditos a cargos
--     (con liberación lógica `released_at`, nunca DELETE).
--  C) account_collection_items: notas, promesas de pago, tareas y bitácora de
--     recordatorios (cobranza).
--  D) Configuración: pos_settings / customer_groups / customers.account_config
--     (jsonb validado), customers.credit_status y collector_user_id.
--  E) RLS: el ledger y las tablas nuevas se ESCRIBEN sólo vía RPC security
--     definer (se revoca el insert directo que usaba "Cobrar deuda").
--  F) Features de plan cc_punitorios / cc_cobranza (mismo plan que
--     cuenta_corriente) y payment_method_plan_key('account') → cuenta_corriente.
--  G) cash_movements acepta los cobros no efectivo de cuenta corriente
--     (account_payment / account_payment_void); system_emails acepta los envíos
--     account_reminder / account_statement.
--  H) Guard + auditoría de los campos de crédito del cliente.
--
-- Migraciones aplicadas NO se tocan: todo es aditivo o `create or replace`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Ledger
-- -----------------------------------------------------------------------------
alter table customer_account_movements
  add column if not exists kind            text,
  add column if not exists installment_no  int,
  add column if not exists installments    int,
  add column if not exists parent_id       uuid references customer_account_movements(id) on delete cascade,
  add column if not exists method          text,
  add column if not exists cash_shift_id   uuid references cash_shifts(id),
  add column if not exists receipt_no      bigint,
  add column if not exists idempotency_key text,
  add column if not exists note            text,
  add column if not exists period          date,
  add column if not exists voided_at       timestamptz,
  add column if not exists voided_by       uuid references public.users(id);

-- Backfill: hasta hoy sólo existían cargos (trigger de venta, delta > 0) y pagos
-- manuales ("Pago de deuda", delta < 0). Un delta 0 (pago de $0 cargado a mano)
-- se considera pago.
update customer_account_movements
   set kind = case when delta > 0 then 'charge' else 'payment' end
 where kind is null;

alter table customer_account_movements alter column kind set not null;

-- Cargos anteriores a 20260607180000 no tienen vencimiento: se asume fecha + 30
-- (el mismo supuesto que hacía el cálculo FIFO del front).
update customer_account_movements
   set due_date = (created_at at time zone 'America/Argentina/Buenos_Aires')::date + 30
 where kind = 'charge' and due_date is null;

alter table customer_account_movements drop constraint if exists cam_kind_check;
alter table customer_account_movements add constraint cam_kind_check check (
  kind in ('charge', 'payment', 'interest', 'interest_waiver',
           'adjust_debit', 'adjust_credit', 'reversal'));

-- Signo coherente con el tipo: débitos suman deuda, créditos la restan. (>= / <=
-- para no romper filas históricas en 0.)
alter table customer_account_movements drop constraint if exists cam_sign_check;
alter table customer_account_movements add constraint cam_sign_check check (
  (kind in ('charge', 'interest', 'adjust_debit') and delta >= 0)
  or (kind in ('payment', 'interest_waiver', 'adjust_credit', 'reversal') and delta <= 0));

alter table customer_account_movements drop constraint if exists cam_installments_check;
alter table customer_account_movements add constraint cam_installments_check check (
  (installments is null or installments between 1 and 24)
  and (installment_no is null or (installment_no >= 1 and installment_no <= coalesce(installments, 24))));

alter table customer_account_movements drop constraint if exists cam_method_check;
alter table customer_account_movements add constraint cam_method_check check (
  method is null or method in ('cash', 'debit', 'credit', 'transfer', 'qr', 'other'));

-- Interés, condonación y reversa siempre cuelgan de un débito.
alter table customer_account_movements drop constraint if exists cam_parent_check;
alter table customer_account_movements add constraint cam_parent_check check (
  kind not in ('interest', 'interest_waiver', 'reversal') or parent_id is not null);

create index if not exists cam_customer_created_idx
  on customer_account_movements (tenant_id, customer_id, created_at);
create index if not exists cam_parent_idx
  on customer_account_movements (parent_id) where parent_id is not null;
create index if not exists cam_sale_idx
  on customer_account_movements (sale_id) where sale_id is not null;
create index if not exists cam_due_idx
  on customer_account_movements (tenant_id, due_date) where kind in ('charge', 'interest', 'adjust_debit');
create index if not exists cam_shift_idx
  on customer_account_movements (cash_shift_id) where cash_shift_id is not null;

-- Recibo correlativo por tenant (lo asigna account_collect con advisory lock).
create unique index if not exists cam_receipt_uniq
  on customer_account_movements (tenant_id, receipt_no) where receipt_no is not null;
-- Idempotencia de cobros (doble click / reintento de red).
create unique index if not exists cam_idempotency_uniq
  on customer_account_movements (tenant_id, idempotency_key) where idempotency_key is not null;
-- Un movimiento de interés por cargo y período.
create unique index if not exists cam_interest_period_uniq
  on customer_account_movements (parent_id, period) where kind = 'interest';

comment on column customer_account_movements.kind is
  'charge|payment|interest|interest_waiver|adjust_debit|adjust_credit|reversal. '
  'Débitos (charge/interest/adjust_debit) delta>=0; créditos delta<=0.';
comment on column customer_account_movements.parent_id is
  'Débito al que aplica un interest (cargo), interest_waiver (interés) o reversal (cargo).';

-- -----------------------------------------------------------------------------
-- B) Imputaciones
-- -----------------------------------------------------------------------------
create table if not exists customer_account_allocations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  payment_id  uuid not null references customer_account_movements(id) on delete cascade,
  charge_id   uuid not null references customer_account_movements(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references public.users(id),
  -- Liberación lógica (anulación del cobro o reversa del cargo): la fila queda
  -- como historia y deja de contar.
  released_at timestamptz
);
create index if not exists caa_payment_idx on customer_account_allocations (payment_id) where released_at is null;
create index if not exists caa_charge_idx on customer_account_allocations (charge_id) where released_at is null;
create index if not exists caa_tenant_idx on customer_account_allocations (tenant_id);

alter table customer_account_allocations enable row level security;
drop policy if exists caa_select on customer_account_allocations;
create policy caa_select on customer_account_allocations
  for select using (tenant_id = (select current_tenant_id()) or (select is_internal()));

-- -----------------------------------------------------------------------------
-- C) Cobranza: notas, promesas, tareas y bitácora de recordatorios
-- -----------------------------------------------------------------------------
create table if not exists account_collection_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  customer_id    uuid not null references customers(id) on delete cascade,
  type           text not null check (type in ('note', 'promise', 'task', 'reminder_log')),
  body           text,
  promise_date   date,
  promise_amount numeric(12,2) check (promise_amount is null or promise_amount > 0),
  status         text not null default 'open'
                   check (status in ('open', 'done', 'kept', 'broken', 'cancelled', 'sent', 'failed')),
  due_at         timestamptz,
  assignee       uuid references public.users(id),
  done_at        timestamptz,
  -- Recordatorios: canal y clave de deduplicación (p. ej. 'after:7:2026-11-10').
  channel        text check (channel is null or channel in ('email', 'whatsapp')),
  dedupe_key     text,
  meta           jsonb not null default '{}'::jsonb,
  created_by     uuid default auth.uid() references public.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint aci_promise_check check (type <> 'promise' or (promise_date is not null and promise_amount is not null))
);
create index if not exists aci_customer_idx
  on account_collection_items (tenant_id, customer_id, created_at desc) where deleted_at is null;
create index if not exists aci_open_idx
  on account_collection_items (tenant_id, type, status) where deleted_at is null;
create unique index if not exists aci_dedupe_uniq
  on account_collection_items (tenant_id, customer_id, dedupe_key) where dedupe_key is not null;

drop trigger if exists set_updated_at_account_collection_items on account_collection_items;
create trigger set_updated_at_account_collection_items
  before update on account_collection_items
  for each row execute function set_updated_at();

alter table account_collection_items enable row level security;
drop policy if exists aci_select on account_collection_items;
create policy aci_select on account_collection_items
  for select using (tenant_id = (select current_tenant_id()) or (select is_internal()));

-- -----------------------------------------------------------------------------
-- D) Configuración
-- -----------------------------------------------------------------------------

-- Default de la config (ESPEJO de ACCOUNT_CONFIG_DEFAULT en lib/account/config.ts).
create or replace function account_config_default()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select '{
    "terms":        {"mode": "days", "days": 30, "cutoff_day": 25, "due_day": 10},
    "installments": {"enabled": false, "max": 6, "interval_days": 30},
    "interest":     {"enabled": false, "rate_pct": 3, "period": "monthly", "method": "simple",
                     "grace_days": 5, "cap_pct": 50, "min_amount": 0},
    "blocking":     {"overdue_days": null, "allow_manager_override": true},
    "reminders":    {"before_days": [3], "after_days": [1, 7, 15], "channel": "email"}
  }'::jsonb;
$$;

-- Número en rango (o null si se permite). Para el CHECK de la config.
create or replace function _account_num_ok(v jsonb, lo numeric, hi numeric, nullable boolean default false)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if v is null then
    return true; -- clave ausente
  end if;
  if jsonb_typeof(v) = 'null' then
    return nullable;
  end if;
  if jsonb_typeof(v) <> 'number' then
    return false;
  end if;
  return (v #>> '{}')::numeric between lo and hi;
end;
$$;

-- Validación (parcial) de un account_config. Espeja accountConfigOverrideSchema
-- (Zod): toda clave es opcional; si está, tiene que tener el tipo y rango
-- correcto. null = hereda.
create or replace function account_config_valid(c jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t jsonb;
  e jsonb;
begin
  if c is null then
    return true;
  end if;
  if jsonb_typeof(c) <> 'object' then
    return false;
  end if;

  t := c -> 'terms';
  if t is not null then
    if jsonb_typeof(t) <> 'object' then return false; end if;
    if t ? 'mode' and coalesce(t ->> 'mode', '') not in ('days', 'monthly_cutoff') then return false; end if;
    if not _account_num_ok(t -> 'days', 0, 365) then return false; end if;
    if not _account_num_ok(t -> 'cutoff_day', 1, 31) then return false; end if;
    if not _account_num_ok(t -> 'due_day', 1, 31) then return false; end if;
  end if;

  t := c -> 'installments';
  if t is not null then
    if jsonb_typeof(t) <> 'object' then return false; end if;
    if t ? 'enabled' and jsonb_typeof(t -> 'enabled') <> 'boolean' then return false; end if;
    if not _account_num_ok(t -> 'max', 1, 24) then return false; end if;
    if not _account_num_ok(t -> 'interval_days', 1, 90) then return false; end if;
  end if;

  t := c -> 'interest';
  if t is not null then
    if jsonb_typeof(t) <> 'object' then return false; end if;
    if t ? 'enabled' and jsonb_typeof(t -> 'enabled') <> 'boolean' then return false; end if;
    if not _account_num_ok(t -> 'rate_pct', 0, 100) then return false; end if;
    if t ? 'period' and coalesce(t ->> 'period', '') not in ('monthly', 'daily') then return false; end if;
    if t ? 'method' and coalesce(t ->> 'method', '') not in ('simple', 'compound') then return false; end if;
    if not _account_num_ok(t -> 'grace_days', 0, 90) then return false; end if;
    if not _account_num_ok(t -> 'cap_pct', 0, 1000, true) then return false; end if;
    if not _account_num_ok(t -> 'min_amount', 0, 1e12) then return false; end if;
  end if;

  t := c -> 'blocking';
  if t is not null then
    if jsonb_typeof(t) <> 'object' then return false; end if;
    if not _account_num_ok(t -> 'overdue_days', 0, 365, true) then return false; end if;
    if t ? 'allow_manager_override' and jsonb_typeof(t -> 'allow_manager_override') <> 'boolean' then
      return false;
    end if;
  end if;

  t := c -> 'reminders';
  if t is not null then
    if jsonb_typeof(t) <> 'object' then return false; end if;
    if t ? 'channel' and coalesce(t ->> 'channel', '') not in ('email') then return false; end if;
    foreach e in array array[t -> 'before_days', t -> 'after_days'] loop
      if e is not null then
        if jsonb_typeof(e) <> 'array' or jsonb_array_length(e) > 10 then return false; end if;
        if exists (select 1 from jsonb_array_elements(e) x where not _account_num_ok(x, 0, 365)) then
          return false;
        end if;
      end if;
    end loop;
  end if;

  return true;
end;
$$;

alter table pos_settings     add column if not exists account_config jsonb;
alter table customer_groups  add column if not exists account_config jsonb;
alter table customers        add column if not exists account_config jsonb;
alter table customers        add column if not exists credit_status text not null default 'ok';
alter table customers        add column if not exists collector_user_id uuid references public.users(id);

alter table pos_settings drop constraint if exists pos_settings_account_config_check;
alter table pos_settings add constraint pos_settings_account_config_check
  check (account_config_valid(account_config));
alter table customer_groups drop constraint if exists customer_groups_account_config_check;
alter table customer_groups add constraint customer_groups_account_config_check
  check (account_config_valid(account_config));
alter table customers drop constraint if exists customers_account_config_check;
alter table customers add constraint customers_account_config_check
  check (account_config_valid(account_config));
alter table customers drop constraint if exists customers_credit_status_check;
alter table customers add constraint customers_credit_status_check
  check (credit_status in ('ok', 'watch', 'blocked'));

-- Migración del plazo plano: account_due_days → account_config.terms.days (sólo
-- donde el negocio todavía no tiene config). La columna vieja queda como
-- respaldo de lectura (account_effective_config la usa si falta la config).
update pos_settings
   set account_config = jsonb_build_object('terms', jsonb_build_object('mode', 'days', 'days', account_due_days))
 where account_config is null and account_due_days is not null;

-- Merge profundo de jsonb (objetos se mezclan, el resto se reemplaza). Espeja
-- merge() de lib/account/config.ts. null en `b` = no tocar.
create or replace function account_jsonb_merge(a jsonb, b jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  k   text;
  out jsonb;
begin
  if b is null or jsonb_typeof(b) <> 'object' then
    return a;
  end if;
  if a is null or jsonb_typeof(a) <> 'object' then
    return b;
  end if;
  out := a;
  for k in select jsonb_object_keys(b) loop
    if jsonb_typeof(a -> k) = 'object' and jsonb_typeof(b -> k) = 'object' then
      out := jsonb_set(out, array[k], account_jsonb_merge(a -> k, b -> k));
    else
      out := jsonb_set(out, array[k], b -> k);
    end if;
  end loop;
  return out;
end;
$$;

-- Config efectiva de un cliente: default ← negocio ← grupo ← cliente.
create or replace function account_effective_config(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_group  uuid;
  v_cust   jsonb;
  v_grp    jsonb;
  v_ten    jsonb;
  v_days   int;
  v_cfg    jsonb := account_config_default();
begin
  select c.tenant_id, c.group_id, c.account_config into v_tenant, v_group, v_cust
    from customers c where c.id = p_customer;
  if v_tenant is null then
    return v_cfg;
  end if;
  select ps.account_config, ps.account_due_days into v_ten, v_days
    from pos_settings ps where ps.tenant_id = v_tenant;
  if v_days is not null then
    v_cfg := account_jsonb_merge(v_cfg, jsonb_build_object('terms', jsonb_build_object('days', v_days)));
  end if;
  if v_group is not null then
    select g.account_config into v_grp from customer_groups g where g.id = v_group and g.tenant_id = v_tenant;
  end if;
  return account_jsonb_merge(account_jsonb_merge(account_jsonb_merge(v_cfg, v_ten), v_grp), v_cust);
end;
$$;
-- Sin grant a authenticated: no chequea tenant (la usan las RPC/trigger, que sí
-- lo hacen). El front arma la efectiva con lib/account/config.ts.
revoke all on function account_effective_config(uuid) from public, anon, authenticated;
grant execute on function account_effective_config(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- E) RLS del ledger: escrituras SÓLO por RPC (security definer).
-- -----------------------------------------------------------------------------
drop policy if exists cust_account_write on customer_account_movements;
revoke insert, update, delete on customer_account_movements from anon, authenticated;
revoke insert, update, delete on customer_account_allocations from anon, authenticated;
revoke insert, update, delete on account_collection_items from anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) Features de plan (convención CLAUDE.md, pasos 1 y 2)
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('cc_punitorios', 'Punitorios de cuenta corriente',
   'Cálculo y devengo automático de intereses por mora y condonación', 'ventas', false, 51),
  ('cc_cobranza', 'Gestión de cobranza',
   'Recordatorios automáticos, promesas de pago, notas, tareas y cobrador asignado', 'ventas', false, 52)
on conflict (key) do nothing;

-- Mismo análisis comercial que cuenta_corriente: cada plan (global o a medida)
-- las hereda con el valor que tiene cuenta_corriente (Business+ en los globales).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'cc_punitorios', coalesce((p.limits -> 'modules' ->> 'cuenta_corriente')::boolean, false),
         'cc_cobranza',   coalesce((p.limits -> 'modules' ->> 'cuenta_corriente')::boolean, false)
       ),
  true
)
where not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'cc_punitorios');

-- Gating del medio: 'account' → feature cuenta_corriente. Redefine la última
-- versión (20261011150000_payment_channels) agregando sólo esas dos líneas, así
-- el trigger BEFORE INSERT de payments (trg_payments_assert_method) corta las
-- ventas a cuenta de un plan sin la feature, venga de donde venga.
create or replace function payment_method_plan_key(p_method text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_method, ''))
    when 'cash'              then 'efectivo'
    when 'efectivo'          then 'efectivo'
    when 'transfer'          then 'transferencia'
    when 'transferencia'     then 'transferencia'
    when 'mercadopago'       then 'mercado_pago'
    when 'mp'                then 'mercado_pago'
    when 'mercado_pago'      then 'mercado_pago'
    when 'mercadopago_point' then 'mercadopago_point'
    when 'modo'              then 'modo'
    when 'mobbex'            then 'mobbex'
    when 'payway'            then 'payway'
    when 'payway_point'      then 'payway_point'
    when 'getnet'            then 'getnet'
    when 'getnet_point'      then 'getnet_point'
    when 'fiserv'            then 'fiserv'
    when 'pagos360'          then 'pagos360'
    when 'nave'              then 'nave'
    when 'nave_point'        then 'nave_point'
    when 'account'           then 'cuenta_corriente'
    when 'cuenta_corriente'  then 'cuenta_corriente'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- G) Caja y emails
-- -----------------------------------------------------------------------------
-- Cobros de cuenta corriente en caja: en EFECTIVO entran como 'income' (y su
-- anulación como 'expense') para que el arqueo existente los cuente sin cambios;
-- con otros medios entran como 'account_payment' (no suman al efectivo esperado
-- pero quedan en el turno y en el Z). Ver account_collect / account_void_payment.
alter table cash_movements drop constraint if exists cash_movements_type_check;
alter table cash_movements add constraint cash_movements_type_check
  check (type in ('income', 'expense', 'sale', 'sale_void', 'account_payment', 'account_payment_void'));

alter table system_emails drop constraint if exists system_emails_kind_check;
alter table system_emails add constraint system_emails_kind_check
  check (kind in ('system', 'receipt', 'smtp_test', 'account_reminder', 'account_statement'));

-- Devoluciones de ventas a cuenta: el reintegro puede ir a la cuenta corriente.
alter table sale_returns drop constraint if exists sale_returns_refund_method_check;
alter table sale_returns add constraint sale_returns_refund_method_check
  check (refund_method in ('cash', 'store_credit', 'account'));
alter table sale_returns add column if not exists account_credited numeric(12,2) not null default 0;

-- Z: cobros de cuenta corriente del turno por medio.
alter table cash_z_closures add column if not exists account_collected jsonb not null default '{}'::jsonb;

-- -----------------------------------------------------------------------------
-- H) Guard de los campos de crédito del cliente
--    customers tiene RLS de aislamiento (cualquier miembro edita la ficha). Los
--    campos de crédito (límite, config, estado, cobrador) sólo los cambia el
--    dueño o un encargado, y todo cambio queda en audit_logs. Service role /
--    cron (auth.uid() null) pasa.
-- -----------------------------------------------------------------------------
create or replace function trg_customers_credit_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.account_config is not null
              or coalesce(new.credit_status, 'ok') <> 'ok'
              or new.collector_user_id is not null;
  else
    v_changed := new.credit_limit is distinct from old.credit_limit
              or new.account_config is distinct from old.account_config
              or new.credit_status is distinct from old.credit_status
              or new.collector_user_id is distinct from old.collector_user_id;
  end if;

  if not v_changed then
    return new;
  end if;

  if auth.uid() is not null and not is_tenant_manager() then
    raise exception 'forbidden_account_fields' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
    values (new.tenant_id, auth.uid(), 'customers', new.id, 'account_terms_changed',
      jsonb_build_object('credit_limit', old.credit_limit, 'account_config', old.account_config,
                         'credit_status', old.credit_status, 'collector_user_id', old.collector_user_id),
      jsonb_build_object('credit_limit', new.credit_limit, 'account_config', new.account_config,
                         'credit_status', new.credit_status, 'collector_user_id', new.collector_user_id));
  end if;
  return new;
end;
$$;
revoke all on function trg_customers_credit_guard() from public, anon, authenticated;

drop trigger if exists customers_credit_guard on customers;
create trigger customers_credit_guard
  before insert or update on customers
  for each row execute function trg_customers_credit_guard();
