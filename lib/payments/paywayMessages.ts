// Copy para el cliente final en el checkout propio de Payway (/pagar/[id]).
// Mapea la respuesta de payway_checkout (action pay) y el error de tokenización
// de Payway (POST /tokens) a un mensaje claro. Sólo "rejected_attempt" es un
// rechazo del emisor; los errores del procesador no culpan a la tarjeta.

export type PaywayPayResult = {
  status?: string;
  error?: string;
  reason?: string;
};

export function paywayPayMessage(r: PaywayPayResult): string {
  if (r.status === "rejected_attempt") {
    return "El pago fue rechazado por el emisor de la tarjeta. Probá con otra tarjeta.";
  }
  if (r.status === "pending_review" || r.error === "payment_in_review") {
    return "Tu pago quedó en revisión. No lo vuelvas a intentar: avisale al cajero para que lo confirme.";
  }
  if (r.error === "intent_not_pending") {
    return "Este cobro ya no está disponible. Pedile al cajero que lo genere de nuevo.";
  }
  // Mismo contrato para el checkout propio de Getnet (ADR-069).
  if (r.error === "payway_error" || r.error === "getnet_error") {
    switch (r.reason) {
      case "amount_mismatch":
        return "No pudimos confirmar el pago. Avisale al cajero antes de volver a intentarlo.";
      case "token":
        return "No pudimos procesar la tarjeta. Cargá los datos de nuevo y volvé a intentar.";
      case "card_data":
        return "Revisá los datos de la tarjeta e intentá de nuevo.";
      case "not_enabled":
      case "credentials":
        return "El comercio todavía no puede cobrar con tarjeta por acá. Avisale al cajero para pagar con otro medio.";
      default:
        return "El procesador de pagos no respondió bien. Probá de nuevo en unos segundos.";
    }
  }
  if (r.error === "invalid_card") return "Revisá los datos de la tarjeta e intentá de nuevo.";
  if (r.error === "card_expired") return "La tarjeta está vencida. Probá con otra tarjeta.";
  if (r.error === "checkout_api_unavailable" || r.error === "payment_method_not_allowed") {
    return "El pago con tarjeta por acá no está disponible. Avisale al cajero para pagar con otro medio.";
  }
  if (r.error === "invalid_brand") return "Elegí la tarjeta con la que vas a pagar.";
  if (r.error === "plan_not_available") return "Esas cuotas no están disponibles. Elegí otra opción.";
  return "No se pudo procesar el pago. Probá de nuevo.";
}

type TokenError = {
  error_type?: string;
  validation_errors?: { code?: string; param?: string }[];
};

export function paywayTokenMessage(body: unknown): string {
  const ve = ((body as TokenError | null)?.validation_errors ?? []).filter(Boolean);
  if (ve.some((e) => /expired/i.test(String(e.param ?? "")))) {
    return "La tarjeta está vencida. Probá con otra tarjeta.";
  }
  return "No pudimos validar la tarjeta. Revisá los datos.";
}
