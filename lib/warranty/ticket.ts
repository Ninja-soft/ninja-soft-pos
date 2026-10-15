// Garantía extendida en el ticket y la factura (ADR-139). PURO. La línea de
// garantía trae el vencimiento y las condiciones que guardó el servidor al
// vender (sale_items.warranty_expires_on / warranty_terms). Las columnas no
// están en types/database.ts: se leen sueltas.

import { formatDateAr } from "./pricing";

type Row = Record<string, unknown>;

export function warrantyOfItem(item: object): { warranty_expires_on?: string; warranty_terms?: string } {
  const it = item as Row;
  const exp =
    typeof it.warranty_expires_on === "string" && it.warranty_expires_on ? it.warranty_expires_on.slice(0, 10) : null;
  if (!exp) return {};
  const terms = typeof it.warranty_terms === "string" && it.warranty_terms.trim() ? it.warranty_terms.trim() : null;
  return { warranty_expires_on: exp, ...(terms ? { warranty_terms: terms } : {}) };
}

/** Renglones debajo de la línea de garantía: hasta cuándo cubre y las condiciones. */
export function warrantyDetailLines(it: { warranty_expires_on?: string | null; warranty_terms?: string | null }): {
  bullet: boolean;
  text: string;
}[] {
  if (!it.warranty_expires_on) return [];
  return [
    { bullet: false, text: `Cubre hasta el ${formatDateAr(it.warranty_expires_on)}` },
    ...(it.warranty_terms ? [{ bullet: false, text: it.warranty_terms }] : []),
  ];
}

/** Estado de una garantía vendida a una fecha (AAAA-MM-DD en Argentina). */
export function warrantyStatus(
  expiresOn: string | null,
  today: string,
  voided = false,
): "vigente" | "vencida" | "anulada" {
  if (voided) return "anulada";
  if (!expiresOn) return "vencida";
  return expiresOn.slice(0, 10) >= today ? "vigente" : "vencida";
}
