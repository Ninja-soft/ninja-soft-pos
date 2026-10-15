"use client";

// =============================================================================
// Cobranza 360 (F20-11 · H136 · ADR-131): hooks sobre las RPC de
// 20261126100000_cobranza_360 (lista de cobranza, historia unificada,
// cobradores, asignación y notas de gestión). El front nunca escribe tablas.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Collector, NoteKind, NoteOutcome, Portfolio, Timeline360 } from "@/lib/billing/collection360";

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const client = createClient() as unknown as RpcClient;
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export function usePortfolio(enabled = true) {
  return useQuery({
    queryKey: ["billing-portfolio"],
    queryFn: () => call<Portfolio>("internal_billing_portfolio"),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useTimeline(tenantId: string | null, range?: { from: string | null; to: string | null }) {
  return useQuery({
    queryKey: ["billing-timeline", tenantId, range?.from ?? null, range?.to ?? null],
    queryFn: () =>
      call<Timeline360>("internal_billing_timeline", {
        p_tenant: tenantId,
        p_from: range?.from ?? null,
        p_to: range?.to ?? null,
      }),
    enabled: Boolean(tenantId),
    retry: false,
  });
}

export function useCollectors(enabled = true) {
  return useQuery({
    queryKey: ["billing-collectors"],
    queryFn: () => call<Collector[]>("internal_billing_collectors"),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useCobranza360Mutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["billing-portfolio"] });
    void qc.invalidateQueries({ queryKey: ["billing-timeline"] });
    void qc.invalidateQueries({ queryKey: ["billing-collectors"] });
  };
  return {
    assign: useMutation({
      mutationFn: (v: { tenantIds: string[]; userId: string | null; reason?: string | null }) =>
        call<number>("internal_billing_assign", { p_tenants: v.tenantIds, p_user: v.userId, p_reason: v.reason ?? null }),
      onSuccess: done,
    }),
    addNote: useMutation({
      mutationFn: (v: { tenantId: string; kind: NoteKind; outcome: NoteOutcome | null; body: string; nextActionAt: string | null }) =>
        call<string>("internal_collection_note_add", {
          p_tenant: v.tenantId,
          p_kind: v.kind,
          p_outcome: v.outcome,
          p_body: v.body,
          p_next_action_at: v.nextActionAt,
        }),
      onSuccess: done,
    }),
    voidNote: useMutation({
      mutationFn: (v: { noteId: string; reason: string }) => call<null>("internal_collection_note_void", { p_note: v.noteId, p_reason: v.reason }),
      onSuccess: done,
    }),
  };
}
