// Ítems vendidos resumidos del Cierre Z (F11 · H30b, ADR-085). El servidor los
// arma al cerrar (trigger czc_items_summary) en cash_z_closures.items_summary;
// acá se normalizan para mostrarlos y exportarlos. Puro y testeable.

export interface ZItemLine {
  productId: string | null;
  variantId: string | null;
  name: string;
  qty: number;
  total: number;
  /** Línea "Otros productos" que agrupa lo que pasó del tope de 200. */
  other: boolean;
}

/**
 * Normaliza el jsonb del Z. Los Z cerrados antes de esta función no tienen
 * resumen: devuelve null (la UI dice "sin detalle") y no un arreglo vacío,
 * que significa "turno sin ventas".
 */
export function parseZItems(raw: unknown): ZItemLine[] | null {
  if (raw == null || !Array.isArray(raw)) return null;
  return raw
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      productId: typeof r.product_id === "string" ? r.product_id : null,
      variantId: typeof r.variant_id === "string" ? r.variant_id : null,
      name: typeof r.name === "string" && r.name.trim() ? r.name : "Sin nombre",
      qty: Number(r.qty ?? 0) || 0,
      total: Number(r.total ?? 0) || 0,
      other: r.other === true,
    }));
}

/** Totales del resumen (unidades e importe). */
export function zItemsTotals(lines: ZItemLine[]): { units: number; total: number } {
  return lines.reduce(
    (acc, l) => ({
      units: Math.round((acc.units + l.qty) * 1000) / 1000,
      total: Math.round((acc.total + l.total) * 100) / 100,
    }),
    { units: 0, total: 0 },
  );
}
