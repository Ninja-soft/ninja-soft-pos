-- =============================================================================
-- 20261030100100_reintegro_mp  (F8 · H21h · ADR-067)
--
-- Reintegro por Mercado Pago al hacer una devolución.
--
-- Flujo (dos tiempos, sin perder plata ni la devolución):
--   1) return_sale_v2 (copia de 20261013120000 + p_mp_payment_id y
--      p_mp_amount) registra la devolución en una sola transacción: stock,
--      ítems, la parte que va por Mercado Pago (hasta lo cobrado por ese pago
--      menos lo ya reintegrado) y el resto como hasta hoy (efectivo, vale o
--      cuenta corriente). La pata MP crea una fila `mp_refunds` en 'pending'.
--      Pide PIN de supervisor 'reintegro_mp' (siempre, salvo que quien opera
--      sea supervisor por rol) y motivo de devolución.
--   2) La Edge `mp_refund` (verify_jwt = true) toma la fila (_mp_refund_claim),
--      llama a POST /v1/payments/{id}/refunds con el monto y
--      X-Idempotency-Key = id de la fila, con la credencial y el ambiente con
--      los que se creó el cobro (secret_store_id y mp_env del intent), y
--      cierra la fila (_mp_refund_finish).
--   3) Si Mercado Pago lo rechaza (saldo insuficiente, plazo vencido, pago en
--      disputa, ya reintegrado), mp_refund_fallback lo pasa a efectivo (turno
--      propio) o a vale, con auditoría.
--
--   A) Ajuste del dueño: tenant_payment_methods(mercadopago).config
--      .mp_refunds_enabled (apagado por defecto). Sólo por
--      mp_refund_settings_save (dueño); un trigger impide tocarlo desde el
--      cliente.
--   B) Acción de PIN 'reintegro_mp' (copias de security_default_policy y
--      pin_action_required de 20261026100100).
--   C) sale_returns: refund_method 'mercadopago' y mp_refund_amount.
--   D) mp_refunds: RLS `tenant_id = current_tenant_id() or internal_scope()`
--      (ADR-052) y alcance de sucursal de la venta. Sin policies de escritura.
--   E) mp_refund_options(venta): pagos de MP reintegrables para el wizard.
--   F) return_sale_v2 (copia) con la pata Mercado Pago.
--   G) _mp_refund_claim / _mp_refund_finish (service_role, para la Edge). Al
--      aprobarse se registra la devolución en payment_disputes con origen
--      'pos' (ADR-064): la sincronización no la avisa como devolución hecha
--      desde Mercado Pago y la conciliación la muestra "Devuelto (POS)".
--   H) mp_refund_fallback: efectivo o vale si MP no pudo.
--
-- Aditiva. NO aplicada todavía. No toca create_sale, close_cash_shift,
-- _pc_complete ni el resolver de precios.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Ajuste del dueño
-- -----------------------------------------------------------------------------
create or replace function mp_refund_settings_save(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before jsonb;
  v_on     boolean := coalesce(p_enabled, false);
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if not exists (select 1 from tenant_users tu
                  where tu.tenant_id = v_tenant and tu.user_id = auth.uid()
                    and tu.status = 'active' and tu.role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_on and not tenant_has_feature_for(v_tenant, 'reintegro_mp') then
    raise exception 'feature_not_in_plan: reintegro_mp' using errcode = '42501';
  end if;

  select config into v_before from tenant_payment_methods
   where tenant_id = v_tenant and provider_key = 'mercadopago';

  insert into tenant_payment_methods (tenant_id, provider_key, enabled, sandbox, surcharge_pct, config)
  values (v_tenant, 'mercadopago', false, true, 0, jsonb_build_object('mp_refunds_enabled', v_on))
  on conflict (tenant_id, provider_key) do update
    set config = coalesce(tenant_payment_methods.config, '{}'::jsonb)
                 || jsonb_build_object('mp_refunds_enabled', v_on);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'tenant_payment_methods', null, 'mp_refund_settings_saved',
          jsonb_build_object('mp_refunds_enabled', coalesce((v_before ->> 'mp_refunds_enabled')::boolean, false)),
          jsonb_build_object('mp_refunds_enabled', v_on));
  return jsonb_build_object('mp_refunds_enabled', v_on);
end;
$$;
revoke all on function mp_refund_settings_save(boolean) from public, anon;
grant execute on function mp_refund_settings_save(boolean) to authenticated;

-- Desde el cliente (tpm_write deja escribir config a dueño y encargado) no se
-- puede prender ni apagar: sólo el dueño, por la RPC (que audita). SECURITY
-- INVOKER a propósito: current_user es 'authenticated' en un acceso directo y
-- el dueño de la función dentro de la RPC.
create or replace function tpm_mp_refunds_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old jsonb := case when tg_op = 'UPDATE' then old.config -> 'mp_refunds_enabled' else null end;
begin
  if current_user in ('authenticated', 'anon')
     and (new.config -> 'mp_refunds_enabled') is distinct from v_old
     and not (tg_op = 'INSERT' and new.config -> 'mp_refunds_enabled' is null) then
    raise exception 'mp_refunds_setting_owner_only' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists tpm_mp_refunds_guard on tenant_payment_methods;
create trigger tpm_mp_refunds_guard
  before insert or update on tenant_payment_methods
  for each row execute function tpm_mp_refunds_guard();

-- -----------------------------------------------------------------------------
-- B) PIN de supervisor: 'reintegro_mp'
-- -----------------------------------------------------------------------------
-- Copia de 20261026100100 con 'reintegro_mp'. Como el cierre forzado y el
-- cajón: se pide SIEMPRE que se consulta (la plata sale de la cuenta de MP);
-- quien es supervisor por rol pasa sin PIN (require_supervisor).
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
    'reintegro_mp',      jsonb_build_object('enabled', true,  'threshold', 0));
