// =============================================================================
// Motor de liquidación del staff (F21 · ADR-121, spec docs/40-cobranza-saas.md §20).
//
// Lógica PURA (sin red ni base): la usan la Edge `staff_payouts` (borrador,
// cierre, "mi participación" y proyección), el simulador del panel interno y
// los tests (tests/unit/staffSettlement.test.ts). Una sola implementación del
// reparto: lo que se ve en el simulador es exactamente lo que se cierra.
//
// Reglas (decisiones en §20 y §22 #15):
//   · Base = COBRADO NETO del mes: pagos aprobados − comisiones de cobro −
//     reintegros y contracargos − reserva de impuestos (% configurable, 0 por
//     defecto). Cada hecho de plata se liquida UNA sola vez: el que entra
//     tarde (pago cargado con fecha de un mes ya cerrado, contracargo de un
//     pago ya liquidado) va a la próxima liquidación abierta como "ajuste de
//     meses anteriores".
//   · Cada pago o reversa se reparte con las participaciones vigentes EL DÍA
//     del hecho (un cambio a mitad de mes no promedia: cada pago usa la suya).
//   · Reglas por cliente: "+X %" (bonus_bp) suma puntos a una persona en ese
//     negocio; "X % en este cliente" (override_bp) reemplaza su porcentaje.
//     Salen de la parte de la casa. Si en un cliente la suma pasa el 100 %, se
//     reduce a todos en proporción y se avisa.
//   · Comisión de alta (signup_fixed / signup_bp): una sola vez, en la primera
//     liquidación con un cobro de ese cliente dentro de la vigencia. La paga
//     la casa.
//   · Gastos: recurrencia (única, mensual, anual, cada N meses, cada N días),
//     fecha de fin, monto distinto en un mes puntual (o 0 = no hubo), USD con
//     la cotización del día en que ocurre (venta oficial, ADR-135; si no hay,
//     la última anterior y, de respaldo, la mensual cargada a mano), prorrateo en N meses (un anual en
//     12). Asignación: proporcional (por defecto, con el % de gastos de cada
//     uno y la casa con el resto), exenciones, 100 % a una persona, a la
//     casa, porcentajes a medida o por cliente (en proporción a lo que cada
//     uno cobra de ese negocio).
//   · Ajustes manuales y saldo negativo arrastrado: son pases entre la
//     persona y la casa (la suma total no cambia).
//   · Redondeo: resto mayor (Hamilton) en cada reparto, en enteros con BigInt.
//     La suma de todas las partes da EXACTO el total al centavo.
//
// Invariante (la verifica también la RPC de cierre):
//   Σ neto de las personas + neto de la casa = a repartir − gastos
//                                            = cobrado neto − reserva − gastos
// =============================================================================

import { addDays, addMonths, daysOfPeriod, inRange, monthIndex, periodEnd, periodFromIndex, periodLabel, periodOf } from "./dates.ts";
import { FX_STALE_DAYS, effectiveDaily, rateOn, type DailyFxRate, type FxSource } from "../fx/rates.ts";

export const ENGINE_VERSION = "staff-settlement/2"; // 2: cotización diaria (ADR-135)
export const HOUSE = "__house__";
export const FULL_BP = 10_000;

// ── Tipos de entrada ─────────────────────────────────────────────────────────

export interface SettlementSettings {
  /** La casa (NinjaSoft) absorbe gastos con su parte. false = sólo las personas. */
  houseAbsorbsExpenses: boolean;
  /** Si el neto de una persona da negativo, se descuenta el mes siguiente. */
  negativeCarry: boolean;
  /** Reserva de impuestos sobre el cobrado neto, en puntos básicos (0 = no). */
  incomeTaxReserveBp: number;
}

export interface StaffMember {
  id: string;
  name: string;
}

export interface StaffShare {
  member_id: string;
  /** Participación sobre el cobrado neto (10.000 = 100 %). */
  share_bp: number;
  /** % con el que absorbe gastos proporcionales; null = igual que share_bp. */
  expense_bp: number | null;
  valid_from: string;
  valid_to: string | null;
}

export type ClientRuleKind = "bonus_bp" | "override_bp" | "signup_fixed" | "signup_bp";

export interface ClientRule {
  id: string;
  member_id: string;
  tenant_id: string;
  kind: ClientRuleKind;
  /** bp para bonus/override/signup_bp; centavos para signup_fixed. */
  value: number;
  valid_from: string;
  valid_to: string | null;
}

export type MoneySource = "payment" | "reversal" | "projected";

export interface MoneyItem {
  source: MoneySource;
  id: string;
  tenant_id: string;
  tenant_name?: string;
  /** Día del hecho (pago o reversa), hora de Argentina. */
  date: string;
  /** Con signo: pago > 0, reversa < 0. */
  amount_cents: number;
  /** Comisión de cobro del pago (≥ 0). */
  fee_cents: number;
}

