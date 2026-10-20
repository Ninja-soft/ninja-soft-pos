-- =============================================================================
-- 20270111100000_viumi  (F8 · ADR-173 Viumi)
--
-- Viumi (Banco Macro, plataforma Geopagos; provider/feature `viumi`, marca
-- viumi, canal qr_link). Link de pago + QR por la Checkout API v2 (Edge `viumi`
-- + `viumi_webhook`): el POS crea la orden, muestra el checkout de Viumi como
-- QR y link y la venta se cierra sola al acreditarse. El cobro entra como
-- method='qr' con reference = intent (mp_payment_intents.provider_key =
-- 'viumi'), así que el gating fino del trigger de payments lo cubre vía
-- payment_method_plan_key('viumi').
--
-- Sin registro manual (no hay payments.method 'viumi') y sin tabla de
-- devoluciones: la API de Viumi no documenta devoluciones, se hacen desde la
-- app o el panel de Viumi.
--
-- Plan: OPTIONAL desde Pro (pro, business, enterprise), como el resto de los
-- links de pago (gocuotas, directo, nave, getnet, ualabis).
-- =============================================================================

-- A) Catálogo de proveedores ---------------------------------------------------
insert into payment_providers (key, name, kind, sort, is_active, brand, channel) values
  ('viumi', 'Viumi', 'gateway', 14, true, 'viumi', 'qr_link')
on conflict (key) do update
  set name = excluded.name,
      kind = excluded.kind,
      brand = excluded.brand,
      channel = excluded.channel;

-- B) Feature de plan -----------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('viumi', 'Viumi',
   'Cobros con Viumi (Banco Macro): link de pago y QR por API, la venta se cierra sola al acreditarse',
   'pagos', false, 126)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('viumi', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'viumi');

-- C) Gating: medio → feature de plan. Copia de la definición más nueva
-- (20261210100000_ualabis) con 'viumi' -> feature 'viumi'.
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
    when 'account'           then 'cuenta_corriente'
    when 'cuenta_corriente'  then 'cuenta_corriente'
    when 'plataforma'        then 'canales_delivery'
    when 'mercadolibre'      then 'mercadolibre'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;

-- D) Cobros en espera (ADR-048): tope de vencimiento del link de Viumi (la
-- orden se crea con expireLimitMinutes 1440). Copia de 20261210100000_ualabis
-- + 'viumi'. Espejo de modules/pending-charges/logic.ts (PROVIDER_MAX_TTL_MINUTES).
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
    else 1440
  end;
$$;
grant execute on function pending_charge_max_ttl(text) to authenticated, service_role;
