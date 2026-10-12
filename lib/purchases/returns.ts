// lib/purchases/returns.ts
//
// Devoluciones a proveedor y anulación de recepciones (F18 · H101, ADR-059).
// Lógica PURA, espejo de purchase_return_create y purchase_receipt_void
// (migración 20261022100200).

import { round } from "./costs";

export type ReturnReason = "danado" | "vencido" | "error_proveedor" | "sobrante" | "calidad" | "otro";

export const RETURN_REASONS: ReturnReason[] = ["danado", "vencido", "error_proveedor", "sobrante", "calidad", "otro"];

export const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  danado: "Dañado",
  vencido: "Vencido",
  error_proveedor: "Error del proveedor",
  sobrante: "Sobrante",
  calidad: "Problema de calidad",
  otro: "Otro",
};

export const formatReturnNumber = (n: number) => `DEV-${String(n).padStart(6, "0")}`;

/**
 * Costo promedio después de sacar `qty` unidades a `unitCost` (devolución al
 * proveedor o anulación de la recepción que las había sumado):
 *
 *   promedio nuevo = (S × P − q × c) / (S − q)
 *
 * S = stock total antes (negativo cuenta como cero), P = promedio, q =
 * unidades que salen, c = su costo. Si no queda stock el promedio no cambia;
 * nunca es negativo. Sin promedio o cantidad 0, no cambia.
 */
export function averageAfterOutflow(
  stockBefore: number,
  avg: number | null | undefined,
  qty: number,
  unitCost: number,
): number | null {
  if (avg == null) return null;
  if (!(qty > 0)) return avg;
  const s = Math.max(Number(stockBefore) || 0, 0);
  const remaining = s - qty;
  if (remaining <= 0) return avg;
  return Math.max(round((s * avg - qty * (Number(unitCost) || 0)) / remaining, 4), 0);
}

/** Lo que todavía se puede devolver de una línea de recepción. */
export function returnableQty(line: { qty: number; qty_returned?: number | null }): number {
  return Math.max(round(Number(line.qty) - Number(line.qty_returned ?? 0), 3), 0);
}

export interface ReceiptVoidState {
  status: "posted" | "voided";
  invoice_id: string | null;
  has_returns: boolean;
  /** Algún lote de la recepción ya tiene consumos (ventas o devoluciones). */
  lots_consumed: boolean;
  /** Líneas cuyo stock en la sucursal no alcanza para sacarlas. */
  short_lines: string[];
}

export type ReceiptVoidBlocker = "voided" | "invoiced" | "returns" | "lots_consumed" | "stock_consumed";

export const RECEIPT_VOID_BLOCKER_LABEL: Record<ReceiptVoidBlocker, string> = {
  voided: "La recepción ya está anulada.",
  invoiced: "Tiene una factura vinculada: anulá o desvinculá la factura primero.",
  returns: "Tiene devoluciones al proveedor: no se puede anular.",
  lots_consumed: "Sus lotes ya se vendieron o devolvieron en parte: hacé una devolución o un ajuste.",
  stock_consumed: "No queda stock suficiente en la sucursal para sacar lo recibido: hacé una devolución o un ajuste.",
};

/** Motivos por los que una recepción no se puede anular (vacío = se puede). */
export function receiptVoidBlockers(s: ReceiptVoidState): ReceiptVoidBlocker[] {
  const out: ReceiptVoidBlocker[] = [];
  if (s.status === "voided") return ["voided"];
  if (s.invoice_id) out.push("invoiced");
  if (s.has_returns) out.push("returns");
  if (s.lots_consumed) out.push("lots_consumed");
  if (s.short_lines.length > 0) out.push("stock_consumed");
  return out;
}

export interface ReceiptLineCost {
  receipt_id: string;
  received_date: string;
  created_at: string;
  valued_unit_cost: number;
}

/**
 * Último costo después de anular una recepción: si la anulada era la más
 * reciente del producto, vuelve al costo valuado de la recepción vigente
 * anterior; si no había otra, al valor previo de la historia (`historyOld`);
 * si la anulada no era la última, no cambia.
 */
export function lastCostAfterVoid(
  voidedReceiptId: string,
  lines: ReceiptLineCost[],
  currentLast: number | null,
  historyOld: number | null,
): number | null {
  const sorted = [...lines].sort(
    (a, b) => b.received_date.localeCompare(a.received_date) || b.created_at.localeCompare(a.created_at),
  );
  if (sorted[0]?.receipt_id !== voidedReceiptId) return currentLast;
  const prev = sorted.find((l) => l.receipt_id !== voidedReceiptId);
  if (prev) return prev.valued_unit_cost;
  return historyOld ?? currentLast;
}

export interface ReturnLineDraft {
  qty: number;
  unit_cost: number;
  max?: number | null;
  store_qty?: number | null;
}

/** Errores de una devolución (espejo del servidor). */
export function validateReturn(lines: ReturnLineDraft[]): string[] {
  const errors: string[] = [];
  const active = lines.filter((l) => l.qty > 0);
  if (active.length === 0) errors.push("Cargá al menos una cantidad para devolver.");
  if (lines.some((l) => l.qty < 0)) errors.push("Las cantidades no pueden ser negativas.");
  if (active.some((l) => l.max != null && l.qty > l.max + 1e-9)) {
    errors.push("No podés devolver más de lo recibido en esa recepción.");
  }
  if (active.some((l) => l.store_qty != null && l.qty > l.store_qty + 1e-9)) {
    errors.push("No hay stock suficiente en la sucursal para devolver esa cantidad.");
  }
  if (active.some((l) => l.unit_cost < 0)) errors.push("El costo no puede ser negativo.");
  return errors;
}

export function returnTotals(lines: Array<{ qty: number; unit_cost: number }>): { units: number; value: number } {
  let units = 0;
  let value = 0;
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    units += l.qty;
    value += l.qty * l.unit_cost;
  }
  return { units: round(units, 3), value: round(value, 2) };
}
