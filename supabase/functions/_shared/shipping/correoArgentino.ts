// =============================================================================
// _shared/shipping/correoArgentino.ts  (ADR-103) · ESQUELETO
//
// Correo Argentino tiene DOS APIs (research 2026-10-13, nada verificado):
//
// 1) MiCorreo (pymes, alta online con CUIT, credenciales de API por formulario)
//    Base probable: https://api.correoargentino.com.ar/micorreo/v1  (A CONFIRMAR)
//    Fuente: manual descargable de MiCorreo y el wrapper comunitario
//    YamilEzequiel/correo-argentino. Recursos que menciona el wrapper (todos
//    A CONFIRMAR): token con HTTP Basic de la credencial de aplicación,
//    validación del usuario MiCorreo (devuelve customerId), tarifas por CP,
//    peso y medidas (Clásico o Expreso, domicilio o sucursal), sucursales por
//    provincia e "importación" del envío a la cuenta.
//    LIMITACIÓN: la importación NO devuelve etiqueta; el pago y la impresión
//    se terminan en la web de MiCorreo. La UI tiene que decirlo.
//
// 2) PAQ.AR 2.0 (corporativo, acuerdo comercial)
//    Base probable: https://api.correoargentino.com.ar/paqar/v1 y sandbox
//    https://apitest.correoargentino.com.ar/paqar/api (A CONFIRMAR, fuente:
//    plugin WooCommerce "Correo Argentino for WooCommerce").
//    Auth: Agreement + Apikey del ejecutivo de cuentas. Alta con etiqueta
//    (formato A CONFIRMAR, se reporta PDF en base64) y cancelación.
//
// Credenciales que se piden (config.api = 'micorreo' | 'paqar'):
//   micorreo: usuario y contraseña de MiCorreo + credencial de aplicación.
//   paqar:    agreement + api key.
// =============================================================================
import { GENERIC_STATUS_MAP, skeletonAdapter } from "./skeleton.ts";

export const correoArgentinoAdapter = skeletonAdapter({
  key: "correo_argentino",
  name: "Correo Argentino",
  // MiCorreo: sin etiqueta por API (se termina en la web). PAQ.AR la tendría.
  capabilities: { quote: true, label: false, points: true, track: true, cancel: false, webhooks: false, pickup: false },
  labelFormats: ["pdf"],
  statusMap: GENERIC_STATUS_MAP,
});
