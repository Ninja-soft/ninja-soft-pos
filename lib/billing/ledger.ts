// =============================================================================
// Cuenta corriente de la plataforma (F20-1 · H127, spec docs/40 §6.3, §10,
// §17 y §22; ADR-115).
//
// Funciones puras, espejo de la lógica SQL de las migraciones
// 20261113100000_cobranza_ledger y 20261113100100_cobranza_ledger_rpc:
//   · billingTotal      → platform_billing_breakdown / subscription_billing_total
//   · prorationCents    → trigger subscriptions_proration
//   · paidPeriodAnchor  → reanchor_subscription_period (pago durante la prueba)
//   · allocateFifo      → platform_auto_allocate
//   · statementTotals   → platform_statement (saldo, vencido, aging)
// Más los textos y formatos que usan las pantallas. Sin Supabase: se testean
// en tests/unit/billingLedger.test.ts.
// =============================================================================

import { percentToBp, prorateCents } from "@/lib/billing/proration";

const DAY = 86_400_000;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Pesos (con decimales) a centavos enteros, redondeo al centavo. */
export function toCents(pesos: number): number {
  return Math.round(num(pesos) * 100);
}

/**
 * Importe escrito por una persona ("12.500", "12500,50", "12500.5") a
 * centavos. null si no es un número positivo.
 */
export function parsePesosToCents(text: string): number | null {
  const raw = String(text ?? "").trim().replace(/\s|\$/g, "");
  if (!raw) return null;
  let normalized = raw;
  if (raw.includes(",")) normalized = raw.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) normalized = raw.replace(/\./g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return cents > 0 ? cents : null;
}

/** Centavos a pesos. */
export function fromCents(cents: number): number {
  return num(cents) / 100;
}

// ── Monto de la suscripción ─────────────────────────────────────────────────

export interface BillingAddon {
  status: string;
  source: string;
  monthly_price_ars: number | null;
  catalog_price_ars?: number | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: string | null;
}

export interface BillingDiscount {
  kind: "percent" | "fixed" | string;
  value: number;
  valid_from: string | null;
  valid_until: string | null;
  deleted_at?: string | null;
}

export interface BillingTotalInput {
  cycle: "monthly" | "yearly" | string;
  planMonthly: number;
  planYearly: number | null;
  addons: BillingAddon[];
  discounts: BillingDiscount[];
  /** Fecha de vigencia (YYYY-MM-DD). */
  at: string;
}

export interface BillingTotal {
  gross: number;
  planAmount: number;
  addonsAmount: number;
  percentOff: number;
  fixedOff: number;
  discount: number;
  total: number;
}

function discountActive(d: BillingDiscount, at: string): boolean {
  if (d.deleted_at) return false;
  if (num(d.value) <= 0) return false;
  if (d.valid_from && d.valid_from > at) return false;
  if (d.valid_until && d.valid_until < at) return false;
  return true;
}

/**
 * Monto del ciclo con IVA incluido: plan del ciclo (anual o, si no hay anual,
 * mensual × 12) + addons comprados vigentes (× 12 en el anual) − descuentos
 * vigentes. Los porcentajes suman (tope 100 %) y van sobre el bruto; después
 * los fijos (mensuales, × 12 en el anual). Nunca negativo.
 */
export function billingTotal(input: BillingTotalInput): BillingTotal {
  const yearly = input.cycle === "yearly";
  const planAmount = yearly
    ? num(input.planYearly) > 0
      ? num(input.planYearly)
      : num(input.planMonthly) * 12
    : num(input.planMonthly);
  const addonsMonthly = input.addons.reduce((acc, a) => {
    if (a.source === "granted") return acc;
    const billable =
      a.status === "active" ||
      (Boolean(a.cancel_at_period_end) && Boolean(a.current_period_end) && String(a.current_period_end).slice(0, 10) >= input.at);
    return billable ? acc + num(a.monthly_price_ars ?? a.catalog_price_ars ?? 0) : acc;
  }, 0);
  const addonsAmount = yearly ? addonsMonthly * 12 : addonsMonthly;
  const gross = planAmount + addonsAmount;
  const active = input.discounts.filter((d) => discountActive(d, input.at));
  const percentOff = Math.min(
    100,
    active.filter((d) => d.kind === "percent").reduce((s, d) => s + num(d.value), 0),
  );
  const fixedMonthly = active.filter((d) => d.kind === "fixed").reduce((s, d) => s + num(d.value), 0);
  const fixedOff = yearly ? fixedMonthly * 12 : fixedMonthly;
  const discount = Math.min(gross, Math.round(gross * percentOff) / 100 + fixedOff);
  return { gross, planAmount, addonsAmount, percentOff, fixedOff, discount, total: gross - discount };
}