export type Recurrence = "once" | "monthly" | "yearly" | "every_n_months" | "every_n_days";
export type ExpenseAllocation = "proportional" | "single" | "custom" | "house" | "client";
export type ExpenseCategory = "servidores" | "dominios" | "servicios" | "sueldos" | "impuestos" | "comisiones" | "otros";
export type Currency = "ARS" | "USD";

export interface StaffExpense {
  id: string;
  name: string;
  category: ExpenseCategory;
  vendor?: string | null;
  /** En la moneda del gasto, en centavos. */
  amount_cents: number;
  currency: Currency;
  recurrence: Recurrence;
  interval_n: number | null;
  start_date: string;
  end_date: string | null;
  /** Cada ocurrencia se reparte en N meses (1 = entera en su mes; 12 = anual amortizado). */
  spread_months: number;
  allocation: ExpenseAllocation;
  /** single: la persona que lo absorbe (null = la casa). */
  member_id: string | null;
  /** client: el negocio al que se atribuye. */
  tenant_id: string | null;
  /** custom: % por persona (member_id null = la casa), suman 10.000. */
  custom: { member_id: string | null; share_bp: number }[];
  exemptions: { member_id: string; valid_from: string | null; valid_to: string | null }[];
  /** Monto de un mes puntual (en la moneda del gasto): reemplaza al de ese mes; 0 = no hubo. */
  period_amounts: { period: string; amount_cents: number }[];
}

export interface FxRate {
  period: string;
  currency: "USD";
  /** Pesos por 1 USD. */
  rate: number;
}

export interface StaffAdjustment {
  id: string;
  member_id: string;
  /** > 0 suma a la persona (lo pone la casa); < 0 le descuenta (vuelve a la casa). */
  amount_cents: number;
  reason: string;
}

export interface CarryIn {
  member_id: string;
  /** Saldo negativo que viene del mes anterior (≤ 0). */
  amount_cents: number;
}

export interface SettlementInput {
  period: string;
  settings: SettlementSettings;
  members: StaffMember[];
  shares: StaffShare[];
  clientRules: ClientRule[];
  /** Comisiones de alta ya pagadas en liquidaciones cerradas. */
  appliedSignupRuleIds: string[];
  items: MoneyItem[];
  expenses: StaffExpense[];
  /** Cotización mensual cargada a mano (staff_fx_rates, previa a ADR-135): respaldo. */
  fxRates: FxRate[];
  /**
   * Cotización diaria (ADR-135, platform_fx_daily_rates: venta del oficial, manual >
   * API). Se usa la del día de la ocurrencia o la última anterior; si no hay
   * ninguna, la mensual de fxRates.
   */
  dailyRates?: DailyFxRate[];
  adjustments: StaffAdjustment[];
  carryIn: CarryIn[];
}

// ── Tipos de salida ──────────────────────────────────────────────────────────

export interface TenantIncome {
  tenant_id: string;
  tenant_name: string;
  /** Base del negocio repartida (neto − reserva) en este período. */
  base_cents: number;
  cents: number;
  /** Puntos con los que cobró la mayor parte (para mostrar). */
  bp: number;
  rule: ClientRuleKind | null;
}

export interface ExpenseShareOut {
  expense_id: string;
  name: string;
  cents: number;
}

export interface SettlementLine {
  member_id: string;
  name: string;
  /** Participación vigente el primer y el último día del mes. */
  share_bp_start: number;
  share_bp_end: number;
  expense_bp_end: number;
  income_cents: number;
  by_tenant: TenantIncome[];
  signup_cents: number;
  signup_rule_ids: string[];
  expense_cents: number;
  by_expense: ExpenseShareOut[];
  adjustment_cents: number;
  carry_in_cents: number;
  net_cents: number;
  payable_cents: number;
  carry_out_cents: number;
}

export interface ExpenseOut {
  expense_id: string;
  name: string;
  category: ExpenseCategory;
  allocation: ExpenseAllocation;
  currency: Currency;
  /** En la moneda del gasto. */
  original_cents: number;
  fx_rate: number | null;
  fx_period: string | null;
  /** Día de la cotización usada (diaria) o null si vino de la mensual. */
  fx_date?: string | null;
  /** De dónde salió: API, carga manual del día o la mensual vieja. */
  fx_source?: FxSource | "monthly" | null;
  amount_cents: number;
  /** Ocurrencias que aportan a este mes (fechas) y si es una cuota de un prorrateo. */
  occurrences: { date: string; installment: number; of: number }[];
  split: { member_id: string | null; cents: number }[];
}

export interface SettlementResult {
  engine: string;
  period: string;
  base: {
    gross_cents: number;
    fees_cents: number;
    reversals_cents: number;
    net_cents: number;
    reserve_cents: number;
    distributable_cents: number;
    /** Parte del neto que viene de meses ya cerrados (pagos tardíos, contracargos). */
    late_net_cents: number;
    items: number;
  };
  expenses: ExpenseOut[];
  expenses_cents: number;
  /** distributable − gastos. */
  to_share_cents: number;
  lines: SettlementLine[];
  house: {
    income_cents: number;
    signup_cents: number;
    expense_cents: number;
    adjustment_cents: number;
    carry_in_cents: number;
    net_cents: number;
    /** Lo que queda en la cuenta de NinjaSoft después de pagar a todos este mes. */
    cash_cents: number;
    forgiven_cents: number;
  };
  item_ids: { source: MoneySource; id: string }[];
  warnings: string[];
  errors: string[];
}

