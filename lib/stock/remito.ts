// lib/stock/remito.ts
//
// Armado PURO de las filas del remito interno de traslado (impresión y XLSX).

import { DIFFERENCE_REASON_LABEL, type DifferenceReason } from "./transfers";

export interface RemitoItem {
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  qty_requested: number;
  qty_dispatched: number | null;
  qty_received: number;
  difference_reason: DifferenceReason | null;
}

export interface RemitoRow {
  producto: string;
  sku: string;
  unidad: string;
  pedido: number;
  enviado: number | null;
  recibido: number | null;
  diferencia: number | null;
  motivo: string;
}

/**
 * Filas del remito. `showReception`: incluye recibido y diferencia (traslados
 * ya recibidos o en recepción); antes de despachar, "enviado" queda vacío.
 */
export function remitoRows(
  items: RemitoItem[],
  showReception: boolean,
): RemitoRow[] {
  return items.map((i) => {
    const sent = i.qty_dispatched == null ? null : Number(i.qty_dispatched);
    const got = showReception ? Number(i.qty_received) : null;
    const diff =
      showReception && sent != null
        ? Math.round((Number(i.qty_received) - sent) * 1000) / 1000
        : null;
    return {
      producto: i.variant_label
        ? `${i.product_name} (${i.variant_label})`
        : i.product_name,
      sku: i.sku ?? "",
      unidad: i.unit,
      pedido: Number(i.qty_requested),
      enviado: sent,
      recibido: got,
      diferencia: diff,
      motivo:
        diff && i.difference_reason
          ? DIFFERENCE_REASON_LABEL[i.difference_reason]
          : "",
    };
  });
}

export function remitoTotals(rows: RemitoRow[]): {
  pedido: number;
  enviado: number;
  recibido: number;
} {
  const sum = (k: "pedido" | "enviado" | "recibido") =>
    Math.round(rows.reduce((t, r) => t + Number(r[k] ?? 0), 0) * 1000) / 1000;
  return {
    pedido: sum("pedido"),
    enviado: sum("enviado"),
    recibido: sum("recibido"),
  };
}
