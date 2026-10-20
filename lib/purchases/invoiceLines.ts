// lib/purchases/invoiceLines.ts
//
// Renglones de la factura de compra (F24 · H167, ADR-178). PURO: artículos
// que también ingresan stock (la recepción la crea el servidor con
// purchase_receive) y gastos con cuenta contable. Espejo de
// supplier_invoice_save_full.

import { round } from "./costs";
import { vatFor, type VatLine } from "./invoices";

export type InvoiceLineKind = "item" | "expense";

export interface InvoiceLineDraft {
  kind: InvoiceLineKind;
  product_id?: string | null;
  variant_id?: string | null;
  description?: string | null;
  qty?: number | null;
  unit_cost?: number | null;
  vat_rate: number;
  /** Sólo gastos (en los artículos es qty × costo). */
  net?: number | null;
  account_id?: string | null;
}

export function lineNet(l: InvoiceLineDraft): number {
  if (l.kind === "item") return round((Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 2);
  return round(Number(l.net) || 0, 2);
}

/** Neto e IVA por alícuota que suman los renglones (para precargar). */
export function linesVat(lines: InvoiceLineDraft[]): VatLine[] {
  const by = new Map<number, number>();
  for (const l of lines) by.set(Number(l.vat_rate), round((by.get(Number(l.vat_rate)) ?? 0) + lineNet(l), 2));
  return [...by.entries()]
    .filter(([, net]) => net > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([rate, net]) => ({ rate, net, vat: vatFor(net, rate) }));
}

export function validateLines(
  lines: InvoiceLineDraft[],
  ctx: { invoiceNet: number; hasStore: boolean; editing: boolean },
): string[] {
  const errors: string[] = [];
  for (const l of lines) {
    if (l.kind === "item") {
      if (!l.product_id) errors.push("Elegí el artículo de cada renglón.");
      if (!((Number(l.qty) || 0) > 0)) errors.push("La cantidad de cada artículo tiene que ser mayor a cero.");
      if ((Number(l.unit_cost) || 0) < 0) errors.push("El costo no puede ser negativo.");
    } else {
      if (!String(l.description ?? "").trim()) errors.push("Escribí el detalle de cada gasto.");
      if (!(lineNet(l) > 0)) errors.push("El neto de cada gasto tiene que ser mayor a cero.");
    }
  }
  if (lines.some((l) => l.kind === "item")) {
    if (ctx.editing) errors.push("Los artículos con recepción se cargan sólo en el alta del comprobante.");
    if (!ctx.hasStore) errors.push("Elegí la sucursal que recibe la mercadería.");
  }
  const sum = round(lines.reduce((t, l) => t + lineNet(l), 0), 2);
  if (sum > ctx.invoiceNet + 0.01) {
    errors.push("Los renglones suman más que el neto del comprobante.");
  }
  return [...new Set(errors)];
}
