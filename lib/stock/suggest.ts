// lib/stock/suggest.ts
//
// Sugerencia de traslados por stock bajo (F17 · H94/H95, ADR-046). PURO.
//
// Para cada producto (o variante), las sucursales por debajo de su mínimo
// (contando lo que ya viene en camino) piden hasta su máximo (o hasta el
// mínimo si no tienen máximo). Las sucursales con sobrante (stock por encima
// de su propio mínimo) donan, empezando por la que más tiene. Nunca se deja a
// una donante por debajo de su mínimo.

export interface StockCell {
  /** Producto o variante (p. ej. `${productId}:${variantId ?? ""}`). */
  key: string;
  storeId: string;
  qty: number;
  /** Mínimo efectivo (0 = sin mínimo). */
  min: number;
  max: number | null;
  /** Lo que ya viene en camino a esta sucursal. */
  inTransitIn?: number;
}

export interface TransferSuggestion {
  key: string;
  fromStoreId: string;
  toStoreId: string;
  qty: number;
}

export interface SuggestOptions {
  /** Sólo sugerir para esta sucursal de destino. */
  destStoreId?: string | null;
  /** Si la clave se cuenta en unidades enteras (redondea hacia abajo). */
  isInteger?: (key: string) => boolean;
}

const EPS = 1e-9;

function roundQty(n: number, integer: boolean): number {
  if (integer) return Math.floor(n + EPS);
  return Math.floor(n * 1000 + EPS) / 1000;
}

export function suggestTransfers(
  cells: StockCell[],
  opts: SuggestOptions = {},
): TransferSuggestion[] {
  const byKey = new Map<string, StockCell[]>();
  for (const c of cells) {
    const list = byKey.get(c.key) ?? [];
    list.push(c);
    byKey.set(c.key, list);
  }

  const out: TransferSuggestion[] = [];
  for (const [key, list] of byKey) {
    const integer = opts.isInteger ? opts.isInteger(key) : true;

    const needy = list
      .map((c) => {
        const have = c.qty + (c.inTransitIn ?? 0);
        const target = Math.max(c.min, c.max ?? 0);
        return { c, need: c.min > 0 && have < c.min ? target - have : 0 };
      })
      .filter((n) => n.need > EPS)
      .filter((n) => !opts.destStoreId || n.c.storeId === opts.destStoreId)
      .sort(
        (a, b) => b.need - a.need || a.c.storeId.localeCompare(b.c.storeId),
      );
    if (needy.length === 0) continue;

    const needyIds = new Set(needy.map((n) => n.c.storeId));
    const donors = list
      .filter((c) => !needyIds.has(c.storeId))
      .map((c) => ({ c, surplus: c.qty - Math.max(c.min, 0) }))
      .filter((d) => d.surplus > EPS)
      .sort(
        (a, b) =>
          b.surplus - a.surplus || a.c.storeId.localeCompare(b.c.storeId),
      );

    for (const n of needy) {
      let need = n.need;
      for (const d of donors) {
        if (need <= EPS) break;
        const give = roundQty(Math.min(need, d.surplus), integer);
        if (give <= EPS) continue;
        out.push({
          key,
          fromStoreId: d.c.storeId,
          toStoreId: n.c.storeId,
          qty: give,
        });
        d.surplus -= give;
        need -= give;
      }
    }
  }
  return out;
}

export interface SuggestionGroup {
  fromStoreId: string;
  toStoreId: string;
  lines: TransferSuggestion[];
}

/** Agrupa las sugerencias por par origen → destino (un traslado por grupo). */
export function groupSuggestions(
  list: TransferSuggestion[],
): SuggestionGroup[] {
  const map = new Map<string, SuggestionGroup>();
  for (const s of list) {
    const k = `${s.fromStoreId}>${s.toStoreId}`;
    const g = map.get(k) ?? {
      fromStoreId: s.fromStoreId,
      toStoreId: s.toStoreId,
      lines: [],
    };
    g.lines.push(s);
    map.set(k, g);
  }
  return [...map.values()].sort((a, b) => b.lines.length - a.lines.length);
}

/** Clave estable de producto/variante. */
export function stockKey(
  productId: string,
  variantId: string | null | undefined,
): string {
  return `${productId}:${variantId ?? ""}`;
}

export function parseStockKey(key: string): {
  productId: string;
  variantId: string | null;
} {
  const [productId = "", variantId] = key.split(":");
  return { productId, variantId: variantId ? variantId : null };
}
