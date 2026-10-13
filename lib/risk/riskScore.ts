// Prevención de fraude y riesgo operativo (F16 · H82, ADR-091).
//
// Puntaje de UNA operación (devolución o anulación). Espejo exacto de
// risk_score_return / risk_score_void (20261109100200_riesgo_operativo.sql):
// mismos pesos y mismos códigos de motivo. Si cambia uno, cambia el otro
// (tests/unit/riskOperativo.test.ts compara los pesos con la migración).

export interface RiskSettings {
  return_amount_high: number;
  return_days_late: number;
  returns_per_user_day: number;
  voids_per_user_day: number;
  discount_pct_high: number;
  cash_diff_abs: number;
  flag_score_min: number;
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  return_amount_high: 50000,
  return_days_late: 30,
  returns_per_user_day: 3,
  voids_per_user_day: 3,
  discount_pct_high: 20,
  cash_diff_abs: 5000,
  flag_score_min: 50,
};

export type RiskReason =
  | "monto_alto"
  | "fuera_de_plazo"
  | "devoluciones_repetidas"
  | "efectivo_sin_cliente"
  | "misma_persona"
  | "anulaciones_repetidas"
  | "anulada_tarde"
  | "turno_cerrado";

export const RISK_REASON_LABEL: Record<RiskReason, string> = {
  monto_alto: "Monto alto",
  fuera_de_plazo: "Fuera de plazo",
  devoluciones_repetidas: "Muchas devoluciones en el día",
  efectivo_sin_cliente: "Efectivo sin cliente",
  misma_persona: "La misma persona vendió y revirtió",
  anulaciones_repetidas: "Muchas anulaciones en el día",
  anulada_tarde: "Anulada más de 2 horas después",
  turno_cerrado: "El turno de la venta ya estaba cerrado",
};

export const RETURN_WEIGHTS = {
  monto_alto: 40,
  fuera_de_plazo: 20,
  devoluciones_repetidas: 25,
  efectivo_sin_cliente: 15,
  misma_persona: 20,
} as const;

export const VOID_WEIGHTS = {
  monto_alto: 40,
  anulaciones_repetidas: 30,
  anulada_tarde: 15,
  turno_cerrado: 25,
  misma_persona: 15,
} as const;

export const VOID_LATE_MINUTES = 120;

export interface ScoreResult {
  score: number;
  reasons: RiskReason[];
}

function finish(parts: [boolean, RiskReason, number][]): ScoreResult {
  let score = 0;
  const reasons: RiskReason[] = [];
  for (const [hit, reason, weight] of parts) {
    if (!hit) continue;
    score += weight;
    reasons.push(reason);
  }
  return { score: Math.min(score, 100), reasons };
}

export function scoreReturn(
  s: RiskSettings,
  x: {
    amount: number;
    daysSinceSale: number;
    userReturnsToday: number;
    cashWithoutCustomer: boolean;
    sameUserSold: boolean;
  },
): ScoreResult {
  return finish([
    [x.amount >= s.return_amount_high, "monto_alto", RETURN_WEIGHTS.monto_alto],
    [x.daysSinceSale > s.return_days_late, "fuera_de_plazo", RETURN_WEIGHTS.fuera_de_plazo],
    [x.userReturnsToday > s.returns_per_user_day, "devoluciones_repetidas", RETURN_WEIGHTS.devoluciones_repetidas],
    [x.cashWithoutCustomer, "efectivo_sin_cliente", RETURN_WEIGHTS.efectivo_sin_cliente],
    [x.sameUserSold, "misma_persona", RETURN_WEIGHTS.misma_persona],
  ]);
}

export function scoreVoid(
  s: RiskSettings,
  x: {
    amount: number;
    userVoidsToday: number;
    minutesAfterSale: number;
    shiftClosed: boolean;
    sameUserSold: boolean;
  },
): ScoreResult {
  return finish([
    [x.amount >= s.return_amount_high, "monto_alto", VOID_WEIGHTS.monto_alto],
    [x.userVoidsToday > s.voids_per_user_day, "anulaciones_repetidas", VOID_WEIGHTS.anulaciones_repetidas],
    [x.minutesAfterSale > VOID_LATE_MINUTES, "anulada_tarde", VOID_WEIGHTS.anulada_tarde],
    [x.shiftClosed, "turno_cerrado", VOID_WEIGHTS.turno_cerrado],
    [x.sameUserSold, "misma_persona", VOID_WEIGHTS.misma_persona],
  ]);
}

export function shouldFlag(s: RiskSettings, r: ScoreResult): boolean {
  return r.score >= s.flag_score_min;
}

export function reasonLabel(code: string): string {
  return RISK_REASON_LABEL[code as RiskReason] ?? code;
}

/** Valida los umbrales antes de guardarlos (mismos rangos que los CHECK). */
export function validateRiskSettings(s: RiskSettings): string[] {
  const errors: string[] = [];
  if (!(s.return_amount_high > 0)) errors.push("El monto alto tiene que ser mayor a cero.");
  if (!(s.return_days_late >= 1 && s.return_days_late <= 365)) errors.push("El plazo de devolución va de 1 a 365 días.");
  if (!(s.returns_per_user_day >= 1 && s.returns_per_user_day <= 100)) errors.push("Devoluciones por día: de 1 a 100.");
  if (!(s.voids_per_user_day >= 1 && s.voids_per_user_day <= 100)) errors.push("Anulaciones por día: de 1 a 100.");
  if (!(s.discount_pct_high > 0 && s.discount_pct_high <= 100)) errors.push("El descuento alto va de 1% a 100%.");
  if (!(s.cash_diff_abs >= 0)) errors.push("La diferencia de caja no puede ser negativa.");
  if (!(s.flag_score_min >= 1 && s.flag_score_min <= 100)) errors.push("El puntaje para marcar va de 1 a 100.");
  for (const k of ["return_days_late", "returns_per_user_day", "voids_per_user_day", "flag_score_min"] as const) {
    if (!Number.isInteger(s[k])) {
      errors.push("Los días, cantidades y el puntaje van sin decimales.");
      break;
    }
  }
  return errors;
}
