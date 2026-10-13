// F9: Motor de promociones (ADR-074).
//
// Motor PURO (sin DOM, sin red, sin estado). Lo usan el POS (vista previa del
// carrito y del cobro), el simulador y el admin ("así se ve en el ticket"). El
// servidor tiene el MISMO motor en SQL (`_promo_eval_core`, migración
// 20261102100100_promociones_motor) y create_sale es la autoridad: si el
// descuento que manda el POS no coincide, rechaza con `promo_mismatch`. La
// paridad se prueba con la matriz de tests/fixtures/promoMatrix.ts (unit contra
// este archivo, integración contra la base).
//
// Reglas (iguales en los dos lados):
//   · Líneas que participan: con producto, que no son regalo ni sesión de pack
//     y con importe > 0 (`excluded` las saca). Recargos, garantía y venta libre
//     no reciben promos.
//   · Condiciones: activa, vigencia por fecha (AR), días, franja horaria,
//     sucursal, lista de precios, medio de pago / marca de tarjeta / banco
//     (todos los pagos deben cumplir), topes de usos (total y por cliente),
//     monto mínimo (sobre las líneas que participan) y algo en el alcance.
//   · Acciones: percent, amount, fixed_price, nxm, second_item, volume_tier,
//     bundle (combo a precio fijo por juego completo) y gift (aparte).
//   · Tope por ticket (`max_discount`): el descuento de la promo no lo supera.
//   · Combinabilidad: las acumulables se aplican en orden de prioridad (mayor
//     primero, luego id), cada una sobre lo que dejó la anterior; cada
//     excluyente se calcula sola. Gana lo que más descuenta (mejor precio para
//     el cliente); ante empate, la excluyente de mayor prioridad.
//   · Redondeo a centavos por línea (r2), mismo orden de operaciones que SQL.

export type PromoScope = "cart" | "category" | "product" | "brand";
export type PromoActionType =
  | "percent"
  | "amount"
  | "nxm"
  | "fixed_price"
  | "second_item"
  | "volume_tier"
  | "bundle"
  | "gift";

export interface PromoVolumeTier {
  min_qty: number;
  pct: number;
}

/** Componente de un combo: producto y unidades por juego. */
export interface PromoBundleItem {
  product_id: string;
  qty: number;
}

export interface Promotion {
  id: string;
  name: string;
  is_active: boolean;
  /** Mayor número = se aplica antes y gana los empates. */
  priority: number;
  valid_from: string | null;
  valid_to: string | null;
  days_of_week: number[] | null;
  time_from: number | null;
  time_to: number | null;
  min_amount: number;
  scope: PromoScope;
  scope_category_id: string | null;
  scope_product_id: string | null;
  action_type: PromoActionType;
  action_value: number;
  buy_qty: number | null;
  pay_qty: number | null;
  volume_tiers: PromoVolumeTier[] | null;
  /** Medio exigido (cash, debit, credit...). null = cualquiera. */
  payment_method: string | null;
  gift_product_id: string | null;
  gift_qty: number | null;
  // ── ADR-074 ──
  /** Marca del alcance 'brand' (o la primera de scope_ids). */
  scope_brand_id?: string | null;
  /** Varios ids del alcance (categorías, productos o marcas). Vacío = el id simple. */
  scope_ids?: string[] | null;
  /** Combo: productos y unidades por juego; action_value = precio del juego. */
  bundle_items?: PromoBundleItem[] | null;
  /** Marcas de tarjeta (visa, master, amex...). Vacío = cualquiera. */
  card_brands?: string[] | null;
  /** Bancos emisores (slug de lib/payments/banks). Vacío = cualquiera. */
  banks?: string[] | null;
  /** Sucursales donde vale. Vacío = todo el negocio (herencia negocio → sucursal). */
  store_ids?: string[] | null;
  /** Listas de precios con las que vale. Vacío = cualquiera. */
  price_list_ids?: string[] | null;
  /** Acumulable con otras acumulables. false = excluyente. */
  stackable?: boolean | null;
  /** Tope de descuento por ticket. null = sin tope. */
  max_discount?: number | null;
  /** Tope de usos totales (ventas no anuladas). */
  max_uses_total?: number | null;
  /** Tope de usos por cliente (exige cliente en la venta). */
  max_uses_per_customer?: number | null;
  /** Texto para el ticket. null = el nombre. */
  ticket_label?: string | null;
}

