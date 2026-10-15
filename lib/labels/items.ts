// Datos de cada etiqueta y cantidades (ADR-148 · H24 etiquetas PRO). Puro.

export type NetUnit = "g" | "kg" | "ml" | "l" | "cm3" | "m" | "cm" | "un";

export interface NetContent {
  qty: number;
  unit: NetUnit;
}

/** Fila que devuelve `label_catalog` (producto o variante con su stock). */
export interface LabelCatalogRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_label: string | null;
  brand: string | null;
  category: string | null;
  sku: string | null;
  barcode: string | null;
  plu: string | null;
  unit: string | null;
  price: number;
  image_url: string | null;
  net_content: number | null;
  net_content_unit: string | null;
  /** Stock en el alcance pedido (null si el producto no controla stock). */
  stock: number | null;
}

/** Una etiqueta lista para dibujar. */
export interface LabelItem {
  key: string;
  productId: string;
  variantId: string | null;
  name: string;
  variant: string | null;
  brand: string | null;
  price: number;
  prevPrice: number | null;
  unitPrice: { value: number; per: string } | null;
  plu: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  qrUrl: string | null;
  date: string | null;
}

export type QtyMode = "one" | "stock" | "fixed";

/** Copias de un renglón según el modo: 1, igual al stock (redondeado arriba) o fija. */
export function copiesFor(mode: QtyMode, stock: number | null, fixed: number): number {
  if (mode === "one") return 1;
  if (mode === "fixed") return clampCopies(fixed);
  if (stock == null || !Number.isFinite(stock) || stock <= 0) return 0;
  return clampCopies(Math.ceil(stock));
}

/** Copias válidas por renglón (0..500). 0 = no se imprime. */
export function clampCopies(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(500, Math.floor(n)));
}

/** Tope de etiquetas por impresión (para no colgar el navegador). */
export const MAX_LABELS = 3000;

/** Expande renglones con copias a una lista plana, sin pasar del tope. */
export function expandCopies<T>(rows: { item: T; copies: number }[], max = MAX_LABELS): { items: T[]; truncated: boolean } {
  const items: T[] = [];
  for (const r of rows) {
    const n = clampCopies(r.copies);
    for (let i = 0; i < n; i++) {
      if (items.length >= max) return { items, truncated: true };
      items.push(r.item);
    }
  }
  return { items, truncated: false };
}

const UNIT_ALIASES: Record<string, NetUnit> = {
  g: "g",
  gr: "g",
  grs: "g",
  gramos: "g",
  kg: "kg",
  kilo: "kg",
  kilos: "kg",
  ml: "ml",
  cc: "cm3",
  cm3: "cm3",
  l: "l",
  lt: "l",
  lts: "l",
  litro: "l",
  litros: "l",
  m: "m",
  mts: "m",
  metros: "m",
  cm: "cm",
};

/**
 * Contenido neto escrito en el nombre ("Aceite 900 ml", "Yerba 1kg",
 * "Gaseosa 2,25 L"). Toma la última coincidencia. Null si no hay.
 */