$$;

-- Copia de 20261026100100 con 'reintegro_mp' (siempre).
create or replace function pin_action_required(p_tenant uuid, p_action text, p_amount numeric)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v   security_settings%rowtype;
  v_a jsonb;
  v_t numeric;
begin
  if p_action in ('shift_force_close', 'abrir_cajon', 'reintegro_mp') then return true; end if;
  v := security_effective(p_tenant);
  v_a := v.pin_policy -> p_action;
  if v_a is null or not coalesce((v_a ->> 'enabled')::boolean, false) then return false; end if;
  v_t := coalesce((v_a ->> 'threshold')::numeric, 0);
  if p_action in ('discount_over', 'cambio_precio') then
    return coalesce(p_amount, 0) > v_t + 0.001;
  end if;
  return coalesce(p_amount, 0) >= v_t;
end;
$$;
revoke all on function pin_action_required(uuid, text, numeric) from public, anon;
grant execute on function pin_action_required(uuid, text, numeric) to authenticated;

-- -----------------------------------------------------------------------------
-- C) sale_returns
-- -----------------------------------------------------------------------------
alter table sale_returns drop constraint if exists sale_returns_refund_method_check;
alter table sale_returns add constraint sale_returns_refund_method_check
  check (refund_method in ('cash', 'store_credit', 'account', 'mercadopago'));
alter table sale_returns add column if not exists mp_refund_amount numeric(12,2) not null default 0;

-- -----------------------------------------------------------------------------
-- D) mp_refunds
-- -----------------------------------------------------------------------------
create table if not exists mp_refunds (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  sale_id             uuid not null references sales(id) on delete cascade,
  sale_return_id      uuid not null references sale_returns(id) on delete cascade,
  payment_id          uuid not null references payments(id) on delete cascade,
  intent_id           uuid not null references mp_payment_intents(id) on delete cascade,
  store_id            uuid references stores(id) on delete set null,
  provider_key        text not null,
  -- Pago en Mercado Pago (lo resuelve la Edge: mp_payment_id o el de la orden).
  provider_payment_id text,
  mp_refund_id        text,
  amount              numeric(12,2) not null check (amount > 0),
  -- pending: registrado, falta llamar a MP · processing: la Edge lo tomó ·
  -- approved: MP lo hizo · in_process: MP lo aceptó y lo procesa ·
  -- failed: MP lo rechazó (se puede pasar a efectivo o vale) ·
  -- error: no se sabe si MP lo hizo (reintentar con la misma clave) ·
  -- fallback: se reintegró en efectivo o vale.
  status              text not null default 'pending'
                        check (status in ('pending', 'processing', 'approved', 'in_process', 'failed', 'error', 'fallback')),
  mp_status           text,
  error_code          text,
  error_detail        text,
  mp_env              text,
  secret_store_id     uuid references stores(id) on delete set null,
  attempts            int not null default 0,
  -- Clave de idempotencia = id:idem_seq. Se reusa en un reintento tras un
  -- error dudoso (MP no duplica) y cambia tras un rechazo firme (MP
  -- devolvería el mismo rechazo con la misma clave).
  idem_seq            int not null default 0,
  requested_by        uuid references public.users(id) on delete set null,
  authorized_by       uuid references public.users(id) on delete set null,
  fallback_method     text check (fallback_method is null or fallback_method in ('cash', 'store_credit')),
  fallback_by         uuid references public.users(id) on delete set null,
  fallback_at         timestamptz,
  fallback_ref        uuid,
  completed_at        timestamptz,
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists mp_refunds_tenant_idx on mp_refunds (tenant_id, created_at desc);
create index if not exists mp_refunds_sale_idx on mp_refunds (sale_id);
create index if not exists mp_refunds_return_idx on mp_refunds (sale_return_id);
create index if not exists mp_refunds_payment_idx on mp_refunds (payment_id);
create index if not exists mp_refunds_intent_idx on mp_refunds (intent_id);
create index if not exists mp_refunds_store_idx on mp_refunds (store_id) where store_id is not null;
create index if not exists mp_refunds_open_idx on mp_refunds (tenant_id)
  where status in ('pending', 'processing', 'error');
create unique index if not exists mp_refunds_mp_id_uniq on mp_refunds (tenant_id, mp_refund_id)
  where mp_refund_id is not null;
create index if not exists mp_refunds_requested_by_idx on mp_refunds (requested_by) where requested_by is not null;
create index if not exists mp_refunds_authorized_by_idx on mp_refunds (authorized_by) where authorized_by is not null;
create index if not exists mp_refunds_fallback_by_idx on mp_refunds (fallback_by) where fallback_by is not null;
create index if not exists mp_refunds_secret_store_idx on mp_refunds (secret_store_id) where secret_store_id is not null;

drop trigger if exists set_updated_at_mp_refunds on mp_refunds;
create trigger set_updated_at_mp_refunds
  before update on mp_refunds
  for each row execute function set_updated_at();

alter table mp_refunds enable row level security;
drop policy if exists mp_refunds_select on mp_refunds;
create policy mp_refunds_select on mp_refunds
  for select using (tenant_id = current_tenant_id() or internal_scope());
-- Alcance de sucursal: como las ventas (sales_branch_scope).
drop policy if exists mp_refunds_branch on mp_refunds;
create policy mp_refunds_branch on mp_refunds
  as restrictive for select
  using (internal_scope() or store_id is null or store_id = any ((select user_allowed_store_ids())::uuid[]));
revoke insert, update, delete on mp_refunds from anon, authenticated;
grant select on mp_refunds to authenticated;

comment on table mp_refunds is
  'ADR-067: reintegros por Mercado Pago de una devolución. Escritura sólo por RPC (return_sale_v2, _mp_refund_claim/_finish, mp_refund_fallback).';

-- -----------------------------------------------------------------------------
-- E) Pagos de MP reintegrables
-- -----------------------------------------------------------------------------
-- Plazo de Mercado Pago para devolver un pago (días desde el cobro).
create or replace function mp_refund_window_days()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 180 $$;
grant execute on function mp_refund_window_days() to authenticated, service_role;