export interface PromoCartLine {
  productId: string | null;
  categoryId: string | null;
  brandId?: string | null;
  unitPrice: number;
  quantity: number;
  /** Importe de la línea ya neto de su descuento (qty × precio − desc). */
  lineTotal: number;
  /** Regalo, sesión de pack, etc.: no participa. */
  excluded?: boolean;
}

export interface PromoPayment {
  method: string;
  /** Marca de la tarjeta (clave o etiqueta: "visa", "Mastercard"...). */
  cardBrand?: string | null;
  /** Banco emisor (slug). */
  bank?: string | null;
  /**
   * El POS no pudo evaluar este pago al calcular (Point: el medio real se sabe
   * al final). Las promos con condición de cobro no aplican.
   */
  ineligible?: boolean;
}

export interface PromoUsage {
  total: number;
  customer: number;
}

export interface PromoContext {
  weekday: number; // 0=domingo..6=sábado (AR)
  minutes: number; // minutos del día (AR)
  date: string; // YYYY-MM-DD (AR)
  /** Atajo de un solo medio (compatibilidad). */
  paymentMethod?: string | null;
  /** Pagos de la venta. Sin pagos, las promos por medio no aplican. */
  payments?: PromoPayment[] | null;
  storeId?: string | null;
  priceListId?: string | null;
  customerId?: string | null;
  /** Usos por promo (ventas no anuladas), para los topes. */
  usage?: Record<string, PromoUsage> | null;
}

export interface PromoResult {
  promotionId: string;
  name: string;
  discount: number;
}

export interface AppliedPromo {
  promotionId: string;
  name: string;
  /** Texto del ticket (ticket_label o nombre). */
  label: string;
  discount: number;
  stackable: boolean;
  /** Descuento por línea (mismo índice que las líneas de entrada). */
  lines: number[];
}

export interface GiftResult {
  promotionId: string;
  name: string;
  giftProductId: string;
  giftQty: number;
}

export interface PromoEvaluation {
  discount: number;
  applied: AppliedPromo[];
  gifts: GiftResult[];
}

// ── Utilidades ────────────────────────────────────────────────────────────────

/** Redondeo a centavos, mitad hacia arriba (igual que round(numeric, 2)). */
export function r2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const s = x < 0 ? -1 : 1;
  return (s * Math.round(Math.abs(x) * 100 + 1e-6)) / 100;
}

const cents = (x: number) => Math.round(x * 100);

const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

/** Clave de marca de tarjeta: acepta clave o etiqueta (espejo de _promo_card_key). */
export function cardKey(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "mastercard" || s === "master") return "master";
  if (s === "american express" || s === "americanexpress" || s === "amex") return "amex";
  return s;
}

/** Línea que participa de las promos. */
function eligible(l: PromoCartLine): boolean {
  return !l.excluded && Boolean(l.productId) && (l.lineTotal || 0) > 0 && (l.quantity || 0) > 0;
}

/** Subtotal de las líneas que participan. */
export function cartSubtotal(lines: PromoCartLine[]): number {
  return r2(lines.reduce((a, l) => a + (eligible(l) ? l.lineTotal : 0), 0));
}

function scopeIds(p: Promotion): string[] {
  const many = arr(p.scope_ids).filter(Boolean);
  if (many.length > 0) return many;
  const one =
    p.scope === "category"
      ? p.scope_category_id
      : p.scope === "product"
        ? p.scope_product_id
        : p.scope === "brand"
          ? (p.scope_brand_id ?? null)
          : null;
  return one ? [one] : [];
}

/** ¿La línea i entra en el alcance de la promo? (el combo usa sus productos). */
function inScope(p: Promotion, l: PromoCartLine): boolean {
  if (p.action_type === "bundle") {
    return arr(p.bundle_items).some((b) => b.product_id === l.productId);
  }
  if (p.scope === "cart") return true;
  const ids = scopeIds(p);
  if (p.scope === "category") return Boolean(l.categoryId) && ids.includes(l.categoryId as string);
  if (p.scope === "product") return Boolean(l.productId) && ids.includes(l.productId as string);
  if (p.scope === "brand") return Boolean(l.brandId) && ids.includes(l.brandId as string);
  return false;
}

function paymentsOk(p: Promotion, ctx: PromoContext): boolean {
  const brands = arr(p.card_brands);
  const banks = arr(p.banks);
  if (!p.payment_method && brands.length === 0 && banks.length === 0) return true;
  const pays: PromoPayment[] =
    ctx.payments && ctx.payments.length > 0
      ? ctx.payments
      : ctx.paymentMethod
        ? [{ method: ctx.paymentMethod }]
        : [];
  if (pays.length === 0) return false;
  return pays.every((x) => {
    if (x.ineligible) return false;
    if (p.payment_method && x.method !== p.payment_method) return false;
    if (brands.length > 0) {
      if (x.method !== "debit" && x.method !== "credit") return false;
      const k = cardKey(x.cardBrand);
      if (!k || !brands.includes(k)) return false;
    }
    if (banks.length > 0 && !(x.bank && banks.includes(x.bank))) return false;
    return true;
  });
}

