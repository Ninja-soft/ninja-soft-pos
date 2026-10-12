-- =============================================================================
-- 20261011170000_mp_orders_api  (F8 · H15 · ADR-032)
-- Mercado Pago presencial sobre la Orders API unificada:
--   * QR dinámico (POST /v1/orders type "qr") atado a la caja del tenant.
--   * Point (POST /v1/orders type "point"), reemplaza la Payment Intents API.
--
-- Cambios de esquema (aditivos, compatibles con los intents viejos):
--   * mp_payment_intents.mp_order_id: id de la order (ORD...). NULL en los
--     intents legacy (Checkout Pro y Point Payment Intents API), que siguen
--     resolviéndose por su camino viejo.
--   * mp_payment_intents.mp_env: ambiente de la credencial con que se creó el
--     intent ('prod' | 'test'); status / cancel / webhooks usan ese mismo
--     token aunque el dueño cambie el switch en el medio.
--   * Índice por mp_order_id: el webhook topic `order` llega sólo con el id
--     de la order y busca el intent por ahí.
--
-- Switch Sandbox de Mercado Pago: tenant_payment_methods.sandbox nació con
-- default true y para MP nunca tuvo efecto (siempre producción). Desde ADR-032
-- sí lo tiene (token de prueba), así que se normaliza a false en las filas MP
-- existentes para que nadie quede "en prueba" sin haberlo elegido. Las Edge
-- igual sólo pasan a prueba si además hay token de prueba cargado.
--
-- Sin cambios de gating: mercadopago → mercado_pago y mercadopago_point →
-- mercadopago_point ya están en payment_method_plan_key (20261011150000).
-- =============================================================================

alter table mp_payment_intents add column if not exists mp_order_id text;
alter table mp_payment_intents add column if not exists mp_env text not null default 'prod';

alter table mp_payment_intents drop constraint if exists mp_payment_intents_mp_env_check;
alter table mp_payment_intents
  add constraint mp_payment_intents_mp_env_check check (mp_env in ('prod', 'test'));

create unique index if not exists mp_payment_intents_mp_order_id_idx
  on mp_payment_intents (mp_order_id)
  where mp_order_id is not null;

comment on column mp_payment_intents.mp_order_id is
  'Id de la order de la Orders API de Mercado Pago (QR dinámico / Point). NULL en intents legacy.';
comment on column mp_payment_intents.mp_env is
  'Ambiente de la credencial MP con que se creó el intent: prod | test (ADR-032).';

update tenant_payment_methods
set sandbox = false
where provider_key in ('mercadopago', 'mercadopago_point')
  and sandbox = true;
