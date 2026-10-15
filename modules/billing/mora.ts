"use client";

// =============================================================================
// Mora, punitorios y promesas de la cobranza de la plataforma (F20-9 · H135 ·
// ADR-128): tipos y hooks sobre las RPC de 20261124100000_cobranza_mora_punitorios.
// Todo pasa por RPC SECURITY DEFINER (staff con internal_scope o el negocio
// sobre su propia cuenta); el front nunca escribe tablas.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { billingErrorMessage } from "@/lib/billing/ledger";
import type { InterestBillMode, InterestMethod } from "@/lib/billing/interest";
import { MORA_ERROR_MESSAGES, type CollectionState, type DunningAction, type DunningChannel, type PromiseStatus } from "@/lib/billing/mora";

/** Mensaje legible para los errores de las RPC de mora (si no, los de cobranza). */
export function moraErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const hit = Object.entries(MORA_ERROR_MESSAGES)
    .sort((a, b) => b[0].length - a[0].length)
    .find(([k]) => raw.includes(k));
  return hit ? hit[1] : billingErrorMessage(e);
}

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

export interface InterestPolicyRow {
  id: string;
  name: string;
  monthly_rate_bp: number;
  grace_days: number;
  method: InterestMethod;
  cap_bp: number | null;
  min_amount_cents: number;
  bill_mode: InterestBillMode;
  is_active?: boolean;
  archived_at?: string | null;
  updated_at?: string;
  tenants?: number;
}

export interface DunningStepRow {
  id: string;
  position: number;
  offset_days: number;
  action: DunningAction;
  channels: DunningChannel[];
  requires_no_promise: boolean;
  min_debt_cents: number;
  title: string;
  body: string;
  is_active: boolean;
}

export interface DunningLadderRow {
  id: string;
  name: string;
  is_active: boolean;
  archived_at: string | null;
  updated_at: string;
  tenants: number;
  steps: DunningStepRow[];
}

export interface MoraSettings {
  interest_enabled: boolean;
  interest_since: string | null;
  interest_on_mp: boolean;
  default_interest_policy_id: string | null;
  dunning_enabled: boolean;
  default_dunning_ladder_id: string | null;
  dunning_min_debt_cents: number;
  promise_self_enabled: boolean;
  promise_max_days: number;
  promise_staff_max_days: number;
  promise_max_broken: number;
  soft_restrict_areas: string[];
}

export interface MoraConfig {
  as_of: string;
  can_configure: boolean;
  settings: MoraSettings;
  policies: InterestPolicyRow[];
  plans: { plan_id: string; key: string; name: string; policy_id: string | null }[];
  ladders: DunningLadderRow[];
  holidays: { day: string; name: string; source: string }[];
}

export interface PromiseRow {
  id: string;
  amount_cents: number;
  promised_date: string;
  original_date: string;
  status: PromiseStatus;
  channel: "owner" | "staff";
  note: string | null;
  paid_cents: number | null;
  extended_count: number;
  created_at: string;
  resolved_at: string | null;
  created_by_name?: string | null;
}

export interface WaiverRow {
  id: string;
  tenant_id: string;
  tenant_name?: string;
  status: "applied" | "pending_approval" | "rejected";
  amount_cents: number;
  applied_cents: number | null;
  credit_note_cents: number;
  reason: string;
  movement_ids: string[] | null;
  requested_role: string | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
}

export interface NextStep {
  step_id: string;
  action: DunningAction;
  title: string;
  offset_days: number;
  date: string;
}

export interface FiscalPendingRow {
  id: string;
  kind: "debit_note" | "credit_note";
  concept: "interest_collected" | "interest_month" | "interest_waiver";
  amount_cents: number;
  period_month: string | null;
  status: "pending_h130" | "cancelled" | "issued";
  created_at: string;
  note: string | null;
}

export interface AccrualMonth {
  month: string;
  accrued_cents: number;
  liquidated_cents: number;
  posted_cents: number;
}

export interface AccrualRow {
  charge_id: string;
  description: string;
  charge_status: string;
  effective_due: string;
  accrue_from: string;
  original_cents: number;
  accrued_cents: number;
  liquidated_cents: number;
  pending_cents: number;
  posted_cents: number;
  cap_reached: boolean;
  months: AccrualMonth[];
  accrued_through: string | null;
  policy: InterestPolicyRow;
}

