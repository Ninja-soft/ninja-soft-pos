// =============================================================================
// Facturación de Mercado Libre (ADR-141). PURO: textos, filtros y qué se puede
// hacer con cada venta de la bandeja. El servidor decide de verdad.
// =============================================================================
import { letterOptions, type LetterOption } from "@/lib/billing/cbteOptions";
import type {
  CouponMode,
  LogisticKind,
  MlInvoicePlan,
  PerceptionStrategy,
  PlanReceptor,
  ReceptorChoice,
} from "@/supabase/functions/_shared/mercadolibre/invoicePlan";

export type { MlInvoicePlan, PlanReceptor, ReceptorChoice };

export type InboxFilter = "todo" | "por_facturar" | "percepcion" | "revisar" | "error" | "facturadas" | "omitidas";

export const INBOX_FILTERS: Array<{ key: InboxFilter; label: string }> = [
  { key: "por_facturar", label: "Por facturar" },
  { key: "percepcion", label: "Esperando percepción" },
  { key: "revisar", label: "A revisar" },
  { key: "error", label: "Con error" },
  { key: "facturadas", label: "Facturadas" },
  { key: "omitidas", label: "No se facturan" },
  { key: "todo", label: "Todas" },
];

export const PLAN_STATUS_LABELS: Record<string, string> = {
  ready: "Lista para facturar",
  hold_perception: "Esperando la percepción",
  needs_review: "A revisar",
  blocked: "Jurisdicción bloqueada",
  queued: "Facturando",
  approved: "Facturada",
  error: "Con error",
  skipped: "No se factura",
  cancelled: "Cancelada",
};

export function planStatusTone(s: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (s === "approved") return "success";
  if (s === "queued") return "info";
  if (s === "error" || s === "blocked") return "danger";
  if (s === "needs_review" || s === "hold_perception") return "warning";
  return "neutral";
}

export const WARNING_LABELS: Record<string, string> = {
  paid_mismatch: "Lo cobrado no cierra con la factura",
  shipping_a_convenir: "Envío a convenir: si el comprador te paga el envío aparte, facturalo aparte",
  coupon_not_deducted: "El cupón no se descuenta de la factura",
  emitter_not_configured: "Faltan la condición frente al IVA y el CUIT del negocio",
  cf_identification_required: "Por el monto, el consumidor final tiene que estar identificado",
  cf_company_cuit: "Empresa como consumidor final: pedile un DNI o facturale con sus datos",
  perception_skipped: "Se factura sin percibir IIBB",
  perception_expired: "El link de la percepción venció",
  perception_paid_late: "La percepción se pagó después de vencer o cancelarse: revisala",
  blocked_jurisdiction: "El envío va a una jurisdicción que no facturás",
  invalid_cuit: "El CUIT que cargó el comprador no es válido",
  foreign_document: "Documento extranjero: revisá los datos",
  empty_invoice: "La factura queda en cero",
  refund_review: "Reintegro en Mercado Libre: revisá la nota de crédito",
  amounts_changed: "La orden cambió en Mercado Libre después de entrar al POS: revisá los importes",
};

export const warningLabel = (w: string) => WARNING_LABELS[w] ?? w;

/** Advertencias que frenan la factura automática (rojo) o sólo avisan. */
export const BLOCKING_WARNINGS = new Set([
  "paid_mismatch", "emitter_not_configured", "cf_identification_required", "cf_company_cuit", "empty_invoice", "blocked_jurisdiction",
  "amounts_changed",
]);

export const INVOICE_MODES: Array<{ key: string; label: string; hint: string; pro?: boolean }> = [
  { key: "on_paid", label: "Al pagarse", hint: "Apenas Mercado Libre confirma el pago." },
  { key: "on_shipped", label: "Al despacharse", hint: "Cuando el envío sale (o se entrega)." },
  { key: "on_delivered", label: "Al entregarse", hint: "Recién cuando el comprador recibe.", pro: true },
  { key: "manual", label: "A mano, por lote", hint: "Quedan en la bandeja y facturás las que elijas." },
  { key: "none", label: "No facturar", hint: "Las ventas entran sin factura." },
];

