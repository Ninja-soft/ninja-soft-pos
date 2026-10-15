-- =============================================================================
-- 20261210100000_ualabis  (F8 · ADR-143 Ualá Bis)
--
-- Ualá Bis (provider/feature `ualabis`, marca ualabis, canal qr_link). Dos
-- caminos, los dos con la misma feature de plan:
--
--   * Link de pago + QR por la API Cobros Online v2 (Edge `ualabis` +
--     `ualabis_webhook`): el POS crea la orden, muestra el checkout de Ualá como
--     QR y link y la venta se cierra sola al acreditarse. El cobro entra como
--     method='qr' con reference = intent (mp_payment_intents.provider_key =
--     'ualabis'), así que el gating fino del trigger de payments lo cubre vía
--     payment_method_plan_key('ualabis').
--
--   * Registro manual con número de operación (QR de Ualá, POS Mini / POS Pro y
--     Tap en tu celu NO tienen API pública): payments.method = 'ualabis' y
--     número de operación obligatorio (payments.reference), como Directo
--     (ADR-034). El gating coarse del trigger lo corta por plan. A diferencia de
--     Directo, el registro manual se ofrece SIEMPRE que el medio esté
--     habilitado (también con la API conectada): cubre productos que la API no.
--
-- Devoluciones: tabla ualabis_refunds (una devolución viva por cobro; la API
-- sólo devuelve el total de órdenes APPROVED dentro de los 90 días). Escribe
-- sólo service_role (Edge `ualabis` action refund y `ualabis_webhook`); el
-- negocio la lee por RLS.
--
-- Plan: OPTIONAL desde Pro (pro, business, enterprise), como el resto de los
-- links y billeteras de uso masivo (gocuotas, directo, nave, getnet).
-- =============================================================================

-- A) Catálogo de proveedores ---------------------------------------------------
insert into payment_providers (key, name, kind, sort, is_active, brand, channel) values
  ('ualabis', 'Ualá Bis', 'gateway', 13, true, 'ualabis', 'qr_link')
on conflict (key) do update
  set name = excluded.name,
      kind = excluded.kind,
      brand = excluded.brand,
      channel = excluded.channel;

-- B) Feature de plan -----------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('ualabis', 'Ualá Bis',
   'Cobros con Ualá Bis: link de pago y QR por API (la venta se cierra sola) o registro del número de operación del QR, el POS o Tap en tu celu de Ualá Bis',
   'pagos', false, 125)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('ualabis', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'ualabis');

-- C) payments.method: 'ualabis' + número de operación obligatorio --------------
-- Copia de la lista más nueva (20261110400000_features_mercadolibre) + 'ualabis'.
alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash','debit','credit','transfer','qr','other','store_credit','account','directo','sena',
                    'plataforma', 'mercadolibre', 'ualabis'));

alter table payments drop constraint if exists payments_ualabis_reference_check;
alter table payments add constraint payments_ualabis_reference_check
  check (method <> 'ualabis' or length(btrim(coalesce(reference, ''))) between 1 and 64);

-- Comisiones estimadas (ADR-099): una regla por el medio manual de Ualá Bis.
alter table payment_fee_rules drop constraint if exists payment_fee_rules_method_check;
alter table payment_fee_rules add constraint payment_fee_rules_method_check
  check (method in ('debit', 'credit', 'qr', 'transfer', 'other', 'directo', 'ualabis'));

-- D) Gating: medio → feature de plan. Copia de la definición más nueva
-- (20261110400000_features_mercadolibre) con 'ualabis' -> feature 'ualabis'.
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
    when 'account'           then 'cuenta_corriente'
    when 'cuenta_corriente'  then 'cuenta_corriente'
    when 'plataforma'        then 'canales_delivery'
    when 'mercadolibre'      then 'mercadolibre'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;

-- E) Cobros en espera (ADR-048): tope de vencimiento del link de Ualá Bis.
-- Copia de 20261014100000_cobros_en_espera + 'ualabis'. Espejo de
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
    else 1440
  end;
$$;
grant execute on function pending_charge_max_ttl(text) to authenticated, service_role;

-- F) Devoluciones de Ualá Bis ---------------------------------------------------
create table if not exists ualabis_refunds (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  intent_id     uuid not null references mp_payment_intents(id) on delete cascade,
  order_uuid    text not null check (char_length(order_uuid) between 8 and 64),
  amount        numeric(12,2) not null check (amount > 0),
  -- requested: pedido en curso · initiated: Ualá lo aceptó (INITIATED) ·
  -- refunded: confirmado (orden REFUNDED) · not_refunded: Ualá no lo hizo ·
  -- failed: rechazo o error al pedirlo (se puede volver a pedir).
  status        text not null default 'requested'
                  check (status in ('requested', 'initiated', 'refunded', 'not_refunded', 'failed')),
  error_code    text check (error_code is null or char_length(error_code) <= 80),
  requested_by  uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table ualabis_refunds is
  'ADR-143: devoluciones totales de cobros de Ualá Bis por la API. Escribe service_role (Edge ualabis y ualabis_webhook).';

-- Una devolución viva por cobro: un reintento no manda otra.
create unique index if not exists ualabis_refunds_live_uniq
  on ualabis_refunds (intent_id) where status in ('requested', 'initiated', 'refunded');
create index if not exists ualabis_refunds_intent_idx on ualabis_refunds (intent_id);
create index if not exists ualabis_refunds_tenant_created_idx on ualabis_refunds (tenant_id, created_at desc);
create index if not exists ualabis_refunds_requested_by_idx on ualabis_refunds (requested_by) where requested_by is not null;

drop trigger if exists set_updated_at_ualabis_refunds on ualabis_refunds;
create trigger set_updated_at_ualabis_refunds
  before update on ualabis_refunds
  for each row execute function set_updated_at();

alter table ualabis_refunds enable row level security;
revoke all on ualabis_refunds from anon, authenticated;
grant select on ualabis_refunds to authenticated;
drop policy if exists ualabis_refunds_select on ualabis_refunds;
create policy ualabis_refunds_select on ualabis_refunds
  for select using (tenant_id = (select current_tenant_id()));