// ── Reparto exacto (resto mayor) ─────────────────────────────────────────────

/**
 * Reparte `total` centavos (con signo) según pesos enteros ≥ 0. La suma de las
 * partes da exactamente `total`. Desempate del resto: mayor resto, después el
 * orden de entrada. Pesos todos en 0 → null.
 */
export function allocate(total: number, weights: { key: string; w: number | bigint }[]): Map<string, number> | null {
  if (!Number.isSafeInteger(total)) throw new Error(`monto no entero: ${total}`);
  const W = weights.reduce((s, x) => s + BigInt(x.w), 0n);
  const out = new Map<string, number>();
  if (W <= 0n) return null;
  const sign = total < 0 ? -1n : 1n;
  const T = BigInt(Math.abs(total));
  let assigned = 0n;
  const rema: { key: string; r: bigint; i: number }[] = [];
  weights.forEach((x, i) => {
    const w = BigInt(x.w);
    if (w < 0n) throw new Error("peso negativo");
    const q = (T * w) / W;
    const r = (T * w) % W;
    out.set(x.key, (out.get(x.key) ?? 0) + Number(q * sign));
    assigned += q;
    rema.push({ key: x.key, r, i });
  });
  let left = T - assigned;
  rema.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const x of rema) {
    if (left <= 0n) break;
    if (x.r === 0n) continue;
    out.set(x.key, (out.get(x.key) ?? 0) + Number(sign));
    left -= 1n;
  }
  return out;
}

/** Redondeo al entero más cercano, mitades lejos del cero (a × bp / 10.000). */
export function bpOf(amount: number, bp: number): number {
  const n = BigInt(amount) * BigInt(Math.round(bp));
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = a / 10_000n;
  const r = a % 10_000n;
  const v = r * 2n >= 10_000n ? q + 1n : q;
  return Number(neg ? -v : v);
}

// ── Participaciones ──────────────────────────────────────────────────────────

/** Fila vigente de la persona en el día (la de valid_from más reciente). */
export function shareOn(shares: StaffShare[], memberId: string, day: string): StaffShare | null {
  let best: StaffShare | null = null;
  for (const s of shares) {
    if (s.member_id !== memberId || !inRange(day, s.valid_from, s.valid_to)) continue;
    if (!best || s.valid_from > best.valid_from) best = s;
  }
  return best;
}

/**
 * Valida que en ningún día la suma de participaciones pase el 100 %. Devuelve
 * el primer día con exceso y la suma, o null si está bien. Las sumas son
 * constantes por tramos: alcanza con mirar cada inicio de vigencia.
 */
export function sharesOverflow(shares: StaffShare[]): { day: string; total_bp: number } | null {
  const days = [...new Set(shares.map((s) => s.valid_from))].sort();
  const members = [...new Set(shares.map((s) => s.member_id))];
  for (const d of days) {
    const total = members.reduce((acc, m) => acc + (shareOn(shares, m, d)?.share_bp ?? 0), 0);
    if (total > FULL_BP) return { day: d, total_bp: total };
  }
  return null;
}

interface Ctx {
  input: SettlementInput;
  /** Cotización diaria efectiva (una por día, manual > API). */
  daily: DailyFxRate[];
  memberIds: string[];
  warnings: Set<string>;
  errors: Set<string>;
}

function incomeBpOn(ctx: Ctx, day: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of ctx.memberIds) {
    const s = shareOn(ctx.input.shares, id, day);
    if (s && s.share_bp > 0) m.set(id, s.share_bp);
  }
  return m;
}

function expenseBpOn(ctx: Ctx, day: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of ctx.memberIds) {
    const s = shareOn(ctx.input.shares, id, day);
    const w = s ? (s.expense_bp ?? s.share_bp) : 0;
    if (w > 0) m.set(id, w);
  }
  return m;
}

