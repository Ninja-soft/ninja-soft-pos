// Mercado Libre (H87 · ADR-104): etiquetas, tonos y mensajes de error de la
// integración. PURO: lo usan la configuración, la pantalla Mercado Libre y la
// ficha del producto, y los tests unitarios.

export type MlTone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

export const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  active: "Activa",
  reauth_required: "Reconectar",
  disconnected: "Desconectada",
};

export const ITEM_STATUS_LABELS: Record<string, string> = {
  active: "Activa",
  paused: "Pausada",
  closed: "Finalizada",
  under_review: "En revisión",
  inactive: "Inactiva",
  payment_required: "Pago pendiente",
  not_yet_active: "Sin activar",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  paid: "Pagada",
  confirmed: "Confirmada",
  payment_required: "Esperando pago",
  payment_in_process: "Pago en proceso",
  partially_paid: "Pago parcial",
  partially_refunded: "Reintegro parcial",
  pending_cancel: "Cancelándose",
  cancelled: "Cancelada",
  invalid: "Inválida",
};

export const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  handling: "En preparación",
  ready_to_ship: "Listo para despachar",
  shipped: "En camino",
  delivered: "Entregado",
  not_delivered: "No entregado",
  cancelled: "Cancelado",
  to_be_agreed: "A coordinar",
};

export const SHIPMENT_SUBSTATUS_LABELS: Record<string, string> = {
  ready_to_print: "Etiqueta lista",
  printed: "Etiqueta impresa",
  in_hub: "En el centro",
  in_packing_list: "En la colecta",
  picked_up: "Retirado",
  waiting_for_withdrawal: "Esperando retiro",
  out_for_delivery: "En reparto",
};

export const QUESTION_STATUS_LABELS: Record<string, string> = {
  UNANSWERED: "Sin responder",
  ANSWERED: "Respondida",
  CLOSED_UNANSWERED: "Cerrada sin responder",
  UNDER_REVIEW: "En revisión",
  BANNED: "Bloqueada",
  DELETED: "Borrada",
  DISABLED: "Deshabilitada",
};

export const ANSWER_STATE_LABELS: Record<string, string> = {
  none: "",
  sending: "Enviando",
  sent: "Enviada",
  error: "No se pudo enviar",
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  none: "Sin facturar",
  pending: "Para facturar",
  queued: "Facturando",
  approved: "Factura aprobada",
  uploaded: "Factura subida a ML",
  error: "Factura con problemas",
  not_applicable: "No se factura",
};

export const LOGISTIC_LABELS: Record<string, string> = {
  drop_off: "Correo",
  xd_drop_off: "Places",
  cross_docking: "Colecta",
  self_service: "Flex",
  fulfillment: "Full",
  me1: "Envío propio",
  custom: "Envío propio",
  not_specified: "A convenir",
  default: "Mercado Envíos",
};

export const LISTING_TYPE_LABELS: Record<string, string> = {
  gold_special: "Clásica",
  gold_pro: "Premium",
  free: "Gratuita",
};

export const INVOICE_MODE_LABELS: Record<string, string> = {
  on_paid: "Al pagarse",
  on_shipped: "Al despacharse",
  manual: "A mano",
  none: "No facturar",
};

export const LABEL_FORMAT_LABELS: Record<string, string> = {
  pdf: "PDF (impresora común, A4 o 10x15)",
  zpl2: "ZPL (térmica Zebra)",
};

export const LABEL_BLOCKER_LABELS: Record<string, string> = {
  fraud: "Riesgo de fraude: no despachar",
  not_me2: "No es Mercado Envíos",
  fulfillment: "Lo despacha Full",
  not_ready: "La etiqueta todavía no está lista",
  not_found: "Envío no encontrado",
};

const label = (map: Record<string, string>, key: string | null | undefined, fallback = "") =>
  key ? (map[key] ?? key) : fallback;

export const itemStatusLabel = (s: string | null | undefined) => label(ITEM_STATUS_LABELS, s, "Sin estado");
export const orderStatusLabel = (s: string | null | undefined) => label(ORDER_STATUS_LABELS, s, "Sin estado");
export const shipmentStatusLabel = (s: string | null | undefined, sub?: string | null) => {
  const main = label(SHIPMENT_STATUS_LABELS, s, "Sin estado");
  const extra = sub ? SHIPMENT_SUBSTATUS_LABELS[sub] : undefined;
  return extra ? `${main} · ${extra}` : main;
};
export const logisticLabel = (logistic: string | null | undefined, mode?: string | null) =>
  mode === "me1" || mode === "custom" ? LOGISTIC_LABELS.me1! : label(LOGISTIC_LABELS, logistic, "Sin envío");

