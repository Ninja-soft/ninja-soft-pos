// lib/purchases/credits.ts
//
// NC y anticipos aplicados a comprobantes concretos (F24 · H167, ADR-178).
// PURO: validación espejo de _supplier_credit_apply y saldo de cada factura
// después de aplicar créditos e imputar pagos. Montos en pesos.

import { round } from "./costs";
import type { OpenInvoice } from "./paymentOrders";

export type CreditSourceType = "credit_note" | "payment";

/** Crédito disponible (vista supplier_credit_open). */
export interface OpenCredit {
  source_type: CreditSourceType;
  source_id: string;
  label: string;
  doc_date: string;
  amount_ars: number;
  applied_ars: number;
  available_ars: number;
}

export interface CreditApplicationDraft {
  source_type: CreditSourceType;
  source_id: string;
  invoice_id: string;
  amount: number;
}

export const CREDIT_SOURCE_LABEL: Record<CreditSourceType, string> = {
  credit_note: "Nota de crédito",
  payment: "Anticipo",
};

export function creditsTotal(apps: Pick<CreditApplicationDraft, "amount">[]): number {
  return round(apps.reduce((t, a) => t + (Number(a.amount) || 0), 0), 2);
}

/** Saldo de cada comprobante después de aplicar los créditos propuestos. */
export function openAfterCredits(docs: OpenInvoice[], apps: CreditApplicationDraft[]): OpenInvoice[] {
  const used = new Map<string, number>();
  for (const a of apps) used.set(a.invoice_id, round((used.get(a.invoice_id) ?? 0) + (Number(a.amount) || 0), 2));
  return docs.map((d) => ({ ...d, open_ars: round(d.open_ars - (used.get(d.invoice_id) ?? 0), 2) }));
}

/**
 * Aplica un crédito a los comprobantes más viejos primero (por vencimiento)
 * hasta `amount` (o todo lo disponible).
 */
export function autoApplyCredit(credit: OpenCredit, docs: OpenInvoice[], amount?: number): CreditApplicationDraft[] {
  let left = round(Math.min(amount ?? credit.available_ars, credit.available_ars), 2);
  const out: CreditApplicationDraft[] = [];
  const sorted = [...docs]
    .filter((d) => d.open_ars > 0.004)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.issue_date.localeCompare(b.issue_date));
  for (const d of sorted) {
    if (left <= 0) break;
    const take = round(Math.min(left, d.open_ars), 2);
    if (take <= 0) continue;
    out.push({ source_type: credit.source_type, source_id: credit.source_id, invoice_id: d.invoice_id, amount: take });
    left = round(left - take, 2);
  }
  return out;
}

/** Errores que bloquean (igual que el servidor). */
export function validateCreditApplications(
  apps: CreditApplicationDraft[],
  credits: OpenCredit[],
  docs: OpenInvoice[],
): string[] {
  const errors: string[] = [];
  const avail = new Map(credits.map((c) => [`${c.source_type}:${c.source_id}`, c.available_ars]));
  const open = new Map(docs.map((d) => [d.invoice_id, d.open_ars]));
  const usedCredit = new Map<string, number>();
  const usedDoc = new Map<string, number>();
  for (const a of apps) {
    if (!(a.amount > 0)) {
      errors.push("Cada crédito aplicado tiene que tener un importe mayor a cero.");
      continue;
    }
    const k = `${a.source_type}:${a.source_id}`;
    if (!avail.has(k)) errors.push("Hay un crédito que ya no está disponible.");
    if (!open.has(a.invoice_id)) errors.push("Hay un comprobante al que no se le puede aplicar el crédito.");
    usedCredit.set(k, round((usedCredit.get(k) ?? 0) + a.amount, 2));
    usedDoc.set(a.invoice_id, round((usedDoc.get(a.invoice_id) ?? 0) + a.amount, 2));
  }
  for (const [k, v] of usedCredit) {
    if (v > (avail.get(k) ?? 0) + 0.005) errors.push("Aplicaste más que el saldo disponible de un crédito.");
  }
  for (const [k, v] of usedDoc) {
    if (v > (open.get(k) ?? 0) + 0.005) errors.push("Aplicaste más que el saldo de un comprobante.");
  }
  return [...new Set(errors)];
}
