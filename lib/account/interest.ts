// Punitorios de cuenta corriente (Cuenta corriente v2).
//
// ESPEJO del SQL: account_accrue_interest() en
// supabase/migrations/20261011200100_cuenta_corriente_v2_rpc.sql.
//
// Reglas:
// - El punitorio corre desde el día siguiente al vencimiento + días de gracia
//   (`interestStart`).
// - Los períodos arrancan en ese inicio y se repiten cada mes (tasa mensual,
//   "por mes o fracción") o cada día (tasa diaria). Cada período EMPEZADO
//   devenga una unidad de tasa.
// - Cada corrida liquida, en UN movimiento, las unidades de los períodos que
//   empezaron desde el último liquidado. El movimiento se identifica por el
//   inicio del último período (`period`), único por cargo: re-correr el mismo
//   día no duplica.
// - simple: capital pendiente × tasa × unidades.
//   compuesto: (capital pendiente + interés impago) × ((1 + tasa)^unidades − 1).
// - Tope (`cap_pct`): el interés liquidado acumulado del cargo nunca supera ese
//   % del capital ORIGINAL. null = sin tope.
// - Mínimo (`min_amount`): si lo calculado es menor, no se liquida en esta
//   corrida (las unidades se acumulan para la próxima).
import { addDays, addMonthsClamped, diffDays } from "./terms";

export interface InterestConfig {
  enabled: boolean;
  rate_pct: number;
  period: "monthly" | "daily";
  method: "simple" | "compound";
  grace_days: number;
  cap_pct: number | null;
  min_amount: number;
}

export interface AccrueInput {
  asOf: string;
  dueDate: string;
  originalAmount: number;
  outstandingPrincipal: number;
  unpaidInterest: number;
  postedInterest: number;
  lastPeriod: string | null;
  cfg: InterestConfig;
}

export interface Accrual {
  period: string;
  units: number;
  amount: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function interestStart(dueDate: string, graceDays: number): string {
  return addDays(dueDate, Math.max(0, Math.trunc(graceDays)) + 1);
}

// Cantidad de períodos que empezaron hasta `asOf` (inclusive) e inicio del último.
function periodsStarted(
  start: string,
  asOf: string,
  period: "monthly" | "daily",
): { count: number; last: string | null } {
  if (diffDays(start, asOf) < 0) return { count: 0, last: null };
  if (period === "daily") {
    const n = diffDays(start, asOf) + 1;
    return { count: n, last: addDays(start, n - 1) };
  }
  let k = 0;
  while (diffDays(addMonthsClamped(start, k + 1), asOf) >= 0) k++;
  return { count: k + 1, last: addMonthsClamped(start, k) };
}

export function accrueInterest(input: AccrueInput): Accrual | null {
  const { cfg } = input;
  if (!cfg.enabled || cfg.rate_pct <= 0) return null;
  if (input.outstandingPrincipal <= 0.004) return null;

  const start = interestStart(input.dueDate, cfg.grace_days);
  const now = periodsStarted(start, input.asOf, cfg.period);
  if (now.count === 0 || !now.last) return null;

  const done = input.lastPeriod ? periodsStarted(start, input.lastPeriod, cfg.period).count : 0;
  const units = now.count - done;
  if (units <= 0) return null;

  const r = cfg.rate_pct / 100;
  let amount =
    cfg.method === "compound"
      ? (input.outstandingPrincipal + Math.max(0, input.unpaidInterest)) * (Math.pow(1 + r, units) - 1)
      : input.outstandingPrincipal * r * units;
  amount = round2(amount);

  if (cfg.cap_pct != null && cfg.cap_pct >= 0) {
    const room = round2((input.originalAmount * cfg.cap_pct) / 100 - input.postedInterest);
    amount = Math.min(amount, room);
  }
  if (amount <= 0.004) return null;
  if (amount < cfg.min_amount) return null;

  return { period: now.last, units, amount };
}

// Calculadora de ejemplo (configuración): interés que generaría `principal` con
// `daysLate` días de atraso, aplicando gracia, tope y método.
export function interestExample(principal: number, daysLate: number, cfg: InterestConfig): number {
  const due = "2026-01-01";
  const r = accrueInterest({
    asOf: addDays(due, Math.max(0, Math.trunc(daysLate))),
    dueDate: due,
    originalAmount: principal,
    outstandingPrincipal: principal,
    unpaidInterest: 0,
    postedInterest: 0,
    lastPeriod: null,
    cfg: { ...cfg, enabled: true, min_amount: 0 },
  });
  return r?.amount ?? 0;
}
