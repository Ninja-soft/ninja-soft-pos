-- =============================================================================
-- 20270118100000_dlocal_cupones  (F8 · ADR-180)
--
-- Dos medios nuevos para cobrar a distancia:
--
--  1) dLocal Go (provider/feature `dlocalgo`, marca dlocalgo, canal qr_link):
--     link de pago con el checkout hosted de dLocal Go (Payments API,
--     docs.dlocalgo.com). El POS crea el pago (Edge `dlocalgo`), muestra el
--     redirect_url como QR y link, y la venta se cierra sola cuando el pago
--     RE-CONSULTADO a dLocal Go está PAID con el monto exacto en ARS y el
--     order_id del intent (Edge `dlocalgo_webhook`, notificación firmada con
--     HMAC-SHA256 + poll del POS + cron de cobros en espera). El cobro entra
--     como method='qr' con reference = intent (mp_payment_intents.provider_key
--     = 'dlocalgo'). Devoluciones totales por la API: tabla dlocalgo_refunds.
--
--  2) Cupones de pago en efectivo (feature `cupones_efectivo`): Rapipago o Pago
--     Fácil por la Orders API de Mercado Pago (type online, payment_method
--     ticket) con la conexión de Mercado Pago que el negocio ya tiene (Edge
--     `mp_cupon`). El intent usa provider_key = 'mp_cupon' y mp_order_id, así
--     que el webhook topic order de siempre (mp_orders_webhook) lo acredita
--     con la misma regla (order processed + monto exacto + external_reference).
--     Pensado para cobros a distancia y cobros en espera, no para el mostrador.
--     mp_payment_intents.voucher guarda los datos del cupón (código de barras,
--     referencia, vencimiento) para volver a mostrarlo y compartirlo.
--
-- Plan: las dos OPTIONAL desde Pro (pro, business, enterprise), como el resto
-- de los links de pago y billeteras integradas.
-- =============================================================================

-- A) Catálogo de proveedores ---------------------------------------------------
insert into payment_providers (key, name, kind, sort, is_active, brand, channel) values
  ('dlocalgo', 'dLocal Go', 'gateway', 16, true, 'dlocalgo', 'qr_link')
on conflict (key) do update
  set name = excluded.name,
      kind = excluded.kind,
      brand = excluded.brand,
      channel = excluded.channel;

-- B) Features de plan ----------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('dlocalgo', 'dLocal Go',
   'Cobros con dLocal Go: link de pago y QR con su checkout, la venta se cierra sola al acreditarse',
   'pagos', false, 128),
  ('cupones_efectivo', 'Cupones Rapipago y Pago Fácil',
   'Cupón de pago en efectivo de Mercado Pago para cobrar a distancia: el cliente paga en Rapipago o Pago Fácil y la venta se registra sola',
   'pagos', false, 129)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('dlocalgo', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'dlocalgo');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('cupones_efectivo', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'cupones_efectivo');

-- C) Gating: medio → feature de plan. Copia de la definición más nueva
-- (20270113100000_talo) + 'dlocalgo' y 'mp_cupon'.
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
    when 'fiserv_point'      then 'fiserv_point'
    when 'pagos360'          then 'pagos360'
    when 'nave'              then 'nave'
    when 'nave_point'        then 'nave_point'
    when 'gocuotas'          then 'gocuotas'
    when 'directo'           then 'directo'
    when 'ualabis'           then 'ualabis'
    when 'viumi'             then 'viumi'
    when 'talo'              then 'talo'
    when 'account'           then 'cuenta_corriente'
    when 'cuenta_corriente'  then 'cuenta_corriente'
    when 'plataforma'        then 'canales_delivery'
    when 'mercadolibre'      then 'mercadolibre'
    when 'cheque'            then 'tesoreria'
    when 'echeq'             then 'tesoreria'
    when 'cash_usd'          then 'efectivo_usd'
    when 'dlocalgo'          then 'dlocalgo'
    when 'mp_cupon'          then 'cupones_efectivo'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;

-- D) Cobros en espera (ADR-048): tope de vencimiento. dLocal Go: el
-- redirect_url vence a las 24 h (doc de Retrieve a payment). Cupón: se emite
-- con vencimiento P3D (lo que recomienda Mercado Pago), tope 3 días. Copia de
-- 20270113100000_talo + 'dlocalgo' y 'mp_cupon'. Espejo de
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
    when 'ualabis'     then 1440
    when 'viumi'       then 1440
    when 'talo'        then 4320
    when 'dlocalgo'    then 1440
    when 'mp_cupon'    then 4320
    else 1440
  end;
$$;
grant execute on function pending_charge_max_ttl(text) to authenticated, service_role;

-- E) Datos del cupón de pago en efectivo -------------------------------------
alter table mp_payment_intents add column if not exists voucher jsonb
  check (voucher is null or jsonb_typeof(voucher) = 'object');
comment on column mp_payment_intents.voucher is
  'ADR-180: cupón Rapipago / Pago Fácil (payment_method, barcode_content, reference, verification_code, ticket_url, expires_at). Escribe service_role.';

-- F) Devoluciones de dLocal Go -------------------------------------------------
create table if not exists dlocalgo_refunds (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  intent_id     uuid not null references mp_payment_intents(id) on delete cascade,
  payment_id    text not null check (char_length(payment_id) between 3 and 64),
  amount        numeric(12,2) not null check (amount > 0),
  -- requested: pedido en curso · initiated: dLocal Go lo aceptó (PENDING) ·
  -- refunded: SUCCESS · failed: REJECTED, CANCELLED o error (se puede volver a pedir).
  status        text not null default 'requested'
                  check (status in ('requested', 'initiated', 'refunded', 'failed')),
  -- Id de la devolución en dLocal Go (REF-...) para re-consultarla.
  refund_ref    text check (refund_ref is null or char_length(refund_ref) <= 64),
  error_code    text check (error_code is null or char_length(error_code) <= 80),
  requested_by  uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table dlocalgo_refunds is
  'ADR-180: devoluciones totales de cobros de dLocal Go por la API. Escribe service_role (Edge dlocalgo y dlocalgo_webhook).';

-- Una devolución viva o hecha por cobro: un reintento no manda otra.
create unique index if not exists dlocalgo_refunds_live_uniq
  on dlocalgo_refunds (intent_id) where status in ('requested', 'initiated', 'refunded');
create index if not exists dlocalgo_refunds_intent_idx on dlocalgo_refunds (intent_id);
create index if not exists dlocalgo_refunds_tenant_created_idx on dlocalgo_refunds (tenant_id, created_at desc);
create index if not exists dlocalgo_refunds_requested_by_idx on dlocalgo_refunds (requested_by) where requested_by is not null;

drop trigger if exists set_updated_at_dlocalgo_refunds on dlocalgo_refunds;
create trigger set_updated_at_dlocalgo_refunds
  before update on dlocalgo_refunds
  for each row execute function set_updated_at();

alter table dlocalgo_refunds enable row level security;
revoke all on dlocalgo_refunds from anon, authenticated;
grant select on dlocalgo_refunds to authenticated;
drop policy if exists dlocalgo_refunds_select on dlocalgo_refunds;
create policy dlocalgo_refunds_select on dlocalgo_refunds
  for select using (tenant_id = (select current_tenant_id()));
