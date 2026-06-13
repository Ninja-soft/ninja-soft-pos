// F9 · H53 — Núcleo del motor de promociones (evaluación declarativa).
//
// Motor PURO (sin DOM, sin red, sin estado): toma las líneas del carrito + el
// contexto (día/hora/fecha) + las promociones definidas, y devuelve la promoción
// aplicable que MÁS descuenta. Es declarativo: una promo tiene CONDICIONES
// (vigencia por fecha, día de semana, franja horaria, monto mínimo del carrito,
// alcance) y una ACCIÓN (% o monto fijo de descuento sobre el alcance).
//
// v1: se aplica UNA sola promoción (la de mayor descuento; desempate por
// prioridad y luego por id) para evitar combinaciones inesperadas. Combinables /
// apilables, productos bonificados (NxM) y segmentos de cliente → siguientes
// hitos (H54/H55). La INTEGRACIÓN en el POS (aplicar el descuento al carrito y
// persistirlo en la venta) es follow-up: este módulo sólo decide.

export type PromoScope = "cart" | "category" | "product";
// percent / amount (H53) + nxm (2x1, 3x2…), fixed_price (precio fijo del alcance:
// combo/pack), second_item ("2º al X%": en cada par del alcance, el más barato
// con `action_value`% off) y volume_tier (% por volumen escalonado: el % sube por
// tramos de cantidad del alcance) (H54).
export type PromoActionType =
  | "percent"
  | "amount"
  | "nxm"
  | "fixed_price"
  | "second_item"
  | "volume_tier"
  // gift = regalo por compra: al cumplir las condiciones, se regala `gift_qty`
  // unidades del producto `gift_product_id`. NO descuenta (agrega un ítem a $0);
  // se evalúa aparte de la mejor promo de descuento (ver evaluateGifts).
  | "gift";

// Un tramo de la promo por volumen: a partir de `min_qty` unidades del alcance,
// se aplica `pct`% de descuento sobre la base del alcance. Califica el tramo más
// alto cuyo `min_qty` no supera la cantidad del carrito (ver volumeTierDiscount).
export interface PromoVolumeTier {
  min_qty: number;
  pct: number;
}

export interface Promotion {
  id: string;
  name: string;
  is_active: boolean;
  // Mayor prioridad gana ante empate de descuento (mayor número = más prioridad).
  priority: number;
  // Vigencia por fecha (YYYY-MM-DD, hora local AR). null = sin límite por ese lado.
  valid_from: string | null;
  valid_to: string | null;
  // Días de semana válidos (0=domingo..6=sábado). null/[] = todos los días.
  days_of_week: number[] | null;
  // Franja horaria válida en minutos del día (0..1440). null = todo el día.
  time_from: number | null;
  time_to: number | null;
  // Monto mínimo del SUBTOTAL del carrito para que aplique.
  min_amount: number;
  // Alcance del descuento: todo el carrito, una categoría o un producto.
  scope: PromoScope;
  scope_category_id: string | null;
  scope_product_id: string | null;
  // Acción:
  //  - percent: % de `action_value` sobre la base del alcance.
  //  - amount: monto fijo `action_value` (acotado a la base).
  //  - fixed_price: el alcance pasa a costar `action_value` (combo/pack);
  //    descuento = base − action_value (acotado, ≥ 0).
  //  - nxm: "lleva buy_qty, paga pay_qty" sobre las unidades del alcance;
  //    descuento = (unidades gratis) × precio de las unidades MÁS BARATAS.
  action_type: PromoActionType;
  action_value: number;
  // Sólo para nxm: N (lleva) y M (paga). N > M ≥ 1. null en los demás tipos.
  buy_qty: number | null;
  pay_qty: number | null;
  // Sólo para volume_tier: tramos de cantidad → %. null en los demás tipos.
  volume_tiers: PromoVolumeTier[] | null;
  // CONDICIÓN por medio de pago (H54): si está seteado (ej. 'cash'), la promo SÓLO
  // aplica cuando se paga con ese medio. null = cualquier medio (como hasta hoy).
  // El medio del cobro llega por PromoContext.paymentMethod (lo resuelve el modal
  // al elegir el medio); en la evaluación del carrito (sin medio aún) estas promos
  // no aplican. Es una condición, ortogonal al action_type.
  payment_method: string | null;
  // Sólo para action_type='gift' (H54): producto a regalar y cuántas unidades.
  // null en los demás tipos.
  gift_product_id: string | null;
  gift_qty: number | null;
}

// Línea del carrito reducida a lo que el motor necesita. `lineTotal` alimenta las
// acciones agregadas (percent/amount/fixed_price); `unitPrice`/`quantity` el NxM
// (que razona por unidad). El caller (POS) ya tiene todos estos datos.
export interface PromoCartLine {
  productId: string | null;
  categoryId: string | null;
  unitPrice: number;
  quantity: number;
  // Importe de la línea ya neto de su descuento de línea (qty*precio - desc).
  lineTotal: number;
}