/** % de cada persona en un negocio el día dado, con las reglas del cliente aplicadas. */
export function tenantBpOn(
  ctx: Pick<Ctx, "input" | "memberIds" | "warnings">,
  tenantId: string,
  day: string,
): { bp: Map<string, number>; rules: Map<string, ClientRuleKind> } {
  const bp = new Map<string, number>();
  for (const id of ctx.memberIds) {
    const s = shareOn(ctx.input.shares, id, day);
    if (s && s.share_bp > 0) bp.set(id, s.share_bp);
  }
  const rules = new Map<string, ClientRuleKind>();
  // Primero los override (reemplazan), después los bonus (suman).
  const roster = new Set(ctx.memberIds);
  const active = ctx.input.clientRules.filter(
    (r) =>
      roster.has(r.member_id) &&
      r.tenant_id === tenantId &&
      inRange(day, r.valid_from, r.valid_to) &&
      (r.kind === "override_bp" || r.kind === "bonus_bp"),
  );
  for (const r of active.filter((x) => x.kind === "override_bp")) {
    bp.set(r.member_id, Math.max(0, r.value));
    rules.set(r.member_id, "override_bp");
  }
  for (const r of active.filter((x) => x.kind === "bonus_bp")) {
    bp.set(r.member_id, Math.max(0, (bp.get(r.member_id) ?? 0) + r.value));
    if (!rules.has(r.member_id)) rules.set(r.member_id, "bonus_bp");
  }
  for (const [k, v] of bp) if (v <= 0) bp.delete(k);
  const total = [...bp.values()].reduce((a, b) => a + b, 0);
  if (total > FULL_BP) {
    // Se reduce a todos en proporción hasta sumar 100 % (en puntos enteros).
    const scaled = allocate(
      FULL_BP,
      [...bp.entries()].map(([key, w]) => ({ key, w })),
    )!;
    for (const [k, v] of scaled) bp.set(k, v);
    ctx.warnings.add(`En un cliente las participaciones suman ${(total / 100).toFixed(2)} %: se redujeron en proporción al 100 %.`);
  }
  return { bp, rules };
}

// ── Gastos: ocurrencias y prorrateo ──────────────────────────────────────────

/** Fechas en que ocurre el gasto, hasta `until` inclusive. */
export function occurrenceDates(e: Pick<StaffExpense, "recurrence" | "interval_n" | "start_date" | "end_date">, until: string): string[] {
  const out: string[] = [];
  const last = e.end_date && e.end_date < until ? e.end_date : until;
  if (e.start_date > last) return out;
  const n = Math.max(1, Math.floor(e.interval_n ?? 1));
  for (let k = 0; k < 5000; k++) {
    let d: string;
    switch (e.recurrence) {
      case "once":
        d = e.start_date;
        if (k > 0) return out;
        break;
      case "monthly":
        d = addMonths(e.start_date, k);
        break;
      case "yearly":
        d = addMonths(e.start_date, 12 * k);
        break;
      case "every_n_months":
        d = addMonths(e.start_date, n * k);
        break;
      case "every_n_days":
        d = addDays(e.start_date, n * k);
        break;
      default:
        return out;
    }
    if (d > last) break;
    out.push(d);
  }
  return out;
}

/** Cuotas exactas de un monto en n meses: las primeras se llevan el centavo que sobra. */
export function spreadParts(amount: number, n: number): number[] {
  const k = Math.max(1, Math.floor(n));
  const base = Math.trunc(amount / k);
  let rest = amount - base * k;
  const parts: number[] = [];
  for (let i = 0; i < k; i++) {
    const extra = rest > 0 ? 1 : rest < 0 ? -1 : 0;
    parts.push(base + extra);
    rest -= extra;
  }
  return parts;
}

type FxUsed = { rate: number; period: string; date: string | null; source: FxSource | "monthly" };

function fxFor(ctx: Ctx, day: string, expenseName: string): FxUsed | null {
  const period = periodOf(day);
  // 1) Diaria (ADR-135): la del día o la última anterior; manual > API.
  const daily = ctx.daily.length > 0 ? rateOn(ctx.daily, day) : null;
  if (daily) {
    if (daily.lagDays > FX_STALE_DAYS) {
      ctx.warnings.add(`No hay cotización del dólar cerca del ${formatDayAR(day)}: se usó la del ${formatDayAR(daily.date)}.`);
    }
    return { rate: daily.rate, period: periodOf(daily.date), date: daily.date, source: daily.source };
  }
  // 2) Respaldo: la mensual cargada a mano (antes de ADR-135).
  const rates = ctx.input.fxRates.filter((r) => r.currency === "USD" && r.rate > 0).sort((a, b) => (a.period < b.period ? 1 : -1));
  const exact = rates.find((r) => r.period === period);
  if (exact) return { rate: exact.rate, period: exact.period, date: null, source: "monthly" };
  const prior = rates.find((r) => r.period < period);
  if (prior) {
    ctx.warnings.add(`Falta la cotización del dólar de ${periodLabel(period)}: se usó la de ${periodLabel(prior.period)}.`);
    return { rate: prior.rate, period: prior.period, date: null, source: "monthly" };
  }
  ctx.errors.add(`Falta la cotización del dólar de ${periodLabel(period)} para "${expenseName}".`);
  return null;
}

