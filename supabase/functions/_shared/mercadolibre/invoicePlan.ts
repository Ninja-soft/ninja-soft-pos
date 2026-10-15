// =============================================================================
// _shared/mercadolibre/invoicePlan.ts (ADR-141). PURO, sin imports.
//
// Arma la factura de una venta de Mercado Libre (un carrito o una orden) con
// las reglas de facturación de la cuenta, tomadas de cómo factura hoy
// ANDESMAR (docs/43-mercadolibre-facturacion.md):
//
//   • Renglones a precio de la publicación (unit_price: el descuento del
//     vendedor ya viene adentro). Cupón (la "contraparte" que paga ML o la
//     campaña y no el comprador): renglón de descuento, prorrateado en los
//     precios o sin descontar.
//   • Envío: renglón sólo cuando lo pagó el comprador (shipping_cost de los
//     pagos, o el costo del envío si el pago lo incluye). Gratis, bonificado,
//     Full o "a convenir": sin renglón.
//   • Comisiones, cargos y costo de envío del vendedor nunca van a la factura
//     del comprador.
//   • Control: lo cobrado (Σ pago − cupón + envío) tiene que cerrar con la
//     factura (tolerancia $ 1); si no, queda "a revisar".
//   • Receptor: datos de facturación de ML, con la condición del padrón de
//     ARCA si está (ADR-133). Dos variantes guardadas: "datos del comprador"
//     y "consumidor final"; la elección por venta cambia de una a otra sin
//     recalcular importes.
//   • Percepciones de IIBB por jurisdicción con reglas configurables (padrón,
//     alícuota fija o cero, % de base, mínimos de base y de importe, modo
//     acumulado o destino) y estrategia por tipo de envío: cobrar por link
//     de pago antes de facturar, facturar B sin percepción o facturar sin
//     percibir.
//
// Lo usan el worker (al ingresar la venta) y la Edge ml_facturacion (re
// armar). El servidor (SQL) valida la letra con la matriz de ARCA al emitir.
// =============================================================================

export type LogisticKind = "me2" | "me1" | "full" | "flex" | "a_convenir" | "custom" | "none";
export type CouponMode = "discount_line" | "prorate" | "none";
export type PerceptionStrategy = "link" | "invoice_b" | "skip";
export type ReceptorChoice = "billing" | "consumidor_final";
export type PlanStatus = "ready" | "hold_perception" | "needs_review" | "blocked";
export type Letter = "A" | "B" | "C" | "M";

export interface PlanPayment {
  id: string;
  status: string;
  transaction_amount: number;
  coupon_amount: number;
  shipping_cost: number;
}

export interface PlanLine {
  ml_order_id: string;
  ml_item_id: string;
  ml_variation_id: string | null;
  title: string;
  seller_sku: string | null;
  quantity: number;
  unit_price: number;
  /** Alícuota de IVA del producto vinculado (21 si no se sabe). */
  iva_rate?: number | null;
}

export interface PlanOrder {
  ml_order_id: string;
  status: string;
  total_amount: number;
  lines: PlanLine[];
  payments: PlanPayment[];
}

export interface PlanShipment {
  mode: string | null;
  logistic_type: string | null;
  /** Lo que paga el comprador por el envío (lead_time.cost / shipping_option.cost). */
  cost: number | null;
  state: string | null;
}

export interface PlanBilling {
  docType: "cuit" | "cuil" | "dni" | "passport" | "other" | null;
  docNumber: string | null;
  name: string;
  ivaCondition: string;
  address: string | null;
  state?: string | null;
}

export interface PlanPadron {
  iva_condition: string | null;
  razon_social?: string | null;
  domicilio?: string | null;
  provincia?: string | null;
}

export interface IibbEntry {
  jurisdiction: string;
  rate: number;
  valid_from: string;
  valid_to: string;
}

export interface PercRule {
  jurisdiction: string;
  enabled: boolean;
  rate_source: "padron" | "fixed" | "zero";
  rate: number | null;
  /** % de la base que se percibe (50 para Convenio Multilateral). */
  base_pct: number;
  min_base: number;
  min_amount: number;
  /** Condiciones alcanzadas. */
  conditions: string[];
  /** Base para RI y monotributo: neto (sin IVA) o total. */
  base: "neto" | "total";
  /** Base para exentos (ANDESMAR: bruto). */
  base_exempt: "neto" | "total";
  /** Aplica aunque el CUIT no esté en el padrón, si el envío va a esa jurisdicción. */
  without_padron: boolean;
}

