// lib/commercial/margins.ts
//
// Márgenes y alertas (F14 · H67, ADR-092). PURO. Espejo de margin_alerts y
// trg_products_margin_watch (migración 20261109200200).
//
// Margen = (precio - costo) / precio, sobre el precio de venta.

export type MarginLevel = "ok" | "low" | "negative" | "below_min_price" | "no_cost";

export interface MarginAlertRow {
  product_id: string;
  name: string;
  sku: string | null;
  category_id: string | null;
  price: number;
  cost: number;
  margin_pct: number;
  min_price: number | null;
  level: Exclude<MarginLevel, "ok" | "no_cost">;
  suggested_price: number;
}

export interface MarginSummary {
  min_margin_pct: number;
  active: number;
  without_cost: number;
  negative: number;
  low: number;
  below_min_price: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Margen sobre el precio, en %. null sin precio o sin costo. */
export function marginPct(price: number | null | undefined, cost: number | null | undefined): number | null {
  const p = Number(price ?? 0);
  const c = Number(cost ?? 0);
  if (!(p > 0) || !(c > 0)) return null;
  return r2(((p - c) * 100) / p);
}

/** Nivel de alerta del producto (el más grave primero). */
export function marginLevel(
  price: number | null | undefined,
  cost: number | null | undefined,
  minMarginPct: number,
  minPrice?: number | null,
): MarginLevel {
  const p = Number(price ?? 0);
  const c = Number(cost ?? 0);
  if (!(p > 0)) return "ok";
  if (!(c > 0)) return "no_cost";
  if (p < c) return "negative";
  if (minPrice != null && p < minPrice) return "below_min_price";
  return ((p - c) * 100) / p < minMarginPct ? "low" : "ok";
}

/** Precio que deja el margen mínimo (y respeta el precio mínimo). */
export function suggestedPrice(cost: number, minMarginPct: number, minPrice?: number | null): number {
  if (!(cost > 0) || minMarginPct < 0 || minMarginPct >= 100) return Math.max(0, minPrice ?? 0);
  return Math.max(r2((cost * 100) / (100 - minMarginPct)), minPrice ?? 0);
}

/** ¿El cambio de costo o precio cruza el mínimo hacia abajo? (dispara el aviso). */
export function crossesBelow(
  before: { price: number | null; cost: number | null },
  after: { price: number | null; cost: number | null },
  minMarginPct: number,
): boolean {
  const now = marginPct(after.price, after.cost);
  if (now == null || now >= minMarginPct) return false;
  const prev = marginPct(before.price, before.cost);
  return prev == null || prev >= minMarginPct;
}

export const MARGIN_LEVEL_LABEL: Record<MarginLevel, string> = {
  ok: "Bien",
  low: "Margen bajo",
  negative: "Bajo costo",
  below_min_price: "Bajo el precio mínimo",
  no_cost: "Sin costo",
};

export function marginErrorMessage(e: unknown): string {
  const msg = String((e as { message?: string } | null)?.message ?? e ?? "");
  if (/invalid_margin/.test(msg)) return "El margen mínimo va de 0 a 99 %.";
  if (/forbidden/.test(msg)) return "Sólo el dueño o el encargado ven los márgenes.";
  if (/feature_not_in_plan/.test(msg)) return "Tu plan no incluye las alertas de margen.";
  return "No se pudo completar la acción.";
}
