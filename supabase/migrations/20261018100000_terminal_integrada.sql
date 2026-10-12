-- =============================================================================
-- 20261018100000_terminal_integrada  (F8 · ADR-053)
--
-- Terminal integrada: la terminal de tarjeta (posnet con cable / LAN o pinpad
-- conectado a la PC) cobra y le devuelve al POS los datos del cupón. La
-- comunicación con el equipo es local (navegador por Web Serial / WebUSB o el
-- puente local); el servidor registra y valida lo que se escribe.
--
--   A) Feature de plan `terminal_integrada` (OPTIONAL, grupo pagos): Pro,
--      Business y Enterprise.
--   B) payment_terminals.kind suma 'posnet_integrado' y 'pinpad' (marcas
--      payway, fiserv, getnet). Gating en el trigger de reglas: dar de alta,
--      pasar a integrada o reactivar una integrada exige la feature y que la
--      marca esté en el plan.
--   C) terminal_transactions: bitácora de cada operación con la terminal
--      (venta, anulación, devolución, cierre de lote, prueba) con el resultado
--      normalizado y la respuesta cruda. Sólo lectura por RLS; escritura sólo
--      por la RPC terminal_tx_record (rol, sucursal, feature, auditoría).
--   D) Trigger en payments: un pago cuyo card_voucher dice origen 'terminal'
--      tiene que traer terminal_tx de una venta APROBADA del mismo negocio,
--      del mismo monto, de las últimas 24 h y no usada por otro pago; la
--      feature tiene que estar activa. Así el "cupón informado por la
--      terminal" no se puede inventar desde el navegador.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('terminal_integrada', 'Terminal integrada',
   'Posnet o pinpad conectado a la caja: cobra el monto que manda el POS y devuelve lote, cupón, autorización, tarjeta y cuotas',
   'pagos', false, 66)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('terminal_integrada', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'terminal_integrada');

-- -----------------------------------------------------------------------------
-- B) Tipos de terminal y reglas
-- -----------------------------------------------------------------------------
alter table payment_terminals drop constraint if exists payment_terminals_kind_check;
alter table payment_terminals add constraint payment_terminals_kind_check
  check (kind in ('point', 'qr_caja', 'clover', 'posnet_manual', 'posnet_integrado', 'pinpad'));

create or replace function payment_terminals_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reg_store  uuid;
  v_integrated boolean := new.kind in ('posnet_integrado', 'pinpad');
begin
  if not exists (select 1 from stores where id = new.store_id and tenant_id = new.tenant_id) then
    raise exception 'store_not_found' using errcode = '23503';
  end if;
  if new.cash_register_id is not null then
    select store_id into v_reg_store from cash_registers
     where id = new.cash_register_id and tenant_id = new.tenant_id;
    if v_reg_store is null then raise exception 'register_not_found' using errcode = '23503'; end if;
    if v_reg_store <> new.store_id then raise exception 'register_store_mismatch' using errcode = '23514'; end if;
  end if;

  if (new.kind = 'qr_caja' and new.provider_key <> 'mercadopago')
     or (new.kind = 'clover' and new.provider_key <> 'fiserv_point')
     or (new.kind = 'point' and new.provider_key not in ('mercadopago_point', 'nave_point',
                                                         'payway_point', 'getnet_point'))
     or (v_integrated and new.provider_key not in ('payway', 'fiserv', 'getnet')) then
    raise exception 'terminal_kind_mismatch' using errcode = '23514';
  end if;

  -- Gating (ADR-053): alta, cambio a integrada o reactivación de una
  -- integrada. Bajar de plan no borra la terminal: deja de poder usarse (el
  -- trigger de payments y la RPC de bitácora vuelven a mirar la feature).
  if v_integrated and new.deleted_at is null and new.active
     and (tg_op = 'INSERT' or old.kind is distinct from new.kind or not old.active or old.deleted_at is not null) then
    if not tenant_has_feature_for(new.tenant_id, 'terminal_integrada') then
      raise exception 'feature_not_in_plan: terminal_integrada' using errcode = '42501';
    end if;
    if not tenant_has_feature_for(new.tenant_id, payment_method_plan_key(new.provider_key)) then
      raise exception 'feature_not_in_plan: %', new.provider_key using errcode = '42501';
    end if;
  end if;

  new.label := btrim(new.label);
  -- Sin caja no hay default; archivada no queda default.
  if new.cash_register_id is null or new.deleted_at is not null then
    new.is_default := false;
  end if;
  -- Un solo default por caja y proveedor: el nuevo desplaza al anterior.
  if new.is_default and (tg_op = 'INSERT' or not old.is_default
                         or new.cash_register_id is distinct from old.cash_register_id) then
    update payment_terminals
       set is_default = false
     where cash_register_id = new.cash_register_id
       and provider_key = new.provider_key
       and is_default and deleted_at is null
       and id <> new.id;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Bitácora de operaciones con la terminal