// ── Prorrateo de upgrade (§17.4, §22 #12) ──────────────────────────────────

export interface ProrationInput {
  /** Precio del ciclo del plan viejo y del nuevo (pesos). */
  oldCycleAmount: number;
  newCycleAmount: number;
  /** Fechas YYYY-MM-DD del período vigente [start, end) y de hoy. */
  periodStart: string;
  periodEnd: string;
  today: string;
  /** Descuento porcentual vigente (0 a 100). */
  percentOff?: number;
}

export interface Proration {
  debitCents: number;
  creditCents: number;
  totalCents: number;
  daysLeft: number;
  daysTotal: number;
}

const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY);

/**
 * Diferencia prorrateada de un upgrade a mitad de período: débito por los días
 * que quedan del plan nuevo menos crédito por esos días del plan viejo. Se
 * suma al próximo cobro. null si no corresponde (downgrade, período terminado
 * o sin días).
 */
export function prorationCents(input: ProrationInput): Proration | null {
  if (num(input.newCycleAmount) <= num(input.oldCycleAmount)) return null;
  const daysTotal = dayNumber(input.periodEnd) - dayNumber(input.periodStart);
  const daysLeft = Math.min(daysTotal, dayNumber(input.periodEnd) - dayNumber(input.today));
  if (daysTotal <= 0 || daysLeft <= 0) return null;
  // Mismo cálculo que platform_prorate_cents (F20-10, lib/billing/proration.ts).
  const pctBp = percentToBp(Math.min(100, Math.max(0, num(input.percentOff))));
  const debitCents = prorateCents(Math.round(num(input.newCycleAmount) * 100), pctBp, daysLeft, daysTotal);
  const creditCents = prorateCents(Math.round(num(input.oldCycleAmount) * 100), pctBp, daysLeft, daysTotal);
  const totalCents = debitCents - creditCents;
  if (totalCents <= 0) return null;
  return { debitCents, creditCents, totalCents, daysLeft, daysTotal };
}

// ── Período pago (§5.3, §22 #11) ────────────────────────────────────────────

export interface AnchorInput {
  status: string;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  now: Date;
}

/**
 * Inicio del período que paga un cobro aprobado. Si paga durante la prueba,
 * arranca al terminar la prueba (no se pierden días de prueba). Si no, en el
 * vencimiento anterior (no se regalan días por pagar tarde).
 */
export function paidPeriodAnchor(input: AnchorInput): Date {
  if (input.status === "trial" && input.trialEndsAt && Date.parse(input.trialEndsAt) > input.now.getTime()) {
    return new Date(input.trialEndsAt);
  }
  const base = input.currentPeriodEnd ?? input.currentPeriodStart;
  return base ? new Date(base) : new Date(input.now);
}

// ── Imputación FIFO ─────────────────────────────────────────────────────────

export interface OpenDebit {
  id: string;
  open: number;
  due: string;
  kind?: string;
  createdAt?: string;
}

export interface OpenCredit {
  id: string;
  open: number;
  date: string;
  createdAt?: string;
}

export interface Allocation {
  credit: string;
  debit: string;
  amount: number;
}

/**
 * Imputa el haber libre contra el debe pendiente: créditos por fecha; débitos
 * con los punitorios primero y después por vencimiento y antigüedad. El
 * sobrante queda como saldo a favor.
 */
