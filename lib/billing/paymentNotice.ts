// =============================================================================
// Cuenta corriente de la plataforma (F20-8 · ADR-120, spec docs/40 §9.3, §10.1,
// §12.3 y §22 #13): avisos de cobro, datos bancarios y comprobantes.
//
// Funciones puras, espejo de la migración 20261116100000_cobranza_cuenta_corriente:
//   · noticeKey          → platform_notice_key (qué aviso toca hoy y su clave
//                          de idempotencia)
//   · bankBlockHtml      → platform_bank_block_html (bloque de cuentas del email)
//   · proofContactHtml   → platform_proof_contact_html (a dónde mandar el
//                          comprobante)
//   · formatArsCents     → platform_format_ars
//   · paymentReference   → referencia sugerida para la transferencia
// Más la validación de lo que informa el cliente con "Ya transferí". Sin
// Supabase: se testean en tests/unit/paymentNotice.test.ts.
// =============================================================================

import { isValidAlias, isValidCbu } from "@/lib/payments/transfer";

export type StatementFrequency = "per_period" | "every_n_days" | "monthly_day";

export const STATEMENT_FREQUENCY_LABELS: Record<StatementFrequency, string> = {
  per_period: "Una vez por cuota",
  every_n_days: "Cada N días hasta que pague",
  monthly_day: "Un resumen por mes",
};

export interface NoticeRule {
  frequency: StatementFrequency;
  /** Días antes del vencimiento en que sale el primer aviso. */
  leadDays: number;
  /** Cada cuántos días se repite (every_n_days). */
  everyDays: number;
  /** Día del mes del resumen (monthly_day). */
  statementDay: number;
}

const DAY = 86_400_000;

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
}

function lastDayOfMonth(iso: string): number {
  const [y, m] = iso.slice(0, 10).split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Clave del aviso de una cuota que corresponde mandar hoy, o null si todavía
 * no toca. Idempotente: el cron no manda dos avisos con la misma clave.
 *   · per_period:   uno por cuota, desde `leadDays` antes del vencimiento.
 *   · every_n_days: el primero igual y después uno cada `everyDays` mientras
 *                   la cuota siga impaga.
 */
export function noticeKey(rule: NoticeRule, charge: { id: string; due_date: string }, today: string): string | null {
  if (rule.frequency === "monthly_day") return null;
  const start = dayNumber(charge.due_date) - Math.max(0, Math.trunc(rule.leadDays));
  const now = dayNumber(today);
  if (now < start) return null;
  if (rule.frequency === "per_period") return `notice:${charge.id}`;
  const every = Math.max(1, Math.trunc(rule.everyDays));
  return `notice:${charge.id}:${Math.floor((now - start) / every)}`;
}

/**
 * Clave del resumen mensual (monthly_day) o null si hoy no toca. Si el día
 * elegido no existe en el mes (31 en febrero), sale el último día.
 */
export function statementKey(rule: NoticeRule, tenantId: string, today: string, openCents: number): string | null {
  if (rule.frequency !== "monthly_day" || openCents <= 0) return null;
  const day = Number(today.slice(8, 10));
  const target = Math.min(Math.max(1, Math.trunc(rule.statementDay)), lastDayOfMonth(today));
  if (day < target) return null;
  return `statement:${tenantId}:${today.slice(0, 7)}`;
}

// ── Formato ─────────────────────────────────────────────────────────────────

/** "$ 12.500,00" (mismo formato que platform_format_ars). */
export function formatArsCents(cents: number): string {
  const n = Math.round(Number(cents) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const int = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const dec = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$ ${int},${dec}`;
}

export function escapeHtml(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Referencia sugerida para la transferencia: NS-<slug>. */
export function paymentReference(slug: string | null | undefined): string {
  const s = String(slug ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 24);
  return s ? `NS-${s}` : "NS";
}

/** "0000 0000 0000 0000 0000 00" para leer un CBU / CVU. */
export function groupCbu(cbu: string | null | undefined): string {
  const d = String(cbu ?? "").replace(/\D/g, "");
  return d.replace(/(\d{4})(?=\d)/g, "$1 ");
}

// ── Bloques HTML del email (los valores vienen de la base: se escapan) ─────

export interface NoticeBankAccount {
  bank_name: string;
  holder_name: string;
  cuit: string | null;
  cbu: string | null;
  alias: string | null;
}

const SOFT = "#f7f6fb";
const HAIR = "#ecebf3";
const INK = "#09051C";
const MUTED = "#6b7280";

function row(label: string, value: string, first: boolean): string {
  const border = first ? "" : `border-top:1px solid ${HAIR};`;
  return (
    `<tr><td style="padding:10px 20px;${border}font-size:13px;line-height:18px;color:${MUTED}">${label}</td>` +
    `<td align="right" style="padding:10px 20px;${border}font-size:14px;line-height:18px;font-weight:700;color:${INK}">${value}</td></tr>`
  );
}

/** Una tarjeta por cuenta: banco, titular, CUIT, CBU / CVU y alias. */
export function bankBlockHtml(accounts: NoticeBankAccount[]): string {
  if (accounts.length === 0) return "";
  const cards = accounts.map((a) => {
    const rows: string[] = [];
    rows.push(row("Titular", escapeHtml(a.holder_name), true));
    if (a.cuit) rows.push(row("CUIT", escapeHtml(a.cuit), false));
    if (a.cbu) rows.push(row(a.cbu.startsWith("000") ? "CVU" : "CBU", escapeHtml(a.cbu), false));
    if (a.alias) rows.push(row("Alias", escapeHtml(a.alias), false));
    return (
      `<p style="margin:16px 0 8px;font-size:14px;line-height:20px;font-weight:700;color:${INK}">${escapeHtml(a.bank_name)}</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${SOFT}" style="background:${SOFT};border-radius:16px">` +
      rows.join("") +
      `</table>`
    );
  });
  return (
    `<p style="margin:8px 0 0;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${MUTED}">Datos para transferir</p>` +
    cards.join("")
  );
}

