-- =============================================================================
-- 20261013300000_fiserv_clover_point  (F8 · ADR-047 Clover Point de Fiserv)
--
-- Fiserv (marca `fiserv`) queda con dos canales:
--   * `fiserv` (canal manual): Posnet o Clover SIN integrar. Habilitarlo suma
--     la "Tarjeta en posnet" del POS (se cobra en la terminal y se carga el
--     cupón). Además es la fila que guarda la CONEXIÓN de la marca
--     (payment_secrets provider 'fiserv': merchant_id + token de Clover;
--     ambiente por tenant_payment_methods.sandbox). Antes figuraba como canal
--     'point' sin flujo: pasa a 'manual', que es lo que hace hoy.
--   * `fiserv_point` (canal point, NUEVO): terminal Clover integrada por Cloud
--     Pay Display (Edge `clover_point` + `clover_webhook`). El monto viaja a la
--     terminal y la venta se registra sola como débito/crédito al aprobarse.
--
-- Plan: OPTIONAL desde Business. Depende de la feature `fiserv` (requires en
-- lib/saas/featureInfo.ts), que es Business+: la terminal integrada va en los
-- mismos planes que su marca. La Edge exige las DOS features
-- (tenant_has_feature_for 'fiserv_point' y 'fiserv') y la conexión Fiserv.
--
-- Gating real: payment_method_plan_key('fiserv_point') = 'fiserv_point', así
-- el trigger de tenant_payment_methods corta habilitarla sin plan.
-- =============================================================================

-- A) Catálogo ------------------------------------------------------------------
update payment_providers
set channel = 'manual',
    name = 'Fiserv Posnet / Clover'
where key = 'fiserv';

insert into payment_providers (key, name, kind, sort, is_active, brand, channel) values
  ('fiserv_point', 'Clover Point', 'gateway', 8, true, 'fiserv', 'point')
on conflict (key) do update
  set name = excluded.name,
      kind = excluded.kind,
      brand = excluded.brand,
      channel = excluded.channel;

-- B) Feature de plan -------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('fiserv_point', 'Clover Point (Fiserv)', 'Cobros con la terminal Clover integrada al POS (Cloud Pay Display)', 'pagos', false, 85)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('fiserv_point', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise');

-- C) Gating: medio → feature de plan. Redefine la ÚLTIMA versión
-- (20261011200000_cuenta_corriente_v2, que conserva account → cuenta_corriente)
-- agregando sólo la línea de fiserv_point.
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
    when 'account'           then 'cuenta_corriente'
    when 'cuenta_corriente'  then 'cuenta_corriente'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;
