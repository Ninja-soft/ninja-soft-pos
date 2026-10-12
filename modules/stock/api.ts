"use client";

// Stock por sucursal y traslados (F17 · H94 + H95, ADR-046).
// Lecturas por tabla con RLS y RPC; toda escritura por RPC SECURITY DEFINER
// (el servidor valida plan, rol, estado y stock). Las tablas y RPC nuevas no
// están en los tipos generados (no se regeneran): se castean.

import { createClient } from "@/lib/supabase/client";
import type { StoreRef, StoreStockRow } from "@/lib/stock/byStore";
import {
  DEFAULT_TRANSFER_SETTINGS,
  type DifferenceReason,
  type TransferSettings,
  type TransferStatus,
} from "@/lib/stock/transfers";

export type { StoreRef, StoreStockRow };

export interface TransferRow {
  id: string;
  number: number;
  origin_store_id: string;
  dest_store_id: string;
  status: TransferStatus;
  scheduled_for: string | null;
  notes: string | null;
  carrier: string | null;
  cancel_reason: string | null;
  total_units: number;
  total_value: number;
  needs_approval: boolean;
  created_by: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  dispatched_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
}

export interface TransferItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  unit_cost: number | null;
  qty_requested: number;
  qty_dispatched: number | null;
  qty_received: number;
  difference_reason: DifferenceReason | null;
  notes: string | null;
  sort: number;
}

