// =============================================================================
// Prorrateo de la cobranza de la plataforma (F20-10 · H136 · ADR-131, spec
// docs/40-cobranza-saas.md §17.4 y §22 #12).
//
// Espejo EXACTO de las funciones SQL de 20261126100000_cobranza_360:
//   · prorateCents     → platform_prorate_cents (el único cálculo)
//   · prorationQuote   → platform_proration_core (sin las líneas de un período
//                        nuevo, que la base arma con el desglose del negocio)
// La prueba de PGlite compara casos al azar SQL = TS.
//
// Reglas (§17.4):
//   · Upgrade inmediato: débito por los días que quedan del plan nuevo menos
//     crédito por esos días del plan viejo, en un cargo que vence con el
//     próximo cobro.
//   · Downgrade: al fin del período, sin crédito. Inmediato (sólo el staff):
//     lo no usado queda como bonificación (tope del nivel).
//   · Cambio de ciclo: mensual → anual rige ya, el período nuevo empieza hoy y
//     lo no usado del mensual baja el cargo anual; anual → mensual, al fin del
//     período (inmediato: lo no usado del anual queda a favor).
//   · Sólo se acredita lo que se cargó: si el cargo del período vigente
//     todavía no se generó, va a salir con el plan nuevo y no hay prorrateo.
//   · Días calendario de Argentina; centavos enteros; mitad para arriba.
// =============================================================================

export type ProrationKind = "upgrade" | "downgrade" | "lateral" | "cycle_up" | "cycle_down";
export type ProrationTiming = "immediate" | "period_end";
export type ProrationEffect = "charge" | "credit" | "charge_and_credit" | "scheduled" | "none";
export type BillingCycle = "monthly" | "yearly";

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);

