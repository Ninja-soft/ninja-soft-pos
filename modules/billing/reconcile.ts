"use client";

// =============================================================================
// Conciliación con Mercado Pago (F20-10 · H136 · ADR-131): tipos y hooks sobre
// las RPC de 20261126100000_cobranza_360 y la Edge platform_mp_reconcile.
// La Edge sólo lee la API de MP (GET); la bandeja resuelve por RPC con motivo.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient, INTERNAL_SCOPE_HEADER } from "@/lib/supabase/client";

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const client = createClient() as unknown as RpcClient;
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

// ── Tipos ───────────────────────────────────────────────────────────────────

export type ReconDiffKind =
  | "missing_local"
  | "missing_mp"
  | "duplicate"
  | "amount_mismatch"
  | "chargeback"
  | "refund"
  | "status_mismatch";

export type ReconDiffStatus = "open" | "resolved" | "ignored" | "auto_resolved";
export type ReconActionKey = "impute" | "keep_credit" | "refund" | "chargeback" | "accept" | "ignore";
export type ReconStatusFilter = "open" | "closed" | "all";

export interface ReconRun {
  id: string;
  source: "cron" | "manual";
  status: "running" | "ok" | "degraded" | "error";
  window_from: string;
  window_to: string;
  mp_count: number;
  local_count: number;
  matched: number;
  diffs_new: number;
  diffs_closed: number;
  fees_updated: number;
  message: string | null;
  started_at: string;
  finished_at: string | null;
  started_by_name: string | null;
}

export interface ReconDiff {
  id: string;
  kind: ReconDiffKind;
  severity: "high" | "medium" | "low";
  status: ReconDiffStatus;
  diff_key: string;
  tenant_id: string | null;
  tenant_name: string | null;
  payment_id: string | null;
  mp_payment_id: string | null;
  expected_cents: number | null;
  actual_cents: number | null;
  detail: Record<string, unknown>;
  excluded: string | null;
  resolution: string | null;
  resolve_reason: string | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
  created_at: string;
  updated_at: string;
  payment: { status: string; amount_cents: number; paid_at: string; method: string; external_id: string | null } | null;
  mp: {
    status: string;
    status_detail: string | null;
    amount_cents: number;
    refunded_cents: number;
    fee_cents: number | null;
    date_approved: string | null;
    date_created: string | null;
    description: string | null;
  } | null;
}

export interface ReconOverview {
  credentials: boolean;
  settings: { window_hours: number; tolerance_cents: number };
  can_manage: boolean;
  can_configure: boolean;
  runs: ReconRun[];
  counts: Partial<Record<ReconDiffKind, number>>;
  diffs: ReconDiff[];
  tenants: { id: string; name: string }[];
}

export interface ReconRunResult {
  status: "ok" | "degraded" | "error";
  run_id?: string;
  message?: string | null;
  mp_count?: number;
  matched?: number;
  diffs_new?: number;
  diffs_closed?: number;
  fees_updated?: number;
}

// ── Lecturas ────────────────────────────────────────────────────────────────

export function useReconOverview(status: ReconStatusFilter = "open") {
  return useQuery({
    queryKey: ["recon-overview", status],
    queryFn: () => call<ReconOverview>("internal_recon_overview", { p_status: status }),
    retry: false,
  });
}

// ── Acciones ────────────────────────────────────────────────────────────────

export function useReconResolve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { diffId: string; action: ReconActionKey; tenantId?: string | null; reason: string }) =>
      call<{ id: string; resolution: string; ref: string | null }>("internal_recon_resolve", {
        p_diff: v.diffId,
        p_action: v.action,
        p_tenant: v.tenantId ?? null,
        p_reason: v.reason,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recon-overview"] });
      qc.invalidateQueries({ queryKey: ["billing-overview"] });
      qc.invalidateQueries({ queryKey: ["billing-statement"] });
    },
  });
}

export function useReconSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { windowHours: number; toleranceCents: number; reason: string }) =>
      call<null>("internal_recon_set_settings", {
        p_window_hours: v.windowHours,
        p_tolerance_cents: v.toleranceCents,
        p_reason: v.reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recon-overview"] }),
  });
}

/** Corre la conciliación ahora (Edge platform_mp_reconcile, modo manual). */
export async function runReconcile(hours?: number): Promise<ReconRunResult> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("platform_mp_reconcile", {
    body: hours ? { mode: "manual", hours } : { mode: "manual" },
    headers: { [INTERNAL_SCOPE_HEADER]: "internal" },
  });
  if (!error) {
    const res = (data ?? {}) as ReconRunResult & { error?: string };
    if (res.error) throw new Error(res.error);
    return res;
  }
  let code: string | null = null;
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      code = ((await ctx.json()) as { error?: string }).error ?? null;
    } catch {
      /* cuerpo no JSON */
    }
  }
  throw new Error(code ?? error.message ?? "platform_mp_reconcile_failed");
}

export function useRunReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hours?: number) => runReconcile(hours),
    onSettled: () => qc.invalidateQueries({ queryKey: ["recon-overview"] }),
  });
}

const RECON_ERRORS: Record<string, string> = {
  recon_running: "Ya hay una conciliación corriendo. Probá de nuevo en unos minutos.",
  diff_not_open: "Esa diferencia ya se resolvió.",
  action_not_allowed: "Esa acción no corresponde para este tipo de diferencia.",
  tenant_required: "Elegí el negocio al que corresponde el pago.",
  duplicate_payment: "Ese pago de Mercado Pago ya está registrado.",
  mp_payment_unknown: "No tenemos los datos de ese pago de Mercado Pago. Corré la conciliación de nuevo.",
  payment_required: "La diferencia no tiene un pago local asociado.",
  payment_not_reversible: "El pago ya no está acreditado: no se puede revertir.",
  invalid_settings: "Revisá la ventana (24 a 720 horas) y la tolerancia.",
  reason_required: "Escribí un motivo de al menos 5 caracteres.",
  forbidden: "No tenés permiso para esta acción.",
};

/** Mensaje legible para los errores de la conciliación. */
export function reconErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const hit = Object.entries(RECON_ERRORS)
    .sort((a, b) => b[0].length - a[0].length)
    .find(([k]) => raw.includes(k));
  return hit ? hit[1] : raw || "No se pudo completar la acción.";
}
