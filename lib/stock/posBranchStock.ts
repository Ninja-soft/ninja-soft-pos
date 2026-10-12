// lib/stock/posBranchStock.ts
//
// Stock de la sucursal del POS (F17 · H94). PURO: sin React ni Supabase.
// Con 2+ sucursales y la feature stock_sucursales, el POS muestra y controla el
// stock de SU sucursal (product_stock) en lugar del total del negocio, y ofrece
// ver lo que hay en las otras. Las filas vienen de stock_by_store.

export interface BranchStockRow {
  store_id: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
}

/** Saldo de un producto (sumando variantes) o de una variante en una sucursal. */
export function branchQty(
  rows: BranchStockRow[],
  storeId: string,
  productId: string,
  variantId: string | null = null,
): number {
  let total = 0;
  for (const r of rows) {
    if (r.store_id !== storeId || r.product_id !== productId) continue;
    if (variantId !== null && r.variant_id !== variantId) continue;
    total += Number(r.qty) || 0;
  }
  return total;
}

/** Saldo por producto (variantes sumadas) en la sucursal. */
export function branchQtyMap(rows: BranchStockRow[], storeId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.store_id !== storeId) continue;
    out.set(r.product_id, (out.get(r.product_id) ?? 0) + (Number(r.qty) || 0));
  }
  return out;
}

export interface OtherBranchStock {
  storeId: string;
  name: string;
  qty: number;
}

/**
 * Lo que hay del producto en las OTRAS sucursales (con saldo distinto de 0),
 * de mayor a menor. Para "Ver en otras sucursales".
 */
export function otherBranchesStock(
  rows: BranchStockRow[],
  productId: string,
  currentStoreId: string,
  names: Map<string, string>,
): OtherBranchStock[] {
  const byStore = new Map<string, number>();
  for (const r of rows) {
    if (r.product_id !== productId || r.store_id === currentStoreId) continue;
    if (!names.has(r.store_id)) continue;
    byStore.set(r.store_id, (byStore.get(r.store_id) ?? 0) + (Number(r.qty) || 0));
  }
  return [...byStore.entries()]
    .filter(([, qty]) => qty !== 0)
    .map(([storeId, qty]) => ({ storeId, name: names.get(storeId)!, qty }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}

/** "Norte: 3 · Shopping: 1" (vacío si no hay en ninguna otra). */
export function otherBranchesText(list: OtherBranchStock[], fmt: (n: number) => string = String): string {
  return list.map((o) => `${o.name}: ${fmt(o.qty)}`).join(" · ");
}

export interface StockNeedLine {
  productId: string | null;
  variantId?: string | null;
  quantity: number;
}

export interface BranchShortfall {
  productId: string;
  variantId: string | null;
  need: number;
  have: number;
}

/**
 * Líneas del carrito que dejan la sucursal en negativo. Sólo productos que
 * controlan stock (`tracked`). Las líneas del mismo producto/variante se suman.
 */
export function branchShortfalls(
  lines: StockNeedLine[],
  rows: BranchStockRow[],
  storeId: string,
  tracked: Set<string>,
): BranchShortfall[] {
  const need = new Map<string, { productId: string; variantId: string | null; qty: number }>();
  for (const l of lines) {
    if (!l.productId || !tracked.has(l.productId)) continue;
    const variantId = l.variantId ?? null;
    const key = `${l.productId}|${variantId ?? ""}`;
    const cur = need.get(key) ?? { productId: l.productId, variantId, qty: 0 };
    cur.qty += Number(l.quantity) || 0;
    need.set(key, cur);
  }
  const out: BranchShortfall[] = [];
  for (const n of need.values()) {
    const have = branchQty(rows, storeId, n.productId, n.variantId);
    if (n.qty > have) out.push({ productId: n.productId, variantId: n.variantId, need: n.qty, have });
  }
  return out;
}

export type StockCheck = "ok" | "warn" | "block";

/**
 * Qué hacer al agregar `adding` unidades cuando ya hay `inCart` en el carrito:
 * alcanza → ok; no alcanza y se permite vender en negativo → warn; si no, block.
 */
export function branchStockCheck(input: {
  have: number;
  inCart: number;
  adding: number;
  allowNegative: boolean;
}): StockCheck {
  if (input.inCart + input.adding <= input.have) return "ok";
  return input.allowNegative ? "warn" : "block";
}