/** Días entre dos fechas YYYY-MM-DD (b − a). */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** Suma meses calendario a una fecha YYYY-MM-DD (como `date + interval 'N months'` de Postgres). */
export function addMonthsYmd(ymd: string, months: number): string {
  const [y = 1970, m = 1, d = 1] = ymd.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/**
 * cents × (10000 − descuento en bp) × días que quedan / (días × 10000),
 * redondeado al centavo, mitad para arriba. 0 si no hay nada que prorratear.
 * Con BigInt para no perder precisión (importes de hasta 10^10 centavos).
 */
export function prorateCents(cents: number, pctBp: number, left: number, days: number): number {
  if (!(cents > 0) || !(left > 0) || !(days > 0)) return 0;
  const bp = BigInt(Math.min(10000, Math.max(0, Math.round(pctBp || 0))));
  const l = BigInt(Math.min(left, days));
  const d = BigInt(days);
  const num = 2n * BigInt(Math.round(cents)) * (10000n - bp) * l + d * 10000n;
  const den = 2n * d * 10000n;
  return Number(num / den);
}

/** Descuento porcentual (0 a 100, con decimales) a puntos básicos, como platform_percent_off_bp. */
export function percentToBp(percent: number): number {
  return Math.min(10000, Math.round((Number(percent) || 0) * 100));
}

export interface ProrationQuoteInput {
  fromCycle: BillingCycle;
  toCycle: BillingCycle;
  /** Precio del ciclo (centavos) del plan viejo en su ciclo y del nuevo en el suyo. */
  fromCycleCents: number;
  toCycleCents: number;
  /** Período vigente [start, end) y hoy, YYYY-MM-DD (hora Argentina). */
  periodStart: string;
  periodEnd: string;
  today: string;
  percentBp: number;
  /** El período vigente tiene cargo (o es anterior al estado de cuenta). */
  charged: boolean;
  timing?: "auto" | ProrationTiming;
  /** Cambio de ciclo: subtotal del cargo del período nuevo (plan, addons y descuento del ciclo nuevo). */
  newPeriodSubtotalCents?: number;
}

export interface ProrationQuote {
  kind: ProrationKind;
  timing: ProrationTiming;
  effect: ProrationEffect;
  days: number;
  daysLeft: number;
  debitCents: number;
  creditCents: number;
  /** Lo que se carga (cargo de prorrateo o del período nuevo). */
  chargeCents: number;
  /** Lo que queda a favor como bonificación. */
  bonusCents: number;
  /** Crédito aplicado como línea del cargo del período nuevo (cambio a anual). */
  appliedCreditCents: number;
  newPeriod: { start: string; end: string } | null;
  effectiveOn: string;
}

export function prorationKind(i: Pick<ProrationQuoteInput, "fromCycle" | "toCycle" | "fromCycleCents" | "toCycleCents">): ProrationKind {
  if (i.fromCycle !== i.toCycle) return i.toCycle === "yearly" ? "cycle_up" : "cycle_down";
  if (i.toCycleCents > i.fromCycleCents) return "upgrade";
  if (i.toCycleCents < i.fromCycleCents) return "downgrade";
  return "lateral";
}

/** Misma decisión que platform_proration_core. */
export function prorationQuote(i: ProrationQuoteInput): ProrationQuote {
  const kind = prorationKind(i);
  let timing: ProrationTiming =
    i.timing === "immediate" || i.timing === "period_end"
      ? i.timing
      : kind === "upgrade" || kind === "cycle_up" || kind === "lateral"
        ? "immediate"
        : "period_end";
  if (kind === "lateral") timing = "immediate";
  const days = daysBetween(i.periodStart, i.periodEnd);
  const left = Math.min(days, daysBetween(i.today, i.periodEnd));
  const base: ProrationQuote = {
    kind,
    timing,
    effect: "none",
    days: Math.max(days, 0),
    daysLeft: Math.max(left, 0),
    debitCents: 0,
    creditCents: 0,
    chargeCents: 0,
    bonusCents: 0,
    appliedCreditCents: 0,
    newPeriod: null,
    effectiveOn: timing === "period_end" ? i.periodEnd : i.today,
  };
  const running = days > 0 && left > 0;

  if (timing === "period_end") return { ...base, effect: "scheduled" };

  if (kind === "upgrade") {
    if (!i.charged || !running) return base;
    const debit = prorateCents(i.toCycleCents, i.percentBp, left, days);
    const credit = prorateCents(i.fromCycleCents, i.percentBp, left, days);
    if (debit - credit <= 0) return { ...base, debitCents: debit, creditCents: credit };
    return { ...base, effect: "charge", debitCents: debit, creditCents: credit, chargeCents: debit - credit };
  }

  if (kind === "downgrade") {
    if (!i.charged || !running) return base;
    const credit = prorateCents(i.fromCycleCents, i.percentBp, left, days);
    const debit = prorateCents(i.toCycleCents, i.percentBp, left, days);
    const bonus = Math.max(credit - debit, 0);
    return { ...base, effect: bonus > 0 ? "credit" : "none", debitCents: debit, creditCents: credit, bonusCents: bonus };
  }

  if (kind === "cycle_up" || kind === "cycle_down") {
    const end = addMonthsYmd(i.today, i.toCycle === "yearly" ? 12 : 1);
    const subtotal = Math.round(i.newPeriodSubtotalCents ?? i.toCycleCents);
    const credit = i.charged && running ? prorateCents(i.fromCycleCents, i.percentBp, left, days) : 0;
    let applied = 0;
    let bonus = 0;
    if (kind === "cycle_up") {
      applied = Math.min(credit, Math.max(subtotal, 0));
      bonus = credit - applied;
    } else {
      bonus = credit;
    }
    return {
      ...base,
      effect: bonus > 0 ? "charge_and_credit" : "charge",
      creditCents: credit,
      appliedCreditCents: applied,
      chargeCents: Math.max(subtotal - applied, 0),
      bonusCents: bonus,
      newPeriod: { start: i.today, end },
    };
  }

  return base;
}

export const PRORATION_KIND_LABELS: Record<ProrationKind, string> = {
  upgrade: "Sube de plan",
  downgrade: "Baja de plan",
  lateral: "Sin diferencia de precio",
  cycle_up: "Pasa a anual",
  cycle_down: "Pasa a mensual",
};

export const PRORATION_EFFECT_LABELS: Record<ProrationEffect, string> = {
  charge: "Genera un cargo",
  credit: "Deja saldo a favor",
  charge_and_credit: "Genera un cargo y deja saldo a favor",
  scheduled: "Queda programado",
  none: "Sin movimientos de plata",
};
