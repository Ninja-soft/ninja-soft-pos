// =============================================================================
// KPIs de MRR y cobranza (F20-2 · H128 · ADR-126, spec docs/40 §15).
//
// Funciones puras sobre lo que devuelve internal_billing_kpis() (migración
// 20261122100000_cobranza_mrr_snapshots): snapshots de los cierres de mes,
// cobrado por mes, efectividad por mes de vencimiento y debe abierto. La base
// sólo junta los datos; las definiciones viven acá (una sola vez) y se testean
// en tests/unit/billingKpis.test.ts. Importes en centavos.
//
// Definiciones:
//   · Cuenta paga: active o past_due, sin exclusión y MRR > 0 (paying).
//   · Movimiento de MRR entre dos cierres:
//       nuevo        no era paga al inicio y nunca lo había sido;
//       reactivación no era paga al inicio pero lo fue antes;
//       expansión    paga en los dos cierres y sube;
//       contracción  paga en los dos cierres y baja;
//       churn        paga al inicio y no al cierre (cancelada, suspendida,
//                    excluida): MRR del inicio.
//     MRR al cierre = inicio + nuevo + expansión + reactivación − contracción − churn.
//   · Churn de clientes (logo): pagas al inicio que al cierre están canceladas
//     o suspendidas hace más de 30 días (sin pagar), sobre las pagas al inicio.
//   · NRR = (inicio + expansión − contracción − churn) / inicio y
//     GRR = (inicio − contracción − churn) / inicio, sobre la cohorte paga al
//     inicio (la reactivación no es de esa cohorte).
//   · Aging: debe abierto vencido por días de mora (1-30, 31-60, 61-90, +90).
//   · DSO = deuda abierta total / lo cargado en los últimos 90 días × 90.
//   · Efectividad: imputado con pagos hasta el cierre del mes a lo que vencía
//     en el mes, sobre lo que vencía menos lo anulado o bonificado.
// =============================================================================

export interface SnapshotRow {
  tenant_id: string;
  mrr_cents: number;
  paying: boolean;
  status: string | null;
  plan_key: string | null;
  last_paying_day: string | null;
}

export interface Boundary {
  day: string;
  live: boolean;
  /** false = no hay snapshot de ese día (antes del backfill). */
  available: boolean;
  rows: SnapshotRow[];
}

export interface CollectionMonth {
  month: string;
  payments: number;
  gross_cents: number;
  fee_cents: number;
  reversal_cents: number;
}

export interface EffectivenessMonth {
  month: string;
  due_cents: number;
  forgiven_cents: number;
  collected_cents: number;
}

export interface OpenDebit {
  tenant_id: string;
  due_date: string;
  open_cents: number;
}

export interface BillingKpisData {
  as_of: string;
  months: number;
  snapshots_since: string | null;
  excluded_count: number;
  boundaries: Boundary[];
  first_paying_day: Record<string, string>;
  collections: CollectionMonth[];
  effectiveness: EffectivenessMonth[];
  open_debits: OpenDebit[];
  billed_90d_cents: number;
}

