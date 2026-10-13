-- =============================================================================
-- 20261110400000_features_mercadolibre  (H87 · ADR-104 · Mercado Libre MVP)
--
-- Feature `mercadolibre`: OPTIONAL desde Pro (convención CLAUDE.md §6).
--   1. Key en `features` (grupo integraciones, is_basic = false).
--   2. Marca por plan: Pro, Business y Enterprise sí; Start no. Lo ya
--      declarado en un plan gana (sólo se completa si falta).
--   3. Gating real server-side: ml_oauth_start, ml_api y ml_worker
--      (ml_edge_guard / ml_account_assert), las RPC ml_* (ml_assert) y el
--      cobro con medio 'mercadolibre' (payment_method_plan_key ->
--      assert_payment_method_allowed en el trigger BEFORE INSERT de payments).
--   4. Copy en lib/saas/featureInfo.ts; 5. comparación derivada de la matriz.
--
-- Medio de cobro 'mercadolibre': lo registra SOLO la ingesta de órdenes
-- (ml_ingest_pack). No mueve caja (no hay cash_movements): la plata la cobra
-- Mercado Libre y la liquida por Mercado Pago.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('mercadolibre', 'Mercado Libre',
   'Cuentas de Mercado Libre conectadas: publicaciones vinculadas a tus productos, stock y precio sincronizados, ventas que entran al POS con su comisión, facturación ARCA subida a la venta, etiquetas de envío y preguntas',
   'integraciones', false, 230)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('mercadolibre', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'mercadolibre');

-- Medio de cobro del canal (sin caja).
alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash','debit','credit','transfer','qr','other','store_credit','account','directo','sena',
                    'plataforma', 'mercadolibre'));

-- Copia de la definición más nueva (20261110200100_canales_delivery_modelo, que
-- suma 'plataforma') con 'mercadolibre' -> feature 'mercadolibre'.
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
    when 'plataforma'        then 'canales_delivery'
    when 'mercadolibre'      then 'mercadolibre'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;