export const COUPON_MODES: Array<{ key: CouponMode; label: string; hint: string }> = [
  { key: "discount_line", label: "Renglón de descuento", hint: "Los productos a su precio y el cupón como descuento (como ANDESMAR)." },
  { key: "prorate", label: "Repartido en los precios", hint: "El cupón baja el precio de cada producto en proporción." },
  { key: "none", label: "No descontar", hint: "Se factura el precio completo (si tu contador lo indica cuando el cupón lo paga Mercado Libre)." },
];

export const LOGISTIC_LABELS: Record<LogisticKind, string> = {
  me2: "Mercado Envíos",
  me1: "Envío propio (ME1)",
  custom: "Envío propio",
  a_convenir: "A convenir",
  flex: "Flex",
  full: "Full",
  none: "Sin envío",
};

export const STRATEGY_LABELS: Record<PerceptionStrategy, string> = {
  link: "Cobrar por link antes de facturar A",
  invoice_b: "Facturar B sin percepción",
  skip: "Facturar A sin percibir",
};

export const RECEPTOR_CHOICE_LABELS: Record<ReceptorChoice, string> = {
  billing: "Con los datos del comprador",
  consumidor_final: "A consumidor final",
};

export const SOURCE_LABELS: Record<PlanReceptor["source"], string> = {
  ml: "Datos de facturación de Mercado Libre",
  padron: "Verificado con el padrón de ARCA",
  cf: "Consumidor final con documento",
  cf_generic: "Consumidor final sin identificar",
};

export const PERC_CONDITIONS: Array<{ key: string; label: string }> = [
  { key: "responsable_inscripto", label: "Responsable Inscripto" },
  { key: "monotributo", label: "Monotributo" },
  { key: "exento", label: "Exento" },
];

export interface InboxRow {
  id: string;
  pack_key: string;
  sale_id: string | null;
  sale_number: number | null;
  status: string;
  warnings: string[];
  choice: ReceptorChoice;
  letter: string | null;
  pto_vta: number | null;
  concepto: number | null;
  pdf_format: "a4" | "ticket" | null;
  perception_mode: "charge" | "skip";
  last_error: string | null;
  skip_reason: string | null;
  created_at: string;
  emitted_at: string | null;
  plan: MlInvoicePlan;
  orders: Array<{ ml_order_id: number; status: string; buyer_nickname: string | null; date_created: string | null; total_amount: number; fraud_risk: boolean; needs_review: string | null }> | null;
  document: { id: string; status: string; letter: string | null; pto_vta: number | null; nro: number | null; cae: string | null; error_code: string | null; error_msg: string | null; total: number } | null;
  documents: Array<{
    id: string;
    origin: "sale" | "return" | "void";
    status: string;
    letter: string | null;
    cbte_tipo: number | null;
    pto_vta: number | null;
    nro: number | null;
    total: number;
    upload: { id: string; sync: boolean; status: string; ml_doc_id: string | null; last_error: string | null; uploaded_at: string | null } | null;
  }>;
  charge: {
    id: string;
    status: string;
    amount: number;
    init_point: string | null;
    expires_at: string | null;
    paid_at: string | null;
    provider: string;
    message_sent_at: string | null;
    message_error: string | null;
  } | null;
}

export interface InboxCounts {
  por_facturar: number;
  percepcion: number;
  revisar: number;
  error: number;
  facturadas: number;
  omitidas: number;
}

/** Letra que va a salir (la elegida o la sugerida del receptor elegido). */
export function effectiveLetter(row: Pick<InboxRow, "letter" | "choice" | "plan">): string | null {
  return row.letter ?? row.plan.receptors[row.choice]?.letter ?? null;
}

/** Opciones de letra para el receptor elegido, con la matriz de ARCA (ADR-133). */
export function letterChoices(
  emitter: string | null | undefined,
  receptor: PlanReceptor,
  issuesM: boolean,
): LetterOption[] {
  const hasCuit = receptor.doc_type === "cuit" && (receptor.doc_number ?? "").length === 11;
  return letterOptions(emitter, receptor.iva_condition, { hasCuit, issuesM });
}

