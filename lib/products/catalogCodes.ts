// F24 · H163 (ADR-177): códigos alternativos, unidades de venta con
// coeficiente y uso del artículo. Lógica PURA (sin React ni Supabase).

/** both = compra y venta; sale = sólo venta; purchase = insumo (no se vende). */
export type ProductUsage = "both" | "sale" | "purchase";

export const USAGE_OPTIONS: { value: ProductUsage; label: string; hint: string }[] = [
  { value: "both", label: "Compra y venta", hint: "Aparece en el POS y al comprar." },
  { value: "sale", label: "Sólo venta", hint: "No aparece al cargar compras." },
  { value: "purchase", label: "Sólo compra (insumo)", hint: "No aparece en el POS ni en el catálogo online." },
];

export function usageOf(p: { usage?: string | null } | null | undefined): ProductUsage {
  const u = p?.usage;
  return u === "sale" || u === "purchase" ? u : "both";
}

/** ¿Se puede vender? (POS, mesas, delivery, catálogo). */
export const isSellable = (p: { usage?: string | null }) => usageOf(p) !== "purchase";
/** ¿Se puede comprar? (compras, recepción). */
export const isPurchasable = (p: { usage?: string | null }) => usageOf(p) !== "sale";

/** Mismo criterio que la base: mayúsculas y sin espacios. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export const CODE_RE = /^[A-Z0-9._-]{1,60}$/;

/** null si el código sirve; si no, el motivo para mostrar. */
export function codeError(raw: string): string | null {
  const c = normalizeCode(raw);
  if (!c) return "Escribí el código";
  if (!CODE_RE.test(c)) return "Sólo letras, números, punto, guion y guion bajo (hasta 60)";
  return null;
}

/** Mensaje del error barcode_taken:<origen> de la base. */
export function barcodeTakenMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String((err as { message?: string } | null)?.message ?? err ?? "");
  const m = /barcode_taken:(\w+)/.exec(msg);
  if (!m) {
    if (msg.includes("uq_product_barcodes_code") || msg.includes("uq_product_sale_units_barcode"))
      return "Ese código ya lo usa otro artículo";
    if (msg.includes("barcode_invalid")) return "El código no es válido";
    if (msg.includes("sale_unit_weighted_not_allowed")) return "Un artículo pesable no se vende por bulto";
    if (msg.includes("sale_unit_not_allowed"))
      return "Las unidades de venta no van con variantes, serializados ni servicios";
    return null;
  }
  switch (m[1]) {
    case "product":
      return "Ese código es el principal de otro artículo";
    case "variant":
      return "Ese código es de una variante";
    case "alt":
      return "Ese código ya es alternativo de un artículo";
    case "sale_unit":
      return "Ese código es de una unidad de venta (bulto o caja)";
    default:
      return "Ese código ya está en uso";
  }
}

/** "Yerba 1 kg (COPIA)", sin pasar el largo del nombre (120). */
export function copyName(name: string, max = 120): string {
  const suffix = " (COPIA)";
  const base = name.trim().replace(/\s*\(COPIA\)$/i, "");
  return `${base.slice(0, max - suffix.length)}${suffix}`;
}

// ── Códigos alternativos ──────────────────────────────────────────────────
export interface AltCode {
  /** id en DB; null si todavía no se guardó. */
  id: string | null;
  code: string;
  supplierId: string | null;
  variantId: string | null;
}

/** Qué insertar y qué dar de baja (lógica) entre lo guardado y lo editado. */
export function diffAltCodes(saved: AltCode[], edited: AltCode[]) {
  const keep = edited.filter((c) => normalizeCode(c.code));
  const ids = new Set(keep.map((c) => c.id).filter(Boolean) as string[]);
  const savedById = new Map(saved.filter((s) => s.id).map((s) => [s.id as string, s]));
  const changed = keep.filter((c) => {
    if (!c.id) return false;
    const s = savedById.get(c.id);
    return Boolean(s) && (normalizeCode(s!.code) !== normalizeCode(c.code) || (s!.supplierId ?? null) !== (c.supplierId ?? null));
  });
  return {
    // Un cambio es baja + alta: así el código viejo se libera antes.
    insert: [...keep.filter((c) => !c.id), ...changed].map((c) => ({
      code: normalizeCode(c.code),
      supplier_id: c.supplierId,
      variant_id: c.variantId,
    })),
    remove: [...saved.filter((s) => s.id && !ids.has(s.id)).map((s) => s.id as string), ...changed.map((c) => c.id as string)],
  };
}

