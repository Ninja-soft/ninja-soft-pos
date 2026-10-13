// Señales de riesgo operativo por persona (F16 · H82, ADR-091).
//
// operational_risk_signals() devuelve números por persona en un período; acá
// se convierten en señales legibles y un puntaje 0..100 con nivel. Es una
// guía para revisar, no una acusación: el texto lo dice así.

import { DEFAULT_RISK_SETTINGS, type RiskSettings } from "@/lib/risk/riskScore";

export interface RiskPersonRow {
  user_id: string | null;
  name: string;
  sales_count: number;
  sales_total: number;
  sales_subtotal: number;
  discount_total: number;
  discounted_sales: number;
  voids_count: number;
  voids_total: number;
  returns_count: number;
  returns_total: number;
  rejected_payments: number;
  shifts_closed: number;
  cash_diff_total: number;
  cash_diff_shifts: number;
  flags_pending: number;
  flags_total: number;
}

export interface RiskSignalsResponse {
  settings: RiskSettings;
  people: RiskPersonRow[];
}

export type RiskSignalKind = "anulaciones" | "descuentos" | "devoluciones" | "cobros_rechazados" | "caja" | "marcas";
export type RiskLevel = "alto" | "medio" | "bajo";

export interface RiskSignal {
  kind: RiskSignalKind;
  label: string;
  weight: number;
}

export interface PersonRisk {
  row: RiskPersonRow;
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
}

// Tasas a partir de las cuales una señal cuenta (sobre las ventas de la
// persona en el período). Con pocas ventas pesa la cantidad absoluta.
export const SIGNAL_RULES = {
  voidRate: 0.05, // más del 5% de sus ventas anuladas
  voidMin: 3, // o 3 anulaciones o más
  returnRate: 0.05,
  returnMin: 3,
  rejectedMin: 3,
} as const;

export const SIGNAL_WEIGHTS: Record<RiskSignalKind, number> = {
  anulaciones: 25,
  descuentos: 20,
  devoluciones: 20,
  cobros_rechazados: 10,
  caja: 25,
  marcas: 30,
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function personRisk(row: RiskPersonRow, s: RiskSettings = DEFAULT_RISK_SETTINGS): PersonRisk {
  const signals: RiskSignal[] = [];
  const sales = Math.max(Number(row.sales_count) || 0, 0);
  const voids = Number(row.voids_count) || 0;
  const returns = Number(row.returns_count) || 0;

  const voidRate = sales > 0 ? voids / (sales + voids) : voids > 0 ? 1 : 0;
  if (voids >= SIGNAL_RULES.voidMin || (voids > 0 && voidRate > SIGNAL_RULES.voidRate)) {
    signals.push({
      kind: "anulaciones",
      label: `${voids} ${voids === 1 ? "anulación" : "anulaciones"} (${pct(voidRate)} de sus ventas)`,
      weight: SIGNAL_WEIGHTS.anulaciones,
    });
  }

  const subtotal = Number(row.sales_subtotal) || 0;
  const discountPct = subtotal > 0 ? ((Number(row.discount_total) || 0) / subtotal) * 100 : 0;
  if (discountPct >= s.discount_pct_high) {
    signals.push({
      kind: "descuentos",
      label: `Descuentos del ${Math.round(discountPct)}% sobre lo vendido`,
      weight: SIGNAL_WEIGHTS.descuentos,
    });
  }

  const returnRate = sales > 0 ? returns / sales : returns > 0 ? 1 : 0;
  if (returns >= SIGNAL_RULES.returnMin || (returns > 0 && returnRate > SIGNAL_RULES.returnRate)) {
    signals.push({
      kind: "devoluciones",
      label: `${returns} ${returns === 1 ? "devolución" : "devoluciones"} (${pct(returnRate)} de sus ventas)`,
      weight: SIGNAL_WEIGHTS.devoluciones,
    });
  }

  const rejected = Number(row.rejected_payments) || 0;
  if (rejected >= SIGNAL_RULES.rejectedMin) {
    signals.push({
      kind: "cobros_rechazados",
      label: `${rejected} cobros rechazados`,
      weight: SIGNAL_WEIGHTS.cobros_rechazados,
    });
  }

  const diffShifts = Number(row.cash_diff_shifts) || 0;
  if (diffShifts > 0) {
    signals.push({
      kind: "caja",
      label: `${diffShifts} ${diffShifts === 1 ? "cierre" : "cierres"} con diferencia de caja mayor al umbral`,
      weight: SIGNAL_WEIGHTS.caja,
    });
  }

  const flags = Number(row.flags_pending) || 0;
  if (flags > 0) {
    signals.push({
      kind: "marcas",
      label: `${flags} ${flags === 1 ? "operación marcada" : "operaciones marcadas"} sin revisar`,
      weight: SIGNAL_WEIGHTS.marcas,
    });
  }

  const score = Math.min(
    signals.reduce((acc, x) => acc + x.weight, 0),
    100,
  );
  return { row, score, signals, level: riskLevel(score) };
}

export function riskLevel(score: number): RiskLevel {
  if (score >= 50) return "alto";
  if (score >= 25) return "medio";
  return "bajo";
}

export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = {
  alto: "Revisar",
  medio: "Mirar",
  bajo: "Sin señales",
};

/** Personas ordenadas por puntaje (mayor primero); a igual puntaje, por nombre. */
export function rankPeople(rows: RiskPersonRow[], s: RiskSettings = DEFAULT_RISK_SETTINGS): PersonRisk[] {
  return rows
    .map((r) => personRisk(r, s))
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
}

const ERRORS: [RegExp, string][] = [
  [/feature_not_in_plan: prevencion_fraude/, "Tu plan no incluye prevención de fraude."],
  [/forbidden/, "Sólo el dueño o un encargado ven el riesgo operativo."],
  [/range_too_long/, "Elegí un período de hasta 92 días."],
  [/note_required/, "Para descartar una marca contá por qué."],
  [/check constraint|invalid_settings/, "Revisá los umbrales: hay un valor fuera de rango."],
];

export function riskErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [re, text] of ERRORS) if (re.test(msg)) return text;
  return "No se pudo completar la operación.";
}
