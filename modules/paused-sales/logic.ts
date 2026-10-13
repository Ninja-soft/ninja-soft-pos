// =============================================================================
// Pausar venta (ADR-106). PURO: serialización y restauración del estado de la
// venta en curso, reglas de descarte y de "Limpiar" según los pagos, avisos al
// retomar y la copia local para cuando no hay conexión.
//
// Una venta pausada guarda:
//   * el carrito tal cual (líneas, descuento, cupón, cliente, garantía
//     ofrecida, lista y condición de precio, notas);
//   * el estado de la hoja de cobro (líneas de pago, propina, garantía y
//     vendedor elegidos);
//   * los pagos, normalizados para el servidor (paused_sale_payments): las
//     líneas ya registradas en la hoja y el QR o link que estaba esperando.
// =============================================================================
import type { CartLine } from "@/modules/pos/store";
import type { CheckoutSnapshot, LiveIntent, PaidLine } from "@/components/pos/checkout/types";

export type PausedStatus = "paused" | "resumed" | "completed" | "discarded" | "expired";
export type PausedPaymentKind = "line" | "intent";
export type PausedPaymentStatus =
  | "confirmed"
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "used";

export interface PausedPayment {
  id?: string;
  kind: PausedPaymentKind;
  method: string;
  amount: number;
  reference?: string | null;
  card_voucher?: Record<string, unknown> | null;
  intent_id?: string | null;
  provider_key?: string | null;
  channel?: "qr" | "link" | null;
  /** Línea de la hoja (título, logo, recargos) para restaurarla igual. */
  line: Record<string, unknown>;
  status: PausedPaymentStatus;
  credited: boolean;
}

/** Carrito guardado (paused_sales.cart). */
export interface PausedCart {
  v: 1;
  lines: CartLine[];
  discountTotal: number;
  couponCode: string | null;
  customer: { id: string; name: string } | null;
  /** Garantía ofrecida en el carrito (H28). */
  offeredWarrantyId: string;
  /** Lista y condición de pago elegidas en el POS (ADR-058). */
  pricing: { listId: string | null; termId: string | null };
  /** Notas de la venta (create_sale p_notes), si el POS las cargó. */
  notes: string | null;
}

export interface PausedSale {
  id: string;
  tenant_id: string;
  store_id: string;
  register_id: string | null;
  cash_shift_id: string | null;
  created_by: string | null;
  resumed_by: string | null;
  customer_id: string | null;
  customer_name: string | null;
  label: string | null;
  cart: PausedCart;
  checkout: CheckoutSnapshot | null;
  total: number;
  paid_amount: number;
  item_count: number;
  status: PausedStatus;
  carry_over: boolean;
  needs_review: boolean;
  source: "online" | "offline";
  paused_at: string;
  resumed_at: string | null;
  /** Vencimiento del servidor (ADR-108): último movimiento + 24 h. */
  expires_at?: string | null;
  /** Venció con pagos vivos: no se vence sola, hay que resolverla. */
  expiry_held_at?: string | null;
  version: number;
  payments: PausedPayment[];
  /** Sólo en este equipo: se pausó sin conexión y falta subirla. */
  localOnly?: boolean;
}

// ── Pagos ────────────────────────────────────────────────────────────────────

/**
 * ¿La plata ya entró por un proveedor? Espejo de paused_payment_credited
 * (SQL). Efectivo, cuenta corriente y saldo a favor no: el efectivo está en el
 * cajón y los otros dos se cargan recién al confirmar la venta.
 */