/** Códigos repetidos dentro de la lista (o iguales al principal). */
export function duplicateCodes(main: string | null | undefined, list: { code: string }[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  const m = main ? normalizeCode(main) : "";
  for (const c of list) {
    const n = normalizeCode(c.code);
    if (!n) continue;
    if (n === m || seen.has(n)) dup.add(n);
    seen.add(n);
  }
  return dup;
}

// ── Unidades de venta ─────────────────────────────────────────────────────
export interface SaleUnit {
  id: string | null;
  label: string;
  units: number;
  /** Precio del bulto. null = derivado del precio unitario. */
  price: number | null;
  discountPct: number;
  barcode: string;
  isActive: boolean;
}

export const SALE_UNIT_LABELS = ["Bulto", "Caja", "Pack", "Display", "Docena"] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Precio de UN bulto con el precio unitario de hoy. Nunca más que comprar las
 * unidades sueltas (el servidor lo cobra como descuento del renglón). Sin
 * descuento permitido (producto no bonificable o sin la feature), N × precio.
 */
export function saleUnitPrice(
  u: Pick<SaleUnit, "units" | "price" | "discountPct">,
  unitPrice: number,
  allowDiscount = true,
): number {
  const full = round2(u.units * unitPrice);
  if (!allowDiscount) return full;
  const wanted = u.price != null ? round2(u.price) : round2(full * (1 - (u.discountPct || 0) / 100));
  return Math.max(0, Math.min(full, wanted));
}

/** "Caja x 12". */
export function saleUnitLabel(u: Pick<SaleUnit, "label" | "units">): string {
  return `${(u.label || "Bulto").trim()} x ${u.units}`;
}

/** null si la unidad sirve; si no, el motivo. */
export function saleUnitError(u: SaleUnit, product: { unit?: string | null; has_variants?: boolean | null; is_serialized?: boolean | null; is_service?: boolean | null }): string | null {
  if ((product.unit ?? "un") === "kg") return "Un artículo pesable no se vende por bulto";
  if (product.has_variants || product.is_serialized || product.is_service)
    return "No va con variantes, serializados ni servicios";
  if (!u.label.trim()) return "Poné un nombre (Bulto, Caja, Pack)";
  if (u.label.trim().length > 20) return "El nombre tiene hasta 20 letras";
  if (!Number.isInteger(u.units) || u.units < 2 || u.units > 10000) return "Las unidades van de 2 a 10.000";
  if (u.price != null && !(u.price > 0)) return "El precio tiene que ser mayor a 0";
  if (u.discountPct < 0 || u.discountPct >= 100) return "El descuento va de 0 a 99";
  if (u.barcode.trim() && codeError(u.barcode)) return codeError(u.barcode);
  return null;
}

export interface SaleUnitRow {
  id: string;
  label: string;
  units: number;
  price: number | null;
  discount_pct: number;
  barcode: string | null;
  is_active: boolean;
}

export function saleUnitFromRow(r: SaleUnitRow): SaleUnit {
  return {
    id: r.id,
    label: r.label,
    units: Number(r.units),
    price: r.price == null ? null : Number(r.price),
    discountPct: Number(r.discount_pct ?? 0),
    barcode: r.barcode ?? "",
    isActive: r.is_active !== false,
  };
}

export function saleUnitToRow(u: SaleUnit) {
  return {
    label: u.label.trim(),
    units: u.units,
    price: u.price,
    discount_pct: u.discountPct || 0,
    barcode: u.barcode.trim() ? normalizeCode(u.barcode) : null,
    is_active: u.isActive,
  };
}

export function diffSaleUnits(saved: SaleUnit[], edited: SaleUnit[]) {
  const ids = new Set(edited.map((u) => u.id).filter(Boolean) as string[]);
  const savedById = new Map(saved.filter((s) => s.id).map((s) => [s.id as string, s]));
  return {
    insert: edited.filter((u) => !u.id).map(saleUnitToRow),
    update: edited
      .filter((u) => u.id && JSON.stringify(saleUnitToRow(savedById.get(u.id)!)) !== JSON.stringify(saleUnitToRow(u)))
      .map((u) => ({ id: u.id as string, ...saleUnitToRow(u) })),
    remove: saved.filter((s) => s.id && !ids.has(s.id)).map((s) => s.id as string),
  };
}

// ── Venta: el renglón del bulto se expande para el servidor ───────────────
/** Datos del bulto que viajan en la línea del carrito. */
export interface CartSaleUnit {
  id: string;
  units: number;
  /** Precio unitario de lista con el que entró (el servidor lo valida). */
  basePrice: number;
  label: string;
  price: number | null;
  discountPct: number;
  allowDiscount: boolean;
}

/**
 * Renglón del carrito (cantidad en bultos, precio del bulto) → renglón de
 * create_sale (cantidad en unidades, precio unitario de lista, descuento del
 * renglón = lo que baja el bulto + el descuento manual).
 */
export function expandSaleUnitLine(l: { quantity: number; unitPrice: number; discount: number; saleUnit: CartSaleUnit }) {
  const qty = l.quantity * l.saleUnit.units;
  const packDisc = round2(Math.max(0, l.quantity * (l.saleUnit.units * l.saleUnit.basePrice - l.unitPrice)));
  return { quantity: qty, unit_price: l.saleUnit.basePrice, discount: round2(packDisc + (l.discount || 0)) };
}

/** Repreciado (price_mismatch): el servidor manda el precio unitario. */
export function repriceSaleUnit(su: CartSaleUnit, expectedUnitPrice: number): { to: number; saleUnit: CartSaleUnit } {
  const next = { ...su, basePrice: expectedUnitPrice };
  return { to: saleUnitPrice(next, expectedUnitPrice, su.allowDiscount), saleUnit: next };
}

// ── Búsqueda local (POS sin conexión) ─────────────────────────────────────
export interface OfflineCodes {
  product_barcodes?: { code: string; deleted_at?: string | null }[] | null;
  product_sale_units?:
    | { id: string; label: string; units: number; price: number | null; discount_pct: number; barcode: string | null; is_active: boolean; deleted_at?: string | null }[]
    | null;
}

/** "42" encuentra el PLU "000042". */
export function pluCandidates(code: string): string[] {
  const c = code.trim();
  return /^\d{1,5}$/.test(c) ? [c, c.padStart(6, "0")] : [c];
}