export function parseNetContent(name: string): NetContent | null {
  const unitRe = "(kg|kilos?|gramos|grs?|g|ml|cc|cm3|litros?|lts?|l|metros|mts|m|cm)";
  // Multipack: "3 x 100 g" = 300 g.
  const multi = new RegExp(String.raw`(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*${unitRe}\b`, "gi");
  const re = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*${unitRe}\b`, "gi");
  let last: NetContent | null = null;
  for (const m of name.matchAll(multi)) {
    const qty = Number(m[1]) * Number(m[2]!.replace(",", "."));
    const unit = UNIT_ALIASES[m[3]!.toLowerCase()];
    if (unit && qty > 0) last = { qty: Math.round(qty * 1000) / 1000, unit };
  }
  if (last) return last;
  for (const m of name.matchAll(re)) {
    const qty = Number(m[1]!.replace(",", "."));
    const unit = UNIT_ALIASES[m[2]!.toLowerCase()];
    if (unit && qty > 0) last = { qty, unit };
  }
  return last;
}

export function normalizeNetUnit(u: string | null | undefined): NetUnit | null {
  const k = (u ?? "").toLowerCase().trim();
  return (UNIT_ALIASES[k] ?? (["g", "kg", "ml", "l", "cm3", "m", "cm", "un"].includes(k) ? (k as NetUnit) : null)) || null;
}

/**
 * Precio por unidad de medida (Ley de Góndolas 27.545): por kg, por litro o
 * por metro. Productos que se venden por kg o litro ya tienen el precio
 * unitario; los envasados lo calculan con el contenido neto.
 */
export function unitPriceOf(price: number, content: NetContent | null, sellUnit?: string | null): { value: number; per: string } | null {
  const su = (sellUnit ?? "").toLowerCase();
  if (su === "kg" || su === "l" || su === "lt" || su === "m") return null; // el precio ya es por unidad
  if (!content || !(content.qty > 0) || !(price > 0)) return null;
  const { qty, unit } = content;
  if (unit === "un" && qty <= 1) return null;
  // Factor para llevar el contenido a la unidad de referencia (kg, l, m, un).
  const REF: Record<NetUnit, [number, string]> = {
    g: [1000, "kg"],
    kg: [1, "kg"],
    ml: [1000, "l"],
    cm3: [1000, "l"],
    l: [1, "l"],
    cm: [100, "m"],
    m: [1, "m"],
    un: [1, "un"],
  };
  const [factor, per] = REF[unit];
  const value = Math.round((price / qty) * factor * 100) / 100;
  // 1 kg o 1 litro: el precio por unidad es el mismo precio, no se repite.
  return Math.abs(value - price) < 0.005 ? null : { value, per };
}

/** Precio con formato argentino. `decimals`: auto (sólo si hay centavos), siempre o nunca. */
export function formatPriceParts(n: number, decimals: "auto" | "always" | "never" = "auto"): { int: string; dec: string | null } {
  const v = Number.isFinite(n) ? n : 0;
  const cents = Math.round(Math.abs(v) * 100) % 100;
  const showDec = decimals === "always" || (decimals === "auto" && cents !== 0);
  const intPart = decimals === "never" ? Math.round(Math.abs(v)) : Math.floor(Math.abs(v) + 1e-9);
  const int = (v < 0 ? "-" : "") + intPart.toLocaleString("es-AR", { maximumFractionDigits: 0 }).replace(/,/g, ".");
  return { int, dec: showDec ? String(cents).padStart(2, "0") : null };
}

export function formatPrice(n: number, decimals: "auto" | "always" | "never" = "auto"): string {
  const p = formatPriceParts(n, decimals);
  return `$ ${p.int}${p.dec ? `,${p.dec}` : ""}`;
}

/** Arma la etiqueta desde una fila del catálogo y el precio de góndola resuelto. */
export function toLabelItem(
  row: LabelCatalogRow,
  opts: { price: number; prevPrice?: number | null; qrUrl?: string | null; date?: string | null },
): LabelItem {
  const content: NetContent | null =
    row.net_content && Number(row.net_content) > 0 && normalizeNetUnit(row.net_content_unit)
      ? { qty: Number(row.net_content), unit: normalizeNetUnit(row.net_content_unit)! }
      : parseNetContent(row.name);
  const prev = opts.prevPrice != null && opts.prevPrice > opts.price ? opts.prevPrice : null;
  return {
    key: `${row.product_id}:${row.variant_id ?? ""}`,
    productId: row.product_id,
    variantId: row.variant_id,
    name: row.name,
    variant: row.variant_label,
    brand: row.brand,
    price: opts.price,
    prevPrice: prev,
    unitPrice: unitPriceOf(opts.price, content, row.unit),
    plu: row.plu,
    sku: row.sku,
    barcode: row.barcode,
    imageUrl: row.image_url,
    qrUrl: opts.qrUrl ?? null,
    date: opts.date ?? null,
  };
}
