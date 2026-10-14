// =============================================================================
// KPIs del SaaS para el dashboard interno (F20-0a · H125, spec docs/40 §15).
//
// Funciones puras sobre los datos de hoy (subscriptions, plans, addons,
// descuentos, billing_records y la auditoría de cambios de estado que trae
// internal_saas_kpi_events). Sin Supabase: se testean en
// tests/unit/saasKpis.test.ts. La versión con snapshots llega en F20-2.
//
// Definiciones (resumen; el texto completo vive en KPI_DEFINITIONS):
//   · Cuenta paga: suscripción active o past_due, no excluida y con MRR > 0.
//   · Excluidas: lifetime (exentas), negocios de prueba (isTest, cuando exista
//     la marca tenants.is_test) y negocios dados de baja (deleted_at).
//   · MRR: plan del ciclo normalizado a mes (anual / 12; si el anual vale 0,
//     el mensual) + addons comprados vigentes − descuentos vigentes.
// =============================================================================

export type SubStatus = "trial" | "active" | "past_due" | "suspended" | "cancelled" | string;

export interface KpiPlan {
  monthly_price_ars: number | null;
  yearly_price_ars: number | null;
}

export interface KpiAddon {
  status: string;
  source: string;
  monthly_price_ars: number | null;
  catalog_price_ars?: number | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: string | null;
}

export interface KpiDiscount {
  kind: "percent" | "fixed" | string;
  value: number;
  valid_from: string | null;
  valid_until: string | null;
  deleted_at?: string | null;
}

export interface KpiAccount {
  tenantId: string;
  name: string;
  createdAt: string;
  deletedAt?: string | null;
  /** Marca de negocio interno o de prueba. Pendiente: tenants.is_test (spec §15.1). */
  isTest?: boolean;
  trialEndsAt: string | null;
  status: SubStatus | null;
  billingCycle: string | null;
  isLifetime: boolean;
  plan: KpiPlan | null;
  planKey?: string | null;
  planName?: string | null;
  addons: KpiAddon[];
  discounts: KpiDiscount[];
}

export interface StatusChange {
  tenant_id: string;
  at: string;
  from: string | null;
  to: string | null;
}

export interface PaymentRow {
  tenant_id: string;
  amount: number;
  at: string;
}

export interface Period {
  start: Date;
  end: Date;
}

export type PeriodKey = "mes" | "anterior" | "12m";

const DAY = 86_400_000;
const PAID = new Set(["active", "past_due"]);
export const SMALL_SAMPLE = 5;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

// ── Períodos ────────────────────────────────────────────────────────────────

/** Período pedido y el anterior de igual largo (para la tendencia). */
export function periodsFor(key: PeriodKey, now: Date = new Date()): { current: Period; previous: Period } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (key === "anterior") {
    const current = { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
    return { current, previous: { start: new Date(Date.UTC(y, m - 2, 1)), end: current.start } };
  }
  if (key === "12m") {
    const current = { start: new Date(Date.UTC(y - 1, m, now.getUTCDate())), end: now };
    return { current, previous: { start: new Date(Date.UTC(y - 2, m, now.getUTCDate())), end: current.start } };
  }
  // Mes actual hasta hoy, contra el mes anterior completo.
  const current = { start: new Date(Date.UTC(y, m, 1)), end: now };
  return { current, previous: { start: new Date(Date.UTC(y, m - 1, 1)), end: current.start } };
}

export function parsePeriodKey(v: string | string[] | undefined): PeriodKey {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "anterior" || s === "12m" ? s : "mes";
}

// ── Exclusiones y MRR ───────────────────────────────────────────────────────

export type ExclusionReason = "lifetime" | "test" | "deleted";

export function exclusionReason(a: KpiAccount): ExclusionReason | null {
  if (a.deletedAt) return "deleted";
  if (a.isTest) return "test";
  if (a.isLifetime) return "lifetime";
  return null;
}

