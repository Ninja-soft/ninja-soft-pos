"use client";

// Depósitos internos (F11 · H33, ADR-085). Lecturas por tabla con RLS y por
// RPC; toda escritura por RPC SECURITY DEFINER (el servidor valida plan, rol,
// sucursal y disponible). Las tablas y RPC nuevas no están en los tipos
// generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type {
  Warehouse,
  WarehouseDifferenceReason,
  WarehouseKind,
  WarehouseLink,
  WarehouseMoveReason,
  WarehouseMoveStatus,
  WarehouseOverviewRow,
} from "@/lib/stock/warehouses";

export interface WarehouseMove {
  id: string;
  number: number;
  store_id: string;
  origin_warehouse_id: string;
  dest_warehouse_id: string;
  status: WarehouseMoveStatus;
  reason: WarehouseMoveReason;
  notes: string | null;
  total_units: number;
  has_differences: boolean;
  cancel_reason: string | null;
  created_at: string;
  received_at: string | null;
  items: WarehouseMoveItem[];
}

export interface WarehouseMoveItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  qty_sent: number;
  qty_received: number;
  difference_reason: WarehouseDifferenceReason | null;
  sort: number;
}

export interface MoveLineInput {
  product_id: string;
  variant_id: string | null;
  qty: number;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

function from(table: string) {
  return createClient().from(table as never);
}

const WH_COLS = "id, store_id, name, code, kind, sort";
// ADR-136: columnas de la configuración. Sin la migración, la lectura
// reintenta sin ellas (vendible por tipo).
const WH_COLS_CONFIG = `${WH_COLS}, sellable, sale_priority`;
const MISSING_CONFIG_COLS = /sellable|sale_priority/;

export const warehousesApi = {
  list: async (storeId: string): Promise<Warehouse[]> => {
    const run = (cols: string) =>
      from("warehouses").select(cols).eq("store_id", storeId).is("deleted_at", null).order("sort").order("name");
    let { data, error } = await run(WH_COLS_CONFIG);
    if (error && MISSING_CONFIG_COLS.test(error.message)) ({ data, error } = await run(WH_COLS));
    if (error) throw error;
    return (data ?? []) as unknown as Warehouse[];
  },

  /** ADR-136: depósitos de otras sucursales habilitados para `storeId` y vínculos de los de `storeId`. */
  links: async (storeId: string): Promise<{ own: WarehouseLink[]; incoming: (Warehouse & { store_name: string })[] }> => {
    const own = await from("warehouse_store_links")
      .select("warehouse_id, store_id, warehouses!inner(store_id)")
      .is("deleted_at", null)
      .eq("warehouses.store_id", storeId);
    if (own.error) {
      // Sin la migración no hay vínculos.
      if (/warehouse_store_links|does not exist|schema cache/i.test(own.error.message)) return { own: [], incoming: [] };
      throw own.error;
    }
    const inc = await from("warehouse_store_links")
      .select(`warehouse:warehouses!inner(${WH_COLS_CONFIG}, deleted_at, store:stores(name))`)
      .is("deleted_at", null)
      .eq("store_id", storeId);
    if (inc.error) throw inc.error;
    type Inc = { warehouse: (Warehouse & { deleted_at: string | null; store: { name: string } | null }) | null };
    return {
      own: ((own.data ?? []) as unknown as WarehouseLink[]).map((l) => ({ warehouse_id: l.warehouse_id, store_id: l.store_id })),
      incoming: ((inc.data ?? []) as unknown as Inc[])
        .map((r) => r.warehouse)
        .filter((w): w is NonNullable<Inc["warehouse"]> => Boolean(w) && !w!.deleted_at)
        .map(({ store, deleted_at: _d, ...w }) => ({ ...w, store_name: store?.name ?? "Sucursal" })),
    };
  },

  /** ADR-136: vendible, prioridad y sucursales que lo usan (dueño o encargado). */
  saveConfig: (v: { id: string; sellable: boolean; priority: number; storeIds: string[] }) =>
    rpc<{ id: string }>("warehouse_config_save", {
      p_id: v.id,
      p_sellable: v.sellable,
      p_priority: v.priority,
      p_store_ids: v.storeIds,
    }),

  /** ADR-136: el salón como fila, para habilitarlo a otras sucursales. */
  setupPrincipal: (storeId: string) => rpc<string>("warehouse_principal_setup", { p_store_id: storeId }),

  /** Miniaturas de los productos de la tabla (image_url). */
  thumbs: async (productIds: string[]): Promise<Record<string, string>> => {
    if (productIds.length === 0) return {};
    const { data, error } = await createClient()
      .from("products")
      .select("id, image_url")
      .in("id", productIds.slice(0, 500));
    if (error) throw error;
    const out: Record<string, string> = {};
    for (const p of (data ?? []) as { id: string; image_url: string | null }[]) if (p.image_url) out[p.id] = p.image_url;
    return out;
  },

  overview: async (storeId: string, search: string): Promise<WarehouseOverviewRow[]> => {
    const rows = await rpc<WarehouseOverviewRow[]>("warehouse_stock_overview", {
      p_store_id: storeId,
      p_search: search.trim() || null,
      p_limit: 300,
    });
    return (rows ?? []).map((r) => ({
      ...r,
      store_qty: Number(r.store_qty),
      principal_qty: Number(r.principal_qty),
      in_transit: Number(r.in_transit),
      min_qty: r.min_qty == null ? null : Number(r.min_qty),
      max_qty: r.max_qty == null ? null : Number(r.max_qty),
      by_warehouse: Object.fromEntries(
        Object.entries(r.by_warehouse ?? {}).map(([k, v]) => [k, Number(v)]),
      ),
    }));
  },

  moves: async (storeId: string, open: boolean): Promise<WarehouseMove[]> => {
    let q = from("warehouse_moves")
      .select(
        "id, number, store_id, origin_warehouse_id, dest_warehouse_id, status, reason, notes, total_units, has_differences, cancel_reason, created_at, received_at, items:warehouse_move_items(id, product_id, variant_id, product_name, variant_label, sku, unit, qty_sent, qty_received, difference_reason, sort)",
      )
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(open ? 100 : 30);
    q = open ? q.in("status", ["in_transit", "partially_received"]) : q.in("status", ["received", "cancelled"]);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as WarehouseMove[]).map((m) => ({
      ...m,
      total_units: Number(m.total_units),
      items: [...(m.items ?? [])]
        .sort((a, b) => a.sort - b.sort)
        .map((i) => ({ ...i, qty_sent: Number(i.qty_sent), qty_received: Number(i.qty_received) })),
    }));
  },