// Contexto temporal (hora local de Argentina), resuelto por el caller.
export interface PromoContext {
  weekday: number; // 0=domingo..6=sábado
  minutes: number; // minutos del día (0..1440)
  date: string; // YYYY-MM-DD
  // Medio de pago elegido (H54): habilita las promos condicionadas por medio.
  // undefined/null = todavía no se eligió (evaluación del carrito) → las promos
  // con payment_method no aplican; las método-agnósticas sí.
  paymentMethod?: string | null;
}

export interface PromoResult {
  promotionId: string;
  name: string;
  discount: number; // monto a descontar (≥ 0)
}

// Subtotal del carrito (todas las líneas).
export function cartSubtotal(lines: PromoCartLine[]): number {
  return lines.reduce((acc, l) => acc + (l.lineTotal || 0), 0);
}

// Líneas alcanzadas por la promo (sobre las que se calcula el descuento).
function scopedLines(promo: Promotion, lines: PromoCartLine[]): PromoCartLine[] {
  if (promo.scope === "category") {
    return lines.filter((l) => l.categoryId && l.categoryId === promo.scope_category_id);
  }
  if (promo.scope === "product") {
    return lines.filter((l) => l.productId && l.productId === promo.scope_product_id);
  }
  return lines; // cart
}

// Base sobre la que se aplica el descuento (suma del alcance).
function scopeBase(promo: Promotion, lines: PromoCartLine[]): number {
  return scopedLines(promo, lines).reduce((acc, l) => acc + (l.lineTotal || 0), 0);
}

// ¿Está vigente la promo en el contexto dado y matchea las condiciones?
export function promoApplies(
  promo: Promotion,
  lines: PromoCartLine[],
  ctx: PromoContext,
): boolean {
  if (!promo.is_active) return false;
  if (promo.valid_from && ctx.date < promo.valid_from) return false;
  if (promo.valid_to && ctx.date > promo.valid_to) return false;
  if (promo.days_of_week && promo.days_of_week.length > 0 && !promo.days_of_week.includes(ctx.weekday))
    return false;
  if (promo.time_from != null && ctx.minutes < promo.time_from) return false;
  if (promo.time_to != null && ctx.minutes >= promo.time_to) return false;
  // Condición por medio de pago (H54): si la promo exige un medio, sólo aplica
  // cuando el contexto trae ese mismo medio (lo setea el modal al elegirlo). Sin
  // medio en contexto (evaluación del carrito), las promos por medio no aplican.
  if (promo.payment_method && ctx.paymentMethod !== promo.payment_method) return false;
  if (cartSubtotal(lines) < (promo.min_amount || 0)) return false;
  // Debe haber algo en el alcance para descontar.
  if (scopeBase(promo, lines) <= 0) return false;
  return true;
}

// Precios unitarios de TODAS las unidades del alcance (una entrada por unidad),
// ordenados ascendente. Para NxM: las unidades gratis son las más baratas.
function scopedUnitPrices(promo: Promotion, lines: PromoCartLine[]): number[] {
  const prices: number[] = [];
  for (const l of scopedLines(promo, lines)) {
    const q = Math.max(0, Math.trunc(l.quantity || 0));
    for (let i = 0; i < q; i++) prices.push(l.unitPrice || 0);
  }
  return prices.sort((a, b) => a - b);
}

// Descuento de un NxM ("lleva N, paga M") sobre las unidades del alcance: por
// cada grupo de N unidades, (N−M) salen gratis (las más baratas).
function nxmDiscount(promo: Promotion, lines: PromoCartLine[]): number {
  const n = Math.trunc(promo.buy_qty || 0);
  const m = Math.trunc(promo.pay_qty || 0);
  if (n < 2 || m < 1 || m >= n) return 0;
  const prices = scopedUnitPrices(promo, lines);
  const sets = Math.floor(prices.length / n);
  const freeUnits = sets * (n - m);
  // Las `freeUnits` unidades más baratas (prices ya viene ascendente).
  let disc = 0;
  for (let i = 0; i < freeUnits && i < prices.length; i++) disc += prices[i] ?? 0;
  return disc;
}

// Cantidad total de unidades del alcance (suma de cantidades; soporta peso/kg).
function scopedQty(promo: Promotion, lines: PromoCartLine[]): number {
  return scopedLines(promo, lines).reduce(
    (acc, l) => acc + Math.max(0, l.quantity || 0),
    0,
  );
}

// Descuento "% por volumen escalonado": según la cantidad del alcance, aplica el
// % del tramo que MÁS conviene entre los que califican (min_qty ≤ cantidad). Así
// es robusto ante tramos mal ordenados: el cliente nunca recibe menos del mejor
// tramo al que tiene derecho. Descuento = base del alcance × % / 100.
function volumeTierDiscount(promo: Promotion, lines: PromoCartLine[]): number {
  const tiers = promo.volume_tiers ?? [];
  if (tiers.length === 0) return 0;
  const qty = scopedQty(promo, lines);
  let pct = 0;
  for (const t of tiers) {
    const minQty = t?.min_qty ?? 0;
    const tierPct = t?.pct ?? 0;
    if (minQty >= 1 && qty >= minQty && tierPct > pct) pct = tierPct;
  }
  if (pct <= 0) return 0;
  return (scopeBase(promo, lines) * pct) / 100;
}

