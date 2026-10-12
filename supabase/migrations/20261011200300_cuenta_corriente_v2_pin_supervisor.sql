-- =============================================================================
-- 20261011200300_cuenta_corriente_v2_pin_supervisor  (H31 · Cuenta corriente v2)
--
-- Spec: docs/specs/cuenta-corriente-v2.md · ADR-037 (addendum "PIN de supervisor").
-- Parte 4. Requiere 20261011200000..200200.
--
-- Qué hace:
--  A) PIN de supervisor: dueños y encargados cargan un PIN de 4 a 6 dígitos.
--     Se guarda SÓLO el hash (pgcrypto, bcrypt) en account_supervisor_pins, con
--     RLS sin policies (ningún cliente lee ni escribe; todo vía RPC security
--     definer).
--  B) Autorización desde la sesión del cajero: account_authorize_override()
--     verifica el PIN del supervisor elegido, limita intentos fallidos (5 cada
--     15 minutos por negocio y supervisor; al quinto, bloqueo de 15 minutos),
--     audita (supervisor, cajero, motivo, cliente, monto) y entrega un token de
--     un solo uso que vence a los 5 minutos, atado al cliente, al cajero que lo
--     pidió y al monto del intento de venta.
--  C) payment_account_charge (redefine la de 20261011200100): consume el token
--     (override_token en payments.reference) para destrabar bloqueo por mora,
--     cuenta bloqueada o límite de crédito superado. Se mantiene el camino de
--     sesión de dueño/encargado (override_reason). Ambos auditados.
--  D) Condiciones de cuenta por GRUPO de clientes: account_set_group_config()
--     (dueño/encargado, gating cuenta_corriente, validado) + guard/auditoría
--     en customer_groups para que un UPDATE directo tampoco pase sin rastro.
--
-- Gating: todo bajo la feature `cuenta_corriente` (server-side). Sin feature
-- nueva.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- A) Tablas (RLS deny-all para clientes)
-- -----------------------------------------------------------------------------
create table if not exists account_supervisor_pins (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  user_id           uuid not null references public.users(id) on delete cascade,
  pin_hash          text not null,
  fail_count        int not null default 0,
  fail_window_start timestamptz,
  locked_until      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, user_id)
);
alter table account_supervisor_pins enable row level security;
revoke all on account_supervisor_pins from anon, authenticated;

create table if not exists account_override_tokens (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  supervisor_id    uuid not null references public.users(id),
  requested_by     uuid references public.users(id),
  amount           numeric(12,2) not null check (amount > 0),
  reason           text not null,
  block            text not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  consumed_at      timestamptz,
  consumed_sale_id uuid
);
create index if not exists aot_tenant_customer_idx on account_override_tokens (tenant_id, customer_id);
alter table account_override_tokens enable row level security;
revoke all on account_override_tokens from anon, authenticated;

-- PIN débil: todos iguales (0000) o escalera (1234, 9876).
create or replace function account_pin_is_weak(p_pin text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  i int;
  up boolean := true;
  dn boolean := true;
  same boolean := true;
  a int;
  b int;
begin
  for i in 2..length(p_pin) loop
    a := substr(p_pin, i - 1, 1)::int;
    b := substr(p_pin, i, 1)::int;
    if b <> a then same := false; end if;
    if b <> (a + 1) % 10 then up := false; end if;
    if b <> (a + 9) % 10 then dn := false; end if;
  end loop;
  return same or up or dn;
end;
$$;

-- Bloqueo que hoy pide autorización para una venta a cuenta de p_amount
-- (null = no hace falta). Misma regla que payment_account_charge.
create or replace function account_override_needed(p_tenant uuid, p_customer uuid, p_amount numeric)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cust customers%rowtype;
  v_cfg  jsonb;
begin
  select * into v_cust from customers where id = p_customer and tenant_id = p_tenant;
  if not found then
    raise exception 'customer_not_found';
  end if;
  v_cfg := account_effective_config(v_cust.id);
  if v_cust.credit_status = 'blocked' then
    return 'account_blocked';
  end if;
  if (v_cfg -> 'blocking' ->> 'overdue_days') is not null
     and account_max_days_overdue(p_tenant, v_cust.id, account_today()) > (v_cfg -> 'blocking' ->> 'overdue_days')::int then
    return 'account_overdue_blocked';
  end if;
  if coalesce(v_cust.credit_limit, 0) > 0
     and account_balance(v_cust.id) + coalesce(p_amount, 0) > v_cust.credit_limit + 0.001 then
    return 'credit_limit_exceeded';
  end if;
  return null;
end;
$$;
revoke all on function account_override_needed(uuid, uuid, numeric) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- A) PIN propio (dueño / encargado)
-- -----------------------------------------------------------------------------
create or replace function account_supervisor_pin_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := account_assert('cuenta_corriente');
  v_row    account_supervisor_pins%rowtype;