/** Precio mensual normalizado del plan según el ciclo. */
export function planMonthly(plan: KpiPlan | null, cycle: string | null): number {
  if (!plan) return 0;
  const monthly = num(plan.monthly_price_ars);
  if (cycle === "yearly") {
    const yearly = num(plan.yearly_price_ars);
    return yearly > 0 ? yearly / 12 : monthly;
  }
  return monthly;
}

/** Addons comprados que se facturan: activos o cancelados dentro de su ventana paga. */
export function addonsMonthly(addons: KpiAddon[], at: Date = new Date()): number {
  const today = dateOnly(at);
  return addons.reduce((acc, a) => {
    if (a.source === "granted") return acc;
    const billable =
      a.status === "active" ||
      (Boolean(a.cancel_at_period_end) && Boolean(a.current_period_end) && String(a.current_period_end) >= today);
    if (!billable) return acc;
    return acc + num(a.monthly_price_ars ?? a.catalog_price_ars ?? 0);
  }, 0);
}

export function isDiscountActive(d: KpiDiscount, at: Date = new Date()): boolean {
  if (d.deleted_at) return false;
  const today = dateOnly(at);
  if (d.valid_from && d.valid_from > today) return false;
  if (d.valid_until && d.valid_until < today) return false;
  return num(d.value) > 0;
}

/**
 * Monto recurrente mensual de una cuenta: plan + addons − descuentos vigentes.
 * Los porcentajes se aplican primero sobre el bruto y después los fijos
 * (mensuales). Nunca negativo.
 */
export function accountMrr(a: KpiAccount, at: Date = new Date()): number {
  const gross = planMonthly(a.plan, a.billingCycle) + addonsMonthly(a.addons, at);
  const active = a.discounts.filter((d) => isDiscountActive(d, at));
  const pct = active.filter((d) => d.kind === "percent").reduce((s, d) => s + num(d.value), 0);
  const fixed = active.filter((d) => d.kind === "fixed").reduce((s, d) => s + num(d.value), 0);
  const net = gross * (1 - Math.min(100, pct) / 100) - fixed;
  return Math.max(0, Math.round(net * 100) / 100);
}

export function isPaidStatus(s: string | null | undefined): boolean {
  return PAID.has(String(s ?? ""));
}

export function isPaidAccount(a: KpiAccount, at: Date = new Date()): boolean {
  return isPaidStatus(a.status) && exclusionReason(a) === null && accountMrr(a, at) > 0;
}

// ── Estado en una fecha (reconstruido desde la auditoría) ───────────────────

/**
 * Estado de la suscripción en `at`: el `from` del primer cambio posterior a
 * `at`; si no hubo cambios después, el estado actual. null si el negocio
 * todavía no existía.
 */
export function statusAt(
  a: Pick<KpiAccount, "tenantId" | "status" | "createdAt">,
  changes: StatusChange[],
  at: Date,
): string | null {
  if (new Date(a.createdAt).getTime() > at.getTime()) return null;
  const t = at.getTime();
  const after = changes
    .filter((c) => c.tenant_id === a.tenantId && new Date(c.at).getTime() > t)
    .sort((x, y) => x.at.localeCompare(y.at));
  return after.length > 0 ? after[0]!.from : (a.status ?? null);
}

/** Desde cuándo está la suscripción en su estado de `at` (último cambio ≤ at). */
function lastChangeBefore(tenantId: string, changes: StatusChange[], at: Date): StatusChange | null {
  const t = at.getTime();
  const prev = changes
    .filter((c) => c.tenant_id === tenantId && new Date(c.at).getTime() <= t)
    .sort((x, y) => y.at.localeCompare(x.at));
  return prev[0] ?? null;
}

// ── Resultados ──────────────────────────────────────────────────────────────

export interface Ratio {
  num: number;
  den: number;
  /** null si el denominador es chico (< 5) o 0: se muestra "n/d (muestra chica)". */
  pct: number | null;
}

