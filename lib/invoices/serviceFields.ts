// Datos de servicio de una venta y sus renglones (ADR-116) para el ticket y la
// factura. Las columnas nuevas de sales / sale_items todavía no están en
// types/database.ts (no se regeneran): se leen sueltas. PURO.

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Período del servicio y vencimiento del pago de la venta. */
export function serviceOfSale(sale: object): { service_from?: string; service_to?: string; payment_due?: string } {
  const s = sale as Row;
  const from = str(s.service_from);
  if (!from) return {};
  return {
    service_from: from.slice(0, 10),
    service_to: (str(s.service_to) ?? from).slice(0, 10),
    ...(str(s.payment_due) ? { payment_due: (s.payment_due as string).slice(0, 10) } : {}),
  };
}

/** Unidad, descripción ampliada, aclaraciones y nota de un renglón. */
export function serviceOfItem(item: object): {
  unit_label?: string;
  line_detail?: string;
  line_clarifications?: string[];
  line_note?: string;
  service_type_name?: string;
} {
  const it = item as Row;
  const cl = Array.isArray(it.line_clarifications)
    ? (it.line_clarifications as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  return {
    ...(str(it.unit_label) ? { unit_label: it.unit_label as string } : {}),
    ...(str(it.line_detail) ? { line_detail: it.line_detail as string } : {}),
    ...(cl.length > 0 ? { line_clarifications: cl } : {}),
    ...(str(it.line_note) ? { line_note: it.line_note as string } : {}),
    // ADR-122: tipo del servicio (sale_items.service_type_name).
    ...(str(it.service_type_name) ? { service_type_name: it.service_type_name as string } : {}),
  };
}
