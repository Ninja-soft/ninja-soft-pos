"use client";

// Prevención de fraude y riesgo operativo (F16 · H82, ADR-091). Lecturas por
// RPC (señales por persona, umbrales) y por tabla con RLS (marcas, sólo
// dueño o encargado); escrituras por RPC. No están en los tipos generados.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { RiskSettings } from "@/lib/risk/riskScore";
import type { RiskSignalsResponse } from "@/lib/risk/operationalRisk";

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

export type RiskFlagStatus = "pendiente" | "revisada" | "descartada";

export interface RiskFlag {
  id: string;
  store_id: string | null;
  kind: "return" | "void";
  entity_id: string;
  sale_id: string | null;
  actor_id: string | null;
  amount: number;
  score: number;
  reasons: string[];
  status: RiskFlagStatus;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  actor: { full_name: string | null; email: string | null } | null;
  sale: { number: number } | null;
}

export function useRiskSignals(fromIso: string, toIso: string, storeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["risk-signals", fromIso, toIso, storeId],
    enabled,
    queryFn: () =>
      rpc<RiskSignalsResponse>("operational_risk_signals", { p_from: fromIso, p_to: toIso, p_store_id: storeId }),
  });
}

export function useRiskFlags(status: RiskFlagStatus | "todas", storeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["risk-flags", status, storeId],
    enabled,
    queryFn: async (): Promise<RiskFlag[]> => {
      let q = createClient()
        .from("risk_flags" as never)
        .select(
          "id, store_id, kind, entity_id, sale_id, actor_id, amount, score, reasons, status, review_note, " +
            "reviewed_at, created_at, actor:users!risk_flags_actor_id_fkey(full_name, email), sale:sales(number)",
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (status !== "todas") q = q.eq("status", status);
      if (storeId) q = q.eq("store_id", storeId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as RiskFlag[];
    },
  });
}

export function useRiskSettings(enabled: boolean) {
  return useQuery({
    queryKey: ["risk-settings"],
    enabled,
    queryFn: () => rpc<RiskSettings>("risk_settings_get", {}),
  });
}

export function useRiskMutations() {
  const qc = useQueryClient();
  const saveSettings = useMutation({
    mutationFn: (s: RiskSettings) => rpc<RiskSettings>("risk_settings_save", { p_settings: s }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["risk-settings"] });
      qc.invalidateQueries({ queryKey: ["risk-signals"] });
    },
  });
  const review = useMutation({
    mutationFn: (i: { id: string; status: RiskFlagStatus; note: string }) =>
      rpc<void>("risk_flag_review", { p_id: i.id, p_status: i.status, p_note: i.note.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["risk-flags"] });
      qc.invalidateQueries({ queryKey: ["risk-signals"] });
      qc.invalidateQueries({ queryKey: ["commerce-cockpit"] });
    },
  });
  return { saveSettings, review };
}
