// =============================================================================
// _shared/deliveryChannels/rappi.ts (ADR-102) · ESQUELETO
//
// Rappi Partners API (restaurants-integrations-public-api). Fuente:
// research-delivery-apps.md §1.2 y dev-portal.dev.rappi.com. Lo marcado
// SEGURO está en la documentación pública; lo marcado A CONFIRMAR se valida
// con el TAM (Technical Account Manager) de Rappi antes de implementarlo.
//
// Estado: firma del webhook implementada (formato documentado). Pedidos,
// estados y finanzas: TODO hasta tener el ambiente dev y la homologación.
//
// TODO (Rappi):
//   * Auth: client credentials de Auth0 que entrega el TAM; el token va en
//     credentials.access_token con su vencimiento. Endpoint de token: A CONFIRMAR.
//   * Dominio por país (Argentina): A CONFIRMAR con el TAM; dev en
//     microservices.dev.rappi.com / api.dev.rappi.com (SEGURO).
//   * Webhooks (SEGURO): NEW_ORDER, NEW_ORDER_SCHEDULED, ORDER_EVENT_CANCEL,
//     ORDER_RT_TRACKING (ubicación y ETA del repartidor), ORDER_OTHER_EVENT
//     (taken_visible_order con datos del repartidor), PING (responder
//     { status: "OK" } cada 3 minutos o la tienda queda no disponible),
//     STORE_CONNECTIVITY, MENU_APPROVED / MENU_REJECTED.
//     Nombres de los campos dentro del payload: A CONFIRMAR con un pedido real
//     del ambiente dev (no se inventan).
//   * Aceptar (SEGURO): PUT orders/{id}/take/{cookingTime}. Sin acción en
//     6 minutos el pedido pasa a TIMEOUT: conviene auto-aceptar.
//   * Rechazar (SEGURO): PUT orders/{id}/reject con motivo (y opción de
//     desactivar SKUs). Formato del cuerpo: A CONFIRMAR.
//   * Listo para retirar (SEGURO): POST orders/{id}/ready-for-pickup (manual;
//     por defecto Rappi lo hace solo).
//   * Retirado: lo informa Rappi (eventos del repartidor); no hay llamada del
//     POS documentada: A CONFIRMAR.
//   * Pedidos recientes (SEGURO): GET orders (polling mínimo cada 45 s, cada
//     pedido se entrega una sola vez) y GET orders/{id}/events.
//   * Finanzas (SEGURO): API Financial (payments, orders con comisiones,
//     agreements, ajustes) -> delivery_channel_settlements kind 'liquidado'.
//   * Estándar: tasa de éxito de requests >= 98 % o pueden revocar el acceso.
// =============================================================================

import { verifySignatureHeader } from "./signature.ts";
import {
  NotImplementedError,
  notImplemented,
  type DeliveryChannelAdapter,
  type ParsedWebhook,
} from "./types.ts";

/** Header de la firma (SEGURO): `Rappi-Signature: t=...,sign=...`. */
export const RAPPI_SIGNATURE_HEADER = "rappi-signature";

/** Tipos de evento documentados (SEGURO). El nombre del campo que los trae: A CONFIRMAR. */
export const RAPPI_EVENTS = [
  "NEW_ORDER",
  "NEW_ORDER_SCHEDULED",
  "ORDER_EVENT_CANCEL",
  "ORDER_RT_TRACKING",
  "ORDER_OTHER_EVENT",
  "PING",
  "STORE_CONNECTIVITY",
  "MENU_APPROVED",
  "MENU_REJECTED",
] as const;

export const rappiAdapter: DeliveryChannelAdapter = {
  provider: "rappi",
  ready: false,
  async verifySignature(req, ctx) {
    // HMAC-SHA256 sobre `<t>.<payload crudo>` (SEGURO, test de homologación).
    // Tolerancia de tiempo: A CONFIRMAR (se usa 5 minutos).
    return verifySignatureHeader(
      req.headers.get(RAPPI_SIGNATURE_HEADER),
      ctx.webhookSecret,
      req.rawBody,
      ctx.now ? ctx.now() : Date.now(),
    );
  },
  parseEvent(rawBody): ParsedWebhook {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    // TODO(rappi): el campo con el tipo de evento es A CONFIRMAR. El PING sí
    // tiene respuesta documentada: { status: "OK" }.
    if (body && (body.event === "PING" || body.type === "PING")) {
      return { events: [], reply: { status: 200, body: { status: "OK" } } };
    }
    throw new NotImplementedError("rappi", "parseEvent");
  },
  parseOrder() {
    // TODO(rappi): mapear el pedido de NEW_ORDER a NormalizedOrder (ítems,
    // toppings, totales, cliente, tipo de entrega). Campos A CONFIRMAR.
    throw new NotImplementedError("rappi", "parseOrder");
  },
  async accept() {
    // TODO(rappi): PUT orders/{id}/take/{cookingTime} (SEGURO); base URL A CONFIRMAR.
    return notImplemented("rappi", "accept");
  },
  async reject() {
    // TODO(rappi): PUT orders/{id}/reject con motivo (SEGURO); cuerpo A CONFIRMAR.
    return notImplemented("rappi", "reject");
  },
  async markReady() {
    // TODO(rappi): POST orders/{id}/ready-for-pickup (SEGURO).
    return notImplemented("rappi", "markReady");
  },
  async markPickedUp() {
    // Rappi informa el retiro por eventos del repartidor: no hay llamada (A CONFIRMAR).
    return { ok: true, retryable: false, response: { skipped: "rappi_informa_el_retiro" } };
  },
  async fetchRecentOrders() {
    // TODO(rappi): GET orders (polling >= 45 s) y GET orders/{id}/events.
    throw new NotImplementedError("rappi", "fetchRecentOrders");
  },
  async syncMenu() {
    // TODO(rappi): API de menús con aprobación (MENU_APPROVED / MENU_REJECTED).
    return notImplemented("rappi", "syncMenu");
  },
  async toggleStore() {
    // TODO(rappi): disponibilidad de tienda / ítems (Managing availability).
    return notImplemented("rappi", "toggleStore");
  },
};