export function isCreditedPayment(p: Pick<PausedPayment, "kind" | "method" | "status">): boolean {
  if (p.kind === "intent") return p.status === "approved" || p.status === "used";
  return !["cash", "account", "store_credit"].includes(p.method);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Copia serializable de una línea de la hoja (sin funciones ni undefined). */
function plainLine(l: PaidLine): Record<string, unknown> {
  return JSON.parse(JSON.stringify(l)) as Record<string, unknown>;
}

/** Pagos para el servidor a partir del estado de la hoja y el QR vivo. */
export function paymentsFromCheckout(snap: CheckoutSnapshot | null, live: LiveIntent | null): PausedPayment[] {
  const out: PausedPayment[] = [];
  for (const l of snap?.lines ?? []) {
    if (!(l.amount > 0)) continue;
    const p: PausedPayment = {
      kind: "line",
      method: l.method,
      amount: round2(l.amount),
      reference: l.reference ?? null,
      card_voucher: (l.card_voucher as Record<string, unknown> | undefined) ?? null,
      intent_id: l.method === "qr" && l.reference && UUID_RE.test(l.reference) ? l.reference : null,
      line: plainLine(l),
      status: "confirmed",
      credited: false,
    };
    p.credited = isCreditedPayment(p);
    out.push(p);
  }
  if (live && live.amount > 0) {
    out.push({
      kind: "intent",
      method: "qr",
      amount: round2(live.amount),
      intent_id: live.intentId,
      provider_key: live.provider,
      channel: live.channel,
      reference: null,
      card_voucher: null,
      line: {
        tenderId: live.tenderId,
        title: live.title,
        logo: live.logo,
        surcharges: live.surcharges,
        shareUrl: live.shareUrl,
      },
      status: "pending",
      credited: false,
    });
  }
  return out;
}

export interface PaymentClasses {
  /** Acreditado por un proveedor (QR cobrado, tarjeta con cupón, transferencia). */
  credited: number;
  creditedList: PausedPayment[];
  /** Efectivo recibido (está en el cajón). */
  cash: number;
  /** QR o link todavía esperando el pago. */
  pendingIntents: PausedPayment[];
  /** Todo lo cobrado (líneas y QR aprobados). */
  paid: number;
}

export function classifyPayments(payments: PausedPayment[]): PaymentClasses {
  const live = payments.filter((p) => p.status !== "cancelled" && p.status !== "expired" && p.status !== "rejected");
  const creditedList = live.filter((p) => p.credited || isCreditedPayment(p));
  return {
    credited: round2(creditedList.reduce((a, p) => a + p.amount, 0)),
    creditedList,
    cash: round2(live.filter((p) => p.kind === "line" && p.method === "cash").reduce((a, p) => a + p.amount, 0)),
    pendingIntents: live.filter((p) => p.kind === "intent" && p.status === "pending"),
    paid: round2(
      live.filter((p) => p.kind === "line" || p.status === "approved").reduce((a, p) => a + p.amount, 0),
    ),
  };
}

// ── Reglas de descarte y de "Limpiar" ────────────────────────────────────────

export type DiscardRule =
  /** Sin pagos: se descarta con una confirmación simple. */
  | { kind: "free"; pendingIntents: number }
  /** Hay efectivo recibido: confirmar que se devolvió. */
  | { kind: "confirm_cash"; cash: number; pendingIntents: number }
  /**
   * Hay pagos acreditados: no se descarta sin devolverlos. Dueño o encargado
   * pueden confirmar "ya lo devolví" con motivo; el resto ve qué hacer.
   */
  | { kind: "needs_refund"; credited: number; canOverride: boolean; cash: number };

export function discardRule(payments: PausedPayment[], role: string | null | undefined): DiscardRule {
  const c = classifyPayments(payments);
  if (c.credited > 0) {
    return { kind: "needs_refund", credited: c.credited, canOverride: role === "owner" || role === "manager", cash: c.cash };
  }
  if (c.cash > 0) return { kind: "confirm_cash", cash: c.cash, pendingIntents: c.pendingIntents.length };
  return { kind: "free", pendingIntents: c.pendingIntents.length };
}

export type ClearRule =
  /** Nada cobrado: limpiar sin rastro. */
  | { kind: "free" }
  /** Pagos en curso no acreditados (efectivo, QR pendiente): limpiar y auditar. */
  | { kind: "audit"; cash: number; pendingIntents: number }
  /** Pagos acreditados: no se limpia; se ofrece pausar. */
  | { kind: "blocked"; credited: number };

export function clearRule(payments: PausedPayment[]): ClearRule {
  const live = payments.filter((p) => p.status !== "cancelled" && p.status !== "expired" && p.status !== "rejected");
  if (live.length === 0) return { kind: "free" };
  const c = classifyPayments(live);
  if (c.credited > 0) return { kind: "blocked", credited: c.credited };
  return { kind: "audit", cash: c.cash, pendingIntents: c.pendingIntents.length };
}

// ── Serialización ────────────────────────────────────────────────────────────

export interface PauseInput {
  lines: CartLine[];
  discountTotal: number;
  couponCode: string | null;
  customer: { id: string; name: string } | null;
  offeredWarrantyId: string;
  pricing: { listId: string | null; termId: string | null };
  notes?: string | null;
}

/** Carrito para guardar (copia profunda: el store sigue cambiando después). */
export function buildPausedCart(input: PauseInput): PausedCart {
  return {
    v: 1,
    lines: JSON.parse(JSON.stringify(input.lines)) as CartLine[],
    discountTotal: Math.max(0, Number(input.discountTotal) || 0),
    couponCode: input.couponCode?.trim() ? input.couponCode.trim() : null,
    customer: input.customer ? { id: input.customer.id, name: input.customer.name } : null,
    offeredWarrantyId: input.offeredWarrantyId ?? "",
    pricing: { listId: input.pricing.listId ?? null, termId: input.pricing.termId ?? null },
    notes: input.notes?.trim() ? input.notes.trim() : null,
  };
}

function isLine(x: unknown): x is CartLine {
  if (!x || typeof x !== "object") return false;
  const l = x as Record<string, unknown>;
  return (
    typeof l.lineId === "string" &&
    typeof l.name === "string" &&
    Number.isFinite(Number(l.unitPrice)) &&
    Number.isFinite(Number(l.quantity))
  );
}

/** Lee el carrito guardado (tolera versiones viejas o datos a medias). */
export function readPausedCart(raw: unknown): PausedCart | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.lines)) return null;
  const lines = c.lines.filter(isLine).map((l) => ({
    ...l,
    unitPrice: Number(l.unitPrice),
    quantity: Number(l.quantity),
    discount: Number(l.discount) || 0,
    unit: typeof l.unit === "string" ? l.unit : "un",
  }));
  const cust = c.customer as { id?: unknown; name?: unknown } | null | undefined;
  const pricing = (c.pricing ?? {}) as { listId?: unknown; termId?: unknown };
  return {
    v: 1,
    lines,
    discountTotal: Math.max(0, Number(c.discountTotal) || 0),
    couponCode: typeof c.couponCode === "string" && c.couponCode.trim() ? c.couponCode : null,
    customer: cust && typeof cust.id === "string" ? { id: cust.id, name: String(cust.name ?? "") } : null,
    offeredWarrantyId: typeof c.offeredWarrantyId === "string" ? c.offeredWarrantyId : "",
    pricing: {
      listId: typeof pricing.listId === "string" ? pricing.listId : null,
      termId: typeof pricing.termId === "string" ? pricing.termId : null,
    },
    notes: typeof c.notes === "string" && c.notes.trim() ? c.notes : null,
  };
}

