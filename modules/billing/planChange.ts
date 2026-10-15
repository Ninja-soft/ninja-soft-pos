"use client";

// =============================================================================
// Cambio de plan, ciclo y addons con prorrateo (F20-10 · H136 · ADR-131): el
// simulador (internal_billing_proration_preview) y la confirmación
// (internal_billing_plan_change) usan la misma cotización de la base. Con
// débito automático, después de aplicar se sincroniza el monto del preapproval
// (Edge mp_update_subscription_amount, best effort).
// =============================================================================

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

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

export type BillingCycle = "monthly" | "yearly";
export type ChangeTiming = "auto" | "immediate" | "period_end";
export type ChangeKind = "upgrade" | "downgrade" | "lateral" | "cycle_up" | "cycle_down";
export type ChangeEffect = "charge" | "credit" | "charge_and_credit" | "scheduled" | "none";

export interface QuoteLine {
  source: string;
  description: string;
  amount_cents: number;
  ref_id?: string | null;
}

export interface ProrationQuote {
  kind: ChangeKind;
  timing: "immediate" | "period_end";
  effect: ChangeEffect;
  period_start: string;
  period_end: string;
  today: string;
  days: number;
  days_left: number;
  percent_bp: number;
  from: { plan_id: string; plan_name: string | null; cycle: BillingCycle; cycle_cents: number };
  to: { plan_id: string; plan_name: string | null; cycle: BillingCycle; cycle_cents: number };
  debit_cents: number;
  credit_cents: number;
  charge: {
    kind: string;
    description: string;
    period_start: string;
    period_end: string;
    due_date: string;
    lines: QuoteLine[];
    total_cents: number;
  } | null;
  charge_cents: number;
  bonus_cents: number;
  new_period: { start: string; end: string } | null;
  effective_on: string;
  charged: boolean;
  notes: string[];
  warnings?: string[];
  billing_mode?: string;
  exclusion?: string | null;
  subscription_status?: string;
  scheduled?: { id: string; effective_on: string; kind: string } | null;
}

export interface PlanOption {
  id: string;
  key: string;
  name: string;
  monthly_price_ars: number;
  yearly_price_ars: number | null;
  tenant_id: string | null;
}

export interface PlanChangeResult {
  id: string;
  status: "applied" | "scheduled";
  charge_id?: string | null;
  credit_movement_id?: string | null;
  effective_on?: string;
  quote?: ProrationQuote;
  mp_amount_sync?: boolean;
  replayed?: boolean;
}

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  lateral: "Sin diferencia de precio",
  cycle_up: "Pasa a anual",
  cycle_down: "Pasa a mensual",
};

export const TIMING_LABELS: Record<ChangeTiming, string> = {
  auto: "Automático",
  immediate: "Inmediato",
  period_end: "Al fin del período",
};

// ── Lecturas ────────────────────────────────────────────────────────────────

/** Planes que se le pueden asignar al negocio: globales activos y su plan propio. */
export function useAssignablePlans(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: ["assignable-plans", tenantId],
    enabled,
    queryFn: async (): Promise<PlanOption[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("plans")
        .select("id, key, name, monthly_price_ars, yearly_price_ars, tenant_id, sort")
        .eq("is_active", true)
        .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
        .order("sort");
      if (error) throw error;
      return ((data ?? []) as unknown as PlanOption[]).map((p) => ({
        ...p,
        monthly_price_ars: Number(p.monthly_price_ars ?? 0),
        yearly_price_ars: p.yearly_price_ars === null ? null : Number(p.yearly_price_ars),
      }));
    },
    staleTime: 60_000,
  });
}

/** Plan y ciclo vigentes del negocio (punto de partida del simulador). */
export function useCurrentSubscription(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: ["current-subscription", tenantId],
    enabled,
    queryFn: async (): Promise<{ plan_id: string; billing_cycle: BillingCycle; status: string } | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("subscriptions")
        .select("plan_id, billing_cycle, status")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const d = data as { plan_id: string; billing_cycle: string | null; status: string };
      return { plan_id: d.plan_id, billing_cycle: d.billing_cycle === "yearly" ? "yearly" : "monthly", status: d.status };
    },
  });
}