  save: (v: { id?: string | null; storeId: string; name: string; kind: WarehouseKind; code?: string | null; sort?: number }) =>
    rpc<string>("warehouse_save", {
      p_id: v.id ?? null,
      p_store_id: v.storeId,
      p_name: v.name,
      p_kind: v.kind,
      p_code: v.code ?? null,
      p_sort: v.sort ?? 0,
    }),

  archive: (id: string) => rpc<void>("warehouse_archive", { p_id: id }),

  setStock: (v: { warehouseId: string; productId: string; variantId: string | null; qty: number; notes?: string | null }) =>
    rpc<number>("warehouse_stock_set", {
      p_warehouse_id: v.warehouseId,
      p_product_id: v.productId,
      p_variant_id: v.variantId,
      p_qty: v.qty,
      p_notes: v.notes ?? null,
    }),

  createMove: (v: {
    origin: string;
    dest: string;
    items: MoveLineInput[];
    reason: WarehouseMoveReason;
    notes?: string | null;
    receiveNow: boolean;
  }) =>
    rpc<string>("warehouse_move_create", {
      p_origin: v.origin,
      p_dest: v.dest,
      p_items: v.items,
      p_reason: v.reason,
      p_notes: v.notes ?? null,
      p_receive_now: v.receiveNow,
    }),

