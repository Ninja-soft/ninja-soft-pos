// lib/stock/cycleCount.ts
//
// Conteo cíclico por clase ABC (F14 · H64, ADR-092). PURO. Espejo de
// cycle_count_due y cycle_count_submit (migración 20261109200300).
//
// Clase: se ordenan los productos por venta de la sucursal (mayor a menor);
// un producto es A si lo acumulado ANTES de él es menor al corte A (el
// primero siempre es A si vendió), B si es menor al corte B, y C el resto o
// si no vendió. Toca contar si nunca se contó o si pasaron los días de su
// clase desde el último conteo.

export type AbcClass = "A" | "B" | "C";

export interface CyclePolicy {
  a_days: number;
  b_days: number;
  c_days: number;
  a_share: number;
  b_share: number;
  lookback_days: number;
  daily_items: number;
}

export const DEFAULT_CYCLE_POLICY: CyclePolicy = {
  a_days: 7,
  b_days: 30,
  c_days: 90,
  a_share: 80,
  b_share: 95,
  lookback_days: 90,
  daily_items: 25,
};

export interface CycleDueRow {
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string | null;
  abc_class: AbcClass;
  sales_value: number;
  system_qty: number;
  last_counted_at: string | null;
  due_days: number;
}

const keyOf = (x: { key: string }) => x.key;

/** Clasifica por participación en la venta. Devuelve key → clase. */
export function classifyAbc(
  rows: { key: string; value: number }[],
  policy: Pick<CyclePolicy, "a_share" | "b_share"> = DEFAULT_CYCLE_POLICY,
): Map<string, AbcClass> {
  const sorted = [...rows]
    .map((r) => ({ key: r.key, value: Math.max(0, Number(r.value) || 0) }))
    .sort((a, b) => b.value - a.value || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const total = sorted.reduce((a, r) => a + r.value, 0);
  const out = new Map<string, AbcClass>();
  let before = 0;
  for (const r of sorted) {
    let c: AbcClass = "C";
    if (r.value > 0 && total > 0) {
      const share = (before * 100) / total;
      c = share < policy.a_share ? "A" : share < policy.b_share ? "B" : "C";
    }
    out.set(r.key, c);
    before += r.value;
  }
  return out;
}

export function daysFor(c: AbcClass, policy: Pick<CyclePolicy, "a_days" | "b_days" | "c_days"> = DEFAULT_CYCLE_POLICY): number {
  return c === "A" ? policy.a_days : c === "B" ? policy.b_days : policy.c_days;
}

/** ¿Toca contar? */
export function isDue(lastCountedAt: string | Date | null, c: AbcClass, policy: CyclePolicy = DEFAULT_CYCLE_POLICY, now: Date = new Date()): boolean {
  if (!lastCountedAt) return true;
  const last = new Date(lastCountedAt).getTime();
  return last <= now.getTime() - daysFor(c, policy) * 86_400_000;
}

/** Días de atraso (0 si no toca o si nunca se contó). */
export function overdueDays(lastCountedAt: string | null, c: AbcClass, policy: CyclePolicy = DEFAULT_CYCLE_POLICY, now: Date = new Date()): number {
  if (!lastCountedAt) return 0;
  const diff = Math.floor((now.getTime() - new Date(lastCountedAt).getTime()) / 86_400_000) - daysFor(c, policy);
  return Math.max(0, diff);
}

export interface CountLine {
  expected: number;
  counted: number;
  unitCost?: number | null;
}

/** Resumen del conteo: exactitud (líneas sin diferencia) y diferencias. */
export function countSummary(lines: CountLine[]): {
  lines: number;
  exact: number;
  accuracyPct: number | null;
  unitsDiff: number;
  valueDiff: number;
} {
  let exact = 0;
  let units = 0;
  let value = 0;
  for (const l of lines) {
    const d = (Number(l.counted) || 0) - (Number(l.expected) || 0);
    if (d === 0) exact++;
    units += d;
    value += Math.round(d * (Number(l.unitCost) || 0) * 100) / 100;
  }
  return {
    lines: lines.length,
    exact,
    accuracyPct: lines.length ? Math.round((exact * 10000) / lines.length) / 100 : null,
    unitsDiff: Math.round(units * 1000) / 1000,
    valueDiff: Math.round(value * 100) / 100,
  };
}

/** Valida la política antes de mandarla (mismas reglas que los CHECK). */
export function policyError(p: CyclePolicy): string | null {
  const int = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!int(p.a_days, 1, 365) || !int(p.b_days, 1, 365) || !int(p.c_days, 1, 365)) return "Los días van de 1 a 365.";
  if (!(p.a_days <= p.b_days && p.b_days <= p.c_days)) return "A se cuenta más seguido que B, y B más que C.";
  if (!(p.a_share > 0 && p.a_share < p.b_share && p.b_share <= 100)) return "El corte de A tiene que ser menor que el de B (hasta 100 %).";
  if (!int(p.lookback_days, 7, 365)) return "La ventana de ventas va de 7 a 365 días.";
  if (!int(p.daily_items, 1, 200)) return "Por día, de 1 a 200 productos.";
  return null;
}

export const ABC_HINT: Record<AbcClass, string> = {
  A: "Lo que más vende",
  B: "Venta media",
  C: "Poca o ninguna venta",
};

export function cycleErrorMessage(e: unknown): string {
  const msg = String((e as { message?: string } | null)?.message ?? e ?? "");
  if (/feature_not_in_plan: conteo_ciclico/.test(msg)) return "Tu plan no incluye el conteo cíclico.";
  if (/feature_not_in_plan: (multi_sucursal|stock_sucursales)/.test(msg)) return "Tu plan no incluye stock por sucursal.";
  if (/forbidden_store/.test(msg)) return "No tenés acceso a esa sucursal.";
  if (/forbidden/.test(msg)) return "Sólo el dueño o el encargado cuentan stock.";
  if (/duplicate_lines/.test(msg)) return "Hay un producto repetido en el conteo.";
  if (/invalid_qty/.test(msg)) return "Revisá las cantidades: no pueden ser negativas.";
  if (/invalid_lines/.test(msg)) return "Contá al menos un producto (hasta 300 por vez).";
  return "No se pudo guardar el conteo.";
}