/** Línea "Mandanos el comprobante a ..." con email y WhatsApp. */
export function proofContactHtml(email: string | null | undefined, whatsapp: string | null | undefined): string {
  const e = String(email ?? "").trim();
  const w = String(whatsapp ?? "").trim();
  if (!e && !w) return "";
  const parts: string[] = [];
  if (e) parts.push(`<a href="mailto:${escapeHtml(e)}" style="color:${INK};font-weight:700">${escapeHtml(e)}</a>`);
  if (w) {
    const digits = w.replace(/\D/g, "");
    parts.push(`<a href="https://wa.me/${digits}" style="color:${INK};font-weight:700">WhatsApp ${escapeHtml(w)}</a>`);
  }
  return (
    `<p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:${MUTED}">Cuando transfieras, mandanos el comprobante a ` +
    parts.join(" o ") +
    ` o subilo desde tu panel con el botón Ya transferí.</p>`
  );
}

// ── "Ya transferí" ──────────────────────────────────────────────────────────

export const PROOF_MAX_BYTES = 10 * 1024 * 1024;
export const PROOF_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;

export interface TransferReportInput {
  amountCents: number | null;
  paidOn: string;
  today: string;
  file: { size: number; type: string } | null;
}

export type TransferReportErrors = Partial<Record<"amount" | "paidOn" | "file", string>>;

export function validateTransferReport(v: TransferReportInput): TransferReportErrors {
  const errors: TransferReportErrors = {};
  if (v.amountCents === null || v.amountCents <= 0) errors.amount = "Ingresá el importe que transferiste";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.paidOn)) errors.paidOn = "Elegí la fecha de la transferencia";
  else if (v.paidOn > v.today) errors.paidOn = "La fecha no puede ser futura";
  else if (dayNumber(v.today) - dayNumber(v.paidOn) > 120) errors.paidOn = "La transferencia tiene más de 120 días";
  if (!v.file) errors.file = "Adjuntá el comprobante";
  else if (!(PROOF_MIME as readonly string[]).includes(v.file.type)) errors.file = "Subí un PDF, JPG, PNG o WebP";
  else if (v.file.size > PROOF_MAX_BYTES) errors.file = "El archivo pesa más de 10 MB";
  return errors;
}

/** Extensión del archivo del comprobante según su tipo. */
export function proofExtension(mime: string): string {
  switch (mime) {
    case "application/pdf":
      return "pdf";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

/** Cuenta para cobrar válida: titular, y CBU / CVU válido o alias válido. */
export function bankAccountUsable(a: { holder_name: string; cbu: string | null; alias: string | null }): boolean {
  if (!a.holder_name.trim()) return false;
  const cbuOk = a.cbu ? isValidCbu(a.cbu) : false;
  const aliasOk = a.alias ? isValidAlias(a.alias) : false;
  return cbuOk || aliasOk;
}

// ── Modalidad ───────────────────────────────────────────────────────────────

export type BillingModeKey = "mp_subscription" | "account" | "manual" | "exempt";

export interface ModeChangePlan {
  /** Hay que cancelar el débito automático en Mercado Pago. */
  cancelsPreapproval: boolean;
  /** Hay que mandarle al cliente el checkout de Mercado Pago. */
  needsCheckout: boolean;
  /** El cambio rige ya o queda pendiente hasta el primer débito. */
  effective: "now" | "after_first_debit";
}

/**
 * Qué implica pasar de una modalidad a otra (lo mismo que decide
 * internal_billing_change_mode en el servidor):
 *   · a Mercado Pago: el cliente completa el checkout y, hasta el primer
 *     débito aprobado, sigue en la modalidad anterior;
 *   · a cualquier otra con un preapproval vivo: se cancela en Mercado Pago
 *     para que no cobre doble.
 */
export function modeChangePlan(to: BillingModeKey, hasPreapproval: boolean): ModeChangePlan {
  if (to === "mp_subscription") return { cancelsPreapproval: false, needsCheckout: true, effective: "after_first_debit" };
  return { cancelsPreapproval: hasPreapproval, needsCheckout: false, effective: "now" };
}
