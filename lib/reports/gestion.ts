// F24 · H161 (ADR-174): helpers puros de Reportes > Gestión.

/** Motivos de movimiento de stock, en castellano. */
export const STOCK_REASON_LABEL: Record<string, string> = {
  sale: "Venta",
  sale_void: "Anulación de venta",
  purchase: "Compra",
  adjustment: "Ajuste",
  transfer: "Traslado",
  transfer_in: "Traslado (entra)",
  transfer_out: "Traslado (sale)",
  loss: "Merma",
  return: "Devolución",
  production: "Producción",
  count: "Conteo",
  transfer_return: "Traslado (vuelve)",
  purchase_return: "Devolución a proveedor",
  purchase_void: "Anulación de compra",
};

export function stockReasonLabel(r: string | null | undefined): string {
  if (!r) return "Otro";
  return STOCK_REASON_LABEL[r] ?? r.replace(/_/g, " ");
}

/** "2026-10" → "octubre 2026". */
export function monthLabel(ym: string | null | undefined): string {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym ?? "";
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("es-AR", { month: "long", timeZone: "UTC" });
  return `${name} ${y}`;
}

/** Variación porcentual contra el período anterior (null sin base). */
export function deltaPct(cur: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || !Number.isFinite(prev) || prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

/** Margen bruto sobre ventas netas, en % (null sin ventas). */
export function marginPct(margin: number, netSales: number): number | null {
  if (!netSales) return null;
  return Math.round((margin / netSales) * 1000) / 10;
}

/** Tramo de días sin venta para la mercadería parada. */
export function deadBucket(days: number | null): "nunca" | "90+" | "180+" | "365+" | "menos" {
  if (days === null) return "nunca";
  if (days >= 365) return "365+";
  if (days >= 180) return "180+";
  if (days >= 90) return "90+";
  return "menos";
}

/** yyyy-mm-dd local (para los RPC con fecha). */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Rango de un DateRange a instantes: desde 00:00 del primer día hasta 00:00 del día siguiente al último. */
export function rangeToInstants(from: Date | undefined, to: Date | undefined): { from: string; to: string } | null {
  if (!from) return null;
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const last = to ?? from;
  const b = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return { from: a.toISOString(), to: b.toISOString() };
}
