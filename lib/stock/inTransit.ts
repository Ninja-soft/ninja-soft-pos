// =============================================================================
// Reporte de artículos en tránsito entre sucursales (F17 · H95 · ADR-080).
//
// Lo pendiente de cada ítem se calcula igual que stock_by_store (SQL,
// 20261013200200): traslados en camino o recibidos en parte, despachado menos
// recibido, nunca negativo. Un faltante cerrado con motivo deja el traslado
// recibido y sale del reporte. Puro y testeable.
// =============================================================================

export interface InTransitSourceLine {
  transfer_id: string;
  number: number;
  status: string;
  origin_store_id: string;
  dest_store_id: string;
  dispatched_at: string | null;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  unit_cost: number | null;
  qty_dispatched: number | null;
  qty_received: number;
}

export interface InTransitRow extends InTransitSourceLine {
  pending: number;
  /** Pendiente a costo (null si el ítem no tiene costo). */
  value: number | null;
  /** Días desde el despacho (redondeado hacia abajo). */
  days: number | null;
}

export const TRANSIT_STATUSES = ["in_transit", "partially_received"] as const;

export type TransitDirection = "all" | "incoming" | "outgoing";

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pendiente de un ítem (despachado menos recibido, sin negativos). */
export function pendingQty(l: Pick<InTransitSourceLine, "qty_dispatched" | "qty_received">): number {
  return Math.max(round3((Number(l.qty_dispatched) || 0) - (Number(l.qty_received) || 0)), 0);
}

/**
 * Filas del reporte: sólo traslados en camino con algo pendiente, de la
 * sucursal pedida (origen o destino según la dirección), lo más viejo primero.
 */
export function inTransitRows(
  lines: InTransitSourceLine[],
  opts: { storeId?: string | null; direction?: TransitDirection; now?: Date } = {},
): InTransitRow[] {
  const now = opts.now ?? new Date();
  const dir = opts.direction ?? "all";
  const out: InTransitRow[] = [];
  for (const l of lines) {
    if (!(TRANSIT_STATUSES as readonly string[]).includes(l.status)) continue;
    if (opts.storeId) {
      const inc = l.dest_store_id === opts.storeId;
      const outg = l.origin_store_id === opts.storeId;
      if (dir === "incoming" && !inc) continue;
      if (dir === "outgoing" && !outg) continue;
      if (dir === "all" && !inc && !outg) continue;
    }
    const pending = pendingQty(l);
    if (pending <= 0) continue;
    const cost = l.unit_cost == null ? null : Number(l.unit_cost);
    out.push({
      ...l,
      pending,
      value: cost == null || Number.isNaN(cost) ? null : round2(cost * pending),
      days: l.dispatched_at
        ? Math.max(0, Math.floor((now.getTime() - new Date(l.dispatched_at).getTime()) / 86_400_000))
        : null,
    });
  }
  return out.sort(
    (a, b) =>
      (a.dispatched_at ?? "").localeCompare(b.dispatched_at ?? "") ||
      a.number - b.number ||
      a.product_name.localeCompare(b.product_name),
  );
}

export interface InTransitSummary {
  transfers: number;
  items: number;
  units: number;
  value: number;
  /** Ítems sin costo (el valor no los incluye). */
  uncosted: number;
  oldestDays: number | null;
}

export function inTransitSummary(rows: InTransitRow[]): InTransitSummary {
  const transfers = new Set(rows.map((r) => r.transfer_id));
  let units = 0;
  let value = 0;
  let uncosted = 0;
  let oldest: number | null = null;
  for (const r of rows) {
    units += r.pending;
    if (r.value == null) uncosted += 1;
    else value += r.value;
    if (r.days != null) oldest = oldest == null ? r.days : Math.max(oldest, r.days);
  }
  return {
    transfers: transfers.size,
    items: rows.length,
    units: round3(units),
    value: round2(value),
    uncosted,
    oldestDays: oldest,
  };
}

export interface InTransitByProduct {
  key: string;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  pending: number;
  value: number | null;
  transfers: number[];
}

/** Total en camino por producto (para ver "cuánto de X viene en camino"). */
export function inTransitByProduct(rows: InTransitRow[]): InTransitByProduct[] {
  const map = new Map<string, InTransitByProduct>();
  for (const r of rows) {
    const key = `${r.product_id}:${r.variant_id ?? ""}`;
    const cur = map.get(key);
    if (cur) {
      cur.pending = round3(cur.pending + r.pending);
      cur.value = cur.value == null || r.value == null ? null : round2(cur.value + r.value);
      if (!cur.transfers.includes(r.number)) cur.transfers.push(r.number);
    } else {
      map.set(key, {
        key,
        product_name: r.product_name,
        variant_label: r.variant_label,
        sku: r.sku,
        unit: r.unit,
        pending: r.pending,
        value: r.value,
        transfers: [r.number],
      });
    }
  }
  return [...map.values()].sort((a, b) => b.pending - a.pending || a.product_name.localeCompare(b.product_name));
}
