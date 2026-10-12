// lib/stock/byStore.ts
//
// Desglose de stock por sucursal para la UI (F17 · H94, ADR-046). PURO.
// Arma, para un producto o variante, una fila por sucursal (aunque no tenga
// saldo) con su estado contra el mínimo, la sucursal actual primero.

export interface StoreRef {
  id: string;
  name: string;
  is_default: boolean;
}

export interface StoreStockRow {
  store_id: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
  min_qty: number | null;
  max_qty: number | null;
  location: string | null;
  in_transit_in: number;
  in_transit_out: number;
}

export type StoreStockTone = "ok" | "low" | "out" | "negative";

export interface StoreStockLine {
  store: StoreRef;
  qty: number;
  min: number;
  max: number | null;
  location: string | null;
  inTransitIn: number;
  inTransitOut: number;
  tone: StoreStockTone;
  current: boolean;
}

export function storeStockTone(qty: number, min: number): StoreStockTone {
  if (qty < 0) return "negative";
  if (qty === 0) return "out";
  if (min > 0 && qty <= min) return "low";
  return "ok";
}

/**
 * Líneas por sucursal de un producto/variante. `productMin` es el mínimo del
 * producto (products.stock_min), que se usa si la sucursal no tiene el suyo.
 * La sucursal actual (o la principal si no hay contexto) va primero.
 */
export function storeStockLines(
  stores: StoreRef[],
  rows: StoreStockRow[],
  productId: string,
  variantId: string | null,
  productMin: number | null | undefined,
  currentStoreId?: string | null,
): StoreStockLine[] {
  const current =
    currentStoreId ??
    stores.find((s) => s.is_default)?.id ??
    stores[0]?.id ??
    null;
  const lines = stores.map((store) => {
    const r = rows.find(
      (x) =>
        x.store_id === store.id &&
        x.product_id === productId &&
        (x.variant_id ?? null) === (variantId ?? null),
    );
    const qty = Number(r?.qty ?? 0);
    const min = Number(r?.min_qty ?? productMin ?? 0);
    return {
      store,
      qty,
      min,
      max: r?.max_qty == null ? null : Number(r.max_qty),
      location: r?.location ?? null,
      inTransitIn: Number(r?.in_transit_in ?? 0),
      inTransitOut: Number(r?.in_transit_out ?? 0),
      tone: storeStockTone(qty, min),
      current: store.id === current,
    };
  });
  return lines.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.store.is_default !== b.store.is_default)
      return a.store.is_default ? -1 : 1;
    return a.store.name.localeCompare(b.store.name, "es");
  });
}

/**
 * Stock de un producto por sucursal. Con variantes suma las filas de cada
 * variante; sin variantes usa la fila del producto (variant_id null).
 */
export function totalsByStore(
  rows: StoreStockRow[],
  productId: string,
  hasVariants = false,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.product_id !== productId) continue;
    if (hasVariants ? r.variant_id == null : r.variant_id != null) continue;
    m.set(r.store_id, (m.get(r.store_id) ?? 0) + Number(r.qty ?? 0));
  }
  return m;
}
