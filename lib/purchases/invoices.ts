// lib/purchases/invoices.ts
//
// Comprobantes de compra y pagos a proveedores (F18 · H101, ADR-050). Lógica
// PURA: totales, validación (espejo de supplier_invoice_save y
// supplier_payment_create, migración 20261016100300) y catálogos.

import { round } from "./costs";

export type InvoiceKind = "invoice" | "debit_note" | "credit_note";
export type InvoiceLetter = "A" | "B" | "C" | "M" | "E";

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  invoice: "Factura",
  debit_note: "Nota de débito",
  credit_note: "Nota de crédito",
};

export const INVOICE_LETTERS: InvoiceLetter[] = ["A", "B", "C", "M", "E"];

export const VAT_RATES = [21, 10.5, 27, 5, 2.5, 0] as const;

export type OtherTaxKind =
  | "percepcion_iva"
  | "percepcion_iibb"
  | "percepcion_ganancias"
  | "percepcion_municipal"
  | "impuesto_interno"
  | "otro";

export const OTHER_TAX_LABEL: Record<OtherTaxKind, string> = {
  percepcion_iva: "Percepción de IVA",
  percepcion_iibb: "Percepción de IIBB",
  percepcion_ganancias: "Percepción de Ganancias",
  percepcion_municipal: "Percepción municipal",
  impuesto_interno: "Impuestos internos",
  otro: "Otro tributo",
};

export interface VatLine {
  rate: number;
  net: number;
  vat: number;
}

export interface OtherTaxLine {
  kind: OtherTaxKind;
  description?: string | null;
  jurisdiction?: string | null;
  amount: number;
}

export interface InvoiceDraft {
  kind: InvoiceKind;
  letter: InvoiceLetter;
  point_of_sale: number;
  number: number;
  issue_date: string;
  due_date?: string | null;
  vat_lines: VatLine[];
  exempt_amount: number;
  non_taxed_amount: number;
  other_taxes: OtherTaxLine[];
  total: number;
}

/** B y C no discriminan IVA (el importe va entero como neto). */
export function letterDiscriminatesVat(letter: InvoiceLetter): boolean {
  return letter === "A" || letter === "M";
}

/** IVA sugerido de un neto a una alícuota. */
export function vatFor(net: number, rate: number): number {
  return round((net * rate) / 100, 2);
}

export interface InvoiceTotals {
  net: number;
  vat: number;
  other: number;
  total: number;
}

export function invoiceTotals(
  d: Pick<InvoiceDraft, "vat_lines" | "exempt_amount" | "non_taxed_amount" | "other_taxes">,
): InvoiceTotals {
  const net = round(d.vat_lines.reduce((t, l) => t + (Number(l.net) || 0), 0), 2);
  const vat = round(d.vat_lines.reduce((t, l) => t + (Number(l.vat) || 0), 0), 2);
  const other = round(d.other_taxes.reduce((t, l) => t + (Number(l.amount) || 0), 0), 2);
  const total = round(
    net + vat + (Number(d.exempt_amount) || 0) + (Number(d.non_taxed_amount) || 0) + other,
    2,
  );
  return { net, vat, other, total };
}

export interface InvoiceValidation {
  errors: string[];
  warnings: string[];
  totals: InvoiceTotals;
}

