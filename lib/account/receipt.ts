// F24 · H160 (ADR-179): recibo de cuenta corriente con varios medios.
// Matemática y validación PURAS (sin React ni Supabase), espejo de
// account_collect_multi (supabase/migrations/20270117100000_h160_cobros.sql):
//   - cada línea es un medio (efectivo, transferencia, tarjeta, QR, otro,
//     cheque, e-cheq) o una retención sufrida (IIBB, IVA, Ganancias, SUSS);
//   - las líneas tienen que sumar lo que cancela el recibo; la diferencia,
//     hasta la tolerancia del negocio, va como ajuste por redondeo;
//   - el cheque y el e-cheq entran a la cartera de Tesorería como cheque de
//     terceros "en cartera".

import { isValidCuit, normalizeDigits } from "@/lib/tax/catalog";

export type ReceiptPayMethod = "cash" | "debit" | "credit" | "transfer" | "qr" | "other" | "cheque" | "echeq";
export type ReceiptRetentionTax = "iibb" | "iva" | "ganancias" | "suss";

export interface ReceiptCheque {
  number: string;
  bank_name?: string | null;
  /** AAAA-MM-DD. */
  payment_date: string;
  issue_date?: string | null;
  drawer_name?: string | null;
  drawer_cuit?: string | null;
}

export type ReceiptLine =
  | {
      kind: "payment";
      method: ReceiptPayMethod;
      amount: number;
      reference?: string | null;
      transfer_account_id?: string | null;
      cheque?: ReceiptCheque | null;
    }
  | {
      kind: "retention";
      tax: ReceiptRetentionTax;
      amount: number;
      /** Código de jurisdicción (tax_jurisdictions.code), obligatorio en IIBB. */
      jurisdiction?: string | null;
      certificate?: string | null;
      agent_cuit?: string | null;
    };

export const RECEIPT_METHOD_LABEL: Record<ReceiptPayMethod | "retention" | "rounding", string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR",
  other: "Otro",
  cheque: "Cheque",
  echeq: "E-cheq",
  retention: "Retención",
  rounding: "Redondeo",
};

export const RETENTION_TAX_LABEL: Record<ReceiptRetentionTax, string> = {
  iibb: "IIBB",
  iva: "IVA",
  ganancias: "Ganancias",
  suss: "SUSS",
};

/** Tolerancia por defecto (pos_settings.receipt_rounding_tolerance). */
export const DEFAULT_ROUNDING_TOLERANCE = 10;

const cents = (n: number) => Math.round((Number(n) || 0) * 100);

export interface ReceiptTotals {
  /** Suma de las líneas (medios y retenciones). */
  linesTotal: number;
  /** Lo que cancela el recibo. */
  total: number;
  /** total - linesTotal: positivo = falta (redondeo a favor del cliente). */
  diff: number;
  /** Ajuste por redondeo que se registra (0 si cuadra). */
  rounding: number;
  /** ¿Se puede grabar? (la diferencia entra en la tolerancia). */
  balanced: boolean;
}

export function receiptTotals(
  lines: Pick<ReceiptLine, "amount">[],
  total: number | null | undefined,
  tolerance: number = DEFAULT_ROUNDING_TOLERANCE,
): ReceiptTotals {
  const linesC = lines.reduce((a, l) => a + cents(l.amount), 0);
  const totalC = total != null && total > 0 ? cents(total) : linesC;
  const diffC = totalC - linesC;
  const tolC = Math.max(0, cents(tolerance));
  const balanced = totalC > 0 && linesC > 0 && Math.abs(diffC) <= tolC;
  return {
    linesTotal: linesC / 100,
    total: totalC / 100,
    diff: diffC / 100,
    rounding: balanced ? diffC / 100 : 0,
    balanced,
  };
}

export type ReceiptLineError =
  | "invalid_amount"
  | "cheque_data_required"
  | "payment_date_required"
  | "invalid_cuit"
  | "suffered_jurisdiction_required";

