// =============================================================================
// _shared/mercadolibre/orders.ts (H87 · ADR-104). PURO.
//
// De la orden de ML a la venta del POS:
//   • normalizeBilling: datos fiscales del comprador, formato nuevo
//     (GET /orders/billing-info/MLA/{id}) y anterior (GET /orders/{id}/billing_info).
//   • receptorIva / expectedLetter: el campo invoice_type ya no existe; la
//     regla de ML para MLA es CUIT -> Factura A y DNI -> Factura B (emisor
//     Responsable Inscripto). Un emisor monotributista emite C siempre. Espejo
//     de cbte_letter_infer (SQL), que es quien decide de verdad en la venta.
//   • buildPackPayload: el carrito (pack) es la unidad de facturación de ML:
//     UNA venta del POS por pack (o por orden si no tiene pack). Es lo que
//     recibe la RPC ml_ingest_pack.
//   • packDecision: espejo de la regla de la RPC (crear venta, esperar,
//     cancelar o bloquear por fraude).
//   • normalizeShipment / labelBlocker: estado del envío y si se puede
//     imprimir la etiqueta ME2.
// =============================================================================
import type { MlBillingInfoLegacy, MlBillingInfoNew, MlOrder, MlShipment } from "./types.ts";

export type IvaCondition =
  | "consumidor_final"
  | "responsable_inscripto"
  | "monotributo"
  | "monotributo_social"
  | "exento"
  | "no_alcanzado"
  | "no_categorizado";

export type DocType = "cuit" | "cuil" | "dni" | "passport" | "other";

export interface BillingNormalized {
  docType: DocType | null;
  docNumber: string | null;
  name: string;
  ivaCondition: IvaCondition;
  taxpayerRaw: string | null;
  address: string | null;
  /** Provincia de facturación (jurisdicción de IIBB, ADR-141). */
  state?: string | null;
}

const clean = (s: unknown): string => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

export function docTypeOf(raw: unknown): DocType | null {
  const t = clean(raw).toUpperCase();
  if (!t) return null;
  if (t === "CUIT") return "cuit";
  if (t === "CUIL") return "cuil";
  if (t === "DNI" || t === "LE" || t === "LC" || t === "CI") return "dni";
  if (t.startsWith("PAS")) return "passport";
  return "other";
}

/** Condición frente al IVA desde el taxpayer_type de ML (texto libre) y el documento. */
export function receptorIva(taxpayer: string | null | undefined, docType: DocType | null): IvaCondition {
  const t = clean(taxpayer)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (t.includes("inscripto")) return "responsable_inscripto";
  if (t.includes("monotribut")) return t.includes("social") ? "monotributo_social" : "monotributo";
  if (t.includes("exento")) return "exento";
  if (t.includes("no alcanzado")) return "no_alcanzado";
  if (t.includes("consumidor final")) return "consumidor_final";
  if (t.includes("no categorizado")) return "no_categorizado";
  // Sin condición informada: la regla de ML para MLA (CUIT -> A).
  return docType === "cuit" ? "responsable_inscripto" : "consumidor_final";
}

/** Letra esperada (espejo de cbte_letter_infer). null = el negocio no tiene condición cargada. */
export function expectedLetter(emitterIva: string | null | undefined, receptor: IvaCondition): "A" | "B" | "C" | null {
  if (!emitterIva) return null;
  if (emitterIva !== "responsable_inscripto") return "C";
  return receptor === "responsable_inscripto" || receptor === "monotributo" || receptor === "monotributo_social" ? "A" : "B";
}

function joinAddress(parts: Array<string | undefined>): string | null {
  const s = parts.map(clean).filter(Boolean).join(", ");
  return s ? s.slice(0, 300) : null;
}