/** Validación del comprobante: errores bloquean (igual que el servidor), avisos no. */
export function validateInvoice(d: InvoiceDraft): InvoiceValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const totals = invoiceTotals(d);

  if (!(d.point_of_sale >= 1 && d.point_of_sale <= 99999)) {
    errors.push("El punto de venta va de 1 a 99999.");
  }
  if (!(d.number >= 1 && d.number <= 99_999_999)) {
    errors.push("El número va de 1 a 99999999.");
  }
  if (!d.issue_date) errors.push("Falta la fecha del comprobante.");
  if (d.due_date && d.issue_date && d.due_date < d.issue_date) {
    errors.push("El vencimiento no puede ser anterior a la fecha.");
  }
  for (const l of d.vat_lines) {
    if (!(VAT_RATES as readonly number[]).includes(Number(l.rate))) {
      errors.push(`Alícuota de IVA inválida: ${l.rate} %.`);
    }
    if (l.net < 0 || l.vat < 0) errors.push("Los importes no pueden ser negativos.");
    else if (Math.abs(vatFor(l.net, l.rate) - l.vat) > Math.max(0.05, l.net * 0.001)) {
      warnings.push(
        `El IVA al ${String(l.rate).replace(".", ",")} % no coincide con el neto (esperado ${vatFor(l.net, l.rate).toFixed(2)}).`,
      );
    }
  }
  if (!letterDiscriminatesVat(d.letter) && totals.vat > 0) {
    errors.push(`Los comprobantes ${d.letter} no discriminan IVA.`);
  }
  if (d.other_taxes.some((t) => t.amount < 0) || d.exempt_amount < 0 || d.non_taxed_amount < 0) {
    errors.push("Los importes no pueden ser negativos.");
  }
  if (!(d.total > 0)) errors.push("El total tiene que ser mayor a cero.");
  else if (Math.abs(totals.total - d.total) > 0.01) {
    errors.push(
      `El total (${d.total.toFixed(2)}) no coincide con la suma de los importes (${totals.total.toFixed(2)}).`,
    );
  }
  return { errors, warnings, totals };
}

/** Vencimiento por defecto: fecha del comprobante + plazo del proveedor. */
export function defaultDueDate(issueDate: string, termsDays: number): string {
  const [y, m, d] = issueDate.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + (termsDays || 0)));
  return dt.toISOString().slice(0, 10);
}

export function formatInvoiceNumber(letter: string, pos: number, num: number): string {
  return `${letter} ${String(pos).padStart(5, "0")}-${String(num).padStart(8, "0")}`;
}

/**
 * "0001-00001234" o "00001-00001234" → { pos, number }. Devuelve null si no
 * tiene forma de punto de venta y número.
 */
export function parseInvoiceNumber(text: string): { pos: number; number: number } | null {
  const m = String(text).trim().match(/^(\d{1,5})\s*-\s*(\d{1,8})$/);
  if (!m) return null;
  return { pos: Number(m[1]), number: Number(m[2]) };
}

/**
 * Letra que corresponde según la condición del proveedor (sugerencia): el
 * monotributista y el exento emiten C; el responsable inscripto, A a un
 * responsable inscripto y B al resto.
 */
export function suggestedLetter(
  supplierIva: string,
  buyerIsRegistered: boolean,
): InvoiceLetter | null {
  if (supplierIva === "monotributo" || supplierIva === "exento") return "C";
  if (supplierIva === "responsable_inscripto") return buyerIsRegistered ? "A" : "B";
  return null;
}

// ── Pagos ───────────────────────────────────────────────────────────────────

export type PaymentMethod =
  | "efectivo"
  | "transferencia"
  | "cheque"
  | "echeq"
  | "tarjeta"
  | "deposito"
  | "otro";

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  transferencia: "Transferencia",
  efectivo: "Efectivo",
  echeq: "E-cheq",
  cheque: "Cheque",
  deposito: "Depósito",
  tarjeta: "Tarjeta",
  otro: "Otro",
};

/** Etiqueta del medio de un pago (las órdenes de pago con varios medios son "mixto"). */
export function paymentMethodLabel(method: string): string {
  if (method === "mixto") return "Varios medios";
  return PAYMENT_METHOD_LABEL[method as PaymentMethod] ?? method;
}

export type WithholdingKind ="ganancias" | "iva" | "iibb" | "suss" | "otro";

export const WITHHOLDING_LABEL: Record<WithholdingKind, string> = {
  ganancias: "Retención de Ganancias",
  iva: "Retención de IVA",
  iibb: "Retención de IIBB",
  suss: "Retención SUSS",
  otro: "Otra retención",
};

export interface WithholdingLine {
  kind: WithholdingKind;
  description?: string | null;
  certificate?: string | null;
  amount: number;
}

/** Deuda que cancela un pago: neto pagado + retenciones practicadas. */
export function paymentApplied(netPaid: number, withholdings: WithholdingLine[]): number {
  return round(
    (Number(netPaid) || 0) + withholdings.reduce((t, w) => t + (Number(w.amount) || 0), 0),
    2,
  );
}
