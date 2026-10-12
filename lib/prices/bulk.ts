// Actualización masiva de precios (F18 · H100, ADR-058). Lógica pura.
//
// bulkNewPrice es espejo de `_price_bulk_new` (SQL, 20261021100300): el
// servidor calcula el diff autoritativo; acá se resume la vista previa, se
// calcula el % de un índice y el recargo de una condición de pago.

import { applyRounding, fromCents, isRounding, toCents, type RoundingRule } from "./rounding";

export type BulkMode = "pct" | "amount";

export function bulkNewPrice(
  oldPrice: number,
  mode: BulkMode,
  value: number,
  rounding?: RoundingRule | null,
): number {
  const c = toCents(oldPrice);
  let v = mode === "amount" ? c + toCents(value) : toCents((c * (100 + value)) / 10000);
  v = Math.max(0, v);
  if (isRounding(rounding) && v > 0) v = toCents(applyRounding(fromCents(v), rounding));
  return fromCents(v);
}

export interface BulkPreviewRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  old_price: number;
  new_price: number;
  cost: number | null;
}

export interface BulkSummary {
  count: number;
  before: number;
  after: number;
  /** Variación promedio ponderada por precio (en %). */
  avgPct: number;
  up: number;
  down: number;
  belowCost: number;
}

export function summarizePreview(rows: BulkPreviewRow[]): BulkSummary {
  let before = 0;
  let after = 0;
  let up = 0;
  let down = 0;
  let belowCost = 0;
  for (const r of rows) {
    before += toCents(r.old_price);
    after += toCents(r.new_price);
    if (r.new_price > r.old_price) up++;
    else if (r.new_price < r.old_price) down++;
    if (r.cost != null && r.cost > 0 && r.new_price < r.cost) belowCost++;
  }
  const avgPct = before > 0 ? Math.round(((after - before) / before) * 10000) / 100 : 0;
  return { count: rows.length, before: fromCents(before), after: fromCents(after), avgPct, up, down, belowCost };
}

/** % entre dos valores de un índice o cotización, con tope opcional (4 decimales). */
export function indexPct(from: number, to: number, capPct?: number | null): number {
  if (!(from > 0) || !(to > 0)) return 0;
  let pct = Math.round((to / from - 1) * 1_000_000) / 10_000;
  if (capPct != null && pct > capPct) pct = capPct;
  return pct;
}

export type TermRateMode = "flat" | "simple" | "compound";

/**
 * Recargo financiero de una condición a partir de una tasa mensual:
 * simple = tasa × días / 30; compuesto = (1 + tasa)^(días / 30) − 1.
 * Devuelve el % con 3 decimales (lo que se guarda en payment_terms).
 */
export function termSurcharge(monthlyRatePct: number, days: number, mode: TermRateMode): number {
  if (mode === "flat" || !(monthlyRatePct > 0) || !(days > 0)) return 0;
  const months = days / 30;
  const pct =
    mode === "simple" ? monthlyRatePct * months : (Math.pow(1 + monthlyRatePct / 100, months) - 1) * 100;
  return Math.round(pct * 1000) / 1000;
}
