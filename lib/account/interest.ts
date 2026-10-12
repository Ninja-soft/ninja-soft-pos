// Punitorios de cuenta corriente (Cuenta corriente v2).
//
// ESPEJO del SQL: account_accrue_interest() en
// supabase/migrations/20261011200100_cuenta_corriente_v2_rpc.sql.
//
// Reglas:
// - El punitorio corre desde el día siguiente al vencimiento + días de gracia
//   (`interestStart`).
// - Tasa MENSUAL (`accrueInterest`): los períodos arrancan en ese inicio y se
//   repiten cada mes ("por mes o fracción"). Cada período EMPEZADO devenga una
//   unidad de tasa. Cada corrida liquida, en UN movimiento, las unidades de los
//   períodos que empezaron desde el último liquidado. El movimiento se
//   identifica por el inicio del último período (`period`), único por cargo:
//   re-correr el mismo día no duplica.
// - Tasa DIARIA (`accrueDailyInterest`): cada día devenga una unidad, pero NO
//   se crea un movimiento por día. Hay UN movimiento por cargo y MES CALENDARIO
//   (`period` = día 1 del mes) que el cron diario va actualizando (upsert por
//   (cargo, período)); `accrued_through` guarda el último día devengado, así
//   re-correr el mismo día no suma nada. Si la corrida abarca varios meses
//   (cron caído, primer devengo tardío) arma un movimiento por cada mes.
// - simple: capital pendiente × tasa × unidades.
//   compuesto: (capital pendiente + interés impago) × ((1 + tasa)^unidades − 1).
// - Tope (`cap_pct`): el interés liquidado acumulado del cargo nunca supera ese
//   % del capital ORIGINAL. null = sin tope.
// - Mínimo (`min_amount`): si lo calculado es menor, no se liquida en esta
//   corrida (las unidades se acumulan para la próxima). En tasa diaria el
//   mínimo se mide contra el TOTAL del mes (lo ya liquidado en el mes + lo
//   nuevo); si un mes cerrado no llega, sus días pasan al mes siguiente.
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

export interface DailyAccrueInput {
  asOf: string;
  dueDate: string;
  originalAmount: number;
  outstandingPrincipal: number;
  unpaidInterest: number;
  // Todo el interés liquidado del cargo (incluye el del mes en curso).
  postedInterest: number;
  // Último día ya devengado del cargo (max accrued_through), null si ninguno.
  accruedThrough: string | null;
  // Lo ya liquidado en el movimiento del mes del primer día a devengar (0 si no hay).
  existingMonthAmount: number;
  cfg: InterestConfig;
}

export interface MonthlyAccrual {
  // Día 1 del mes calendario: clave del movimiento junto con el cargo.
  period: string;
  // Último día devengado que cubre este monto.
  through: string;
  units: number;
  // Monto a SUMAR al movimiento del mes (o a crear si no existe).
  amount: number;
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function monthEnd(iso: string): string {
  return addDays(addMonthsClamped(monthStart(iso), 1), -1);
}

export function accrueDailyInterest(input: DailyAccrueInput): MonthlyAccrual[] {
  const { cfg } = input;
  if (!cfg.enabled || cfg.rate_pct <= 0) return [];
  if (input.outstandingPrincipal <= 0.004) return [];

  let from = interestStart(input.dueDate, cfg.grace_days);
  if (input.accruedThrough && diffDays(from, addDays(input.accruedThrough, 1)) > 0) {
    from = addDays(input.accruedThrough, 1);
  }
  const r = cfg.rate_pct / 100;
  let room =
    cfg.cap_pct != null && cfg.cap_pct >= 0
      ? round2((input.originalAmount * cfg.cap_pct) / 100 - input.postedInterest)
      : Infinity;
  let unpaid = Math.max(0, input.unpaidInterest);
  let existing = input.existingMonthAmount || 0;
  let carry = 0;
  let carryUnits = 0;
  const out: MonthlyAccrual[] = [];

  while (diffDays(from, input.asOf) >= 0) {
    const mEnd = monthEnd(from);
    const end = diffDays(mEnd, input.asOf) < 0 ? input.asOf : mEnd;
    const units = diffDays(from, end) + 1;
    const calc =
      cfg.method === "compound"
        ? (input.outstandingPrincipal + unpaid) * (Math.pow(1 + r, units) - 1)
        : input.outstandingPrincipal * r * units;
    const raw = round2(calc + carry);
    const amount = Math.min(raw, room);
    if (amount <= 0.004) break;
    if (existing + amount < cfg.min_amount) {
      if (end === input.asOf) break;
      carry = raw;
      carryUnits += units;
    } else {
      out.push({ period: monthStart(from), through: end, units: units + carryUnits, amount });
      room -= amount;
      unpaid += amount;
      carry = 0;
      carryUnits = 0;
    }
    existing = 0;
    from = addDays(end, 1);
  }
  return out;
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

// Concepto de un punitorio en el estado de cuenta. Con tasa diaria (movimiento
// mensual con accrued_through): "Punitorio de octubre 2026 (al 20/10)".
export function interestConcept(period: string | null, accruedThrough: string | null): string {
  if (!period || !accruedThrough) return "Punitorio";
  const [y, m] = period.split("-");
  const [, tm, td] = accruedThrough.split("-");
  return `Punitorio de ${MONTHS[Number(m) - 1]} ${y} (al ${td}/${tm})`;
}

// Calculadora de ejemplo (configuración): interés que generaría `principal` con
// `daysLate` días de atraso, aplicando gracia, tope y método.
export function interestExample(principal: number, daysLate: number, cfg: InterestConfig): number {
  const due = "2026-01-01";
  const asOf = addDays(due, Math.max(0, Math.trunc(daysLate)));
  if (cfg.period === "daily") {
    return round2(
      accrueDailyInterest({
        asOf,
        dueDate: due,
        originalAmount: principal,
        outstandingPrincipal: principal,
        unpaidInterest: 0,
        postedInterest: 0,
        accruedThrough: null,
        existingMonthAmount: 0,
        cfg: { ...cfg, enabled: true, min_amount: 0 },
      }).reduce((s, b) => s + b.amount, 0),
    );
  }
  const r = accrueInterest({
    asOf,
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