// ── Restauración ─────────────────────────────────────────────────────────────

/** Línea de la hoja para un QR que se aprobó mientras la venta estaba pausada. */
export function approvedIntentLine(p: PausedPayment): PaidLine {
  const line = p.line ?? {};
  const surcharges = Array.isArray(line.surcharges)
    ? (line.surcharges as { name: string; amount: number }[]).filter((s) => Number(s.amount) > 0)
    : [];
  const sc = round2(surcharges.reduce((a, s) => a + Number(s.amount), 0));
  return {
    key: `r-${p.intent_id ?? p.id ?? Math.random().toString(36).slice(2)}`,
    tenderId: typeof line.tenderId === "string" ? line.tenderId : "qr",
    title: typeof line.title === "string" ? line.title : "QR",
    detail: "Aprobado",
    logo: typeof line.logo === "string" ? line.logo : null,
    method: "qr",
    amount: p.amount,
    surcharge: sc,
    surchargeItems: surcharges,
    reference: p.intent_id ?? undefined,
    locked: true,
    promoEligible: true,
  };
}

function restoredLine(p: PausedPayment, i: number): PaidLine | null {
  const l = p.line as Partial<PaidLine>;
  if (!l || typeof l !== "object" || typeof l.method !== "string") return null;
  return {
    ...(l as PaidLine),
    key: `r${i}-${l.key ?? i}`,
    amount: Number(l.amount) || p.amount,
    surcharge: Number(l.surcharge) || 0,
    surchargeItems: Array.isArray(l.surchargeItems) ? l.surchargeItems : [],
    // Lo que ya cobró un proveedor no se quita desde la hoja.
    locked: Boolean(l.locked) || (p.method === "qr" && Boolean(p.intent_id)),
    promoEligible: l.promoEligible !== false,
  };
}