export function ratio(n: number, d: number): Ratio {
  return { num: n, den: d, pct: d >= SMALL_SAMPLE ? Math.round((n / d) * 1000) / 10 : null };
}

export interface MrrSummary {
  mrr: number;
  arr: number;
  paidAccounts: number;
  arpa: number | null;
  /** MRR de cuentas pagas con riesgo de cobro (past_due o débito rechazado). */
  mrrAtRisk: number;
  byPlan: { key: string; name: string; accounts: number; mrr: number }[];
}

export function mrrSummary(
  accounts: KpiAccount[],
  rejectedDebitTenants: Set<string> = new Set(),
  at: Date = new Date(),
): MrrSummary {
  let mrr = 0;
  let paid = 0;
  let atRisk = 0;
  const plans = new Map<string, { key: string; name: string; accounts: number; mrr: number }>();
  for (const a of accounts) {
    if (!isPaidAccount(a, at)) continue;
    const v = accountMrr(a, at);
    mrr += v;
    paid += 1;
    if (a.status === "past_due" || rejectedDebitTenants.has(a.tenantId)) atRisk += v;
    const key = a.planKey ?? "sin_plan";
    const row = plans.get(key) ?? { key, name: a.planName ?? key, accounts: 0, mrr: 0 };
    row.accounts += 1;
    row.mrr += v;
    plans.set(key, row);
  }
  return {
    mrr,
    arr: mrr * 12,
    paidAccounts: paid,
    arpa: paid > 0 ? mrr / paid : null,
    mrrAtRisk: atRisk,
    byPlan: Array.from(plans.values()).sort((x, y) => y.mrr - x.mrr),
  };
}

/** MRR al cierre de `at`, con el estado reconstruido y los precios de hoy. */
export function stockAt(
  accounts: KpiAccount[],
  changes: StatusChange[],
  at: Date,
): { mrr: number; paidAccounts: number } {
  let mrr = 0;
  let paid = 0;
  for (const a of accounts) {
    if (exclusionReason(a)) continue;
    if (!isPaidStatus(statusAt(a, changes, at))) continue;
    const v = accountMrr(a, at);
    if (v <= 0) continue;
    mrr += v;
    paid += 1;
  }
  return { mrr, paidAccounts: paid };
}

export function mrrAt(accounts: KpiAccount[], changes: StatusChange[], at: Date): number {
  return stockAt(accounts, changes, at).mrr;
}

/**
 * Churn de clientes del período: cuentas pagas al inicio que al cierre están
 * canceladas, o suspendidas hace más de 30 días, sobre las pagas al inicio.
 */
export function logoChurn(accounts: KpiAccount[], changes: StatusChange[], p: Period): Ratio & { tenants: string[] } {
  let base = 0;
  const churned: string[] = [];
  for (const a of accounts) {
    if (exclusionReason(a)) continue;
    if (accountMrr(a, p.start) <= 0) continue;
    if (!isPaidStatus(statusAt(a, changes, p.start))) continue;
    base += 1;
    const end = statusAt(a, changes, p.end);
    if (end === "cancelled") churned.push(a.tenantId);
    else if (end === "suspended") {
      const since = lastChangeBefore(a.tenantId, changes, p.end);
      if (since && p.end.getTime() - new Date(since.at).getTime() > 30 * DAY) churned.push(a.tenantId);
    }
  }
  return { ...ratio(churned.length, base), tenants: churned };
}

/**
 * Conversión trial → pago por cohorte: trials cuyo fin cayó en el período y
 * que recibieron su primer pago antes de trial_ends_at + 7 días.
 */
export function trialConversion(accounts: KpiAccount[], payments: PaymentRow[], p: Period): Ratio {
  let den = 0;
  let n = 0;
  const firstPay = new Map<string, number>();
  for (const pay of payments) {
    if (num(pay.amount) <= 0) continue;
    const t = new Date(pay.at).getTime();
    const cur = firstPay.get(pay.tenant_id);
    if (cur === undefined || t < cur) firstPay.set(pay.tenant_id, t);
  }
  for (const a of accounts) {
    if (exclusionReason(a) || !a.trialEndsAt) continue;
    const end = new Date(a.trialEndsAt).getTime();
    if (end < p.start.getTime() || end >= p.end.getTime()) continue;
    den += 1;
    const fp = firstPay.get(a.tenantId);
    if (fp !== undefined && fp <= end + 7 * DAY) n += 1;
  }
  return ratio(n, den);
}