// ── Condiciones ───────────────────────────────────────────────────────────────

/** ¿La promo aplica al carrito en este contexto? (no mira el monto del descuento). */
export function promoApplies(promo: Promotion, lines: PromoCartLine[], ctx: PromoContext): boolean {
  if (!promo.is_active) return false;
  if (promo.valid_from && ctx.date < promo.valid_from) return false;
  if (promo.valid_to && ctx.date > promo.valid_to) return false;
  const days = arr(promo.days_of_week);
  if (days.length > 0 && !days.includes(ctx.weekday)) return false;
  if (promo.time_from != null && ctx.minutes < promo.time_from) return false;
  if (promo.time_to != null && ctx.minutes >= promo.time_to) return false;
  const stores = arr(promo.store_ids);
  if (stores.length > 0 && !(ctx.storeId && stores.includes(ctx.storeId))) return false;
  const lists = arr(promo.price_list_ids);
  if (lists.length > 0 && !(ctx.priceListId && lists.includes(ctx.priceListId))) return false;
  if (!paymentsOk(promo, ctx)) return false;
  const use = ctx.usage?.[promo.id];
  if (promo.max_uses_total != null && (use?.total ?? 0) >= promo.max_uses_total) return false;
  if (promo.max_uses_per_customer != null) {
    if (!ctx.customerId) return false;
    if ((use?.customer ?? 0) >= promo.max_uses_per_customer) return false;
  }
  if (cents(cartSubtotal(lines)) < cents(promo.min_amount || 0)) return false;
  return lines.some((l) => eligible(l) && inScope(promo, l));
}

// ── Asignación por línea ──────────────────────────────────────────────────────

/** Reparte `d` en proporción a `w` (el último absorbe el redondeo). */
function distribute(d: number, w: number[]): number[] {
  const out = w.map(() => 0);
  const idx = w.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0 || d <= 0) return out;
  const total = idx.reduce((a, i) => a + (w[i] ?? 0), 0);
  let acc = 0;
  idx.forEach((i, k) => {
    const wi = w[i] ?? 0;
    const v = k === idx.length - 1 ? r2(d - acc) : r2((d * wi) / total);
    out[i] = Math.max(0, Math.min(v, wi));
    acc = r2(acc + (out[i] ?? 0));
  });
  return out;
}

interface Unit {
  i: number;
  u: number;
}

/** Unidades enteras de las líneas del alcance, con su precio neto restante. */
function unitsOf(rem: number[], lines: PromoCartLine[], ok: boolean[], desc: boolean): Unit[] {
  const units: Unit[] = [];
  lines.forEach((l, i) => {
    if (!ok[i]) return;
    const k = Math.trunc(l.quantity || 0);
    // Precio unitario a 6 decimales: mismo orden que round(rem / qty, 6) en SQL.
    const u = Math.round(((rem[i] ?? 0) / (l.quantity || 1)) * 1e6) / 1e6;
    for (let j = 0; j < k; j++) units.push({ i, u });
  });
  units.sort((a, b) => (a.u !== b.u ? (desc ? b.u - a.u : a.u - b.u) : a.i - b.i));
  return units;
}

