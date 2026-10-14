// Presupuestos (ADR-122). Lógica PURA: estados, número, totales, carrito ↔
// renglones, documento para el motor de comprobantes (ADR-112), mensajes de
// error y links para compartir. Sin React ni Supabase.

import type { InvoiceDoc, InvoiceLine } from "@/lib/invoices/types";
import { fmtDate } from "@/lib/invoices/legal";
import { serviceLineBlocks, unitLabel } from "@/lib/catalog/mode";
import { formatCurrency } from "@/lib/utils/format";

export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired" | "converted";

export const QUOTE_STATUSES: QuoteStatus[] = ["draft", "sent", "accepted", "rejected", "expired", "converted"];

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: "Borrador",
  sent: "Enviado",
  accepted: "Aceptado",
  rejected: "Rechazado",
  expired: "Vencido",
  converted: "Convertido",
};

export const QUOTE_STATUS_TONE: Record<QuoteStatus, "neutral" | "info" | "success" | "danger" | "warning" | "brand"> = {
  draft: "neutral",
  sent: "info",
  accepted: "success",
  rejected: "danger",
  expired: "warning",
  converted: "brand",
};

export interface QuoteItem {
  id?: string;
  sort?: number;
  product_id: string | null;
  variant_id?: string | null;
  variant_label?: string | null;
  name: string;
  sku?: string | null;
  quantity: number;
  unit_price: number;
  discount: number;
  subtotal: number;
  is_service: boolean;
  unit_label?: string | null;
  service_type_name?: string | null;
  line_detail?: string | null;
  line_note?: string | null;
  line_clarifications?: string[] | null;
  clarification_ids?: string[] | null;
}

export interface Quote {
  id: string;
  pto_vta: number;
  number: number;
  version: number;
  status: QuoteStatus;
  customer_id: string | null;
  customer_name: string | null;
  customer_doc: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  customer_iva: string | null;
  issue_date: string;
  /** ADR-123: null = sin vencimiento (precio de referencia, nunca vence). */
  valid_until: string | null;
  terms: string | null;
  notes: string | null;
  service_from: string | null;
  service_to: string | null;
  subtotal: number;
  discount_total: number;
  total: number;
  show_signature: boolean;
  public_token: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_via: "staff" | "link" | null;
  accepted_by_name: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  converted_sale_id: string | null;
  converted_at: string | null;
  parent_quote_id: string | null;
  created_at: string;
  updated_at: string;
  /** ADR-123: emails del cliente (destinatarios), customer_email = el primero. */
  customer_emails?: string[];
  /** ADR-123: quién emitió y quién lo modificó por última vez. */
  created_by?: string | null;
  created_by_name?: string | null;
  updated_by?: string | null;
  updated_by_name?: string | null;
  items?: QuoteItem[];
}

/** Hoy en Argentina (AAAA-MM-DD). */
export function todayArIso(now: Date = new Date()): string {
  return new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
}

/** Mismo criterio que quote_effective_status (SQL). */
export function effectiveQuoteStatus(status: QuoteStatus, validUntil: string | null, today: string = todayArIso()): QuoteStatus {
  // Sin vencimiento (ADR-123): nunca pasa a vencido.
  if ((status === "draft" || status === "sent") && validUntil && validUntil.slice(0, 10) < today) return "expired";
  return status;
}

/** "0001-00000012". */
export function quoteNumberLabel(ptoVta: number, number: number): string {
  return `${String(ptoVta).padStart(4, "0")}-${String(number).padStart(8, "0")}`;
}

/** ¿Se puede editar? Mientras no esté aceptado ni convertido. */
export const quoteEditable = (status: QuoteStatus) => status !== "accepted" && status !== "converted";

/** ¿Se puede convertir en venta? */
export const quoteConvertible = (eff: QuoteStatus) => eff === "draft" || eff === "sent" || eff === "accepted";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function lineSubtotal(l: { quantity: number; unit_price: number; discount?: number }): number {
  return r2(r2(l.quantity * l.unit_price) - (l.discount ?? 0));
}

/** Mismo cálculo que quote_save: suma de renglones menos el descuento general. */
export function quoteTotals(items: { quantity: number; unit_price: number; discount?: number }[], discountTotal = 0) {
  const subtotal = r2(items.reduce((a, l) => a + lineSubtotal(l), 0));
  const discount = Math.min(Math.max(0, r2(discountTotal)), subtotal);
  return { subtotal, discount, total: r2(subtotal - discount) };
}

