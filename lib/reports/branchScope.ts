// lib/reports/branchScope.ts
//
// Alcance de sucursal de Reportes y pantallas de stock (F17 · H97 / H94). PURO.
// La sucursal sale del chip del panel (useBranchContext().filterStoreId):
// null = "Todas las sucursales" (consolidado de lo que el usuario puede ver; el
// servidor recorta a las permitidas).

export interface BranchNameRef {
  name: string;
  short_name?: string | null;
}

/** "Sucursal Centro" / "Todas las sucursales" / null (negocio de una sucursal). */
export function reportScopeLabel(
  isMulti: boolean,
  store: BranchNameRef | null | undefined,
): string | null {
  if (!isMulti) return null;
  if (!store) return "Todas las sucursales";
  return `Sucursal ${store.short_name?.trim() || store.name}`;
}

/** Sufijo para nombres de archivo: "centro", "todas" o "" (una sola sucursal). */
export function branchFileTag(
  isMulti: boolean,
  store: BranchNameRef | null | undefined,
): string {
  if (!isMulti) return "";
  if (!store) return "todas";
  const raw = (store.short_name?.trim() || store.name).toLowerCase();
  const slug = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return slug || "sucursal";
}

/** Filas con sucursal: todas sin filtro, o sólo las de la sucursal elegida. */
export function filterByStore<T extends { store_id: string | null }>(
  rows: T[],
  storeId: string | null,
): T[] {
  if (!storeId) return rows;
  return rows.filter((r) => r.store_id === storeId);
}

export interface BranchStockRow {
  store_id: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
  min_qty: number | null;
}

/**
 * Stock de un producto en una sucursal (suma variantes si tiene) y su mínimo
 * (el de la sucursal o, si no tiene, el del producto). null sin sucursal.
 */
export function branchStockOf(
  rows: BranchStockRow[],
  product: { id: string; has_variants?: boolean | null; stock_min?: number | null },
  storeId: string | null,
): { qty: number; min: number } | null {
  if (!storeId) return null;
  const hasVariants = Boolean(product.has_variants);
  const mine = rows.filter(
    (r) =>
      r.product_id === product.id &&
      r.store_id === storeId &&
      (hasVariants ? r.variant_id != null : r.variant_id == null),
  );
  const own = mine.find((r) => r.variant_id == null);
  return {
    qty: mine.reduce((t, r) => t + Number(r.qty ?? 0), 0),
    min: hasVariants ? 0 : Number(own?.min_qty ?? product.stock_min ?? 0),
  };
}
