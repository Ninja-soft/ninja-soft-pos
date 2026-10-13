// =============================================================================
// lib/shipping/status.ts  (Envíos · ADR-103) · PURO
// Etiquetas, tonos y grupos de filtro de los estados normalizados. La regla de
// avance vive en supabase/functions/_shared/shipping/status.ts (espejo de la
// base); acá sólo presentación.
// =============================================================================
import type { BadgeTone } from "@/components/ui/Badge";
import {
  FINAL_STATUSES,
  SHIPMENT_STATUSES,
  isFinal,
} from "@/supabase/functions/_shared/shipping/status";
import type { ShipmentStatus } from "@/supabase/functions/_shared/shipping/types";

export { FINAL_STATUSES, SHIPMENT_STATUSES, isFinal };
export type { ShipmentStatus };

export const STATUS_LABEL: Record<ShipmentStatus, string> = {
  draft: "Borrador",
  quoted: "Cotizado",
  pending: "Generando",
  created: "Creado",
  label_ready: "Etiqueta lista",
  picked_up: "Retirado",
  in_transit: "En viaje",
  out_for_delivery: "En reparto",
  ready_for_pickup: "Para retirar",
  delivered: "Entregado",
  failed_attempt: "Visita fallida",
  returned: "Devuelto",
  cancelled: "Cancelado",
  error: "Con error",
};

export const STATUS_TONE: Record<ShipmentStatus, BadgeTone> = {
  draft: "neutral",
  quoted: "neutral",
  pending: "info",
  created: "info",
  label_ready: "brand",
  picked_up: "info",
  in_transit: "info",
  out_for_delivery: "gold",
  ready_for_pickup: "gold",
  delivered: "success",
  failed_attempt: "warning",
  returned: "warning",
  cancelled: "neutral",
  error: "danger",
};

/** Grupos del filtro de la pantalla Envíos. */
export const STATUS_GROUPS: { key: string; label: string; statuses: ShipmentStatus[] }[] = [
  { key: "to_print", label: "Para imprimir", statuses: ["label_ready"] },
  { key: "preparing", label: "Preparando", statuses: ["draft", "quoted", "pending", "created"] },
  { key: "moving", label: "En camino", statuses: ["picked_up", "in_transit", "out_for_delivery", "ready_for_pickup"] },
  { key: "issues", label: "Con problemas", statuses: ["error", "failed_attempt"] },
  { key: "done", label: "Terminados", statuses: ["delivered", "returned", "cancelled"] },
];

export function statusLabel(s: string): string {
  return STATUS_LABEL[s as ShipmentStatus] ?? s;
}

export function statusTone(s: string): BadgeTone {
  return STATUS_TONE[s as ShipmentStatus] ?? "neutral";
}

/** ¿Se puede cancelar desde la UI? (la base decide igual; esto es cortesía). */
export function canCancel(s: { status: string; external_id: string | null; cancel_requested_at: string | null }): boolean {
  if (isFinal(s.status as ShipmentStatus) || s.cancel_requested_at) return false;
  return true;
}

/** ¿Necesita la confirmación "cancelar sólo en NinjaSoft"? */
export function needsLocalCancel(
  s: { external_id: string | null },
  capabilities: { cancel?: boolean } | null | undefined,
): boolean {
  return Boolean(s.external_id) && !capabilities?.cancel;
}