export function allocateFifo(debits: OpenDebit[], credits: OpenCredit[]): Allocation[] {
  const ds = debits
    .map((d) => ({ ...d }))
    .sort(
      (a, b) =>
        Number(b.kind === "interest") - Number(a.kind === "interest") ||
        a.due.localeCompare(b.due) ||
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
        a.id.localeCompare(b.id),
    );
  const cs = credits
    .map((c) => ({ ...c }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
        a.id.localeCompare(b.id),
    );
  const out: Allocation[] = [];
  for (const c of cs) {
    for (const d of ds) {
      if (c.open <= 0) break;
      if (d.open <= 0) continue;
      const amount = Math.min(c.open, d.open);
      out.push({ credit: c.id, debit: d.id, amount });
      c.open -= amount;
      d.open -= amount;
    }
  }
  return out;
}

// ── Estado de cuenta ────────────────────────────────────────────────────────

export interface StatementMovement {
  amount_cents: number;
  open_cents: number;
  due_date: string | null;
  effective_date: string;
}

export interface Aging {
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
}

export interface StatementTotals {
  balance: number;
  overdue: number;
  upcoming: number;
  credit: number;
  aging: Aging;
}

/** Saldo, vencido, a vencer, a favor y aging (días desde el vencimiento). */
export function statementTotals(movements: StatementMovement[], today: string): StatementTotals {
  const t = dayNumber(today);
  const aging: Aging = { d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let balance = 0;
  let overdue = 0;
  let upcoming = 0;
  let credit = 0;
  for (const m of movements) {
    balance += num(m.amount_cents);
    const open = num(m.open_cents);
    if (num(m.amount_cents) < 0) {
      credit += open;
      continue;
    }
    if (open <= 0) continue;
    const due = m.due_date ?? m.effective_date;
    const days = t - dayNumber(due);
    if (days >= 1) {
      overdue += open;
      if (days <= 30) aging.d1_30 += open;
      else if (days <= 60) aging.d31_60 += open;
      else if (days <= 90) aging.d61_90 += open;
      else aging.d90_plus += open;
    } else {
      upcoming += open;
    }
  }
  return { balance, overdue, upcoming, credit, aging };
}

/** Días de mora desde el vencimiento más viejo impago (0 si no hay). */
export function daysOverdue(oldestDue: string | null | undefined, today: string): number {
  if (!oldestDue) return 0;
  return Math.max(0, dayNumber(today) - dayNumber(oldestDue.slice(0, 10)));
}

// ── Textos ──────────────────────────────────────────────────────────────────

export const MOVEMENT_LABELS: Record<string, string> = {
  charge: "Cargo",
  interest: "Punitorio",
  adjustment_debit: "Ajuste al debe",
  refund: "Reintegro",
  payment_reversal: "Contracargo",
  payment: "Pago",
  bonus_credit: "Bonificación",
  interest_waiver: "Condonación de punitorio",
  adjustment_credit: "Ajuste a favor",
  charge_void: "Anulación de cargo",
  opening_balance: "Saldo inicial",
};

export const CHARGE_KIND_LABELS: Record<string, string> = {
  subscription_period: "Suscripción",
  proration: "Prorrateo por cambio de plan",
  addon: "Complemento",
  one_off: "Cargo puntual",
  interest: "Punitorio",
  adjustment: "Ajuste",
};

export const CHARGE_STATUS_LABELS: Record<string, string> = {
  open: "Pendiente",
  partially_paid: "Pago parcial",
  paid: "Pagado",
  voided: "Anulado",
  written_off: "Incobrable",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  mp_preapproval: "Mercado Pago (débito automático)",
  mp_checkout: "Mercado Pago",
  transfer: "Transferencia",
  cash: "Efectivo",
  other: "Otro medio",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending_verification: "Por verificar",
  approved: "Acreditado",
  rejected: "Rechazado",
  refunded: "Reintegrado",
  partially_refunded: "Reintegro parcial",
  charged_back: "Contracargo",
  in_dispute: "En disputa",
};

export const BILLING_MODE_LABELS: Record<string, string> = {
  mp_subscription: "Débito automático con Mercado Pago",
  account: "Cuenta corriente",
  manual: "Manual",
  exempt: "Exento",
};

export const EXCLUSION_LABELS: Record<string, string> = {
  deleted: "Dado de baja",
  test: "Negocio de prueba",
  staff_owned: "Negocio del staff",
  lifetime: "Cuenta lifetime",
  exempt: "Exento",
};

export const BILLING_ROLE_LABELS: Record<string, string> = {
  viewer: "Sólo lectura",
  cobranzas: "Cobranzas",
  admin: "Admin",
  super_admin: "Super admin",
};

/** Movimientos que restan saldo (haber). */
export function isCredit(kind: string, amountCents: number): boolean {
  return amountCents < 0 || ["payment", "bonus_credit", "interest_waiver", "adjustment_credit", "charge_void"].includes(kind);
}

/** Mensaje legible para los errores de las RPC de cobranza. */
export function billingErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  const map: Record<string, string> = {
    forbidden: "No tenés permiso para esta acción.",
    forbidden_exempt: "Sólo un super admin puede marcar un negocio como exento.",
    reason_required: "Escribí un motivo de al menos 5 caracteres.",
    reason_too_long: "El motivo no puede superar los 500 caracteres.",
    invalid_amount: "Ingresá un importe mayor a cero.",
    invalid_paid_on: "La fecha de pago no puede ser futura ni de hace más de un año.",
    invalid_method: "Elegí un medio de pago.",
    mp_reference_required: "Para un pago de Mercado Pago, cargá el número de operación.",
    duplicate_payment: "Ese pago de Mercado Pago ya está registrado.",
    cap_per_operation_exceeded: "Supera el tope por operación de tu nivel.",
    cap_per_month_exceeded: "Supera el tope mensual de bonificaciones para este negocio.",
    charge_already_voided: "El cargo ya estaba anulado.",
    payment_not_reversible: "Ese pago ya fue revertido.",
    invalid_description: "La descripción debe tener entre 3 y 140 caracteres.",
    invalid_due_date: "El vencimiento tiene que estar entre hace 30 días y dentro de un año.",
    exempt_reason_required: "Para marcar exento, escribí el motivo de la exención.",
    invalid_due_days: "El plazo de pago va de 0 a 60 días.",
    invalid_caps: "El tope mensual no puede ser menor al tope por operación.",
    not_staff: "La persona no es del staff.",
    tenant_not_found: "No encontramos el negocio.",
    ledger_ingest_failed: "No se pudo registrar el pago en la cuenta corriente.",
    // F20-8 (ADR-120)
    use_mode_change: "La modalidad se cambia con Cambiar modalidad.",
    same_mode: "El negocio ya está en esa modalidad.",
    mode_change_pending: "Ya hay un pase a Mercado Pago esperando el primer débito.",
    invalid_billing_mode: "Elegí una modalidad.",
    billing_mode_not_mp: "El negocio no paga con Mercado Pago: pasalo a débito automático desde Cambiar modalidad.",
    invalid_cbu: "El CBU o CVU no es válido (revisá los 22 dígitos).",
    invalid_alias: "El alias tiene que tener de 6 a 20 letras, números, puntos o guiones.",
    cbu_or_alias_required: "Cargá un CBU, un CVU o un alias.",
    invalid_cuit: "El CUIT tiene que tener 11 dígitos.",
    bank_account_not_found: "No encontramos esa cuenta.",
    invalid_email: "Hay un email con formato inválido.",
    too_many_recipients: "Hasta 5 emails por lista.",
    invalid_notice_terms: "Revisá los días del aviso.",
    nothing_to_collect: "El negocio no tiene saldo pendiente.",
    no_recipients: "El negocio no tiene a quién mandarle el aviso.",
    report_not_pending: "Esa transferencia ya fue resuelta.",
    report_not_found: "No encontramos esa transferencia.",
    duplicate_proof: "Ese comprobante ya fue informado.",
    invalid_proof: "No pudimos leer el comprobante. Volvé a subirlo.",
    too_many_pending: "Tenés muchas transferencias sin verificar. Esperá a que las revisemos.",
    invalid_overrides: "Revisá los límites.",
    invalid_value: "Los límites son números enteros desde 0.",
    invalid_key: "Ese límite no existe.",
    subscription_not_found: "El negocio no tiene suscripción.",
    code_taken: "Ya existe un código con ese texto.",
    forbidden_lifetime: "Sólo un super admin puede crear códigos vitalicios.",
    invalid_code: "El código va de 4 a 32 letras, números, guiones o guion bajo.",
    plan_not_found: "Ese plan no está disponible.",
    invalid_validity: "La fecha de fin no puede ser anterior a la de inicio.",
    // F20-10 y F20-11 (ADR-131)
    quote_changed: "El cálculo cambió desde que lo simulaste. Volvé a simular antes de confirmar.",
    no_change: "Elegí un plan o un ciclo distinto del actual.",
    invalid_cycle: "Elegí un ciclo válido (mensual o anual).",
    invalid_timing: "Elegí cuándo rige el cambio.",
    request_id_required: "Falta el identificador del pedido. Volvé a intentar.",
    change_not_found: "No encontramos ese cambio de plan.",
    change_not_scheduled: "Ese cambio ya no está programado.",
    recon_running: "Ya hay una conciliación en curso. Esperá unos minutos.",
    diff_not_found: "No encontramos esa diferencia.",
    diff_not_open: "Esa diferencia ya fue resuelta.",
    invalid_action: "Esa acción no existe.",
    action_not_allowed: "Esa acción no corresponde a este tipo de diferencia.",
    tenant_required: "Elegí a qué negocio imputar el pago.",
    mp_payment_unknown: "No tenemos los datos de ese pago de Mercado Pago. Volvé a conciliar.",
    payment_required: "La diferencia no tiene un pago asociado.",
    not_collector: "Esa persona no puede ser cobradora (necesita Cobranzas o ser admin).",
    invalid_tenants: "Elegí entre 1 y 500 negocios.",
    invalid_body: "La nota tiene que tener entre 3 y 2000 caracteres.",
    invalid_next_action: "La próxima acción tiene que ser desde hoy y dentro de los 180 días.",
    note_not_found: "No encontramos esa nota.",
    note_already_voided: "Esa nota ya estaba anulada.",
    invalid_settings: "Revisá la ventana (24 a 720 horas) y la tolerancia.",
    invalid_outcome: "Elegí un resultado válido.",
    "check constraint": "Revisá los datos: hay un valor fuera de rango.",
  };
  // La clave más larga primero: "forbidden_exempt" antes que "forbidden".
  const entries = Object.entries(map).sort((x, y) => y[0].length - x[0].length);
  for (const [k, v] of entries) if (raw.includes(k)) return v;
  if (/function .* does not exist|Could not find the function/i.test(raw)) {
    return "Falta aplicar la migración de cobranza.";
  }
  return raw || "No se pudo completar la acción.";
}

// ── Formato ─────────────────────────────────────────────────────────────────

/** $ 12.345,67 desde centavos (signo con "−" tipográfico). */
export function formatCents(cents: number, opts: { signed?: boolean } = {}): string {
  const v = num(cents) / 100;
  const abs = Math.abs(v).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? "−" : opts.signed && v > 0 ? "+" : "";
  return `${sign}$ ${abs}`;
}

/** dd/mm/aaaa desde YYYY-MM-DD o ISO, sin correr el día por zona horaria. */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "Sin fecha";
  const ymd = value.slice(0, 10);
  const [y, m, d] = ymd.split("-");
  if (!y || !m || !d) return value;
  return `${d}/${m}/${y}`;
}

/** Período [start, end) como "01/10/2026 al 31/10/2026". */
export function formatPeriod(start: string | null | undefined, end: string | null | undefined): string | null {
  if (!start) return null;
  if (!end) return `Desde ${formatDay(start)}`;
  const last = new Date(Date.parse(`${end.slice(0, 10)}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  return `${formatDay(start)} al ${formatDay(last)}`;
}

/** Hoy en Argentina como YYYY-MM-DD. */
export function todayAR(now: Date = new Date()): string {
  return new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