export function itemStatusTone(status: string | null | undefined): MlTone {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "warning";
    case "under_review":
    case "payment_required":
      return "danger";
    case "closed":
    case "inactive":
      return "neutral";
    default:
      return "info";
  }
}

export function accountStatusTone(status: string | null | undefined): MlTone {
  return status === "active" ? "success" : status === "reauth_required" ? "warning" : "neutral";
}

export function orderStatusTone(status: string | null | undefined): MlTone {
  if (status === "paid") return "success";
  if (status === "cancelled" || status === "invalid") return "danger";
  return "warning";
}

export function invoiceStatusTone(status: string | null | undefined): MlTone {
  switch (status) {
    case "uploaded":
    case "approved":
      return "success";
    case "error":
      return "danger";
    case "queued":
      return "info";
    case "pending":
      return "warning";
    default:
      return "neutral";
  }
}

/** Monto neto de una venta de ML: total menos comisión y envío a cargo del vendedor. */
export function orderNet(total: number, fee: number | null | undefined, shipping: number | null | undefined): number {
  return Math.round((Number(total || 0) - Number(fee || 0) - Number(shipping || 0)) * 100) / 100;
}

const MESSAGES: Array<[RegExp, string]> = [
  [/ml_app_not_configured|platform_not_configured/, "Falta configurar la app de Mercado Libre. Avisale a soporte de NinjaSoft para que la active."],
  [/feature_not_in_plan/, "Mercado Libre no está incluido en tu plan."],
  [/ml_account_taken/, "Esa cuenta de Mercado Libre ya está conectada a otro negocio."],
  [/operator_user|invalid_operator/, "Conectá con el usuario administrador de la cuenta de Mercado Libre, no con un colaborador."],
  [/invalid_grant|reauth/, "La conexión con Mercado Libre venció: reconectá la cuenta."],
  [/rate_limited|local_rate_limited|429/, "Mercado Libre pidió bajar el ritmo. Probá de nuevo en unos segundos."],
  [/missing_permission/, "A la app de Mercado Libre le falta un permiso para esta acción."],
  [/kit_not_supported/, "Los combos no se pueden vincular a una publicación: vinculá cada producto."],
  [/variant_required/, "Elegí la variante del producto."],
  [/variant_not_found/, "La variante ya no existe."],
  [/variation_required/, "La publicación tiene variaciones: elegí cuál vincular."],
  [/product_not_found/, "El producto ya no existe."],
  [/item_not_found/, "La publicación ya no está en la lista."],
  [/already_answered/, "Esa pregunta ya se respondió."],
  [/invalid_text/, "La respuesta tiene que tener entre 2 y 2000 caracteres."],
  [/arca_not_enabled/, "Activá la facturación electrónica ARCA para facturar las ventas."],
  [/already_enqueued/, "Esa venta ya tiene una factura en camino."],
  [/invoice_not_approved/, "La factura todavía no está aprobada por ARCA."],
  [/fraud_risk/, "Mercado Libre detectó riesgo de fraude en la venta: no la despaches ni la factures."],
  [/no_sale/, "La orden todavía no tiene venta en el POS (falta el pago)."],
  [/invalid_store/, "Elegí una sucursal válida."],
  [/invalid_warehouse/, "El depósito no es de esa sucursal."],
  [/invalid_price_list/, "Elegí una lista de precios válida."],
  [/invalid_invoice_mode/, "Elegí cuándo facturar."],
  [/invalid_selection/, "Elegí entre 1 y 500 publicaciones."],
  [/invalid_action/, "Acción no válida."],
  [/forbidden|42501/, "No tenés permiso para hacer esto."],
  [/not_found/, "No se encontró el registro."],
  [/account_inactive/, "La cuenta del negocio está suspendida."],
  [/network|Failed to fetch/, "Sin conexión con el servidor. Probá de nuevo."],
];

function errorText(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object") {
    const o = e as { message?: unknown; error?: unknown; code?: unknown };
    return [o.error, o.message, o.code].filter((x) => typeof x === "string").join(" ");
  }
  return String(e);
}

/** Mensaje claro para un error del servidor o de la Edge. */
export function mlErrorMessage(e: unknown): string {
  const t = errorText(e);
  for (const [re, msg] of MESSAGES) if (re.test(t)) return msg;
  return t && t.length < 160 ? t : "No se pudo completar la operación con Mercado Libre.";
}
