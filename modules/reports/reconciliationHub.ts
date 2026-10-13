"use client";

// Conciliación (hub): lecturas de todos los procesadores juntos y acciones en
// lote. No hay RPC nueva: lee settlement_lines con RLS (dueño o encargado,
// filtro explícito por tenant, ADR-052) y escribe con las de siempre:
//   - set_payments_reconciled  (tarjetas, ADR-044) en tandas de 200 ids;
//   - settlement_line_resolve  (marcar revisado, ADR-061) una línea por vez;
//   - payment_dispute_ack      (marcar visto, ADR-064) una disputa por vez.
// Cada RPC valida rol, plan y negocio en el servidor: la UI no es la barrera.

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { SettlementLineRow } from "@/lib/reports/processorReconciliation";
import type { HubUnmatched } from "@/lib/reports/reconciliationHub";
import { runInBatches, type BatchReport } from "@/lib/reports/selection";
import { LINE_COLS, toNum, type MatchResponse } from "./processorReconciliation";

const PAGE = 1000;
const MAX_ROWS = 20_000;

async function listAllLines(fromISO: string, toISO: string): Promise<SettlementLineRow[]> {
  const supabase = createClient();
  const tenantId = await getCurrentTenantId();
  const out: SettlementLineRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    let q = supabase
      .from("settlement_lines" as never)
      .select(LINE_COLS)
      .gte("operation_at", fromISO)
      .lt("operation_at", toISO);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q
      .order("operation_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = ((data ?? []) as unknown as SettlementLineRow[]).map(toNum);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Líneas de liquidación de todos los procesadores del período. */
export function useAllSettlementLines(fromISO: string, toISO: string, enabled: boolean) {
  return useQuery({
    queryKey: ["settlements", "all-lines", fromISO, toISO],
    queryFn: () => listAllLines(fromISO, toISO),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Cruce de cada procesador con datos (misma clave de caché que la vista de un
 * procesador): devuelve las ventas sin cobro de todos juntos.
 */
export function useHubMatches(providers: string[], fromISO: string, toISO: string, enabled: boolean) {
  const qc = useQueryClient();
  const results = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ["settlements", "match", provider, fromISO, toISO],
      enabled,
      staleTime: 60_000,
      retry: false,
      queryFn: async (): Promise<MatchResponse> => {
        const { data, error } = await createClient().functions.invoke("settlements", {
          body: { action: "match", provider, from: fromISO, to: toISO },
        });
        if (error) throw error;
        const res = data as MatchResponse;
        if (res.updated > 0) await qc.invalidateQueries({ queryKey: ["settlements", "lines", provider] });
        if (res.updated > 0) await qc.invalidateQueries({ queryKey: ["settlements", "all-lines"] });
        return res;
      },
    })),
  });
  const unmatched: HubUnmatched[] = [];
  results.forEach((r, i) => {
    for (const u of r.data?.unmatched_payments ?? []) unmatched.push({ ...u, provider: providers[i]! });
  });
  return {
    unmatched,
    isFetching: results.some((r) => r.isFetching),
    errors: results.filter((r) => r.isError).length,
  };
}

export interface SaleInfo {
  number: number;
  status: string;
  store_id: string | null;
}

/** Número y sucursal de las ventas cruzadas (ticket y filtro por sucursal). */
export function useSaleInfo(saleIds: string[]) {
  const key = [...new Set(saleIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["settlements", "sale-info", key],
    enabled: key.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Record<string, SaleInfo>> => {
      const out: Record<string, SaleInfo> = {};
      const supabase = createClient();
      for (let i = 0; i < key.length; i += 200) {
        const { data, error } = await supabase
          .from("sales")
          .select("id, number, status, store_id")
          .in("id", key.slice(i, i + 200));
        if (error) throw error;
        for (const s of (data ?? []) as { id: string; number: number; status: string; store_id: string | null }[]) {
          out[s.id] = { number: s.number, status: s.status, store_id: s.store_id };
        }
      }
      return out;
    },
  });
}

// ── Acciones en lote ─────────────────────────────────────────────────────────

/** Tamaño de tanda de set_payments_reconciled (la RPC acepta hasta 5.000). */
export const RECONCILE_BATCH = 200;

type Progress = (done: number, total: number) => void;

/** Concilia (o desconcilia) cobros de tarjeta en tandas. */
export function useBulkReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { ids: string[]; reconciled: boolean; onProgress?: Progress }): Promise<BatchReport<string>> =>
      runInBatches(
        v.ids,
        RECONCILE_BATCH,
        async (batch) => {
          const { error } = await createClient().rpc("set_payments_reconciled" as never, {
            p_payment_ids: batch,
            p_reconciled: v.reconciled,
          } as never);
          if (error) throw error;
        },
        { onProgress: v.onProgress },
      ),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["reports", "card-reconciliation"] });
    },
  });
}

/** Marca revisadas varias líneas del procesador (una RPC por línea, de a 4). */
export function useBulkReviewLines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { lineIds: string[]; note?: string | null; onProgress?: Progress }) =>
      runInBatches(
        v.lineIds,
        1,
        async ([id]) => {
          const { error } = await createClient().rpc("settlement_line_resolve" as never, {
            p_line_id: id,
            p_action: "ignore",
            p_payment_id: null,
            p_note: v.note ?? null,
          } as never);
          if (error) throw error;
        },
        { concurrency: 4, onProgress: v.onProgress },
      ),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["settlements"] });
      qc.invalidateQueries({ queryKey: ["reports", "card-payments"] });
    },
  });
}

/** Marca como vistas varias disputas (una RPC por disputa, de a 4). */
export function useBulkAckDisputes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { ids: string[]; onProgress?: Progress }) =>
      runInBatches(
        v.ids,
        1,
        async ([id]) => {
          const { error } = await createClient().rpc("payment_dispute_ack" as never, { p_id: id } as never);
          if (error) throw error;
        },
        { concurrency: 4, onProgress: v.onProgress },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: ["disputes"] }),
  });
}
