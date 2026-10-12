// lib/purchases/aging.ts
//
// Cuenta corriente de proveedores (F18 · H101, ADR-050). Lógica PURA sobre las
// filas de la vista supplier_account_entries: saldo y antigüedad de deuda
// (aging) aplicando pagos y notas de crédito a los comprobantes más viejos
// primero (FIFO por vencimiento). Montos en pesos al tipo de cambio de cada
// comprobante.

import { round } from "./costs";

export type EntryType = "invoice" | "debit_note" | "credit_note" | "payment";

export const ENTRY_TYPE_LABEL: Record<EntryType, string> = {
  invoice: "Factura",
  debit_note: "Nota de débito",
  credit_note: "Nota de crédito",
  payment: "Pago",
};

export interface AccountEntry {
  doc_id: string;
  entry_type: EntryType;
  doc_label: string;
  doc_date: string;
  due_date: string;
  /** > 0 deuda; < 0 pago o nota de crédito. */
  amount_ars: number;
  supplier_id?: string;
}

export type AgingBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

export const AGING_BUCKETS: AgingBucket[] = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"];

export const AGING_LABEL: Record<AgingBucket, string> = {
  current: "A vencer",
  d1_30: "1 a 30 días",
  d31_60: "31 a 60 días",
  d61_90: "61 a 90 días",
  d90_plus: "Más de 90 días",
};

export interface OpenDocument {
  doc_id: string;
  doc_label: string;
  entry_type: EntryType;
  doc_date: string;
  due_date: string;
  amount: number;
  open: number;
  days_overdue: number;
  bucket: AgingBucket;
}

export interface AgingResult {
  balance: number;
  buckets: Record<AgingBucket, number>;
  /** Saldo a favor (pagos o NC sin aplicar). */
  credit: number;
  overdue: number;
  open: OpenDocument[];
}

/** Días entre dos fechas YYYY-MM-DD (b - a), sin corrimiento por zona horaria. */
export function daysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86_400_000);
}

export function bucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d90_plus";
}

export function accountBalance(entries: Pick<AccountEntry, "amount_ars">[]): number {
  return round(entries.reduce((t, e) => t + Number(e.amount_ars), 0), 2);
}

/**
 * Aging FIFO: los créditos (pagos y NC) cancelan los comprobantes de deuda por
 * orden de vencimiento (y de fecha); lo que queda abierto se agrupa por días de
 * atraso a `today`. Si los créditos superan la deuda, el excedente es saldo a
 * favor.
 */
export function supplierAging(entries: AccountEntry[], today: string): AgingResult {
  const debts = entries
    .filter((e) => Number(e.amount_ars) > 0)
    .sort(
      (a, b) =>
        a.due_date.localeCompare(b.due_date) ||
        a.doc_date.localeCompare(b.doc_date) ||
        a.doc_label.localeCompare(b.doc_label),
    )
    .map((e) => ({ e, open: Number(e.amount_ars) }));

  let credit = round(
    entries.filter((e) => Number(e.amount_ars) < 0).reduce((t, e) => t - Number(e.amount_ars), 0),
    2,
  );

  for (const d of debts) {
    if (credit <= 0) break;
    const used = Math.min(d.open, credit);
    d.open = round(d.open - used, 2);
    credit = round(credit - used, 2);
  }

  const buckets: Record<AgingBucket, number> = {
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
  };
  const open: OpenDocument[] = [];
  for (const d of debts) {
    if (d.open <= 0) continue;
    const days = daysBetween(d.e.due_date, today);
    const bucket = bucketFor(days);
    buckets[bucket] = round(buckets[bucket] + d.open, 2);
    open.push({
      doc_id: d.e.doc_id,
      doc_label: d.e.doc_label,
      entry_type: d.e.entry_type,
      doc_date: d.e.doc_date,
      due_date: d.e.due_date,
      amount: Number(d.e.amount_ars),
      open: d.open,
      days_overdue: Math.max(days, 0),
      bucket,
    });
  }

  const overdue = round(
    buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus,
    2,
  );
  return { balance: accountBalance(entries), buckets, credit, overdue, open };
}

/** Aging de todos los proveedores (agrupa por supplier_id). */
export function agingBySupplier(
  entries: AccountEntry[],
  today: string,
): Map<string, AgingResult> {
  const by = new Map<string, AccountEntry[]>();
  for (const e of entries) {
    const k = e.supplier_id ?? "";
    const list = by.get(k) ?? [];
    list.push(e);
    by.set(k, list);
  }
  const out = new Map<string, AgingResult>();
  for (const [k, list] of by) out.set(k, supplierAging(list, today));
  return out;
}

export interface LedgerRow extends AccountEntry {
  running: number;
}

/** Movimientos en orden cronológico con saldo acumulado. */
export function ledgerWithRunning(entries: AccountEntry[]): LedgerRow[] {
  const sorted = [...entries].sort(
    (a, b) => a.doc_date.localeCompare(b.doc_date) || a.doc_label.localeCompare(b.doc_label),
  );
  let run = 0;
  return sorted.map((e) => {
    run = round(run + Number(e.amount_ars), 2);
    return { ...e, running: run };
  });
}