  receive: (v: {
    moveId: string;
    items: { item_id: string; qty: number; reason?: WarehouseDifferenceReason | null }[];
    close: boolean;
  }) => rpc<string>("warehouse_move_receive", { p_move_id: v.moveId, p_items: v.items, p_close: v.close }),

  cancel: (v: { moveId: string; reason: string }) =>
    rpc<void>("warehouse_move_cancel", { p_move_id: v.moveId, p_reason: v.reason }),

  /** ADR-088: ¿la venta puede tomar de la reserva cuando el salón no alcanza? */
  sellFromReserve: async (): Promise<boolean> => {
    const { data, error } = await from("pos_settings").select("sell_from_reserve").maybeSingle();
    if (error) throw error;
    return Boolean((data as unknown as { sell_from_reserve?: boolean } | null)?.sell_from_reserve);
  },

  /** Dueño o encargado con `depositos` (auditado en el servidor). */
  saveSellFromReserve: (value: boolean) =>
    rpc<{ sell_from_reserve: boolean }>("warehouse_settings_save", { p_sell_from_reserve: value }),
};

export function useSellFromReserve(enabled = true) {
  return useQuery({
    queryKey: ["warehouse-settings"],
    queryFn: () => warehousesApi.sellFromReserve(),
    enabled,
  });
}

export function useSaveSellFromReserve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: warehousesApi.saveSellFromReserve,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["warehouse-settings"] }),
  });
}

export function useWarehouses(storeId: string | null) {
  return useQuery({
    queryKey: ["warehouses", storeId],
    queryFn: () => warehousesApi.list(storeId!),
    enabled: Boolean(storeId),
  });
}

/** ADR-136: vínculos de los depósitos de la sucursal y depósitos de otras habilitados para ella. */
export function useWarehouseLinks(storeId: string | null) {
  return useQuery({
    queryKey: ["warehouse-links", storeId],
    queryFn: () => warehousesApi.links(storeId!),
    enabled: Boolean(storeId),
  });
}

/** Miniaturas por producto (para la tabla de Depósitos). */
export function useProductThumbs(productIds: string[]) {
  const key = [...new Set(productIds)].sort();
  return useQuery({
    queryKey: ["product-thumbs", key.join(",")],
    queryFn: () => warehousesApi.thumbs(key),
    enabled: key.length > 0,
    staleTime: 5 * 60_000,
  });
}

export function useWarehouseOverview(storeId: string | null, search: string, enabled = true) {
  return useQuery({
    queryKey: ["warehouse-overview", storeId, search],
    queryFn: () => warehousesApi.overview(storeId!, search),
    enabled: Boolean(storeId) && enabled,
  });
}

export function useWarehouseMoves(storeId: string | null, open: boolean) {
  return useQuery({
    queryKey: ["warehouse-moves", storeId, open],
    queryFn: () => warehousesApi.moves(storeId!, open),
    enabled: Boolean(storeId),
  });
}

/** Mutaciones con invalidación de depósitos, saldos, movimientos y stock. */
export function useWarehouseMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    for (const key of ["warehouses", "warehouse-overview", "warehouse-moves", "warehouse-links", "stock-by-store", "products"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
  const opts = { onSuccess: invalidate };
  return {
    save: useMutation({ mutationFn: warehousesApi.save, ...opts }),
    archive: useMutation({ mutationFn: warehousesApi.archive, ...opts }),
    setStock: useMutation({ mutationFn: warehousesApi.setStock, ...opts }),
    createMove: useMutation({ mutationFn: warehousesApi.createMove, ...opts }),
    receive: useMutation({ mutationFn: warehousesApi.receive, ...opts }),
    cancel: useMutation({ mutationFn: warehousesApi.cancel, ...opts }),
    saveConfig: useMutation({ mutationFn: warehousesApi.saveConfig, ...opts }),
    setupPrincipal: useMutation({ mutationFn: warehousesApi.setupPrincipal, ...opts }),
  };
}