function formatDayAR(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

interface Portion {
  date: string;
  installment: number;
  of: number;
  original: number;
  ars: number;
  fx: FxUsed | null;
}

/** Lo que el gasto aporta al período (en pesos), por ocurrencia. */
export function expensePortions(ctx: Ctx, e: StaffExpense, period: string): Portion[] {
  const spread = Math.max(1, Math.floor(e.spread_months || 1));
  const target = monthIndex(period);
  const dates = occurrenceDates(e, periodEnd(period));
  // Agrupadas por mes: un monto puntual reemplaza el total de ese mes.
  const byMonth = new Map<number, string[]>();
  for (const d of dates) {
    const mi = monthIndex(d);
    if (mi + spread - 1 < target) continue;
    byMonth.set(mi, [...(byMonth.get(mi) ?? []), d]);
  }
  const out: Portion[] = [];
  for (const [mi, ds] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
    const k = target - mi;
    if (k < 0 || k >= spread) continue;
    const occPeriod = periodFromIndex(mi);
    const override = e.period_amounts.find((p) => p.period === occPeriod);
    const monthAmount = override ? override.amount_cents : e.amount_cents * ds.length;
    if (monthAmount === 0) continue;
    const part = spreadParts(monthAmount, spread)[k] ?? 0;
    if (part === 0) continue;
    let ars = part;
    let fx: Portion["fx"] = null;
    if (e.currency === "USD") {
      fx = fxFor(ctx, ds[0]!, e.name);
      if (!fx) continue;
      ars = Math.round(part * fx.rate);
    }
    out.push({ date: ds[0]!, installment: k + 1, of: spread, original: part, ars, fx });
  }
  return out;
}

function exemptOn(e: StaffExpense, memberId: string, day: string): boolean {
  return e.exemptions.some((x) => x.member_id === memberId && inRange(day, x.valid_from, x.valid_to));
}

/** Pesos (enteros, sumados día por día) para repartir un gasto del mes. */
function expenseWeights(ctx: Ctx, e: StaffExpense, period: string): { key: string; w: number }[] {
  const days = daysOfPeriod(period);
  const absorbs = ctx.input.settings.houseAbsorbsExpenses;
  const known = (id: string | null) => (id && ctx.memberIds.includes(id) ? id : HOUSE);
  if (e.allocation === "house") return [{ key: HOUSE, w: 1 }];
  if (e.allocation === "single") {
    if (e.member_id && !ctx.memberIds.includes(e.member_id)) ctx.warnings.add(`"${e.name}" está asignado a alguien que ya no está: lo absorbe la casa.`);
    return [{ key: known(e.member_id), w: 1 }];
  }
  if (e.allocation === "custom") {
    return e.custom.filter((c) => c.share_bp > 0).map((c) => ({ key: known(c.member_id), w: c.share_bp }));
  }
  const acc = new Map<string, number>();
  for (const d of days) {
    const base =
      e.allocation === "client" && e.tenant_id ? tenantBpOn(ctx, e.tenant_id, d).bp : expenseBpOn(ctx, d);
    let preTotal = 0;
    for (const [id, w] of base) {
      preTotal += w;
      if (exemptOn(e, id, d)) continue;
      acc.set(id, (acc.get(id) ?? 0) + w);
    }
    if (absorbs) acc.set(HOUSE, (acc.get(HOUSE) ?? 0) + Math.max(0, FULL_BP - preTotal));
  }
  // Orden estable: personas en el orden del plantel, la casa al final.
  const out = ctx.memberIds.filter((id) => (acc.get(id) ?? 0) > 0).map((id) => ({ key: id, w: acc.get(id)! }));
  if ((acc.get(HOUSE) ?? 0) > 0) out.push({ key: HOUSE, w: acc.get(HOUSE)! });
  return out;
}

// ── Cálculo ──────────────────────────────────────────────────────────────────

interface Acc {
  income: number;
  byTenant: Map<string, { name: string; base: number; cents: number; bp: number; rule: ClientRuleKind | null }>;
  signup: number;
  signupIds: string[];
  expense: number;
  byExpense: Map<string, { name: string; cents: number }>;
  adjustment: number;
  carryIn: number;
}

const emptyAcc = (): Acc => ({
  income: 0,
  byTenant: new Map(),
  signup: 0,
  signupIds: [],
  expense: 0,
  byExpense: new Map(),
  adjustment: 0,
  carryIn: 0,
});

export function computeSettlement(input: SettlementInput): SettlementResult {
  const period = periodOf(input.period);
  const end = periodEnd(period);
  const ctx: Ctx = { input, daily: effectiveDaily(input.dailyRates ?? []), memberIds: input.members.map((m) => m.id), warnings: new Set(), errors: new Set() };
  const names = new Map(input.members.map((m) => [m.id, m.name]));
  const acc = new Map<string, Acc>();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = emptyAcc();
      acc.set(id, a);
    }
    return a;
  };
  const reserveBp = Math.min(FULL_BP, Math.max(0, Math.round(input.settings.incomeTaxReserveBp || 0)));

  // 1) Cobrado neto, ítem por ítem, con las participaciones del día del hecho.
  let gross = 0;
  let fees = 0;
  let reversals = 0;
  let reserve = 0;
  let distributable = 0;
  let late = 0;
  const tenantBase = new Map<string, { name: string; dist: number; positiveInWindow: { date: string; dist: number }[] }>();
  for (const it of input.items) {
    if (!Number.isSafeInteger(it.amount_cents) || !Number.isSafeInteger(it.fee_cents)) {
      ctx.errors.add(`Importe inválido en ${it.id}.`);
      continue;
    }
    if (it.date > end) continue; // de un mes posterior: espera su liquidación
    const fee = it.amount_cents > 0 ? Math.max(0, it.fee_cents) : 0;
    if (it.amount_cents > 0) gross += it.amount_cents;
    else reversals += -it.amount_cents;
    fees += fee;
    const net = it.amount_cents - fee;
    const res = bpOf(net, reserveBp);
    const dist = net - res;
    reserve += res;
    distributable += dist;
    if (it.date < period) late += net;
    const tname = it.tenant_name ?? it.tenant_id;
    const tb = tenantBase.get(it.tenant_id) ?? { name: tname, dist: 0, positiveInWindow: [] };
    tb.dist += dist;
    if (it.amount_cents > 0) tb.positiveInWindow.push({ date: it.date, dist });
    tenantBase.set(it.tenant_id, tb);
    if (dist === 0) continue;
    const { bp, rules } = tenantBpOn(ctx, it.tenant_id, it.date);
    const weights = ctx.memberIds.filter((id) => (bp.get(id) ?? 0) > 0).map((id) => ({ key: id, w: bp.get(id)! }));
    const houseBp = FULL_BP - weights.reduce((s, x) => s + x.w, 0);
    if (houseBp > 0) weights.push({ key: HOUSE, w: houseBp });
    const split = allocate(dist, weights) ?? new Map([[HOUSE, dist]]);
    for (const [k, cents] of split) {
      const a = get(k);
      a.income += cents;
      const t = a.byTenant.get(it.tenant_id) ?? { name: tname, base: 0, cents: 0, bp: 0, rule: null };
      t.base += dist;
      t.cents += cents;
      t.bp = k === HOUSE ? houseBp : (bp.get(k) ?? 0);
      t.rule = k === HOUSE ? null : (rules.get(k) ?? t.rule);
      a.byTenant.set(it.tenant_id, t);
    }
  }
  const netTotal = gross - fees - reversals;

  // 2) Comisiones de alta: una vez, la paga la casa.
  const applied = new Set(input.appliedSignupRuleIds);
  for (const r of input.clientRules) {
    if ((r.kind !== "signup_fixed" && r.kind !== "signup_bp") || applied.has(r.id) || !names.has(r.member_id)) continue;
    const tb = tenantBase.get(r.tenant_id);
    const inWindow = (tb?.positiveInWindow ?? []).filter((p) => inRange(p.date, r.valid_from, r.valid_to));
    if (inWindow.length === 0) continue;
    const base = inWindow.reduce((s, p) => s + p.dist, 0);
    const cents = r.kind === "signup_fixed" ? Math.max(0, Math.round(r.value)) : Math.max(0, bpOf(base, r.value));
    if (cents === 0) continue;
    const a = get(r.member_id);
    a.signup += cents;
    a.signupIds.push(r.id);
    get(HOUSE).signup -= cents;
  }

  // 3) Gastos del mes.
  const expensesOut: ExpenseOut[] = [];
  let expensesTotal = 0;
  for (const e of input.expenses) {
    const portions = expensePortions(ctx, e, period);
    if (portions.length === 0) continue;
    const amount = portions.reduce((s, p) => s + p.ars, 0);
    const original = portions.reduce((s, p) => s + p.original, 0);
    if (amount === 0) continue;
    let weights = expenseWeights(ctx, e, period);
    if (weights.reduce((s, x) => s + x.w, 0) <= 0) {
      ctx.warnings.add(`"${e.name}" no tenía a quién asignarse (todos eximidos o sin participación): lo absorbe la casa.`);
      weights = [{ key: HOUSE, w: 1 }];
    }
    const split = allocate(amount, weights)!;
    for (const [k, cents] of split) {
      const a = get(k);
      a.expense += cents;
      const b = a.byExpense.get(e.id) ?? { name: e.name, cents: 0 };
      b.cents += cents;
      a.byExpense.set(e.id, b);
    }
    expensesTotal += amount;
    const fx = portions.find((p) => p.fx)?.fx ?? null;
    expensesOut.push({
      expense_id: e.id,
      name: e.name,
      category: e.category,
      allocation: e.allocation,
      currency: e.currency,
      original_cents: original,
      fx_rate: fx?.rate ?? null,
      fx_period: fx?.period ?? null,
      fx_date: fx?.date ?? null,
      fx_source: fx?.source ?? null,
      amount_cents: amount,
      occurrences: portions.map((p) => ({ date: p.date, installment: p.installment, of: p.of })),
      split: [...split.entries()].map(([k, cents]) => ({ member_id: k === HOUSE ? null : k, cents })),
    });
  }

  // 4) Ajustes y saldo arrastrado: pases persona ↔ casa.
  for (const adj of input.adjustments) {
    if (!adj.amount_cents || !names.has(adj.member_id)) continue;
    get(adj.member_id).adjustment += adj.amount_cents;
    get(HOUSE).adjustment -= adj.amount_cents;
  }
  for (const c of input.carryIn) {
    if (!c.amount_cents || !names.has(c.member_id)) continue;
    get(c.member_id).carryIn += c.amount_cents;
    get(HOUSE).carryIn -= c.amount_cents;
  }

  // 5) Líneas por persona.
  const lines: SettlementLine[] = [];
  let payableTotal = 0;
  let forgiven = 0;
  const firstDay = period;
  for (const id of ctx.memberIds) {
    const a = acc.get(id);
    const sStart = shareOn(input.shares, id, firstDay);
    const sEnd = shareOn(input.shares, id, end);
    if (!a && !sStart && !sEnd) continue;
    const x = a ?? emptyAcc();
    const net = x.income + x.signup - x.expense + x.adjustment + x.carryIn;
    const payable = Math.max(0, net);
    const carryOut = net < 0 && input.settings.negativeCarry ? net : 0;
    if (net < 0 && !input.settings.negativeCarry) forgiven += -net;
    payableTotal += payable;
    lines.push({
      member_id: id,
      name: names.get(id) ?? id,
      share_bp_start: sStart?.share_bp ?? 0,
      share_bp_end: sEnd?.share_bp ?? 0,
      expense_bp_end: sEnd ? (sEnd.expense_bp ?? sEnd.share_bp) : 0,
      income_cents: x.income,
      by_tenant: [...x.byTenant.entries()]
        .map(([tenant_id, t]) => ({ tenant_id, tenant_name: t.name, base_cents: t.base, cents: t.cents, bp: t.bp, rule: t.rule }))
        .sort((p, q) => q.cents - p.cents),
      signup_cents: x.signup,
      signup_rule_ids: x.signupIds,
      expense_cents: x.expense,
      by_expense: [...x.byExpense.entries()].map(([expense_id, b]) => ({ expense_id, name: b.name, cents: b.cents })),
      adjustment_cents: x.adjustment,
      carry_in_cents: x.carryIn,
      net_cents: net,
      payable_cents: payable,
      carry_out_cents: carryOut,
    });
  }
  for (const r of input.adjustments) {
    if (!names.has(r.member_id)) ctx.errors.add(`Ajuste de una persona que no está en el plantel (${r.member_id}).`);
  }

  const h = acc.get(HOUSE) ?? emptyAcc();
  const houseNet = h.income + h.signup - h.expense + h.adjustment + h.carryIn;
  const toShare = distributable - expensesTotal;
  if (toShare < 0) ctx.warnings.add("Los gastos del mes superan lo cobrado: el reparto da negativo.");

  return {
    engine: ENGINE_VERSION,
    period,
    base: {
      gross_cents: gross,
      fees_cents: fees,
      reversals_cents: reversals,
      net_cents: netTotal,
      reserve_cents: reserve,
      distributable_cents: distributable,
      late_net_cents: late,
      items: input.items.filter((i) => i.date <= end).length,
    },
    expenses: expensesOut,
    expenses_cents: expensesTotal,
    to_share_cents: toShare,
    lines,
    house: {
      income_cents: h.income,
      signup_cents: h.signup,
      expense_cents: h.expense,
      adjustment_cents: h.adjustment,
      carry_in_cents: h.carryIn,
      net_cents: houseNet,
      cash_cents: toShare - payableTotal,
      forgiven_cents: forgiven,
    },
    item_ids: input.items.filter((i) => i.date <= end && i.source !== "projected").map((i) => ({ source: i.source, id: i.id })),
    warnings: [...ctx.warnings],
    errors: [...ctx.errors],
  };
}

