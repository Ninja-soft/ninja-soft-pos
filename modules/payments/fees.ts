"use client";

// Comisiones estimadas por medio de pago (F8 · ADR-099): reglas del negocio
// (payment_fee_rules, RLS dueño/encargado + gating del plan en el servidor) y
// el reporte payment_fees_report. Ni la tabla ni la RPC están en los tipos
// generados: se castean args y payload.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { normalizeFeeReport, type FeeReport, type FeeRule, type FeeRuleDraft } from "@/lib/payments/feeEstimate";

const RULE_COLS = "id, method, provider_key, installments, fee_pct, fixed_fee, vat_on_fee, note, created_at";

export const feesApi = {
  rules: async (): Promise<FeeRule[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("payment_fee_rules" as never)
      .select(RULE_COLS)
      .is("deleted_at", null)
      .order("method")
      .order("created_at");
    if (error) throw error;
    return ((data ?? []) as unknown as FeeRule[]).map((r) => ({
      ...r,
      fee_pct: Number(r.fee_pct),
      fixed_fee: Number(r.fixed_fee),
    }));
  },

  providers: async (): Promise<{ key: string; name: string }[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.from("payment_providers").select("key, name").order("sort");
    if (error) throw error;
    return (data ?? []) as { key: string; name: string }[];
  },

  save: async (draft: FeeRuleDraft & { id?: string }): Promise<void> => {
    const supabase = createClient();
    const row = {
      method: draft.method,
      provider_key: draft.provider_key,
      installments: draft.installments,
      fee_pct: draft.fee_pct,
      fixed_fee: draft.fixed_fee,
      vat_on_fee: draft.vat_on_fee,
      note: draft.note,
    };
    if (draft.id) {
      const { error } = await supabase
        .from("payment_fee_rules" as never)
        .update(row as never)
        .eq("id", draft.id);
      if (error) throw error;
      return;
    }
    // tenant_id por default (current_tenant_id()), como el resto de las altas.
    const { error } = await supabase.from("payment_fee_rules" as never).insert(row as never);
    if (error) throw error;
  },

  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("payment_fee_rules" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },

  report: async (fromISO: string, toISO: string, storeId: string | null): Promise<FeeReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("payment_fees_report" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_store_id: storeId,
    } as never);
    if (error) throw error;
    return normalizeFeeReport(data);
  },
};

export function usePaymentFeeRules(enabled = true) {
  return useQuery({ queryKey: ["payment-fee-rules"], queryFn: feesApi.rules, enabled });
}

export function usePaymentProvidersList(enabled = true) {
  return useQuery({ queryKey: ["payment-providers-list"], queryFn: feesApi.providers, enabled, staleTime: 3_600_000 });
}

export function usePaymentFeesReport(fromISO: string, toISO: string, storeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["reports", "payment-fees", fromISO, toISO, storeId],
    queryFn: () => feesApi.report(fromISO, toISO, storeId),
    enabled,
  });
}

export function useSaveFeeRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: feesApi.save,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payment-fee-rules"] });
      void qc.invalidateQueries({ queryKey: ["reports", "payment-fees"] });
    },
  });
}

export function useRemoveFeeRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: feesApi.remove,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payment-fee-rules"] });
      void qc.invalidateQueries({ queryKey: ["reports", "payment-fees"] });
    },
  });
}

/** Mensaje honesto para los errores del servidor. */
export function feeErrorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
  if (m.includes("feature_not_in_plan")) return "Tu plan no incluye las comisiones estimadas.";
  if (m.includes("duplicate key") || m.includes("payment_fee_rules_uniq"))
    return "Ya hay una comisión para ese medio, procesador y cuotas.";
  if (m.includes("forbidden")) return "Sólo el dueño o un encargado cargan las comisiones.";
  return "No se pudo guardar. Probá de nuevo.";
}
