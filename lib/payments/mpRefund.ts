// =============================================================================
// Reintegro por Mercado Pago (H21h · ADR-067): lógica pura para el wizard de
// devolución, el detalle de la venta y los mensajes. Sin red ni React.
//
// El servidor decide (return_sale_v2, Edge mp_refund y mp_refund_fallback);
// esto arma las opciones, el tope y los textos honestos.
// =============================================================================

export type MpRefundStatus =
  | "pending"
  | "processing"
  | "approved"
  | "in_process"
  | "failed"
  | "error"
  | "fallback";

export interface MpRefundablePayment {
  payment_id: string;
  intent_id: string;
  provider_key: string;
  paid: number;
  refunded: number;
  refundable: number;
  expired: boolean;
  paid_at: string;
}

export interface MpRefundOptions {
  feature: boolean;
  enabled: boolean;
  is_supervisor: boolean;
  window_days: number;
  payments: MpRefundablePayment[];
}

export interface MpRefundRow {
  id: string;
  sale_id: string;
  sale_return_id: string;
  payment_id: string;
  amount: number;
  status: MpRefundStatus;
  mp_refund_id: string | null;
  mp_status: string | null;
  error_code: string | null;
  error_detail: string | null;
  fallback_method: "cash" | "store_credit" | null;
  created_at: string;
  completed_at: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cobros de MP que se pueden reintegrar hoy (con saldo y en plazo). */
export function usablePayments(o: MpRefundOptions | null | undefined): MpRefundablePayment[] {
  if (!o) return [];
  return o.payments.filter((p) => !p.expired && Number(p.refundable) > 0.009);
}

/** ¿Se ofrece "Reintegrar por Mercado Pago" en el wizard? */
export function mpRefundAvailable(o: MpRefundOptions | null | undefined): boolean {
  return Boolean(o?.feature && o.enabled && usablePayments(o).length > 0);
}

/** Por qué no se ofrece, para explicarlo (o null si se ofrece o no aplica). */
export function mpRefundUnavailableReason(o: MpRefundOptions | null | undefined): string | null {
  if (!o || o.payments.length === 0) return null;
  if (!o.feature) return "Tu plan no incluye el reintegro por Mercado Pago.";
  if (!o.enabled) return "El dueño todavía no habilitó el reintegro por Mercado Pago (Medios de pago, Mercado Pago).";
  if (o.payments.every((p) => p.expired)) {
    return `Pasaron más de ${o.window_days} días desde el cobro: Mercado Pago ya no permite devolverlo.`;
  }
  if (o.payments.every((p) => Number(p.refundable) <= 0.009)) return "Ese cobro ya fue reintegrado por completo.";
  return null;
}

/** Tope del reintegro por MP: lo devuelto y lo disponible del cobro. */
export function maxMpAmount(returnTotal: number, payment: MpRefundablePayment | null | undefined): number {
  if (!payment) return 0;
  return round2(Math.max(0, Math.min(Number(returnTotal) || 0, Number(payment.refundable) || 0)));
}

/** Monto válido (0 < monto <= tope), redondeado a centavos. */
export function clampMpAmount(value: number, max: number): number {
  const v = round2(Number(value) || 0);
  if (v <= 0) return 0;
  return Math.min(v, round2(max));
}

export const MP_REFUND_STATUS_LABEL: Record<MpRefundStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  pending: { label: "Por enviar a Mercado Pago", tone: "warning" },
  processing: { label: "Enviando a Mercado Pago", tone: "warning" },
  approved: { label: "Reintegrado por Mercado Pago", tone: "success" },
  in_process: { label: "Mercado Pago lo está procesando", tone: "success" },
  failed: { label: "Mercado Pago no pudo", tone: "danger" },
  error: { label: "Sin respuesta de Mercado Pago", tone: "warning" },
  fallback: { label: "Reintegrado en efectivo o vale", tone: "neutral" },
};

/** Se puede reintentar el pedido a Mercado Pago. */
export const canRetry = (s: MpRefundStatus) => s === "pending" || s === "error" || s === "failed";

/** Se puede pasar a efectivo o vale (MP lo rechazó o todavía no se intentó). */
export const canFallback = (s: MpRefundStatus) => s === "failed" || s === "pending";

/** Mensaje honesto de un error de MP o del servidor. */
export function mpRefundErrorMessage(code: string | null | undefined): string {
  const map: Record<string, string> = {
    insufficient_balance:
      "Tu cuenta de Mercado Pago no tiene saldo suficiente para devolver ese monto. Podés devolverlo en efectivo o con un vale, o cargar saldo y reintentar.",
    refund_period_expired: "Mercado Pago ya no permite devolver ese cobro: pasó el plazo.",
    payment_in_dispute:
      "El pago tiene un reclamo o contracargo abierto en Mercado Pago: no se puede devolver por ahí mientras tanto.",
    already_refunded: "Ese cobro ya fue devuelto en Mercado Pago.",
    invalid_amount: "Mercado Pago no aceptó el monto a devolver.",
    payment_not_found: "No se encontró el pago en Mercado Pago.",
    mp_auth: "La cuenta de Mercado Pago con la que se cobró no está conectada o venció la autorización.",
    rejected_by_mp: "Mercado Pago rechazó la devolución.",
    provider_unavailable:
      "Mercado Pago no respondió. No sabemos si hizo la devolución: reintentá (no se duplica).",
    provider_error: "Mercado Pago respondió algo inesperado. Reintentá en unos minutos.",
    mp_refunds_disabled: "El dueño no habilitó el reintegro por Mercado Pago.",
    mp_refund_reason_required: "Elegí el motivo de la devolución para reintegrar por Mercado Pago.",
    mp_payment_not_refundable: "Ese cobro no se puede reintegrar por Mercado Pago.",
    mp_amount_exceeds_refundable: "El monto supera lo que queda por reintegrar de ese cobro.",
    mp_amount_exceeds_return: "El monto por Mercado Pago no puede ser mayor que lo devuelto.",
    mp_refund_period_expired: "Mercado Pago ya no permite devolver ese cobro: pasó el plazo.",
    "feature_not_in_plan: reintegro_mp": "Tu plan no incluye el reintegro por Mercado Pago.",
    feature_not_in_plan: "Tu plan no incluye el reintegro por Mercado Pago.",
    in_progress: "Ya se está enviando a Mercado Pago. Esperá unos segundos.",
    refund_not_fallbackable: "Ese reintegro ya no se puede pasar a efectivo o vale.",
    forbidden: "No tenés permiso para esta acción.",
  };
  if (!code) return "No se pudo reintegrar por Mercado Pago.";
  const key = Object.keys(map)
    .sort((a, b) => b.length - a.length)
    .find((k) => code.includes(k));
  return (key && map[key]) || "No se pudo reintegrar por Mercado Pago.";
}

/** Total reintegrado (o en camino) por Mercado Pago de una lista de filas. */
export function mpRefundedTotal(rows: Pick<MpRefundRow, "amount" | "status">[]): number {
  return round2(
    rows
      .filter((r) => r.status === "approved" || r.status === "in_process")
      .reduce((a, r) => a + Number(r.amount), 0),
  );
}