/** Descuento de la promo línea por línea, sobre lo que queda (`rem`). */
export function promoAllocation(promo: Promotion, lines: PromoCartLine[], rem: number[]): number[] {
  const n = lines.length;
  const zero = () => new Array<number>(n).fill(0);
  const ok = lines.map((l, i) => eligible(l) && (rem[i] ?? 0) > 0 && inScope(promo, l));
  const base = r2(rem.reduce((a, x, i) => a + (ok[i] ? x : 0), 0));
  if (base <= 0) return zero();
  const v = Number(promo.action_value) || 0;
  let out = zero();

  const pctOf = (pct: number) =>
    rem.map((x, i) => (ok[i] ? Math.min(x, r2((x * pct) / 100)) : 0));
  const byCount = (count: number[], pct: number) =>
    rem.map((x, i) => {
      const c = count[i] ?? 0;
      if (!ok[i] || c <= 0) return 0;
      const q = lines[i]?.quantity || 1;
      return Math.min(x, r2((x * c * pct) / (q * 100)));
    });

  switch (promo.action_type) {
    case "percent":
      out = pctOf(Math.min(Math.max(v, 0), 100));
      break;
    case "amount":
      out = distribute(Math.min(v, base), rem.map((x, i) => (ok[i] ? x : 0)));
      break;
    case "fixed_price":
      out = distribute(Math.max(r2(base - v), 0), rem.map((x, i) => (ok[i] ? x : 0)));
      break;
    case "volume_tier": {
      const qty = lines.reduce((a, l, i) => a + (ok[i] ? Math.max(0, l.quantity || 0) : 0), 0);
      let pct = 0;
      for (const t of arr(promo.volume_tiers)) {
        const mq = Number(t?.min_qty) || 0;
        const tp = Number(t?.pct) || 0;
        if (mq >= 1 && qty >= mq && tp > pct) pct = tp;
      }
      if (pct > 0) out = pctOf(Math.min(pct, 100));
      break;
    }
    case "nxm": {
      const bn = Math.trunc(promo.buy_qty || 0);
      const pm = Math.trunc(promo.pay_qty || 0);
      if (bn < 2 || pm < 1 || pm >= bn) break;
      const units = unitsOf(rem, lines, ok, false);
      const free = Math.floor(units.length / bn) * (bn - pm);
      const count = new Array<number>(n).fill(0);
      for (let k = 0; k < free && k < units.length; k++) count[units[k]!.i] = (count[units[k]!.i] ?? 0) + 1;
      out = byCount(count, 100);
      break;
    }
    case "second_item": {
      const pct = Math.min(Math.max(v, 0), 100);
      if (pct <= 0) break;
      const units = unitsOf(rem, lines, ok, false);
      const pairs = Math.floor(units.length / 2);
      const count = new Array<number>(n).fill(0);
      for (let k = 0; k < pairs; k++) {
        const it = units[2 * k]!;
        count[it.i] = (count[it.i] ?? 0) + 1;
      }
      out = byCount(count, pct);
      break;
    }
    case "bundle": {
      const items = arr(promo.bundle_items).filter((b) => b.product_id && Math.trunc(b.qty) >= 1);
      if (items.length === 0) break;
      const units = unitsOf(rem, lines, ok, true);
      let sets = Infinity;
      for (const b of items) {
        const have = units.filter((x) => lines[x.i]?.productId === b.product_id).length;
        sets = Math.min(sets, Math.floor(have / Math.trunc(b.qty)));
      }
      if (!Number.isFinite(sets) || sets <= 0) break;
      const count = new Array<number>(n).fill(0);
      for (const b of items) {
        let need = sets * Math.trunc(b.qty);
        for (const x of units) {
          if (need <= 0) break;
          if (lines[x.i]?.productId !== b.product_id) continue;
          count[x.i] = (count[x.i] ?? 0) + 1;
          need--;
        }
      }
      const taken = byCount(count, 100);
      const value = r2(taken.reduce((a, x) => a + x, 0));
      out = distribute(Math.max(r2(value - sets * v), 0), taken);
      break;
    }
    default:
      out = zero();
  }

  const total = r2(out.reduce((a, x) => a + x, 0));
  const cap = promo.max_discount;
  if (cap != null && cap >= 0 && total > cap) out = distribute(r2(cap), out);
  return out;
}

/** Descuento de una promo sola sobre el carrito (sin condiciones). */
export function promoDiscount(promo: Promotion, lines: PromoCartLine[]): number {
  const rem = lines.map((l) => (eligible(l) ? l.lineTotal : 0));
  return r2(promoAllocation(promo, lines, rem).reduce((a, x) => a + x, 0));
}

const byPriority = (a: Promotion, b: Promotion) =>
  b.priority !== a.priority ? b.priority - a.priority : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function applied(p: Promotion, alloc: number[]): AppliedPromo {
  return {
    promotionId: p.id,
    name: p.name,
    label: (p.ticket_label ?? "").trim() || p.name,
    discount: r2(alloc.reduce((a, x) => a + x, 0)),
    stackable: Boolean(p.stackable),
    lines: alloc,
  };
}

/**
 * Evalúa todas las promociones: devuelve el descuento total, cada promo
 * aplicada (para el carrito y el ticket) y los regalos.
 */