-- -----------------------------------------------------------------------------
create table if not exists terminal_transactions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  terminal_id      uuid not null references payment_terminals(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  cash_register_id uuid references cash_registers(id) on delete set null,
  op               text not null check (op in ('sale', 'void', 'refund', 'close_batch', 'test')),
  status           text not null check (status in ('approved', 'declined', 'timeout', 'cancelled', 'error')),
  amount           numeric(12,2) check (amount is null or amount >= 0),
  installments     int check (installments is null or installments between 1 and 99),
  adapter          text not null check (char_length(adapter) <= 40),
  simulated        boolean not null default false,
  result           jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  raw              text check (raw is null or char_length(raw) <= 8000),
  client_ref       text check (client_ref is null or char_length(client_ref) <= 80),
  payment_id       uuid references payments(id) on delete set null,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now()
);

create index if not exists terminal_transactions_tenant_idx
  on terminal_transactions (tenant_id, created_at desc);
create index if not exists terminal_transactions_terminal_idx
  on terminal_transactions (terminal_id, created_at desc);
create unique index if not exists terminal_transactions_payment_key
  on terminal_transactions (payment_id) where payment_id is not null;

alter table terminal_transactions enable row level security;
drop policy if exists terminal_transactions_select on terminal_transactions;
create policy terminal_transactions_select on terminal_transactions
  for select using (
    internal_scope()
    or (tenant_id = current_tenant_id()
        and store_id = any ((select user_allowed_store_ids())::uuid[]))
  );
-- Sin policies de escritura: sólo la RPC (SECURITY DEFINER).

create or replace function terminal_tx_record(
  p_terminal     uuid,
  p_op           text,
  p_status       text,
  p_amount       numeric,
  p_installments int,
  p_result       jsonb,
  p_raw          text,
  p_client_ref   text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_uid    uuid := auth.uid();
  v_term   payment_terminals;
  v_role   text;
  v_adapter text;
  v_id     uuid;
  v_res    jsonb := case when jsonb_typeof(p_result) = 'object' then p_result else '{}'::jsonb end;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_op not in ('sale', 'void', 'refund', 'close_batch', 'test')
     or p_status not in ('approved', 'declined', 'timeout', 'cancelled', 'error') then
    raise exception 'invalid_terminal_op' using errcode = '22023';
  end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 9999999999) then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if not tenant_has_feature_for(v_tenant, 'terminal_integrada') then
    raise exception 'feature_not_in_plan: terminal_integrada' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
   where tenant_id = v_tenant and user_id = v_uid and status = 'active'
   limit 1;
  if v_role is null or v_role not in ('owner', 'manager', 'cashier') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Pruebas y cierres de lote desde Configuración: dueño o encargado.
  if p_op = 'test' and v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_term from terminal_for_user(v_tenant, v_uid, p_terminal) limit 1;
  if v_term.id is null or v_term.kind not in ('posnet_integrado', 'pinpad') then
    raise exception 'terminal_not_found' using errcode = '23503';
  end if;
  v_adapter := coalesce(nullif(v_term.external_meta -> 'integration' ->> 'adapter', ''), 'simulator');

  insert into terminal_transactions
    (tenant_id, terminal_id, store_id, cash_register_id, op, status, amount, installments,
     adapter, simulated, result, raw, client_ref, created_by)
  values
    (v_tenant, v_term.id, v_term.store_id, v_term.cash_register_id, p_op, p_status,
     round(p_amount, 2), nullif(p_installments, 0), left(v_adapter, 40), v_adapter = 'simulator',
     v_res, left(p_raw, 8000), left(p_client_ref, 80), v_uid)
  returning id into v_id;

  update payment_terminals set last_seen_at = now() where id = v_term.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, v_uid, 'terminal_transactions', v_id, 'terminal_' || p_op || '_' || p_status,
          jsonb_build_object(
            'terminal_id', v_term.id, 'adapter', v_adapter, 'amount', p_amount,
            'installments', p_installments, 'lote', v_res ->> 'lote', 'cupon', v_res ->> 'cupon',
            'authCode', v_res ->> 'authCode', 'responseCode', v_res ->> 'responseCode'));
  return v_id;