begin
  select * into v_row from account_supervisor_pins where tenant_id = v_tenant and user_id = auth.uid();
  return jsonb_build_object(
    'can_have_pin', is_tenant_manager(),
    'has_pin', found,
    'updated_at', v_row.updated_at,
    'locked_until', case when v_row.locked_until > now() then v_row.locked_until end);
end;
$$;
revoke all on function account_supervisor_pin_status() from public, anon;
grant execute on function account_supervisor_pin_status() to authenticated;

create or replace function account_set_supervisor_pin(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := account_assert('cuenta_corriente');
  v_had    boolean;
begin
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'invalid_pin';
  end if;
  if account_pin_is_weak(p_pin) then
    raise exception 'weak_pin';
  end if;
  v_had := exists (select 1 from account_supervisor_pins where tenant_id = v_tenant and user_id = auth.uid());
  insert into account_supervisor_pins (tenant_id, user_id, pin_hash)
  values (v_tenant, auth.uid(), crypt(p_pin, gen_salt('bf', 8)))
  on conflict (tenant_id, user_id) do update
    set pin_hash = excluded.pin_hash, fail_count = 0, fail_window_start = null,
        locked_until = null, updated_at = now();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'users', auth.uid(),
          case when v_had then 'supervisor_pin_changed' else 'supervisor_pin_set' end,
          jsonb_build_object('supervisor_id', auth.uid()));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function account_set_supervisor_pin(text) from public, anon;
grant execute on function account_set_supervisor_pin(text) to authenticated;

-- Borra el PIN propio; el dueño puede borrar el de cualquier supervisor (por
-- ejemplo, un encargado que dejó el negocio).
create or replace function account_clear_supervisor_pin(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := account_assert('cuenta_corriente');
  v_target uuid := coalesce(p_user_id, auth.uid());
begin
  if v_target = auth.uid() then
    if not is_tenant_manager() then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  elsif not is_tenant_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from account_supervisor_pins where tenant_id = v_tenant and user_id = v_target;
  if found then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'users', v_target, 'supervisor_pin_cleared',
            jsonb_build_object('supervisor_id', v_target));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function account_clear_supervisor_pin(uuid) from public, anon;
grant execute on function account_clear_supervisor_pin(uuid) to authenticated;

-- Supervisores con PIN cargado (para que el cajero elija quién autoriza).
create or replace function account_supervisors()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := account_assert('cuenta_corriente');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', tu.user_id,
             'name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email, 'Sin nombre'),
             'role', tu.role,
             'locked', coalesce(p.locked_until > now(), false))
             order by tu.role desc, coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email))
      from account_supervisor_pins p
      join tenant_users tu on tu.tenant_id = p.tenant_id and tu.user_id = p.user_id
      join public.users u on u.id = p.user_id
     where p.tenant_id = v_tenant
       and tu.status = 'active'
       and tu.role in ('owner', 'manager')), '[]'::jsonb);
end;
$$;
revoke all on function account_supervisors() from public, anon;
grant execute on function account_supervisors() to authenticated;

