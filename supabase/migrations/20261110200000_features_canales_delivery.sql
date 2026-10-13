-- =============================================================================
-- 20261110200000_features_canales_delivery  (F13 · H49 integraciones, ADR-102)
--
-- Feature de plan nueva (convención CLAUDE.md §6):
--   • canales_delivery (OPTIONAL, grupo integraciones): los pedidos de las apps
--     de delivery (PedidosYa, Rappi, Uber Eats, Mercado Pago Delivery) entran
--     solos, crean la comanda en el KDS, se facturan con la cola fiscal y se
--     sigue al repartidor. Incluye el simulador para probar de punta a punta.
--     Pro, Business y Enterprise (mismo nivel que facturacion_afip: lo usa un
--     local gastronómico que ya factura y opera delivery). Los planes a medida
--     heredan el valor de facturacion_afip.
--
-- El gating real vive en 20261110200200 (RPCs de conexión, ingesta de pedidos,
-- facturación y medio de pago 'plataforma' por payment_method_plan_key) y en
-- las Edge delivery_channel_webhook / delivery_channel_worker. La UI es cortesía.
-- Idempotente: sólo escribe la key en los planes que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('canales_delivery', 'Canales de delivery (apps)',
   'Pedidos de PedidosYa, Rappi, Uber Eats y Mercado Pago Delivery que entran solos, comanda automática en cocina, facturación y seguimiento del repartidor',
   'integraciones', false, 215)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = false;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('canales_delivery', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'canales_delivery');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'canales_delivery',
         coalesce((p.limits -> 'modules' ->> 'facturacion_afip')::boolean, false)
       ),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'canales_delivery');