-- Cobro de MP de una venta: intent aprobado, monto cobrado, reintegrado y
-- disponible. Interna (la usan las RPC de este archivo).
create or replace function _mp_refundable(p_tenant uuid, p_payment uuid)
returns table (
  payment_id   uuid,
  sale_id      uuid,
  intent_id    uuid,
  provider_key text,
  paid         numeric,
  refunded     numeric,
  refundable   numeric,
  expired      boolean,
  paid_at      timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with p as (
    select pa.id, pa.sale_id, pa.amount, pa.created_at,
           case when pa.reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then pa.reference::uuid end as intent_ref
      from payments pa
     where pa.id = p_payment and pa.tenant_id = p_tenant
  ),
  i as (
    select p.*, it.id as iid, it.provider_key as pkey, it.amount as iamount
      from p
      join mp_payment_intents it on it.id = p.intent_ref and it.tenant_id = p_tenant
     where it.provider_key in ('mercadopago', 'mercadopago_point') and it.status = 'approved'
  ),
  r as (
    select coalesce(sum(m.amount), 0) as pos_refunded
      from mp_refunds m, i
     where m.payment_id = i.id and m.tenant_id = p_tenant
       and m.status in ('pending', 'processing', 'approved', 'in_process', 'error')
  ),
  d as (
    -- Devoluciones hechas desde Mercado Pago (ADR-064) también restan.
    select coalesce(sum(pd.amount), 0) as prov_refunded
      from payment_disputes pd, i
     where pd.tenant_id = p_tenant and pd.payment_id = i.id and pd.kind = 'refund'
       and pd.origin = 'provider' and pd.status in ('open', 'refunded') and pd.deleted_at is null
  )
  select i.id, i.sale_id, i.iid, i.pkey,
         round(least(i.amount, i.iamount), 2),
         round(r.pos_refunded + d.prov_refunded, 2),
         greatest(round(least(i.amount, i.iamount) - r.pos_refunded - d.prov_refunded, 2), 0),
         i.created_at < now() - make_interval(days => mp_refund_window_days()),
         i.created_at
    from i, r, d;
$$;
revoke all on function _mp_refundable(uuid, uuid) from public, anon, authenticated;

-- Para el wizard: ajuste prendido, feature, si quien opera es supervisor y los
-- cobros de MP de la venta con lo que se puede devolver de cada uno.
create or replace function mp_refund_options(p_sale_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid;
  v_on     boolean;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  select store_id into v_store from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_store is not null and not coalesce(user_can_access_store(v_store), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce((config ->> 'mp_refunds_enabled')::boolean, false) into v_on
    from tenant_payment_methods where tenant_id = v_tenant and provider_key = 'mercadopago';

  return jsonb_build_object(
    'feature', tenant_has_feature_for(v_tenant, 'reintegro_mp'),
    'enabled', coalesce(v_on, false),
    'is_supervisor', is_supervisor(v_tenant, auth.uid()),
    'window_days', mp_refund_window_days(),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'payment_id', x.payment_id, 'intent_id', x.intent_id, 'provider_key', x.provider_key,
               'paid', x.paid, 'refunded', x.refunded, 'refundable', x.refundable,
               'expired', x.expired, 'paid_at', x.paid_at)
               order by x.paid_at)
        from payments pa
        cross join lateral _mp_refundable(v_tenant, pa.id) x
       where pa.tenant_id = v_tenant and pa.sale_id = p_sale_id), '[]'::jsonb));
