// dLocal Go (ADR-180): textos y reglas de la devolución desde la conciliación
// de cobros QR. Puro (sin React ni Supabase) para testearlo. La devolución más
// nueva de cada cobro sale de latestRefundByIntent (lib/payments/ualabis).

export type DlocalRefundStatus = "requested" | "initiated" | "refunded" | "failed";

/**
 * ¿Se puede pedir la devolución? Cobro de dLocal Go aprobado, sin venta vigente
 * (sin venta o con la venta anulada) y sin otra devolución viva o hecha.
 */
export function canRefundDlocal(
  intent: { provider_key: string; status: string; saleNumber: number | null; saleStatus: string | null },
  refund: { status: string } | null | undefined,
): boolean {
  if (intent.provider_key !== "dlocalgo" || intent.status !== "approved") return false;
  if (intent.saleNumber !== null && intent.saleStatus !== "voided") return false;
  return !refund || refund.status === "failed";
}

export function dlocalRefundLabel(status: string): { label: string; tone: "info" | "success" | "danger" } {
  switch (status) {
    case "refunded":
      return { label: "Devuelto", tone: "success" };
    case "failed":
      return { label: "No se pudo devolver", tone: "danger" };
    default:
      return { label: "Devolución en curso", tone: "info" };
  }
}

export function dlocalRefundErrorCopy(code: string | null | undefined): string {
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
      return "Tu plan no incluye dLocal Go.";
    case "not_connected":
      return "Conectá dLocal Go en Configuración, Medios de pago.";
    default:
      if (code && code.startsWith("retry_")) return "dLocal Go no respondió. Probá de nuevo en unos minutos.";
      return "dLocal Go no aceptó la devolución. Revisala en el dashboard de dLocal Go.";
  }
}