/** Días entre dos fechas ISO (validez). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T12:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}

export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso.slice(0, 10)}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Carrito del POS ↔ renglones del presupuesto
// ---------------------------------------------------------------------------

/** Forma mínima de una línea del carrito (modules/pos/store CartLine). */
export interface CartLineLike {
  lineId: string;
  productId: string | null;
  name: string;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  discount: number;
  unit: string;
  variantId?: string | null;
  variantLabel?: string;
  packId?: string | null;
  packCreditId?: string | null;
  giftPromoId?: string | null;
  lineDetail?: string | null;
  clarificationIds?: string[];
  lineNote?: string | null;
  categoryId?: string | null;
  priceOverride?: boolean;
  overrideReason?: string | null;
  listPrice?: number | null;
}

/** Payload de quote_save desde el carrito (sin regalos ni sesiones de pack). */
export function cartToQuoteItems(lines: CartLineLike[]): Record<string, unknown>[] {
  return lines
    .filter((l) => !l.giftPromoId && !l.packCreditId && l.quantity > 0)
    .map((l) => ({
      ...(l.productId ? { product_id: l.productId } : {}),
      ...(l.variantId ? { variant_id: l.variantId } : {}),
      ...(l.variantLabel ? { variant_label: l.variantLabel } : {}),
      name: l.name,
      sku: l.sku,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      discount: Math.max(0, l.discount || 0),
      ...(l.lineNote?.trim() ? { line_note: l.lineNote.trim() } : {}),
      ...(l.lineDetail !== undefined ? { line_detail: l.lineDetail ?? "" } : {}),
      ...(l.clarificationIds !== undefined ? { clarification_ids: l.clarificationIds } : {}),
    }));
}

/**
 * Renglones del presupuesto → carrito del POS para cobrarlo. El precio es el
 * acordado: si el de lista actual es otro, la línea viaja como cambio manual
 * de precio con motivo (ADR-056: el servidor lo valida y pide PIN según la
 * política). Un ítem dado de baja entra como monto libre con su nombre.
 */
export function quoteItemsToCart(
  items: QuoteItem[],
  current: Map<string, { price: number; unit: string; category_id: string | null; active: boolean }>,
  reason: string,
  newId: () => string,
): CartLineLike[] {
  return items.map((it) => {
    const p = it.product_id ? current.get(it.product_id) : undefined;
    const base: CartLineLike = {
      lineId: newId(),
      productId: p?.active ? it.product_id : null,
      categoryId: p?.category_id ?? null,
      name: it.name,
      sku: it.sku ?? null,
      unitPrice: Number(it.unit_price),
      quantity: Number(it.quantity),
      discount: Number(it.discount) || 0,
      unit: p?.unit ?? "un",
      ...(it.variant_id && p?.active ? { variantId: it.variant_id } : {}),
      ...(it.variant_label ? { variantLabel: it.variant_label } : {}),
    };
    if (p?.active && !it.variant_id && Math.abs(Number(p.price) - Number(it.unit_price)) > 0.004) {
      base.priceOverride = true;
      base.overrideReason = reason;
      base.listPrice = Number(p.price);
    }
    if (it.is_service && p?.active) {
      base.lineDetail = it.line_detail ?? null;
      base.clarificationIds = it.clarification_ids ?? [];
      if (it.line_note) base.lineNote = it.line_note;
    } else if (it.line_note) {
      base.lineNote = it.line_note;
    }
    return base;
  });
}

// ---------------------------------------------------------------------------
// Documento para el motor de comprobantes (ADR-112)
// ---------------------------------------------------------------------------

export interface QuoteBrand {
  legal_name: string | null;
  trade_name?: string | null;
  cuit: string | null;
  address: string | null;
  phone: string | null;
  iva_condition?: string | null;
  iibb?: string | null;
  activity_start?: string | null;
  email?: string | null;
}

/** Texto debajo del nombre: tipo de servicio, detalle, aclaraciones y nota. */
export function quoteDetailLines(it: QuoteItem): { bullet: boolean; text: string }[] {
  return [
    ...(it.service_type_name ? [{ bullet: false, text: `Tipo: ${it.service_type_name}` }] : []),
    ...(it.variant_label ? [{ bullet: false, text: it.variant_label }] : []),
    ...serviceLineBlocks({ detail: it.line_detail, clarifications: it.line_clarifications, note: it.line_note }),
  ];
}

