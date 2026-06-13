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
export type PromoActionType = "percent" | "amount";

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
  // Acción: % sobre el alcance, o monto fijo (acotado a la base del alcance).
  action_type: PromoActionType;
  action_value: number;
}

// Línea del carrito reducida a lo que el motor necesita.
export interface PromoCartLine {
  productId: string | null;
  categoryId: string | null;
  // Importe de la línea ya neto de su descuento de línea (qty*precio - desc).
  lineTotal: number;
}

// Contexto temporal (hora local de Argentina), resuelto por el caller.
export interface PromoContext {
  weekday: number; // 0=domingo..6=sábado
  minutes: number; // minutos del día (0..1440)
  date: string; // YYYY-MM-DD
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
  if (cartSubtotal(lines) < (promo.min_amount || 0)) return false;
  // Debe haber algo en el alcance para descontar.
  if (scopeBase(promo, lines) <= 0) return false;
  return true;
}

// Descuento en dinero que produce la promo (acotado a la base; nunca negativo).
export function promoDiscount(promo: Promotion, lines: PromoCartLine[]): number {
  const base = scopeBase(promo, lines);
  if (base <= 0) return 0;
  const raw =
    promo.action_type === "percent"
      ? (base * (promo.action_value || 0)) / 100
      : promo.action_value || 0;
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
