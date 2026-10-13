"use client";

// Control comercial (F14 · H63, H67, ADR-092): aprobaciones de cambios y
// alertas de margen. Todo por RPC SECURITY DEFINER (el servidor valida rol,
// plan y negocio). Las RPC nuevas no están en los tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  DEFAULT_GOVERNANCE,
  type Governance,
  type RequestEntity,
  type RequestStatus,
} from "@/lib/commercial/governance";
import type { MarginAlertRow, MarginSummary } from "@/lib/commercial/margins";

export interface ChangeRequest {
  id: string;
  entity_type: RequestEntity;
  entity_id: string;
  entity_label: string | null;
  kind: "create" | "update";
  before_data: Record<string, unknown>;
  proposed: Record<string, unknown>;
  impact: Record<string, unknown>;
  status: RequestStatus;
  requested_by: string | null;
  requested_name: string | null;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

const n = (v: unknown, d = 0) => (v == null ? d : Number(v));

export const commercialApi = {
  governance: async (): Promise<Governance> => {
    const g = await rpc<Record<string, unknown>>("commercial_governance_get");
    return {
      ...DEFAULT_GOVERNANCE,
      ...(g as Partial<Governance>),
      promo_pct: n(g?.promo_pct, 20),
      promo_amount: g?.promo_amount == null ? null : Number(g.promo_amount),
      request_ttl_days: n(g?.request_ttl_days, 7),
    };
  },
  saveGovernance: (g: Omit<Governance, "has_feature">) => rpc<Governance>("commercial_governance_save", { p: g }),
  requests: async (status: "pending" | "all"): Promise<ChangeRequest[]> =>
    (await rpc<ChangeRequest[]>("commercial_requests", { p_status: status, p_limit: 200 })) ?? [],
  decide: (v: { id: string; approve: boolean; note?: string | null }) =>
    rpc<{ id: string; status: RequestStatus }>("commercial_change_decide", {
      p_id: v.id,
      p_approve: v.approve,
      p_note: v.note ?? null,
    }),
  cancel: (id: string) => rpc<void>("commercial_change_cancel", { p_id: id }),

  marginSettings: async (): Promise<{ min_margin_pct: number; notify: boolean }> => {
    const s = await rpc<{ min_margin_pct: number; notify: boolean }>("margin_settings_get");
    return { min_margin_pct: n(s?.min_margin_pct, 20), notify: s?.notify !== false };
  },
  saveMarginSettings: (v: { min: number; notify: boolean }) =>
    rpc("margin_settings_save", { p_min_margin_pct: v.min, p_notify: v.notify }),
  marginAlerts: async (): Promise<MarginAlertRow[]> =>
    ((await rpc<MarginAlertRow[]>("margin_alerts", { p_min_pct: null, p_limit: 500 })) ?? []).map((r) => ({
      ...r,
      price: Number(r.price),
      cost: Number(r.cost),
      margin_pct: Number(r.margin_pct),
      min_price: r.min_price == null ? null : Number(r.min_price),
      suggested_price: Number(r.suggested_price),
    })),
  marginSummary: async (): Promise<MarginSummary> => {
    const s = await rpc<Record<string, unknown>>("margin_summary");
    return {
      min_margin_pct: n(s?.min_margin_pct, 20),
      active: n(s?.active),
      without_cost: n(s?.without_cost),
      negative: n(s?.negative),
      low: n(s?.low),
      below_min_price: n(s?.below_min_price),
    };
  },
};

export function useGovernance(enabled = true) {
  return useQuery({ queryKey: ["commercial-governance"], queryFn: commercialApi.governance, enabled });
}

export function useChangeRequests(status: "pending" | "all", enabled = true) {
  return useQuery({
    queryKey: ["commercial-requests", status],
    queryFn: () => commercialApi.requests(status),
    enabled,
  });
}

export function useCommercialMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["commercial-requests"] });
    void qc.invalidateQueries({ queryKey: ["commercial-governance"] });
    void qc.invalidateQueries({ queryKey: ["promotions"] });
    void qc.invalidateQueries({ queryKey: ["pos", "payment-plans"] });
  };
  return {
    saveGovernance: useMutation({ mutationFn: commercialApi.saveGovernance, onSuccess: invalidate }),
    decide: useMutation({ mutationFn: commercialApi.decide, onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: commercialApi.cancel, onSuccess: invalidate }),
  };
}

export function useMarginSettings(enabled = true) {
  return useQuery({ queryKey: ["margin-settings"], queryFn: commercialApi.marginSettings, enabled });
}

export function useMarginAlerts(enabled = true) {
  return useQuery({ queryKey: ["margin-alerts"], queryFn: commercialApi.marginAlerts, enabled });
}

export function useMarginSummary(enabled = true) {
  return useQuery({ queryKey: ["margin-summary"], queryFn: commercialApi.marginSummary, enabled });
}

export function useSaveMarginSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commercialApi.saveMarginSettings,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["margin-settings"] });
      void qc.invalidateQueries({ queryKey: ["margin-alerts"] });
      void qc.invalidateQueries({ queryKey: ["margin-summary"] });
    },
  });
}