export const QUOTE_LEGEND = "PRESUPUESTO. No válido como factura.";

/** Leyenda de un presupuesto sin vencimiento (ADR-123). */
export const QUOTE_NO_EXPIRY_LEGEND = "Presupuesto de referencia: precios sujetos a cambio sin previo aviso.";

/** Validez en una línea ("Válido hasta el 29/10/2026" / "Precio de referencia, sujeto a cambios"). */
export function quoteValidityText(validUntil: string | null): string {
  return validUntil ? `Válido hasta el ${fmtDate(validUntil)}` : "Precio de referencia, sujeto a cambios";
}

/** Leyendas del presupuesto (validez y condiciones). */
export function quoteLegends(
  q: Pick<Quote, "valid_until" | "terms" | "version"> &
    Partial<
      Pick<
        Quote,
        "notes" | "service_from" | "service_to" | "show_signature" | "status" | "accepted_at" | "accepted_by_name" | "accepted_via" | "created_by_name"
      >
    >,
): string[] {
  const accepted = Boolean(q.accepted_at) && (q.status === "accepted" || q.status === "converted");
  return [
    q.valid_until ? `Válido hasta el ${fmtDate(q.valid_until)}.` : QUOTE_NO_EXPIRY_LEGEND,
    ...(q.created_by_name?.trim() ? [`Emitido por: ${q.created_by_name.trim()}.`] : []),
    ...(q.version > 1 ? [`Revisión ${q.version}.`] : []),
    ...(q.service_from ? [`Período del servicio: ${fmtDate(q.service_from)} al ${fmtDate(q.service_to ?? q.service_from)}.`] : []),
    ...(q.terms?.trim() ? [`Condiciones: ${q.terms.trim()}`] : []),
    ...(q.notes?.trim() ? [`Notas: ${q.notes.trim()}`] : []),
    ...(accepted
      ? [
          `Aceptado${q.accepted_by_name ? ` por ${q.accepted_by_name}` : ""} el ${fmtDate(q.accepted_at)}${q.accepted_via === "link" ? " (aceptación en línea)" : ""}.`,
        ]
      : q.show_signature
        ? [QUOTE_SIGNATURE]
        : []),
  ];
}

/** Espacio de aceptación del cliente (leyenda: el motor la dibuja en todos los modelos). */
export const QUOTE_SIGNATURE =
  "Acepto el presupuesto. Firma: ____________________  Aclaración: ____________________  Fecha: ____ / ____ / ______";

/**
 * InvoiceDoc no fiscal para los modelos de ticket del motor: título
 * "PRESUPUESTO", la leyenda "Documento no válido como factura" (NonFiscalNote)
 * y la validez y condiciones como leyendas.
 */