/** Cotización en vivo. Sólo corre cuando hay un cambio (plan o ciclo distinto). */
export function useProrationPreview(
  tenantId: string,
  planId: string | null,
  cycle: BillingCycle | null,
  timing: ChangeTiming,
  enabled = true,
) {
  return useQuery({
    queryKey: ["proration-preview", tenantId, planId, cycle, timing],
    enabled: enabled && Boolean(tenantId && planId && cycle),
    queryFn: () =>
      call<ProrationQuote>("internal_billing_proration_preview", {
        p_tenant: tenantId,
        p_plan: planId,
        p_cycle: cycle,
        p_timing: timing,
      }),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

// ── Acciones ────────────────────────────────────────────────────────────────

/** Sincroniza el monto del débito automático del negocio. Nunca lanza. */
export async function syncTenantMpAmount(tenantId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_update_subscription_amount", {
      body: { tenant_id: tenantId },
    });
    if (error) return { ok: false, reason: error.message };
    const res = (data ?? {}) as { ok?: boolean; reason?: string; error?: string };
    if (res.error) return { ok: false, reason: res.error };
    return { ok: Boolean(res.ok) || res.reason === "no_preapproval", reason: res.reason };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function usePlanChange(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      planId: string;
      cycle: BillingCycle;
      timing: ChangeTiming;
      reason: string;
      requestId: string;
      expected: { charge_cents: number; bonus_cents: number; timing: string };
    }): Promise<PlanChangeResult & { mpSync?: { ok: boolean; reason?: string } }> => {
      const res = await call<PlanChangeResult>("internal_billing_plan_change", {
        p_tenant: tenantId,
        p_plan: v.planId,
        p_cycle: v.cycle,
        p_timing: v.timing,
        p_reason: v.reason,
        p_request_id: v.requestId,
        p_expected: v.expected,
      });
      if (res.status === "applied" && res.mp_amount_sync) {
        return { ...res, mpSync: await syncTenantMpAmount(tenantId) };
      }
      return res;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["proration-preview", tenantId] });
      qc.invalidateQueries({ queryKey: ["billing-statement", tenantId] });
      qc.invalidateQueries({ queryKey: ["billing-timeline", tenantId] });
      qc.invalidateQueries({ queryKey: ["billing-overview"] });
    },
  });
}

export function useCancelPlanChange(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { changeId: string; reason: string }) =>
      call<null>("internal_billing_plan_change_cancel", { p_change: v.changeId, p_reason: v.reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proration-preview", tenantId] });
      qc.invalidateQueries({ queryKey: ["billing-timeline", tenantId] });
      qc.invalidateQueries({ queryKey: ["plan-change-scheduled", tenantId] });
    },
  });
}

/** El cambio programado del negocio (de la cotización contra el mismo plan no sirve: se lee del timeline). */
export function useScheduledPlanChange(tenantId: string) {
  return useQuery({
    queryKey: ["plan-change-scheduled", tenantId],
    queryFn: async () => {
      const t = await call<{
        scheduled_change: { id: string; kind: ChangeKind; effective_on: string; to_plan: string | null; to_cycle: BillingCycle | null } | null;
      }>("internal_billing_timeline", { p_tenant: tenantId, p_from: null, p_to: null });
      return t?.scheduled_change ?? null;
    },
    retry: false,
  });
}

const PLAN_CHANGE_ERRORS: Record<string, string> = {
  quote_changed: "Los números cambiaron desde que abriste el simulador. Revisá la cotización nueva y confirmá otra vez.",
  no_change: "Elegí un plan o un ciclo distinto al actual.",
  plan_not_found: "Ese plan no existe o no está activo.",
  invalid_cycle: "El ciclo no es válido.",
  subscription_not_found: "El negocio no tiene suscripción.",
  change_not_scheduled: "Ese cambio ya no está programado.",
  cap_per_operation_exceeded: "El crédito supera el tope por operación de tu nivel.",
  cap_per_month_exceeded: "El crédito supera el tope mensual de tu nivel para este negocio.",
  reason_required: "Escribí un motivo de al menos 5 caracteres.",
  forbidden: "Cambiar el plan es de admin o super admin.",
};

export function planChangeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const hit = Object.entries(PLAN_CHANGE_ERRORS)
    .sort((a, b) => b[0].length - a[0].length)
    .find(([k]) => raw.includes(k));
  return hit ? hit[1] : raw || "No se pudo completar el cambio.";
}
