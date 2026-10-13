// =============================================================================
// _shared/shipping/oca.ts  (ADR-103) · ESQUELETO
//
// OCA e-Pak: web service SOAP/ASMX "Express Pak" (research 2026-10-13, nada
// verificado). Host que citan la ayuda de OCA y los clientes comunitarios
// (ocaclient en Python, oca-php-api): webservice.oca.com.ar, servicio
// Oep_TrackEPak.asmx (A CONFIRMAR). Métodos que nombran esas fuentes, todos
// A CONFIRMAR con la documentación que entrega OCA al habilitar la cuenta:
//   cotización corporativa (CUIT + operativa), ingreso de orden de retiro (XML),
//   anulación de la orden, etiquetas en HTML o PDF por orden o número de
//   envío, seguimiento por pieza y último estado, centros de imposición por CP.
// Sin webhooks: seguimiento por polling. ZPL: A CONFIRMAR.
//
// Credenciales que se piden: usuario y contraseña de e-Pak, CUIT y un número
// de OPERATIVA por servicio (puerta a puerta, puerta a sucursal, etc.).
// Parseo: XML (SOAP) con una librería liviana y fixtures, cuando haya doc.
// =============================================================================
import { GENERIC_STATUS_MAP, skeletonAdapter } from "./skeleton.ts";

export const ocaAdapter = skeletonAdapter({
  key: "oca",
  name: "OCA",
  capabilities: { quote: true, label: true, points: true, track: true, cancel: true, webhooks: false, pickup: true },
  labelFormats: ["pdf"],
  statusMap: GENERIC_STATUS_MAP,
});
