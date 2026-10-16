"use client";

// Fuente de los asientos de liquidación y NubCeo en la Contabilidad (F23 ·
// H153, ADR-162): quién arma el asiento de cada liquidación (NinjaPOS o
// NubCeo), la tabla de equivalencias de cuentas de NubCeo y el estado de
// conciliación que devuelve NubCeo. Todo por RPC SECURITY DEFINER auditada;
// tolerante a una base sin la migración (devuelve vacío).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { isMissingSchema } from "@/lib/treasury/accounts";

export type SettlementSource = "ninjapos" | "nubceo";

export interface SettlementSourceInfo {
  source: SettlementSource;
  from: string | null;
  before: SettlementSource;
  nubceo_feature: boolean;
  nubceo_configured: boolean;
  first_open_month: string | null;
  nubceo_headers: number;
  nubceo_in_journal: number;
  nubceo_issues: number;
}

export interface NubceoAccountRow {
  nubceo_code: string;
  nubceo_subcode: string;
  nubceo_name: string | null;
  entries: number;
  amount: number;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
}

export interface ReconciliationCounts {
  reconciled: number;
  pending: number;
  difference: number;
  unknown: number;
  last_pull: string | null;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

export const settlementSourceApi = {
  info: async (): Promise<SettlementSourceInfo | null> => {
    try {
      return await rpc<SettlementSourceInfo>("acc_settlement_source_info");
    } catch (e) {
      if (isMissingSchema(e)) return null;
      throw e;
    }
  },
  /** Cambia la fuente desde el primer día de un mes abierto y rearma el primer lote. */
  set: (source: SettlementSource, from: string) =>
    rpc<{ changed: boolean; more?: boolean; next_offset?: number; deleted_entries?: number; processed?: number; failed?: number }>(
      "acc_settlement_source_set",
      { p_source: source, p_from: from },
    ),
  resync: (offset: number) =>
    rpc<{ processed: number; failed: number; more: boolean; next_offset: number }>("acc_settlement_source_resync", {
      p_offset: offset,
    }),
  nubceoAccounts: async (): Promise<NubceoAccountRow[]> => {
    try {
      const rows = await rpc<NubceoAccountRow[]>("nubceo_ledger_accounts");
      return (rows ?? []).map((r) => ({ ...r, amount: Number(r.amount), entries: Number(r.entries) }));
    } catch (e) {
      if (isMissingSchema(e)) return [];
      throw e;
    }
  },
  mapNubceoAccount: (v: { code: string; subcode: string; accountId: string | null; name?: string | null }) =>
    rpc<{ retried: number }>("nubceo_account_map_set", {
      p_code: v.code,
      p_subcode: v.subcode,
      p_account: v.accountId,
      p_name: v.name ?? null,
    }),
  reconciliationCounts: async (): Promise<ReconciliationCounts | null> => {
    try {
      const r = await rpc<ReconciliationCounts>("nubceo_reconciliation_counts", { p_from: null, p_to: null });
      return r
        ? {
            reconciled: Number(r.reconciled) || 0,
            pending: Number(r.pending) || 0,
            difference: Number(r.difference) || 0,
            unknown: Number(r.unknown) || 0,
            last_pull: r.last_pull ?? null,
          }
        : null;
    } catch (e) {
      if (isMissingSchema(e)) return null;
      throw e;
    }
  },
  /** Trae ya el estado de conciliación de NubCeo (Edge nubceo_sync). */
  pullReconciliation: async (): Promise<{ ok: boolean; rows: number; updated: number; message: string }> => {
    const { data, error } = await createClient().functions.invoke("nubceo_sync", { body: { action: "reconciliation_pull" } });
    if (error) throw error;
    return data as { ok: boolean; rows: number; updated: number; message: string };
  },
};

const K = ["accounting", "settlement-source"] as const;

export function useSettlementSourceInfo(enabled = true) {
  return useQuery({ queryKey: [...K, "info"], queryFn: () => settlementSourceApi.info(), enabled });
}

export function useNubceoLedgerAccounts(enabled = true) {
  return useQuery({ queryKey: [...K, "nubceo-accounts"], queryFn: () => settlementSourceApi.nubceoAccounts(), enabled });
}

export function useNubceoReconciliationCounts(enabled = true) {
  return useQuery({
    queryKey: ["nubceo", "reconciliation-counts"],
    queryFn: () => settlementSourceApi.reconciliationCounts(),
    enabled,
  });
}

export function useSettlementSourceMutations() {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ["accounting"] });
    void qc.invalidateQueries({ queryKey: ["nubceo"] });
  };
  return {
    /** Cambia la fuente y sigue rearmando por lotes hasta terminar. */
    set: useMutation({
      mutationFn: async (v: { source: SettlementSource; from: string }) => {
        const r = await settlementSourceApi.set(v.source, v.from);
        let more = Boolean(r.more);
        let offset = Number(r.next_offset ?? 0);
        let guard = 0;
        while (more && guard < 40) {
          const n = await settlementSourceApi.resync(offset);
          more = n.more;
          offset = n.next_offset;
          guard++;
        }
        return r;
      },
      onSuccess: inv,
    }),
    mapNubceoAccount: useMutation({ mutationFn: settlementSourceApi.mapNubceoAccount, onSuccess: inv }),
    pullReconciliation: useMutation({ mutationFn: settlementSourceApi.pullReconciliation, onSuccess: inv }),
  };
}