-- -----------------------------------------------------------------------------
-- B) Autorización con PIN desde la sesión del cajero
--    Los resultados del PIN (inválido, bloqueado) se DEVUELVEN, no se lanzan:
--    un raise desharía el conteo de intentos fallidos.
-- -----------------------------------------------------------------------------
create or replace function account_authorize_override(
  p_customer_id   uuid,
  p_supervisor_id uuid,
  p_pin           text,
  p_amount        numeric,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant  uuid := account_assert('cuenta_corriente');
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_block   text;
  v_cfg     jsonb;
  v_pin     account_supervisor_pins%rowtype;
  v_token   uuid;
  v_expires timestamptz := now() + interval '5 minutes';
  v_left    int;
  c_max     constant int := 5;
  c_window  constant interval := interval '15 minutes';
begin
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'invalid_amount';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'override_reason_required';
  end if;
  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = p_supervisor_id
       and status = 'active' and role in ('owner', 'manager')
  ) then
    raise exception 'supervisor_not_found';
  end if;

  v_block := account_override_needed(v_tenant, p_customer_id, p_amount);
  if v_block is null then
    return jsonb_build_object('ok', false, 'error', 'override_not_needed');
  end if;
  v_cfg := account_effective_config(p_customer_id);
  if not coalesce((v_cfg -> 'blocking' ->> 'allow_manager_override')::boolean, true) then
    return jsonb_build_object('ok', false, 'error', 'override_not_allowed');
  end if;

  select * into v_pin from account_supervisor_pins
   where tenant_id = v_tenant and user_id = p_supervisor_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pin_not_set');
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'pin_locked', 'locked_until', v_pin.locked_until);
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' or crypt(p_pin, v_pin.pin_hash) <> v_pin.pin_hash then
    if v_pin.fail_window_start is null or v_pin.fail_window_start < now() - c_window then
      v_pin.fail_window_start := now();
      v_pin.fail_count := 1;
    else
      v_pin.fail_count := v_pin.fail_count + 1;
    end if;
    v_left := greatest(c_max - v_pin.fail_count, 0);

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'customers', p_customer_id, 'supervisor_pin_failed',
            jsonb_build_object('supervisor_id', p_supervisor_id, 'cashier_id', auth.uid(),
                               'amount', p_amount, 'attempt', v_pin.fail_count));

    if v_left = 0 then
      update account_supervisor_pins
         set fail_count = 0, fail_window_start = null, locked_until = now() + c_window, updated_at = now()
       where id = v_pin.id
      returning locked_until into v_pin.locked_until;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, auth.uid(), 'users', p_supervisor_id, 'supervisor_pin_locked',
              jsonb_build_object('supervisor_id', p_supervisor_id, 'cashier_id', auth.uid(),
                                 'locked_until', v_pin.locked_until));
      return jsonb_build_object('ok', false, 'error', 'pin_locked', 'locked_until', v_pin.locked_until);
    end if;

    update account_supervisor_pins
       set fail_count = v_pin.fail_count, fail_window_start = v_pin.fail_window_start
     where id = v_pin.id;
    return jsonb_build_object('ok', false, 'error', 'pin_invalid', 'attempts_left', v_left);
  end if;

  -- PIN correcto.
  update account_supervisor_pins
     set fail_count = 0, fail_window_start = null, locked_until = null
   where id = v_pin.id;

  insert into account_override_tokens
    (tenant_id, customer_id, supervisor_id, requested_by, amount, reason, block, expires_at)
  values
    (v_tenant, p_customer_id, p_supervisor_id, auth.uid(), round(p_amount, 2), v_reason, v_block, v_expires)
  returning id into v_token;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'customers', p_customer_id, 'account_override_authorized', v_reason,
          jsonb_build_object('supervisor_id', p_supervisor_id, 'cashier_id', auth.uid(),
                             'customer_id', p_customer_id, 'amount', round(p_amount, 2),
                             'block', v_block, 'token_id', v_token, 'expires_at', v_expires));

  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires, 'block', v_block);
end;
$$;
revoke all on function account_authorize_override(uuid, uuid, text, numeric, text) from public, anon;
grant execute on function account_authorize_override(uuid, uuid, text, numeric, text) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Cargo por venta a cuenta (REEMPLAZO de la de 20261011200100)
--    Cambios: override por token de PIN (un solo uso, mismo cliente, mismo
--    cajero, monto <= autorizado, sin vencer) y override también del límite de
--    crédito (pedido del dueño), siempre que blocking.allow_manager_override.
-- -----------------------------------------------------------------------------
create or replace function payment_account_charge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale     record;
  v_cust     customers%rowtype;
  v_cfg      jsonb;
  v_ref      jsonb;
  v_n        int := 1;
  v_override text;
  v_token    text;
  v_tok_id   uuid;
  v_tok      account_override_tokens%rowtype;
  v_balance  numeric;
  v_days     int;
  v_block    text;
  v_over_lim boolean;
  v_need     text;
  v_allowed  boolean;
  v_first    date;
  v_due      date;
  v_cents    bigint;
  v_base     bigint;
  v_amt      numeric;
  v_dues     jsonb := '[]'::jsonb;
  i          int;