export function trialsSummary(accounts: KpiAccount[], now: Date = new Date()): { active: number; endingIn7d: number } {
  let active = 0;
  let ending = 0;
  for (const a of accounts) {
    if (exclusionReason(a) || a.status !== "trial") continue;
    active += 1;
    if (a.trialEndsAt) {
      const left = new Date(a.trialEndsAt).getTime() - now.getTime();
      if (left >= 0 && left <= 7 * DAY) ending += 1;
    }
  }
  return { active, endingIn7d: ending };
}

/** Negocios creados en el período (sin los de prueba ni los borrados). */
export function newTenants(accounts: KpiAccount[], p: Period): number {
  return accounts.filter((a) => {
    if (a.deletedAt || a.isTest) return false;
    const t = new Date(a.createdAt).getTime();
    return t >= p.start.getTime() && t < p.end.getTime();
  }).length;
}

/** Cobrado (bruto) en el período según billing_records. */
export function collected(payments: PaymentRow[], p: Period, excluded: Set<string> = new Set()): number {
  return payments.reduce((acc, pay) => {
    if (excluded.has(pay.tenant_id)) return acc;
    const t = new Date(pay.at).getTime();
    return t >= p.start.getTime() && t < p.end.getTime() ? acc + num(pay.amount) : acc;
  }, 0);
}

// ── Riesgo: dos ejes ────────────────────────────────────────────────────────

export interface CollectionRisk {
  tenantId: string;
  name: string;
  reasons: string[];
  daysOverdue: number;
  mrr: number;
}

/**
 * Riesgo de cobro: past_due o último débito rechazado (30 días). Las promesas
 * de pago y el saldo vencido llegan con el ledger (F20-1). Orden: días de mora
 * y monto.
 */
export function collectionRisk(
  accounts: KpiAccount[],
  pastDueSince: Map<string, string | null>,
  rejectedDebits: { tenant_id: string; at: string }[],
  now: Date = new Date(),
): CollectionRisk[] {
  const lastRejected = new Map<string, string>();
  for (const r of rejectedDebits) {
    if (now.getTime() - new Date(r.at).getTime() > 30 * DAY) continue;
    const cur = lastRejected.get(r.tenant_id);
    if (!cur || r.at > cur) lastRejected.set(r.tenant_id, r.at);
  }
  const out: CollectionRisk[] = [];
  for (const a of accounts) {
    if (exclusionReason(a)) continue;
    if (a.status === "cancelled" || a.status === "trial") continue;
    const reasons: string[] = [];
    let days = 0;
    if (a.status === "past_due" || a.status === "suspended") {
      const since = pastDueSince.get(a.tenantId);
      days = since ? Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / DAY)) : 0;
      reasons.push(a.status === "suspended" ? "Suspendido por falta de pago" : "Pago vencido");
      if (since) reasons.push(`${days} ${days === 1 ? "día" : "días"} de mora`);
    }
    const rej = lastRejected.get(a.tenantId);
    if (rej) reasons.push("Último débito rechazado");
    if (reasons.length === 0) continue;
    out.push({ tenantId: a.tenantId, name: a.name, reasons, daysOverdue: days, mrr: accountMrr(a, now) });
  }
  return out.sort((x, y) => y.daysOverdue - x.daysOverdue || y.mrr - x.mrr);
}

export interface UsageRiskInput {
  account: KpiAccount;
  score: number;
  reasons: string[];
  /** Ventas totales registradas (para "trial sin ventas a los 7 días"). */
  hasSales: boolean;
}

