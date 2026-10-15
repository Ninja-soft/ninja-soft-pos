// =============================================================================
// Punitorios de la cobranza de la plataforma (F20-9 · H135, spec docs/40
// §10.3 y §22 #4; ADR-128).
//
// Función pura, espejo EXACTO de platform_interest_schedule() de la migración
// 20261124100000_cobranza_mora_punitorios. La usa el simulador del panel
// interno y la prueba de PGlite compara las dos implementaciones caso por
// caso: el punitorio que muestra el simulador es el que devenga el cron.
//
// Reglas:
//   · Días de mora = hoy − (vencimiento efectivo + días de gracia). El
//     vencimiento efectivo es el próximo día hábil si el original cae en fin de
//     semana o feriado (lib/billing/mora.ts → nextBusinessDay).
//   · Capital de un día = importe original del cargo − lo imputado con fecha
//     hasta ese día (un pago parcial baja el interés de los días que siguen).
//   · daily_prorata: por mes calendario, Σ capital del día × tasa / 30,
//     redondeado al centavo (mitad para arriba) una vez por mes.
//   · per_month_started: bloques de 30 días desde el primer día de mora; cada
//     bloque empezado cobra el mes entero sobre el capital de su primer día.
//   · Interés simple (nunca sobre punitorios), con tope sobre el capital
//     original (cap_bp) y mínimo por mes: debajo del mínimo el mes no se
//     liquida y el importe pasa al siguiente.
//   · Pausas [desde, hasta): esos días no devengan (suspender el devengamiento
//     de un negocio corta sólo hacia adelante).
// Importes en centavos enteros; las sumas usan BigInt para no perder
// precisión.
// =============================================================================

export type InterestMethod = "daily_prorata" | "per_month_started";
export type InterestBillMode = "on_collection" | "monthly";

export interface InterestPolicy {
  /** Tasa mensual en puntos básicos: 300 = 3 %. */
  monthlyRateBp: number;
  /** Días desde el vencimiento antes de devengar. */
  graceDays: number;
  method: InterestMethod;
  /** Tope total sobre el capital original en puntos básicos (5000 = 50 %). null = sin tope. */
  capBp: number | null;
  /** Debajo de este monto el mes no se liquida y pasa al siguiente. */
  minAmountCents: number;
}

export interface CapitalReduction {
  /** YYYY-MM-DD: desde ese día el capital ya está reducido. */
  date: string;
  cents: number;
}

/** Rango de días [from, to). to null = abierto. */
export interface DateRange {
  from: string;
  to: string | null;
}

export interface InterestInput {
  policy: InterestPolicy;
  /** Vencimiento efectivo (ya corrido al próximo día hábil). */
  dueDate: string;
  originalCents: number;
  reductions?: CapitalReduction[];
  /** Último día que devenga (incluido). */
  asOf: string;
  /** Primer día que puede devengar (p. ej., cuando se prendieron los punitorios). */
  accrueFrom?: string | null;
  pauses?: DateRange[];
}

export interface InterestMonth {
  /** YYYY-MM */
  month: string;
  /** Devengado del mes, con el tope aplicado. */
  accruedCents: number;
  /** Lo que se liquida en el mes (con lo arrastrado por el mínimo). */
  liquidatedCents: number;
}

export interface InterestResult {
  daysOverdue: number;
  accruedCents: number;
  liquidatedCents: number;
  /** Devengado que todavía no llega al mínimo. */
  pendingCents: number;
  capCents: number | null;
  capReached: boolean;
  months: InterestMonth[];
}

const DAY = 86_400_000;

