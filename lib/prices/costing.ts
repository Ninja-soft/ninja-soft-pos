// Costos y utilidad del producto, y cálculo del asistente "Actualizar precios"
// (ADR-140). Lógica pura, espejo EXACTO de las funciones SQL de
// 20261207100100_costos_producto_usd y 20261207100200_precios_actualizacion_dolar
// (price_final_cost, price_from_cost, price_usd_to_ars, price_floor_from_final,
// price_bulk_round, price_bulk_raw, price_bulk_follow, price_margin_pct). La
// paridad se prueba en PGlite con cientos de casos al azar.
//
// Todo en centavos enteros con "mitad hacia arriba" (igual que round() de
// Postgres sobre numeric). Los costos son netos de IVA.
//
// Markup vs margen (lo que se explica en pantalla):
//   · Markup: cuánto le sumás al costo. Costo $100 con 50 % de markup = $150.
//   · Margen: qué parte del precio es ganancia. Precio $150 con costo $100 =
//     33,33 % de margen. Para ganar 50 % de margen, el precio es $200.
//   El mismo precio tiene siempre markup mayor que margen.

import { applyRounding, fromCents, isRounding, toCents, toCentsCeil, type RoundingRule } from "./rounding";

export type CostCurrency = "ARS" | "USD";
export type UtilityMode = "markup" | "margin";
export type CostExtraType = "pct" | "amount";

export interface CostExtra {
  label: string;
  type: CostExtraType;
  /** % sobre el costo de compra o monto en pesos. Negativo = bonificación. */
  value: number;
}

/** Componentes sugeridos al cargar un producto (el dueño los puede renombrar). */
export const COST_EXTRA_PRESETS: { label: string; type: CostExtraType; hint: string }[] = [
  { label: "Impuestos internos no recuperables", type: "pct", hint: "Los que pagás al comprar y no descontás" },
  { label: "Percepciones no recuperables", type: "pct", hint: "IIBB u otras que no vas a computar" },
  { label: "Flete", type: "pct", hint: "En % del costo o en pesos por unidad" },
  { label: "Otros gastos", type: "amount", hint: "Embalaje, seguro, comisiones" },
];

export const MAX_COST_EXTRAS = 10;

/** Espejo de price_cost_extras_error: null si está bien. */
export function costExtrasError(extras: unknown): string | null {
  if (extras == null) return null;
  if (!Array.isArray(extras) || extras.length > MAX_COST_EXTRAS) return "invalid_cost_extras";
  for (const e of extras) {
    if (!e || typeof e !== "object") return "invalid_cost_extras";
    const x = e as Partial<CostExtra>;
    if (x.type !== "pct" && x.type !== "amount") return "invalid_cost_extras";
    if (String(x.label ?? "").length > 60) return "invalid_cost_extras";
    const v = Number(x.value);
    if (x.value == null || !Number.isFinite(v)) return "invalid_cost_extras";
    if (x.type === "pct" && (v <= -100 || v > 1000)) return "invalid_cost_extras";
    if (x.type === "amount" && Math.abs(v) > 1_000_000_000) return "invalid_cost_extras";
  }
  return null;
}

/** Costo final = costo + Σ (costo × %) + Σ $. Los % van sobre el costo de compra. */
export function finalCost(cost: number | null | undefined, extras: CostExtra[] | null | undefined): number | null {
  if (cost == null || !Number.isFinite(Number(cost))) return null;
  const base = toCents(Number(cost));
  let v = base;
  for (const e of extras ?? []) {
    if (!e || e.value == null) continue;
    if (e.type === "pct") v += toCents((base * Number(e.value)) / 10000);
    else if (e.type === "amount") v += toCents(Number(e.value));
  }
  return fromCents(Math.max(v, 0));
}

/** Detalle de cada componente en pesos (para la tabla de la ficha). */
export function costBreakdown(cost: number | null | undefined, extras: CostExtra[] | null | undefined) {
  const base = cost == null ? 0 : toCents(Number(cost));
  return (extras ?? []).map((e) => ({
    ...e,
    amount: fromCents(e.type === "pct" ? toCents((base * Number(e.value)) / 10000) : toCents(Number(e.value))),
  }));
}