export interface RestorePlan {
  cart: PausedCart;
  /** Estado de la hoja a restaurar (null = la hoja arranca de cero). */
  checkout: CheckoutSnapshot | null;
  /** Avisos para el cajero (QR vencido, rechazado, cobrado en la pausa). */
  notices: string[];
}

/** Cómo queda la venta al retomarla, con los pagos ya conciliados. */
export function restorePlan(sale: Pick<PausedSale, "cart" | "checkout" | "payments">): RestorePlan | null {
  const cart = readPausedCart(sale.cart);
  if (!cart) return null;
  const notices: string[] = [];
  const lines: PaidLine[] = [];
  const ordered = [...(sale.payments ?? [])];
  ordered.forEach((p, i) => {
    if (p.kind === "line") {
      const l = restoredLine(p, i);
      if (l) lines.push(l);
      return;
    }
    if (p.status === "approved") {
      lines.push(approvedIntentLine(p));
      notices.push(`El QR de ${fmt(p.amount)} se cobró mientras la venta estaba pausada.`);
    } else if (p.status === "expired") {
      notices.push(`El QR de ${fmt(p.amount)} venció: generalo de nuevo al cobrar.`);
    } else if (p.status === "rejected") {
      notices.push(`El pago del QR de ${fmt(p.amount)} fue rechazado.`);
    } else if (p.status === "cancelled") {
      notices.push(`El QR de ${fmt(p.amount)} quedó cancelado: generalo de nuevo al cobrar.`);
    }
  });
  const base = sale.checkout && typeof sale.checkout === "object" ? sale.checkout : null;
  const hasState =
    lines.length > 0 ||
    Boolean(base && (base.tipPct != null || base.tipCustom || base.warrantyId || base.professionalId));
  return {
    cart,
    checkout: hasState
      ? {
          v: 1,
          lines,
          tipPct: base?.tipPct ?? null,
          tipCustom: base?.tipCustom ?? "",
          warrantyId: base?.warrantyId ?? "",
          warrantyLineId: base?.warrantyLineId ?? "",
          professionalId: base?.professionalId ?? "",
        }
      : null,
    notices,
  };
}

function fmt(n: number): string {
  return `$${n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ── Avisos al retomar ────────────────────────────────────────────────────────

export interface LinePriceChange {
  lineId: string;
  name: string;
  from: number;
  to: number;
}

/**
 * Líneas cuyo precio de lista cambió desde que se pausó (mismo resolver que el
 * servidor, ADR-058). No se tocan las de precio manual, regalos, packs ni las
 * de monto libre: esas las decide el servidor por su lado.
 */
export function priceChanges(
  lines: CartLine[],
  priceFor: (productId: string, variantId: string | null, current: number, qty: number) => number | null,
): LinePriceChange[] {
  const out: LinePriceChange[] = [];
  for (const l of lines) {
    if (!l.productId || l.priceOverride || l.giftPromoId || l.packCreditId || l.packId) continue;
    // Con modificadores el precio incluye los deltas: el servidor lo valida.
    if (l.modifiers && l.modifiers.length > 0) continue;
    const to = priceFor(l.productId, l.variantId ?? null, l.unitPrice, l.quantity);
    if (to == null || !Number.isFinite(to)) continue;
    if (Math.abs(to - l.unitPrice) > 0.009) out.push({ lineId: l.lineId, name: l.name, from: l.unitPrice, to });
  }
  return out;
}

/** Texto del cambio de total entre la pausa y el retomar (null si no cambió). */
export function totalChangeNotice(before: number, after: number): string | null {
  if (!(before > 0) || Math.abs(before - after) < 0.01) return null;
  return `El total cambió de ${fmt(before)} a ${fmt(after)} (precios o promos vigentes).`;
}

// ── Presentación ─────────────────────────────────────────────────────────────

/** Nombre por defecto: el cliente o "Venta 14:32". */
export function defaultPausedLabel(customerName: string | null | undefined, at: Date = new Date()): string {
  if (customerName?.trim()) return customerName.trim().slice(0, 60);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `Venta ${hh}:${mm}`;
}

export function pausedTitle(s: Pick<PausedSale, "label" | "customer_name" | "paused_at">): string {
  return s.label?.trim() || defaultPausedLabel(s.customer_name, new Date(s.paused_at));
}

/** Hora corta de la pausa (hoy: "14:32"; otro día: "12/10 14:32"). */
export function pausedTimeLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return same ? hm : `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
}