begin
  if new.method <> 'account' then
    return new;
  end if;

  select s.id, s.customer_id, s.tenant_id, s.number into v_sale from sales s where s.id = new.sale_id;
  if v_sale.customer_id is null then
    raise exception 'account_needs_customer';
  end if;
  if not tenant_has_feature_for(v_sale.tenant_id, 'cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;
  if coalesce(new.amount, 0) <= 0 then
    raise exception 'invalid_amount';
  end if;

  -- Fin de la carrera: lock del cliente durante toda la transacción de la venta.
  select * into v_cust from customers
   where id = v_sale.customer_id and tenant_id = v_sale.tenant_id
   for update;
  if not found then
    raise exception 'customer_not_found';
  end if;

  v_cfg := account_effective_config(v_cust.id);

  begin
    if new.reference is not null and left(btrim(new.reference), 1) = '{' then
      v_ref := new.reference::jsonb;
    end if;
  exception when others then
    v_ref := null;
  end;
  v_n := greatest(1, coalesce((v_ref ->> 'installments')::int, 1));
  v_override := nullif(btrim(coalesce(v_ref ->> 'override_reason', '')), '');
  v_token := nullif(btrim(coalesce(v_ref ->> 'override_token', '')), '');

  v_balance := account_balance(v_cust.id);
  v_over_lim := coalesce(v_cust.credit_limit, 0) > 0
                and v_balance + new.amount > v_cust.credit_limit + 0.001;

  -- Bloqueo por estado manual o por mora.
  if v_cust.credit_status = 'blocked' then
    v_block := 'account_blocked';
  elsif (v_cfg -> 'blocking' ->> 'overdue_days') is not null then
    v_days := account_max_days_overdue(v_sale.tenant_id, v_cust.id, account_today());
    if v_days > (v_cfg -> 'blocking' ->> 'overdue_days')::int then
      v_block := 'account_overdue_blocked';
    end if;
  end if;

  if v_block is not null or v_over_lim then
    v_need := coalesce(v_block, 'credit_limit_exceeded');
    v_allowed := coalesce((v_cfg -> 'blocking' ->> 'allow_manager_override')::boolean, true);

    if v_allowed and v_token is not null then
      begin
        v_tok_id := v_token::uuid;
      exception when others then
        raise exception 'override_token_invalid';
      end;
      update account_override_tokens t
         set consumed_at = now(), consumed_sale_id = v_sale.id
       where t.id = v_tok_id
         and t.tenant_id = v_sale.tenant_id
         and t.customer_id = v_cust.id
         and t.consumed_at is null
         and t.expires_at > now()
         and t.requested_by is not distinct from auth.uid()
         and new.amount <= t.amount + 0.001
      returning t.* into v_tok;
      if not found then
        raise exception 'override_token_invalid';
      end if;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
      values (v_sale.tenant_id, auth.uid(), 'customers', v_cust.id, 'account_block_override', v_tok.reason,
              jsonb_build_object('via', 'pin', 'block', v_block, 'credit_limit_exceeded', v_over_lim,
                                 'sale_id', v_sale.id, 'amount', new.amount, 'authorized_amount', v_tok.amount,
                                 'supervisor_id', v_tok.supervisor_id, 'cashier_id', auth.uid(),
                                 'token_id', v_tok.id, 'days_overdue', v_days, 'balance', v_balance));
    elsif v_allowed and v_override is not null and is_tenant_manager() then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
      values (v_sale.tenant_id, auth.uid(), 'customers', v_cust.id, 'account_block_override', v_override,
              jsonb_build_object('via', 'session', 'block', v_block, 'credit_limit_exceeded', v_over_lim,
                                 'sale_id', v_sale.id, 'amount', new.amount, 'supervisor_id', auth.uid(),
                                 'days_overdue', v_days, 'balance', v_balance));
    else
      raise exception '%', v_need;
    end if;
  end if;

  -- Cuotas.
  if v_n > 1 then
    if not coalesce((v_cfg -> 'installments' ->> 'enabled')::boolean, false)
       or v_n > coalesce((v_cfg -> 'installments' ->> 'max')::int, 1) then
      raise exception 'installments_not_allowed';
    end if;
  end if;

  v_first := account_due_date(account_today(), v_cfg -> 'terms');
  v_cents := round(new.amount * 100)::bigint;
  v_base  := v_cents / v_n;
  for i in 1..v_n loop
    v_amt := (case when i = v_n then v_cents - v_base * (v_n - 1) else v_base end)::numeric / 100;
    if coalesce(v_cfg -> 'terms' ->> 'mode', 'days') = 'monthly_cutoff' then
      v_due := account_add_months(v_first, i - 1);
    else
      v_due := v_first + (i - 1) * greatest(1, coalesce((v_cfg -> 'installments' ->> 'interval_days')::int, 30));
    end if;
    insert into customer_account_movements
      (tenant_id, customer_id, kind, delta, reason, sale_id, due_date, installment_no, installments, created_by)
    values
      (v_sale.tenant_id, v_cust.id, 'charge', v_amt,
       'Venta #' || v_sale.number || case when v_n > 1 then ' · cuota ' || i || '/' || v_n else '' end,
       v_sale.id, v_due,
       case when v_n > 1 then i else null end,
       case when v_n > 1 then v_n else null end,
       auth.uid());
    v_dues := v_dues || jsonb_build_object('installment_no', i, 'amount', v_amt, 'due_date', v_due);
  end loop;

  -- Anticipos (saldo a favor) se aplican a los cargos nuevos.
  perform account_reconcile(v_cust.id);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_sale.tenant_id, auth.uid(), 'customers', v_cust.id, 'account_charge',
          jsonb_build_object('sale_id', v_sale.id, 'sale_number', v_sale.number,
                             'amount', new.amount, 'installments', v_n, 'schedule', v_dues));
  return new;