export function normalizeBilling(
  raw: MlBillingInfoNew | MlBillingInfoLegacy | null | undefined,
  fallbackName = "",
): BillingNormalized | null {
  if (!raw) return null;
  const nb = (raw as MlBillingInfoNew).buyer?.billing_info;
  if (nb) {
    const docType = docTypeOf(nb.identification?.type);
    const docNumber = clean(nb.identification?.number).replace(/\D/g, "") || null;
    const business = clean(nb.attributes?.business_name);
    const person = [clean(nb.name), clean(nb.last_name)].filter(Boolean).join(" ");
    const taxpayer = clean(nb.taxes?.taxpayer_type?.description) || null;
    const a = nb.address;
    return {
      docType,
      docNumber,
      name: (business || person || fallbackName || "Comprador de Mercado Libre").slice(0, 200),
      ivaCondition: receptorIva(taxpayer, docType),
      taxpayerRaw: taxpayer,
      address: a ? joinAddress([[a.street_name, a.street_number].map(clean).join(" "), a.city_name, a.state?.name, a.zip_code]) : null,
      state: clean(a?.state?.name) || null,
    };
  }
  const lb = (raw as MlBillingInfoLegacy).billing_info;
  if (lb) {
    const info = new Map((lb.additional_info ?? []).map((x) => [clean(x.type).toUpperCase(), clean(x.value)]));
    const docType = docTypeOf(lb.doc_type);
    const docNumber = clean(lb.doc_number).replace(/\D/g, "") || null;
    const person = [info.get("FIRST_NAME"), info.get("LAST_NAME")].filter(Boolean).join(" ");
    const taxpayer = info.get("TAXPAYER_TYPE_ID") || null;
    return {
      docType,
      docNumber,
      name: (info.get("BUSINESS_NAME") || person || fallbackName || "Comprador de Mercado Libre").slice(0, 200),
      ivaCondition: receptorIva(taxpayer, docType),
      taxpayerRaw: taxpayer,
      address: joinAddress([
        [info.get("STREET_NAME"), info.get("STREET_NUMBER")].filter(Boolean).join(" "),
        info.get("CITY_NAME"),
        info.get("STATE_NAME"),
        info.get("ZIP_CODE"),
      ]),
      state: info.get("STATE_NAME") || null,
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Pack -> venta.
// -----------------------------------------------------------------------------
export interface PackLine {
  ml_order_id: string;
  ml_item_id: string;
  ml_variation_id: string | null;
  title: string;
  seller_sku: string | null;
  quantity: number;
  unit_price: number;
  sale_fee: number;
}

export interface PackOrder {
  ml_order_id: string;
  status: string;
  status_detail: string | null;
  tags: string[];
  date_created: string;
  date_closed: string | null;
  last_updated: string | null;
  total_amount: number;
  paid_amount: number;
  currency: string;
  fraud_risk: boolean;
  cancel_detail: Record<string, unknown> | null;
  buyer: { id: string; nickname: string | null };
  shipment_id: string | null;
  sale_fee_total: number;
  lines: PackLine[];
  /** Pagos (ADR-141): cupón y envío para armar y controlar la factura. */
  payments: Array<{ id: string; status: string; transaction_amount: number; coupon_amount: number; shipping_cost: number }>;
  coupon_amount: number;
  shipping_paid: number;
}

export interface ShipmentNormalized {
  shipment_id: string;
  mode: string | null;
  logistic_type: string | null;
  status: string;
  substatus: string | null;
  tracking_number: string | null;
  tracking_method: string | null;
  cost: number | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  date_created: string | null;
  order_id: string | null;
}

export interface PackPayload {
  pack_key: string;
  pack_id: string | null;
  orders: PackOrder[];
  shipment: ShipmentNormalized | null;
  billing: BillingNormalized | null;
}

const money = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
};
const idStr = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  return /^\d{1,22}$/.test(s) ? s : null;
};

export function isFraud(o: Pick<MlOrder, "tags">): boolean {
  return (o.tags ?? []).includes("fraud_risk_detected");
}

export function orderToPackOrder(o: MlOrder): PackOrder {
  const lines: PackLine[] = (o.order_items ?? []).map((it) => ({
    ml_order_id: String(o.id),
    ml_item_id: String(it.item.id),
    ml_variation_id: idStr(it.item.variation_id),
    title: clean(it.item.title).slice(0, 250) || String(it.item.id),
    seller_sku: clean(it.item.seller_sku ?? it.item.seller_custom_field) || null,
    quantity: Math.max(0, Number(it.quantity) || 0),
    unit_price: money(it.unit_price),
    sale_fee: money(it.sale_fee),
  }));
  const payments = (o.payments ?? []).slice(0, 20).map((p) => ({
    id: String(p.id),
    status: clean(p.status) || "unknown",
    transaction_amount: money(p.transaction_amount ?? 0),
    coupon_amount: money(p.coupon_amount ?? 0),
    shipping_cost: money(p.shipping_cost ?? 0),
  }));
  const approved = payments.filter((p) => p.status === "approved");
  return {
    ml_order_id: String(o.id),
    status: clean(o.status) || "unknown",
    status_detail: clean(o.status_detail) || null,
    tags: (o.tags ?? []).filter((t) => typeof t === "string").slice(0, 30),
    date_created: o.date_created,
    date_closed: o.date_closed ?? null,
    last_updated: o.last_updated ?? null,
    total_amount: money(o.total_amount),
    paid_amount: money(o.paid_amount ?? 0),
    currency: o.currency_id ?? "ARS",
    fraud_risk: isFraud(o),
    cancel_detail: (o.cancel_detail as Record<string, unknown> | null | undefined) ?? null,
    buyer: { id: String(o.buyer?.id ?? ""), nickname: o.buyer?.nickname ?? null },
    shipment_id: idStr(o.shipping?.id),
    // sale_fee viene por unidad: comisión total = fee x cantidad.
    sale_fee_total: money(lines.reduce((s, l) => s + l.sale_fee * l.quantity, 0)),
    lines,
    payments,
    coupon_amount: money(approved.reduce((s, p) => s + p.coupon_amount, 0)),
    shipping_paid: money(approved.reduce((s, p) => s + p.shipping_cost, 0)),
  };
}

export function packKeyOf(o: Pick<MlOrder, "id" | "pack_id">): string {
  return idStr(o.pack_id) ?? String(o.id);
}

export function buildPackPayload(
  orders: MlOrder[],
  shipment: ShipmentNormalized | null,
  billing: BillingNormalized | null,
): PackPayload {
  if (orders.length === 0) throw new Error("pack_without_orders");
  const first = orders[0]!;
  const packId = idStr(first.pack_id);
  const sorted = [...orders].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    pack_key: packKeyOf(first),
    pack_id: packId,
    orders: sorted.map(orderToPackOrder),
    shipment,
    billing,
  };
}