export interface PlanSettings {
  coupon_mode: CouponMode;
  shipping_line: boolean;
  shipping_label: string;
  receptor_policy: "auto" | "always_cf";
  use_padron: boolean;
  cf_dni_from_cuit: boolean;
  cf_generic_company: boolean;
  blocked_jurisdictions: string[];
  check_tolerance: number;
  perc_enabled: boolean;
  perc_mode: "acumulado" | "destino";
  perc_strategy: Partial<Record<LogisticKind, PerceptionStrategy>>;
  perc_rules: PercRule[];
}

export interface PlanEmitter {
  iva_condition: string | null;
  issues_m: boolean;
  cf_id_threshold: number | null;
  /** El negocio es agente de percepción (feature y regla activa). */
  can_perceive: boolean;
}

export interface PlanInput {
  orders: PlanOrder[];
  shipment: PlanShipment | null;
  billing: PlanBilling | null;
  padron: PlanPadron | null;
  iibb: IibbEntry[];
  /** Jurisdicciones con el padrón del período actual cargado. */
  iibb_loaded: string[];
  emitter: PlanEmitter;
  settings: PlanSettings;
  /** AAAA-MM-DD en hora de Argentina. */
  today: string;
}

export interface PlanReceptor {
  name: string;
  doc_type: "cuit" | "cuil" | "dni" | "passport" | "other" | null;
  doc_number: string | null;
  iva_condition: string;
  address: string | null;
  source: "ml" | "padron" | "cf" | "cf_generic";
  letter: Letter | null;
  /** Consumidor final sin documento por encima del tope de ARCA. */
  needs_id: boolean;
}

export interface PerceptionLine {
  jurisdiction: string;
  rate: number;
  base_pct: number;
  effective_rate: number;
  base: number;
  amount: number;
  source: "padron" | "fixed";
}

export interface PlanPerception {
  applies: boolean;
  strategy: PerceptionStrategy | null;
  total: number;
  neto: number;
  destination: string | null;
  lines: PerceptionLine[];
  skipped: Array<{ jurisdiction: string; reason: "min_base" | "min_amount" | "zero" | "not_in_padron" | "other_destination" }>;
  reason: string | null;
}

export interface PlanItem {
  ml_order_id: string;
  ml_item_id: string;
  ml_variation_id: string | null;
  title: string;
  seller_sku: string | null;
  quantity: number;
  unit_price: number;
  list_unit_price: number;
  gross: number;
  iva_rate: number;
}

