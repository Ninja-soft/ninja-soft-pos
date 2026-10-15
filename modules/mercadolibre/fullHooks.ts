"use client";

// Mercado Libre Full (ADR-142): lecturas con RLS del negocio activo, escrituras
// sólo por RPC SECURITY DEFINER (ml_full_*) y la Edge ml_full (sincronizar,
// recepción leída de ML y costos). El servidor exige mercadolibre y
// mercadolibre_full en cada llamada.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { InboundStatus } from "@/lib/mercadolibre/full";

export interface MlFullSettings {
  lead_days: number;
  target_days: number;
  label_format: string;
  last_sync_at: string | null;
  sync_error: string | null;
  sync_note: string | null;
  costs_synced_at: string | null;
  own_store_id: string | null;
  account_status: string;
}

export interface MlFullRow {
  id: string;
  inventory_id: string;
  ml_item_id: string | null;
  ml_variation_id: string | null;
  title: string;
  variation_label: string | null;
  item_status: string | null;
  product_id: string | null;
  variant_id: string | null;
  product_name: string | null;
  sku: string | null;
  barcode: string | null;
  total: number;
  available: number;
  pending_sales: number;
  not_available: number;
  damaged: number;
  lost: number;
  withdrawal: number;
  internal_process: number;
  transfer: number;
  no_fiscal_coverage: number;
  not_supported: number;
  other: number;
  conditions: Array<{ status: string; condition: string; quantity: number }>;
  in_transit: number;
  own_qty: number | null;
  sold_30d_ops: number | null;
  sold_30d_orders: number | null;
  synced_at: string | null;
  last_error: string | null;
}

export interface MlFullOverview {
  settings: MlFullSettings;
  rows: MlFullRow[];
}

export interface MlFullInboundItem {
  id: string;
  inventory_id: string;
  inventory_row_id: string | null;
  product_id: string;
  variant_id: string | null;
  title: string;
  qty_sent: number;
  qty_received: number;
  qty_damaged: number;
  qty_missing: number;
  missing_action: "lost" | "returned" | null;
  missing_reason: string | null;
  ml_received: number | null;
  ml_damaged: number | null;
}

export interface MlFullInbound {
  id: string;
  account_id: string;
  number: number;
  store_id: string;
  warehouse_id: string | null;
  status: InboundStatus;
  ml_inbound_id: string | null;
  boxes: number;
  scheduled_for: string | null;
  notes: string | null;
  cancel_reason: string | null;
  ml_checked_at: string | null;
  label_units_printed: number;
  label_boxes_printed: number;
  dispatched_at: string | null;
  received_at: string | null;
  closed_at: string | null;
  created_at: string;
  stores: { name: string } | null;
  items: MlFullInboundItem[];
}

export interface MlFullCost {
  id: string;
  period_key: string;
  charge_type: string;
  label: string;
  amount: number;
  currency: string;
  synced_at: string;
}

export interface InboundInput {
  account_id: string;
  store_id: string;
  warehouse_id: string | null;
  ml_inbound_id: string | null;
  boxes: number;
  scheduled_for: string | null;
  notes: string | null;
  items: Array<{ product_id: string; variant_id: string | null; qty: number }>;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw new Error([error.message, (error as { details?: string }).details].filter(Boolean).join(" "));
  return data as T;
}

async function fullEdge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("ml_full", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: { error?: string; message?: string } | null = null;
    try {
      detail = ctx && typeof ctx.json === "function" ? await ctx.json() : null;
    } catch {
      detail = null;
    }
    throw new Error([detail?.error, detail?.message].filter(Boolean).join(": ") || error.message);
  }
  return data as T;
}

const from = (t: string) => createClient().from(t as never);