end;
$$;
revoke all on function payment_account_charge() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Condiciones por grupo de clientes
-- -----------------------------------------------------------------------------
create or replace function trg_customer_groups_account_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.account_config is not distinct from old.account_config then
    return new;
  end if;
  if tg_op = 'INSERT' and new.account_config is null then
    return new;
  end if;
  if auth.uid() is not null and not is_tenant_manager() then
    raise exception 'forbidden_account_fields' using errcode = '42501';
  end if;
  if new.account_config is not null and not tenant_has_feature_for(new.tenant_id, 'cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (new.tenant_id, auth.uid(), 'customer_groups', new.id, 'account_group_terms_changed',
          case when tg_op = 'UPDATE' then jsonb_build_object('account_config', old.account_config) end,
          jsonb_build_object('account_config', new.account_config));
  return new;
end;
$$;
revoke all on function trg_customer_groups_account_guard() from public, anon, authenticated;

drop trigger if exists customer_groups_account_guard on customer_groups;
create trigger customer_groups_account_guard
  before insert or update on customer_groups
  for each row execute function trg_customer_groups_account_guard();

-- Override PARCIAL del grupo (null o {} = hereda del negocio). Auditoría: guard.
create or replace function account_set_group_config(p_group_id uuid, p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := account_assert('cuenta_corriente');
  v_cfg    jsonb := case when p_config = '{}'::jsonb then null else p_config end;
begin
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_cfg is not null and not account_config_valid(v_cfg) then
    raise exception 'invalid_account_config';
  end if;
  update customer_groups set account_config = v_cfg
   where id = p_group_id and tenant_id = v_tenant;
  if not found then
    raise exception 'group_not_found';
  end if;
  return jsonb_build_object('ok', true, 'config', v_cfg);
end;
$$;
revoke all on function account_set_group_config(uuid, jsonb) from public, anon;
grant execute on function account_set_group_config(uuid, jsonb) to authenticated;
