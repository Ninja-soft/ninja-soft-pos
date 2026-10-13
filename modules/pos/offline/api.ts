import { createClient } from "@/lib/supabase/client";
import type { Product } from "@/modules/products/api";
import { offlinePolicyToRaw, type OfflinePolicy } from "@/lib/pos/offline/policy";
import { SNAPSHOT_MAX_PRODUCTS } from "@/lib/pos/offline/snapshot";
import type { OfflineQueueEntry } from "@/lib/pos/offline/queue";
import type { OfflineConflict, OfflineServerStatus, SyncMeta, SyncServerResult } from "@/lib/pos/offline/sync";

// Llamadas de la venta offline (ADR-077). Las RPC nuevas no están en los
// tipos generados (no se regeneran): se castea el payload.

export interface OfflineSaleRow {
  id: string;
  client_sale_id: string;
  submitted_by: string | null;
  cash_shift_id: string | null;
  store_id: string | null;
  payload: {
    items?: { product_id?: string | null; name?: string; quantity?: number; unit_price?: number; discount?: number }[];
    payments?: { method?: string; amount?: number }[];
  };
  meta: { total?: number; device_id?: string | null };
  sold_at: string;
  status: OfflineServerStatus;
  reasons: string[];
  error: string | null;
  conflicts: OfflineConflict[];
  sale_id: string | null;
  sale_number: number | null;
  sale_total: number | null;
  attempts: number;
  reviewed_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

/** En revisión, o registrada con diferencias que nadie vio todavía. */
export function offlineRowNeedsAttention(r: Pick<OfflineSaleRow, "status" | "reviewed_at" | "conflicts">): boolean {
  return r.status === "needs_review" || (r.status === "synced" && !r.reviewed_at && (r.conflicts ?? []).length > 0);
}

export type OfflineResolveAction ="retry" | "discard" | "resolve" | "acknowledge";

export const offlineApi = {
  /** Catálogo para la foto local (mismo select que el POS, hasta 5000). */
  catalog: async (): Promise<Product[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("products")
      .select("*, categories(name)")
      .is("deleted_at", null)
      .order("name")
      .limit(SNAPSHOT_MAX_PRODUCTS);
    if (error) throw error;
    return (data ?? []) as unknown as Product[];
  },

  sync: async (entry: OfflineQueueEntry, meta: SyncMeta): Promise<SyncServerResult> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc(
      "sync_offline_sale" as never,
      { p_client_sale_id: entry.client_sale_id, p_sale: entry.payload, p_meta: meta } as never,
    );
    if (error) throw error;
    return data as unknown as SyncServerResult;
  },

  /** Ping liviano para saber si NinjaSoft responde. */
  ping: async (): Promise<boolean> => {
    try {
      const supabase = createClient();
      const { error } = await supabase.from("pos_settings").select("tenant_id").limit(1);
      return !error || !/fetch|network|load failed/i.test(error.message);
    } catch {
      return false;
    }
  },

  savePolicy: async (p: OfflinePolicy): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("offline_policy_save" as never, { p_policy: offlinePolicyToRaw(p) } as never);
    if (error) throw error;
  },

  /** Bandeja: con problemas (en revisión o con diferencias sin ver) o todas. */
  list: async (filter: "problems" | "all", storeId: string | null): Promise<OfflineSaleRow[]> => {
    const supabase = createClient();
    let q = supabase
      .from("offline_sales" as never)
      .select(
        "id, client_sale_id, submitted_by, cash_shift_id, store_id, payload, meta, sold_at, status, reasons, error, conflicts, sale_id, sale_number, sale_total, attempts, reviewed_at, resolved_at, resolution_note, created_at",
      )
      .order("sold_at", { ascending: false })
      .limit(200);
    if (filter === "problems") {
      q = q.or("status.eq.needs_review,and(status.eq.synced,reviewed_at.is.null)");
    }
    if (storeId) q = q.eq("store_id", storeId);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as unknown as OfflineSaleRow[];
    return filter === "problems" ? rows.filter(offlineRowNeedsAttention) : rows;
  },

  resolve: async (id: string, action: OfflineResolveAction, note: string | null, shiftId: string | null) => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc(
      "offline_sale_resolve" as never,
      {
        p_id: id,
        p_action: action,
        p_note: note ?? undefined,
        ...(shiftId ? { p_cash_shift_id: shiftId } : {}),
      } as never,
    );
    if (error) throw error;
    return data as unknown as SyncServerResult;
  },
};