end;
$$;
revoke all on function terminal_tx_record(uuid, text, text, numeric, int, jsonb, text, text) from public, anon;
grant execute on function terminal_tx_record(uuid, text, text, numeric, int, jsonb, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Pagos con cupón informado por la terminal
-- -----------------------------------------------------------------------------
create or replace function trg_payments_terminal_tx()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx   terminal_transactions;
  v_txid uuid;
begin
  if new.card_voucher is null
     or not (new.card_voucher ? 'terminal_tx' or coalesce(new.card_voucher ->> 'origen', '') = 'terminal') then
    return new;
  end if;
  if not tenant_has_feature_for(new.tenant_id, 'terminal_integrada') then
    raise exception 'feature_not_in_plan: terminal_integrada' using errcode = '42501';
  end if;
  if new.method not in ('debit', 'credit') then
    raise exception 'terminal_tx_invalid: method' using errcode = '23514';
  end if;
  begin
    v_txid := (new.card_voucher ->> 'terminal_tx')::uuid;
  exception when invalid_text_representation then
    v_txid := null;
  end;
  if v_txid is null then
    raise exception 'terminal_tx_required' using errcode = '23514';
  end if;

  select * into v_tx from terminal_transactions
   where id = v_txid and tenant_id = new.tenant_id
   for update;
  if v_tx.id is null
     or v_tx.op <> 'sale'
     or v_tx.status <> 'approved'
     or v_tx.payment_id is not null
     or v_tx.created_at < now() - interval '24 hours'
     or abs(coalesce(v_tx.amount, -1) - new.amount) > 0.005 then
    raise exception 'terminal_tx_invalid' using errcode = '23514';
  end if;

  -- Lo que guarda el pago sale de la bitácora, no del navegador.
  new.card_voucher := new.card_voucher
    || jsonb_strip_nulls(jsonb_build_object(
         'lote', v_tx.result ->> 'lote',
         'cupon', v_tx.result ->> 'cupon',
         'autorizacion', v_tx.result ->> 'authCode',
         'ultimos4', v_tx.result ->> 'last4',
         'simulado', case when v_tx.simulated then true end));
  return new;
end;
$$;

drop trigger if exists payments_terminal_tx on payments;
create trigger payments_terminal_tx
  before insert on payments
  for each row execute function trg_payments_terminal_tx();

-- El vínculo se escribe después del INSERT (la FK a payments exige que el pago
-- exista). El FOR UPDATE del BEFORE hace esperar a un segundo pago con el
-- mismo terminal_tx, que al releer la fila ya la ve usada.
create or replace function trg_payments_terminal_tx_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update terminal_transactions
     set payment_id = new.id
   where id = (new.card_voucher ->> 'terminal_tx')::uuid
     and tenant_id = new.tenant_id
     and payment_id is null;
  return null;
end;
$$;

drop trigger if exists payments_terminal_tx_link on payments;
create trigger payments_terminal_tx_link
  after insert on payments
  for each row
  when (new.card_voucher ? 'terminal_tx')
  execute function trg_payments_terminal_tx_link();
