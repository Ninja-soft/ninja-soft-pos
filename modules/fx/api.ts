"use client";

// =============================================================================
// Cotización del dólar (ADR-135): venta del oficial de ArgentinaDatos, diaria,
// con carga manual del super_admin que manda sobre la de la API ese día.
// Lecturas por RLS (staff interno), escrituras por RPC auditadas y la Edge
// platform_fx_sync para traerla ahora.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient, INTERNAL_SCOPE_HEADER } from "@/lib/supabase/client";
import type { DailyFxRate, FxSource } from "@/supabase/functions/_shared/fx/rates";

type Res = { data: unknown; error: { message: string } | null };
type Client = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<Res>;
  from: (t: string) => {
    select: (cols: string) => {
      order: (c: string, o?: { ascending: boolean }) => { limit: (n: number) => Promise<Res> };
    };
  };
  functions: {
    invoke: (
      fn: string,
      o: { body: unknown; headers?: Record<string, string> },
    ) => Promise<{ data: unknown; error: { message: string; context?: Response } | null }>;
  };
};
const db = () => createClient() as unknown as Client;

export interface FxDailyRow {
  rate_date: string;
  venta: number;
  compra: number | null;
  source: FxSource;
  note: string | null;
  updated_at: string;
}

export interface FxRun {
  id: string;
  origin: "cron" | "manual" | "backfill";
  status: "ok" | "error";
  attempts: number;
  received: number;
  upserted: number;
  latest_date: string | null;
  message: string | null;
  created_at: string;
}

export interface FxSyncResult {
  status: "ok" | "error";
  message: string;
  upserted?: number;
  latest_date?: string | null;
}

const K = ["fx-rates"] as const;

export const toDaily = (r: FxDailyRow): DailyFxRate => ({ date: r.rate_date, rate: Number(r.venta), source: r.source, note: r.note });

/** Una cotización por día (manual > API), de los últimos 2 años y un poco más. */
export function useFxDaily(from: string, enabled = true) {
  return useQuery({
    queryKey: [...K, "daily", from],
    enabled,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await db().rpc("platform_fx_daily_rates", { p_casa: "oficial", p_from: from, p_to: null });
      if (error) throw new Error(error.message);
      return ((data ?? []) as FxDailyRow[]).map((r) => ({ ...r, venta: Number(r.venta), compra: r.compra === null ? null : Number(r.compra) }));
    },
  });
}

export function useFxLastRun(enabled = true) {
  return useQuery({
    queryKey: [...K, "last-run"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await db().from("platform_fx_runs").select("*").order("created_at", { ascending: false }).limit(1);
      if (r.error) throw new Error(r.error.message);
      return ((r.data ?? []) as FxRun[])[0] ?? null;
    },
  });
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const { error } = await db().rpc(fn, args);
  if (error) throw new Error(error.message);
}

async function sync(): Promise<FxSyncResult> {
  const { data, error } = await db().functions.invoke("platform_fx_sync", {
    body: { mode: "manual" },
    headers: { [INTERNAL_SCOPE_HEADER]: "internal" },
  });
  if (!error) {
    const res = (data ?? {}) as FxSyncResult & { error?: string };
    if (res.error) throw new Error(res.error);
    return res;
  }
  let code: string | null = null;
  const ctx = error.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      code = ((await ctx.json()) as { error?: string }).error ?? null;
    } catch {
      /* cuerpo no JSON */
    }
  }
  throw new Error(code ?? error.message ?? "fx_sync_failed");
}

export function useFxMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: K });
    void qc.invalidateQueries({ queryKey: ["staff-payouts"] });
  };
  const setManual = useMutation({
    mutationFn: (a: { date: string; venta: number; compra: number | null; note: string | null }) =>
      rpc("internal_fx_set_manual", { p_date: a.date, p_venta: a.venta, p_compra: a.compra, p_note: a.note }),
    onSuccess: done,
  });
  const clearManual = useMutation({
    mutationFn: (a: { date: string; reason: string }) => rpc("internal_fx_clear_manual", { p_date: a.date, p_reason: a.reason }),
    onSuccess: done,
  });
  const syncNow = useMutation({ mutationFn: sync, onSuccess: done });
  return { setManual, clearManual, syncNow };
}