export function quoteToInvoiceDoc(
  q: Quote,
  items: QuoteItem[],
  brand: QuoteBrand | null,
  /** ADR-119: fotos de los productos por id (las muestra el motor si el negocio las prendió). */
  images?: Map<string, string> | null,
): InvoiceDoc {
  const lines: InvoiceLine[] = items.map((it, i) => {
    const detail = quoteDetailLines(it);
    const gross = Number(it.quantity) * Number(it.unit_price);
    return {
      code: String(i + 1).padStart(3, "0"),
      description: it.name,
      quantity: Number(it.quantity),
      unit: it.unit_label ? unitLabel(it.unit_label) : "unidad",
      unitPrice: Number(it.unit_price),
      discountPct: Number(it.discount) > 0 && gross > 0 ? Math.round((Number(it.discount) / gross) * 1000) / 10 : null,
      subtotal: Number(it.subtotal),
      ...(detail.length ? { detailLines: detail } : {}),
      ...(it.product_id && images?.get(it.product_id) ? { imageUrl: images.get(it.product_id)! } : {}),
    };
  });
  const numberText = quoteNumberLabel(q.pto_vta, q.number);
  return {
    fiscal: false,
    letter: "X",
    cbteClass: "no_fiscal",
    cbteCode: null,
    label: "Presupuesto",
    ptoVta: "",
    number: numberText,
    // Fecha sola (sin hora) y sin concepto: un presupuesto no "factura" un
    // período (la hoja A4 lo muestra como "Período del servicio").
    date: q.issue_date.slice(0, 10),
    concepto: null,
    servicePeriod: q.service_from ? { from: q.service_from, to: q.service_to ?? q.service_from } : null,
    paymentDue: null,
    saleCondition: "A convenir",
    currency: { code: "ARS" },
    issuer: {
      name: brand?.legal_name?.trim() || brand?.trade_name || "Mi negocio",
      tradeName: brand?.trade_name ?? null,
      cuit: brand?.cuit ?? null,
      ivaCondition: brand?.iva_condition ?? null,
      address: brand?.address ?? null,
      phone: brand?.phone ?? null,
      email: brand?.email ?? null,
    },
    receiver: {
      name: q.customer_name?.trim() || "Consumidor Final",
      ivaCondition: q.customer_iva ?? "consumidor_final",
      docNumber: q.customer_doc ?? null,
      docType: q.customer_doc ? q.customer_doc.split(" ")[0] ?? null : null,
      address: q.customer_address ?? null,
      email: q.customer_emails?.length ? q.customer_emails.join(", ") : (q.customer_email ?? null),
    },
    lines,
    totals: {
      subtotal: Number(q.subtotal),
      discounts: Number(q.discount_total) > 0 ? [{ label: "Descuento", amount: Number(q.discount_total) }] : [],
      iva: [],
      otherTaxes: [],
      total: Number(q.total),
    },
    transparency: null,
    authorization: null,
    qrUrl: null,
    qrFallbackText: `Presupuesto ${numberText} | ${formatCurrency(Number(q.total))} | ${q.valid_until ? `válido hasta ${fmtDate(q.valid_until)}` : "precio de referencia"}`,
    associated: [],
    payments: [],
    footer: null,
    legends: quoteLegends(q),
    internalRef: null,
    branchText: null,
    voided: false,
  };
}

// ---------------------------------------------------------------------------
// Compartir
// ---------------------------------------------------------------------------

export function publicQuoteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/presupuesto/${token}`;
}

/** Teléfono para wa.me: sólo dígitos; un celular argentino sin prefijo suma 549. */
export function whatsappPhone(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length < 8) return null;
  if (d.startsWith("54")) return d;
  const local = d.replace(/^0/, "").replace(/^(\d{2,4})15/, "$1");
  return `549${local}`;
}

export function quoteShareText(q: Pick<Quote, "pto_vta" | "number" | "total" | "valid_until">, businessName: string, url: string | null): string {
  return [
    `Hola, te enviamos el presupuesto N° ${quoteNumberLabel(q.pto_vta, q.number)} de ${businessName} por ${formatCurrency(Number(q.total))}, ${q.valid_until ? `válido hasta el ${fmtDate(q.valid_until)}` : "como precio de referencia sujeto a cambios"}.`,
    ...(url ? [`Podés verlo y aceptarlo acá: ${url}`] : []),
  ].join("\n");
}

export function whatsappUrl(phone: string | null, text: string): string {
  const p = whatsappPhone(phone);
  return `https://wa.me/${p ?? ""}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------
// Envío por email (ADR-123)
// ---------------------------------------------------------------------------

export const QUOTE_EMAIL_MAX_RECIPIENTS = 10;

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export const isEmail = (s: string) => s.trim().length <= 160 && EMAIL_RE.test(s.trim());

/**
 * Separa lo escrito en emails (coma, punto y coma, espacio o salto de línea),
 * en minúscula, sin repetir. Devuelve los válidos y lo que no se entendió.
 */
export function parseEmails(raw: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const e = part.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!e) continue;
    if (!isEmail(e)) invalid.push(part.trim());
    else if (!valid.includes(e)) valid.push(e);
  }
  return { valid, invalid };
}

/** Emails del cliente de un presupuesto (los nuevos o el email suelto). */
export function quoteRecipients(q: Pick<Quote, "customer_email"> & Partial<Pick<Quote, "customer_emails">>): string[] {
  if (q.customer_emails?.length) return q.customer_emails;
  return q.customer_email ? parseEmails(q.customer_email).valid : [];
}

export const QUOTE_EMAIL_DEFAULT_SUBJECT = "Presupuesto N° {numero} de {negocio}";

