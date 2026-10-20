// F24 · H159 (ADR-172): ticket de cambio sin precios. PURO.

export interface ExchangeItemInput {
  product_name: string;
  quantity: number;
  returned_qty?: number | null;
  /** Renglón de garantía extendida: no va en el ticket de cambio. */
  warranty_for_item_id?: string | null;
}

/** Productos que se pueden cambiar (sin lo ya devuelto), agrupados por nombre. */
export function exchangeItems(items: ExchangeItemInput[]): { name: string; quantity: number }[] {
  const out = new Map<string, number>();
  for (const it of items) {
    if (it.warranty_for_item_id) continue;
    const q = Number(it.quantity) - Number(it.returned_qty ?? 0);
    if (!(q > 0)) continue;
    const name = String(it.product_name ?? "").trim() || "Producto";
    out.set(name, Math.round(((out.get(name) ?? 0) + q) * 1000) / 1000);
  }
  return [...out.entries()].map(([name, quantity]) => ({ name, quantity }));
}

/** "dd/mm/aaaa": fecha de la venta (día argentino) más N días. */
export function exchangeDeadline(saleDateIso: string, days: number): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(saleDateIso));
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + Math.max(0, Math.floor(days))));
  const dd = String(t.getUTCDate()).padStart(2, "0");
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${t.getUTCFullYear()}`;
}