export interface MlInvoicePlan {
  version: 1;
  logistic: LogisticKind;
  items: PlanItem[];
  shipping: { kind: "buyer_paid" | "free" | "a_convenir" | "none"; amount: number; line: boolean; label: string };
  coupon: { total: number; mode: CouponMode; discount: number };
  totals: { items_gross: number; discount: number; shipping: number; invoice: number; collected: number | null; diff: number | null };
  receptors: Record<ReceptorChoice, PlanReceptor>;
  choice: ReceptorChoice;
  perception: PlanPerception;
  status: PlanStatus;
  warnings: string[];
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------
const r2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const fold = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Dígito verificador de CUIT/CUIL. */
export function cuitValid(cuit: string | null | undefined): boolean {
  const d = digits(cuit);
  if (d.length !== 11) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = w.reduce((s, x, i) => s + x * Number(d[i]), 0);
  let v = 11 - (sum % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return v === Number(d[10]);
}

/** Persona humana (20, 23, 24, 27) o empresa (30, 33, 34). */
export function cuitKind(cuit: string | null | undefined): "person" | "company" | null {
  const p = digits(cuit).slice(0, 2);
  if (["20", "23", "24", "27"].includes(p)) return "person";
  if (["30", "33", "34"].includes(p)) return "company";
  return null;
}

/** DNI dentro del CUIT/CUIL de una persona (los 8 del medio). */
export function dniFromCuit(cuit: string | null | undefined): string | null {
  const d = digits(cuit);
  if (d.length !== 11 || cuitKind(d) !== "person") return null;
  return String(Number(d.slice(2, 10)));
}

const JURISDICTIONS: Array<[string, string[]]> = [
  ["901", ["capital federal", "ciudad autonoma de buenos aires", "caba", "ciudad de buenos aires", "c a b a"]],
  ["902", ["buenos aires", "provincia de buenos aires", "bs as", "gba"]],
  ["903", ["catamarca"]],
  ["904", ["cordoba"]],
  ["905", ["corrientes"]],
  ["906", ["chaco"]],
  ["907", ["chubut"]],
  ["908", ["entre rios"]],
  ["909", ["formosa"]],
  ["910", ["jujuy"]],
  ["911", ["la pampa"]],
  ["912", ["la rioja"]],
  ["913", ["mendoza"]],
  ["914", ["misiones"]],
  ["915", ["neuquen"]],
  ["916", ["rio negro"]],
  ["917", ["salta"]],
  ["918", ["san juan"]],
  ["919", ["san luis"]],
  ["920", ["santa cruz"]],
  ["921", ["santa fe"]],
  ["922", ["santiago del estero"]],
  ["923", ["tierra del fuego", "tierra del fuego antartida e islas del atlantico sur"]],
  ["924", ["tucuman"]],
];

/** Provincia (texto de ML o de ARCA) a código de jurisdicción 901 a 924. */
export function jurisdictionOf(state: string | null | undefined): string | null {
  const s = fold(state);
  if (!s) return null;
  for (const [code, names] of JURISDICTIONS) if (names.includes(s)) return code;
  // CABA antes que Buenos Aires: "capital federal" ya cubierto; "ciudad..." también.
  for (const [code, names] of JURISDICTIONS) if (names.some((n) => s.startsWith(n))) return code;
  return null;
}

/** Tipo de envío de ML (modo y logística). */
export function logisticKind(mode: string | null | undefined, logisticType: string | null | undefined): LogisticKind {
  if (!mode && !logisticType) return "none";
  if (logisticType === "fulfillment") return "full";
  if (logisticType === "self_service") return "flex";
  if (mode === "me2") return "me2";
  if (mode === "me1") return "me1";
  if (mode === "custom") return "custom";
  if (mode === "not_specified") return "a_convenir";
  return mode ? "a_convenir" : "none";
}

/**
 * Fila del padrón de IIBB para hoy: la vigente; si no hay y el período actual
 * de esa jurisdicción no está cargado, la más nueva; si el período está
 * cargado y el CUIT no figura, salió del padrón (no se percibe).
 */
export function pickPadronEntry(entries: IibbEntry[], today: string, currentLoaded: boolean): IibbEntry | null {
  const valid = entries
    .filter((e) => e.valid_from <= today && e.valid_to >= today)
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  if (valid[0]) return valid[0];
  if (currentLoaded) return null;
  return [...entries].sort((a, b) => b.valid_to.localeCompare(a.valid_to))[0] ?? null;
}

const CLASS_A = ["responsable_inscripto", "monotributo", "monotributo_social"];
const discriminates = (c: string | null | undefined) => c === "responsable_inscripto";

/** Letra sugerida (espejo de cbte_letter_infer, ADR-068 / ADR-133). */
export function suggestLetter(emitter: PlanEmitter, receptorCondition: string): Letter | null {
  if (!emitter.iva_condition) return null;
  if (!discriminates(emitter.iva_condition)) return "C";
  if (CLASS_A.includes(receptorCondition)) return emitter.issues_m ? "M" : "A";
  return "B";
}

// -----------------------------------------------------------------------------
// Armado
// -----------------------------------------------------------------------------
function approved(o: PlanOrder): PlanPayment[] {
  return (o.payments ?? []).filter((p) => p.status === "approved");
}

function buildItems(orders: PlanOrder[], couponMode: CouponMode, coupon: number): { items: PlanItem[]; gross: number } {
  const items: PlanItem[] = [];
  for (const o of orders) {
    if (o.status === "cancelled" || o.status === "invalid") continue;
    for (const l of o.lines) {
      const qty = num(l.quantity);
      if (qty <= 0) continue;
      const unit = r2(num(l.unit_price));
      items.push({
        ml_order_id: String(l.ml_order_id ?? o.ml_order_id),
        ml_item_id: l.ml_item_id,
        ml_variation_id: l.ml_variation_id ?? null,
        title: (l.title || l.ml_item_id).slice(0, 250),
        seller_sku: l.seller_sku ?? null,
        quantity: qty,
        unit_price: unit,
        list_unit_price: unit,
        gross: r2(unit * qty),
        iva_rate: l.iva_rate == null ? 21 : num(l.iva_rate),
      });
    }
  }
  const gross = r2(items.reduce((s, i) => s + i.gross, 0));
  if (couponMode === "prorate" && coupon > 0 && gross > 0) {
    // El cupón se reparte por el peso de cada renglón; el último absorbe el redondeo.
    const target = r2(gross - Math.min(coupon, gross));
    let acc = 0;
    items.forEach((it, i) => {
      const g = i === items.length - 1 ? r2(target - acc) : r2(it.gross - (Math.min(coupon, gross) * it.gross) / gross);
      acc = r2(acc + g);
      it.gross = g;
      it.unit_price = r2(g / it.quantity);
    });
  }
  return { items, gross };
}

function receptorFor(input: PlanInput, choice: ReceptorChoice, total: number, warnings: Set<string>): PlanReceptor {
  const { billing, padron, settings, emitter } = input;
  const thr = emitter.cf_id_threshold;
  const overThreshold = thr != null && thr > 0 && total >= thr;
  const cf = (doc: { type: "dni" | "passport" | "other"; number: string } | null, source: "cf" | "cf_generic", name?: string): PlanReceptor => ({
    name: (doc ? name || billing?.name : null) || "Consumidor Final",
    doc_type: doc?.type ?? null,
    doc_number: doc?.number ?? null,
    iva_condition: "consumidor_final",
    address: doc ? billing?.address ?? null : null,
    source,
    letter: suggestLetter(emitter, "consumidor_final"),
    needs_id: !doc && overThreshold,
  });

  const docType = billing?.docType ?? null;
  const docNumber = digits(billing?.docNumber);
  const isCuit = (docType === "cuit" || docType === "cuil") && cuitValid(docNumber);

  // Documento de persona para facturar a consumidor final.
  const personDoc = (): { type: "dni" | "passport" | "other"; number: string } | null => {
    if (docType === "dni" && docNumber.length >= 6 && docNumber.length <= 9) return { type: "dni", number: String(Number(docNumber)) };
    if (isCuit && settings.cf_dni_from_cuit) {
      const dni = dniFromCuit(docNumber);
      if (dni) return { type: "dni", number: dni };
    }
    if (docType === "passport" && docNumber) return { type: "passport", number: docNumber };
    return null;
  };

  if (choice === "consumidor_final") {
    const doc = personDoc();
    return doc ? cf(doc, "cf") : cf(null, "cf_generic");
  }

  if (!billing) return cf(null, "cf_generic");
  if (!isCuit) {
    if ((docType === "cuit" || docType === "cuil") && docNumber) warnings.add("invalid_cuit");
    if (docType === "other" && docNumber) warnings.add("foreign_document");
    const doc = personDoc();
    return doc ? cf(doc, "cf") : cf(null, "cf_generic");
  }

  const fromPadron = settings.use_padron && padron?.iva_condition ? padron.iva_condition : null;
  const condition = fromPadron ?? billing.ivaCondition ?? (docType === "cuit" ? "responsable_inscripto" : "consumidor_final");
  const name = (fromPadron && padron?.razon_social) || billing.name || "Comprador de Mercado Libre";
  const address = (fromPadron && padron?.domicilio) || billing.address;
  const source = fromPadron ? "padron" : "ml";

  if (condition === "consumidor_final") {
    // CUIT de persona: va como DNI. Empresa: consumidor final no identificado
    // bajo el tope (RG 5700) o queda para revisar.
    const kind = cuitKind(docNumber);
    if (kind === "person" && settings.cf_dni_from_cuit) {
      return { ...cf({ type: "dni", number: dniFromCuit(docNumber)! }, "cf", name), source };
    }
    if (kind === "company") {
      if (settings.cf_generic_company && !overThreshold) return cf(null, "cf_generic");
      warnings.add("cf_company_cuit");
    }
  }

  return {
    name: name.slice(0, 200),
    doc_type: "cuit",
    doc_number: docNumber,
    iva_condition: condition,
    address: address ?? null,
    source,
    letter: suggestLetter(emitter, condition),
    needs_id: false,
  };
}

function perceptionFor(input: PlanInput, receptor: PlanReceptor, invoiceTotal: number, ivaDivisor: number, logistic: LogisticKind): PlanPerception {
  const { settings, emitter } = input;
  const dest = jurisdictionOf(input.shipment?.state ?? input.billing?.state ?? input.padron?.provincia ?? null);
  const neto = r2(invoiceTotal / ivaDivisor);
  const none = (reason: string | null): PlanPerception => ({
    applies: false, strategy: null, total: 0, neto, destination: dest, lines: [], skipped: [], reason,
  });
  if (!settings.perc_enabled) return none("disabled");
  if (!emitter.can_perceive) return none("not_agent");
  if (receptor.doc_type !== "cuit" || !receptor.doc_number) return none("no_cuit");
  if (invoiceTotal <= 0) return none("no_amount");

  const lines: PerceptionLine[] = [];
  const skipped: PlanPerception["skipped"] = [];
  for (const rule of settings.perc_rules) {
    if (!rule.enabled) continue;
    if (!rule.conditions.includes(receptor.iva_condition)) continue;
    if (settings.perc_mode === "destino" && rule.jurisdiction !== dest) {
      skipped.push({ jurisdiction: rule.jurisdiction, reason: "other_destination" });
      continue;
    }
    const entry = pickPadronEntry(
      input.iibb.filter((e) => e.jurisdiction === rule.jurisdiction),
      input.today,
      input.iibb_loaded.includes(rule.jurisdiction),
    );
    let rate = 0;
    let source: "padron" | "fixed" = "padron";
    if (rule.rate_source === "zero") {
      skipped.push({ jurisdiction: rule.jurisdiction, reason: "zero" });
      continue;
    } else if (rule.rate_source === "padron") {
      if (!entry) {
        skipped.push({ jurisdiction: rule.jurisdiction, reason: "not_in_padron" });
        continue;
      }
      rate = num(entry.rate);
    } else {
      if (!entry && !(rule.without_padron && dest === rule.jurisdiction)) {
        skipped.push({ jurisdiction: rule.jurisdiction, reason: "not_in_padron" });
        continue;
      }
      rate = num(rule.rate);
      source = "fixed";
    }
    const basePct = rule.base_pct > 0 ? rule.base_pct : 100;
    const eff = Math.round(rate * basePct * 100) / 10000;
    if (eff <= 0) {
      skipped.push({ jurisdiction: rule.jurisdiction, reason: "zero" });
      continue;
    }
    const kind = receptor.iva_condition === "exento" ? rule.base_exempt : rule.base;
    const base = kind === "total" ? r2(invoiceTotal) : neto;
    if (base < num(rule.min_base)) {
      skipped.push({ jurisdiction: rule.jurisdiction, reason: "min_base" });
      continue;
    }
    const amount = r2((base * eff) / 100);
    if (amount <= 0 || amount < num(rule.min_amount)) {
      skipped.push({ jurisdiction: rule.jurisdiction, reason: "min_amount" });
      continue;
    }
    lines.push({ jurisdiction: rule.jurisdiction, rate, base_pct: basePct, effective_rate: eff, base, amount, source });
  }
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));
  if (total <= 0) return { ...none(lines.length === 0 && skipped.length > 0 ? "nothing_to_perceive" : "no_rule"), skipped };
  return {
    applies: true,
    strategy: settings.perc_strategy[logistic] ?? "link",
    total,
    neto,
    destination: dest,
    lines,
    skipped,
    reason: null,
  };
}

