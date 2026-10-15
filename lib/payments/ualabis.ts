// Ualá Bis (ADR-143): textos y reglas de la devolución desde la conciliación
// de cobros QR. Puro (sin React ni Supabase) para testearlo.

export type UalaRefundStatus = "requested" | "initiated" | "refunded" | "not_refunded" | "failed";

export interface UalaRefundRow {
  intent_id: string;
  status: string;
  created_at: string;
}

/** La devolución más nueva de cada cobro. */
export function latestRefundByIntent(rows: UalaRefundRow[]): Map<string, UalaRefundRow> {
  const out = new Map<string, UalaRefundRow>();
  for (const r of rows) {
    const prev = out.get(r.intent_id);
    if (!prev || r.created_at > prev.created_at) out.set(r.intent_id, r);
  }
  return out;
}

/**
 * ¿Se puede pedir la devolución? Cobro de Ualá Bis aprobado, sin venta vigente
 * (sin venta o con la venta anulada) y sin otra devolución viva.
 */
export function canRefundUala(
  intent: { provider_key: string; status: string; saleNumber: number | null; saleStatus: string | null },
  refund: { status: string } | null | undefined,
): boolean {
  if (intent.provider_key !== "ualabis" || intent.status !== "approved") return false;
  if (intent.saleNumber !== null && intent.saleStatus !== "voided") return false;
  return !refund || refund.status === "failed" || refund.status === "not_refunded";
}

export function ualaRefundLabel(status: string): { label: string; tone: "info" | "success" | "danger" } {
  switch (status) {
    case "refunded":
      return { label: "Devuelto", tone: "success" };
    case "not_refunded":
      return { label: "Ualá no lo devolvió", tone: "danger" };
    case "failed":
      return { label: "No se pudo devolver", tone: "danger" };
    default:
      return { label: "Devolución en curso", tone: "info" };
  }
}

export function ualaRefundErrorCopy(code: string | null | undefined): string {
  switch (code) {
    case "sale_active":
      return "Este cobro tiene una venta vigente. Anulá la venta primero y después devolvé el pago.";
    case "refund_in_progress":
      return "Ya hay una devolución en curso para este cobro.";
    case "not_refundable":
      return "Sólo se pueden devolver cobros aprobados.";
    case "forbidden":
      return "Sólo el dueño o un encargado pueden devolver cobros.";
    case "payment_method_not_allowed":
      return "Tu plan no incluye Ualá Bis.";
    case "not_connected":
      return "Conectá Ualá Bis en Configuración, Medios de pago.";
    default:
      if (code && code.startsWith("retry_")) return "Ualá Bis no respondió. Probá de nuevo en unos minutos.";
      return "Ualá Bis no aceptó la devolución. Recordá que se puede devolver dentro de los 90 días del pago.";
  }
}