/** Día como entero (días desde 1970-01-01, UTC). */
export function dayNum(ymd: string): number {
  return Math.round(Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`) / DAY);
}

/** Entero de día a YYYY-MM-DD. */
export function dayStr(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

/** YYYY-MM-DD + n días. */
export function addDays(ymd: string, n: number): string {
  return dayStr(dayNum(ymd) + n);
}

/** División entera redondeando la mitad para arriba (n ≥ 0, d > 0). */
function roundHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

function paused(day: number, pauses: { from: number; to: number | null }[]): boolean {
  return pauses.some((p) => day >= p.from && (p.to === null || day < p.to));
}

/**
 * Punitorio de una deuda hasta `asOf` según la política. Devuelve el detalle
 * por mes (devengado y liquidado) y los totales.
 */
export function interestSchedule(input: InterestInput): InterestResult {
  const { policy } = input;
  const bp = BigInt(Math.max(0, int(policy.monthlyRateBp)));
  const grace = Math.max(0, int(policy.graceDays));
  const original = Math.max(0, int(input.originalCents));
  const due = dayNum(input.dueDate);
  const asOf = dayNum(input.asOf);
  const moraStart = due + grace + 1;
  const start = Math.max(moraStart, input.accrueFrom ? dayNum(input.accrueFrom) : moraStart);
  const daysOverdue = Math.max(0, asOf - (due + grace));
  const capCents = policy.capBp === null || policy.capBp === undefined ? null : Math.floor((original * Math.max(0, int(policy.capBp))) / 10000);

  const reductions = (input.reductions ?? [])
    .map((r) => ({ day: dayNum(r.date), cents: Math.max(0, int(r.cents)) }))
    .sort((a, b) => a.day - b.day);
  const ps = (input.pauses ?? []).map((p) => ({ from: dayNum(p.from), to: p.to ? dayNum(p.to) : null }));
  const capital = (day: number): bigint => {
    let c = original;
    for (const r of reductions) if (r.day <= day) c -= r.cents;
    return BigInt(Math.max(0, c));
  };

  // Devengado crudo por mes (YYYY-MM → centavos).
  const raw = new Map<string, bigint>();
  if (original > 0 && bp > 0n && start <= asOf) {
    if (policy.method === "per_month_started") {
      for (let b = moraStart; b <= asOf; b += 30) {
        if (b < start || paused(b, ps)) continue;
        const m = dayStr(b).slice(0, 7);
        raw.set(m, (raw.get(m) ?? 0n) + roundHalfUp(capital(b) * bp, 10000n));
      }
    } else {
      const sums = new Map<string, bigint>();
      for (let d = start; d <= asOf; d++) {
        if (paused(d, ps)) continue;
        const m = dayStr(d).slice(0, 7);
        sums.set(m, (sums.get(m) ?? 0n) + capital(d));
      }
      for (const [m, s] of sums) raw.set(m, roundHalfUp(s * bp, 300000n));
    }
  }

  const months: InterestMonth[] = [];
  let accrued = 0;
  let liquidated = 0;
  let pending = 0;
  let rawTotal = 0;
  const minAmount = Math.max(0, int(policy.minAmountCents));
  for (const m of [...raw.keys()].sort()) {
    let a = Number(raw.get(m) ?? 0n);
    rawTotal += a;
    if (capCents !== null) a = Math.min(a, Math.max(0, capCents - accrued));
    accrued += a;
    pending += a;
    let liq = 0;
    if (pending > 0 && pending >= minAmount) {
      liq = pending;
      pending = 0;
    }
    liquidated += liq;
    months.push({ month: m, accruedCents: a, liquidatedCents: liq });
  }
  const capReached = capCents !== null && rawTotal > 0 && rawTotal >= capCents;

  return { daysOverdue, accruedCents: accrued, liquidatedCents: liquidated, pendingCents: pending, capCents, capReached, months };
}

export interface SimulationInput {
  policy: InterestPolicy;
  capitalCents: number;
  /** Vencimiento original. */
  dueDate: string;
  asOf: string;
  holidays?: Iterable<string>;
  /** Corre el vencimiento al próximo día hábil (como el cron). Default true. */
  shiftToBusinessDay?: boolean;
}

export interface SimulationResult extends InterestResult {
  effectiveDue: string;
  shifted: boolean;
}

/** Simulador del panel interno: misma cuenta que el cron sobre una deuda sin pagos. */
export function simulateInterest(input: SimulationInput): SimulationResult {
  const holidays = new Set(input.holidays ?? []);
  const shift = input.shiftToBusinessDay !== false;
  const effectiveDue = shift ? nextBusinessDayLocal(input.dueDate, holidays) : input.dueDate;
  const r = interestSchedule({
    policy: input.policy,
    dueDate: effectiveDue,
    originalCents: input.capitalCents,
    asOf: input.asOf,
  });
  return { ...r, effectiveDue, shifted: effectiveDue !== input.dueDate };
}

// Copia local de mora.ts → nextBusinessDay para no crear un ciclo de imports.
function nextBusinessDayLocal(ymd: string, holidays: Set<string>): string {
  let d = ymd.slice(0, 10);
  for (let i = 0; i < 60; i++) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidays.has(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

// ── Textos ──────────────────────────────────────────────────────────────────

export const INTEREST_METHOD_LABELS: Record<InterestMethod, string> = {
  daily_prorata: "Diario (tasa mensual / 30 por día)",
  per_month_started: "Por mes empezado (mes empezado = mes entero)",
};

export const INTEREST_BILL_MODE_LABELS: Record<InterestBillMode, string> = {
  on_collection: "Nota de débito al cobrarlo",
  monthly: "Nota de débito al cierre del mes",
};

/** "3 %" o "2,5 %" desde puntos básicos. */
export function formatBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return "Sin tope";
  return `${(int(bp) / 100).toLocaleString("es-AR", { maximumFractionDigits: 2 })} %`;
}

/** "3" o "2,5" (porcentaje escrito por una persona) a puntos básicos. null si no es válido. */
export function parsePercentToBp(text: string): number | null {
  const raw = String(text ?? "").trim().replace("%", "").replace(",", ".");
  if (!raw) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}
