"use client";

// Datos del procesador de un cobro (ADR-061): Edge payment_provider_data,
// intents de los cobros de la venta y terminal. Sondeo cada 15 s mientras algo
// puede cambiar (el proyecto no usa Realtime).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { ProcessorPaymentData } from "@/supabase/functions/_shared/processorData";
import { isIntentRef, type PaymentIntentRow } from "@/lib/sales/paymentDetail";

export type ProviderDataResponse =
  | { status: "ok" | "stale"; cached?: boolean; fetched_at: string; data: ProcessorPaymentData; error?: string }
  | { status: "no_provider" }
  | { status: "no_api"; provider: string }
  | { status: "error"; error: string; detail?: string | null; provider?: string };

async function invokeProviderData(paymentId: string, refresh: boolean): Promise<ProviderDataResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("payment_provider_data", {
    body: { payment_id: paymentId, refresh },
  });
  let res = data as ProviderDataResponse | { error?: string } | null;
  if (error) {
    const ctx = (error as { context?: Response }).context;
    try {
      res = ctx ? await ctx.json() : null;
    } catch {
      res = null;
    }
    if (!res) return { status: "error", error: "provider_error" };
  }
  if (res && "status" in res && res.status) return res as ProviderDataResponse;
  return { status: "error", error: (res as { error?: string } | null)?.error ?? "provider_error" };
}

const providerKey = (paymentId: string | null) => ["sales", "provider-data", paymentId] as const;

export function useProviderData(paymentId: string | null, opts: { enabled: boolean; live?: boolean }) {
  return useQuery({
    queryKey: providerKey(paymentId),
    queryFn: () => invokeProviderData(paymentId!, false),
    enabled: opts.enabled && Boolean(paymentId),
    staleTime: 60_000,
    // Automático: como mucho cada 60 s (el servidor guarda la foto 10 min).
    refetchInterval: opts.live ? 60_000 : false,
    retry: false,
  });
}

export function useRefreshProviderData(paymentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invokeProviderData(paymentId!, true),
    onSuccess: (res) => qc.setQueryData(providerKey(paymentId), res),
  });
}

/** Foto guardada (sólo dueño o encargado por RLS): se muestra sin consultar. */
export function useProviderSnapshot(paymentId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["sales", "provider-snapshot", paymentId],
    enabled: enabled && Boolean(paymentId),
    staleTime: 60_000,
    queryFn: async (): Promise<{ normalized: ProcessorPaymentData; fetched_at: string } | null> => {
      const { data, error } = await createClient()
        .from("payment_provider_snapshots" as never)
        .select("normalized, fetched_at")
        .eq("payment_id", paymentId!)
        .order("fetched_at", { ascending: false })
        .limit(1);
      if (error) return null;
      const row = (data as unknown as { normalized: ProcessorPaymentData; fetched_at: string }[] | null)?.[0];
      return row ?? null;
    },
  });
}

export type SalePaymentIntents = {
  intents: PaymentIntentRow[];
  terminals: Record<string, string>;
};

/** Intents de los cobros de la venta (payments.reference) y nombres de terminal. */
export function useSalePaymentIntents(
  saleId: string | null,
  refs: (string | null)[],
  opts: { enabled: boolean; live: boolean },
) {
  const ids = [...new Set(refs.filter(isIntentRef))].sort();
  return useQuery({
    queryKey: ["sales", "payment-intents", saleId, ids.join(",")],
    enabled: opts.enabled && Boolean(saleId) && ids.length > 0,
    refetchInterval: opts.live ? 15_000 : false,
    queryFn: async (): Promise<SalePaymentIntents> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("mp_payment_intents")
        .select(
          "id, provider_key, status, amount, mp_payment_id, mp_order_id, preference_id, point_device_id, payment_terminal_id, created_at, updated_at, secret_store_id" as "*",
        )
        .in("id", ids);
      if (error) throw error;
      const intents = ((data ?? []) as unknown as PaymentIntentRow[]).map((i) => ({ ...i, amount: Number(i.amount) }));
      const termIds = [...new Set(intents.map((i) => i.payment_terminal_id).filter((v): v is string => !!v))];
      const terminals: Record<string, string> = {};
      if (termIds.length > 0) {
        const { data: ts } = await supabase
          .from("payment_terminals" as never)
          .select("id, label")
          .in("id", termIds);
        for (const t of (ts ?? []) as unknown as { id: string; label: string }[]) terminals[t.id] = t.label;
      }
      return { intents, terminals };
    },
  });
}