/** Arma la factura de la venta (ver el encabezado). */
export function buildInvoicePlan(input: PlanInput): MlInvoicePlan {
  const s = input.settings;
  const warnings = new Set<string>();
  const logistic = logisticKind(input.shipment?.mode, input.shipment?.logistic_type);
  const live = input.orders.filter((o) => o.status !== "cancelled" && o.status !== "invalid");
  const pays = live.flatMap(approved);
  const hasPays = pays.length > 0;
  const coupon = r2(pays.reduce((a, p) => a + num(p.coupon_amount), 0));
  const tx = r2(pays.reduce((a, p) => a + num(p.transaction_amount), 0));
  let shipPaid = r2(pays.reduce((a, p) => a + num(p.shipping_cost), 0));

  const { items, gross } = buildItems(input.orders, s.coupon_mode, coupon);
  const shipCost = r2(num(input.shipment?.cost));
  if (logistic === "a_convenir") {
    shipPaid = 0;
  } else if (shipPaid <= 0.01 && shipCost > 0.01) {
    // El pago incluye el envío (o no hay pagos informados): se toma el costo del envío.
    if (!hasPays || tx >= gross + shipCost - 0.01) shipPaid = shipCost;
  }
  const shippingKind = logistic === "a_convenir" ? "a_convenir" : shipPaid > 0.01 ? "buyer_paid" : input.shipment ? "free" : "none";
  const shipLine = s.shipping_line && shippingKind === "buyer_paid";
  const discount = s.coupon_mode === "discount_line" ? Math.min(coupon, gross) : 0;
  const itemsNet = r2(items.reduce((a, i) => a + i.gross, 0));
  const invoice = r2(itemsNet - discount + (shipLine ? shipPaid : 0));

  // Control de lo cobrado.
  let collected: number | null = null;
  let diff: number | null = null;
  if (hasPays) {
    collected = r2(tx + shipPaid - coupon);
    const comparable = r2(collected - (shipLine ? 0 : shipPaid) + (s.coupon_mode === "none" ? coupon : 0));
    diff = r2(invoice - comparable);
    if (Math.abs(diff) > (s.check_tolerance > 0 ? s.check_tolerance : 1)) warnings.add("paid_mismatch");
  }
  if (logistic === "a_convenir") warnings.add("shipping_a_convenir");
  if (coupon > 0 && s.coupon_mode === "none") warnings.add("coupon_not_deducted");

  // IVA ponderado para la base neta de las percepciones (envío al 21 %).
  const weights = items.map((i) => ({ g: i.gross - (discount * i.gross) / (itemsNet || 1), rate: i.iva_rate }));
  if (shipLine) weights.push({ g: shipPaid, rate: 21 });
  const gSum = weights.reduce((a, w) => a + w.g, 0);
  const nSum = weights.reduce((a, w) => a + w.g / (1 + w.rate / 100), 0);
  const ivaDivisor = discriminates(input.emitter.iva_condition) && nSum > 0 ? gSum / nSum : 1;

  const bw = new Set<string>();
  const cw = new Set<string>();
  const billing = receptorFor(input, "billing", invoice, bw);
  const consumidor = receptorFor(input, "consumidor_final", invoice, cw);
  const perception = perceptionFor(input, billing, invoice, ivaDivisor, logistic);

  let choice: ReceptorChoice = s.receptor_policy === "always_cf" ? "consumidor_final" : "billing";
  if (choice === "billing" && perception.applies && perception.strategy === "invoice_b") choice = "consumidor_final";
  for (const w of choice === "billing" ? bw : cw) warnings.add(w);
  const chosen = choice === "billing" ? billing : consumidor;
  if (!input.emitter.iva_condition) warnings.add("emitter_not_configured");
  if (chosen.needs_id) warnings.add("cf_identification_required");
  if (choice === "billing" && perception.applies && perception.strategy === "skip") warnings.add("perception_skipped");
  if (items.length === 0 || invoice <= 0) warnings.add("empty_invoice");

  const dest = perception.destination ?? jurisdictionOf(input.shipment?.state ?? input.billing?.state ?? null);
  let status: PlanStatus = "ready";
  if (dest && s.blocked_jurisdictions.includes(dest)) {
    status = "blocked";
    warnings.add("blocked_jurisdiction");
  } else if (
    ["paid_mismatch", "emitter_not_configured", "cf_identification_required", "cf_company_cuit", "empty_invoice"].some((w) => warnings.has(w))
  ) {
    status = "needs_review";
  } else if (choice === "billing" && perception.applies && perception.strategy === "link") {
    status = "hold_perception";
  }

  return {
    version: 1,
    logistic,
    items,
    shipping: { kind: shippingKind, amount: shipPaid, line: shipLine, label: (s.shipping_label || "Envío").slice(0, 120) },
    coupon: { total: coupon, mode: s.coupon_mode, discount: r2(discount) },
    totals: { items_gross: gross, discount: r2(discount), shipping: shipLine ? shipPaid : 0, invoice, collected, diff },
    receptors: { billing, consumidor_final: consumidor },
    choice,
    perception,
    status,
    warnings: [...warnings],
  };
}