export const QUOTE_EMAIL_DEFAULT_MESSAGE = [
  "Hola {cliente},",
  "",
  "Te enviamos el presupuesto N° {numero} por {total}. {validez}.",
  "",
  "Te lo adjuntamos en PDF y también lo podés ver y aceptar en línea con el botón de abajo.",
  "",
  "Cualquier consulta, respondé este email.",
  "",
  "Saludos,",
  "{emisor}",
  "{negocio}",
].join("\n");

/** Variables de la plantilla del email (las muestra Configuración). */
export const QUOTE_EMAIL_VARS = ["{cliente}", "{numero}", "{total}", "{validez}", "{emisor}", "{negocio}"] as const;

export interface QuoteEmailVars {
  cliente: string;
  numero: string;
  total: string;
  validez: string;
  emisor: string;
  negocio: string;
}

export function quoteEmailVars(
  q: Pick<Quote, "pto_vta" | "number" | "total" | "valid_until" | "customer_name"> & Partial<Pick<Quote, "created_by_name">>,
  businessName: string,
  issuer?: string | null,
): QuoteEmailVars {
  return {
    cliente: q.customer_name?.trim() || "",
    numero: quoteNumberLabel(q.pto_vta, q.number),
    total: formatCurrency(Number(q.total)),
    validez: quoteValidityText(q.valid_until),
    emisor: (issuer ?? q.created_by_name ?? "").trim(),
    negocio: businessName.trim(),
  };
}

const VAR_RE = /\{(cliente|numero|total|validez|emisor|negocio)\}/g;

/**
 * Completa la plantilla: {variable} → valor. Sin cliente, "Hola {cliente},"
 * queda "Hola,"; una línea que queda vacía por una variable vacía se va.
 */
export function fillQuoteTemplate(tpl: string, v: QuoteEmailVars): string {
  const out: string[] = [];
  for (const line of tpl.replace(/\r\n/g, "\n").split("\n")) {
    const hadVar = /\{(cliente|numero|total|validez|emisor|negocio)\}/.test(line);
    const filled = line
      .replace(VAR_RE, (_, k: keyof QuoteEmailVars) => v[k] ?? "")
      .replace(/[ \t]+,/g, ",")
      .replace(/\.\./g, ".")
      .replace(/[ \t]{2,}/g, " ")
      .trimEnd();
    if (hadVar && filled.trim() === "") continue;
    out.push(filled);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Errores de las RPC
// ---------------------------------------------------------------------------

const ERRORS: Record<string, string> = {
  feature_not_in_plan: "Los presupuestos no están incluidos en tu plan.",
  forbidden_read_only: "Tu usuario es de solo lectura.",
  forbidden_role: "No tenés permiso para hacer esto.",
  quote_not_found: "No encontramos el presupuesto.",
  quote_locked: "Un presupuesto aceptado o convertido no se puede cambiar.",
  quote_items_invalid: "Agregá al menos un renglón (hasta 200).",
  quote_item_invalid: "Revisá cantidades, precios y descuentos de los renglones.",
  quote_item_name_required: "Cada renglón necesita un nombre.",
  quote_validity_invalid: "La validez tiene que ser desde hoy y hasta un año.",
  quote_discount_invalid: "El descuento no puede superar el subtotal.",
  quote_status_invalid: "El presupuesto no admite ese cambio de estado.",
  quote_expired: "El presupuesto está vencido: editalo para extender la validez.",
  quote_already_converted: "El presupuesto ya se convirtió en otra venta.",
  quote_already_answered: "Este presupuesto ya fue respondido.",
  quote_name_required: "Escribí tu nombre para aceptar.",
  customer_not_found: "No encontramos el cliente.",
  product_not_found: "Uno de los productos ya no existe.",
  sale_not_found: "No encontramos la venta.",
  service_period_invalid: "Revisá el período del servicio.",
  quote_email_invalid: "Revisá los emails del cliente (hasta 10, separados por coma).",
  quote_email_subject_required: "Escribí el asunto del email.",
  quote_email_limit: "Llegaste al tope de envíos por email de hoy. Probá mañana o mandalo por WhatsApp.",
  invalid_pdf: "No se pudo generar el PDF del presupuesto.",
  pdf_too_large: "El PDF es muy pesado para mandarlo por email. Probá sin fotos o en formato ticket.",
  send_failed: "El proveedor de email no pudo enviarlo. Revisá Configuración → Email o probá de nuevo.",
};

export function quoteErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  for (const [code, text] of Object.entries(ERRORS)) if (msg.includes(code)) return text;
  return "No se pudo completar la operación.";
}