end;
$$;
revoke all on function mp_refund_options(uuid) from public, anon;
grant execute on function mp_refund_options(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) return_sale_v2: copia exacta de 20261013120000_venta_sucursal_del_turno
--    + p_mp_payment_id / p_mp_amount (reintegro por Mercado Pago, ADR-067).
--    Cambios marcados con "H21h". Se dropea la firma de 7 args (exchange_sale
--    la llama con argumentos con nombre: sigue resolviendo).
-- -----------------------------------------------------------------------------
create or replace function return_sale_v2(
  p_sale_id uuid,
  p_items jsonb,
  p_reason_id uuid default null,
  p_refund text default 'cash',
  p_customer_id uuid default null,
  p_allowed_branch_ids uuid[] default null,
  p_cash_shift_id uuid default null,
  p_mp_payment_id uuid default null,
  p_mp_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_sale     record;
  v_reason   record;
  v_dest     text := 'resale';
  v_reason_label text;
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_total    numeric := 0;
  v_ret      uuid;
  v_it       record;
  v_si       record;
  v_unit     numeric;
  v_qty      numeric;
  v_line     numeric;
  v_ratio    numeric := 1;
  v_policy   text := 'cashier_choice';
  v_validity int;
  v_refund   text;
  v_customer uuid;
  v_voucher_id uuid;
  v_voucher_code text;
  v_expires  timestamptz;
  v_restock  text;
  -- CC v2: parte acreditada en la cuenta corriente.
  v_acc      numeric := 0;
  -- H21h: parte por Mercado Pago y resto por el medio elegido.
  v_mp_req   boolean := coalesce(p_mp_amount, 0) > 0;
  v_mp       numeric := 0;
  v_rest     numeric := 0;
  v_mpi      record;
  v_mp_id    uuid;
  v_sup      uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- BUG A: no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  -- CC v2: se acepta el reintegro a la cuenta corriente.
  if p_refund not in ('cash','store_credit','account') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;

  -- H21h: validaciones de la pata Mercado Pago antes de tocar nada.
  if v_mp_req then
    if not tenant_has_feature_for(v_tenant, 'reintegro_mp') then
      raise exception 'feature_not_in_plan: reintegro_mp' using errcode = '42501';
    end if;
    if not coalesce((select (config ->> 'mp_refunds_enabled')::boolean from tenant_payment_methods
                      where tenant_id = v_tenant and provider_key = 'mercadopago'), false) then
      raise exception 'mp_refunds_disabled';
    end if;
    if p_reason_id is null then raise exception 'mp_refund_reason_required'; end if;
    if p_mp_payment_id is null then raise exception 'mp_payment_required'; end if;
    -- Un reintegro a la vez por cobro (lo que se resta lo leen las filas).
    perform 1 from payments where id = p_mp_payment_id and tenant_id = v_tenant for update;
    select * into v_mpi from _mp_refundable(v_tenant, p_mp_payment_id);
    if v_mpi.payment_id is null or v_mpi.sale_id is distinct from p_sale_id then
      raise exception 'mp_payment_not_refundable';
    end if;
    if v_mpi.expired then raise exception 'mp_refund_period_expired'; end if;
    v_mp := round(p_mp_amount, 2);
    if v_mp > v_mpi.refundable + 0.001 then raise exception 'mp_amount_exceeds_refundable'; end if;
  end if;

  select coalesce(return_policy, 'cashier_choice'), voucher_validity_months
    into v_policy, v_validity
  from pos_settings where tenant_id = v_tenant;
  if not found then v_policy := 'cashier_choice'; end if;

  v_refund := p_refund;
  -- CC v2: el reintegro a la cuenta corriente (cancelar deuda) no lo pisa la
  -- política de devoluciones (que rige efectivo vs vale).
  if v_refund <> 'account' then
    if v_policy = 'always_credit' then v_refund := 'store_credit';
    elsif v_policy = 'always_cash' then v_refund := 'cash';
    end if;
  end if;

  v_customer := coalesce(v_sale.customer_id, p_customer_id);
  -- H21h: con pata MP el cliente del vale se exige después, si queda resto.
  if v_refund = 'store_credit' and v_customer is null and not v_mp_req then
    raise exception 'store_credit_needs_customer';
  end if;
  if v_refund = 'account' and v_sale.customer_id is null then
    raise exception 'account_needs_customer';
  end if;

  if p_reason_id is not null then
    select * into v_reason from return_reasons
      where id = p_reason_id and tenant_id = v_tenant and deleted_at is null;
    if found then
      v_dest := coalesce(v_reason.stock_destination, 'resale');
      v_reason_label := v_reason.label;
    end if;
  end if;
  v_restock := case v_dest
                 when 'resale' then 'stock'
                 when 'warehouse' then 'review'
                 when 'review' then 'review'
                 else 'discard'
               end;

  if v_sale.subtotal is not null and v_sale.subtotal > 0 then
    v_ratio := v_sale.total / v_sale.subtotal;
  end if;

  -- F17 · H90: turno y sucursal de la caja en uso; el reingreso de stock va a
  -- esa sucursal (o a la de la venta si no hay turno y no hace falta).
  -- H21h: con pata MP el turno se exige después, sólo si queda resto en efectivo.
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, v_refund = 'cash' and not v_mp_req) r;
  v_store := coalesce(v_store, v_sale.store_id);

  if v_refund = 'cash' and not v_mp_req then
    if v_shift is null then raise exception 'no_open_shift'; end if;
  end if;

  -- Correlativo de devolución con advisory lock por tenant.
  perform pg_advisory_xact_lock(hashtext('sale_return_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  insert into sale_returns (sale_id, customer_id, number, reason, refund_method, total)
  values (p_sale_id, v_customer, v_number, v_reason_label, v_refund, 0)
  returning id into v_ret;

  for v_it in
    select * from jsonb_to_recordset(p_items) as x(sale_item_id uuid, quantity numeric)
  loop
    v_qty := coalesce(v_it.quantity, 0);
    if v_qty <= 0 then continue; end if;

    select * into v_si from sale_items
      where id = v_it.sale_item_id and sale_id = p_sale_id for update;
    if not found then raise exception 'item_not_found'; end if;
    if v_qty > (v_si.quantity - coalesce(v_si.returned_qty, 0)) then
      raise exception 'qty_exceeds';
    end if;

    v_unit := case when v_si.quantity > 0 then v_si.subtotal / v_si.quantity else v_si.unit_price end;
    v_line := round(v_unit * v_qty * v_ratio, 2);
    v_total := v_total + v_line;

    insert into sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, subtotal, restock)
    values (v_ret, v_si.id, v_si.product_id, v_qty, v_unit, v_line, v_restock);

    update sale_items set returned_qty = coalesce(returned_qty, 0) + v_qty where id = v_si.id;

    if v_dest = 'resale' and v_si.product_id is not null then
      update products set stock = stock + v_qty, updated_at = now()
        where id = v_si.product_id and tenant_id = v_tenant and track_stock;
      if found then
        insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
        values (v_tenant, v_si.product_id, v_store, v_qty, 'return', v_ret);
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
        values (v_tenant, auth.uid(), 'stock_movements', v_si.product_id, 'return_restock',
          jsonb_build_object('return_id', v_ret, 'product_id', v_si.product_id,
            'qty', v_qty, 'destination', v_dest));
      end if;
    end if;
  end loop;

  if v_total <= 0 then raise exception 'empty_return'; end if;
  update sale_returns set total = v_total where id = v_ret;

  -- H21h: parte por Mercado Pago (nunca más que lo devuelto) y resto.
  if v_mp_req then
    if v_mp > v_total + 0.001 then raise exception 'mp_amount_exceeds_return'; end if;
    v_mp := least(v_mp, v_total);
    v_rest := round(v_total - v_mp, 2);
    if v_rest > 0 and v_refund = 'store_credit' and v_customer is null then
      raise exception 'store_credit_needs_customer';
    end if;
    if v_rest > 0 and v_refund = 'cash' and v_shift is null then
      raise exception 'no_open_shift';
    end if;
    -- Rol supervisor o PIN 'reintegro_mp' (token en el header).
    v_sup := require_supervisor('reintegro_mp', v_mp, p_sale_id);

    insert into mp_refunds (tenant_id, sale_id, sale_return_id, payment_id, intent_id, store_id, provider_key,
                            amount, requested_by, authorized_by, mp_env, secret_store_id)
    select v_tenant, p_sale_id, v_ret, v_mpi.payment_id, v_mpi.intent_id, v_sale.store_id, v_mpi.provider_key,
           v_mp, auth.uid(), coalesce(v_sup, auth.uid()), it.mp_env, it.secret_store_id
      from mp_payment_intents it where it.id = v_mpi.intent_id
    returning id into v_mp_id;

    update sale_returns
       set mp_refund_amount = v_mp,
           refund_method = case when v_rest <= 0 then 'mercadopago' else refund_method end
     where id = v_ret;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'mp_refunds', v_mp_id, 'mp_refund_requested',
      jsonb_build_object('return_id', v_ret, 'sale_id', p_sale_id, 'payment_id', v_mpi.payment_id,
        'amount', v_mp, 'refundable_before', v_mpi.refundable, 'authorized_by', v_sup));
  else
    v_rest := v_total;
  end if;

  -- CC v2: lo pagado con cuenta corriente vuelve a la cuenta (no en efectivo);
  -- con reintegro 'account' vuelve todo a la cuenta. El vale no cambia (el
  -- cambio de mercadería lo usa y la deuda original sigue correspondiendo).
  -- H21h: sobre el resto (lo que no va por Mercado Pago).
  if v_rest > 0 and v_refund in ('cash', 'account') then
    v_acc := account_return_credit(p_sale_id, v_rest, v_refund = 'account',
                                   'Devolución #' || v_number || ' venta #' || v_sale.number);
    update sale_returns
       set account_credited = v_acc,
           refund_method = case when v_mp <= 0 and (v_refund = 'account' or v_acc >= v_total) then 'account'
                                else refund_method end
     where id = v_ret;
  end if;

  if v_rest > 0 and v_refund = 'cash' then
    if v_rest - v_acc > 0 then
      insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
      values (v_shift, 'expense', v_rest - v_acc, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
    end if;
  elsif v_rest > 0 and v_refund = 'store_credit' then
    v_expires := case when v_validity is not null
                      then now() + make_interval(months => v_validity)
                      else null end;
    v_voucher_code := gen_voucher_code();
    insert into store_credit_vouchers
      (tenant_id, code, amount, customer_id, status, expires_at, allowed_branch_ids, sale_return_id)
    values
      (v_tenant, v_voucher_code, v_rest, v_customer, 'active', v_expires, p_allowed_branch_ids, v_ret)
    returning id into v_voucher_id;

    insert into store_credit_movements (customer_id, delta, reason, sale_return_id, voucher_id)
    values (v_customer, v_rest, 'Vale ' || v_voucher_code || ' (dev #' || v_number || ')', v_ret, v_voucher_id);

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'store_credit_vouchers', v_voucher_id, 'voucher_issued',
      jsonb_build_object('code', v_voucher_code, 'amount', v_rest, 'customer_id', v_customer,
        'expires_at', v_expires, 'allowed_branch_ids', p_allowed_branch_ids, 'return_id', v_ret));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'sale_returns', v_ret, 'return_created',
    jsonb_build_object('number', v_number, 'sale_id', p_sale_id, 'total', v_total,
      'refund', v_refund, 'reason_id', p_reason_id, 'stock_destination', v_dest,
      'mp_amount', v_mp, 'mp_refund_id', v_mp_id));

  return jsonb_build_object(
    'return_id', v_ret, 'number', v_number, 'total', v_total,
    'refund', v_refund, 'stock_destination', v_dest,
    'voucher_code', v_voucher_code, 'voucher_expires_at', v_expires,
    'account_credited', v_acc,
    'cash_refund', case when v_refund = 'cash' and v_rest > 0 then v_rest - v_acc else 0 end,
    'mp_amount', v_mp,
    'mp_refund_id', v_mp_id,
    'rest_amount', v_rest
  );
