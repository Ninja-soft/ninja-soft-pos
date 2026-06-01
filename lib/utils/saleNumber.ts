// Formato del N° de comprobante por tenant: prefijo + padding sobre el
// correlativo interno (sales.number). El correlativo no cambia; esto es display.
export interface SaleNumberFormat {
  prefix: string;
  pad: number;
}

export function formatSaleNumber(
  n: number,
  fmt?: SaleNumberFormat | null,
): string {
  const prefix = fmt?.prefix ?? "";
  const pad = fmt?.pad ?? 0;
  const body = pad > 0 ? String(n).padStart(pad, "0") : String(n);
  return `${prefix}${body}`;
}

// ¿Una venta matchea el texto buscado? Compara contra el N° formateado y el
// correlativo crudo (tolerante a mayúsculas, espacios y ceros a la izquierda).
export function saleMatchesQuery(
  n: number,
  fmt: SaleNumberFormat | null | undefined,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const formatted = formatSaleNumber(n, fmt).toLowerCase();
  if (formatted.includes(q)) return true;
  const digits = q.replace(/\D/g, "");
  if (digits && String(n) === String(Number(digits))) return true;
  return String(n).includes(q);
}
