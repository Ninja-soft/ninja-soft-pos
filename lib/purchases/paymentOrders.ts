// lib/purchases/paymentOrders.ts
//
// Órdenes de pago a proveedores (F18 · H101 + H106 + H111, ADR-059). Lógica
// PURA: totales, imputación a comprobantes (manual o automática por
// vencimiento) y validación, espejo de supplier_payment_order_create
// (migración 20261022100400). Montos en pesos.

import { round } from "./costs";
import type { WithholdingLine } from "./invoices";

export type PaymentLineMethod =
  | "efectivo"
  | "transferencia"
  | "cheque_propio"
  | "cheque_tercero"
  | "echeq"
  | "deposito"
  | "tarjeta"
  | "otro";

export const PAYMENT_LINE_METHODS: PaymentLineMethod[] = [
  "transferencia",
  "efectivo",
  "cheque_propio",
  "echeq",
  "cheque_tercero",
  "deposito",
  "tarjeta",
  "otro",
];

export const PAYMENT_LINE_METHOD_LABEL: Record<PaymentLineMethod, string> = {
  efectivo: "Efectivo de mi caja",
  transferencia: "Transferencia",
  cheque_propio: "Cheque propio",
  cheque_tercero: "Cheque de terceros",
  echeq: "E-cheq propio",
  deposito: "Depósito",
  tarjeta: "Tarjeta",
  otro: "Otro",
};

/** Medios que mueven una cuenta o un cheque de tesorería (exigen la feature). */
export const TREASURY_METHODS: PaymentLineMethod[] = ["cheque_propio", "echeq", "cheque_tercero"];

export function methodNeedsTreasury(method: PaymentLineMethod, hasAccount: boolean): boolean {
  if (TREASURY_METHODS.includes(method)) return true;
  return (method === "transferencia" || method === "deposito") && hasAccount;
}

export interface PaymentLineDraft {
  method: PaymentLineMethod;
  amount: number;
  treasury_account_id?: string | null;
  cheque_id?: string | null;
  cheque?: { number: string; payment_date: string; bank_name?: string | null } | null;
  reference?: string | null;
}

export interface AllocationDraft {
  invoice_id: string;
  amount: number;
}

export interface OpenInvoice {
  invoice_id: string;
  label: string;
  issue_date: string;
  due_date: string;
  amount_ars: number;
  open_ars: number;
}

export interface PaymentOrderTotals {
  net: number;
  withholdings: number;
  total: number;
  allocated: number;
  /** Lo que queda a cuenta (anticipo o saldo a favor). */
  onAccount: number;
}

export function paymentOrderTotals(
  lines: Pick<PaymentLineDraft, "amount">[],
  withholdings: Pick<WithholdingLine, "amount">[],
  allocations: Pick<AllocationDraft, "amount">[],
): PaymentOrderTotals {
  const net = round(lines.reduce((t, l) => t + (Number(l.amount) || 0), 0), 2);
  const wh = round(withholdings.reduce((t, w) => t + (Number(w.amount) || 0), 0), 2);
  const total = round(net + wh, 2);
  const allocated = round(allocations.reduce((t, a) => t + (Number(a.amount) || 0), 0), 2);
  return { net, withholdings: wh, total, allocated, onAccount: round(total - allocated, 2) };
}

/**
 * Imputación automática: reparte `amount` entre los comprobantes abiertos por
 * vencimiento (y fecha), el más viejo primero. Lo que sobra queda a cuenta.
 */
export function autoAllocate(amount: number, docs: OpenInvoice[]): AllocationDraft[] {
  let left = round(Math.max(Number(amount) || 0, 0), 2);
  const sorted = [...docs]
    .filter((d) => d.open_ars > 0.004)
    .sort(
      (a, b) =>
        a.due_date.localeCompare(b.due_date) ||
        a.issue_date.localeCompare(b.issue_date) ||
        a.label.localeCompare(b.label),
    );
  const out: AllocationDraft[] = [];
  for (const d of sorted) {
    if (left <= 0) break;
    const take = round(Math.min(left, d.open_ars), 2);
    if (take <= 0) continue;
    out.push({ invoice_id: d.invoice_id, amount: take });
    left = round(left - take, 2);
  }
  return out;
}

/** Saldo que queda en cada comprobante después de la imputación propuesta. */
export function openAfter(docs: OpenInvoice[], allocations: AllocationDraft[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of docs) out.set(d.invoice_id, d.open_ars);
  for (const a of allocations) {
    out.set(a.invoice_id, round((out.get(a.invoice_id) ?? 0) - (Number(a.amount) || 0), 2));
  }
  return out;
}

export interface PaymentOrderDraft {
  lines: PaymentLineDraft[];
  withholdings: WithholdingLine[];
  allocations: AllocationDraft[];
}

export interface PaymentOrderContext {
  openDocs: OpenInvoice[];
  hasTreasury: boolean;
  hasOpenShift: boolean;
  /** Cheques de terceros en cartera: id → importe. */
  chequesInWallet?: Map<string, number>;
}