export const mlFullApi = {
  overview: (accountId: string) => rpc<MlFullOverview>("ml_full_overview", { p_account: accountId }),

  inbounds: async (accountId: string): Promise<MlFullInbound[]> => {
    const { data, error } = await from("ml_full_inbounds")
      .select(
        "id, account_id, number, store_id, warehouse_id, status, ml_inbound_id, boxes, scheduled_for, notes, cancel_reason, " +
          "ml_checked_at, label_units_printed, label_boxes_printed, dispatched_at, received_at, closed_at, created_at, " +
          "stores(name), items:ml_full_inbound_items(id, inventory_id, inventory_row_id, product_id, variant_id, title, qty_sent, " +
          "qty_received, qty_damaged, qty_missing, missing_action, missing_reason, ml_received, ml_damaged)",
      )
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []) as unknown as MlFullInbound[];
  },

  costs: async (accountId: string): Promise<MlFullCost[]> => {
    const { data, error } = await from("ml_full_costs")
      .select("id, period_key, charge_type, label, amount, currency, synced_at")
      .eq("account_id", accountId)
      .order("period_key", { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []) as unknown as MlFullCost[];
  },
};

export function useMlFullOverview(accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ml-full", "overview", accountId],
    queryFn: () => mlFullApi.overview(accountId!),
    enabled: Boolean(accountId) && enabled,
  });
}

export function useMlFullInbounds(accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ml-full", "inbounds", accountId],
    queryFn: () => mlFullApi.inbounds(accountId!),
    enabled: Boolean(accountId) && enabled,
  });
}

export function useMlFullCosts(accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ml-full", "costs", accountId],
    queryFn: () => mlFullApi.costs(accountId!),
    enabled: Boolean(accountId) && enabled,
  });
}

export function useMlFullMutations() {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ["ml-full"] });
  };
  return {
    sync: useMutation({
      mutationFn: (accountId: string) => fullEdge<{ ok: boolean; sync?: { inventories: number; errors: number } }>({ action: "sync", account_id: accountId }),
      onSettled: inv,
    }),
    checkReception: useMutation({
      mutationFn: (v: { accountId: string; inboundId: string }) =>
        fullEdge<{ ok: boolean; lines: Array<{ inventory_id: string; received: number; damaged: number }> }>({
          action: "check_reception",
          account_id: v.accountId,
          inbound_id: v.inboundId,
        }),
      onSettled: inv,
    }),
    costs: useMutation({
      mutationFn: (accountId: string) => fullEdge<{ ok: boolean; saved: number }>({ action: "costs", account_id: accountId }),
      onSettled: inv,
    }),
    saveSettings: useMutation({
      mutationFn: (v: { accountId: string; lead_days: number; target_days: number; label_format: string }) =>
        rpc("ml_full_settings_save", {
          p_account: v.accountId,
          p: { lead_days: v.lead_days, target_days: v.target_days, label_format: v.label_format },
        }),
      onSuccess: inv,
    }),
    saveInbound: useMutation({
      mutationFn: (v: { id: string | null; input: InboundInput }) => rpc<string>("ml_full_inbound_save", { p_id: v.id, p: v.input }),
      onSuccess: inv,
    }),
    setMl: useMutation({
      mutationFn: (v: { id: string; mlInboundId: string; boxes: number | null }) =>
        rpc("ml_full_inbound_set_ml", { p_id: v.id, p_ml_inbound_id: v.mlInboundId, p_boxes: v.boxes }),
      onSuccess: inv,
    }),
    dispatch: useMutation({
      mutationFn: (id: string) => rpc<{ ok: boolean; units: number }>("ml_full_inbound_dispatch", { p_id: id }),
      onSuccess: inv,
    }),
    receive: useMutation({
      mutationFn: (v: {
        id: string;
        close: boolean;
        lines: Array<{ item_id: string; received: number; damaged: number; missing_action?: string | null; missing_reason?: string | null }>;
      }) => rpc<{ ok: boolean; status: string }>("ml_full_inbound_receive", { p_id: v.id, p_lines: v.lines, p_close: v.close }),
      onSuccess: inv,
    }),
    cancel: useMutation({
      mutationFn: (v: { id: string; reason: string }) => rpc("ml_full_inbound_cancel", { p_id: v.id, p_reason: v.reason }),
      onSuccess: inv,
    }),
    labelsPrinted: useMutation({
      mutationFn: (v: { id: string; kind: "units" | "boxes"; count: number }) =>
        rpc("ml_full_labels_printed", { p_id: v.id, p_kind: v.kind, p_count: v.count }),
      onSuccess: inv,
    }),
  };
}
