-- =============================================================================
-- 20261014100000_cobros_en_espera  (F8 · ADR-048)
--
-- "Cobros en espera": el cajero genera un QR o link, lo comparte y deja la
-- venta esperando el pago mientras sigue cobrando. Cuando el proveedor
-- acredita, la VENTA SE CREA DEL LADO DEL SERVIDOR (aunque el POS que la
-- originó esté cerrado), con el carrito guardado y el monto del intent.
--
--   pending_charges        el cobro estacionado: carrito (argumentos de
--                          create_sale), sucursal, caja, turno, cliente,
--                          intent del proveedor, link, vencimiento, estado.
--   pending_charge_events  línea de tiempo (creado, compartido, editado,
--                          pagado, venta creada, cancelado, vencido...).
--
-- Estados: waiting → paid → completed | waiting → cancelled | expired.
--   paid = el proveedor acreditó pero la venta todavía no se pudo crear (no
--   hay caja abierta, falta stock, etc.). Se reintenta sola (cron, apertura de
--   caja) o a mano. needs_review = pago tardío sobre un cobro cancelado o
--   vencido, o pago de un link reemplazado: sólo se completa a mano.
--
-- Escritura SÓLO por RPC SECURITY DEFINER (sin policies de insert/update):
--   park_pending_charge, complete_pending_charge, cancel_pending_charge,
--   update_pending_charge, replace_pending_charge_intent,
--   mark_pending_charge_shared, ack_pending_charge.
-- La completitud (_pc_complete) se dispara desde:
--   1. trigger AFTER UPDATE OF status en mp_payment_intents (webhooks y
--      polling de TODOS los proveedores ya actualizan esa fila),
--   2. el POS (sondeo) y el botón "Reintentar",
--   3. la apertura de caja (trigger en cash_shifts) y el cron cada 2 min.
-- Siempre idempotente: lock de la fila del cobro y del intent; un cobro
-- completado devuelve su venta.
--
-- Montos: nunca se confía en el cliente al completar. Al estacionar se corre
-- create_sale en seco (subtransacción revertida) para obtener el total
-- autoritativo y se exige total + propina = monto del intent. Al completar se
-- usa el carrito guardado y el monto del intent (escrito sólo por Edge
-- Functions tras verificar con el proveedor); si el proveedor cobró más
-- (Payway con cuotas con recargo) la diferencia entra como ítem de recargo.
--
-- Cierre de caja: close_cash_shift suma p_pending_action ('cancel' | 'carry').
-- Con cobros abiertos en el turno y sin decisión → pending_charges_decision_required.
-- 'carry' los desengancha del turno (cash_shift_id = null, carry_over) y se
-- enganchan solos al próximo turno que se abra en esa caja.
--
-- Feature de plan: cobros_en_espera (OPTIONAL, Pro en adelante). Gating real
-- en park/replace/share (la UI no es la única barrera). La completitud no se
-- gatea: si el cliente ya pagó, la venta se registra igual.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature de plan
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('cobros_en_espera', 'Cobros en espera',
   'Dejar un cobro por QR o link esperando el pago mientras se sigue vendiendo; la venta se registra sola al acreditarse',
   'ventas', false, 47)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('cobros_en_espera', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'cobros_en_espera');

-- Notificaciones de cobros y bitácora de emails de links de pago.
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications
  add constraint notifications_type_check
  check (type in ('news','plan','billing','usage','security','afip','maintenance','support','cobros'));

alter table system_emails drop constraint if exists system_emails_kind_check;
alter table system_emails
  add constraint system_emails_kind_check
  check (kind in ('system', 'receipt', 'smtp_test', 'password_recovery', 'payment_link'));

-- -----------------------------------------------------------------------------
-- B) Tablas
-- -----------------------------------------------------------------------------
create table if not exists pending_charges (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id            uuid not null references stores(id),
  register_id         uuid references cash_registers(id),
  -- Turno al que pertenece hoy (null = pasado a la próxima apertura).
  cash_shift_id       uuid references cash_shifts(id),
  -- Turno en el que se creó (histórico).
  origin_shift_id     uuid references cash_shifts(id),
  created_by          uuid references public.users(id),
  customer_id         uuid references customers(id),
  customer_name       text,
  customer_email      text,
  customer_phone      text,
  -- Argumentos de create_sale (items, extras, descuentos, promo, cupón).
  sale_args           jsonb not null,
  -- Carrito del POS tal cual (para "Editar en el POS"). Sólo display.
  cart                jsonb not null default '{}'::jsonb,
  -- Líneas para mostrar en el detalle. Sólo display.
  lines               jsonb not null default '[]'::jsonb,
  -- Monto del intent al estacionar o editar (= total + propina autoritativos).
  amount              numeric(12,2) not null check (amount > 0),
  sale_total          numeric(12,2) not null default 0,
  provider_key        text not null,
  channel             text not null default 'link' check (channel in ('qr', 'link')),
  intent_id           uuid not null references mp_payment_intents(id),
  previous_intent_ids uuid[] not null default '{}',
  share_url           text,
  qr_data             text,
  shared_via          text[] not null default '{}',
  share_count         integer not null default 0,
  status              text not null default 'waiting'
                        check (status in ('waiting', 'paid', 'completed', 'cancelled', 'expired')),
  expires_at          timestamptz not null,
  paid_at             timestamptz,
  paid_amount         numeric(12,2),
  completed_at        timestamptz,
  sale_id             uuid references sales(id),
  sale_number         bigint,
  cancelled_at        timestamptz,
  cancelled_by        uuid references public.users(id),
  cancel_reason       text,
  carry_over          boolean not null default false,
  needs_review        boolean not null default false,
  last_error          text,
  attempts            integer not null default 0,
  last_attempt_at     timestamptz,
  acknowledged_at     timestamptz,
  acknowledged_by     uuid references public.users(id),
  notes               text,
  version             integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create unique index if not exists pending_charges_intent_uidx on pending_charges (intent_id);
create index if not exists pending_charges_prev_intents_idx on pending_charges using gin (previous_intent_ids);
create index if not exists pending_charges_tenant_store_status_idx
  on pending_charges (tenant_id, store_id, status, created_at desc);
create index if not exists pending_charges_shift_idx on pending_charges (cash_shift_id) where status in ('waiting', 'paid');
create index if not exists pending_charges_open_idx on pending_charges (status, expires_at) where status in ('waiting', 'paid');
create index if not exists pending_charges_sale_idx on pending_charges (sale_id);
create index if not exists pending_charges_register_idx on pending_charges (register_id);
create index if not exists pending_charges_origin_shift_idx on pending_charges (origin_shift_id);
create index if not exists pending_charges_customer_idx on pending_charges (customer_id);

drop trigger if exists set_updated_at_pending_charges on pending_charges;
create trigger set_updated_at_pending_charges
  before update on pending_charges
  for each row execute function set_updated_at();

create table if not exists pending_charge_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  pending_charge_id uuid not null references pending_charges(id) on delete cascade,
  kind              text not null,
  data              jsonb,
  actor_user_id     uuid references public.users(id),
  created_at        timestamptz not null default now()
);
create index if not exists pending_charge_events_charge_idx
  on pending_charge_events (pending_charge_id, created_at);
