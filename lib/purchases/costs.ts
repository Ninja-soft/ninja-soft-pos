// lib/purchases/costs.ts
//
// Lógica PURA de costos por producto (F18 · H101, ADR-050). Espejo de las
// funciones SQL purchase_weighted_avg y product_basis_cost (migraciones
// 20261016100100 y 20261016100200). Sin React ni Supabase: testeable.
//
// Todos los costos son NETOS de IVA y en pesos: el crédito fiscal computable
// nunca se suma al costo.

export type CostBasis = "last" | "average" | "replacement";

export const COST_BASES: CostBasis[] = ["last", "average", "replacement"];

export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  last: "Último costo",
  average: "Costo promedio ponderado",
  replacement: "Costo de reposición",
};

export const COST_BASIS_HINT: Record<CostBasis, string> = {
  last: "Lo que pagaste en la última compra. Simple y al día.",
  average:
    "Promedia cada compra con el stock que ya tenías. Es el que mejor refleja el costo de lo vendido.",
  replacement:
    "Lo que te costaría reponerlo hoy (lista del proveedor o carga manual). El más usado para fijar precios con inflación.",
};

export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Costo promedio ponderado móvil después de ingresar `qty` unidades a
 * `unitCost`. El stock negativo cuenta como cero (lo vendido sin stock no tiene
 * costo que promediar). Sin promedio previo o sin stock, el promedio es el
 * costo de la compra. Cantidad 0 o negativa no cambia el promedio.
 */
export function weightedAverageCost(
  stockBefore: number,
  avgBefore: number | null | undefined,
  qty: number,
  unitCost: number,
): number | null {
  if (!(qty > 0)) return avgBefore ?? null;
  const s = Math.max(Number(stockBefore) || 0, 0);
  if (avgBefore == null || s === 0) return round(unitCost, 4);
  return round((s * avgBefore + qty * unitCost) / (s + qty), 4);
}

/**
 * Promedio después de aplicar (o reaplicar) un costeo de importación: la
 * diferencia total entre el costo puesto en depósito y el costo con el que la
 * línea entró al promedio se reparte sobre el stock actual. Sin stock (ya se
 * vendió todo) el promedio no cambia.
 */
export function costingAdjustedAverage(
  avg: number | null | undefined,
  stockNow: number,
  diffTotal: number,
): number | null {
  if (avg == null) return null;
  if (!(stockNow > 0)) return avg;
  return Math.max(round(avg + diffTotal / stockNow, 4), 0);
}

export interface ProductCosts {
  cost: number | null;
  last_cost: number | null;
  avg_cost: number | null;
  replacement_cost: number | null;
}

/** Costo de la base elegida (mismo fallback que product_basis_cost en SQL). */
export function basisCost(
  basis: CostBasis,
  c: Pick<ProductCosts, "last_cost" | "avg_cost" | "replacement_cost">,
): number | null {
  if (basis === "average") return c.avg_cost ?? c.last_cost ?? null;
  if (basis === "replacement") return c.replacement_cost ?? c.last_cost ?? null;
  return c.last_cost ?? c.avg_cost ?? null;
}

const toNum = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

/** Lee los costos de una fila de producto (las columnas nuevas no están en los tipos generados). */
export function productCosts(p: unknown): ProductCosts {
  const r = (p ?? {}) as Record<string, unknown>;
  return {
    cost: toNum(r.cost),
    last_cost: toNum(r.last_cost),
    avg_cost: toNum(r.avg_cost),
    replacement_cost: toNum(r.replacement_cost),
  };
}

/** Costo que alimenta el margen: el de la base elegida o, si no hay, el costo cargado. */
export function marginCost(basis: CostBasis, c: ProductCosts): number | null {
  return basisCost(basis, c) ?? c.cost;
}

/** Margen sobre costo (markup) en %, igual que el campo "Margen %" de la ficha. */
export function markupPct(price: number, cost: number | null | undefined): number | null {
  if (cost == null || !(cost > 0)) return null;
  return round(((price - cost) / cost) * 100, 1);
}

/** Margen sobre precio de venta en %. */
export function marginOnPricePct(
  price: number,
  cost: number | null | undefined,
): number | null {
  if (cost == null || !(price > 0)) return null;
  return round(((price - cost) / price) * 100, 1);
}

/** Precio sugerido para un markup dado. */
export function priceForMarkup(cost: number, markup: number): number {
  return round(cost * (1 + markup / 100), 2);
}

/**
 * Costo de reposición en pesos por unidad de stock desde la lista del
 * proveedor (en su moneda y por unidad de compra).
 */
export function replacementFromSupplier(
  listCost: number,
  currency: string,
  fxRate: number,
  unitsPerPurchase = 1,
): number {
  const fx = currency === "ARS" ? 1 : fxRate;
  const per = unitsPerPurchase > 0 ? unitsPerPurchase : 1;
  return round((listCost * fx) / per, 4);
}