/** Comprueba el invariante: personas + casa = a repartir − gastos, al centavo. */
export function checkInvariant(r: SettlementResult): boolean {
  const people = r.lines.reduce((s, l) => s + l.net_cents, 0);
  return people + r.house.net_cents === r.to_share_cents && r.base.distributable_cents + r.base.reserve_cents === r.base.net_cents;
}

// ── Proyección del mes próximo ───────────────────────────────────────────────

export interface ProjectionTenant {
  tenant_id: string;
  tenant_name: string;
  /** Lo que se espera cobrar en el mes (con descuentos, IVA incluido). */
  expected_cents: number;
  cycle: "monthly" | "yearly";
  /** Vencimiento o renovación dentro del mes. */
  due_date: string;
}

export interface ProjectionAssumptions {
  period: string;
  /** % de lo esperado que se supone efectivamente cobrado (10.000 = todo). */
  collection_rate_bp: number;
  /** Comisión de cobro estimada sobre lo cobrado (promedio de los últimos 90 días). */
  fee_rate_bp: number;
  tenants: number;
  expected_cents: number;
}

/** Ítems "esperados" para proyectar el mes con el mismo motor. */
export function projectedItems(tenants: ProjectionTenant[], period: string, collectionRateBp: number, feeRateBp: number): MoneyItem[] {
  const end = periodEnd(period);
  return tenants
    .filter((t) => t.expected_cents > 0)
    .map((t) => {
      const amount = bpOf(t.expected_cents, Math.max(0, Math.min(FULL_BP, collectionRateBp)));
      const date = t.due_date >= period && t.due_date <= end ? t.due_date : period;
      return {
        source: "projected" as const,
        id: `proj:${t.tenant_id}`,
        tenant_id: t.tenant_id,
        tenant_name: t.tenant_name,
        date,
        amount_cents: amount,
        fee_cents: Math.max(0, bpOf(amount, Math.max(0, feeRateBp))),
      };
    })
    .filter((i) => i.amount_cents > 0);
}

