// =============================================================================
// _shared/deliveryChannels/stateMachine.ts (ADR-102)
//
// Máquina de estados del pedido externo. Espejo exacto de las funciones SQL
// _channel_can_transition, _channel_board_status y
// delivery_channel_backoff_seconds (20261110200200): si cambia una, cambian
// las dos (lo cubre tests/unit/deliveryChannels.test.ts).
// =============================================================================

import type { ExternalStatus } from "./types.ts";

export const EXTERNAL_STATUSES: ExternalStatus[] = [
  "nuevo",
  "aceptado",
  "rechazado",
  "listo",
  "retirado",
  "entregado",
  "cancelado",
];

const NEXT: Record<ExternalStatus, ExternalStatus[]> = {
  nuevo: ["aceptado", "rechazado", "cancelado"],
  aceptado: ["listo", "retirado", "entregado", "cancelado"],
  listo: ["retirado", "entregado", "cancelado"],
  retirado: ["entregado", "cancelado"],
  // La app puede cancelar después de entregar (reintegro al cliente): se anula
  // la venta y sale la nota de crédito.
  entregado: ["cancelado"],
  rechazado: [],
  cancelado: [],
};

/** No retrocede: un evento fuera de orden (o repetido) se ignora. */
export function canTransition(from: ExternalStatus, to: ExternalStatus): boolean {
  return NEXT[from]?.includes(to) ?? false;
}

export function isFinal(status: ExternalStatus): boolean {
  return NEXT[status].length === 0;
}

export type BoardStatus = "recibido" | "preparando" | "en_camino" | "listo" | "entregado" | "cancelado";

/**
 * Columna del tablero de delivery para un estado externo. Hasta facturar el
 * pedido no pasa a 'entregado' (create_sale lo cierra al cobrar).
 */
export function boardStatusFor(status: ExternalStatus, orderType: "delivery" | "takeaway" | "mostrador"): BoardStatus {
  switch (status) {
    case "nuevo":
      return "recibido";
    case "aceptado":
      return "preparando";
    case "listo":
      return "listo";
    case "retirado":
    case "entregado":
      return orderType === "delivery" ? "en_camino" : "listo";
    default:
      return "cancelado";
  }
}

/** Espera antes del próximo intento de una llamada saliente: 15 s, 30 s, 1 min... tope 15 min. */
export function outboxBackoffSeconds(attempt: number): number {
  const n = Math.max(Math.floor(attempt) || 1, 1);
  return Math.min(15 * 2 ** (n - 1), 900);
}

/** Acciones que el local puede hacer en cada estado (botones del tablero). */
export function localActions(status: ExternalStatus): ("accept" | "reject" | "ready" | "picked_up" | "delivered")[] {
  switch (status) {
    case "nuevo":
      return ["accept", "reject"];
    case "aceptado":
      return ["ready", "picked_up"];
    case "listo":
      return ["picked_up"];
    case "retirado":
      return ["delivered"];
    default:
      return [];
  }
}
