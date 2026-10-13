// Listado y detalle de ventas (rediseño de /ventas): lógica pura de
// presentación. Fechas legibles, canal de la venta, agrupado de cobros por
// medio, estado de devolución, estado fiscal, línea de tiempo y filtros que
// corren sobre la página cargada. Sin React ni Supabase: se testea suelto.

import { methodLabel, providerName, voucherInfo, type SalePaymentRow } from "@/lib/sales/paymentDetail";
import { normalizeCardBrand } from "@/lib/payments/terminal/normalize";
import { perceptionLabel } from "@/lib/tax/ticket";

// ── Fechas ──────────────────────────────────────────────────────────────────

const AR_TZ = "America/Argentina/Buenos_Aires";

const dayFmt = new Intl.DateTimeFormat("es-AR", {
  timeZone: AR_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("es-AR", {
  timeZone: AR_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "13/10/2026 14:05" en hora de Argentina. */
export function absoluteDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}

/** "14:05" en hora de Argentina. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : timeFmt.format(d);
}

/** Día calendario de Argentina (YYYY-MM-DD), UTC-3 sin horario de verano. */
function arDay(ms: number): string {
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Tiempo relativo corto para el listado: "recién", "hace 5 min", "hace 2 h",
 * "ayer 18:30", "hace 3 días" y, de ahí en más, la fecha.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return "recién";
  if (secs < 3600) return `hace ${Math.floor(secs / 60)} min`;
  const sameDay = arDay(t) === arDay(now);
  if (sameDay) return `hace ${Math.floor(secs / 3600)} h`;
  if (arDay(t) === arDay(now - 86400 * 1000)) return `ayer ${clockTime(iso)}`;
  const days = Math.round((Date.parse(arDay(now)) - Date.parse(arDay(t))) / 86400000);
  if (days < 7) return `hace ${days} días`;
  return dayFmt.format(new Date(t));
}

// ── Canal ───────────────────────────────────────────────────────────────────

export type SaleChannel = "mostrador" | "mesa" | "delivery" | "takeaway" | "mercadolibre" | "envio" | "offline";

export const CHANNEL_LABEL: Record<SaleChannel, string> = {
  mostrador: "Mostrador",
  mesa: "Mesa",
  delivery: "Delivery",
  takeaway: "Para llevar",
  mercadolibre: "Mercado Libre",
  envio: "Con envío",
  offline: "Sin conexión",
};

export interface ChannelSignals {
  /** Pedido de delivery enlazado (delivery_orders.sale_id). */
  delivery?: { order_type: string | null } | null;
  /** Cuenta de mesa enlazada (table_orders.sale_id). */
  table?: boolean;
  /** Origen del envío enlazado (shipments.source). */
  shipmentSource?: string | null;
  /** Venta registrada sin conexión y sincronizada después. */
  offline?: boolean;
}

/** Canal de la venta según lo que tiene enlazado. Por defecto, mostrador. */
export function saleChannel(s: ChannelSignals): SaleChannel {
  if (s.shipmentSource === "mercadolibre") return "mercadolibre";
  if (s.delivery) return s.delivery.order_type === "takeaway" ? "takeaway" : "delivery";
  if (s.table) return "mesa";
  if (s.shipmentSource) return "envio";
  if (s.offline) return "offline";
  return "mostrador";
}

// ── Cobros ──────────────────────────────────────────────────────────────────

export interface PaymentChip {
  key: string;
  method: string;
  label: string;
  /** Proveedor (intent o adquirente del cupón): elige el logo. */
  providerKey: string | null;
  providerLabel: string | null;
  /** Red de la tarjeta normalizada (visa, master, ...). */
  brandKey: string | null;
  brandLabel: string | null;
  last4: string | null;
  cuotas: number | null;
  amount: number;
  count: number;
}

type ChipPayment = Pick<SalePaymentRow, "method" | "amount" | "reference" | "card_voucher">;

/**
 * Agrupa los cobros de una venta por medio + proveedor + red de tarjeta, con
 * el monto sumado, las cuotas (la mayor) y la cantidad de cobros. Ordena de
 * mayor a menor monto. `providerOf` resuelve el proveedor de un cobro con
 * intent (payments.reference = id del intent).
 */
export function groupPayments(
  payments: ChipPayment[],
  providerOf: (reference: string | null) => string | null = () => null,
): PaymentChip[] {
  const map = new Map<string, PaymentChip>();
  for (const p of payments) {
    const voucher = voucherInfo({ ...p, id: "", created_at: "", reconciled_at: null } as SalePaymentRow);
    const acq = typeof p.card_voucher?.adquirente === "string" ? (p.card_voucher.adquirente as string) : null;
    const provider = providerOf(p.reference) ?? (p.method === "directo" ? "directo" : acq);
    const brandKey = normalizeCardBrand(voucher.brand);
    const key = `${p.method}|${provider ?? ""}|${brandKey ?? voucher.brand ?? ""}`;
    const prev = map.get(key);
    if (prev) {
      prev.amount = round2(prev.amount + Number(p.amount || 0));
      prev.count += 1;
      if (voucher.cuotas && (!prev.cuotas || voucher.cuotas > prev.cuotas)) prev.cuotas = voucher.cuotas;
      if (prev.last4 !== voucher.last4) prev.last4 = null;
      continue;
    }
    map.set(key, {
      key,
      method: p.method,
      label: methodLabel(p.method),
      providerKey: provider,
      providerLabel: providerName(provider),
      brandKey,
      brandLabel: voucher.brand,
      last4: voucher.last4,
      cuotas: voucher.cuotas,
      amount: round2(Number(p.amount || 0)),
      count: 1,
    });
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/** "3 cuotas", "1 pago" o null. */
export function cuotasLabel(cuotas: number | null | undefined): string | null {
  if (!cuotas || cuotas < 1) return null;
  return cuotas === 1 ? "1 pago" : `${cuotas} cuotas`;
}

export interface MethodShare {
  method: string;
  label: string;
  total: number;
  /** Porcentaje del total (0 a 100, redondeado a 1 decimal). */
  pct: number;
}

/** Desglose por medio del resumen (sales_report.by_method), de mayor a menor. */
export function methodBreakdown(byMethod: { method: string; total: number }[]): MethodShare[] {
  const rows = byMethod
    .map((m) => ({ method: m.method, total: Number(m.total) || 0 }))
    .filter((m) => m.total > 0);
  const sum = rows.reduce((a, m) => a + m.total, 0);
  return rows
    .map((m) => ({
      ...m,
      label: methodLabel(m.method),
      pct: sum > 0 ? Math.round((m.total / sum) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/** Ticket promedio; 0 sin ventas. */
export function averageTicket(total: number, count: number): number {
  return count > 0 ? round2(total / count) : 0;
}

// ── Ítems ───────────────────────────────────────────────────────────────────

export interface ItemLike {
  quantity: number;
  returned_qty?: number | null;
}

/** Unidades vendidas (las cantidades fraccionarias, p. ej. kg, cuentan 1). */
export function unitsCount(items: ItemLike[]): number {
  return items.reduce((a, it) => {
    const q = Number(it.quantity) || 0;
    return a + (Number.isInteger(q) ? q : q > 0 ? 1 : 0);
  }, 0);
}

/** Miniaturas a mostrar y cuántas quedan afuera ("+N"). */
export function thumbsPreview<T>(items: T[], max = 3): { shown: T[]; extra: number } {
  const shown = items.slice(0, max);
  return { shown, extra: Math.max(0, items.length - shown.length) };
}

export type ReturnState = "none" | "partial" | "full";

/** Estado de devolución a partir de lo devuelto por ítem. */
export function returnState(items: ItemLike[]): ReturnState {
  const withQty = items.filter((it) => Number(it.quantity) > 0);
  if (withQty.length === 0) return "none";
  const returned = withQty.filter((it) => Number(it.returned_qty ?? 0) > 0);
  if (returned.length === 0) return "none";
  const full = withQty.every((it) => Number(it.returned_qty ?? 0) >= Number(it.quantity));
  return full ? "full" : "partial";
}

/** Texto de variante a partir de las opciones ("Rojo / M"). */
export function variantLabel(v: { option1?: string | null; option2?: string | null } | null | undefined): string | null {
  if (!v) return null;
  const parts = [v.option1, v.option2].map((x) => (x ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

// ── Estados ─────────────────────────────────────────────────────────────────

export type BadgeToneKey = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

export interface StatusBadge {
  key: string;
  label: string;
  tone: BadgeToneKey;
  title?: string;
}

/** Estado principal de la venta: anulada, devuelta, devuelta en parte o completada. */
export function saleStatusBadge(status: string, ret: ReturnState): StatusBadge {
  if (status === "voided") return { key: "voided", label: "Anulada", tone: "danger" };
  if (ret === "full") return { key: "returned", label: "Devuelta", tone: "warning" };
  if (ret === "partial") return { key: "partial", label: "Devuelta en parte", tone: "warning" };
  return { key: "completed", label: "Completada", tone: "success" };
}

export interface FiscalDocLike {
  origin: string;
  status: string;
  cae?: string | null;
}

/** Estado fiscal compacto (factura de la venta). null si no hay comprobante. */
export function fiscalBadge(docs: FiscalDocLike[]): StatusBadge | null {
  const doc = docs.find((d) => d.origin === "sale" && d.status !== "cancelado");
  if (!doc) return null;
  switch (doc.status) {
    case "aprobado":
      return { key: "cae", label: "CAE", tone: "info", title: doc.cae ? `CAE ${doc.cae}` : "Factura aprobada" };
    case "rechazado":
    case "requiere_accion":
      return { key: "fiscal-error", label: "Factura con error", tone: "danger", title: "ARCA rechazó la factura" };
    default:
      return { key: "fiscal-pending", label: "Factura pendiente", tone: "neutral", title: "La factura está en camino a ARCA" };
  }
}

// ── Filtros sobre la página cargada ─────────────────────────────────────────

/**
 * Filtro por canal: corre sobre la página ya traída (no hay columna de canal
 * en sales; el canal sale de lo enlazado). Sin canal, devuelve todo.
 */
export function filterByChannel<T extends { id: string }>(
  rows: T[],
  channelOf: (id: string) => SaleChannel | null,
  channel: SaleChannel | "" | null | undefined,
): T[] {
  if (!channel) return rows;
  return rows.filter((r) => channelOf(r.id) === channel);
}

/** Canales presentes en la página (para no ofrecer filtros vacíos). */
export function presentChannels(channels: (SaleChannel | null)[]): SaleChannel[] {
  const order = Object.keys(CHANNEL_LABEL) as SaleChannel[];
  const set = new Set(channels.filter((c): c is SaleChannel => !!c));
  return order.filter((c) => set.has(c));
}

// ── Línea de tiempo de la venta ─────────────────────────────────────────────

export type SaleTimelineTone = "success" | "warning" | "danger" | "neutral" | "info";
export interface SaleTimelineStep {
  at: string;
  label: string;
  detail?: string;
  tone: SaleTimelineTone;
}

export interface SaleTimelineInput {
  sale: {
    created_at: string;
    status: string;
    voided_at?: string | null;
    void_reason?: string | null;
    receipt_emailed_at?: string | null;
    receipt_email_to?: string | null;
  };
  /** Cobros con intent: aprobación del procesador. */
  intents?: { provider_key: string; status: string; updated_at: string }[];
  returns?: { number: number; created_at: string; total: number }[];
  mpRefunds?: { status: string; amount: number; created_at: string; completed_at: string | null }[];
  fiscal?: { origin: string; status: string; approved_at?: string | null; created_at: string }[];
  formatMoney?: (n: number) => string;
}

/** Hitos de la venta ordenados: creada, cobrada, facturada, email, devoluciones, reintegros MP, anulada. */
export function saleTimeline(input: SaleTimelineInput): SaleTimelineStep[] {
  const money = input.formatMoney ?? ((n: number) => String(n));
  const steps: SaleTimelineStep[] = [{ at: input.sale.created_at, label: "Venta registrada", tone: "success" }];
  for (const i of input.intents ?? []) {
    if (i.status === "approved") {
      steps.push({ at: i.updated_at, label: `Cobro aprobado por ${providerName(i.provider_key) ?? "el procesador"}`, tone: "success" });
    }
  }
  for (const d of input.fiscal ?? []) {
    if (d.status !== "aprobado") continue;
    const label = d.origin === "sale" ? "Factura aprobada por ARCA" : d.origin === "return" ? "Nota de crédito aprobada" : "Anulación informada a ARCA";
    steps.push({ at: d.approved_at ?? d.created_at, label, tone: "info" });
  }
  if (input.sale.receipt_emailed_at) {
    steps.push({
      at: input.sale.receipt_emailed_at,
      label: "Comprobante enviado por email",
      detail: input.sale.receipt_email_to ?? undefined,
      tone: "neutral",
    });
  }
  for (const r of input.returns ?? []) {
    steps.push({ at: r.created_at, label: `Devolución N° ${r.number}`, detail: money(Number(r.total) || 0), tone: "warning" });
  }
  for (const r of input.mpRefunds ?? []) {
    const ok = r.status === "approved" || r.status === "done" || r.status === "completed";
    steps.push({
      at: r.completed_at ?? r.created_at,
      label: ok ? "Reintegro por Mercado Pago" : "Reintegro por Mercado Pago en curso",
      detail: money(Number(r.amount) || 0),
      tone: ok ? "warning" : "neutral",
    });
  }
  if (input.sale.status === "voided" && input.sale.voided_at) {
    steps.push({ at: input.sale.voided_at, label: "Venta anulada", detail: input.sale.void_reason ?? undefined, tone: "danger" });
  }
  return steps
    .filter((s) => s.at && !Number.isNaN(Date.parse(s.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ── Impuestos ──────────────────────────────────────────────────────────────

export interface TaxRow {
  key: string;
  label: string;
  amount: number;
}

interface SaleTaxTotals {
  net_taxed?: number | string | null;
  net_untaxed?: number | string | null;
  net_exempt?: number | string | null;
  iva_total?: number | string | null;
  internal_tax_total?: number | string | null;
}

interface TaxLine {
  kind: string;
  tax: string;
  jurisdiction: string | null;
  rate: number | null;
  amount: number;
}

const rateText = (r: number | null) => (r == null ? "" : ` ${String(Number(r)).replace(".", ",")} %`);

/**
 * Desglose fiscal del detalle: neto gravado / no gravado / exento, IVA por
 * alícuota (o el total si no hay líneas), internos y percepciones. Sólo los
 * importes mayores a cero.
 */
export function taxBreakdown(sale: SaleTaxTotals, lines: TaxLine[]): TaxRow[] {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const out: TaxRow[] = [];
  const push = (key: string, label: string, amount: number) => {
    if (amount > 0) out.push({ key, label, amount: round2(amount) });
  };
  push("net_taxed", "Neto gravado", n(sale.net_taxed));
  push("net_untaxed", "No gravado", n(sale.net_untaxed));
  push("net_exempt", "Exento", n(sale.net_exempt));
  const iva = lines.filter((l) => l.kind === "iva");
  if (iva.length > 0) {
    const byRate = new Map<string, { rate: number | null; amount: number }>();
    for (const l of iva) {
      const k = String(l.rate ?? "");
      const prev = byRate.get(k) ?? { rate: l.rate, amount: 0 };
      prev.amount += n(l.amount);
      byRate.set(k, prev);
    }
    for (const [k, v] of byRate) push(`iva-${k}`, `IVA${rateText(v.rate)}`, v.amount);
  } else {
    push("iva", "IVA", n(sale.iva_total));
  }
  const internos = lines.filter((l) => l.kind === "internos").reduce((a, l) => a + n(l.amount), 0);
  push("internos", "Impuestos internos", internos > 0 ? internos : n(sale.internal_tax_total));
  lines
    .filter((l) => l.kind === "perception")
    .forEach((l, i) => push(`perc-${i}`, perceptionLabel(l), n(l.amount)));
  return out;
}

// ── Totales ────────────────────────────────────────────────────────────────

export interface TotalsInput {
  subtotal: number | string | null;
  discount_total?: number | string | null;
  promo_discount?: number | string | null;
  promo_name?: string | null;
  coupon_discount?: number | string | null;
  coupon_code?: string | null;
  perception_total?: number | string | null;
  total: number | string | null;
}

/**
 * Renglones de totales del detalle: subtotal, descuento, promociones (las de
 * sale_promotions o la promo única guardada en la venta), cupón, percepciones
 * y, si el total no cierra con eso, "Recargos y envío" (extras de create_sale:
 * recargo de tarjeta, garantía, envío). Los descuentos van en negativo.
 */
export function totalsBreakdown(sale: TotalsInput, promos: { label: string; amount: number }[] = []): TaxRow[] {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const out: TaxRow[] = [{ key: "subtotal", label: "Subtotal", amount: round2(n(sale.subtotal)) }];
  const disc = n(sale.discount_total);
  if (disc > 0) out.push({ key: "discount", label: "Descuento", amount: -round2(disc) });
  const promoTotal = n(sale.promo_discount);
  if (promos.length > 0) {
    promos.forEach((p, i) => {
      if (n(p.amount) > 0) out.push({ key: `promo-${i}`, label: p.label || "Promoción", amount: -round2(n(p.amount)) });
    });
  } else if (promoTotal > 0) {
    out.push({ key: "promo", label: sale.promo_name || "Promoción", amount: -round2(promoTotal) });
  }
  const coupon = n(sale.coupon_discount);
  if (coupon > 0) out.push({ key: "coupon", label: sale.coupon_code ? `Cupón ${sale.coupon_code}` : "Cupón", amount: -round2(coupon) });
  const perc = n(sale.perception_total);
  if (perc > 0) out.push({ key: "perceptions", label: "Percepciones", amount: round2(perc) });
  const expected = n(sale.subtotal) - disc - promoTotal - coupon + perc;
  const extras = round2(n(sale.total) - expected);
  if (extras > 0.01) out.push({ key: "extras", label: "Recargos y envío", amount: extras });
  return out;
}

// ── Resumen ────────────────────────────────────────────────────────────────

/** Período del resumen: el rango elegido o, sin rango, los últimos 30 días. */
export function summaryPeriod(
  range: { from?: Date; to?: Date } | undefined,
  now: Date = new Date(),
): { fromISO: string; toISO: string; label: string; isDefault: boolean } {
  if (range?.from) {
    const from = new Date(range.from);
    from.setHours(0, 0, 0, 0);
    const to = new Date(range.to ?? range.from);
    to.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() + 1);
    return { fromISO: from.toISOString(), toISO: to.toISOString(), label: "Período elegido", isDefault: false };
  }
  const to = new Date(now);
  to.setHours(0, 0, 0, 0);
  to.setDate(to.getDate() + 1);
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { fromISO: from.toISOString(), toISO: to.toISOString(), label: "Últimos 30 días", isDefault: true };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