create index if not exists pending_charge_events_tenant_idx on pending_charge_events (tenant_id);

alter table pending_charges enable row level security;
alter table pending_charge_events enable row level security;

-- Lectura: miembros del negocio, sólo de las sucursales que pueden operar.
-- Staff interno sólo con internal_scope() (ADR-052: nunca is_internal() en
-- policies de tablas con tenant_id). Escritura: sólo RPC (sin policies de
-- insert/update/delete).
drop policy if exists pending_charges_select on pending_charges;
create policy pending_charges_select on pending_charges
  for select using (
    internal_scope()
    or (
      tenant_id = current_tenant_id()
      and deleted_at is null
      and store_id = any ((select user_allowed_store_ids())::uuid[])
    )
  );

drop policy if exists pending_charge_events_select on pending_charge_events;
create policy pending_charge_events_select on pending_charge_events
  for select using (
    internal_scope()
    or (
      tenant_id = current_tenant_id()
      and exists (select 1 from pending_charges pc where pc.id = pending_charge_events.pending_charge_id)
    )
  );

comment on table pending_charges is
  'Cobros en espera (ADR-048): venta estacionada esperando el pago de un QR o link. Escritura sólo por RPC.';

-- -----------------------------------------------------------------------------
-- C) Helpers internos (sin grant a authenticated salvo indicación)
-- -----------------------------------------------------------------------------

