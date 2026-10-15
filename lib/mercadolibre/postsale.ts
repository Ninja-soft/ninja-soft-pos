// Gestor de Mercado Libre (H141 · ADR-132, parte B): etiquetas y reglas de la
// posventa y de los embudos. PURO (lo cubren los tests).

import type { MlTone } from "./labels";

export type ClaimKind = "reclamo" | "mediacion" | "devolucion" | "cancelacion";

export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
  reclamo: "Reclamo",
  mediacion: "Mediación",
  devolucion: "Devolución",
  cancelacion: "Cancelación",
};

export const CLAIM_KIND_TONE: Record<ClaimKind, MlTone> = {
  reclamo: "warning",
  mediacion: "danger",
  devolucion: "info",
  cancelacion: "neutral",
};

/** Chips de "casos que afectan la reputación" (como ANDESMAR). */
export type CaseFilter = "all" | "claims" | "mediations" | "returns" | "others";
export function caseGroup(kind: ClaimKind): Exclude<CaseFilter, "all"> {
  if (kind === "reclamo") return "claims";
  if (kind === "mediacion") return "mediations";
  if (kind === "devolucion") return "returns";
  return "others";
}

export const ACTION_LABELS: Record<string, string> = {
  send_message_to_complainant: "Responder al comprador",
  send_message_to_mediator: "Responder a Mercado Libre",
  refund: "Devolver el dinero",
  allow_return: "Aceptar la devolución",
  allow_partial_refund: "Ofrecer un reintegro parcial",
  open_dispute: "Pedir la mediación de Mercado Libre",
  add_shipping_evidence: "Cargar la prueba del envío",
  send_attachments: "Enviar archivos",
  return_review_ok: "La devolución llegó bien",
  return_review_fail: "La devolución llegó con problemas",
  return_review_unified_ok: "La devolución llegó bien",
  return_review_unified_fail: "La devolución llegó con problemas",
  recontact: "Volver a contactar",
};

export const RESPONSIBLE_LABELS: Record<string, string> = {
  respondent: "Te toca",
  complainant: "Le toca al comprador",
  mediator: "Le toca a Mercado Libre",
};

export const STAGE_LABELS: Record<string, string> = {
  claim: "Reclamo",
  dispute: "Mediación",
  recontact: "Recontacto",
  none: "Sin etapa",
};

export const RETURN_STATUS_LABELS: Record<string, string> = {
  label_generated: "Etiqueta generada",
  pending: "Pendiente",
  shipped: "En camino",
  delivered: "Llegó",
  closed: "Cerrada",
  cancelled: "Cancelada",
  expired: "Vencida",
  failed: "Falló",
  not_delivered: "No entregada",
  pending_cancel: "Cancelándose",
};

export const RESULT_LABELS: Record<string, { label: string; tone: MlTone }> = {
  a_favor: { label: "A favor", tone: "success" },
  en_contra: { label: "En contra", tone: "danger" },
  reintegro: { label: "Reintegro parcial", tone: "warning" },
  cubierto: { label: "Lo cubrió Mercado Libre", tone: "info" },
};

export const EXCLUSION_LABELS: Record<string, string> = {
  candidato: "Pedir exclusión",
  pedida: "Exclusión pedida",
  aceptada: "Exclusión aceptada",
  rechazada: "Exclusión rechazada",
  descartada: "Sin exclusión",
};

/** Motivo de ML por familia (PNR, PDD, CS). */
export function reasonLabel(reasonId: string | null | undefined): string {
  const r = (reasonId ?? "").toUpperCase();
  if (r.startsWith("PNR")) return "No recibió el producto";
  if (r.startsWith("PDD")) return "Producto distinto o con fallas";
  if (r.startsWith("CS")) return "Compra cancelada";
  return r ? "Otro motivo" : "Sin motivo";
}

// -----------------------------------------------------------------------------
// Vencimiento en horas hábiles de Argentina (lunes a viernes, UTC-3).
// -----------------------------------------------------------------------------
const AR_OFFSET = 3 * 3600_000;
const isWeekendAr = (ms: number) => {
  const d = new Date(ms - AR_OFFSET).getUTCDay();
  return d === 0 || d === 6;
};

/** Horas hábiles entre ahora y el vencimiento (negativo si venció). */
export function businessHoursLeft(dueIso: string | null | undefined, now = Date.now()): number | null {
  if (!dueIso) return null;
  const due = Date.parse(dueIso);
  if (!Number.isFinite(due)) return null;
  if (due <= now) return -(due < now ? Math.max((now - due) / 3600_000, 0.01) : 0.01);
  let ms = 0;
  let t = now;
  // Por tramos de hasta 1 h, saltando sábados y domingos.
  while (t < due) {
    const step = Math.min(3600_000, due - t);
    if (!isWeekendAr(t)) ms += step;
    t += step;
  }
  return ms / 3600_000;
}

