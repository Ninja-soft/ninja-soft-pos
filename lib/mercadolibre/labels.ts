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
  [/feature_not_in_plan: mercadolibre_gestor|gestor_not_in_plan/, "El gestor de Mercado Libre (métricas, posventa y embudos) no está incluido en tu plan."],
  [/feature_not_in_plan/, "Mercado Libre no está incluido en tu plan."],
  [/price_list_required/, "Elegí la lista de precios del tipo de publicación."],
  [/invalid_listing_type/, "Hay un tipo de publicación repetido o no válido."],
  [/invalid_fixed_price/, "El precio fijo tiene que ser mayor a cero."],
  [/invalid_reserve_pct/, "El porcentaje a guardar va de 0 a 95."],
  [/invalid_max_qty/, "El tope tiene que ser un número entero, cero o más."],
  [/action_not_available/, "Mercado Libre ya no ofrece esa acción para este reclamo. Actualizá el detalle."],
  [/amount_changed/, "El monto cambió en Mercado Libre: revisalo antes de confirmar."],
  [/uncertain/, "No sabemos si Mercado Libre recibió la acción. Revisá el reclamo antes de reintentar."],
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

// ---------------------------------------------------------------------------
// Causas de /items/validate y POST /items ("codigo: mensaje" crudo de ML) en
// español claro con la acción a tomar. El código crudo se muestra aparte, en
// un detalle desplegable.
// ---------------------------------------------------------------------------
export interface MlCauseInfo {
  /** Qué pasa, en español. */
  message: string;
  /** Qué hacer. */
  action: string | null;
  /** Código de ML (p. ej. shipping.lost_me2_by_catalog). */
  code: string | null;
  /** Texto original de ML. */
  raw: string;
}

const attrInBrackets = (raw: string) => /\[([A-Z0-9_]+)\]/.exec(raw)?.[1] ?? null;

const CAUSES: Array<{ re: RegExp; message: (raw: string) => string; action: string | null }> = [
  // Envío
  {
    re: /^shipping\.lost_me2_by_(catalog|category)/i,
    message: () => "Esta categoría no admite Mercado Envíos.",
    action: "Elegí envío a convenir o con costo fijo.",
  },
  {
    re: /^shipping\.lost_me2_by_user/i,
    message: () => "Tu cuenta no tiene Mercado Envíos activo.",
    action: "Activalo en Mercado Libre (Configuración > Envíos) o elegí envío a convenir.",
  },
  {
    re: /^shipping\.lost_me1/i,
    message: () => "Tu cuenta no tiene Mercado Envíos 1 (envío propio con Mercado Libre).",
    action: "No hace falta activarlo: elegí envío a convenir o con costo fijo.",
  },
  {
    re: /^shipping\.(lost_custom|custom)/i,
    message: () => "Mercado Libre no acepta envío con costo fijo para esta publicación.",
    action: "Elegí envío a convenir.",
  },
  {
    re: /^shipping\..*free_shipping/i,
    message: () => "El envío gratis no se puede usar con este modo de envío.",
    action: "Sacá el envío gratis o usá Mercado Envíos.",
  },
  {
    re: /^shipping\..*(dimension|weight)/i,
    message: () => "Faltan o no sirven las medidas y el peso del paquete.",
    action: "Revisá las medidas del producto o elegí envío a convenir.",
  },
  { re: /^shipping\./i, message: () => "Mercado Libre rechazó la forma de envío.", action: "Probá con envío a convenir." },
  // Atributos
  {
    re: /^delete\.item\.attribute/i,
    message: (raw) => `El dato "${attrInBrackets(raw) ?? "atributo"}" no corresponde para esta categoría o condición.`,
    action: "Se saca solo al validar de nuevo.",
  },
  {
    re: /^item\.attributes?\.missing_(conditional_)?required/i,
    message: (raw) => `Falta un dato obligatorio de la categoría${attrInBrackets(raw) ? ` (${attrInBrackets(raw)})` : ""}.`,
    action: "Completalo en \"Datos que pide la categoría\".",
  },
  {
    re: /^item\.attributes?\..*(gtin|product_identifier)/i,
    message: () => "El código de barras (GTIN) no es válido para Mercado Libre.",
    action: "Revisá el código o elegí el motivo por el que no tiene.",
  },
  {
    re: /^item\.attributes?\./i,
    message: (raw) => `Un dato de la categoría no es válido${attrInBrackets(raw) ? ` (${attrInBrackets(raw)})` : ""}.`,
    action: "Revisá los valores elegidos y usá las opciones de la lista cuando las haya.",
  },
  // Precio
  {
    re: /^item\.price\..*(minimum|min)/i,
    message: () => "El precio está por debajo del mínimo de la categoría.",
    action: "Subí el precio.",
  },
  { re: /^item\.price\./i, message: () => "El precio no es válido.", action: "Cargá un precio mayor a cero, sin centavos raros." },
  // Título
  {
    re: /^item\.title\..*(length|max|min)/i,
    message: () => "El título es muy largo o muy corto para la categoría.",
    action: "Ajustá el largo del título.",
  },
  {
    re: /^item\.title\./i,
    message: () => "El título no cumple las reglas de Mercado Libre.",
    action: "Usá producto, marca y modelo. Sin stock, ofertas, envío ni cuotas.",
  },
  // Fotos
  {
    re: /^item\.pictures?\..*(download|source|invalid|size|resolution)/i,
    message: () => "Mercado Libre no pudo usar una de las fotos.",
    action: "Subí fotos JPG o PNG de al menos 500 px por lado en la pestaña Imágenes.",
  },
  { re: /^item\.pictures?\./i, message: () => "Hay un problema con las fotos.", action: "Revisá las fotos del producto (entre 1 y 12)." },
  // Otros frecuentes
  { re: /^item\.category_id\./i, message: () => "La categoría no es válida o no admite publicaciones.", action: "Elegí otra categoría." },
  { re: /^item\.listing_type_id\./i, message: () => "Ese tipo de publicación no está disponible.", action: "Elegí Clásica o Premium." },
  { re: /^item\.available_quantity\./i, message: () => "La cantidad no es válida.", action: "Cargá una cantidad mayor a cero." },
  { re: /^item\.(condition|attribute\.item_condition)/i, message: () => "La condición no es válida para la categoría.", action: "Elegí otra condición." },
  {
    re: /^seller\.|^user\.(unable|restricted|blocked)/i,
    message: () => "Tu cuenta de Mercado Libre no puede publicar en este momento.",
    action: "Revisá avisos o deudas pendientes en Mercado Libre.",
  },
];

/** Traduce una causa de ML ("codigo: mensaje"). */
export function mlCauseInfo(raw: string): MlCauseInfo {
  const text = String(raw ?? "").trim();
  const code = /^([a-z_][\w.]*\.[\w.]+)/i.exec(text)?.[1] ?? null;
  const hit = code ? CAUSES.find((c) => c.re.test(code)) : undefined;
  if (hit) return { message: hit.message(text), action: hit.action, code, raw: text };
  // Errores ya en español (chequeos del POS) o códigos que no conocemos.
  const msg = code ? text.slice(code.length).replace(/^\s*:\s*/, "") || text : text;
  return { message: msg || "Mercado Libre rechazó un dato.", action: null, code, raw: text };
}

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