/**
 * Precio desde el costo con markup o margen. Con IVA (> 0) devuelve el precio
 * final: neto × (1 + IVA). null si no se puede (sin costo, margen >= 100).
 */
export function priceFromCost(
  cost: number | null | undefined,
  mode: UtilityMode | null | undefined,
  value: number | null | undefined,
  ivaPct = 0,
): number | null {
  if (cost == null || !(Number(cost) > 0) || value == null || !Number.isFinite(Number(value))) return null;
  const c = Number(cost);
  const v = Number(value);
  let cents: number;
  if ((mode ?? "markup") === "margin") {
    if (v >= 100) return null;
    cents = toCents(c / (1 - v / 100));
  } else {
    if (v <= -100) return null;
    cents = toCents(c * (1 + v / 100));
  }
  if (Number(ivaPct) !== 0) cents = toCents((cents * (100 + Number(ivaPct))) / 10000);
  return fromCents(cents);
}

/** Costo en pesos desde dólares: round(usd × cotización, 2). */
export function usdToArs(usd: number | null | undefined, rate: number | null | undefined): number | null {
  if (usd == null || rate == null || !(Number(rate) > 0)) return null;
  return fromCents(toCents(Number(usd) * Number(rate)));
}

/** Costo en dólares desde pesos (4 decimales), cuando cambia el costo en pesos. */
export function arsToUsd(ars: number | null | undefined, rate: number | null | undefined): number | null {
  if (ars == null || rate == null || !(Number(rate) > 0)) return null;
  const x = Number(ars) / Number(rate);
  return Math.round((x + Math.sign(x) * 1e-12) * 10000) / 10000;
}

/** Piso: costo final / (1 − m) con IVA si corresponde, hacia arriba a centavos. */
export function priceFloorFromFinal(final: number | null | undefined, marginPct: number | null | undefined, ivaPct = 0): number {
  if (final == null || !(Number(final) > 0) || marginPct == null || Number(marginPct) >= 100) return 0;
  return fromCents(toCentsCeil((Number(final) / (1 - Number(marginPct) / 100)) * (1 + Number(ivaPct || 0) / 100)));
}

/** Margen sobre el precio sin IVA, en % con 2 decimales. */
export function marginPct(price: number | null | undefined, final: number | null | undefined, ivaPct = 0): number | null {
  if (price == null || !(Number(price) > 0) || final == null || !(Number(final) > 0)) return null;
  const net = Number(price) / (1 + Number(ivaPct || 0) / 100);
  return fromCents(toCents(((net - Number(final)) / net) * 100));
}

/** Utilidad que se muestra en la ficha: $ y % (markup y margen), sobre el precio sin IVA. */
export function utility(price: number | null | undefined, final: number | null | undefined, ivaPct = 0) {
  if (price == null || !(Number(price) > 0) || final == null || !(Number(final) > 0)) return null;
  const net = fromCents(toCents(Number(price) / (1 + Number(ivaPct || 0) / 100)));
  const amount = fromCents(toCents(net - Number(final)));
  return {
    net,
    amount,
    markupPct: fromCents(toCents((amount / Number(final)) * 100)),
    marginPct: fromCents(toCents((amount / net) * 100)),
  };
}

/** round(a × b / c) en centavos, mitad lejos del cero, exacto (BigInt). */
function mulDivCents(a: number, b: number, c: number): number {
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  const neg = n < BigInt(0) !== d < BigInt(0);
  const an = n < BigInt(0) ? -n : n;
  const ad = d < BigInt(0) ? -d : d;
  const q = (BigInt(2) * an + ad) / (BigInt(2) * ad);
  return Number(neg ? -q : q);
}

// ── Asistente de actualización (espejo de _price_bulk_v2_compute) ─────────────