/** Configuración por defecto (la de ANDESMAR, con las percepciones apagadas). */
export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  coupon_mode: "discount_line",
  shipping_line: true,
  shipping_label: "Envío",
  receptor_policy: "auto",
  use_padron: true,
  cf_dni_from_cuit: true,
  cf_generic_company: true,
  blocked_jurisdictions: [],
  check_tolerance: 1,
  perc_enabled: false,
  perc_mode: "acumulado",
  perc_strategy: { me2: "link", me1: "link", a_convenir: "link", custom: "link", none: "link", full: "invoice_b", flex: "invoice_b" },
  perc_rules: [],
};

/** Normaliza la configuración guardada (jsonb) con los valores por defecto. */
export function planSettingsFrom(raw: Record<string, unknown> | null | undefined): PlanSettings {
  const r = raw ?? {};
  const d = DEFAULT_PLAN_SETTINGS;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const strategy = { ...d.perc_strategy };
  const rs = (r.perc_strategy ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(strategy) as LogisticKind[]) strategy[k] = pick(rs[k], ["link", "invoice_b", "skip"] as const, strategy[k]!);
  const rules = Array.isArray(r.perc_rules) ? (r.perc_rules as Array<Record<string, unknown>>) : [];
  return {
    coupon_mode: pick(r.coupon_mode, ["discount_line", "prorate", "none"] as const, d.coupon_mode),
    shipping_line: bool(r.shipping_line, d.shipping_line),
    shipping_label: typeof r.shipping_label === "string" && r.shipping_label.trim() ? r.shipping_label.trim() : d.shipping_label,
    receptor_policy: pick(r.receptor_policy, ["auto", "always_cf"] as const, d.receptor_policy),
    use_padron: bool(r.use_padron, d.use_padron),
    cf_dni_from_cuit: bool(r.cf_dni_from_cuit, d.cf_dni_from_cuit),
    cf_generic_company: bool(r.cf_generic_company, d.cf_generic_company),
    blocked_jurisdictions: Array.isArray(r.blocked_jurisdictions) ? (r.blocked_jurisdictions as unknown[]).map(String) : [],
    check_tolerance: num(r.check_tolerance) > 0 ? num(r.check_tolerance) : d.check_tolerance,
    perc_enabled: bool(r.perc_enabled, d.perc_enabled),
    perc_mode: pick(r.perc_mode, ["acumulado", "destino"] as const, d.perc_mode),
    perc_strategy: strategy,
    perc_rules: rules
      .filter((x) => /^9\d{2}$/.test(String(x.jurisdiction ?? "")) && Number(x.jurisdiction) >= 901 && Number(x.jurisdiction) <= 924)
      .map((x) => ({
        jurisdiction: String(x.jurisdiction),
        enabled: bool(x.enabled, true),
        rate_source: pick(x.rate_source, ["padron", "fixed", "zero"] as const, "padron"),
        rate: x.rate == null || x.rate === "" ? null : num(x.rate),
        base_pct: num(x.base_pct) > 0 ? num(x.base_pct) : 100,
        min_base: num(x.min_base),
        min_amount: num(x.min_amount),
        conditions: Array.isArray(x.conditions) ? (x.conditions as unknown[]).map(String) : ["responsable_inscripto", "monotributo", "exento"],
        base: pick(x.base, ["neto", "total"] as const, "neto"),
        base_exempt: pick(x.base_exempt, ["neto", "total"] as const, "total"),
        without_padron: bool(x.without_padron, false),
      })),
  };
}