export interface UsageRisk {
  tenantId: string;
  name: string;
  score: number;
  reasons: string[];
  kind: "uso" | "conversion";
}

/** Riesgo de uso: puntaje de salud < 60 en una cuenta paga o un trial. */
export function usageRisk(rows: UsageRiskInput[], now: Date = new Date()): UsageRisk[] {
  const out: UsageRisk[] = [];
  for (const r of rows) {
    const a = r.account;
    if (exclusionReason(a)) continue;
    const isTrial = a.status === "trial";
    if (!isTrial && !isPaidStatus(a.status)) continue;
    const trialNoSales =
      isTrial && !r.hasSales && now.getTime() - new Date(a.createdAt).getTime() >= 7 * DAY;
    if (r.score >= 60 && !trialNoSales) continue;
    out.push({
      tenantId: a.tenantId,
      name: a.name,
      score: r.score,
      reasons: r.reasons,
      kind: trialNoSales ? "conversion" : "uso",
    });
  }
  return out.sort((x, y) => x.score - y.score);
}

// ── Tendencia y formato ─────────────────────────────────────────────────────

/** Variación porcentual contra el período anterior; null si no hay base. */
export function trend(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

const dec = (n: number, d: number) =>
  n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: d });

/** Formato compacto para las tarjetas: $ 880 k, $ 10,56 M. */
export function formatCompactArs(v: number): string {
  const n = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (n >= 1e9) return `${sign}$ ${dec(n / 1e9, 2)} mil M`;
  if (n >= 1e6) return `${sign}$ ${dec(n / 1e6, 2)} M`;
  if (n >= 1e4) return `${sign}$ ${dec(n / 1e3, n >= 1e5 ? 0 : 1)} k`;
  return `${sign}$ ${dec(n, 0)}`;
}

/** Valor exacto para el tooltip. */
export function formatExactArs(v: number): string {
  return v.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });
}

export function formatPct(v: number): string {
  return `${dec(v, 1)} %`;
}

// ── Definiciones (tooltip de cada tarjeta) ──────────────────────────────────

export const KPI_DEFINITIONS = {
  mrr: "Ingreso recurrente mensual de las cuentas pagas: precio del plan normalizado a mes (anual / 12) más addons comprados vigentes, menos descuentos vigentes. No incluye trials, suspendidas, canceladas, cuentas lifetime ni negocios de prueba.",
  arr: "Run-rate anual: MRR × 12. No es lo facturado en el año.",
  mrrAtRisk: "Suma del MRR de las cuentas pagas con el pago vencido o con el último débito de Mercado Pago rechazado (30 días).",
  collected: "Pagos registrados en el período (billing_records), en bruto. El neto de comisiones y las reversas llegan con el ledger de cobranza (F20-1).",
  paidAccounts: "Suscripciones activas o con pago vencido, con MRR mayor a 0 y sin exclusiones.",
  arpa: "Ingreso promedio por cuenta paga: MRR / cuentas pagas.",
  trials: "Negocios en período de prueba. Entre paréntesis, los que vencen en los próximos 7 días.",
  conversion: "Trials cuyo fin de prueba cayó en el período y pagaron por primera vez antes de los 7 días siguientes, sobre todos los trials que terminaron en el período. Con menos de 5 casos se muestra n/d.",
  churn: "Cuentas pagas al inicio del período que al cierre están canceladas o suspendidas hace más de 30 días, sobre las pagas al inicio. Se reconstruye desde la auditoría de cambios de estado, no desde la fecha de modificación.",
  newTenants: "Negocios creados en el período, sin los de prueba ni los dados de baja.",
  collectionRisk: "Negocios con el pago vencido, suspendidos por falta de pago o con el último débito rechazado (30 días). Las promesas de pago y el saldo vencido se suman con el ledger (F20-1).",
  usageRisk: "Cuentas pagas o trials con puntaje de salud menor a 60 (logins, ventas y usuarios activos), más los trials sin ventas después de 7 días (riesgo de conversión).",
} as const;