export type BulkV2Mode = "pct" | "amount" | "fx" | "markup" | "cost";
export type RepriceMode = "keep_markup" | "target" | "none";

/** Espejo de price_bulk_round: aplica la regla (si hay) a un precio > 0. */
export function bulkRound(value: number | null, rule: RoundingRule | null | undefined): number | null {
  if (value == null) return null;
  if (!isRounding(rule) || value <= 0) return fromCents(Math.max(toCents(value), 0));
  return applyRounding(value, rule);
}

export interface BulkRawInput {
  mode: BulkV2Mode;
  value: number;
  markupMode?: UtilityMode | null;
  oldPrice: number | null;
  oldFinal: number | null;
  newFinal: number | null;
  targetMode?: UtilityMode | null;
  targetPct?: number | null;
  reprice?: RepriceMode | null;
  ivaPct?: number;
}

/** Espejo de price_bulk_raw: precio nuevo sin la regla de redondeo (null = no cambia). */
export function bulkRaw(i: BulkRawInput): number | null {
  let v: number | null;
  if (i.mode === "pct") {
    if (i.oldPrice == null) return null;
    v = fromCents(toCents((toCents(i.oldPrice) * (100 + i.value)) / 10000));
  } else if (i.mode === "amount") {
    if (i.oldPrice == null) return null;
    v = fromCents(toCents(Number(i.oldPrice) + Number(i.value)));
  } else if (i.mode === "fx") {
    const rep = i.reprice ?? "keep_markup";
    if (rep === "none") return null;
    if (rep === "target") v = priceFromCost(i.newFinal, i.targetMode, i.targetPct, i.ivaPct ?? 0);
    else {
      if (i.oldPrice == null || i.oldFinal == null || !(i.oldFinal > 0) || i.newFinal == null) return null;
      v = fromCents(mulDivCents(toCents(i.oldPrice), toCents(i.newFinal), toCents(i.oldFinal)));
    }
  } else if (i.mode === "markup") {
    v = priceFromCost(i.newFinal, i.markupMode, i.value, i.ivaPct ?? 0);
  } else if (i.mode === "cost") {
    v = priceFromCost(i.newFinal, i.targetMode, i.targetPct, i.ivaPct ?? 0);
  } else return null;
  if (v == null) return null;
  return Math.max(v, 0);
}

/** Espejo de price_bulk_follow: precio fijo que acompaña al precio de venta. */
export function bulkFollow(
  oldPrice: number | null,
  baseOld: number | null,
  baseRaw: number | null,
  rule: RoundingRule | null | undefined,
): number | null {
  if (oldPrice == null || baseOld == null || !(baseOld > 0) || baseRaw == null) return null;
  return bulkRound(fromCents(mulDivCents(toCents(oldPrice), toCents(baseRaw), toCents(baseOld))), rule);
}

export type BulkFlag = "below_cost" | "below_floor" | "low_margin";

export const BULK_FLAG_LABEL: Record<BulkFlag, string> = {
  below_cost: "Debajo del costo",
  below_floor: "Debajo del mínimo",
  low_margin: "Margen bajo",
};

/** Cotización del día o la última anterior: gana la fecha más nueva; si empatan, la del negocio. */
export interface FxQuoteRow {
  rate: number;
  rate_date: string;
  origin: "negocio" | "plataforma" | "manual";
}
export function pickFxQuote(rows: FxQuoteRow[], day: string): FxQuoteRow | null {
  let best: FxQuoteRow | null = null;
  for (const r of rows) {
    if (!(Number(r.rate) > 0) || r.rate_date > day) continue;
    if (
      !best ||
      r.rate_date > best.rate_date ||
      (r.rate_date === best.rate_date && best.origin === "plataforma" && r.origin !== "plataforma")
    )
      best = r;
  }
  return best;
}

/** Variación de la cotización en % (3 decimales), como la regla automática. */
export function fxVariationPct(from: number, to: number): number {
  if (!(from > 0) || !(to > 0)) return 0;
  return Math.round((to / from - 1) * 100_000) / 1000;
}
