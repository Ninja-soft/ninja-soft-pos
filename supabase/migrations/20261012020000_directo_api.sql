-- =============================================================================
-- 20261012020000_directo_api  (F8 · ADR-041 Directo por API)
--
-- Directo (provider/feature `directo`, marca directo) pasa a canal qr_link:
-- con la API de comercios conectada (Edge `directo` + `directo_webhook`), el
-- POS muestra el QR + link de la orden de Directo y el cobro entra como
-- method='qr' con reference = intent (mp_payment_intents.provider_key =
-- 'directo'). El gating fino del trigger de payments ya lo cubre vía
-- payment_method_plan_key('directo') (20261011180000).
--
-- Se MANTIENE el respaldo manual de ADR-034 (payments.method = 'directo' +
-- número de operación obligatorio): el POS lo ofrece sólo mientras la API no
-- esté conectada. Por eso no se tocan payments_method_check ni
-- payments_directo_reference_check.
--
-- Sin cambios de plan: sigue OPTIONAL desde Pro.
-- =============================================================================

update payment_providers
set kind = 'gateway',
    channel = 'qr_link'
where key = 'directo';

update features
set description = 'Cobros con crédito Directo por QR + link (API de comercios) o con registro manual del número de operación'
where key = 'directo';