export interface TenantMora {
  as_of: string;
  exclusion: string | null;
  billing_mode: string;
  debt: {
    debt_movement_id: string | null;
    oldest_due: string | null;
    effective_due: string | null;
    days_overdue: number;
    due_cents: number;
    overdue_cents: number;
    open_cents: number;
  };
  status: {
    state: CollectionState;
    soft_restricted: boolean;
    status_by_ladder: string | null;
    suspend_on: string | null;
    evaluated_at: string;
  } | null;
  subscription_status: string | null;
  terms: {
    interest_policy_id: string | null;
    interest_enabled: boolean;
    dunning_ladder_id: string | null;
    self_promise_enabled: boolean | null;
  };
  settings: {
    interest_enabled: boolean;
    interest_on_mp: boolean;
    dunning_enabled: boolean;
    promise_staff_max_days: number;
    promise_max_days: number;
  };
  policy: InterestPolicyRow | null;
  policy_source: "tenant" | "plan" | "default" | null;
  ladder: { id: string; name: string; steps: DunningStepRow[] } | null;
  next_step: NextStep | null;
  executed_step_ids: string[];
  accruals: AccrualRow[];
  interest_open: { id: string; charge_id: string; month: string; effective_date: string; description: string; amount_cents: number; open_cents: number }[];
  interest_open_cents: number;
  promise: PromiseRow | null;
  promises: PromiseRow[];
  events: {
    id: string;
    step_id: string;
    title: string;
    action: DunningAction;
    offset_days: number;
    days_overdue: number;
    due_cents: number;
    notified: boolean;
    executed_at: string;
    closed_at: string | null;
    close_reason: string | null;
  }[];
  waivers: WaiverRow[];
  fiscal_pending: FiscalPendingRow[];
  pauses: { id: string; from: string; to: string | null; reason: string }[];
  holidays: string[];
}

export interface MoraOverview {
  as_of: string;
  business_day: boolean;
  interest_enabled: boolean;
  dunning_enabled: boolean;
  tenants: {
    tenant_id: string;
    name: string;
    slug: string;
    state: CollectionState;
    days_overdue: number;
    overdue_cents: number;
    due_cents: number;
    soft_restricted: boolean;
    status_by_ladder: string | null;
    subscription_status: string | null;
    next_step_date: string | null;
    next_step_action: DunningAction | null;
    next_step_title: string | null;
    interest_open_cents: number;
    promise_date: string | null;
    promise_cents: number | null;
  }[];
  pending_waivers: WaiverRow[];
  fiscal_pending: { debit_notes: number; debit_cents: number; credit_notes: number; credit_cents: number };
}

export interface MyMora {
  as_of: string;
  is_owner: boolean;
  state: CollectionState;
  days_overdue: number;
  oldest_due: string | null;
  effective_due: string | null;
  overdue_cents: number;
  balance_cents: number;
  interest_open_cents: number;
  interest_pending_cents: number;
  interest_enabled: boolean;
  soft_restricted: boolean;
  restrict_areas: string[];
  subscription_status: string | null;
  next_step: NextStep | null;
  promise: PromiseRow | null;
  promise_rules: { can_create: boolean; reason: string | null; max_days: number; min_date: string; max_date: string };
  promises: PromiseRow[];
}

export interface MyRestriction {
  soft_restricted: boolean;
  areas: string[];
  suspend_on: string | null;
  state: CollectionState;
  is_manager: boolean;
}

// ── Lecturas ────────────────────────────────────────────────────────────────

export function useMoraConfig(enabled = true) {
  return useQuery({
    queryKey: ["mora-config"],
    queryFn: () => call<MoraConfig>("internal_billing_mora_config"),
    enabled,
    retry: false,
  });
}

export function useMoraOverview(enabled = true) {
  return useQuery({
    queryKey: ["mora-overview"],
    queryFn: () => call<MoraOverview>("internal_billing_mora_overview"),
    enabled,
    retry: false,
  });
}

export function useTenantMora(tenantId: string) {
  return useQuery({
    queryKey: ["tenant-mora", tenantId],
    queryFn: () => call<TenantMora>("internal_billing_mora", { p_tenant: tenantId }),
    retry: false,
  });
}

export function useMyMora(enabled = true) {
  return useQuery({
    queryKey: ["my-mora"],
    queryFn: () => call<MyMora>("my_billing_mora"),
    enabled,
    retry: false,
  });
}

/** Restricción blanda del negocio activo (cualquier miembro, sin importes). */
export function useMyRestriction(enabled = true) {
  return useQuery({
    queryKey: ["my-restriction"],
    queryFn: () => call<MyRestriction>("my_billing_restriction"),
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
  });
}

// ── Escrituras ──────────────────────────────────────────────────────────────

