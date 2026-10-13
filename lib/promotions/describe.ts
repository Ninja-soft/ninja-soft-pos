// Promociones en lenguaje simple (F9, ADR-074). PURO: lo usan el asistente de
// Configuración → Promociones (tipos con ejemplo, resumen y "así se ve en el
// ticket") y el listado (estado y vigencia).

import {
  evaluatePromotions,
  type PromoActionType,
  type PromoCartLine,
  type PromoContext,
  type Promotion,
} from "./engine";

/** Tipos del asistente. `payment` es un atajo: % con condición de cobro. */
export type PromoKind = PromoActionType | "payment";

export interface PromoKindInfo {
  kind: PromoKind;
  title: string;
  example: string;
  /** Qué hace, en una línea. */
  how: string;
}

export const PROMO_KINDS: PromoKindInfo[] = [
  { kind: "percent", title: "Porcentaje de descuento", example: "10% en toda la tienda los martes", how: "Descuenta un porcentaje de lo que elijas." },
  { kind: "nxm", title: "Lleva y paga menos", example: "2x1 en gaseosas o 3x2 en alfajores", how: "De cada grupo, las unidades más baratas salen gratis." },
  { kind: "second_item", title: "Segunda unidad con descuento", example: "La segunda unidad al 50%", how: "En cada par, la más barata tiene el descuento." },
  { kind: "volume_tier", title: "Descuento por cantidad", example: "Desde 3 unidades 10%, desde 6 unidades 15%", how: "A más unidades, más descuento." },
  { kind: "bundle", title: "Combo a precio fijo", example: "Café y 2 medialunas a $2.500", how: "Cada combo completo cuesta el precio que pongas." },
  { kind: "payment", title: "Por medio de pago, tarjeta o banco", example: "Miércoles 20% pagando con Visa del Galicia", how: "Aplica sólo si se cobra con lo que elijas." },
  { kind: "amount", title: "Monto fijo de descuento", example: "$1.000 menos en compras desde $10.000", how: "Resta un monto fijo de lo que elijas." },
  { kind: "fixed_price", title: "Precio fijo por el total", example: "Todo lo de Liquidación por $10.000", how: "Lo que entre en la promo cuesta, en total, el precio que pongas." },
  { kind: "gift", title: "Regalo por compra", example: "Un llavero de regalo en compras desde $10.000", how: "Suma un producto gratis al carrito." },
];

export const PAYMENT_LABELS: Record<string, string> = {
  cash: "efectivo",
  debit: "débito",
  credit: "crédito",
  transfer: "transferencia",
  qr: "QR",
  account: "cuenta corriente",
};

export const CARD_LABELS: Record<string, string> = {
  visa: "Visa",
  master: "Mastercard",
  amex: "American Express",
  cabal: "Cabal",
  naranja: "Naranja",
  maestro: "Maestro",
  diners: "Diners",
};

const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export function kindOf(p: Pick<Promotion, "action_type" | "payment_method" | "card_brands" | "banks">): PromoKind {
  const hasPay = Boolean(p.payment_method) || (p.card_brands?.length ?? 0) > 0 || (p.banks?.length ?? 0) > 0;
  return p.action_type === "percent" && hasPay ? "payment" : p.action_type;
}