const DAY_MS = 86_400_000;
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Días entre dos fechas YYYY-MM-DD (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Porcentaje con un decimal; null sin base. */
export function pct(num: number, den: number): number | null {
  if (!Number.isFinite(den) || den <= 0) return null;
  return Math.round((num / den) * 1000) / 10;
}

// ── MRR ─────────────────────────────────────────────────────────────────────

export interface MrrStock {
  mrr_cents: number;
  accounts: number;
  past_due_cents: number;
}

export function mrrStock(rows: SnapshotRow[]): MrrStock {
  let mrr = 0;
  let accounts = 0;
  let pastDue = 0;
  for (const r of rows) {
    if (!r.paying) continue;
    mrr += n(r.mrr_cents);
    accounts += 1;
    if (r.status === "past_due") pastDue += n(r.mrr_cents);
  }
  return { mrr_cents: mrr, accounts, past_due_cents: pastDue };
}

export interface MrrMovement {
  start_cents: number;
  end_cents: number;
  new_cents: number;
  expansion_cents: number;
  reactivation_cents: number;
  contraction_cents: number;
  churn_cents: number;
  net_cents: number;
  start_accounts: number;
  end_accounts: number;
  new_accounts: number;
  reactivated_accounts: number;
  /** Cuentas que dejaron de pagar (base del churn de MRR). */
  lost_accounts: number;
  /** Churn de clientes: canceladas o suspendidas hace más de 30 días. */
  churned_accounts: number;
}

/**
 * Movimiento de MRR entre dos cierres. `firstPaying` = primer día en que cada
 * negocio fue cuenta paga (para separar nuevo de reactivación).
 */
export function mrrMovement(
  start: Pick<Boundary, "day" | "rows">,
  end: Pick<Boundary, "day" | "rows">,
  firstPaying: Record<string, string>,
): MrrMovement {
  const s = new Map(start.rows.filter((r) => r.paying).map((r) => [r.tenant_id, r]));
  const e = new Map(end.rows.map((r) => [r.tenant_id, r]));
  const m: MrrMovement = {
    start_cents: 0,
    end_cents: 0,
    new_cents: 0,
    expansion_cents: 0,
    reactivation_cents: 0,
    contraction_cents: 0,
    churn_cents: 0,
    net_cents: 0,
    start_accounts: s.size,
    end_accounts: 0,
    new_accounts: 0,
    reactivated_accounts: 0,
    lost_accounts: 0,
    churned_accounts: 0,
  };
  for (const r of s.values()) m.start_cents += n(r.mrr_cents);

  for (const [id, a] of s) {
    const b = e.get(id);
    if (b?.paying) {
      const d = n(b.mrr_cents) - n(a.mrr_cents);
      if (d > 0) m.expansion_cents += d;
      else if (d < 0) m.contraction_cents -= d;
      continue;
    }
    m.churn_cents += n(a.mrr_cents);
    m.lost_accounts += 1;
    const status = b?.status ?? "cancelled";
    const lastPaid = b?.last_paying_day ?? start.day;
    if (!b || status === "cancelled" || (status === "suspended" && daysBetween(lastPaid, end.day) > 30)) {
      m.churned_accounts += 1;
    }
  }

  for (const [id, b] of e) {
    if (!b.paying) continue;
    m.end_cents += n(b.mrr_cents);
    m.end_accounts += 1;
    if (s.has(id)) continue;
    const first = firstPaying[id];
    if (first && first <= start.day) {
      m.reactivation_cents += n(b.mrr_cents);
      m.reactivated_accounts += 1;
    } else {
      m.new_cents += n(b.mrr_cents);
      m.new_accounts += 1;
    }
  }
  m.net_cents = m.new_cents + m.expansion_cents + m.reactivation_cents - m.contraction_cents - m.churn_cents;
  return m;
}

export interface Retention {
  /** Retención neta de la cohorte paga al inicio (%). */
  nrr: number | null;
  /** Retención bruta (%): sin expansión. */
  grr: number | null;
  /** Churn de ingresos bruto (%): (churn + contracción) / inicio. */
  grossRevenueChurn: number | null;
  /** Churn de clientes (%), con "x de y". */
  logoChurn: number | null;
  churned: number;
  base: number;
}

export function retention(m: MrrMovement): Retention {
  const base = m.start_cents;
  return {
    nrr: pct(base + m.expansion_cents - m.contraction_cents - m.churn_cents, base),
    grr: pct(base - m.contraction_cents - m.churn_cents, base),
    grossRevenueChurn: pct(m.churn_cents + m.contraction_cents, base),
    logoChurn: m.start_accounts >= 5 ? pct(m.churned_accounts, m.start_accounts) : null,
    churned: m.churned_accounts,
    base: m.start_accounts,
  };
}

export interface MonthMovement {
  /** YYYY-MM del mes que cierra en `end`. */
  month: string;
  start: string;
  end: string;
  live: boolean;
  /** null = falta el snapshot de alguno de los dos cierres. */
  movement: MrrMovement | null;
  end_mrr_cents: number | null;
}

/** Movimiento de cada mes (pares de cierres consecutivos). */
export function monthlyMovements(boundaries: Boundary[], firstPaying: Record<string, string>): MonthMovement[] {
  const sorted = [...boundaries].sort((a, b) => a.day.localeCompare(b.day));
  const out: MonthMovement[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const ok = a.available && b.available;
    out.push({
      month: b.day.slice(0, 7),
      start: a.day,
      end: b.day,
      live: b.live,
      movement: ok ? mrrMovement(a, b, firstPaying) : null,
      end_mrr_cents: b.available ? mrrStock(b.rows).mrr_cents : null,
    });
  }
  return out;
}

/** Movimiento de toda la ventana: el primer cierre disponible contra el último. */
export function windowMovement(boundaries: Boundary[], firstPaying: Record<string, string>): MrrMovement | null {
  const sorted = [...boundaries].filter((b) => b.available).sort((a, b) => a.day.localeCompare(b.day));
  if (sorted.length < 2) return null;
  return mrrMovement(sorted[0]!, sorted[sorted.length - 1]!, firstPaying);
}

// ── Cobranza ────────────────────────────────────────────────────────────────

export interface Collected {
  gross_cents: number;
  fee_cents: number;
  reversal_cents: number;
  /** Bruto menos reversas (reintegros y contracargos). */
  collected_cents: number;
  /** Cobrado menos comisiones. */
  net_cents: number;
}

export function collected(row: CollectionMonth | null | undefined): Collected {
  const gross = n(row?.gross_cents);
  const fee = n(row?.fee_cents);
  const rev = n(row?.reversal_cents);
  return {
    gross_cents: gross,
    fee_cents: fee,
    reversal_cents: rev,
    collected_cents: gross - rev,
    net_cents: gross - rev - fee,
  };
}

export interface Aging {
  not_due_cents: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  overdue_cents: number;
  total_cents: number;
  tenants_overdue: number;
}

/** Aging del debe abierto a `today` (YYYY-MM-DD). */
export function agingBuckets(debits: OpenDebit[], today: string): Aging {
  const a: Aging = {
    not_due_cents: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
    overdue_cents: 0,
    total_cents: 0,
    tenants_overdue: 0,
  };
  const late = new Set<string>();
  for (const d of debits) {
    const v = n(d.open_cents);
    if (v <= 0) continue;
    a.total_cents += v;
    const days = daysBetween(d.due_date, today);
    if (days <= 0) {
      a.not_due_cents += v;
      continue;
    }
    a.overdue_cents += v;
    late.add(d.tenant_id);
    if (days <= 30) a.d1_30 += v;
    else if (days <= 60) a.d31_60 += v;
    else if (days <= 90) a.d61_90 += v;
    else a.d90_plus += v;
  }
  a.tenants_overdue = late.size;
  return a;
}

/** Días de venta en la calle; null si no se cargó nada en 90 días. */
export function dso(totalDebtCents: number, billed90dCents: number): number | null {
  if (!Number.isFinite(billed90dCents) || billed90dCents <= 0) return null;
  return Math.round((Math.max(0, totalDebtCents) / billed90dCents) * 90 * 10) / 10;
}

export interface Effectiveness {
  base_cents: number;
  collected_cents: number;
  pct: number | null;
}

export function collectionEffectiveness(row: EffectivenessMonth | null | undefined): Effectiveness {
  const base = Math.max(0, n(row?.due_cents) - n(row?.forgiven_cents));
  const got = Math.min(base, n(row?.collected_cents));
  return { base_cents: base, collected_cents: got, pct: pct(got, base) };
}

// ── Formato ─────────────────────────────────────────────────────────────────

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-10" → "oct 26". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${String(y).slice(2)}`;
}