export type PackDecision = "create_sale" | "wait_payment" | "fraud" | "cancel" | "partial_cancel" | "noop";

/**
 * Qué hace la RPC con el pack (espejo de ml_ingest_pack):
 *   • fraude en alguna orden: no se crea la venta ni se imprime etiqueta.
 *   • todas canceladas: se revierte (si había venta, se anula).
 *   • alguna cancelada y otra no: se revierte lo cancelado y queda para revisar.
 *   • todas pagadas: se crea la venta (si no existe).
 *   • si no: se espera el pago.
 */
export function packDecision(p: Pick<PackPayload, "orders">, hasSale: boolean): PackDecision {
  const st = p.orders.map((o) => o.status);
  if (p.orders.some((o) => o.fraud_risk) && !hasSale) return "fraud";
  if (st.length > 0 && st.every((s) => s === "cancelled" || s === "invalid")) return "cancel";
  if (st.some((s) => s === "cancelled" || s === "invalid")) return "partial_cancel";
  if (hasSale) return "noop";
  if (st.length > 0 && st.every((s) => s === "paid")) return "create_sale";
  return "wait_payment";
}

export function normalizeShipment(s: MlShipment): ShipmentNormalized {
  const addr = s.destination?.receiver_address ?? s.receiver_address ?? null;
  const cost = s.lead_time?.cost ?? s.shipping_option?.cost ?? null;
  return {
    shipment_id: String(s.id),
    mode: clean(s.logistic?.mode ?? s.mode) || null,
    logistic_type: clean(s.logistic?.type ?? s.logistic_type) || null,
    status: clean(s.status) || "unknown",
    substatus: clean(s.substatus) || null,
    tracking_number: clean(s.tracking_number) || null,
    tracking_method: clean(s.tracking_method) || null,
    cost: cost === null || cost === undefined ? null : money(cost),
    city: clean(addr?.city?.name) || null,
    state: clean(addr?.state?.name) || null,
    zip: clean(addr?.zip_code) || null,
    date_created: s.date_created ?? null,
    order_id: idStr(s.order_id),
  };
}

export type LabelBlocker = "fraud" | "not_me2" | "fulfillment" | "not_ready" | null;

/** ¿Se puede imprimir la etiqueta? (doc ME2: me2 + ready_to_ship + ready_to_print|printed, nunca Full). */
export function labelBlocker(sh: Pick<ShipmentNormalized, "mode" | "logistic_type" | "status" | "substatus">, fraud: boolean): LabelBlocker {
  if (fraud) return "fraud";
  if (sh.mode !== "me2") return "not_me2";
  if (sh.logistic_type === "fulfillment") return "fulfillment";
  if (sh.status !== "ready_to_ship" || !["ready_to_print", "printed"].includes(sh.substatus ?? "")) return "not_ready";
  return null;
}

/** Lotes de hasta 50 envíos por llamada a /shipment_labels. */
export function labelBatches<T>(ids: T[], size = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