end;
$$;

drop function if exists public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[], uuid);
revoke all on function public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[], uuid, uuid, numeric) from public, anon;
grant execute on function public.return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[], uuid, uuid, numeric) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Para la Edge `mp_refund` (service_role)
-- -----------------------------------------------------------------------------
-- Toma el reintegro para llamar a MP. Lo puede pedir quien lo registró o un
-- dueño o encargado del negocio. 'pending', 'error' (reintento con la misma
-- clave de idempotencia), 'failed' (reintento con clave nueva, p. ej. después
-- de cargar saldo) y 'processing' trabado más de 2 minutos.
create or replace function _mp_refund_claim(p_id uuid, p_tenant uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v   mp_refunds%rowtype;
  v_i mp_payment_intents%rowtype;
  v_role text;
begin
  select * into v from mp_refunds where id = p_id and tenant_id = p_tenant for update;
  if not found then return jsonb_build_object('error', 'refund_not_found'); end if;
  select role into v_role from tenant_users
   where tenant_id = p_tenant and user_id = p_user and status = 'active';
  if v_role is null or (v.requested_by is distinct from p_user and v_role not in ('owner', 'manager')) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if not tenant_has_feature_for(p_tenant, 'reintegro_mp') then
    return jsonb_build_object('error', 'feature_not_in_plan');
  end if;
  if v.status in ('approved', 'in_process', 'fallback') then
    return jsonb_build_object('error', 'already_final', 'status', v.status, 'mp_refund_id', v.mp_refund_id);
  end if;
  if v.status = 'processing' and v.updated_at > now() - interval '2 minutes' then
    return jsonb_build_object('error', 'in_progress');
  end if;
  select * into v_i from mp_payment_intents where id = v.intent_id and tenant_id = p_tenant;
  if not found then return jsonb_build_object('error', 'intent_not_found'); end if;

  update mp_refunds
     set status = 'processing', attempts = attempts + 1,
         idem_seq = idem_seq + case when v.status = 'failed' then 1 else 0 end
   where id = v.id
  returning * into v;

  return jsonb_build_object(
    'id', v.id, 'amount', v.amount, 'attempts', v.attempts,
    'idempotency_key', v.id::text || ':' || v.idem_seq::text,
    'sale_id', v.sale_id, 'payment_id', v.payment_id, 'intent_id', v.intent_id,
    'provider_key', v_i.provider_key,
    'mp_payment_id', v_i.mp_payment_id, 'mp_order_id', v_i.mp_order_id,
    'mp_env', coalesce(v.mp_env, v_i.mp_env), 'secret_store_id', coalesce(v.secret_store_id, v_i.secret_store_id),
    'provider_payment_id', v.provider_payment_id);
end;
$$;
revoke all on function _mp_refund_claim(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function _mp_refund_claim(uuid, uuid, uuid) to service_role;

-- Cierra el intento con lo que respondió Mercado Pago.
--   p_status: approved | in_process | failed | error
create or replace function _mp_refund_finish(
  p_id                  uuid,
  p_tenant              uuid,
  p_user                uuid,
  p_status              text,
  p_mp_refund_id        text default null,
  p_mp_status           text default null,
  p_error_code          text default null,
  p_error_detail        text default null,
  p_provider_payment_id text default null,
  p_raw                 jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v       mp_refunds%rowtype;
  v_ppid  text := nullif(left(btrim(coalesce(p_provider_payment_id, '')), 80), '');
  v_rid   text := nullif(left(btrim(coalesce(p_mp_refund_id, '')), 80), '');
begin
  if p_status not in ('approved', 'in_process', 'failed', 'error') then raise exception 'invalid_status'; end if;
  select * into v from mp_refunds where id = p_id and tenant_id = p_tenant for update;
  if not found then raise exception 'refund_not_found'; end if;
  if v.status <> 'processing' then
    return jsonb_build_object('status', v.status, 'unchanged', true);
  end if;

  update mp_refunds set
    status              = p_status,
    mp_refund_id        = coalesce(v_rid, mp_refund_id),
    mp_status           = left(p_mp_status, 40),
    error_code          = case when p_status in ('failed', 'error') then left(p_error_code, 60) end,
    error_detail        = case when p_status in ('failed', 'error') then left(p_error_detail, 300) end,
    provider_payment_id = coalesce(v_ppid, provider_payment_id),
    completed_at        = case when p_status in ('approved', 'in_process', 'failed') then now() end,
    raw                 = coalesce(p_raw, raw)
  where id = v.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, p_user, 'mp_refunds', v.id,
          case p_status when 'approved' then 'mp_refund_approved'
                        when 'in_process' then 'mp_refund_in_process'
                        when 'failed' then 'mp_refund_failed'
                        else 'mp_refund_error' end,
          jsonb_build_object('amount', v.amount, 'mp_refund_id', v_rid, 'mp_status', p_mp_status,
                             'error_code', p_error_code, 'sale_id', v.sale_id, 'return_id', v.sale_return_id,
                             'provider_payment_id', coalesce(v_ppid, v.provider_payment_id)));

  -- ADR-064: la devolución queda registrada como hecha desde el POS. Si la
  -- sincronización ya la había traído, se corrige el origen y no avisa.
  if p_status in ('approved', 'in_process') and v_rid is not null and coalesce(v_ppid, v.provider_payment_id) is not null then
    insert into payment_disputes (tenant_id, provider_key, kind, dispute_key, provider_payment_id, provider_case_id,
                                  scope_store_id, payment_id, sale_id, intent_id, amount, currency, status,
                                  provider_status, refund_source, origin, occurred_at, resolved_at, raw)
    values (p_tenant, 'mercadopago', 'refund', 'mp_refund:' || v_rid, coalesce(v_ppid, v.provider_payment_id), v_rid,
            v.secret_store_id, v.payment_id, v.sale_id, v.intent_id, v.amount, 'ARS',
            case when p_status = 'approved' then 'refunded' else 'open' end,
            left(p_mp_status, 40), 'pos', 'pos', now(),
            case when p_status = 'approved' then now() end,
            jsonb_build_object('mp_refund_row', v.id))
    on conflict (tenant_id, provider_key, dispute_key) do update
      set origin = 'pos',
          payment_id = coalesce(payment_disputes.payment_id, excluded.payment_id),
          sale_id = coalesce(payment_disputes.sale_id, excluded.sale_id),
          intent_id = coalesce(payment_disputes.intent_id, excluded.intent_id);
  end if;

  return jsonb_build_object('status', p_status, 'mp_refund_id', v_rid);
end;
$$;
revoke all on function _mp_refund_finish(uuid, uuid, uuid, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function _mp_refund_finish(uuid, uuid, uuid, text, text, text, text, text, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- H) Respaldo: efectivo o vale cuando Mercado Pago no pudo
-- -----------------------------------------------------------------------------
-- Sólo con el reintegro rechazado por MP ('failed') o todavía sin intentar
-- ('pending'). Quien lo registró o un dueño o encargado. Efectivo: sale del
-- turno PROPIO abierto (resolve_sale_shift estricto). Vale: para el cliente de
-- la venta (o el que se indique).
create or replace function mp_refund_fallback(
  p_refund_id     uuid,
  p_method        text,
  p_cash_shift_id uuid default null,
  p_customer_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v         mp_refunds%rowtype;
  v_sale    record;
  v_ret     record;
  v_shift   uuid;
  v_store   uuid;
  v_cust    uuid;
  v_code    text;
  v_vid     uuid;
  v_exp     timestamptz;
  v_valid   int;
  v_mov     uuid;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if p_method not in ('cash', 'store_credit') then raise exception 'invalid_method'; end if;
  select * into v from mp_refunds where id = p_refund_id and tenant_id = v_tenant for update;
  if not found then raise exception 'refund_not_found'; end if;
  if v.requested_by is distinct from auth.uid() and not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v.status not in ('failed', 'pending') then raise exception 'refund_not_fallbackable'; end if;
  select * into v_sale from sales where id = v.sale_id and tenant_id = v_tenant;
  select * into v_ret from sale_returns where id = v.sale_return_id and tenant_id = v_tenant;

  if p_method = 'cash' then
    perform assert_account_active(v_tenant);
    select r.o_shift_id, r.o_store_id into v_shift, v_store from resolve_sale_shift(p_cash_shift_id, true) r;
    if v_shift is null then raise exception 'no_open_shift'; end if;
    insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
    values (v_shift, 'expense', v.amount, 'cash',
            'Devolución venta #' || v_sale.number || ' (Mercado Pago no pudo)', v.sale_return_id)
    returning id into v_mov;
  else
    v_cust := coalesce(v_sale.customer_id, v_ret.customer_id, p_customer_id);
    if v_cust is null then raise exception 'store_credit_needs_customer'; end if;
    if not exists (select 1 from customers c where c.id = v_cust and c.tenant_id = v_tenant) then
      raise exception 'customer_not_found';
    end if;
    select voucher_validity_months into v_valid from pos_settings where tenant_id = v_tenant;
    v_exp := case when v_valid is not null then now() + make_interval(months => v_valid) end;
    v_code := gen_voucher_code();
    insert into store_credit_vouchers (tenant_id, code, amount, customer_id, status, expires_at, sale_return_id)
    values (v_tenant, v_code, v.amount, v_cust, 'active', v_exp, v.sale_return_id)
    returning id into v_vid;
    insert into store_credit_movements (customer_id, delta, reason, sale_return_id, voucher_id)
    values (v_cust, v.amount, 'Vale ' || v_code || ' (dev #' || v_ret.number || ', Mercado Pago no pudo)',
            v.sale_return_id, v_vid);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'store_credit_vouchers', v_vid, 'voucher_issued',
      jsonb_build_object('code', v_code, 'amount', v.amount, 'customer_id', v_cust,
        'expires_at', v_exp, 'return_id', v.sale_return_id, 'mp_refund_id', v.id));
  end if;

  update mp_refunds
     set status = 'fallback', fallback_method = p_method, fallback_by = auth.uid(), fallback_at = now(),
         fallback_ref = coalesce(v_mov, v_vid)
   where id = v.id;
  update sale_returns
     set mp_refund_amount = greatest(mp_refund_amount - v.amount, 0),
         refund_method = case when refund_method = 'mercadopago' then p_method else refund_method end
   where id = v.sale_return_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'mp_refunds', v.id, 'mp_refund_fallback',
          jsonb_build_object('status', v.status, 'error_code', v.error_code),
          jsonb_build_object('method', p_method, 'amount', v.amount, 'return_id', v.sale_return_id,
                             'voucher_code', v_code, 'cash_shift_id', v_shift));

  return jsonb_build_object('method', p_method, 'amount', v.amount, 'voucher_code', v_code,
                            'voucher_expires_at', v_exp);
end;
$$;
revoke all on function mp_refund_fallback(uuid, text, uuid, uuid) from public, anon;
grant execute on function mp_refund_fallback(uuid, text, uuid, uuid) to authenticated;
