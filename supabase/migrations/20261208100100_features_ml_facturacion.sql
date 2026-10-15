-- =============================================================================
-- 20261208100100_features_ml_facturacion  (ADR-141 · parte B)
--
-- Feature `mercadolibre_facturacion`: OPTIONAL (convención CLAUDE.md §6),
-- requiere `mercadolibre` y `facturacion_afip`. Facturación de Mercado Libre
-- con reglas: cupones, envío, datos fiscales del comprador con el padrón,
-- elección por venta de qué factura se emite y cuál se sube a ML, punto de
-- venta por cuenta, A4 o ticket, percepciones de IIBB por jurisdicción con
-- cobro por link de pago, nota de crédito por reintegro y bandeja con
-- acciones en lote.
--   1. Key en `features` (grupo integraciones, is_basic = false).
--   2. Marca por plan: Pro, Business y Enterprise (los mismos que
--      `mercadolibre`, para no quitarle nada a nadie); Start no. Lo ya
--      declarado en un plan gana (sólo se completa si falta).
--   3. Gating real server-side en 20261208100200_ml_facturacion:
--      ml_billing_assert (RPC de la UI), ml_billing_context (worker: sin la
--      feature la venta entra como antes, ADR-104), ml_edge_guard_billing
--      (Edge ml_facturacion) y _ml_invoice_emit. Las percepciones además
--      exigen `percepciones_retenciones` (ser agente de percepción).
--   4. Copy en lib/saas/featureInfo.ts; 5. comparación derivada de la matriz.
-- La facturación básica de ADR-104 (cuándo facturar, letra automática, subir
-- el PDF) sigue en `mercadolibre`.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('mercadolibre_facturacion', 'Facturación de Mercado Libre',
   'Facturación de las ventas de Mercado Libre con reglas: cupones, envío cobrado, datos fiscales del comprador con el padrón de ARCA, qué factura se emite y cuál se sube a la venta, punto de venta por cuenta, A4 o ticket, percepciones de IIBB por jurisdicción con cobro por link de pago, nota de crédito por reintegro y bandeja con acciones en lote',
   'integraciones', false, 232)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('mercadolibre_facturacion', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'mercadolibre_facturacion');
