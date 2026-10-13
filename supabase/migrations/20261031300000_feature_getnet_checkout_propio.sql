-- =============================================================================
-- 20261031300000_feature_getnet_checkout_propio  (ADR-069)
--
-- Feature de plan nueva (convención CLAUDE.md §6):
--
--   `getnet_checkout_propio` · OPTIONAL, grupo pagos, desde Pro.
--   Qué habilita: el checkout PROPIO de NinjaPos (/pagar/{intent}?p=getnet)
--   con la Checkout API de Getnet: marca del negocio, tarjeta y cuotas de los
--   Planes con su interés, igual que Payway. Requiere las credenciales
--   "Checkout API / Plugin VTEX" (slot checkout_api de la conexión Getnet).
--   Gating real (la UI nunca es la única barrera):
--     * Edge `getnet` action create mode 'own' exige
--       tenant_has_feature_for(tenant, 'getnet') y
--       tenant_has_feature_for(tenant, 'getnet_checkout_propio').
--     * Edge `getnet_checkout` action pay exige las dos antes de cobrar.
--     * El pago de la venta sigue pasando por el trigger de `payments`
--       (payment_method_plan_key('getnet')).
--   Análisis comercial: va con el cobro con Getnet (Pro en adelante), igual
--   que el checkout propio de Payway viene con `payway`. Los planes a medida
--   heredan el valor de `getnet`.
--
-- Sin cambios de esquema: el intent del checkout propio es un
-- mp_payment_intents de provider_key 'getnet' cuyo init_point es /pagar/.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('getnet_checkout_propio', 'Checkout propio con Getnet',
   'Link y QR a tu página de pago con tu marca: el cliente elige tarjeta y cuotas y Getnet procesa el cobro (credenciales Checkout API)',
   'pagos', false, 71)
on conflict (key) do nothing;

-- Planes globales: Pro, Business y Enterprise.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('getnet_checkout_propio', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'getnet_checkout_propio');

-- Planes a medida (por tenant): heredan `getnet`.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('getnet_checkout_propio', coalesce((p.limits -> 'modules' ->> 'getnet')::boolean, false)),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'getnet_checkout_propio');