// ── Explicación paso a paso (simulador y detalle) ────────────────────────────

export interface ExplainStep {
  label: string;
  cents: number;
  detail?: string;
  tone?: "plus" | "minus" | "total";
}

const pct = (bp: number) => `${(bp / 100).toLocaleString("es-AR", { maximumFractionDigits: 2 })} %`;

export function explainBase(r: SettlementResult, reserveBp: number): ExplainStep[] {
  const s: ExplainStep[] = [{ label: "Cobrado en el mes", cents: r.base.gross_cents, tone: "plus" }];
  if (r.base.fees_cents) s.push({ label: "Comisiones de cobro", cents: -r.base.fees_cents, tone: "minus", detail: "Mercado Pago u otros medios." });
  if (r.base.reversals_cents)
    s.push({ label: "Reintegros y contracargos", cents: -r.base.reversals_cents, tone: "minus", detail: "Se descuentan en el mes en que ocurren." });
  s.push({ label: "Cobrado neto", cents: r.base.net_cents, tone: "total" });
  if (r.base.reserve_cents)
    s.push({ label: `Reserva de impuestos (${pct(reserveBp)})`, cents: -r.base.reserve_cents, tone: "minus" });
  if (r.base.late_net_cents)
    s.push({
      label: "De meses ya cerrados",
      cents: r.base.late_net_cents,
      detail: "Pagos cargados tarde o contracargos de meses liquidados: entran en esta liquidación.",
    });
  for (const e of r.expenses) s.push({ label: `Gasto: ${e.name}`, cents: -e.amount_cents, tone: "minus", ...(fxDetail(e) ? { detail: fxDetail(e)! } : {}) });
  s.push({ label: "A repartir", cents: r.to_share_cents, tone: "total" });
  return s;
}