/** Texto del mensaje al comprador con el link de pago de la percepción. */
export function perceptionMessage(
  template: string | null | undefined,
  v: { nombre: string; monto: number; link: string; dias: number; detalle: string },
): string {
  const money = (n: number) => `$ ${n.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
  const t =
    template && template.trim()
      ? template
      : "Hola {nombre}, para emitirte la factura A tenemos que cobrarte la percepción de Ingresos Brutos ({detalle}): {monto}. Pagala con este link de Mercado Pago dentro de {dias} días: {link} Si preferís factura B, no hace falta que pagues nada.";
  return t
    .replaceAll("{nombre}", v.nombre)
    .replaceAll("{monto}", money(v.monto))
    .replaceAll("{link}", v.link)
    .replaceAll("{dias}", String(v.dias))
    .replaceAll("{detalle}", v.detalle);
}

/** Recorta un mensaje sin cortar la URL (los mensajes de ML tienen tope). */
export function trimKeepingUrl(text: string, max: number): string {
  if (text.length <= max) return text;
  const m = /(https?:\/\/\S+)/.exec(text);
  if (!m) return text.slice(0, max);
  const url = m[1]!;
  if (url.length >= max) return url;
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + url.length);
  // Primero se recorta lo que va después del link y después lo de antes.
  const afterKept = after.slice(0, Math.max(0, max - url.length - before.length));
  const beforeKept = before.slice(0, max - url.length - afterKept.length);
  return beforeKept + url + afterKept;
}