export function useMoraConfigMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["mora-config"] });
    void qc.invalidateQueries({ queryKey: ["mora-overview"] });
  };
  return {
    setSettings: useMutation({
      mutationFn: (v: { data: Partial<MoraSettings>; reason: string }) =>
        call<null>("internal_billing_set_mora_settings", { p_data: v.data, p_reason: v.reason }),
      onSuccess: done,
    }),
    savePolicy: useMutation({
      mutationFn: (v: { id: string | null; data: Partial<InterestPolicyRow>; reason: string }) =>
        call<string>("internal_interest_policy_save", { p_id: v.id, p_data: v.data, p_reason: v.reason }),
      onSuccess: done,
    }),
    archivePolicy: useMutation({
      mutationFn: (v: { id: string; reason: string }) => call<null>("internal_interest_policy_archive", { p_id: v.id, p_reason: v.reason }),
      onSuccess: done,
    }),
    assignPlan: useMutation({
      mutationFn: (v: { planId: string; policyId: string | null; reason: string }) =>
        call<null>("internal_interest_policy_assign_plan", { p_plan: v.planId, p_policy: v.policyId, p_reason: v.reason }),
      onSuccess: done,
    }),
    saveLadder: useMutation({
      mutationFn: (v: { id: string | null; data: { name: string; steps: Partial<DunningStepRow>[] }; reason: string }) =>
        call<string>("internal_dunning_ladder_save", { p_id: v.id, p_data: v.data, p_reason: v.reason }),
      onSuccess: done,
    }),
    archiveLadder: useMutation({
      mutationFn: (v: { id: string; reason: string }) => call<null>("internal_dunning_ladder_archive", { p_id: v.id, p_reason: v.reason }),
      onSuccess: done,
    }),
    saveHoliday: useMutation({
      mutationFn: (v: { day: string; name: string; reason: string }) =>
        call<null>("internal_holiday_save", { p_day: v.day, p_name: v.name, p_reason: v.reason }),
      onSuccess: done,
    }),
    deleteHoliday: useMutation({
      mutationFn: (v: { day: string; reason: string }) => call<null>("internal_holiday_delete", { p_day: v.day, p_reason: v.reason }),
      onSuccess: done,
    }),
    decideWaiver: useMutation({
      mutationFn: (v: { id: string; approve: boolean; reason: string }) =>
        call<WaiverRow>("internal_interest_waiver_decide", { p_waiver: v.id, p_approve: v.approve, p_reason: v.reason }),
      onSuccess: () => {
        done();
        void qc.invalidateQueries({ queryKey: ["tenant-mora"] });
        void qc.invalidateQueries({ queryKey: ["billing-statement"] });
      },
    }),
  };
}

export function useTenantMoraMutations(tenantId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["tenant-mora", tenantId] });
    void qc.invalidateQueries({ queryKey: ["billing-statement", tenantId] });
    void qc.invalidateQueries({ queryKey: ["billing-overview"] });
    void qc.invalidateQueries({ queryKey: ["mora-overview"] });
  };
  return {
    waive: useMutation({
      mutationFn: (v: { movementIds: string[] | null; amountCents: number | null; reason: string; requestId: string }) =>
        call<WaiverRow>("internal_interest_waive", {
          p_tenant: tenantId,
          p_movement_ids: v.movementIds,
          p_amount_cents: v.amountCents,
          p_reason: v.reason,
          p_request_id: v.requestId,
        }),
      onSuccess: done,
    }),
    createPromise: useMutation({
      mutationFn: (v: { amountCents: number; date: string; note: string | null; reason: string }) =>
        call<PromiseRow>("internal_promise_create", {
          p_tenant: tenantId,
          p_amount_cents: v.amountCents,
          p_date: v.date,
          p_note: v.note,
          p_reason: v.reason,
        }),
      onSuccess: done,
    }),
    updatePromise: useMutation({
      mutationFn: (v: { promiseId: string; action: "extend" | "cancel"; date: string | null; reason: string }) =>
        call<PromiseRow>("internal_promise_update", { p_promise: v.promiseId, p_action: v.action, p_date: v.date, p_reason: v.reason }),
      onSuccess: done,
    }),
    setTerms: useMutation({
      mutationFn: (v: { data: { interest_policy_id?: string | null; dunning_ladder_id?: string | null; self_promise_enabled?: boolean | null }; reason: string }) =>
        call<null>("internal_billing_set_mora_terms", { p_tenant: tenantId, p_data: v.data, p_reason: v.reason }),
      onSuccess: done,
    }),
    pause: useMutation({
      mutationFn: (v: { paused: boolean; reason: string }) =>
        call<null>("internal_interest_pause", { p_tenant: tenantId, p_paused: v.paused, p_reason: v.reason }),
      onSuccess: done,
    }),
  };
}

export function useOwnerPromise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { amountCents: number; date: string; note: string | null }) =>
      call<PromiseRow>("owner_promise_create", { p_amount_cents: v.amountCents, p_date: v.date, p_note: v.note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["my-mora"] });
      void qc.invalidateQueries({ queryKey: ["my-restriction"] });
    },
  });
}