const FX_DETAIL_SOURCE: Record<string, string> = { api: "ArgentinaDatos", manual: "carga manual", monthly: "cotización mensual" };

/** "USD 23,40 a $ 1.535 (oficial venta del 14/10/2026, ArgentinaDatos)". null si el gasto es en pesos. */
export function fxDetail(e: Pick<ExpenseOut, "currency" | "original_cents" | "fx_rate" | "fx_period" | "fx_date" | "fx_source">): string | null {
  if (e.currency !== "USD" || !e.fx_rate) return null;
  const usd = (e.original_cents / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rate = e.fx_rate.toLocaleString("es-AR", { maximumFractionDigits: 2 });
  const when = e.fx_date ? `oficial venta del ${formatDayAR(e.fx_date)}` : e.fx_period ? `cotización de ${periodLabel(e.fx_period)}` : "cotización";
  const src = e.fx_source && e.fx_date ? `, ${FX_DETAIL_SOURCE[e.fx_source] ?? e.fx_source}` : "";
  return `USD ${usd} a $ ${rate} (${when}${src})`;
}

export function explainLine(l: SettlementLine): ExplainStep[] {
  const s: ExplainStep[] = [];
  for (const t of l.by_tenant) {
    const why = t.rule === "bonus_bp" ? " (con bonus en este cliente)" : t.rule === "override_bp" ? " (% especial en este cliente)" : "";
    const back = t.cents < 0 ? " (reintegro o contracargo)" : "";
    s.push({ label: `${pct(t.bp)} de ${t.tenant_name}${why}${back}`, cents: t.cents, tone: t.cents < 0 ? "minus" : "plus" });
  }
  if (l.signup_cents) s.push({ label: "Comisión de alta", cents: l.signup_cents, tone: "plus" });
  for (const e of l.by_expense) s.push({ label: `Su parte de ${e.name}`, cents: -e.cents, tone: "minus" });
  if (l.adjustment_cents) s.push({ label: "Ajustes", cents: l.adjustment_cents, tone: l.adjustment_cents > 0 ? "plus" : "minus" });
  if (l.carry_in_cents) s.push({ label: "Saldo negativo del mes anterior", cents: l.carry_in_cents, tone: "minus" });
  s.push({ label: "Neto", cents: l.net_cents, tone: "total" });
  if (l.carry_out_cents) s.push({ label: "Pasa al mes siguiente", cents: l.carry_out_cents, detail: "El neto dio negativo: no se paga y se descuenta el mes próximo." });
  return s;
}

/** Etiqueta de un período para la UI ('octubre 2026'). */
export { periodLabel };