/** Errores de una línea (los mismos códigos que el servidor). */
export function receiptLineError(l: ReceiptLine): ReceiptLineError | null {
  if (!(cents(l.amount) > 0)) return "invalid_amount";
  if (l.kind === "payment" && (l.method === "cheque" || l.method === "echeq")) {
    const c = l.cheque;
    if (!c || !c.number.trim() || c.number.trim().length > 30) return "cheque_data_required";
    if (!c.payment_date) return "payment_date_required";
    const cuit = normalizeDigits(c.drawer_cuit ?? "");
    if (cuit && !isValidCuit(cuit)) return "invalid_cuit";
  }
  if (l.kind === "retention" && l.tax === "iibb" && !l.jurisdiction) return "suffered_jurisdiction_required";
  return null;
}

/** Payload de account_collect_multi (p_lines). */
export function toReceiptRpcLines(lines: ReceiptLine[]): Record<string, unknown>[] {
  return lines.map((l) => {
    const amount = cents(l.amount) / 100;
    if (l.kind === "retention") {
      return {
        kind: "retention",
        tax: l.tax,
        amount,
        ...(l.tax === "iibb" && l.jurisdiction ? { jurisdiction: l.jurisdiction } : {}),
        ...(l.certificate?.trim() ? { certificate: l.certificate.trim() } : {}),
        ...(normalizeDigits(l.agent_cuit ?? "") ? { agent_cuit: normalizeDigits(l.agent_cuit ?? "") } : {}),
      };
    }
    return {
      kind: "payment",
      method: l.method,
      amount,
      ...(l.reference?.trim() ? { reference: l.reference.trim() } : {}),
      ...(l.method === "transfer" && l.transfer_account_id ? { transfer_account_id: l.transfer_account_id } : {}),
      ...((l.method === "cheque" || l.method === "echeq") && l.cheque
        ? {
            cheque: {
              number: l.cheque.number.trim(),
              payment_date: l.cheque.payment_date,
              ...(l.cheque.bank_name?.trim() ? { bank_name: l.cheque.bank_name.trim() } : {}),
              ...(l.cheque.issue_date ? { issue_date: l.cheque.issue_date } : {}),
              ...(l.cheque.drawer_name?.trim() ? { drawer_name: l.cheque.drawer_name.trim() } : {}),
              ...(normalizeDigits(l.cheque.drawer_cuit ?? "") ? { drawer_cuit: normalizeDigits(l.cheque.drawer_cuit ?? "") } : {}),
            },
          }
        : {}),
    };
  });
}

/** ¿Hace falta el recibo con varios medios? (si no, alcanza account_collect). */
export function needsMultiReceipt(lines: ReceiptLine[], t: ReceiptTotals): boolean {
  if (lines.length !== 1 || t.rounding !== 0) return true;
  const l = lines[0]!;
  return l.kind === "retention" || l.method === "cheque" || l.method === "echeq";
}

/**
 * Cheque que el recibo da de alta en la cartera (espejo del insert de
 * account_collect_multi): de terceros, en cartera, recibido del cliente.
 */
export function chequeForCartera(
  l: Extract<ReceiptLine, { kind: "payment" }>,
  customer: { id: string; name: string },
): {
  kind: "third_party";
  status: "en_cartera";
  is_echeq: boolean;
  number: string;
  bank_name: string | null;
  payment_date: string;
  amount: number;
  drawer_cuit: string | null;
  received_from_customer_id: string;
  received_from: string;
} | null {
  if ((l.method !== "cheque" && l.method !== "echeq") || !l.cheque) return null;
  return {
    kind: "third_party",
    status: "en_cartera",
    is_echeq: l.method === "echeq",
    number: l.cheque.number.trim(),
    bank_name: l.cheque.bank_name?.trim() || null,
    payment_date: l.cheque.payment_date,
    amount: cents(l.amount) / 100,
    drawer_cuit: normalizeDigits(l.cheque.drawer_cuit ?? "") || null,
    received_from_customer_id: customer.id,
    received_from: customer.name.slice(0, 120),
  };
}

/**
 * Monto de cada línea en edición: lo tipeado, y la primera vacía toma lo que
 * falta para llegar al total (las demás vacías, 0).
 */
export function fillReceiptAmounts(typed: (number | null)[], total: number): number[] {
  const typedC = typed.reduce<number>((a, t) => a + (t != null && t > 0 ? cents(t) : 0), 0);
  let rest = Math.max(0, cents(total) - typedC);
  return typed.map((t) => {
    if (t != null) return t > 0 ? cents(t) / 100 : 0;
    const v = rest;
    rest = 0;
    return v / 100;
  });
}