export type PausedBadge = { tone: "success" | "warning" | "info" | "neutral"; text: string };

export function pausedBadges(s: PausedSale): PausedBadge[] {
  const out: PausedBadge[] = [];
  const c = classifyPayments(s.payments ?? []);
  if (s.needs_review) out.push({ tone: "warning", text: "Revisar pago" });
  if (c.credited > 0) out.push({ tone: "success", text: `Cobrado ${fmt(c.credited)}` });
  if (c.cash > 0 && c.credited === 0) out.push({ tone: "neutral", text: `Efectivo ${fmt(c.cash)}` });
  if (c.pendingIntents.length > 0) out.push({ tone: "info", text: "QR esperando" });
  if (s.localOnly) out.push({ tone: "warning", text: "Sin subir" });
  if (s.status === "resumed") out.push({ tone: "info", text: "En curso" });
  return out;
}

// ── Vencimiento (ADR-108) ────────────────────────────────────────────────────

/** Vida de una venta pausada. Espejo de paused_sale_ttl() (SQL). */
export const PAUSED_TTL_HOURS = 24;
/** Desde cuándo se resalta como "vence pronto". */
export const PAUSED_SOON_HOURS = 2;
const HOUR = 3_600_000;

/** ¿Tiene pagos vivos? Espejo de _paused_sale_has_live_payments (SQL). */
export function hasLivePayments(payments: Pick<PausedPayment, "status">[]): boolean {
  return payments.some((p) => ["confirmed", "pending", "approved", "used"].includes(p.status));
}

