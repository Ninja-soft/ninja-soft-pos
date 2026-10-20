-- =============================================================================
-- 20270110100000_h159_caja_pro  (F24 · H159, ADR-172)
--
-- Caja PRO (auditoría de InfoManager IM5):
--
--   A) Arqueo por billete y por medio. cash_shifts.close_count guarda el
--      conteo del cierre (billetes y monedas por denominación, y lo contado
--      de cada medio que no es efectivo: cupones, transferencias, QR). Se
--      guarda con cash_shift_save_count() antes de close_cash_shift (que no
--      cambia). Al crearse el Z, un trigger arma cash_z_closures.count_detail:
--      por medio, esperado, contado y diferencia (el efectivo, con el
--      esperado y lo contado del cierre).
--   B) Apertura con el fondo del cierre anterior. cash_shifts.opening_suggested
--      = lo contado en el último cierre de esa caja; si se abre con otro
--      monto queda en la auditoría (cash_open_difference).
--   C) Borrar un renglón o vaciar el carrito antes de cobrar: queda en la
--      auditoría (log_cart_removal) y, si el negocio lo pide, con PIN de
--      supervisor (acción nueva 'cart_remove', apagada por defecto, umbral en
--      pesos).
--   D) Tope de descuento por usuario: tenant_users.max_discount_pct (null =
--      el del rol). Restringe además del tope del rol; se controla al cerrar
--      la venta (trigger diferido en sales).
--   E) Confirmación del cierre: el encargado o el dueño confirma el Z
--      (cash_z_confirm). Quien lo cerró no se confirma a sí mismo, salvo el
--      dueño. Un Z confirmado no se revisa más.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Arqueo
-- -----------------------------------------------------------------------------
alter table public.cash_shifts add column if not exists close_count jsonb;
alter table public.cash_shifts add column if not exists opening_suggested numeric(14, 2);
alter table public.cash_z_closures add column if not exists count_detail jsonb;
alter table public.cash_z_closures add column if not exists confirmed_at timestamptz;
alter table public.cash_z_closures add column if not exists confirmed_by uuid references auth.users(id);
alter table public.tenant_users add column if not exists max_discount_pct numeric(5, 2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_users_max_discount_pct_check') then
    alter table public.tenant_users add constraint tenant_users_max_discount_pct_check
      check (max_discount_pct is null or (max_discount_pct >= 0 and max_discount_pct <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cash_shifts_close_count_check') then
    alter table public.cash_shifts add constraint cash_shifts_close_count_check
      check (close_count is null or jsonb_typeof(close_count) = 'object');
  end if;
end;
$$;

comment on column public.cash_shifts.close_count is
  'H159: conteo del cierre {bills: {denominación: cantidad}, coins: monto, cash: total, methods: {medio: monto}}.';
comment on column public.cash_z_closures.count_detail is
  'H159: arqueo por medio {bills, methods: {medio: {expected, counted, diff}}}.';

-- Guarda el conteo del turno abierto (lo usa el cierre siguiente). Lo hace
-- quien abrió la caja o un encargado; valida denominaciones y montos.
create or replace function public.cash_shift_save_count(p_shift_id uuid, p_count jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_shift  cash_shifts%rowtype;
  v_bills  jsonb := '{}'::jsonb;
  v_meth   jsonb := '{}'::jsonb;
  v_cash   numeric := 0;
  v_coins  numeric := round(coalesce((p_count ->> 'coins')::numeric, 0), 2);
  v_key    text;
  v_val    jsonb;
  v_n      numeric;
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_count is null or jsonb_typeof(p_count) <> 'object' then raise exception 'invalid_count'; end if;
  select * into v_shift from cash_shifts
   where id = p_shift_id and tenant_id = v_tenant and status = 'open' for update;
  if v_shift.id is null then raise exception 'shift_not_open'; end if;
  if v_shift.opened_by is distinct from auth.uid() and not has_capability_at('cash.close', v_shift.store_id)
     and not is_tenant_manager() then
    raise exception 'shift_not_owned';
  end if;
  if v_coins < 0 or v_coins > 100000000 then raise exception 'invalid_count'; end if;

  for v_key, v_val in select * from jsonb_each(coalesce(p_count -> 'bills', '{}'::jsonb)) loop
    if v_key !~ '^[0-9]{1,6}$' or v_key::int not in (20000, 10000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1) then
      raise exception 'invalid_denomination: %', v_key;
    end if;
    v_n := (v_val #>> '{}')::numeric;
    if v_n is null or v_n < 0 or v_n <> trunc(v_n) or v_n > 1000000 then raise exception 'invalid_count'; end if;
    if v_n > 0 then
      v_bills := v_bills || jsonb_build_object(v_key, v_n);
      v_cash := v_cash + v_key::int * v_n;
    end if;
  end loop;

  for v_key, v_val in select * from jsonb_each(coalesce(p_count -> 'methods', '{}'::jsonb)) loop
    if v_key !~ '^[a-z_]{2,30}$' or v_key in ('cash', 'account', 'store_credit') then
      raise exception 'invalid_method: %', v_key;
    end if;
    v_n := round((v_val #>> '{}')::numeric, 2);
    if v_n is null or v_n < 0 or v_n > 100000000000 then raise exception 'invalid_count'; end if;
    v_meth := v_meth || jsonb_build_object(v_key, v_n);
  end loop;

  v_out := jsonb_build_object(
    'bills', v_bills,
    'coins', v_coins,
    'cash', round(v_cash + v_coins, 2),
    'by_bills', v_bills <> '{}'::jsonb or v_coins > 0,
    'methods', v_meth,
    'counted_at', now(),
    'counted_by', auth.uid());
  update cash_shifts set close_count = v_out where id = v_shift.id;
  return v_out;
end;
$$;
revoke all on function public.cash_shift_save_count(uuid, jsonb) from public, anon;
grant execute on function public.cash_shift_save_count(uuid, jsonb) to authenticated;

-- Esperado por medio del turno: ventas menos anulaciones y cobros de cuenta
-- corriente, sin cuenta corriente ni saldo a favor (no se cuentan).
create or replace function public.cash_shift_expected_by_method(p_tenant uuid, p_shift_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(m, round(t, 2)), '{}'::jsonb)
    from (
      select m, sum(t) as t
        from (
          select payment_method as m,
                 sum(case when type = 'sale' then amount when type = 'sale_void' then -amount else 0 end) as t
            from cash_movements
           where cash_shift_id = p_shift_id and tenant_id = p_tenant
             and payment_method is not null and payment_method not in ('cash', 'account', 'store_credit')
           group by payment_method
          union all
          select a.method, sum(-a.delta)
            from customer_account_movements a
           where a.cash_shift_id = p_shift_id and a.tenant_id = p_tenant
             and a.kind = 'payment' and a.voided_at is null
             and a.method is not null and a.method not in ('cash', 'account', 'store_credit')
           group by a.method
        ) x
       group by m
      having round(sum(t), 2) <> 0
    ) y;
$$;
revoke all on function public.cash_shift_expected_by_method(uuid, uuid) from public, anon, authenticated;

create or replace function public.trg_czc_count_detail()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count jsonb;
  v_exp   jsonb;
  v_meth  jsonb := '{}'::jsonb;
  v_key   text;
  v_e     numeric;
  v_c     numeric;
begin
  select close_count into v_count from cash_shifts where id = new.cash_shift_id;
  v_exp := cash_shift_expected_by_method(new.tenant_id, new.cash_shift_id);
  v_meth := jsonb_build_object('cash', jsonb_build_object(
    'expected', round(coalesce(new.expected_amount, 0), 2),
    'counted', round(coalesce(new.closing_amount, 0), 2),
    'diff', round(coalesce(new.closing_amount, 0) - coalesce(new.expected_amount, 0), 2)));
  for v_key in
    select k from jsonb_object_keys(v_exp) k
    union
    select k from jsonb_object_keys(coalesce(v_count -> 'methods', '{}'::jsonb)) k
  loop
    v_e := coalesce((v_exp ->> v_key)::numeric, 0);
    v_c := (v_count -> 'methods' ->> v_key)::numeric;
    v_meth := v_meth || jsonb_build_object(v_key, jsonb_build_object(
      'expected', v_e,
      'counted', v_c,
      'diff', case when v_c is null then null else round(v_c - v_e, 2) end));
  end loop;
  new.count_detail := jsonb_build_object(
    'bills', coalesce(v_count -> 'bills', '{}'::jsonb),
    'coins', coalesce((v_count ->> 'coins')::numeric, 0),
    'by_bills', coalesce((v_count ->> 'by_bills')::boolean, false),
    'methods', v_meth);
  return new;
end;
$$;
revoke all on function public.trg_czc_count_detail() from public, anon, authenticated;

drop trigger if exists czc_count_detail on public.cash_z_closures;
create trigger czc_count_detail
  before insert on public.cash_z_closures
  for each row execute function public.trg_czc_count_detail();

-- -----------------------------------------------------------------------------
-- B) Apertura con el fondo del cierre anterior
-- -----------------------------------------------------------------------------
create or replace function public.trg_cash_shift_opening_suggested()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select s.closing_amount into new.opening_suggested
    from cash_shifts s
   where s.tenant_id = new.tenant_id and s.cash_register_id = new.cash_register_id
     and s.status = 'closed' and s.closing_amount is not null
   order by s.closed_at desc nulls last
   limit 1;
  return new;
end;
$$;
revoke all on function public.trg_cash_shift_opening_suggested() from public, anon, authenticated;

drop trigger if exists cash_shift_opening_suggested on public.cash_shifts;
create trigger cash_shift_opening_suggested
  before insert on public.cash_shifts
  for each row execute function public.trg_cash_shift_opening_suggested();

create or replace function public.trg_cash_shift_opening_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.opening_suggested is not null
     and abs(coalesce(new.opening_amount, 0) - new.opening_suggested) > 0.009 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, auth.uid(), 'cash_shifts', new.id, 'cash_open_difference',
            jsonb_build_object('opening_amount', new.opening_amount,
                               'opening_suggested', new.opening_suggested,
                               'difference', round(coalesce(new.opening_amount, 0) - new.opening_suggested, 2),
                               'cash_register_id', new.cash_register_id,
                               'store_id', new.store_id));
  end if;
  return null;
end;
$$;
revoke all on function public.trg_cash_shift_opening_audit() from public, anon, authenticated;

drop trigger if exists cash_shift_opening_audit on public.cash_shifts;
create trigger cash_shift_opening_audit
  after insert on public.cash_shifts
  for each row execute function public.trg_cash_shift_opening_audit();

-- -----------------------------------------------------------------------------
-- C) Borrar del carrito: acción de PIN nueva y registro
-- -----------------------------------------------------------------------------
create or replace function security_default_policy()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'discount_over',     jsonb_build_object('enabled', false, 'threshold', 20),
    'cambio_precio',     jsonb_build_object('enabled', true,  'threshold', 0),
    'sale_void',         jsonb_build_object('enabled', false, 'threshold', 0),
    'sale_return',       jsonb_build_object('enabled', false, 'threshold', 0),
    'cash_out',          jsonb_build_object('enabled', false, 'threshold', 0),
    'cash_in',           jsonb_build_object('enabled', false, 'threshold', 0),
    'shift_force_close', jsonb_build_object('enabled', true,  'threshold', 0),
    'abrir_cajon',       jsonb_build_object('enabled', true,  'threshold', 0),
    'reintegro_mp',      jsonb_build_object('enabled', true,  'threshold', 0),
    'cart_remove',       jsonb_build_object('enabled', false, 'threshold', 0));
$$;

-- Lo que se sacó del carrito antes de cobrar. Con la acción 'cart_remove'
-- encendida y el monto en el umbral, pide el token de supervisor.
create or replace function public.log_cart_removal(
  p_kind text,
  p_items jsonb,
  p_amount numeric,
  p_register_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_sup    uuid;
  v_id     uuid;
  v_amount numeric := round(greatest(coalesce(p_amount, 0), 0), 2);
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if p_kind not in ('line', 'clear') then raise exception 'invalid_kind'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'invalid_items';
  end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid() and status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_amount > 0 and pin_action_required(v_tenant, 'cart_remove', v_amount) then
    v_sup := require_supervisor('cart_remove', v_amount, null);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'pos_cart', p_register_id,
          case p_kind when 'line' then 'pos_cart_line_removed' else 'pos_cart_cleared' end,
          jsonb_build_object('amount', v_amount,
                             'items', (select coalesce(jsonb_agg(jsonb_build_object(
                                         'name', left(coalesce(i ->> 'name', ''), 120),
                                         'quantity', (i ->> 'quantity')::numeric,
                                         'amount', (i ->> 'amount')::numeric)), '[]'::jsonb)
                                         from (select i from jsonb_array_elements(p_items) i limit 200) x),
                             'cash_register_id', p_register_id,
                             'supervisor', v_sup))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.log_cart_removal(text, jsonb, numeric, uuid) from public, anon;
grant execute on function public.log_cart_removal(text, jsonb, numeric, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Tope de descuento por usuario
-- -----------------------------------------------------------------------------
create or replace function public.trg_sale_user_discount_cap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cap numeric;
begin
  if coalesce(new.discount_total, 0) <= 0 or coalesce(new.subtotal, 0) <= 0 or new.created_by is null then
    return null;
  end if;
  select max_discount_pct into v_cap from tenant_users
   where tenant_id = new.tenant_id and user_id = new.created_by;
  if v_cap is not null and new.discount_total / new.subtotal * 100 > v_cap + 0.01 then
    raise exception 'discount_exceeds_user_limit'
      using detail = 'Tope ' || v_cap::text || ' %', errcode = 'P0001';
  end if;
  return null;
end;
$$;
revoke all on function public.trg_sale_user_discount_cap() from public, anon, authenticated;

drop trigger if exists sale_user_discount_cap on public.sales;
create constraint trigger sale_user_discount_cap
  after insert on public.sales
  deferrable initially deferred
  for each row when (coalesce(new.discount_total, 0) > 0)
  execute function public.trg_sale_user_discount_cap();

-- El dueño fija el tope de cada persona (null = el de su rol).
create or replace function public.team_set_discount_cap(p_user_id uuid, p_pct numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before numeric;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_pct is not null and (p_pct < 0 or p_pct > 100) then raise exception 'invalid_pct'; end if;
  select max_discount_pct into v_before from tenant_users where tenant_id = v_tenant and user_id = p_user_id;
  if not found then raise exception 'member_not_found'; end if;
  update tenant_users set max_discount_pct = round(p_pct, 2)
   where tenant_id = v_tenant and user_id = p_user_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'tenant_users', p_user_id, 'team_discount_cap_set',
          jsonb_build_object('max_discount_pct', v_before), jsonb_build_object('max_discount_pct', round(p_pct, 2)));
end;
$$;
revoke all on function public.team_set_discount_cap(uuid, numeric) from public, anon;
grant execute on function public.team_set_discount_cap(uuid, numeric) to authenticated;

-- Tope propio del usuario del JWT (para el POS).
create or replace function public.my_discount_cap()
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select max_discount_pct from tenant_users
   where tenant_id = current_tenant_id() and user_id = auth.uid() and status = 'active'
   limit 1;
$$;
revoke all on function public.my_discount_cap() from public, anon;
grant execute on function public.my_discount_cap() to authenticated;

-- -----------------------------------------------------------------------------
-- E) Confirmación del cierre por el encargado
-- -----------------------------------------------------------------------------
create or replace function public.cash_z_confirm(p_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_z      cash_z_closures%rowtype;
  v_role   text;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  select * into v_z from cash_z_closures where id = p_id and tenant_id = v_tenant for update;
  if v_z.id is null then raise exception 'z_not_found'; end if;
  if v_z.confirmed_at is not null then raise exception 'z_already_confirmed'; end if;
  v_role := member_role_in(v_tenant);
  if not (v_role = 'owner' or (is_tenant_manager() and has_capability_at('cash.close', v_z.store_id))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_z.closed_by = auth.uid() and v_role <> 'owner' then
    raise exception 'z_self_confirm';
  end if;
  update cash_z_closures set confirmed_at = now(), confirmed_by = auth.uid() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'cash_z_closures', p_id, 'cash_z_confirmed',
          jsonb_build_object('z_number', v_z.z_number, 'difference', v_z.difference,
                             'note', nullif(left(btrim(coalesce(p_note, '')), 300), '')));
end;
$$;
revoke all on function public.cash_z_confirm(uuid, text) from public, anon;
grant execute on function public.cash_z_confirm(uuid, text) to authenticated;
