// =============================================================================
// Participación del staff (F21 · ADR-121): etiquetas, formatos y mensajes de
// error para la UI. El cálculo vive en
// supabase/functions/_shared/staff/settlement.ts (único motor).
// =============================================================================

import type {
  ClientRuleKind,
  ExpenseAllocation,
  ExpenseCategory,
  Recurrence,
} from "@/supabase/functions/_shared/staff/settlement";

export { formatCents, formatDay, parsePesosToCents } from "@/lib/billing/ledger";

export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  servidores: "Servidores",
  dominios: "Dominios",
  servicios: "Servicios y SaaS",
  sueldos: "Empleados y sueldos",
  impuestos: "Impuestos",
  comisiones: "Comisiones de cobro",
  otros: "Otros",
};

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  once: "Única vez",
  monthly: "Mensual",
  yearly: "Anual",
  every_n_months: "Cada N meses",
  every_n_days: "Cada N días",
};

export const ALLOCATION_LABEL: Record<ExpenseAllocation, string> = {
  proportional: "Proporcional a la participación",
  single: "Todo a una persona",
  custom: "Porcentajes a medida",
  house: "Lo absorbe la casa",
  client: "Lo pagan quienes cobran de un cliente",
};

export const RULE_LABEL: Record<ClientRuleKind, string> = {
  bonus_bp: "Porcentaje extra en este cliente",
  override_bp: "Porcentaje especial en este cliente",
  signup_fixed: "Comisión de alta fija",
  signup_bp: "Comisión de alta (% del primer cobro)",
};

export const METHOD_LABEL: Record<string, string> = {
  transfer: "Transferencia bancaria",
  mercadopago: "Mercado Pago",
  cash: "Efectivo",
  other: "Otro",
};

export const RUN_STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "success" | "info" }> = {
  draft: { label: "Borrador", tone: "neutral" },
  closed: { label: "Cerrada, sin pagar", tone: "info" },
  partially_paid: { label: "Pagada en parte", tone: "warning" },
  paid: { label: "Pagada", tone: "success" },
};

/** 4000 → "40 %"; 1250 → "12,5 %". */
export function formatBp(bp: number | null | undefined): string {
  const v = Number(bp ?? 0) / 100;
  return `${v.toLocaleString("es-AR", { maximumFractionDigits: 2 })} %`;
}

/** "40" / "12,5" → 4000 / 1250 (null si no es un % válido entre 0 y 100). */
export function parsePercentToBp(text: string): number | null {
  const raw = String(text ?? "").trim().replace("%", "").replace(",", ".");
  if (!raw) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return null;
  const bp = Math.round(Number(raw) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** "2026-10-01" → "Octubre 2026". */
export function monthLabel(period: string | null | undefined): string {
  if (!period) return "Sin período";
  const d = new Date(`${period.slice(0, 7)}-15T12:00:00Z`);
  const s = d.toLocaleDateString("es-AR", { month: "long", year: "numeric", timeZone: "UTC" }).replace(" de ", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Primer día del mes de una fecha 'YYYY-MM-DD'. */
export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** Texto de una regla por cliente. */
export function ruleText(kind: ClientRuleKind, value: number, money: (c: number) => string): string {
  switch (kind) {
    case "bonus_bp":
      return `+${formatBp(value)} sobre su porcentaje`;
    case "override_bp":
      return `${formatBp(value)} en este cliente`;
    case "signup_fixed":
      return `${money(value)} una sola vez`;
    case "signup_bp":
      return `${formatBp(value)} del primer cobro`;
  }
}

/** Texto de la recurrencia de un gasto. */
export function recurrenceText(r: Recurrence, n: number | null, spread: number): string {
  const base =
    r === "every_n_months" ? `Cada ${n ?? 1} meses` : r === "every_n_days" ? `Cada ${n ?? 1} días` : RECURRENCE_LABEL[r];
  return spread > 1 ? `${base}, prorrateado en ${spread} meses` : base;
}

const ERRORS: Record<string, string> = {
  forbidden: "Sólo el super admin puede hacer esto.",
  reason_required: "Escribí un motivo de al menos 5 caracteres.",
  reason_too_long: "El motivo es demasiado largo (máximo 500 caracteres).",
  shares_over_100: "Con este cambio las participaciones pasan el 100 %. Bajá a alguien primero.",
  period_closed: "Ese mes ya está liquidado y cerrado: usá una fecha posterior o cargá un ajuste en el mes abierto.",
  member_not_found: "No encontramos a esa persona.",
  user_not_staff: "Ese usuario no es parte del staff.",
  rule_overlap: "Ya hay una regla de porcentaje para esa persona en ese cliente en esas fechas.",
  signup_exists: "Esa persona ya tiene una comisión de alta en ese cliente.",
  custom_must_sum_100: "Los porcentajes a medida tienen que sumar 100 %.",
  expense_not_found: "No encontramos ese gasto.",
  invalid_rate: "La cotización no es válida.",
  invalid_date: "La fecha de la cotización no es válida.",
  fx_manual_not_found: "No hay una carga manual para ese día.",
  invalid_cbu: "El CBU o CVU no es válido (revisá los dígitos).",
  invalid_cuit: "El CUIT no es válido.",
  cbu_or_alias_required: "Cargá el CBU / CVU o el alias.",
  account_not_found: "No encontramos esa cuenta.",
  account_required: "Elegí la cuenta a la que transferiste.",
  overpayment: "El pago supera lo que queda por pagar de esa liquidación.",
  invalid_paid_on: "La fecha del pago no es válida.",
  mp_operation_required: "Cargá el número de operación de Mercado Pago.",
  mp_operation_used: "Esa operación de Mercado Pago ya está registrada en otro pago.",
  mp_lookup_required: "Primero traé la operación desde Mercado Pago.",
  mp_not_approved: "La operación no está aprobada en Mercado Pago.",
  mp_amount_mismatch: "El monto no coincide con el de la operación de Mercado Pago.",
  mp_incoming_operation: "En esa operación NinjaSoft recibió plata: no es un pago al staff.",
  mp_not_configured: "Falta el access token de Mercado Pago de NinjaSoft (Pagos de plataforma).",
  mp_not_found: "Mercado Pago no encontró esa operación en la cuenta de NinjaSoft.",
  invalid_operation_id: "El número de operación tiene que tener entre 6 y 20 dígitos.",
  period_not_finished: "El mes todavía no terminó: se cierra desde el día 1 del mes siguiente.",
  previous_period_open: "Primero cerrá el mes anterior.",
  run_exists: "Ese mes ya está cerrado.",
  result_has_errors: "Hay errores en el cálculo (por ejemplo, falta la cotización del dólar).",
  items_changed: "Entraron o cambiaron cobros mientras mirabas: actualizá y volvé a cerrar.",
  adjustments_changed: "Cambiaron los ajustes mientras mirabas: actualizá y volvé a cerrar.",
  before_start_period: "Ese mes es anterior al inicio de las liquidaciones.",
  start_period_locked: "Ya hay liquidaciones cerradas: el mes de inicio no se puede cambiar.",
  adjustment_not_voidable: "Ese ajuste ya entró en una liquidación cerrada.",
  payment_not_found: "No encontramos ese pago.",
};

export function staffErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const key = Object.keys(ERRORS).find((k) => msg.includes(k));
  return key ? ERRORS[key]! : "No se pudo completar. Probá de nuevo.";
}