/** Errores que bloquean la OP (igual que el servidor). */
export function validatePaymentOrder(d: PaymentOrderDraft, ctx: PaymentOrderContext): string[] {
  const errors: string[] = [];
  const totals = paymentOrderTotals(d.lines, d.withholdings, d.allocations);

  if (d.lines.length === 0 && totals.withholdings <= 0) errors.push("Cargá al menos un medio de pago.");
  if (d.lines.some((l) => !(l.amount > 0))) errors.push("Cada medio tiene que tener un importe mayor a cero.");
  if (d.withholdings.some((w) => w.amount < 0)) errors.push("Las retenciones no pueden ser negativas.");
  if (d.withholdings.some((w) => (w.certificate ?? "").length > 40)) {
    errors.push("El n° de certificado tiene hasta 40 caracteres.");
  }
  if (!(totals.total > 0)) errors.push("El total de la orden tiene que ser mayor a cero.");

  for (const l of d.lines) {
    if (methodNeedsTreasury(l.method, Boolean(l.treasury_account_id)) && !ctx.hasTreasury) {
      errors.push("Los cheques y las cuentas bancarias requieren Tesorería en tu plan.");
      break;
    }
  }
  if (d.lines.some((l) => l.method === "efectivo") && !ctx.hasOpenShift) {
    errors.push("Para pagar en efectivo tenés que tener tu caja abierta.");
  }
  for (const l of d.lines) {
    if ((l.method === "cheque_propio" || l.method === "echeq") && !l.treasury_account_id) {
      errors.push("Elegí la cuenta bancaria del cheque propio.");
    }
    if ((l.method === "cheque_propio" || l.method === "echeq") && (!l.cheque?.number || !l.cheque.payment_date)) {
      errors.push("Completá el número y la fecha de pago del cheque.");
    }
    if (l.method === "cheque_tercero") {
      if (!l.cheque_id) errors.push("Elegí el cheque de terceros que entregás.");
      else if (ctx.chequesInWallet && !ctx.chequesInWallet.has(l.cheque_id)) {
        errors.push("El cheque elegido ya no está en cartera.");
      } else if (ctx.chequesInWallet && Math.abs((ctx.chequesInWallet.get(l.cheque_id) ?? 0) - l.amount) > 0.004) {
        errors.push("El importe del cheque de terceros tiene que ser el del cheque.");
      }
    }
  }
  const chequeIds = d.lines.map((l) => l.cheque_id).filter((x): x is string => Boolean(x));
  if (new Set(chequeIds).size !== chequeIds.length) errors.push("El mismo cheque está dos veces.");

  const open = new Map(ctx.openDocs.map((x) => [x.invoice_id, x.open_ars]));
  const seen = new Set<string>();
  for (const a of d.allocations) {
    if (a.amount < 0) errors.push("La imputación no puede ser negativa.");
    if (seen.has(a.invoice_id)) errors.push("Un comprobante está imputado dos veces.");
    seen.add(a.invoice_id);
    const o = open.get(a.invoice_id);
    if (o == null) errors.push("Hay un comprobante que no se puede imputar.");
    else if (a.amount > o + 0.005) errors.push("Imputaste más que el saldo de un comprobante.");
  }
  if (totals.allocated > totals.total + 0.005) errors.push("Imputaste más que el total de la orden.");
  return [...new Set(errors)];
}

/** Método resumen de la cabecera (espejo del servidor). */
export function headerMethod(lines: Pick<PaymentLineDraft, "method">[]): string {
  const set = [...new Set(lines.map((l) => l.method))];
  if (set.length === 0) return "otro";
  if (set.length > 1) return "mixto";
  const m = set[0]!;
  return m === "cheque_propio" || m === "cheque_tercero" ? "cheque" : m;
}

/** Importe en letras (para la orden de pago impresa). Pesos y centavos. */
export function amountInWords(amount: number): string {
  const n = Math.floor(Math.abs(amount));
  const cents = Math.round((Math.abs(amount) - n) * 100);
  const words = n === 0 ? "cero" : integerWords(n);
  return `${amount < 0 ? "menos " : ""}${words} con ${String(cents).padStart(2, "0")}/100`;
}

const UNITS = [
  "",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
  "veinte",
  "veintiuno",
  "veintidós",
  "veintitrés",
  "veinticuatro",
  "veinticinco",
  "veintiséis",
  "veintisiete",
  "veintiocho",
  "veintinueve",
];
const TENS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const HUNDREDS = [
  "",
  "ciento",
  "doscientos",
  "trescientos",
  "cuatrocientos",
  "quinientos",
  "seiscientos",
  "setecientos",
  "ochocientos",
  "novecientos",
];

function below1000(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cien";
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(HUNDREDS[h]!);
  if (r) {
    if (r < 30) parts.push(UNITS[r]!);
    else {
      const t = Math.floor(r / 10);
      const u = r % 10;
      parts.push(u ? `${TENS[t]} y ${UNITS[u]}` : TENS[t]!);
    }
  }
  return parts.join(" ");
}

function integerWords(n: number): string {
  if (n >= 1_000_000_000_000) return String(n);
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions) parts.push(millions === 1 ? "un millón" : `${integerWords(millions).replace(/veintiuno$/, "veintiún").replace(/uno$/, "un")} millones`);
  if (thousands) parts.push(thousands === 1 ? "mil" : `${below1000(thousands).replace(/veintiuno$/, "veintiún").replace(/uno$/, "un")} mil`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}