export interface TransferEvent {
  id: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  actor_name: string | null;
  notes: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface TransferDetail extends TransferRow {
  items: TransferItem[];
  events: TransferEvent[];
}

export interface TransferLineInput {
  product_id: string;
  variant_id: string | null;
  qty: number;
  notes?: string | null;
}

export interface TransferSaveInput {
  id?: string | null;
  origin_store_id: string;
  dest_store_id: string;
  scheduled_for: string | null;
  notes?: string | null;
  carrier?: string | null;
  items: TransferLineInput[];
}

export interface ReceiveLine {
  item_id: string;
  qty: number;
  reason?: DifferenceReason | null;
  notes?: string | null;
}

export interface LowStockRow {
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  store_id: string;
  qty: number;
  min_qty: number;
  max_qty: number | null;
  in_transit_in: number;
}

export interface TransferFilters {
  statuses?: TransferStatus[] | null;
  storeId?: string | null;
  search?: string | null;
}

const T_COLS =
  "id, number, origin_store_id, dest_store_id, status, scheduled_for, notes, carrier, cancel_reason, total_units, total_value, needs_approval, created_by, created_at, submitted_at, approved_at, dispatched_at, received_at, cancelled_at";

const I_COLS =
  "id, product_id, variant_id, product_name, variant_label, sku, unit, unit_cost, qty_requested, qty_dispatched, qty_received, difference_reason, notes, sort";

function num<T extends object>(row: T, keys: (keyof T)[]): T {
  const out = { ...row };
  for (const k of keys) {
    const v = out[k] as unknown;
    if (v !== null && v !== undefined)
      (out as Record<keyof T, unknown>)[k] = Number(v);
  }
  return out;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

export const stockApi = {
  // Sucursales activas del negocio (la principal primero).
  stores: async (): Promise<StoreRef[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("stores")
      .select("id, name, is_default")
      .is("deleted_at", null)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as StoreRef[];
  },

  // Stock por sucursal (con lo que está en camino) de un conjunto de productos.
  byStore: async (productIds: string[]): Promise<StoreStockRow[]> => {
    const ids = [...new Set(productIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const rows = await rpc<StoreStockRow[]>("stock_by_store", {
      p_product_ids: ids,
    });
    return (rows ?? []).map((r) =>
      num(r, ["qty", "min_qty", "max_qty", "in_transit_in", "in_transit_out"]),
    );
  },

  adjust: (v: {
    storeId: string;
    productId: string;
    variantId: string | null;
    qty: number;
    mode: "delta" | "set";
    reason: string;
    notes?: string | null;
  }): Promise<number> =>
    rpc<number>("adjust_store_stock", {
      p_store_id: v.storeId,
      p_product_id: v.productId,
      p_variant_id: v.variantId,
      p_qty: v.qty,
      p_mode: v.mode,
      p_reason: v.reason,
      p_notes: v.notes ?? null,
    }).then(Number),

  saveSettings: (v: {
    storeId: string;
    productId: string;
    variantId: string | null;
    min: number | null;
    max: number | null;
    location: string | null;
  }): Promise<void> =>
    rpc<void>("set_store_stock_settings", {
      p_store_id: v.storeId,
      p_product_id: v.productId,
      p_variant_id: v.variantId,
      p_min_qty: v.min,
      p_max_qty: v.max,
      p_location: v.location,
    }),

  lowByStore: async (limit = 300): Promise<LowStockRow[]> => {
    const rows = await rpc<LowStockRow[]>("stock_low_by_store", {
      p_limit: limit,
    });
    return (rows ?? []).map((r) =>
      num(r, ["qty", "min_qty", "max_qty", "in_transit_in"]),
    );
  },

  // ── Traslados ──────────────────────────────────────────────────────────────

  listTransfers: async (f: TransferFilters = {}): Promise<TransferRow[]> => {
    const supabase = createClient();
    let q = supabase
      .from("stock_transfers" as never)
      .select(T_COLS)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(300);
    if (f.statuses && f.statuses.length > 0) q = q.in("status", f.statuses);
    if (f.storeId)
      q = q.or(`origin_store_id.eq.${f.storeId},dest_store_id.eq.${f.storeId}`);
    const n = Number(String(f.search ?? "").replace(/\D/g, ""));
    if (n > 0) q = q.eq("number", n);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as TransferRow[]).map((r) =>
      num(r, ["total_units", "total_value"]),
    );
  },

  getTransfer: async (id: string): Promise<TransferDetail> => {
    const supabase = createClient();
    const [t, items, events] = await Promise.all([
      supabase
        .from("stock_transfers" as never)
        .select(T_COLS)
        .eq("id", id)
        .single(),
      supabase
        .from("stock_transfer_items" as never)
        .select(I_COLS)
        .eq("transfer_id", id)
        .order("sort"),
      supabase
        .from("stock_transfer_events" as never)
        .select(
          "id, kind, from_status, to_status, actor_id, notes, data, created_at",
        )
        .eq("transfer_id", id)
        .order("created_at"),
    ]);
    if (t.error) throw t.error;
    if (items.error) throw items.error;
    if (events.error) throw events.error;

    const evs = (events.data ?? []) as unknown as Omit<
      TransferEvent,
      "actor_name"
    >[];
    const actorIds = [
      ...new Set(evs.map((e) => e.actor_id).filter((x): x is string => !!x)),
    ];
    const names = new Map<string, string>();
    if (actorIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, full_name, email")
        .in("id", actorIds);
      for (const u of (users ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string | null;
      }>) {
        names.set(u.id, u.full_name || u.email || "");
      }
    }

    return {
      ...num(t.data as unknown as TransferRow, ["total_units", "total_value"]),
      items: ((items.data ?? []) as unknown as TransferItem[]).map((i) =>
        num(i, [
          "qty_requested",
          "qty_dispatched",
          "qty_received",
          "unit_cost",
        ]),
      ),
      events: evs.map((e) => ({
        ...e,
        actor_name: e.actor_id ? (names.get(e.actor_id) ?? null) : null,
      })),
    };
  },

  saveTransfer: (v: TransferSaveInput): Promise<string> =>
    rpc<string>("transfer_save", {
      p_id: v.id ?? null,
      p_origin: v.origin_store_id,
      p_dest: v.dest_store_id,
      p_scheduled_for: v.scheduled_for,
      p_notes: v.notes ?? null,
      p_items: v.items.map((i) => ({
        product_id: i.product_id,
        variant_id: i.variant_id,
        qty: i.qty,
        notes: i.notes ?? null,
      })),
      p_carrier: v.carrier ?? null,
    }),

  submit: (id: string): Promise<TransferStatus> =>
    rpc<TransferStatus>("transfer_submit", { p_id: id }),

  approve: (id: string, notes?: string | null): Promise<void> =>
    rpc<void>("transfer_approve", { p_id: id, p_notes: notes ?? null }),

  reject: (id: string, reason: string): Promise<void> =>
    rpc<void>("transfer_reject", { p_id: id, p_reason: reason }),

  reschedule: (
    id: string,
    date: string | null,
    notes?: string | null,
  ): Promise<void> =>
    rpc<void>("transfer_reschedule", {
      p_id: id,
      p_date: date,
      p_notes: notes ?? null,
    }),

  dispatch: (
    id: string,
    items?: Array<{ item_id: string; qty: number }> | null,
    notes?: string | null,
  ): Promise<void> =>
    rpc<void>("transfer_dispatch", {
      p_id: id,
      p_items: items ?? null,
      p_notes: notes ?? null,
    }),

  receive: (
    id: string,
    items: ReceiveLine[],
    close: boolean,
    notes?: string | null,
  ): Promise<TransferStatus> =>
    rpc<TransferStatus>("transfer_receive", {
      p_id: id,
      p_items: items.map((i) => ({
        item_id: i.item_id,
        qty: i.qty,
        reason: i.reason ?? null,
        notes: i.notes ?? null,
      })),
      p_close: close,
      p_notes: notes ?? null,
    }),

  cancel: (id: string, reason: string): Promise<void> =>
    rpc<void>("transfer_cancel", { p_id: id, p_reason: reason }),

  settings: async (): Promise<TransferSettings> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("stock_transfer_settings" as never)
      .select(
        "require_approval, approval_min_units, approval_min_value, cashier_can_dispatch, cashier_can_receive, allow_over_receive, require_difference_reason, block_dispatch_without_stock",
      )
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ...DEFAULT_TRANSFER_SETTINGS };
    const d = data as unknown as TransferSettings;
    return {
      ...d,
      approval_min_units:
        d.approval_min_units == null ? null : Number(d.approval_min_units),
      approval_min_value:
        d.approval_min_value == null ? null : Number(d.approval_min_value),
    };
  },

  saveTransferSettings: async (
    tenantId: string,
    s: TransferSettings,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("stock_transfer_settings" as never)
      .upsert({ tenant_id: tenantId, ...s } as never, {
        onConflict: "tenant_id",
      });
    if (error) throw error;
  },
};