export function canEmit(row: Pick<InboxRow, "status" | "document" | "plan" | "choice" | "perception_mode" | "charge">): boolean {
  if (row.document) return false;
  if (!["ready", "needs_review", "error", "hold_perception"].includes(row.status)) return false;
  if (row.status === "hold_perception") {
    return row.choice !== "billing" || row.perception_mode === "skip" || ["paid", "paid_manual"].includes(row.charge?.status ?? "");
  }
  return true;
}

export const isSelectable = (row: Pick<InboxRow, "status" | "document">) =>
  !row.document && ["ready", "needs_review", "error", "hold_perception", "blocked", "skipped"].includes(row.status);

/** Texto del receptor: "EMPRESA SA · CUIT 30712345671". */
export function receptorLine(r: PlanReceptor): string {
  const doc = r.doc_number ? `${(r.doc_type ?? "doc").toUpperCase()} ${r.doc_number}` : "sin documento";
  return `${r.name} · ${doc}`;
}

/** Número del comprobante: "A 00007-00000012". */
export function docNumber(d: { letter: string | null; pto_vta: number | null; nro: number | null }): string {
  if (!d.nro || !d.pto_vta) return d.letter ?? "";
  return `${d.letter ?? ""} ${String(d.pto_vta).padStart(5, "0")}-${String(d.nro).padStart(8, "0")}`.trim();
}

export const DOC_ORIGIN_LABELS: Record<string, string> = {
  sale: "Factura",
  void: "Nota de crédito",
  return: "Nota de crédito",
};

export const UPLOAD_STATUS_LABELS: Record<string, string> = {
  pending: "Para subir",
  queued: "Subiendo",
  uploaded: "Subida a la venta",
  error: "No se pudo subir",
  skipped: "No se sube",
};

export const BILLING_ERRORS: Array<[RegExp, string]> = [
  [/perception_pending/, "Falta cobrar la percepción (o elegí facturar B o sin percibir)."],
  [/perception_mismatch/, "Lo cobrado por la percepción no coincide con la factura."],
  [/letter_condicion_receptor_no_valida/, "ARCA no acepta esa letra para la condición del comprador."],
  [/letter_receptor_sin_cuit/, "La factura A necesita el CUIT del comprador."],
  [/letter_/, "ARCA no acepta esa letra para esta venta."],
  [/cf_identification_required/, "Por el monto, el consumidor final tiene que estar identificado."],
  [/already_invoiced/, "Esta venta ya tiene factura."],
  [/arca_not_enabled/, "Activá la facturación electrónica en Configuración."],
  [/needs_review/, "Está para revisar: abrila y emitila a mano."],
  [/blocked_jurisdiction/, "La jurisdicción del envío está bloqueada para facturar."],
  [/fraud_risk/, "Mercado Libre detectó riesgo de fraude."],
  [/no_sale/, "La venta todavía no entró al POS."],
  [/mp_not_connected/, "Conectá Mercado Pago para crear links de pago."],
  [/payment_method_not_allowed/, "Tu plan no incluye Mercado Pago."],
  [/billing_not_in_plan|mercadolibre_facturacion/, "Tu plan no incluye la facturación de Mercado Libre."],
  [/percepciones_retenciones/, "Tu plan no incluye percepciones y retenciones."],
  [/reference_required/, "Escribí la referencia del cobro."],
  [/credit_note_exists/, "Esta venta ya tiene nota de crédito."],
  [/invoice_not_approved/, "La factura todavía no está aprobada por ARCA."],
  [/no_open_link/, "No hay un link de pago abierto."],
  [/message_failed/, "No se pudo mandar el mensaje: copiá el link y mandalo vos."],
];

export function billingErrorMessage(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  for (const [re, text] of BILLING_ERRORS) if (re.test(msg)) return text;
  return null;
}
