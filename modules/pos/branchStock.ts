"use client";

import { useMemo } from "react";
import { useBranchContext } from "@/modules/branches/hooks";
import { useMultiStoreStock, useStockByStore } from "@/modules/stock/hooks";
import { branchQtyMap, type BranchStockRow } from "@/lib/stock/posBranchStock";

// Stock de la sucursal del POS (F17 · H94). Sólo se activa con 2+ sucursales
// y la feature stock_sucursales; si no, `enabled` es false y el POS sigue con
// el total del negocio como siempre. Pide stock_by_store para los productos
// visibles y los del carrito.
export function usePosBranchStock(productIds: string[]) {
  const { enabled } = useMultiStoreStock();
  const ctx = useBranchContext();
  const storeId = ctx.posStoreId;
  const on = enabled && Boolean(storeId);
  const { data } = useStockByStore(productIds, on);
  const rows = useMemo<BranchStockRow[]>(() => (on ? (data ?? []) : []), [on, data]);
  const qtyByProduct = useMemo(
    () => (on && storeId ? branchQtyMap(rows, storeId) : new Map<string, number>()),
    [on, storeId, rows],
  );
  const names = useMemo(
    () =>
      new Map(
        ctx.allowed.length > 0
          ? ctx.all.filter((b) => !b.deleted_at).map((b) => [b.id, b.short_name || b.name] as const)
          : [],
      ),
    [ctx.all, ctx.allowed.length],
  );
  return {
    enabled: on,
    loaded: on && data !== undefined,
    storeId,
    storeName: ctx.posStore ? ctx.posStore.short_name || ctx.posStore.name : null,
    rows,
    qtyByProduct,
    names,
  };
}
