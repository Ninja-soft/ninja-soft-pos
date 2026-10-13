"use client";

// Inventario PRO (F14 · H64, ADR-092): conteo cíclico por clase ABC y
// garantías por número de serie. Escritura sólo por RPC SECURITY DEFINER.
// Las tablas y RPC nuevas no están en los tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_CYCLE_POLICY, type CycleDueRow, type CyclePolicy } from "@/lib/stock/cycleCount";
import type { ClaimStatus, SerialLookup } from "@/lib/stock/serialWarranty";

export interface CycleCountRecord {
  id: string;
  store_id: string;
  notes: string | null;
  lines_count: number;
  exact_count: number;
  accuracy_pct: number | null;
  units_diff: number;
  value_diff: number;
  created_at: string;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

export const inventoryProApi = {
  policy: async (): Promise<CyclePolicy> => {
    const p = await rpc<Partial<CyclePolicy>>("cycle_count_policy_get");
    const out = { ...DEFAULT_CYCLE_POLICY };
    for (const k of Object.keys(out) as (keyof CyclePolicy)[]) if (p?.[k] != null) out[k] = Number(p[k]);
    return out;
  },
  savePolicy: (p: CyclePolicy) => rpc<CyclePolicy>("cycle_count_policy_save", { p }),
  due: async (storeId: string): Promise<CycleDueRow[]> =>
    ((await rpc<CycleDueRow[]>("cycle_count_due", { p_store_id: storeId, p_limit: null })) ?? []).map((r) => ({
      ...r,
      sales_value: Number(r.sales_value),
      system_qty: Number(r.system_qty),
      due_days: Number(r.due_days),
    })),
  submit: (v: {
    storeId: string;
    lines: { product_id: string; variant_id: string | null; counted: number; abc_class: string }[];
    notes?: string | null;
  }) =>
    rpc<{ id: string; lines: number; exact: number; accuracy_pct: number; units_diff: number; value_diff: number }>(
      "cycle_count_submit",
      { p_store_id: v.storeId, p_lines: v.lines, p_notes: v.notes ?? null },
    ),
  history: async (storeId: string): Promise<CycleCountRecord[]> => {
    const { data, error } = await createClient()
      .from("cycle_counts" as never)
      .select("id, store_id, notes, lines_count, exact_count, accuracy_pct, units_diff, value_diff, created_at")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return ((data ?? []) as unknown as CycleCountRecord[]).map((r) => ({
      ...r,
      accuracy_pct: r.accuracy_pct == null ? null : Number(r.accuracy_pct),
      units_diff: Number(r.units_diff),
      value_diff: Number(r.value_diff),
    }));
  },

  lookup: (serial: string) => rpc<SerialLookup>("serial_lookup", { p_serial: serial }),
  openClaim: (v: { serial: string; reason: string; saleId?: string | null }) =>
    rpc<string>("serial_claim_open", { p_serial: v.serial, p_reason: v.reason, p_sale_id: v.saleId ?? null }),
  updateClaim: (v: { id: string; status: ClaimStatus; resolution?: string | null }) =>
    rpc<void>("serial_claim_update", { p_id: v.id, p_status: v.status, p_resolution: v.resolution ?? null }),
};

export function useCyclePolicy(enabled = true) {
  return useQuery({ queryKey: ["cycle-policy"], queryFn: inventoryProApi.policy, enabled });
}

export function useCycleDue(storeId: string | null) {
  return useQuery({
    queryKey: ["cycle-due", storeId],
    queryFn: () => inventoryProApi.due(storeId!),
    enabled: Boolean(storeId),
  });
}

export function useCycleHistory(storeId: string | null) {
  return useQuery({
    queryKey: ["cycle-history", storeId],
    queryFn: () => inventoryProApi.history(storeId!),
    enabled: Boolean(storeId),
  });
}

export function useCycleMutations() {
  const qc = useQueryClient();
  return {
    submit: useMutation({
      mutationFn: inventoryProApi.submit,
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["cycle-due"] });
        void qc.invalidateQueries({ queryKey: ["cycle-history"] });
        void qc.invalidateQueries({ queryKey: ["products"] });
      },
    }),
    savePolicy: useMutation({
      mutationFn: inventoryProApi.savePolicy,
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["cycle-policy"] });
        void qc.invalidateQueries({ queryKey: ["cycle-due"] });
      },
    }),
  };
}

export function useSerialLookup(serial: string | null) {
  return useQuery({
    queryKey: ["serial-lookup", serial],
    queryFn: () => inventoryProApi.lookup(serial!),
    enabled: Boolean(serial && serial.trim().length >= 3),
    retry: false,
  });
}

export function useSerialClaimMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["serial-lookup"] });
  return {
    open: useMutation({ mutationFn: inventoryProApi.openClaim, onSuccess: invalidate }),
    update: useMutation({ mutationFn: inventoryProApi.updateClaim, onSuccess: invalidate }),
  };
}