/** Vencimiento: el del servidor o, si no vino, último movimiento + 24 h. */
export function pausedExpiresAt(s: Pick<PausedSale, "expires_at" | "paused_at" | "resumed_at">): Date {
  if (s.expires_at) {
    const d = new Date(s.expires_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const paused = new Date(s.paused_at).getTime();
  const resumed = s.resumed_at ? new Date(s.resumed_at).getTime() : paused;
  return new Date(Math.max(paused || 0, resumed || 0) + PAUSED_TTL_HOURS * HOUR);
}

export type PausedExpiry =
  /** Falta más de PAUSED_SOON_HOURS. */
  | { kind: "ok"; msLeft: number; label: string }
  /** Vence pronto: se resalta. */
  | { kind: "soon"; msLeft: number; label: string }
  /** Venció con pagos: no se borra, hay que resolverla. */
  | { kind: "held"; msLeft: number; label: string }
  /** Venció sin pagos: el servidor ya no la lista ni la retoma. */
  | { kind: "expired"; msLeft: number; label: string };

/** "en 5 h", "en 1 h 20 min", "en 12 min", "en menos de 1 min". */
export function leftLabel(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "en menos de 1 min";
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h < PAUSED_SOON_HOURS && m > 0 ? `en ${h} h ${m} min` : `en ${h} h`;
}

export function pausedExpiry(
  s: Pick<PausedSale, "expires_at" | "paused_at" | "resumed_at" | "payments">,
  now: Date = new Date(),
): PausedExpiry {
  const msLeft = pausedExpiresAt(s).getTime() - now.getTime();
  if (msLeft <= 0) {
    return hasLivePayments(s.payments ?? [])
      ? { kind: "held", msLeft, label: "Venció: tiene pagos, resolvela" }
      : { kind: "expired", msLeft, label: "Venció" };
  }
  const label = `Vence ${leftLabel(msLeft)}`;
  return msLeft <= PAUSED_SOON_HOURS * HOUR ? { kind: "soon", msLeft, label } : { kind: "ok", msLeft, label };
}

/** ¿Se muestra en el POS? Abierta y sin vencer (o vencida con pagos). */
export function isPausedVisible(s: PausedSale, now: Date = new Date()): boolean {
  if (s.status !== "paused" && s.status !== "resumed") return false;
  return pausedExpiry(s, now).kind !== "expired";
}

// ── Contenido para la tarjeta ────────────────────────────────────────────────

export interface PausedPreviewLine {
  lineId: string;
  productId: string | null;
  name: string;
  detail: string | null;
  quantity: number;
  unit: string;
  subtotal: number;
}

/** Líneas para mostrar: las primeras `max` y el resto aparte ("+N más"). */
export function pausedPreview(
  lines: CartLine[],
  max = 3,
): { shown: PausedPreviewLine[]; hidden: PausedPreviewLine[]; units: number } {
  const all = lines.map((l) => ({
    lineId: l.lineId,
    productId: l.productId,
    name: l.name,
    detail: [l.variantLabel, l.modifiersLabel].filter((x) => x && x.trim()).join(" · ") || null,
    quantity: Number(l.quantity) || 0,
    unit: l.unit || "un",
    subtotal: round2(l.packCreditId ? 0 : l.unitPrice * l.quantity - (l.discount || 0)),
  }));
  const units = round2(all.reduce((a, l) => a + (l.unit === "un" ? l.quantity : 1), 0));
  return { shown: all.slice(0, max), hidden: all.slice(max), units };
}

// ── Copia local (sin conexión) ───────────────────────────────────────────────

export const LOCAL_KEY_PREFIX = "ninja_paused_sales_v1";

export function localKey(tenantId: string, userId: string): string {
  return `${LOCAL_KEY_PREFIX}:${tenantId}:${userId}`;
}

export function serializeLocal(list: PausedSale[]): string {
  return JSON.stringify({ v: 1, items: list.map((s) => ({ ...s, localOnly: true })) });
}

export function parseLocal(raw: string | null | undefined): PausedSale[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as { v?: number; items?: unknown };
    if (data.v !== 1 || !Array.isArray(data.items)) return [];
    return (data.items as PausedSale[])
      .filter((s) => s && typeof s.id === "string" && readPausedCart(s.cart) !== null)
      .map((s) => ({ ...s, localOnly: true, payments: Array.isArray(s.payments) ? s.payments : [] }));
  } catch {
    return [];
  }
}

/** Server + las locales que todavía no subieron (por id gana el servidor). */
export function mergePaused(server: PausedSale[], local: PausedSale[]): PausedSale[] {
  const ids = new Set(server.map((s) => s.id));
  const merged = [...server, ...local.filter((l) => !ids.has(l.id))];
  return merged.sort((a, b) => (a.paused_at < b.paused_at ? 1 : a.paused_at > b.paused_at ? -1 : 0));
}

// ── Errores ──────────────────────────────────────────────────────────────────

export function pausedErrorCopy(msg: string): string {
  if (msg.includes("paused_sale_has_payments"))
    return "Tiene pagos cobrados: devolvelos o retomala y terminá la venta antes de descartarla.";
  if (msg.includes("refund_requires_manager")) return "Sólo el dueño o un encargado confirma que se devolvió el pago.";
  if (msg.includes("reason_required")) return "Escribí el motivo del descarte.";
  if (msg.includes("paused_sale_intent_pending")) return "El QR de esta venta todavía está esperando el pago.";
  if (msg.includes("paused_sale_in_use")) return "Otra persona está cobrando esta venta.";
  if (msg.includes("paused_sale_closed")) return "Esta venta ya se cobró o se descartó.";
  if (msg.includes("paused_sale_already_charged")) return "Esta venta ya se registró con su QR.";
  if (msg.includes("paused_sale_expired")) return "Esta venta pausada venció (pasaron 24 h) y ya no se puede retomar.";
  if (msg.includes("paused_sale_not_found")) return "No encontramos la venta pausada.";
  if (msg.includes("paused_sale_other_store")) return "La venta se pausó en otra sucursal: retomala desde allá.";
  if (msg.includes("too_many_paused_sales")) return "Hay demasiadas ventas pausadas en la sucursal: retomá o descartá alguna.";
  if (msg.includes("intent_in_other_paused_sale") || msg.includes("intent_already_parked"))
    return "Ese QR ya está en otra venta pausada o en un cobro en espera.";
  if (msg.includes("intent_already_used")) return "Ese QR ya se usó en una venta.";
  if (msg.includes("qr_not_approved")) return "El QR de la venta no está aprobado.";
  if (msg.includes("shift_not_owned")) return "Esta caja la tiene abierta otra persona.";
  if (msg.includes("shift_not_open")) return "La caja de esta venta ya está cerrada.";
  if (msg.includes("store_not_allowed")) return "No operás en esta sucursal.";
  if (msg.includes("version_conflict")) return "La venta cambió en otra caja: actualizá la lista.";
  if (msg.includes("forbidden_read_only")) return "Tu usuario es de solo lectura.";
  if (msg.includes("sale_has_credited_payments")) return "Hay pagos cobrados: pausá la venta en vez de limpiarla.";
  return "No se pudo completar la acción con la venta pausada.";
}
