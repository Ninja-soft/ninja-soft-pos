// Gestor de Mercado Libre (H141 · ADR-132): precio por tipo de publicación y
// stock publicable. PURO.
//
// Espejo EXACTO de las funciones SQL de 20261127100000_ml_gestor_publicaciones:
//   listingPrice   <-> _ml_listing_price
//   publishableQty <-> _ml_available_qty (la parte de reservas y tope)
// El precio que viaja a Mercado Libre lo calcula siempre el servidor; esto
// sirve para la vista previa de la configuración y lo cubren los tests.

export type ListingRuleMode = "markup" | "price_list";
export type OverrideMode = "inherit" | "markup" | "price_list" | "fixed" | "skip";

export interface ListingRule {
  listing_type_id: string;
  enabled: boolean;
  mode: ListingRuleMode;
  markup_pct: number;
  price_list_id: string | null;
  /** 0 = usa el redondeo de la cuenta. */
  rounding: number;
  min_price: number;
  default_on: boolean;
}

export interface ListingOverride {
  listing_type_id: string;
  mode: OverrideMode;
  markup_pct: number | null;
  price_list_id: string | null;
  fixed_price: number | null;
  min_price: number | null;
}

export interface ListingPriceInput {
  /** Precio base de la cuenta (lista de la cuenta o POS + margen, ya redondeado). */
  basePrice: number | null;
  /** Precio de un producto en una lista (null si no tiene). */
  listPrice: (listId: string) => number | null;
  /** Redondeo de la cuenta (price_rounding). */
  accountRounding: number;
  rule: ListingRule | null;
  override: ListingOverride | null;
}

/** round(v, 2) de Postgres (mitad hacia afuera) sin el error de la coma flotante. */
const round2 = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 100 + 1e-6)) / 100;

/** Redondeo hacia arriba al múltiplo (0 = sin redondeo). Espejo de _ml_round_up. */
export function roundUp(value: number, step: number): number {
  if (!(step > 0)) return value;
  // Tolerancia para no subir un escalón por error de coma flotante (1000.0000001).
  return Math.ceil(value / step - 1e-9) * step;
}

/**
 * Precio de un producto en un tipo de publicación. null = no se publica en
 * ese tipo (override "skip") o no hay precio.
 */
export function listingPrice(input: ListingPriceInput): number | null {
  const rule = input.rule && input.rule.enabled ? input.rule : null;
  const ov = input.override;
  if (ov?.mode === "skip") return null;
  const min = ov?.min_price ?? rule?.min_price ?? 0;
  if (ov?.mode === "fixed") {
    if (!(ov.fixed_price && ov.fixed_price > 0)) return null;
    return round2(Math.max(ov.fixed_price, min));
  }

  let mode: ListingRuleMode = "markup";
  let list: string | null = null;
  if (ov?.mode === "price_list") {
    mode = "price_list";
    list = ov.price_list_id;
  } else if (rule?.mode === "price_list") {
    mode = "price_list";
    list = rule.price_list_id;
  }

  let v: number | null = mode === "price_list" && list ? input.listPrice(list) : input.basePrice;
  if (v === null || v === undefined || !Number.isFinite(v)) return null;

  const pct = ov?.mode === "markup" || ov?.mode === "price_list" ? (ov.markup_pct ?? 0) : (rule?.markup_pct ?? 0);
  if (pct !== 0) v = v * (1 + pct / 100);

  const step = rule && rule.rounding > 0 ? rule.rounding : input.accountRounding || 0;
  if (pct !== 0 || mode === "price_list") v = roundUp(v, step);
  return round2(Math.max(v, min));
}

export interface StockRules {
  reserve_qty: number;
  reserve_pct: number;
  max_qty: number | null;
}

/** Stock publicable a partir del disponible de la sucursal o depósito. */
export function publishableQty(available: number | null, r: StockRules): number | null {
  if (available === null || available === undefined) return null;
  let q = Math.max(Math.floor(available - (r.reserve_qty || 0)), 0);
  if (r.reserve_pct > 0) q = Math.floor(q * (1 - r.reserve_pct / 100));
  if (r.max_qty !== null && r.max_qty !== undefined) q = Math.min(q, r.max_qty);
  return Math.max(q, 0);
}

export interface ListingFee {
  listing_type_id: string;
  name: string;
  sale_fee_amount: number;
  percentage_fee: number;
  fixed_fee: number;
}

/**
 * Recargo sugerido para que un tipo deje el mismo neto que otro tipo de
 * referencia (por ejemplo Premium contra Clásica): neto = precio - comisión.
 * Comisión = precio * pct/100 + fijo. Devuelve el % sobre el precio de
 * referencia, redondeado a 0,5, o null si no se puede calcular.
 */
export function suggestedMarkup(price: number, reference: ListingFee, target: ListingFee): number | null {
  if (!(price > 0)) return null;
  const net = price - (price * reference.percentage_fee) / 100 - reference.fixed_fee;
  const k = 1 - target.percentage_fee / 100;
  if (!(k > 0) || !(net > 0)) return null;
  const needed = (net + target.fixed_fee) / k;
  const pct = (needed / price - 1) * 100;
  return Math.round(pct * 2) / 2;
}

/** Defaults sugeridos al configurar por primera vez. */
export const DEFAULT_RULES: ListingRule[] = [
  { listing_type_id: "gold_special", enabled: true, mode: "markup", markup_pct: 0, price_list_id: null, rounding: 0, min_price: 0, default_on: true },
  { listing_type_id: "gold_pro", enabled: true, mode: "markup", markup_pct: 15, price_list_id: null, rounding: 0, min_price: 0, default_on: false },
];