export const BILLING_KPI_DEFINITIONS = {
  mrr: "Suma del monto recurrente mensual de las cuentas pagas (activas o con pago vencido, MRR mayor a 0): plan normalizado a mes, addons comprados y descuentos vigentes, IVA incluido. Sin trials, suspendidas, canceladas, lifetime, exentas, de prueba ni negocios del staff. Hoy se calcula en vivo; los meses anteriores salen de la foto diaria.",
  arr: "MRR × 12. Es un run-rate, no lo facturado en el año.",
  accounts: "Cuentas pagas hoy y su ingreso promedio (ARPA = MRR / cuentas pagas).",
  mrrAtRisk: "MRR de las cuentas pagas que hoy tienen el pago vencido.",
  nrr: "Retención neta de la cohorte paga al inicio de la ventana: (MRR al inicio + expansión − contracción − churn) / MRR al inicio. Más de 100 % = la base crece sola.",
  grr: "Retención bruta: (MRR al inicio − contracción − churn) / MRR al inicio. Nunca pasa de 100 %.",
  movement: "Nuevo: cuentas que nunca habían pagado. Reactivación: volvieron a pagar. Expansión y contracción: cambios de monto de cuentas pagas en los dos cierres. Churn: MRR de las que dejaron de pagar (canceladas, suspendidas o excluidas). La línea es el MRR al cierre de cada mes.",
  logoChurn: "Cuentas pagas al inicio de la ventana que al cierre están canceladas o suspendidas hace más de 30 días, sobre las pagas al inicio. Con menos de 5 se muestra n/d.",
  collected: "Pagos aprobados del mes por fecha de pago, menos reintegros y contracargos del mes. Neto: además, sin las comisiones de Mercado Pago.",
  overdue: "Lo que quedó sin pagar de los cargos, punitorios y ajustes cuyo vencimiento ya pasó, por días de mora.",
  dso: "Deuda abierta total (vencida y a vencer) dividida lo cargado en los últimos 90 días, por 90. Son los días de venta que hay en la calle.",
  effectiveness: "Lo imputado con pagos hasta el cierre del mes a los cargos que vencían en el mes, sobre esos cargos menos lo anulado o bonificado. En el mes actual, sólo lo que ya venció.",
} as const;
