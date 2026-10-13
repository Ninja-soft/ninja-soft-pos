// =============================================================================
// Reintegro por Mercado Pago (H21h · ADR-067). Puro: sin red ni Deno (lo
// importan la Edge `mp_refund` y Vitest).
//
//  * mpOrderPaymentId(orden): id numérico del pago de una orden (Orders API,
//    QR dinámico y Point, ADR-032): transactions.payments[].reference_id.
//  * classifyMpRefund(http, body): resultado de POST
//    /v1/payments/{id}/refunds en uno de cuatro:
//      approved    MP hizo la devolución.
//      in_process  MP la aceptó y la está procesando (cuenta como hecha).
//      failed      MP la rechazó: se puede pasar a efectivo o vale.
//      error       no se sabe (red, 5xx, 429, 409): se reintenta con la MISMA
//                  clave de idempotencia; nunca se ofrece efectivo a ciegas.
//    Con el código de error honesto para el cajero (saldo insuficiente, plazo
//    vencido, pago en disputa, ya devuelto, monto inválido, pago no
//    encontrado, credencial).
// =============================================================================

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export type MpRefundOutcome = "approved" | "in_process" | "failed" | "error";

export type MpRefundErrorCode =
  | "insufficient_balance"
  | "refund_period_expired"
  | "payment_in_dispute"
  | "already_refunded"
  | "invalid_amount"
  | "payment_not_found"
  | "mp_auth"
  | "rejected_by_mp"
  | "provider_unavailable"
  | "provider_error";

export interface MpRefundResult {
  outcome: MpRefundOutcome;
  refundId: string | null;
  mpStatus: string | null;
  code: MpRefundErrorCode | null;
  detail: string | null;
}

/** Id numérico del pago dentro de una orden de la Orders API. */
export function mpOrderPaymentId(order: unknown): string | null {
  if (!isObj(order)) return null;
  const tx = isObj(order.transactions) ? order.transactions : null;
  const pays = Array.isArray(tx?.payments) ? tx.payments : [];
  for (const p of pays) {
    if (!isObj(p)) continue;
    const ref = str(p.reference_id);
    if (ref && /^\d+$/.test(ref)) return ref;
  }
  return null;
}

/** Texto del error de MP (message, error y las causas) para clasificar. */
function errorText(body: unknown): string {
  if (!isObj(body)) return typeof body === "string" ? body : "";
  const parts: string[] = [];
  for (const k of ["message", "error", "status_detail"]) {
    const v = str(body[k]);
    if (v) parts.push(v);
  }
  const cause = Array.isArray(body.cause) ? body.cause : isObj(body.cause) ? [body.cause] : [];
  for (const c of cause) {
    if (!isObj(c)) continue;
    const d = str(c.description) ?? str(c.message);
    const code = str(c.code);
    if (d) parts.push(d);
    if (code) parts.push(`code ${code}`);
  }
  return parts.join(" | ");
}

/** Código honesto a partir del texto de MP. */
export function mpRefundErrorCode(http: number, body: unknown): MpRefundErrorCode {
  const t = errorText(body).toLowerCase();
  if (http === 401 || http === 403 || /unauthorized|invalid (access )?token|forbidden/.test(t)) return "mp_auth";
  if (/insufficient|not enough|saldo|balance|funds/.test(t)) return "insufficient_balance";
  if (/mediation|dispute|chargeback|claim|contracargo|reclamo/.test(t)) return "payment_in_dispute";
  if (/already.*refund|totally refunded|fully refunded|refunded payment|ya.*devuelt/.test(t)) return "already_refunded";
  if (/expir|period|too old|days|plazo|vencid/.test(t)) return "refund_period_expired";
  if (http === 404 || /not found|no encontrad/.test(t)) return "payment_not_found";
  if (/amount|monto|importe/.test(t)) return "invalid_amount";
  return http >= 400 && http < 500 ? "rejected_by_mp" : "provider_error";
}

/** Clasifica la respuesta de POST /v1/payments/{id}/refunds. */
export function classifyMpRefund(http: number, body: unknown): MpRefundResult {
  const detail = errorText(body).slice(0, 300) || null;
  if (http >= 200 && http < 300 && isObj(body)) {
    const refundId = str(body.id);
    const st = (str(body.status) ?? "approved").toLowerCase();
    if (!refundId) {
      return { outcome: "error", refundId: null, mpStatus: st, code: "provider_error", detail: "Respuesta sin id de devolución" };
    }
    if (st === "approved") return { outcome: "approved", refundId, mpStatus: st, code: null, detail: null };
    if (st === "in_process" || st === "pending" || st === "authorized") {
      return { outcome: "in_process", refundId, mpStatus: st, code: null, detail: null };
    }
    if (st === "rejected" || st === "cancelled") {
      return { outcome: "failed", refundId, mpStatus: st, code: "rejected_by_mp", detail };
    }
    return { outcome: "in_process", refundId, mpStatus: st, code: null, detail: null };
  }
  // Dudosos: no se sabe si MP la hizo. Reintento con la misma clave.
  if (http === 0 || http === 408 || http === 409 || http === 429 || http >= 500) {
    return { outcome: "error", refundId: null, mpStatus: null, code: "provider_unavailable", detail };
  }
  return { outcome: "failed", refundId: null, mpStatus: null, code: mpRefundErrorCode(http, body), detail };
}

/** Monto para el cuerpo del pedido (MP espera número con 2 decimales). */
export function refundAmount(n: number): number {
  return Math.round(n * 100) / 100;
}