export function evaluatePromotions(
  lines: PromoCartLine[],
  promos: Promotion[],
  ctx: PromoContext,
): PromoEvaluation {
  const cands = promos
    .filter((p) => p.action_type !== "gift" && promoApplies(p, lines, ctx))
    .sort(byPriority);
  const orig = lines.map((l) => (eligible(l) ? l.lineTotal : 0));

  // Acumulables, en orden, cada una sobre lo que queda.
  const rem = [...orig];
  const stack: AppliedPromo[] = [];
  for (const p of cands) {
    if (!p.stackable) continue;
    const alloc = promoAllocation(p, lines, rem);
    const a = applied(p, alloc);
    if (a.discount <= 0) continue;
    alloc.forEach((x, i) => (rem[i] = r2((rem[i] ?? 0) - x)));
    stack.push(a);
  }
  const stackTotal = r2(stack.reduce((a, x) => a + x.discount, 0));

  // Excluyentes, cada una sola: gana la que más descuenta (prioridad en empate).
  let best: AppliedPromo[] = [];
  let bestTotal = 0;
  for (const p of cands) {
    if (p.stackable) continue;
    const a = applied(p, promoAllocation(p, lines, orig));
    if (cents(a.discount) > cents(bestTotal)) {
      best = [a];
      bestTotal = a.discount;
    }
  }
  if (cents(stackTotal) > cents(bestTotal)) {
    best = stack;
    bestTotal = stackTotal;
  }

  return { discount: r2(bestTotal), applied: best, gifts: evaluateGifts(lines, promos, ctx) };
}

/** Compatibilidad: la mejor promo como una sola (nombres unidos si hay varias). */
export function evaluateCart(
  lines: PromoCartLine[],
  promos: Promotion[],
  ctx: PromoContext,
): PromoResult | null {
  const ev = evaluatePromotions(lines, promos, ctx);
  if (ev.discount <= 0 || ev.applied.length === 0) return null;
  return {
    promotionId: ev.applied[0]!.promotionId,
    name: ev.applied.map((a) => a.name).join(" + "),
    discount: ev.discount,
  };
}

/** Regalos por compra: todas las promos de regalo que se cumplen. */
export function evaluateGifts(
  lines: PromoCartLine[],
  promos: Promotion[],
  ctx: PromoContext,
): GiftResult[] {
  const out: GiftResult[] = [];
  for (const promo of [...promos].sort(byPriority)) {
    if (promo.action_type !== "gift" || !promo.gift_product_id) continue;
    if (!promoApplies(promo, lines, ctx)) continue;
    out.push({
      promotionId: promo.id,
      name: promo.name,
      giftProductId: promo.gift_product_id,
      giftQty: Math.max(1, Math.trunc(promo.gift_qty || 1)),
    });
  }
  return out;
}

// ── Simulador (H56) ───────────────────────────────────────────────────────────

export interface SimSale {
  weekday: number;
  minutes: number;
  date: string;
  lines: PromoCartLine[];
}

export interface SimResult {
  ticketsAnalyzed: number;
  ticketsWithPromo: number;
  totalDiscount: number;
  totalSold: number;
}

/** Corre UNA promo (aunque esté en borrador) contra ventas históricas. */
export function simulatePromotion(promo: Promotion, sales: SimSale[]): SimResult {
  // Sin condiciones de medio, sucursal, lista ni topes: el histórico no las trae.
  const draft: Promotion = {
    ...promo,
    is_active: true,
    payment_method: null,
    card_brands: null,
    banks: null,
    store_ids: null,
    price_list_ids: null,
    max_uses_total: null,
    max_uses_per_customer: null,
  };
  let ticketsWithPromo = 0;
  let totalDiscount = 0;
  let totalSold = 0;
  for (const s of sales) {
    totalSold += cartSubtotal(s.lines);
    const ctx: PromoContext = { weekday: s.weekday, minutes: s.minutes, date: s.date };
    if (!promoApplies(draft, s.lines, ctx)) continue;
    const d = promoDiscount(draft, s.lines);
    if (d <= 0) continue;
    ticketsWithPromo += 1;
    totalDiscount += d;
  }
  return {
    ticketsAnalyzed: sales.length,
    ticketsWithPromo,
    totalDiscount: r2(totalDiscount),
    totalSold: r2(totalSold),
  };
}

// ── Contexto AR ───────────────────────────────────────────────────────────────

/** Día, minutos y fecha en Argentina para un instante (default: ahora). */
export function arPromoClock(at: Date = new Date()): Pick<PromoContext, "weekday" | "minutes" | "date"> {
  const d = new Date(at.getTime() - 3 * 3600 * 1000); // UTC-3, sin horario de verano
  return {
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: d.toISOString().slice(0, 10),
  };
}
