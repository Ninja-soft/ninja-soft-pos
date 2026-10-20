-- =============================================================================
-- 20270113100000_talo  (F8 · ADR-175 Talo)
--
-- Talo (provider/feature `talo`, marca talo, canal qr_link): cobro por
-- transferencia bancaria con un CVU y alias únicos por pago (Payments API de
-- Talo, docs.talo.com.ar). El POS crea el pago (Edge `talo`), muestra el CVU,
-- el alias y el link de Talo como QR, y la venta se cierra sola cuando el pago
-- RE-CONSULTADO a Talo está SUCCESS u OVERPAID con el precio del intent
-- (Edge `talo_webhook` + poll del POS + cron de cobros en espera). El cobro
-- entra como method='qr' con reference = intent (mp_payment_intents.provider_key
-- = 'talo'), así que el gating fino del trigger de payments lo cubre vía
-- payment_method_plan_key('talo'). No hay registro manual: sin API conectada,
-- la transferencia común sigue siendo el medio 'transfer'.
--
-- mp_payment_intents.paid_amount: lo recibido según el proveedor (Talo:
-- transaction_fields.total_paid). Sirve para mostrar el faltante de un pago
-- UNDERPAID y la diferencia de un OVERPAID (a devolver). Lo escribe sólo
-- service_role; el negocio lo lee con la RLS de siempre del intent.
--
-- Devoluciones: tabla talo_refunds (una devolución en curso por cobro). 'full'
-- = todo lo cobrado (sin venta vigente); 'excess' = la diferencia de un
-- OVERPAID. Escribe sólo service_role (Edge `talo` y la sincronización); el
-- negocio la lee por RLS.
--
-- Plan: OPTIONAL desde Pro (pro, business, enterprise), como el resto de los
-- links y billeteras integradas (ualabis, directo, gocuotas, nave, getnet).
-- =============================================================================

-- A) Catálogo de proveedores ---------------------------------------------------
insert into payment_providers (key, name, kind, sort, is_active, brand, channel) values
  ('talo', 'Talo', 'gateway', 15, true, 'talo', 'qr_link')
on conflict (key) do update
  set name = excluded.name,
      kind = excluded.kind,
      brand = excluded.brand,
      channel = excluded.channel;

-- B) Feature de plan -----------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('talo', 'Talo (transferencia)',
   'Cobros por transferencia con Talo: CVU y alias únicos por venta, y la venta se cierra sola cuando llega la plata',
   'pagos', false, 127)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('talo', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'talo');

-- C) Gating: medio → feature de plan. Copia de la definición más nueva
-- (20270111100000_viumi) con 'talo' -> feature 'talo'.
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
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;

-- D) Cobros en espera (ADR-048): tope de vencimiento del cobro de Talo. El CVU
-- vence a los ~5 días; se topea en 3 días (4320 min) como Mobbex y Payway.
-- Copia de 20270111100000_viumi + 'talo'. Espejo de
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
    else 1440
  end;
$$;
grant execute on function pending_charge_max_ttl(text) to authenticated, service_role;

-- E) Lo recibido por el proveedor ---------------------------------------------
alter table mp_payment_intents add column if not exists paid_amount numeric(12,2)
  check (paid_amount is null or paid_amount >= 0);
comment on column mp_payment_intents.paid_amount is
  'ADR-175: monto recibido según el proveedor (Talo: total_paid). null = no informado. Escribe service_role.';

-- F) Devoluciones de Talo ------------------------------------------------------
create table if not exists talo_refunds (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  intent_id     uuid not null references mp_payment_intents(id) on delete cascade,
  payment_id    text not null check (char_length(payment_id) between 6 and 200),
  -- full: todo lo cobrado · excess: la diferencia de un OVERPAID.
  kind          text not null default 'full' check (kind in ('full', 'excess')),
  refund_type   text not null check (refund_type in ('FULL', 'PARTIAL')),
  amount        numeric(12,2) not null check (amount > 0),
  -- requested: pedido en curso · initiated: Talo lo aceptó (PENDING) ·
  -- refunded: SUCCESS · failed: FAILED, rechazo o error (se puede volver a pedir).
  status        text not null default 'requested'
                  check (status in ('requested', 'initiated', 'refunded', 'failed')),
  -- Referencia de la devolución en refunds[] del pago (transaction_ids[0] o
  -- creation_timestamp) para seguir su estado.
  refund_ref    text check (refund_ref is null or char_length(refund_ref) <= 120),
  error_code    text check (error_code is null or char_length(error_code) <= 80),
  requested_by  uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table talo_refunds is
  'ADR-175: devoluciones de cobros de Talo por la API (total o diferencia de un OVERPAID). Escribe service_role (Edge talo y la sincronización).';

-- Una devolución en curso por cobro: un reintento no manda otra.
create unique index if not exists talo_refunds_live_uniq
  on talo_refunds (intent_id) where status in ('requested', 'initiated');
-- Una devolución hecha por tipo: no se devuelve dos veces lo mismo.
create unique index if not exists talo_refunds_done_uniq
  on talo_refunds (intent_id, kind) where status = 'refunded';
create index if not exists talo_refunds_intent_idx on talo_refunds (intent_id);
create index if not exists talo_refunds_tenant_created_idx on talo_refunds (tenant_id, created_at desc);
create index if not exists talo_refunds_requested_by_idx on talo_refunds (requested_by) where requested_by is not null;

drop trigger if exists set_updated_at_talo_refunds on talo_refunds;
create trigger set_updated_at_talo_refunds
  before update on talo_refunds
  for each row execute function set_updated_at();

alter table talo_refunds enable row level security;
revoke all on talo_refunds from anon, authenticated;
grant select on talo_refunds to authenticated;
drop policy if exists talo_refunds_select on talo_refunds;
create policy talo_refunds_select on talo_refunds
  for select using (tenant_id = (select current_tenant_id()));