// Descuento "2º ítem al X%": agrupa las unidades del alcance en PARES (ordenadas
// por precio); en cada par, el más barato recibe `action_value`% de descuento.
function secondItemDiscount(promo: Promotion, lines: PromoCartLine[]): number {
  const pct = promo.action_value || 0;
  if (pct <= 0) return 0;
  const prices = scopedUnitPrices(promo, lines); // ascendente
  const pairs = Math.floor(prices.length / 2);
  let disc = 0;
  // El más barato de cada par es prices[2*i] (lista ascendente).
  for (let i = 0; i < pairs; i++) disc += ((prices[2 * i] ?? 0) * pct) / 100;
  return disc;
}

// Descuento en dinero que produce la promo (acotado a la base; nunca negativo).
export function promoDiscount(promo: Promotion, lines: PromoCartLine[]): number {
  const base = scopeBase(promo, lines);
  if (base <= 0) return 0;
  let raw: number;
  switch (promo.action_type) {
    case "percent":
      raw = (base * (promo.action_value || 0)) / 100;
      break;
    case "amount":
      raw = promo.action_value || 0;
      break;
    case "fixed_price":
      // El alcance pasa a costar action_value; descuento = lo que sobra.
      raw = base - (promo.action_value || 0);
      break;
    case "nxm":
      raw = nxmDiscount(promo, lines);
      break;
    case "second_item":
      raw = secondItemDiscount(promo, lines);
      break;
    case "volume_tier":
      raw = volumeTierDiscount(promo, lines);
      break;
    default:
      raw = 0;
  }
  const capped = Math.min(Math.max(raw, 0), base);
  // Redondeo a 2 decimales para evitar ruido de punto flotante.
  return Math.round(capped * 100) / 100;
}

// Evalúa todas las promos y devuelve la que MÁS descuenta (desempate: mayor
// prioridad, luego id menor). null si ninguna aplica o el mejor descuento es 0.
export function evaluateCart(
  lines: PromoCartLine[],
  promos: Promotion[],
  ctx: PromoContext,
): PromoResult | null {
  let best: { promo: Promotion; discount: number } | null = null;
  for (const promo of promos) {
    if (!promoApplies(promo, lines, ctx)) continue;
    const discount = promoDiscount(promo, lines);
    if (discount <= 0) continue;
    if (
      !best ||
      discount > best.discount ||
      (discount === best.discount && promo.priority > best.promo.priority) ||
      (discount === best.discount &&
        promo.priority === best.promo.priority &&
        promo.id < best.promo.id)
    ) {
      best = { promo, discount };
    }
  }
  if (!best) return null;
  return { promotionId: best.promo.id, name: best.promo.name, discount: best.discount };
}

// Regalo por compra (H54). A diferencia del descuento, NO compite por "la mejor":
// es un mecanismo aparte que puede CONVIVIR con una promo de descuento y con otros
// regalos. Devuelve TODAS las promos de regalo cuyas condiciones se cumplen (el
// caller agrega una línea a $0 por cada una). Las líneas de regalo NO deben venir
// en `lines` (el caller las excluye) para que un regalo no se dispare a sí mismo.
export interface GiftResult {
  promotionId: string;
  name: string;
  giftProductId: string;
  giftQty: number;
}

export function evaluateGifts(
  lines: PromoCartLine[],
  promos: Promotion[],
  ctx: PromoContext,
): GiftResult[] {
  const out: GiftResult[] = [];
  for (const promo of promos) {
    if (promo.action_type !== "gift") continue;
    if (!promo.gift_product_id) continue;
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

// ── Simulador (F9 · H56) ──────────────────────────────────────────────────────
// Corre UNA promo contra ventas históricas para previsualizar su impacto ANTES de
// activarla: cuántos tickets habrían tenido la promo y cuánto descuento total.
// Cada venta histórica trae su contexto (día/hora/fecha local AR, resuelto por la
// RPC) y sus líneas. PURO: no consulta nada, sólo agrega.

export interface SimSale {
  weekday: number;
  minutes: number;
  date: string;
  lines: PromoCartLine[];
}

export interface SimResult {
  ticketsAnalyzed: number;
  ticketsWithPromo: number; // tickets donde la promo habría aplicado (descuento > 0)
  totalDiscount: number; // descuento total estimado
  totalSold: number; // total vendido del período (suma de subtotales)
}

// Simula la promo IGNORANDO su flag is_active (se previsualiza aunque esté en
// borrador). Igual respeta el resto de las condiciones (fecha/día/hora/min/alcance).
export function simulatePromotion(promo: Promotion, sales: SimSale[]): SimResult {
  const draft: Promotion = { ...promo, is_active: true };
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
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    totalSold: Math.round(totalSold * 100) / 100,
  };
}