export type Urgency = "vencido" | "rojo" | "ambar" | "ok" | "sin_plazo";

export function urgency(dueIso: string | null | undefined, now = Date.now(), dueHours = 24): Urgency {
  const h = businessHoursLeft(dueIso, now);
  if (h === null) return "sin_plazo";
  if (h < 0) return "vencido";
  if (h < 4) return "rojo";
  if (h < dueHours) return "ambar";
  return "ok";
}

export const URGENCY_TONE: Record<Urgency, MlTone> = {
  vencido: "danger",
  rojo: "danger",
  ambar: "warning",
  ok: "neutral",
  sin_plazo: "neutral",
};

const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Resolvé hasta el jue 16/10 18:00" en hora de Argentina (igual en todo navegador). */
export function dueLabel(dueIso: string | null | undefined): string {
  if (!dueIso) return "Sin vencimiento";
  const ms = Date.parse(dueIso);
  if (!Number.isFinite(ms)) return "Sin vencimiento";
  const d = new Date(ms - AR_OFFSET);
  return `Resolvé hasta el ${DAYS[d.getUTCDay()]} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// -----------------------------------------------------------------------------
// Embudos.
// -----------------------------------------------------------------------------
export type Board = "sales" | "claims";
export type AutoKey = "new" | "to_prepare" | "shipped" | "delivered" | "claim" | "waiting" | "resolved";

export interface StageRow {
  id: string;
  name: string;
  sort: number;
  auto_key: AutoKey | null;
  is_final: boolean;
}

export const DEFAULT_STAGES: Record<Board, Array<{ name: string; auto_key: AutoKey | null; is_final: boolean }>> = {
  sales: [
    { name: "Nueva", auto_key: "new", is_final: false },
    { name: "A preparar", auto_key: "to_prepare", is_final: false },
    { name: "Despachada", auto_key: "shipped", is_final: false },
    { name: "Entregada", auto_key: "delivered", is_final: false },
    { name: "Con reclamo", auto_key: "claim", is_final: false },
    { name: "Resuelta", auto_key: "resolved", is_final: true },
  ],
  claims: [
    { name: "Nuevo", auto_key: "new", is_final: false },
    { name: "En gestión", auto_key: null, is_final: false },
    { name: "Esperando", auto_key: "waiting", is_final: false },
    { name: "Resuelto", auto_key: "resolved", is_final: true },
  ],
};

/** Etapa automática de una venta (carrito) según la orden, el envío y el reclamo. */
export function autoSalesKey(i: { orderStatus: string; shipmentStatus?: string | null; substatus?: string | null; claimStatus?: string | null }): AutoKey {
  if (i.claimStatus === "opened") return "claim";
  if (i.orderStatus === "cancelled" || i.orderStatus === "invalid") return "resolved";
  if (i.claimStatus === "closed") return "resolved";
  const s = i.shipmentStatus ?? "";
  if (s === "delivered") return "delivered";
  if (s === "shipped" || s === "not_delivered") return "shipped";
  if (s === "ready_to_ship") return "to_prepare";
  return "new";
}

/** Etapa automática de un reclamo. */
export function autoClaimKey(c: { status: string; action_responsible?: string | null }): AutoKey {
  if (c.status === "closed") return "resolved";
  if (c.action_responsible && c.action_responsible !== "respondent") return "waiting";
  return "new";
}

export interface CardRow {
  stage_id: string | null;
  moved_at: string | null;
}

/**
 * Etapa en la que se muestra una tarjeta: la que eligió una persona gana,
 * salvo que el caso se cierre en ML DESPUÉS de ese movimiento (pasa a la
 * etapa final). Sin movimiento manual, la etapa automática; si ninguna etapa
 * tiene ese automático, la primera.
 */
export function effectiveStage(stages: StageRow[], auto: AutoKey, card: CardRow | null, sourceUpdatedAt: string | null): string | null {
  if (stages.length === 0) return null;
  const sorted = [...stages].sort((a, b) => a.sort - b.sort);
  const autoStage = sorted.find((s) => s.auto_key === auto) ?? (auto === "resolved" ? sorted.find((s) => s.is_final) : undefined) ?? sorted[0]!;
  const manual = card?.stage_id ? sorted.find((s) => s.id === card.stage_id) : undefined;
  if (!manual) return autoStage.id;
  if (auto === "resolved" && !manual.is_final && sourceUpdatedAt && card?.moved_at && Date.parse(sourceUpdatedAt) > Date.parse(card.moved_at)) {
    return autoStage.id;
  }
  return manual.id;
}