/** Promo vacía con los valores por defecto de un tipo del asistente. */
export function emptyPromotion(kind: PromoKind = "percent"): Promotion {
  const base: Promotion = {
    id: "draft",
    name: "",
    is_active: true,
    priority: 0,
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    time_from: null,
    time_to: null,
    min_amount: 0,
    scope: "cart",
    scope_category_id: null,
    scope_product_id: null,
    scope_brand_id: null,
    scope_ids: null,
    action_type: kind === "payment" ? "percent" : kind,
    action_value: 0,
    buy_qty: null,
    pay_qty: null,
    volume_tiers: null,
    bundle_items: null,
    payment_method: null,
    card_brands: null,
    banks: null,
    store_ids: null,
    price_list_ids: null,
    stackable: false,
    max_discount: null,
    max_uses_total: null,
    max_uses_per_customer: null,
    ticket_label: null,
    gift_product_id: null,
    gift_qty: null,
  };
  switch (kind) {
    case "percent":
    case "payment":
      return { ...base, action_value: kind === "payment" ? 20 : 10 };
    case "nxm":
      return { ...base, buy_qty: 2, pay_qty: 1 };
    case "second_item":
      return { ...base, action_value: 50 };
    case "volume_tier":
      return {
        ...base,
        volume_tiers: [
          { min_qty: 3, pct: 10 },
          { min_qty: 6, pct: 15 },
        ],
      };
    case "bundle":
      return { ...base, action_value: 0, bundle_items: [] };
    case "amount":
      return { ...base, action_value: 1000 };
    case "fixed_price":
      return { ...base, action_value: 0 };
    case "gift":
      return { ...base, gift_qty: 1 };
    default:
      return base;
  }
}

