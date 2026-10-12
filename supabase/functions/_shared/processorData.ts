// =============================================================================
// _shared/processorData.ts: datos de un cobro según el procesador (ADR-061).
//
// Normaliza la respuesta de cada API (Mercado Pago, Payway, Nave, GO Cuotas,
// Clover, Getnet) a una forma única que muestra el detalle de la venta
// ("Datos del procesador") y que usa la conciliación de procesadores
// (settlement_lines). Comisiones, impuestos, neto, fecha de acreditación,
// cuotas, tarjeta, pagador y línea de tiempo.
//
// Archivo PURO y SIN imports: lo usan las Edge Functions (Deno), Vitest y el
// front (`@/supabase/functions/_shared/processorData`). No agregar imports.
// =============================================================================

type Obj = Record<string, unknown>;

export type ProcessorFeeKind = "fee" | "tax" | "financing" | "other";

export interface ProcessorFee {
  label: string;
  amount: number;
  kind: ProcessorFeeKind;
}

export interface ProcessorTimelineEvent {
  at: string;
  label: string;
}

export interface ProcessorPaymentData {
  provider: string;
  external_id: string | null;
  order_id: string | null;
  external_reference: string | null;
  /** Estado del procesador en minúsculas (approved, refunded, rejected...). */
  status: string;
  status_detail: string | null;
  status_label: string;
  operation_at: string | null;
  approved_at: string | null;
  /** Fecha de acreditación (MP money_release_date). */
  release_date: string | null;
  /** true = el dinero ya está disponible. null = el procesador no lo informa. */
  released: boolean | null;
  gross: number | null;
  fee_total: number;
  taxes_total: number;
  net: number | null;
  refunded: number;
  currency: string | null;
  installments: number | null;
  installment_amount: number | null;
  payment_method: string | null;
  payment_type: string | null;
  card: { brand: string | null; last4: string | null; first6: string | null; holder: string | null } | null;
  authorization: string | null;
  lote: string | null;
  cupon: string | null;
  comercio: string | null;
  terminal: string | null;
  pos_id: string | null;
  store_ext_id: string | null;
  payer: { email: string | null; name: string | null; doc: string | null } | null;
  fees: ProcessorFee[];
  timeline: ProcessorTimelineEvent[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj | null => (isObj(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

const last4Of = (v: unknown): string | null => {
  const s = str(v)?.replace(/\D/g, "") ?? "";
  return s.length >= 4 ? s.slice(-4) : null;
};

function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const BRAND_LABEL: Record<string, string> = {
  visa: "Visa",
  debvisa: "Visa",
  master: "Mastercard",
  mastercard: "Mastercard",
  debmaster: "Mastercard",
  mc: "Mastercard",
  amex: "American Express",
  american_express: "American Express",
  cabal: "Cabal",
  debcabal: "Cabal",
  naranja: "Naranja",
  maestro: "Maestro",
  argencard: "Argencard",
  cencosud: "Cencosud",
  diners: "Diners",
  tarshop: "Tarjeta Shopping",
  account_money: "Dinero en cuenta",
  consumer_credits: "Mercado Crédito",
};

export function brandLabel(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return BRAND_LABEL[s.toLowerCase()] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

const PAYMENT_TYPE_LABEL: Record<string, string> = {
  credit_card: "Crédito",
  debit_card: "Débito",
  prepaid_card: "Prepaga",
  account_money: "Dinero en cuenta",
  ticket: "Efectivo (cupón)",
  bank_transfer: "Transferencia",
  digital_currency: "Mercado Crédito",
  digital_wallet: "Billetera",
  credit: "Crédito",
  debit: "Débito",
};

export function paymentTypeLabel(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return PAYMENT_TYPE_LABEL[s.toLowerCase()] ?? s;
}

const STATUS_LABEL: Record<string, string> = {
  approved: "Aprobado",
  accredited: "Aprobado",
  authorized: "Autorizado",
  pending: "Pendiente",
  in_process: "En proceso",
  in_mediation: "En disputa",
  rejected: "Rechazado",
  cancelled: "Cancelado",
  annulled: "Anulado",
  voided: "Anulado",
  refunded: "Devuelto",
  partially_refunded: "Devuelto en parte",
  charged_back: "Contracargo",
  unknown: "Sin dato",
};

export function statusLabel(v: unknown): string {
  const s = (str(v) ?? "unknown").toLowerCase();
  return STATUS_LABEL[s] ?? s;
}

function empty(provider: string): ProcessorPaymentData {
  return {
    provider,
    external_id: null,
    order_id: null,
    external_reference: null,
    status: "unknown",
    status_detail: null,
    status_label: statusLabel("unknown"),
    operation_at: null,
    approved_at: null,
    release_date: null,
    released: null,
    gross: null,
    fee_total: 0,
    taxes_total: 0,
    net: null,
    refunded: 0,
    currency: null,
    installments: null,
    installment_amount: null,
    payment_method: null,
    payment_type: null,
    card: null,
    authorization: null,
    lote: null,
    cupon: null,
    comercio: null,
    terminal: null,
    pos_id: null,
    store_ext_id: null,
    payer: null,
    fees: [],
    timeline: [],
  };
}

function finish(d: ProcessorPaymentData): ProcessorPaymentData {
  d.fee_total = round2(d.fees.filter((f) => f.kind !== "tax").reduce((a, f) => a + f.amount, 0));
  d.taxes_total = round2(d.fees.filter((f) => f.kind === "tax").reduce((a, f) => a + f.amount, 0));
  if (d.net == null && d.gross != null && (d.fees.length > 0 || d.status === "approved")) {
    d.net = round2(d.gross - d.refunded - d.fee_total - d.taxes_total);
  }
  d.status_label = statusLabel(d.status);
  d.timeline = d.timeline
    .filter((e) => e.at)
    .sort((a, b) => a.at.localeCompare(b.at));
  return d;
}

// ── Mercado Pago (GET /v1/payments/{id} y /v1/payments/search) ───────────────

const MP_FEE_LABEL: Record<string, string> = {
  mercadopago_fee: "Comisión de Mercado Pago",
  financing_fee: "Costo de financiación (cuotas)",
  application_fee: "Comisión de la aplicación",
  shipping_fee: "Envío",
  coupon_fee: "Cupón de descuento",
  discount_fee: "Descuento",
};

/** Comisiones e impuestos a cargo del vendedor (charges_details o fee_details). */
export function mpFees(p: Obj): ProcessorFee[] {
  const out: ProcessorFee[] = [];
  const charges = arr(p.charges_details);
  if (charges.length > 0) {
    for (const c of charges.map(obj)) {
      if (!c) continue;
      const accounts = obj(c.accounts);
      // Sólo lo que paga el cobrador (el vendedor), no el comprador.
      if (accounts && str(accounts.from) && str(accounts.from) !== "collector") continue;
      const amounts = obj(c.amounts);
      const original = num(amounts?.original) ?? num(c.amount) ?? 0;
      const refunded = num(amounts?.refunded) ?? 0;
      const amount = round2(original - refunded);
      if (amount === 0) continue;
      const type = (str(c.type) ?? "").toLowerCase();
      const name = str(c.name) ?? type;
      const kind: ProcessorFeeKind =
        type === "tax" ? "tax" : /financ/i.test(name) ? "financing" : type === "fee" ? "fee" : "other";
      out.push({ label: mpChargeLabel(name, kind), amount, kind });
    }
    return out;
  }
  for (const f of arr(p.fee_details).map(obj)) {
    if (!f) continue;
    const payer = str(f.fee_payer);
    if (payer && payer !== "collector") continue;
    const amount = num(f.amount) ?? 0;
    if (amount === 0) continue;
    const type = str(f.type) ?? "fee";
    out.push({
      label: MP_FEE_LABEL[type] ?? type,
      amount: round2(amount),
      kind: type === "financing_fee" ? "financing" : "fee",
    });
  }
  // Impuestos informados aparte (retenciones de IIBB, etc.).
  const taxes = num(p.taxes_amount);
  if (taxes && taxes > 0) out.push({ label: "Impuestos y retenciones", amount: round2(taxes), kind: "tax" });
  return out;
}

function mpChargeLabel(name: string, kind: ProcessorFeeKind): string {
  const n = name.toLowerCase();
  if (n.includes("mercadopago_fee") || n === "mp_fee" || n.includes("meli_fee")) return "Comisión de Mercado Pago";
  if (n.includes("financing")) return "Costo de financiación (cuotas)";
  if (n.includes("iibb") || n.includes("ingresos_brutos")) return "Retención de Ingresos Brutos";
  if (n.includes("iva")) return "IVA sobre la comisión";
  if (n.includes("ganancias")) return "Retención de Ganancias";
  if (n.includes("debitos_creditos") || n.includes("ley_25413") || n.includes("impuesto_cheque")) {
    return "Impuesto a los débitos y créditos";
  }
  if (kind === "tax") return `Impuesto (${name})`;
  return name.replace(/_/g, " ");
}

export function normalizeMpPayment(raw: unknown, now: Date = new Date()): ProcessorPaymentData {
  const d = empty("mercadopago");
  const p = obj(raw);
  if (!p) return d;
  d.external_id = str(p.id);
  d.order_id = str(obj(p.order)?.id);
  d.external_reference = str(p.external_reference);
  d.status = (str(p.status) ?? "unknown").toLowerCase();
  d.status_detail = str(p.status_detail);
  d.operation_at = isoOrNull(p.date_created);
  d.approved_at = isoOrNull(p.date_approved);
  d.release_date = isoOrNull(p.money_release_date);
  const relStatus = (str(p.money_release_status) ?? "").toLowerCase();
  d.released =
    relStatus === "released"
      ? true
      : relStatus === "pending" || relStatus === "rejected"
        ? false
        : d.release_date
          ? Date.parse(d.release_date) <= now.getTime()
          : null;
  d.gross = num(p.transaction_amount);
  d.refunded = round2(num(p.transaction_amount_refunded) ?? 0);
  d.currency = str(p.currency_id);
  d.installments = num(p.installments);
  const td = obj(p.transaction_details);
  d.installment_amount = num(td?.installment_amount);
  d.payment_method = str(p.payment_method_id);
  d.payment_type = str(p.payment_type_id);
  const card = obj(p.card);
  const holder = obj(card?.cardholder);
  if (card && (card.last_four_digits || card.first_six_digits)) {
    d.card = {
      brand: brandLabel(p.payment_method_id),
      last4: last4Of(card.last_four_digits),
      first6: str(card.first_six_digits),
      holder: str(holder?.name),
    };
  }
  d.authorization = str(p.authorization_code);
  d.pos_id = str(p.pos_id);
  d.store_ext_id = str(p.store_id);
  const poi = obj(p.point_of_interaction);
  const device = obj(obj(poi?.transaction_data)?.device) ?? obj(poi?.device);
  d.terminal = str(device?.serial_number) ?? str(obj(p.metadata)?.terminal_id) ?? null;
  const payer = obj(p.payer);
  const ident = obj(payer?.identification);
  if (payer && (payer.email || payer.first_name || ident?.number)) {
    d.payer = {
      email: str(payer.email),
      name: [str(payer.first_name), str(payer.last_name)].filter(Boolean).join(" ") || null,
      doc: ident?.number ? `${str(ident.type) ?? "Doc"} ${str(ident.number)}` : null,
    };
  }
  d.fees = mpFees(p);
  const netReceived = num(td?.net_received_amount);
  // MP informa 0 en pagos que no son aprobados; ahí se calcula.
  d.net = netReceived && netReceived > 0 ? round2(netReceived) : null;
  if (d.operation_at) d.timeline.push({ at: d.operation_at, label: "Creado en el procesador" });
  if (d.approved_at) d.timeline.push({ at: d.approved_at, label: "Aprobado" });
  for (const r of arr(p.refunds).map(obj)) {
    const at = isoOrNull(r?.date_created);
    if (at) d.timeline.push({ at, label: `Devolución de ${num(r?.amount) ?? ""}`.trim() });
  }
  if (d.release_date) {
    d.timeline.push({
      at: d.release_date,
      label: d.released ? "Dinero acreditado" : "Acreditación prevista",
    });
  }
  const last = isoOrNull(p.date_last_updated);
  if (last && d.status !== "approved") d.timeline.push({ at: last, label: statusLabel(d.status) });
  return finish(d);
}

// ── Payway (GET /api/v2/payments/{id}) ───────────────────────────────────────
// Montos en centavos. La API de pagos no informa aranceles ni fecha de
// acreditación: esos datos llegan con la liquidación (importación de archivo).

export function normalizePaywayPayment(raw: unknown): ProcessorPaymentData {
  const d = empty("payway");
  const p = obj(raw);
  if (!p) return d;
  const sd = obj(p.status_details);
  d.external_id = str(p.id);
  d.external_reference = str(p.site_transaction_id);
  d.status = (str(p.status) ?? "unknown").toLowerCase();
  d.status_detail = str(obj(obj(sd?.error)?.reason)?.description);
  d.operation_at = isoOrNull(p.date);
  if (d.status === "approved" || d.status === "accredited") d.approved_at = d.operation_at;
  const cents = num(p.amount);
  d.gross = cents != null ? round2(cents / 100) : null;
  d.currency = str(p.currency)?.toUpperCase() ?? null;
  d.installments = num(p.installments);
  d.payment_type = str(p.payment_type);
  d.payment_method = str(p.card_brand) ?? str(p.payment_method_id);
  const cardData = obj(p.card_data);
  const last4 = last4Of(cardData?.card_number) ?? last4Of(p.last_four_digits);
  d.card = {
    brand: brandLabel(p.card_brand),
    last4,
    first6: str(p.bin),
    holder: str(obj(cardData?.card_holder)?.name) ?? null,
  };
  d.authorization = str(sd?.card_authorization_code);
  d.cupon = str(sd?.ticket);
  const est = str(p.establishment_name);
  d.comercio = est && /^\d+$/.test(est) ? est : null;
  d.store_ext_id = str(p.site_id);
  const refunds = arr(p.refunds)
    .map(obj)
    .reduce((a, r) => a + (num(r?.amount) ?? 0), 0);
  d.refunded = refunds > 0 ? round2(refunds / 100) : d.status === "annulled" && d.gross ? d.gross : 0;
  if (d.operation_at) d.timeline.push({ at: d.operation_at, label: statusLabel(d.status) });
  return finish(d);
}

// ── Nave (GET /integrations/payments/{id}) ───────────────────────────────────

export function normalizeNavePayment(raw: unknown): ProcessorPaymentData {
  const d = empty("nave");
  const p = obj(raw);
  if (!p) return d;
  const st = obj(p.status);
  const status = (str(st?.name) ?? str(p.status) ?? "unknown").toLowerCase();
  d.status = status;
  d.status_detail = str(st?.reason_name);
  d.external_id = str(p.id);
  d.external_reference = str(p.external_payment_id);
  d.order_id = str(obj(p.payment_request)?.id);
  d.operation_at = isoOrNull(p.created_at) ?? isoOrNull(p.creation_date);
  if (status === "approved") d.approved_at = isoOrNull(st?.date) ?? d.operation_at;
  const amount = obj(p.amount);
  d.gross = num(amount?.value) ?? num(p.amount) ?? num(obj(p.transactions)?.amount);
  d.currency = str(amount?.currency);
  const pm = obj(p.payment_method);
  d.payment_type = str(pm?.card_type)?.toLowerCase() ?? str(pm?.type);
  d.payment_method = str(pm?.brand) ?? str(pm?.name);
  d.installments = num(pm?.installments) ?? num(p.installments);
  if (pm && (pm.last_four_digits || pm.card_last_four || pm.brand)) {
    d.card = {
      brand: brandLabel(pm.brand),
      last4: last4Of(pm.last_four_digits ?? pm.card_last_four),
      first6: str(pm.bin),
      holder: null,
    };
  }
  d.authorization = str(pm?.authorization_code) ?? str(p.authorization_code);
  d.lote = str(pm?.batch_number) ?? str(p.batch_number);
  d.cupon = str(pm?.ticket_number) ?? str(p.ticket_number);
  d.terminal = str(obj(p.point_of_sale)?.terminal_id) ?? str(p.terminal_id);
  if (d.operation_at) d.timeline.push({ at: d.operation_at, label: "Creado en el procesador" });
  if (d.approved_at) d.timeline.push({ at: d.approved_at, label: "Aprobado" });
  return finish(d);
}

// ── GO Cuotas (GET /api_redirect/v1/orders/{id}) ─────────────────────────────

export function normalizeGoCuotasOrder(raw: unknown): ProcessorPaymentData {
  const d = empty("gocuotas");
  const o = obj(raw);
  if (!o) return d;
  d.external_id = str(o.id);
  d.order_id = str(o.id);
  d.external_reference = str(o.order_reference_id);
  const status = (str(o.status) ?? "unknown").toLowerCase();
  d.status = status === "delivered" || status === "approved" ? "approved" : status;
  d.status_detail = str(o.status);
  d.operation_at = isoOrNull(o.created_at);
  d.approved_at = isoOrNull(o.delivered_at) ?? (d.status === "approved" ? d.operation_at : null);
  const cents = num(o.amount_in_cents);
  d.gross = cents != null ? round2(cents / 100) : num(o.amount);
  d.installments = num(o.number_of_installments) ?? num(o.installments);
  d.payment_type = "credit";
  d.payment_method = "gocuotas";
  const card = obj(o.card);
  if (card) d.card = { brand: brandLabel(card.brand), last4: last4Of(card.last_four ?? card.last4), first6: null, holder: null };
  const customer = obj(o.customer);
  if (customer) d.payer = { email: str(customer.email), name: str(customer.name), doc: str(customer.dni) };
  if (d.operation_at) d.timeline.push({ at: d.operation_at, label: "Orden creada" });
  if (d.approved_at) d.timeline.push({ at: d.approved_at, label: "Aprobada" });
  return finish(d);
}

// ── Clover (GET /v3/merchants/{mId}/payments/{id}?expand=tender,cardTransaction)

export function normalizeCloverPayment(raw: unknown): ProcessorPaymentData {
  const d = empty("fiserv");
  const wrap = obj(raw);
  const p = obj(wrap?.payment) ?? wrap;
  if (!p) return d;
  d.external_id = str(p.id);
  d.external_reference = str(p.externalPaymentId);
  const result = (str(p.result) ?? "unknown").toUpperCase();
  d.status = result === "SUCCESS" ? "approved" : result === "VOIDED" ? "voided" : result === "FAIL" ? "rejected" : result.toLowerCase();
  d.operation_at = typeof p.createdTime === "number" ? new Date(p.createdTime).toISOString() : isoOrNull(p.createdTime);
  if (d.status === "approved") d.approved_at = d.operation_at;
  const cents = num(p.amount);
  d.gross = cents != null ? round2(cents / 100) : null;
  const tip = num(p.tipAmount);
  if (tip && d.gross != null) d.gross = round2(d.gross + tip / 100);
  const ct = obj(p.cardTransaction);
  if (ct) {
    d.card = { brand: brandLabel(ct.cardType), last4: last4Of(ct.last4), first6: str(ct.first6), holder: str(ct.cardholderName) };
    d.authorization = str(ct.authCode);
    d.payment_type = str(ct.type)?.toLowerCase() ?? null;
    const extra = obj(ct.extra);
    d.lote = str(extra?.batchNumber) ?? null;
    d.cupon = str(ct.referenceId) ?? null;
  }
  d.payment_method = str(obj(p.tender)?.label);
  d.terminal = str(obj(p.device)?.id);
  if (d.operation_at) d.timeline.push({ at: d.operation_at, label: statusLabel(d.status) });
  return finish(d);
}

// ── Getnet (GET /api/v2/orders/{id}) ─────────────────────────────────────────

export function normalizeGetnetOrder(raw: unknown): ProcessorPaymentData {
  const d = empty("getnet");
  const root = obj(raw);
  const o = obj(root?.data) ?? root;
  if (!o) return d;
  const attrs = obj(o.attributes) ?? o;
  d.external_id = str(o.id) ?? str(attrs.uuid);
  d.order_id = d.external_id;
  d.external_reference = str(attrs.external_reference) ?? str(attrs.reference);
  const status = (str(attrs.status) ?? "unknown").toLowerCase();
  d.status = ["paid", "approved", "success"].includes(status) ? "approved" : status;
  d.status_detail = str(attrs.status);
  d.operation_at = isoOrNull(attrs.created_at) ?? isoOrNull(attrs.createdAt);
  const amount = obj(attrs.amount);
  d.gross = num(amount?.value) ?? num(attrs.amount);
  d.currency = str(amount?.currency) ?? str(attrs.currency);
  const payment = obj(arr(attrs.payments)[0]) ?? obj(attrs.payment);
  if (payment) {
    d.installments = num(payment.installments);
    d.payment_method = str(payment.brand) ?? str(payment.payment_method);
    d.authorization = str(payment.authorization_code);
    d.card = payment.last_four ? { brand: brandLabel(payment.brand), last4: last4Of(payment.last_four), first6: null, holder: null } : null;
  }
  if (d.operation_at) d.timeline.push({ at: d.operation_at, label: "Orden creada" });
  return finish(d);
}

/** Normalizador por proveedor (provider_key de mp_payment_intents). */
export function normalizeProcessorPayment(providerKey: string, raw: unknown, now: Date = new Date()): ProcessorPaymentData {
  switch (providerKey) {
    case "mercadopago":
    case "mercadopago_point":
      return { ...normalizeMpPayment(raw, now), provider: providerKey };
    case "payway":
    case "payway_point":
      return { ...normalizePaywayPayment(raw), provider: providerKey };
    case "nave":
    case "nave_point":
      return { ...normalizeNavePayment(raw), provider: providerKey };
    case "gocuotas":
      return normalizeGoCuotasOrder(raw);
    case "fiserv_point":
    case "fiserv":
      return { ...normalizeCloverPayment(raw), provider: providerKey };
    case "getnet":
      return normalizeGetnetOrder(raw);
    default:
      return empty(providerKey);
  }
}

// ── Línea de liquidación desde un pago de Mercado Pago ───────────────────────

export interface SettlementLineInput {
  provider_key: string;
  line_key: string;
  external_id: string | null;
  order_id: string | null;
  external_reference: string | null;
  kind: "payment" | "refund" | "chargeback" | "other";
  status: string;
  operation_at: string;
  release_date: string | null;
  released: boolean;
  gross: number;
  fee: number;
  taxes: number;
  net: number;
  refunded: number;
  currency: string | null;
  payment_method: string | null;
  payment_type: string | null;
  card_brand: string | null;
  last4: string | null;
  installments: number | null;
  lote: string | null;
  cupon: string | null;
  autorizacion: string | null;
  comercio: string | null;
  terminal: string | null;
  pos_id: string | null;
  store_ext_id: string | null;
  description: string | null;
  payer: string | null;
  fee_detail: ProcessorFee[];
}

/** Estados de MP que son plata real (los demás no se importan a la conciliación). */
export const MP_SETTLEMENT_STATUSES = new Set([
  "approved",
  "authorized",
  "refunded",
  "charged_back",
  "in_mediation",
  "partially_refunded",
]);

/** Línea de liquidación de un pago de MP, o null si no movió plata. */
export function mpSettlementLine(raw: unknown, now: Date = new Date()): SettlementLineInput | null {
  const p = obj(raw);
  if (!p) return null;
  const n = normalizeMpPayment(p, now);
  if (!n.external_id || !MP_SETTLEMENT_STATUSES.has(n.status) || n.gross == null || !n.operation_at) return null;
  // Transferencias salientes, retiros y cargas de saldo no son ventas.
  const op = (str(p.operation_type) ?? "").toLowerCase();
  if (["money_transfer", "account_fund", "payout", "withdrawal", "cellphone_recharge"].includes(op)) return null;
  const gross = round2(n.gross);
  const fee = n.fee_total;
  const taxes = n.taxes_total;
  const net = n.net != null ? n.net : round2(gross - n.refunded - fee - taxes);
  return {
    provider_key: "mercadopago",
    line_key: `mp:${n.external_id}`,
    external_id: n.external_id,
    order_id: n.order_id,
    external_reference: n.external_reference,
    kind: n.status === "charged_back" ? "chargeback" : "payment",
    status: n.status,
    operation_at: n.approved_at ?? n.operation_at,
    release_date: n.release_date,
    released: n.released === true,
    gross,
    fee,
    taxes,
    net,
    refunded: n.refunded,
    currency: n.currency,
    payment_method: n.payment_method,
    payment_type: n.payment_type,
    card_brand: n.card?.brand ?? brandLabel(n.payment_method),
    last4: n.card?.last4 ?? null,
    installments: n.installments,
    lote: null,
    cupon: null,
    autorizacion: n.authorization,
    comercio: null,
    terminal: n.terminal,
    pos_id: n.pos_id,
    store_ext_id: n.store_ext_id,
    description: str(p.description),
    payer: n.payer?.email ?? n.payer?.name ?? null,
    fee_detail: n.fees,
  };
}
