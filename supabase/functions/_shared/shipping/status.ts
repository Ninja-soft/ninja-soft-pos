// =============================================================================
// _shared/shipping/status.ts  (ADR-103)
//
// Estados normalizados: orden de avance, finales y la regla con la que un
// evento del carrier mueve el estado del envío. ESPEJO de
// shipment_record_events y _shipping_status_rank (20261110300200): si cambia
// una, cambia la otra (tests/unit/shippingStatus.test.ts).
// PURO.
// =============================================================================
import type { ShipmentStatus, TrackingEvent } from "./types.ts";

export const SHIPMENT_STATUSES: ShipmentStatus[] = [
  "draft",
  "quoted",
  "pending",
  "created",
  "label_ready",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "ready_for_pickup",
  "delivered",
  "failed_attempt",
  "returned",
  "cancelled",
  "error",
];

export const STATUS_RANK: Record<ShipmentStatus, number> = {
  draft: 0,
  quoted: 1,
  pending: 2,
  error: 2,
  created: 3,
  label_ready: 4,
  picked_up: 5,
  in_transit: 6,
  failed_attempt: 7,
  out_for_delivery: 7,
  ready_for_pickup: 8,
  delivered: 9,
  returned: 9,
  cancelled: 10,
};

export const FINAL_STATUSES: ShipmentStatus[] = ["delivered", "returned", "cancelled"];

export function isFinal(s: ShipmentStatus): boolean {
  return FINAL_STATUSES.includes(s);
}

export function isShipmentStatus(s: unknown): s is ShipmentStatus {
  return typeof s === "string" && (SHIPMENT_STATUSES as string[]).includes(s);
}

/**
 * Estado resultante de aplicar eventos de seguimiento. Manda el evento más
 * reciente con estado (empate: el de mayor avance). "created" sólo pisa
 * estados previos al alta; un envío final no cambia; los estados internos
 * (borrador, pendiente, error, etiqueta lista) no vienen del carrier.
 */
export function applyTrackingEvents(current: ShipmentStatus, events: TrackingEvent[]): ShipmentStatus {
  if (isFinal(current)) return current;
  const withStatus = events.filter((e): e is TrackingEvent & { status: ShipmentStatus } => e.status !== null);
  if (withStatus.length === 0) return current;
  const last = [...withStatus].sort((a, b) => {
    const t = Date.parse(b.occurred_at) - Date.parse(a.occurred_at);
    return t !== 0 ? t : STATUS_RANK[b.status] - STATUS_RANK[a.status];
  })[0]!;
  if (last.status === "created") {
    return ["draft", "quoted", "pending", "error"].includes(current) ? "created" : current;
  }
  if (["draft", "quoted", "pending", "error", "label_ready"].includes(last.status)) return current;
  return last.status;
}

/** Clave de deduplicación (misma fórmula que la base, sin el md5). */
export function eventDedupeBasis(e: TrackingEvent): string {
  if (e.external_event_id) return e.external_event_id;
  const iso = new Date(e.occurred_at).toISOString().slice(0, 19);
  return `${e.status ?? ""}|${e.carrier_status}|${iso}`;
}

/** Quita eventos repetidos (mismo id externo o mismo estado y fecha). */
export function dedupeEvents(events: TrackingEvent[]): TrackingEvent[] {
  const seen = new Set<string>();
  const out: TrackingEvent[] = [];
  for (const e of events) {
    const k = eventDedupeBasis(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * Fecha del carrier sin zona ("2026-07-24T16:28:37") → ISO en hora de
 * Argentina (-03:00). Con zona, se respeta. Inválida → null.
 */
export function argentinaIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const d = new Date(hasZone ? s : `${s.replace(" ", "T")}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