const money = (n: number) =>
  `$${(Math.round(n * 100) / 100).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export interface PromoNames {
  categories?: Record<string, string>;
  products?: Record<string, string>;
  brands?: Record<string, string>;
  stores?: Record<string, string>;
  lists?: Record<string, string>;
  banks?: Record<string, string>;
}

function joinNames(ids: string[], map: Record<string, string> | undefined, fallback: string): string {
  const names = ids.map((id) => map?.[id]).filter(Boolean) as string[];
  if (names.length === 0) return fallback;
  if (names.length <= 2) return names.join(" y ");
  return `${names.slice(0, 2).join(", ")} y ${names.length - 2} más`;
}

function scopeIds(p: Promotion): string[] {
  if (p.scope_ids && p.scope_ids.length > 0) return p.scope_ids;
  const one = p.scope === "category" ? p.scope_category_id : p.scope === "product" ? p.scope_product_id : p.scope === "brand" ? p.scope_brand_id : null;
  return one ? [one] : [];
}

/** "en Bebidas", "en toda la compra", "en 3 productos". */
export function scopePhrase(p: Promotion, names: PromoNames = {}): string {
  const ids = scopeIds(p);
  if (p.scope === "category") return `en ${joinNames(ids, names.categories, ids.length === 1 ? "una categoría" : `${ids.length} categorías`)}`;
  if (p.scope === "product") return `en ${joinNames(ids, names.products, ids.length === 1 ? "un producto" : `${ids.length} productos`)}`;
  if (p.scope === "brand") return `en ${joinNames(ids, names.brands, ids.length === 1 ? "una marca" : `${ids.length} marcas`)}`;
  return "en toda la compra";
}

/** Qué hace la promo, en una frase. */
export function actionPhrase(p: Promotion, names: PromoNames = {}): string {
  const v = Number(p.action_value) || 0;
  switch (p.action_type) {
    case "percent":
      return `${v}% de descuento ${scopePhrase(p, names)}`;
    case "amount":
      return `${money(v)} menos ${scopePhrase(p, names)}`;
    case "fixed_price":
      return `${scopePhrase(p, names).replace(/^en /, "")}: ${money(v)} en total`;
    case "nxm":
      return `Lleva ${p.buy_qty ?? 2} y paga ${p.pay_qty ?? 1} ${scopePhrase(p, names)}`;
    case "second_item":
      return `La segunda unidad al ${v}% ${scopePhrase(p, names)}`;
    case "volume_tier":
      return `${(p.volume_tiers ?? []).map((t) => `desde ${t.min_qty} un. ${t.pct}%`).join(", ") || "Descuento por cantidad"} ${scopePhrase(p, names)}`;
    case "bundle": {
      const items = (p.bundle_items ?? []).map((b) => `${b.qty > 1 ? `${b.qty} ` : ""}${names.products?.[b.product_id] ?? "producto"}`);
      return `Combo ${items.join(" + ") || "sin productos"} a ${money(v)}`;
    }
    case "gift":
      return `Regalo: ${p.gift_qty ?? 1} ${names.products?.[p.gift_product_id ?? ""] ?? "producto"}`;
    default:
      return "Promoción";
  }
}

/** Condiciones (cuándo, cómo se paga, dónde), en frases cortas. */
export function conditionPhrases(p: Promotion, names: PromoNames = {}): string[] {
  const out: string[] = [];
  const days = p.days_of_week ?? [];
  if (days.length > 0 && days.length < 7) out.push(days.map((d) => DAYS[d]).join(", "));
  if (p.time_from != null || p.time_to != null) {
    out.push(`de ${hhmm(p.time_from ?? 0)} a ${hhmm(p.time_to ?? 1440)}`);
  }
  if (p.payment_method) out.push(`pagando con ${PAYMENT_LABELS[p.payment_method] ?? p.payment_method}`);
  if (p.card_brands && p.card_brands.length > 0) out.push(`tarjeta ${p.card_brands.map((c) => CARD_LABELS[c] ?? c).join(" o ")}`);
  if (p.banks && p.banks.length > 0) out.push(`del ${joinNames(p.banks, names.banks, `${p.banks.length} bancos`)}`);
  if ((p.min_amount ?? 0) > 0) out.push(`desde ${money(p.min_amount)}`);
  if (p.store_ids && p.store_ids.length > 0) out.push(`sólo en ${joinNames(p.store_ids, names.stores, `${p.store_ids.length} sucursales`)}`);
  if (p.price_list_ids && p.price_list_ids.length > 0) out.push(`con la lista ${joinNames(p.price_list_ids, names.lists, "elegida")}`);
  if (p.max_discount != null) out.push(`tope ${money(p.max_discount)} por ticket`);
  if (p.max_uses_per_customer != null) out.push(`${p.max_uses_per_customer} ${p.max_uses_per_customer === 1 ? "vez" : "veces"} por cliente`);
  if (p.max_uses_total != null) out.push(`hasta ${p.max_uses_total} usos`);
  return out;
}

export type PromoStatusKey = "active" | "scheduled" | "expired" | "paused" | "waiting";

export interface PromoStatus {
  key: PromoStatusKey;
  label: string;
  tone: "success" | "info" | "neutral" | "warning";
}

/** Estado para el listado: activa ahora, programada, vencida, pausada o fuera de día u horario. */
export function promoStatus(p: Promotion, clock: Pick<PromoContext, "weekday" | "minutes" | "date">): PromoStatus {
  if (!p.is_active) return { key: "paused", label: "Pausada", tone: "neutral" };
  if (p.valid_to && clock.date > p.valid_to) return { key: "expired", label: "Vencida", tone: "warning" };
  if (p.valid_from && clock.date < p.valid_from) return { key: "scheduled", label: `Empieza el ${dmy(p.valid_from)}`, tone: "info" };
  const days = p.days_of_week ?? [];
  const offDay = days.length > 0 && !days.includes(clock.weekday);
  const offHour =
    (p.time_from != null && clock.minutes < p.time_from) || (p.time_to != null && clock.minutes >= p.time_to);
  if (offDay || offHour) return { key: "waiting", label: "Activa, fuera de día u horario", tone: "info" };
  return { key: "active", label: "Activa ahora", tone: "success" };
}

/** Vigencia en texto ("Sin vencimiento", "Hasta el 30/11", "Del 01/11 al 30/11"). */
export function validityText(p: Promotion): string {
  if (p.valid_from && p.valid_to) return `Del ${dmy(p.valid_from)} al ${dmy(p.valid_to)}`;
  if (p.valid_to) return `Hasta el ${dmy(p.valid_to)}`;
  if (p.valid_from) return `Desde el ${dmy(p.valid_from)}`;
  return "Sin vencimiento";
}

// ── "Así se ve en el ticket" ─────────────────────────────────────────────────

export interface PreviewProduct {
  id: string;
  name: string;
  price: number;
  category_id?: string | null;
  brand_id?: string | null;
}

export interface TicketPreview {
  items: { name: string; quantity: number; amount: number }[];
  subtotal: number;
  promos: { label: string; amount: number }[];
  gift: string | null;
  total: number;
}

/** Carrito de ejemplo que dispara la promo, y el ticket que resulta. */
export function ticketPreview(p: Promotion, catalog: PreviewProduct[]): TicketPreview {
  const byId = new Map(catalog.map((x) => [x.id, x]));
  const ids = scopeIds(p);
  const pick = (): PreviewProduct => {
    const match =
      p.scope === "product"
        ? catalog.find((x) => ids.includes(x.id))
        : p.scope === "category"
          ? catalog.find((x) => x.category_id && ids.includes(x.category_id))
          : p.scope === "brand"
            ? catalog.find((x) => x.brand_id && ids.includes(x.brand_id))
            : catalog[0];
    return (
      match ?? {
        id: "ejemplo",
        name: "Producto de ejemplo",
        price: 1000,
        category_id: p.scope === "category" ? (ids[0] ?? null) : null,
        brand_id: p.scope === "brand" ? (ids[0] ?? null) : null,
      }
    );
  };

  const cart: { prod: PreviewProduct; qty: number }[] = [];
  if (p.action_type === "bundle") {
    for (const b of p.bundle_items ?? []) {
      const prod = byId.get(b.product_id) ?? { id: b.product_id, name: "Producto", price: 1000 };
      cart.push({ prod, qty: Math.max(1, b.qty) });
    }
  } else {
    const prod = pick();
    const qty =
      p.action_type === "nxm"
        ? Math.max(2, p.buy_qty ?? 2)
        : p.action_type === "second_item"
          ? 2
          : p.action_type === "volume_tier"
            ? Math.max(1, ...(p.volume_tiers ?? []).map((t) => t.min_qty))
            : 1;
    cart.push({ prod, qty });
    // Que llegue al mínimo de compra.
    const sub = prod.price * qty;
    if ((p.min_amount ?? 0) > sub && prod.price > 0) {
      cart[0]!.qty = Math.ceil((p.min_amount ?? 0) / prod.price);
    }
    if (p.action_type === "fixed_price" && (Number(p.action_value) || 0) >= prod.price * cart[0]!.qty && prod.price > 0) {
      cart[0]!.qty = Math.floor((Number(p.action_value) || 0) / prod.price) + 1;
    }
  }

  const lines: PromoCartLine[] = cart.map((c) => ({
    productId: c.prod.id,
    categoryId: c.prod.category_id ?? null,
    brandId: c.prod.brand_id ?? null,
    unitPrice: c.prod.price,
    quantity: c.qty,
    lineTotal: Math.round(c.prod.price * c.qty * 100) / 100,
  }));
  // Sin condiciones de cuándo ni cómo se paga: se muestra el efecto.
  const draft: Promotion = {
    ...p,
    id: p.id || "draft",
    name: p.name || "Promoción",
    is_active: true,
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    time_from: null,
    time_to: null,
    payment_method: null,
    card_brands: null,
    banks: null,
    store_ids: null,
    price_list_ids: null,
    max_uses_total: null,
    max_uses_per_customer: null,
  };
  const ev = evaluatePromotions(lines, [draft], { weekday: 0, minutes: 0, date: "2000-01-01" });
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  const giftProd = ev.gifts[0] ? byId.get(ev.gifts[0].giftProductId) : undefined;
  return {
    items: cart.map((c) => ({ name: c.prod.name, quantity: c.qty, amount: Math.round(c.prod.price * c.qty * 100) / 100 })),
    subtotal,
    promos: ev.applied.map((a) => ({ label: a.label, amount: a.discount })),
    gift: ev.gifts[0] ? `${ev.gifts[0].giftQty} ${giftProd?.name ?? "producto de regalo"}` : null,
    total: Math.round((subtotal - ev.discount) * 100) / 100,
  };
}