-- Tope de vencimiento por proveedor (minutos). Espejo de
-- modules/pending-charges/logic.ts (PROVIDER_MAX_TTL_MINUTES).
create or replace function pending_charge_max_ttl(p_provider text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_provider
    when 'mercadopago' then 10080
    when 'mobbex'      then 4320
    when 'pagos360'    then 1440
    when 'payway'      then 4320
    when 'getnet'      then 30
    when 'modo'        then 30
    when 'nave'        then 60
    when 'gocuotas'    then 1440
    when 'directo'     then 1440
    else 1440
  end;
$$;
grant execute on function pending_charge_max_ttl(text) to authenticated, service_role;

create or replace function _pc_money(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select '$' || translate(to_char(round(coalesce(p, 0), 2), 'FM999,999,999,990.00'), ',.', '.,');
$$;

create or replace function _pc_event(
  p_tenant uuid,
  p_charge uuid,
  p_kind   text,
  p_data   jsonb default null,
  p_actor  uuid default null
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into pending_charge_events (tenant_id, pending_charge_id, kind, data, actor_user_id)
  values (p_tenant, p_charge, p_kind, p_data, coalesce(p_actor, auth.uid()));
$$;
revoke all on function _pc_event(uuid, uuid, text, jsonb, uuid) from public, anon, authenticated;

-- Notifica a los usuarios activos que operan la sucursal del cobro.
create or replace function _pc_notify(
  p_charge   pending_charges,
  p_severity text,
  p_title    text,
  p_body     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_u record;
begin
  for v_u in
    select tu.user_id, tu.role
      from tenant_users tu
     where tu.tenant_id = p_charge.tenant_id and tu.status = 'active'
  loop
    if p_charge.store_id = any (staff_allowed_store_ids(p_charge.tenant_id, v_u.user_id, null, v_u.role, null)) then
      insert into notifications (target_tenant_id, target_user_id, type, severity, title, body,
                                 action_label, action_url, expires_at)
      values (p_charge.tenant_id, v_u.user_id, 'cobros', p_severity, p_title, p_body,
              'Ver cobro', '/cobros-en-espera?id=' || p_charge.id::text, now() + interval '7 days');
    end if;
  end loop;
exception when others then
  -- Las notificaciones nunca rompen un cobro.
  raise warning '_pc_notify: %', sqlerrm;
end;
$$;
revoke all on function _pc_notify(pending_charges, text, text, text) from public, anon, authenticated;

-- Corre create_sale EN SECO (subtransacción que se revierte) y devuelve su
-- resultado: total autoritativo, propina, descuentos. Valida el carrito igual
-- que la venta real (stock, cupón, topes, gating). Pago ficticio en efectivo
-- por un monto alto para que el pago nunca sea el límite (se revierte).
create or replace function _pc_dry_run(p_sale jsonb, p_shift uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res    jsonb;
  v_msg    text;
  v_detail text;
begin
  begin
    v_res := create_sale(
      p_items          := coalesce(p_sale -> 'items', '[]'::jsonb),
      p_payments       := jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 999999999)),
      p_discount_total := coalesce((p_sale ->> 'discount_total')::numeric, 0),
      p_customer_id    := nullif(p_sale ->> 'customer_id', '')::uuid,
      p_notes          := nullif(p_sale ->> 'notes', ''),
      p_extras         := coalesce(p_sale -> 'extras', '[]'::jsonb),
      p_promo_discount := coalesce((p_sale ->> 'promo_discount')::numeric, 0),
      p_promo_id       := nullif(p_sale ->> 'promo_id', '')::uuid,
      p_promo_name     := nullif(p_sale ->> 'promo_name', ''),
      p_coupon_id      := nullif(p_sale ->> 'coupon_id', '')::uuid,
      p_cash_shift_id  := p_shift
    );
    raise exception using message = 'pc_dry_run_ok', detail = v_res::text;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    if v_msg = 'pc_dry_run_ok' then
      return v_detail::jsonb;
    end if;
    raise exception '%', v_msg;
  end;
end;
$$;
revoke all on function _pc_dry_run(jsonb, uuid) from public, anon, authenticated;

-- Carrito bien formado (sólo claves conocidas; sin mesa ni delivery).
create or replace function _pc_assert_sale_args(p_sale jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_sale is null or jsonb_typeof(p_sale) <> 'object' then
    raise exception 'invalid_sale';
  end if;
  if jsonb_typeof(p_sale -> 'items') is distinct from 'array'
     or jsonb_array_length(p_sale -> 'items') = 0 then
    raise exception 'invalid_sale';
  end if;
  if p_sale ? 'extras' and jsonb_typeof(p_sale -> 'extras') <> 'array' then
    raise exception 'invalid_sale';
  end if;
  if p_sale ? 'table_order_id' or p_sale ? 'delivery_order_id' then
    raise exception 'unsupported_origin';
  end if;
end;
$$;

-- Turno abierto para registrar la venta de un cobro pagado: el suyo si sigue
-- abierto, si no el abierto de su caja, si no el más reciente de su sucursal.
create or replace function _pc_target_shift(p_charge pending_charges)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select cs.id from cash_shifts cs
      where cs.id = p_charge.cash_shift_id and cs.tenant_id = p_charge.tenant_id and cs.status = 'open'),
    (select cs.id from cash_shifts cs
      where cs.cash_register_id = p_charge.register_id and cs.tenant_id = p_charge.tenant_id
        and cs.status = 'open'
      order by cs.opened_at desc limit 1),
    (select cs.id from cash_shifts cs
      where cs.store_id = p_charge.store_id and cs.tenant_id = p_charge.tenant_id
        and cs.status = 'open'
      order by cs.opened_at desc limit 1)
  );
$$;
revoke all on function _pc_target_shift(pending_charges) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Completitud: cobro pagado → venta. Idempotente.
--    p_actor: usuario a cuyo nombre se crea la venta (null = quien estacionó).
--    create_sale lee el negocio y el usuario del JWT: se fijan los claims de
--    la transacción para ese usuario y se restauran al salir (el trigger corre
--    dentro de la transacción del webhook, con service_role).
-- -----------------------------------------------------------------------------
create or replace function _pc_complete(
  p_id     uuid,
  p_actor  uuid default null,
  p_source text default 'system',
  p_force  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c       pending_charges%rowtype;
  v_i       record;
  v_shift   uuid;
  v_items   jsonb;
  v_extras  jsonb;
  v_diff    numeric;
  v_res     jsonb;
  v_msg     text;
  v_actor   uuid;
  v_prev_claims text;
  v_prev_claim  text;
  v_prev_sub    text;
  v_sale_number bigint;
begin
  select * into v_c from pending_charges where id = p_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_c.status = 'completed' then
    return jsonb_build_object('status', 'completed', 'sale_id', v_c.sale_id, 'number', v_c.sale_number);
  end if;
  if v_c.status not in ('waiting', 'paid') then
    return jsonb_build_object('status', v_c.status);
  end if;
  if v_c.needs_review and not p_force then
    return jsonb_build_object('status', v_c.status, 'error', 'needs_review');
  end if;

  select id, status, amount, sale_id, provider_key, mp_payment_id
    into v_i
    from mp_payment_intents
   where id = v_c.intent_id and tenant_id = v_c.tenant_id
   for update;
  if not found or v_i.status <> 'approved' then
    return jsonb_build_object('status', v_c.status);
  end if;

  -- La venta ya existe (p. ej. la registró el POS antes de estacionar).
  if v_i.sale_id is not null then
    select number into v_sale_number from sales where id = v_i.sale_id;
    update pending_charges
       set status = 'completed', sale_id = v_i.sale_id, sale_number = v_sale_number,
           completed_at = coalesce(completed_at, now()),
           paid_at = coalesce(paid_at, now()), paid_amount = coalesce(paid_amount, v_i.amount),
           last_error = null, version = version + 1
     where id = v_c.id;
    perform _pc_event(v_c.tenant_id, v_c.id, 'completed',
                      jsonb_build_object('sale_id', v_i.sale_id, 'number', v_sale_number, 'source', p_source, 'existing', true),
                      p_actor);
    return jsonb_build_object('status', 'completed', 'sale_id', v_i.sale_id, 'number', v_sale_number);
  end if;

  if v_c.status = 'waiting' then
    update pending_charges
       set status = 'paid', paid_at = now(), paid_amount = v_i.amount, version = version + 1
     where id = v_c.id;
    perform _pc_event(v_c.tenant_id, v_c.id, 'paid',
                      jsonb_build_object('amount', v_i.amount, 'provider', v_i.provider_key,
                                         'payment_id', v_i.mp_payment_id, 'source', p_source),
                      p_actor);
    v_c.status := 'paid';
  end if;

  v_shift := _pc_target_shift(v_c);
  if v_shift is null then
    update pending_charges
       set last_error = 'no_open_shift', attempts = attempts + 1, last_attempt_at = now()
     where id = v_c.id;
    return jsonb_build_object('status', 'paid', 'error', 'no_open_shift');
  end if;

  -- Monto: el del intent (verificado por la Edge contra el proveedor).
  v_items  := coalesce(v_c.sale_args -> 'items', '[]'::jsonb);
  v_extras := coalesce(v_c.sale_args -> 'extras', '[]'::jsonb);
  v_diff   := round(v_i.amount - v_c.amount, 2);
  if v_diff > 0.01 then
    -- Cuotas con recargo elegidas por el cliente en el checkout (Payway).
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', null, 'name', 'Recargo cuotas', 'quantity', 1,
      'unit_price', v_diff, 'discount', 0));
    v_extras := v_extras || jsonb_build_array(jsonb_build_object('kind', 'surcharge', 'amount', v_diff));
  elsif v_diff < -0.01 then
    update pending_charges
       set last_error = 'amount_mismatch', needs_review = true,
           attempts = attempts + 1, last_attempt_at = now()
     where id = v_c.id;
    perform _pc_event(v_c.tenant_id, v_c.id, 'completion_failed',
                      jsonb_build_object('error', 'amount_mismatch', 'paid', v_i.amount, 'expected', v_c.amount),
                      p_actor);
    return jsonb_build_object('status', 'paid', 'error', 'amount_mismatch');
  end if;

  -- Claims de la transacción → usuario y negocio del cobro.
  v_actor := coalesce(p_actor, v_c.created_by);
  v_prev_claims := current_setting('request.jwt.claims', true);
  v_prev_claim  := current_setting('request.jwt.claim', true);
  v_prev_sub    := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub', v_actor,
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('current_tenant_id', v_c.tenant_id)
    )::text, true);

  begin
    v_res := create_sale(
      p_items          := v_items,
      p_payments       := jsonb_build_array(jsonb_build_object(
                            'method', 'qr', 'amount', v_i.amount, 'reference', v_i.id::text)),
      p_discount_total := coalesce((v_c.sale_args ->> 'discount_total')::numeric, 0),
      p_customer_id    := nullif(v_c.sale_args ->> 'customer_id', '')::uuid,
      p_notes          := nullif(v_c.sale_args ->> 'notes', ''),
      p_extras         := v_extras,
      p_promo_discount := coalesce((v_c.sale_args ->> 'promo_discount')::numeric, 0),
      p_promo_id       := nullif(v_c.sale_args ->> 'promo_id', '')::uuid,
      p_promo_name     := nullif(v_c.sale_args ->> 'promo_name', ''),
      p_coupon_id      := nullif(v_c.sale_args ->> 'coupon_id', '')::uuid,
      p_cash_shift_id  := v_shift
    );
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);
    perform set_config('request.jwt.claim', coalesce(v_prev_claim, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
    update pending_charges
       set last_error = left(v_msg, 300), attempts = attempts + 1, last_attempt_at = now(),
           version = version + 1
     where id = v_c.id;
    perform _pc_event(v_c.tenant_id, v_c.id, 'completion_failed',
                      jsonb_build_object('error', left(v_msg, 300), 'source', p_source), p_actor);
    -- Primer fallo: aviso para que alguien lo resuelva.
    if v_c.attempts = 0 and v_msg <> 'no_open_shift' then
      perform _pc_notify(v_c, 'warning', 'Cobro pagado sin venta',
        'El cliente pagó ' || _pc_money(v_i.amount)
          || ' pero la venta no se pudo registrar (' || left(v_msg, 80) || '). Revisalo en Cobros en espera.');
    end if;
    return jsonb_build_object('status', 'paid', 'error', left(v_msg, 300));
  end;

  perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);
  perform set_config('request.jwt.claim', coalesce(v_prev_claim, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);

  update pending_charges
     set status = 'completed', sale_id = (v_res ->> 'sale_id')::uuid,
         sale_number = (v_res ->> 'number')::bigint, completed_at = now(),
         cash_shift_id = v_shift, carry_over = false,
         last_error = null, needs_review = false, attempts = attempts + 1, last_attempt_at = now(),
         version = version + 1
   where id = v_c.id;

  perform _pc_event(v_c.tenant_id, v_c.id, 'completed',
                    jsonb_build_object('sale_id', v_res ->> 'sale_id', 'number', v_res -> 'number',
                                       'total', v_res -> 'total', 'shift_id', v_shift,
                                       'source', p_source, 'forced', p_force),
                    p_actor);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_c.tenant_id, v_actor, 'pending_charges', v_c.id, 'pending_charge_completed',
          jsonb_build_object('sale_id', v_res ->> 'sale_id', 'number', v_res -> 'number',
                             'amount', v_i.amount, 'intent_id', v_i.id, 'shift_id', v_shift,
                             'source', p_source, 'forced', p_force));
  perform _pc_notify(v_c, 'success', 'Cobro acreditado',
    'Venta #' || (v_res ->> 'number') || ' por ' || _pc_money(v_i.amount)
      || coalesce(' de ' || v_c.customer_name, '') || '. Ya podés imprimir el ticket.');

  return jsonb_build_object('status', 'completed', 'sale_id', v_res ->> 'sale_id',
                            'number', (v_res ->> 'number')::bigint, 'total', v_res -> 'total');
end;
$$;
revoke all on function _pc_complete(uuid, uuid, text, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Trigger: el intent cambió de estado (webhook o polling de cualquier
--    proveedor). Nunca hace fallar la actualización del intent.
-- -----------------------------------------------------------------------------
create or replace function pending_charges_on_intent_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c pending_charges%rowtype;
begin
  begin
    if new.status = 'approved' then
      -- Intent vigente del cobro.
      select * into v_c from pending_charges where intent_id = new.id and deleted_at is null;
      if found then
        if v_c.status in ('waiting', 'paid') then
          perform _pc_complete(v_c.id, null, 'provider', false);
        elsif v_c.status in ('cancelled', 'expired') then
          -- Pago tardío: la plata entró. No se crea la venta sola (el stock
          -- pudo haberse vendido): queda pagado para revisión.
          update pending_charges
             set status = 'paid', paid_at = now(), paid_amount = new.amount,
                 needs_review = true, last_error = 'paid_after_cancel', version = version + 1
           where id = v_c.id;
          perform _pc_event(v_c.tenant_id, v_c.id, 'paid_after_cancel',
                            jsonb_build_object('amount', new.amount, 'previous_status', v_c.status), null);
          perform _pc_notify(v_c, 'warning', 'Se pagó un cobro cancelado',
            'Entró un pago de ' || _pc_money(new.amount)
              || ' sobre un cobro que estaba ' || case v_c.status when 'cancelled' then 'cancelado' else 'vencido' end
              || '. Registrá la venta o devolvé el dinero.');
        end if;
      end if;

      -- Link reemplazado que igual se pagó.
      for v_c in
        select * from pending_charges
         where new.id = any (previous_intent_ids) and deleted_at is null
           and status in ('waiting', 'expired', 'cancelled', 'paid')
      loop
        update pending_charges
           set needs_review = true, last_error = 'superseded_intent_paid', version = version + 1
         where id = v_c.id;
        perform _pc_event(v_c.tenant_id, v_c.id, 'old_intent_paid',
                          jsonb_build_object('intent_id', new.id, 'amount', new.amount), null);
        perform _pc_notify(v_c, 'warning', 'Se pagó un link anterior',
          'El cliente pagó ' || _pc_money(new.amount)
            || ' con un link que ya habías reemplazado. Revisalo antes de cobrar de nuevo.');
      end loop;

    elsif new.status in ('cancelled', 'expired') then
      for v_c in
        select * from pending_charges
         where intent_id = new.id and status = 'waiting' and deleted_at is null
      loop
        update pending_charges set status = 'expired', version = version + 1 where id = v_c.id;
        perform _pc_event(v_c.tenant_id, v_c.id, 'expired',
                          jsonb_build_object('reason', 'provider', 'intent_status', new.status), null);
      end loop;

    elsif new.status = 'rejected' then
      for v_c in
        select * from pending_charges
         where intent_id = new.id and status = 'waiting' and deleted_at is null
      loop
        perform _pc_event(v_c.tenant_id, v_c.id, 'payment_rejected', null, null);
      end loop;
    end if;
  exception when others then
    raise warning 'pending_charges_on_intent_status(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function pending_charges_on_intent_status() from public, anon, authenticated;

drop trigger if exists pending_charges_on_intent_status on mp_payment_intents;
create trigger pending_charges_on_intent_status
  after update of status on mp_payment_intents
  for each row
  when (old.status is distinct from new.status)
  execute function pending_charges_on_intent_status();

-- -----------------------------------------------------------------------------
-- F) RPC: estacionar un cobro
-- -----------------------------------------------------------------------------
create or replace function park_pending_charge(
  p_intent_id       uuid,
  p_sale            jsonb,
  p_cart            jsonb default '{}'::jsonb,
  p_lines           jsonb default '[]'::jsonb,
  p_cash_shift_id   uuid default null,
  p_channel         text default 'link',
  p_share_url       text default null,
  p_qr_data         text default null,
  p_customer_name   text default null,
  p_customer_email  text default null,
  p_customer_phone  text default null,
  p_expires_minutes integer default null,
  p_notes           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_i       record;
  v_shift   record;
  v_dry     jsonb;
  v_due     numeric;
  v_ttl     integer;
  v_id      uuid;
  v_expires timestamptz;
  v_cust    uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  perform assert_account_active(v_tenant);
  if not tenant_has_feature('cobros_en_espera') then
    raise exception 'feature_not_in_plan: cobros_en_espera';
  end if;
  perform _pc_assert_sale_args(p_sale);
  if p_channel not in ('qr', 'link') then raise exception 'invalid_channel'; end if;

  -- Turno: el que manda el POS (abierto, del negocio y de una sucursal permitida).
  if p_cash_shift_id is null then
    select r.o_shift_id into p_cash_shift_id from resolve_sale_shift(null, true) r;
  end if;
  select cs.id, cs.store_id, cs.cash_register_id, cs.status
    into v_shift
    from cash_shifts cs
   where cs.id = p_cash_shift_id and cs.tenant_id = v_tenant;
  if not found or v_shift.status <> 'open' then raise exception 'shift_not_open'; end if;
  if not user_can_access_store(v_shift.store_id) then raise exception 'store_not_allowed'; end if;

  -- Intent: del negocio, pendiente y no estacionado. El lock serializa con el
  -- webhook: si el cliente pagó justo antes, se avisa y el POS registra la venta.
  select id, status, amount, sale_id, provider_key
    into v_i
    from mp_payment_intents
   where id = p_intent_id and tenant_id = v_tenant
   for update;
  if not found then raise exception 'intent_not_found'; end if;
  if v_i.status = 'approved' or v_i.sale_id is not null then raise exception 'intent_already_paid'; end if;
  if v_i.status <> 'pending' then raise exception 'intent_not_pending'; end if;
  if exists (
    select 1 from pending_charges
     where intent_id = p_intent_id or p_intent_id = any (previous_intent_ids)
  ) then
    raise exception 'intent_already_parked';
  end if;

  -- Total autoritativo: create_sale en seco con el mismo carrito y turno.
  v_dry := _pc_dry_run(p_sale, v_shift.id);
  v_due := round(coalesce((v_dry ->> 'total')::numeric, 0) + coalesce((v_dry ->> 'tip')::numeric, 0), 2);
  if abs(v_due - v_i.amount) > 0.01 then
    raise exception 'amount_mismatch';
  end if;

  v_ttl := least(greatest(coalesce(p_expires_minutes, 1440), 5), pending_charge_max_ttl(v_i.provider_key));
  v_expires := now() + make_interval(mins => v_ttl);
  v_cust := nullif(p_sale ->> 'customer_id', '')::uuid;

  insert into pending_charges (
    tenant_id, store_id, register_id, cash_shift_id, origin_shift_id, created_by,
    customer_id, customer_name, customer_email, customer_phone,
    sale_args, cart, lines, amount, sale_total, provider_key, channel, intent_id,
    share_url, qr_data, expires_at, notes
  ) values (
    v_tenant, v_shift.store_id, v_shift.cash_register_id, v_shift.id, v_shift.id, auth.uid(),
    v_cust, nullif(btrim(coalesce(p_customer_name, '')), ''),
    nullif(lower(btrim(coalesce(p_customer_email, ''))), ''),
    nullif(btrim(coalesce(p_customer_phone, '')), ''),
    p_sale, coalesce(p_cart, '{}'::jsonb), coalesce(p_lines, '[]'::jsonb),
    v_i.amount, coalesce((v_dry ->> 'total')::numeric, 0), v_i.provider_key, p_channel, v_i.id,
    nullif(btrim(coalesce(p_share_url, '')), ''), nullif(p_qr_data, ''), v_expires,
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_id;

  perform _pc_event(v_tenant, v_id, 'created',
                    jsonb_build_object('amount', v_i.amount, 'provider', v_i.provider_key,
                                       'channel', p_channel, 'expires_at', v_expires));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'pending_charges', v_id, 'pending_charge_parked',
          jsonb_build_object('intent_id', v_i.id, 'amount', v_i.amount, 'provider', v_i.provider_key,
                             'store_id', v_shift.store_id, 'shift_id', v_shift.id,
                             'customer_id', v_cust, 'expires_at', v_expires));

  return jsonb_build_object('id', v_id, 'expires_at', v_expires, 'amount', v_i.amount,
                            'sale_total', (v_dry ->> 'total')::numeric);
end;
$$;
revoke all on function park_pending_charge(uuid, jsonb, jsonb, jsonb, uuid, text, text, text, text, text, text, integer, text) from public, anon;
grant execute on function park_pending_charge(uuid, jsonb, jsonb, jsonb, uuid, text, text, text, text, text, text, integer, text) to authenticated;

-- Carga un cobro del negocio con lock y valida el acceso a su sucursal.
create or replace function _pc_lock_for_user(p_id uuid, p_version integer)
returns pending_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c pending_charges%rowtype;
begin
  select * into v_c from pending_charges
   where id = p_id and tenant_id = current_tenant_id() and deleted_at is null
   for update;
  if not found then raise exception 'pending_charge_not_found'; end if;
  if not user_can_access_store(v_c.store_id) then raise exception 'store_not_allowed'; end if;
  if p_version is not null and p_version <> v_c.version then raise exception 'version_conflict'; end if;
  return v_c;
end;
$$;
revoke all on function _pc_lock_for_user(uuid, integer) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) RPC: completar (POS en sondeo, "Reintentar", "Registrar la venta igual")
-- -----------------------------------------------------------------------------
create or replace function complete_pending_charge(p_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c    pending_charges%rowtype;
  v_role text;
begin
  v_c := _pc_lock_for_user(p_id, null);
  if p_force then
    v_role := user_store_role(v_c.store_id);
    if v_role not in ('owner', 'manager') then raise exception 'forbidden'; end if;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_c.tenant_id, auth.uid(), 'pending_charges', v_c.id, 'pending_charge_force_complete',
            jsonb_build_object('last_error', v_c.last_error, 'needs_review', v_c.needs_review));
  end if;
  -- El que reintenta a mano registra la venta a su nombre; el sondeo, a nombre
  -- de quien la estacionó.
  return _pc_complete(p_id, case when p_force then auth.uid() else null end,
                      case when p_force then 'manual' else 'pos' end, p_force);
end;
$$;
revoke all on function complete_pending_charge(uuid, boolean) from public, anon;
grant execute on function complete_pending_charge(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: cancelar (invalida el link: el intent queda cancelado localmente; el
--    POS además lo da de baja en el proveedor donde la API lo permite).
-- -----------------------------------------------------------------------------
create or replace function cancel_pending_charge(
  p_id      uuid,
  p_reason  text default null,
  p_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c pending_charges%rowtype;
  v_i record;
begin
  v_c := _pc_lock_for_user(p_id, p_version);
  if v_c.status not in ('waiting', 'expired') then raise exception 'not_waiting'; end if;

  select id, status into v_i from mp_payment_intents where id = v_c.intent_id for update;
  if v_i.status = 'approved' then
    -- Ganó el pago: se registra la venta en vez de cancelar.
    perform _pc_complete(v_c.id, null, 'cancel_race', false);
    raise exception 'intent_already_paid';
  end if;

  update pending_charges
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = nullif(btrim(coalesce(p_reason, '')), ''), version = version + 1
   where id = v_c.id;
  update mp_payment_intents set status = 'cancelled', updated_at = now()
   where id = v_c.intent_id and status = 'pending';

  perform _pc_event(v_c.tenant_id, v_c.id, 'cancelled', jsonb_build_object('reason', p_reason));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_c.tenant_id, auth.uid(), 'pending_charges', v_c.id, 'pending_charge_cancelled',
          jsonb_build_object('status', v_c.status, 'amount', v_c.amount),
          jsonb_build_object('status', 'cancelled', 'intent_id', v_c.intent_id), p_reason);

  return jsonb_build_object('id', v_c.id, 'intent_id', v_c.intent_id,
                            'provider_key', v_c.provider_key, 'channel', v_c.channel);
end;
$$;
revoke all on function cancel_pending_charge(uuid, text, integer) from public, anon;
grant execute on function cancel_pending_charge(uuid, text, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- I) RPC: datos del cobro (cliente, contacto, nota) y extender el vencimiento.
--    p_patch: { customer_name?, customer_email?, customer_phone?, notes?,
--               extend_minutes? }
-- -----------------------------------------------------------------------------
create or replace function update_pending_charge(
  p_id      uuid,
  p_patch   jsonb,
  p_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c       pending_charges%rowtype;
  v_ext     integer;
  v_expires timestamptz;
  v_email   text;
begin
  v_c := _pc_lock_for_user(p_id, p_version);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'invalid_patch'; end if;
  if v_c.status in ('completed', 'cancelled') and p_patch ? 'extend_minutes' then
    raise exception 'not_waiting';
  end if;

  v_expires := v_c.expires_at;
  if p_patch ? 'extend_minutes' then
    if v_c.status <> 'waiting' then raise exception 'not_waiting'; end if;
    v_ext := (p_patch ->> 'extend_minutes')::integer;
    if v_ext is null or v_ext < 5 then raise exception 'invalid_ttl'; end if;
    -- El nuevo vencimiento cuenta desde ahora y respeta el tope del proveedor.
    v_expires := now() + make_interval(mins => least(v_ext, pending_charge_max_ttl(v_c.provider_key)));
  end if;

  v_email := case when p_patch ? 'customer_email'
                  then nullif(lower(btrim(coalesce(p_patch ->> 'customer_email', ''))), '')
                  else v_c.customer_email end;
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'invalid_email';
  end if;

  update pending_charges
     set customer_name  = case when p_patch ? 'customer_name'
                               then nullif(btrim(coalesce(p_patch ->> 'customer_name', '')), '')
                               else customer_name end,
         customer_email = v_email,
         customer_phone = case when p_patch ? 'customer_phone'
                               then nullif(btrim(coalesce(p_patch ->> 'customer_phone', '')), '')
                               else customer_phone end,
         notes          = case when p_patch ? 'notes'
                               then nullif(btrim(coalesce(p_patch ->> 'notes', '')), '')
                               else notes end,
         expires_at     = v_expires,
         version        = version + 1
   where id = v_c.id;

  perform _pc_event(v_c.tenant_id, v_c.id,
                    case when p_patch ? 'extend_minutes' then 'extended' else 'updated' end,
                    p_patch || jsonb_build_object('expires_at', v_expires));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_c.tenant_id, auth.uid(), 'pending_charges', v_c.id, 'pending_charge_updated',
          jsonb_build_object('expires_at', v_c.expires_at, 'customer_email', v_c.customer_email,
                             'customer_phone', v_c.customer_phone, 'notes', v_c.notes),
          p_patch || jsonb_build_object('expires_at', v_expires));

  return jsonb_build_object('id', v_c.id, 'expires_at', v_expires, 'version', v_c.version + 1);
end;
$$;
revoke all on function update_pending_charge(uuid, jsonb, integer) from public, anon;
grant execute on function update_pending_charge(uuid, jsonb, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- J) RPC: editar / regenerar el link. El POS crea el intent nuevo en el
--    proveedor y lo engancha acá. p_sale null = mismo carrito (regenerar).
--    El intent anterior queda cancelado localmente y en previous_intent_ids:
--    si igual se paga, el trigger lo marca para revisión.
-- -----------------------------------------------------------------------------
create or replace function replace_pending_charge_intent(
  p_id              uuid,
  p_new_intent_id   uuid,
  p_version         integer default null,
  p_sale            jsonb default null,
  p_cart            jsonb default null,
  p_lines           jsonb default null,
  p_channel         text default null,
  p_share_url       text default null,
  p_qr_data         text default null,
  p_expires_minutes integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c       pending_charges%rowtype;
  v_old     record;
  v_new     record;
  v_sale    jsonb;
  v_shift   uuid;
  v_dry     jsonb;
  v_total   numeric;
  v_due     numeric;
  v_ttl     integer;
  v_expires timestamptz;
begin
  if not tenant_has_feature('cobros_en_espera') then
    raise exception 'feature_not_in_plan: cobros_en_espera';
  end if;
  v_c := _pc_lock_for_user(p_id, p_version);
  if v_c.status not in ('waiting', 'expired') then raise exception 'not_waiting'; end if;

  select id, status into v_old from mp_payment_intents where id = v_c.intent_id for update;
  if v_old.status = 'approved' then
    perform _pc_complete(v_c.id, null, 'replace_race', false);
    raise exception 'intent_already_paid';
  end if;

  select id, status, amount, sale_id, provider_key into v_new
    from mp_payment_intents
   where id = p_new_intent_id and tenant_id = v_c.tenant_id
   for update;
  if not found then raise exception 'intent_not_found'; end if;
  if v_new.status <> 'pending' or v_new.sale_id is not null then raise exception 'intent_not_pending'; end if;
  if exists (
    select 1 from pending_charges
     where intent_id = p_new_intent_id or p_new_intent_id = any (previous_intent_ids)
  ) then
    raise exception 'intent_already_parked';
  end if;

  v_sale := coalesce(p_sale, v_c.sale_args);
  perform _pc_assert_sale_args(v_sale);

  if p_sale is null and abs(v_new.amount - v_c.amount) <= 0.01 then
    -- Mismo carrito y mismo monto: ya fue validado al estacionar.
    v_total := v_c.sale_total;
  else
    v_shift := _pc_target_shift(v_c);
    if v_shift is null then raise exception 'no_open_shift'; end if;
    v_dry := _pc_dry_run(v_sale, v_shift);
    v_total := coalesce((v_dry ->> 'total')::numeric, 0);
    v_due := round(v_total + coalesce((v_dry ->> 'tip')::numeric, 0), 2);
    if abs(v_due - v_new.amount) > 0.01 then raise exception 'amount_mismatch'; end if;
  end if;

  v_ttl := least(greatest(coalesce(p_expires_minutes, 1440), 5), pending_charge_max_ttl(v_new.provider_key));
  v_expires := now() + make_interval(mins => v_ttl);

  update mp_payment_intents set status = 'cancelled', updated_at = now()
   where id = v_c.intent_id and status = 'pending';

  update pending_charges
     set intent_id = v_new.id,
         previous_intent_ids = array_append(previous_intent_ids, v_c.intent_id),
         provider_key = v_new.provider_key,
         channel = coalesce(p_channel, channel),
         share_url = coalesce(nullif(btrim(coalesce(p_share_url, '')), ''), case when p_channel is null then share_url end),
         qr_data = coalesce(nullif(p_qr_data, ''), case when p_channel is null then qr_data end),
         sale_args = v_sale,
         cart = coalesce(p_cart, cart),
         lines = coalesce(p_lines, lines),
         customer_id = nullif(v_sale ->> 'customer_id', '')::uuid,
         amount = v_new.amount,
         sale_total = v_total,
         status = 'waiting',
         expires_at = v_expires,
         needs_review = false,
         last_error = null,
         version = version + 1
   where id = v_c.id;

  perform _pc_event(v_c.tenant_id, v_c.id,
                    case when p_sale is null then 'regenerated' else 'edited' end,
                    jsonb_build_object('old_intent_id', v_c.intent_id, 'new_intent_id', v_new.id,
                                       'old_amount', v_c.amount, 'new_amount', v_new.amount,
                                       'expires_at', v_expires));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_c.tenant_id, auth.uid(), 'pending_charges', v_c.id,
          case when p_sale is null then 'pending_charge_regenerated' else 'pending_charge_edited' end,
          jsonb_build_object('intent_id', v_c.intent_id, 'amount', v_c.amount, 'sale_args', v_c.sale_args),
          jsonb_build_object('intent_id', v_new.id, 'amount', v_new.amount, 'sale_args', v_sale));

  return jsonb_build_object('id', v_c.id, 'intent_id', v_new.id, 'amount', v_new.amount,
                            'expires_at', v_expires, 'version', v_c.version + 1,
                            'old_intent_id', v_c.intent_id, 'old_provider_key', v_c.provider_key,
                            'old_channel', v_c.channel);
end;
$$;
revoke all on function replace_pending_charge_intent(uuid, uuid, integer, jsonb, jsonb, jsonb, text, text, text, integer) from public, anon;
grant execute on function replace_pending_charge_intent(uuid, uuid, integer, jsonb, jsonb, jsonb, text, text, text, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- K) RPC: registro de "compartido por" y "visto" (aviso de pago).
-- -----------------------------------------------------------------------------
create or replace function mark_pending_charge_shared(
  p_id  uuid,
  p_via text,
  p_to  text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c pending_charges%rowtype;
begin
  if p_via not in ('whatsapp', 'email', 'sms', 'copy', 'native', 'qr') then
    raise exception 'invalid_channel';
  end if;
  v_c := _pc_lock_for_user(p_id, null);
  update pending_charges
     set shared_via = case when p_via = any (shared_via) then shared_via else array_append(shared_via, p_via) end,
         share_count = share_count + 1
   where id = v_c.id;
  perform _pc_event(v_c.tenant_id, v_c.id, 'shared',
                    jsonb_build_object('via', p_via, 'to', nullif(btrim(coalesce(p_to, '')), '')));
end;
$$;
revoke all on function mark_pending_charge_shared(uuid, text, text) from public, anon;
grant execute on function mark_pending_charge_shared(uuid, text, text) to authenticated;

create or replace function ack_pending_charge(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c pending_charges%rowtype;
begin
  v_c := _pc_lock_for_user(p_id, null);
  if v_c.acknowledged_at is not null then return; end if;
  update pending_charges set acknowledged_at = now(), acknowledged_by = auth.uid() where id = v_c.id;
  perform _pc_event(v_c.tenant_id, v_c.id, 'acknowledged', null);
end;
$$;
revoke all on function ack_pending_charge(uuid) from public, anon;
grant execute on function ack_pending_charge(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- L) Cierre de caja: decisión sobre los cobros abiertos del turno.
--    'cancel' cancela los que esperan (los pagados sin venta pasan igual: la
--    plata ya entró). 'carry' los pasa a la próxima apertura de esa caja.
-- -----------------------------------------------------------------------------
create or replace function _pc_on_close(p_shift_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant    uuid := current_tenant_id();
  v_store     uuid;
  v_c         pending_charges%rowtype;
  v_cancelled int := 0;
  v_carried   int := 0;
  v_amount    numeric := 0;
begin
  select store_id into v_store from cash_shifts
   where id = p_shift_id and tenant_id = v_tenant and status = 'open';
  if v_store is null then raise exception 'shift_not_open'; end if;
  if not user_can_access_store(v_store) then raise exception 'store_not_allowed'; end if;
  if p_action not in ('cancel', 'carry') then raise exception 'invalid_pending_action'; end if;

  for v_c in
    select * from pending_charges
     where tenant_id = v_tenant and cash_shift_id = p_shift_id
       and status in ('waiting', 'paid') and deleted_at is null
     for update
  loop
    v_amount := v_amount + v_c.amount;
    if p_action = 'cancel' and v_c.status = 'waiting' then
      update pending_charges
         set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
             cancel_reason = 'Cierre de caja', version = version + 1
       where id = v_c.id;
      update mp_payment_intents set status = 'cancelled', updated_at = now()
       where id = v_c.intent_id and status = 'pending';
      perform _pc_event(v_tenant, v_c.id, 'cancelled',
                        jsonb_build_object('reason', 'Cierre de caja', 'shift_id', p_shift_id));
      v_cancelled := v_cancelled + 1;
    else
      update pending_charges
         set cash_shift_id = null, carry_over = true, version = version + 1
       where id = v_c.id;
      perform _pc_event(v_tenant, v_c.id, 'carried_over', jsonb_build_object('shift_id', p_shift_id));
      v_carried := v_carried + 1;
    end if;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'cash_shifts', p_shift_id, 'pending_charges_on_close',
          jsonb_build_object('action', p_action, 'cancelled', v_cancelled,
                             'carried', v_carried, 'amount', v_amount));
  return jsonb_build_object('cancelled', v_cancelled, 'carried', v_carried, 'amount', v_amount);
end;
$$;
revoke all on function _pc_on_close(uuid, text) from public, anon;
-- close_cash_shift es SECURITY INVOKER: necesita poder llamarla. Valida
-- negocio, turno abierto y acceso a la sucursal.
grant execute on function _pc_on_close(uuid, text) to authenticated;

-- close_cash_shift: copia EXACTA de 20261011200200_cuenta_corriente_v2_reversas
-- + p_pending_action y el bloque "Cobros en espera". Se dropea la firma de 3
-- args (los callers viejos resuelven a esta por el default).
create or replace function close_cash_shift(
  p_shift_id       uuid,
  p_closing_amount numeric,
  p_notes          text default null,
  p_pending_action text default null
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
  v_account    jsonb;
  v_pending    integer;
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

  -- Cobros en espera (ADR-048): sin estados huérfanos. Con cobros abiertos en
  -- el turno hay que decidir: cancelarlos o pasarlos a la próxima apertura.
  select count(*) into v_pending
  from pending_charges
  where tenant_id = current_tenant_id() and cash_shift_id = p_shift_id
    and status in ('waiting', 'paid') and deleted_at is null;
  if v_pending > 0 then
    if p_pending_action is null then
      raise exception 'pending_charges_decision_required';
    end if;
    perform _pc_on_close(p_shift_id, p_pending_action);
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

  -- CC v2: cobros de cuenta corriente del turno por medio (los de efectivo ya
  -- están en cash_in y en el esperado; acá se informan todos).
  select coalesce(jsonb_object_agg(method, t), '{}'::jsonb)
    into v_account
  from (
    select m.method, round(sum(-m.delta), 2) as t
    from customer_account_movements m
    where m.cash_shift_id = p_shift_id and m.tenant_id = current_tenant_id()
      and m.kind = 'payment' and m.voided_at is null and m.method is not null
    group by m.method
  ) a;

  select coalesce(max(z_number), 0) + 1 into v_znum
  from cash_z_closures where tenant_id = current_tenant_id();

  insert into cash_z_closures (
    store_id, cash_shift_id, z_number, opened_at, closed_at, opened_by, closed_by,
    opening_amount, closing_amount, expected_amount, difference,
    sales_count, sales_total, discounts_total, voids_count, voids_total,
    cash_in, cash_out, payment_breakdown, account_collected
  ) values (
    v_store, p_shift_id, v_znum, v_opened_at, now(), v_opened_by, auth.uid(),
    v_opening, p_closing_amount, v_expected, v_diff,
    v_sales_count, v_sales_total, v_disc_total, v_voids_count, v_voids_total,
    v_cash_in, v_cash_out, v_breakdown, v_account
  )
  on conflict (cash_shift_id) do nothing;

  return v_diff;
end;
$$;

drop function if exists close_cash_shift(uuid, numeric, text);
revoke execute on function close_cash_shift(uuid, numeric, text, text) from public, anon;
grant  execute on function close_cash_shift(uuid, numeric, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- M) Apertura de caja: los cobros pasados a la próxima apertura se enganchan al
--    turno nuevo de su caja (o de su sucursal si la caja ya no existe) y los
--    pagados sin venta se registran en él. Nunca hace fallar la apertura.
-- -----------------------------------------------------------------------------
create or replace function pending_charges_on_shift_open()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c pending_charges%rowtype;
  v_n int := 0;
begin
  begin
    for v_c in
      select pc.* from pending_charges pc
       where pc.tenant_id = new.tenant_id and pc.store_id = new.store_id
         and pc.cash_shift_id is null and pc.status in ('waiting', 'paid') and pc.deleted_at is null
         and (pc.register_id = new.cash_register_id
              or pc.register_id is null
              or not exists (select 1 from cash_registers cr
                              where cr.id = pc.register_id and cr.is_active and cr.deleted_at is null))
       for update of pc
    loop
      update pending_charges
         set cash_shift_id = new.id, carry_over = false, version = version + 1
       where id = v_c.id;
      perform _pc_event(v_c.tenant_id, v_c.id, 'attached_to_shift', jsonb_build_object('shift_id', new.id), new.opened_by);
    end loop;

    for v_c in
      select * from pending_charges
       where tenant_id = new.tenant_id and store_id = new.store_id
         and status = 'paid' and not needs_review and deleted_at is null
       order by paid_at
       limit 20
    loop
      perform _pc_complete(v_c.id, null, 'shift_open', false);
      v_n := v_n + 1;
    end loop;
  exception when others then
    raise warning 'pending_charges_on_shift_open(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function pending_charges_on_shift_open() from public, anon, authenticated;

drop trigger if exists pending_charges_on_shift_open on cash_shifts;
create trigger pending_charges_on_shift_open
  after insert on cash_shifts
  for each row
  when (new.status = 'open')
  execute function pending_charges_on_shift_open();

-- -----------------------------------------------------------------------------
-- N) Mantenimiento (cron cada 2 min): vence los cobros pasados de hora y
--    reintenta los pagados sin venta.
-- -----------------------------------------------------------------------------
create or replace function pending_charges_tick()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c       pending_charges%rowtype;
  v_expired int := 0;
  v_retried int := 0;
begin
  for v_c in
    select * from pending_charges
     where status = 'waiting' and expires_at <= now() and deleted_at is null
     order by expires_at
     limit 200
     for update skip locked
  loop
    -- Si justo se pagó, gana el pago.
    if exists (select 1 from mp_payment_intents where id = v_c.intent_id and status = 'approved') then
      perform _pc_complete(v_c.id, null, 'cron', false);
      continue;
    end if;
    update pending_charges set status = 'expired', version = version + 1 where id = v_c.id;
    update mp_payment_intents set status = 'cancelled', updated_at = now()
     where id = v_c.intent_id and status = 'pending';
    perform _pc_event(v_c.tenant_id, v_c.id, 'expired', jsonb_build_object('reason', 'ttl'), null);
    v_expired := v_expired + 1;
  end loop;

  for v_c in
    select * from pending_charges
     where status = 'paid' and not needs_review and deleted_at is null
       and attempts < 30
       and (last_attempt_at is null or last_attempt_at < now() - interval '2 minutes')
     order by paid_at
     limit 50
     for update skip locked
  loop
    perform _pc_complete(v_c.id, null, 'cron', false);
    v_retried := v_retried + 1;
  end loop;

  return jsonb_build_object('expired', v_expired, 'retried', v_retried);
end;
$$;
revoke all on function pending_charges_tick() from public, anon, authenticated;
grant execute on function pending_charges_tick() to service_role;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'pending-charges-tick') then
      perform cron.unschedule('pending-charges-tick');
    end if;
    perform cron.schedule('pending-charges-tick', '*/2 * * * *', 'select public.pending_charges_tick();');
  else
    raise notice 'pg_cron no disponible; se omite el job de cobros en espera.';
  end if;
end;
$cron$;

-- Sincronización con los proveedores sin webhook (Pagos360) y red de
-- seguridad para webhooks perdidos: POST a la Edge pending_charges_sync cada
-- 2 min (mismo patrón que account_reminders: X-Cron-Secret de
-- platform_secrets 'internal_cron', leído en cada corrida).
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/pending_charges_sync';
  v_cmd text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el job de sincronización de cobros.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el job de sincronización de cobros.';
    return;
  end if;

  v_cmd := format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := '{"mode":"cron"}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$, v_url);

  if exists (select 1 from cron.job where jobname = 'pending-charges-sync') then
    perform cron.unschedule('pending-charges-sync');
  end if;
  perform cron.schedule('pending-charges-sync', '1-59/2 * * * *', v_cmd);
end;
$cron$;
