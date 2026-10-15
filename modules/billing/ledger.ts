"use client";

// =============================================================================
// Cuenta corriente de la plataforma (F20-1 · ADR-115): tipos y hooks sobre las
// RPC de 20261113100100_cobranza_ledger_rpc. Todo pasa por RPC (security
// definer, guard internal_scope o dueño/encargado); el front nunca escribe
// tablas del ledger.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { BillingKpisData } from "@/lib/billing/kpis";

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

export interface LedgerMovement {
  id: string;
  kind: string;
  description: string;
  effective_date: string;
  due_date: string | null;
  amount_cents: number;
  open_cents: number;
  balance_after_cents: number;
  charge_id: string | null;
  payment_id: string | null;
  parent_id: string | null;
  created_at: string;
  reason?: string | null;
  created_by_name?: string | null;
}

export interface ChargeLine {
  source: string;
  description: string;
  qty: number;
  unit_cents: number;
  amount_cents: number;
}

export interface LedgerCharge {
  id: string;
  kind: string;
  description: string;
  period_start: string | null;
  period_end: string | null;
  due_date: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  open_cents: number;
  status: string;
  created_at: string;
  voided_at: string | null;
  void_reason?: string | null;
  source?: string;
  lines: ChargeLine[];
}

export interface LedgerAllocation {
  id: string;
  credit_movement_id: string;
  debit_movement_id: string;
  credit_description: string;
  debit_description: string;
  amount_cents: number;
  created_at: string;
  released_at: string | null;
}

export interface LedgerPayment {
  id: string;
  method: string;
  status: string;
  amount_cents: number;
  paid_at: string;
  provider: string | null;
  period_start: string | null;
  period_end: string | null;
  external_id?: string | null;
  payer_reference?: string | null;
  notes?: string | null;
  recorded_by_name?: string | null;
}

export interface TimelineEvent {
  id: string;
  at: string;
  action: string;
  entity_type: string;
  reason: string | null;
  actor: string | null;
  data: Record<string, unknown> | null;
}

export interface BillingTerms {
  tenant_id: string;
  billing_mode: string | null;
  exempt_reason: string | null;
  due_days: number | null;
  notes: string | null;
  updated_at: string;
}

export interface BillingStatement {
  tenant_id: string;
  as_of: string;
  currency: string;
  balance_cents: number;
  overdue_cents: number;
  upcoming_cents: number;
  credit_cents: number;
  oldest_due_date: string | null;
  next_due: { date: string; cents: number } | null;
  aging: { d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  billing_mode: string;
  exclusion: string | null;
  subscription: {
    status: string;
    billing_cycle: string;
    current_period_start: string | null;
    current_period_end: string | null;
    plan_name: string | null;
    plan_key: string | null;
    has_mp: boolean;
  } | null;
  recurring_cents: number | null;
  recurring_gross_cents: number | null;
  movements: LedgerMovement[];
  charges: LedgerCharge[];
  allocations: LedgerAllocation[];
  payments: LedgerPayment[];
  terms?: BillingTerms | null;
  timeline?: TimelineEvent[];
  is_test?: boolean;
}

export interface OverviewTenant {
  tenant_id: string;
  name: string;
  slug: string;
  sub_status: string | null;
  billing_mode: string;
  exclusion: string | null;
  balance_cents: number;
  overdue_cents: number;
  upcoming_cents: number;
  credit_cents: number;
  oldest_due_date: string | null;
  next_due_date: string | null;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
}

export interface BillingOverview {
  as_of: string;
  totals: {
    balance_cents: number;
    overdue_cents: number;
    upcoming_cents: number;
    credit_cents: number;
    d1_30: number;
    d31_60: number;
    d61_90: number;
    d90_plus: number;
    tenants_overdue: number;
  };
  tenants: OverviewTenant[];
  upcoming: { tenant_id: string; name: string; due_date: string; open_cents: number; description: string; charge_id: string | null }[];
  excluded_count: number;
}

export interface BillingCap {
  level: "cobranzas" | "admin" | "super_admin";
  per_operation_cents: number | null;
  per_month_cents: number | null;
  updated_at: string;
}

export interface BillingAccess {
  role: "viewer" | "cobranzas" | "admin" | "super_admin";
  can_operate: boolean;
  can_set_terms: boolean;
  can_configure: boolean;
  caps: BillingCap[];
}

// ── Lecturas ────────────────────────────────────────────────────────────────

export function useBillingAccess() {
  return useQuery({
    queryKey: ["billing-access"],
    queryFn: () => call<BillingAccess>("internal_my_billing_access"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useInternalStatement(tenantId: string) {
  return useQuery({
    queryKey: ["billing-statement", tenantId],
    queryFn: () => call<BillingStatement>("internal_billing_statement", { p_tenant: tenantId }),
    retry: false,
  });
}

export function useMyStatement(enabled = true) {
  return useQuery({
    queryKey: ["my-billing-statement"],
    queryFn: () => call<BillingStatement>("my_billing_statement"),
    enabled,
    retry: false,
  });
}

export function useBillingOverview() {
  return useQuery({
    queryKey: ["billing-overview"],
    queryFn: () => call<BillingOverview>("internal_billing_overview"),
    retry: false,
  });
}

/** F20-2 (ADR-127): insumos de los KPIs de MRR y cobranza (Cobranzas, admin o super_admin). */
export function useBillingKpis(months = 12, enabled = true) {
  return useQuery({
    queryKey: ["billing-kpis", months],
    queryFn: () => call<BillingKpisData>("internal_billing_kpis", { p_months: months }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useStaffPermissions() {
  return useQuery({
    queryKey: ["staff-permissions"],
    queryFn: () => call<{ user_id: string; permission: string; granted_at: string }[]>("internal_list_staff_permissions"),
    retry: false,
  });
}

// ── Escrituras ──────────────────────────────────────────────────────────────

export function useLedgerMutations(tenantId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["billing-statement", tenantId] });
    void qc.invalidateQueries({ queryKey: ["billing-overview"] });
    void qc.invalidateQueries({ queryKey: ["billing-records", tenantId] });
  };
  return {
    registerPayment: useMutation({
      mutationFn: (v: { amountCents: number; method: string; paidOn: string; reference: string | null; reason: string }) =>
        call<string>("internal_billing_register_payment", {
          p_tenant: tenantId,
          p_amount_cents: v.amountCents,
          p_method: v.method,
          p_paid_on: v.paidOn,
          p_reference: v.reference,
          p_reason: v.reason,
        }),
      onSuccess: done,
    }),
    bonus: useMutation({
      mutationFn: (v: { amountCents: number; reason: string; requestId: string }) =>
        call<string>("internal_billing_bonus", {
          p_tenant: tenantId,
          p_amount_cents: v.amountCents,
          p_reason: v.reason,
          p_request_id: v.requestId,
        }),
      onSuccess: done,
    }),
    addCharge: useMutation({
      mutationFn: (v: { amountCents: number; description: string; dueDate: string | null; reason: string; requestId: string }) =>
        call<string>("internal_billing_add_charge", {
          p_tenant: tenantId,
          p_amount_cents: v.amountCents,
          p_description: v.description,
          p_due_date: v.dueDate,
          p_reason: v.reason,
          p_request_id: v.requestId,
        }),
      onSuccess: done,
    }),
    voidCharge: useMutation({
      mutationFn: (v: { chargeId: string; reason: string }) =>
        call<null>("internal_billing_void_charge", { p_charge: v.chargeId, p_reason: v.reason }),
      onSuccess: done,
    }),
    reversePayment: useMutation({
      mutationFn: (v: { paymentId: string; kind: "chargeback" | "refund"; reason: string }) =>
        call<string>("internal_billing_reverse_payment", { p_payment: v.paymentId, p_kind: v.kind, p_reason: v.reason }),
      onSuccess: done,
    }),
    setTerms: useMutation({
      mutationFn: (v: { mode: string | null; exemptReason: string | null; dueDays: number | null; reason: string }) =>
        call<null>("internal_billing_set_terms", {
          p_tenant: tenantId,
          p_billing_mode: v.mode,
          p_exempt_reason: v.exemptReason,
          p_due_days: v.dueDays,
          p_reason: v.reason,
        }),
      onSuccess: done,
    }),
    setTest: useMutation({
      mutationFn: (v: { isTest: boolean; reason: string }) =>
        call<null>("internal_set_tenant_test", { p_tenant: tenantId, p_is_test: v.isTest, p_reason: v.reason }),
      onSuccess: () => {
        done();
        void qc.invalidateQueries({ queryKey: ["internal-tenants"] });
      },
    }),
  };
}

export function useBillingConfigMutations() {
  const qc = useQueryClient();
  return {
    setCaps: useMutation({
      mutationFn: (v: { level: string; perOperationCents: number | null; perMonthCents: number | null; reason: string }) =>
        call<null>("internal_billing_set_caps", {
          p_level: v.level,
          p_per_operation_cents: v.perOperationCents,
          p_per_month_cents: v.perMonthCents,
          p_reason: v.reason,
        }),
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["billing-access"] }),
    }),
    setPermission: useMutation({
      mutationFn: (v: { userId: string; enabled: boolean; reason: string }) =>
        call<null>("internal_set_staff_permission", {
          p_user: v.userId,
          p_permission: "cobranzas",
          p_enabled: v.enabled,
          p_reason: v.reason,
        }),
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["staff-permissions"] }),
    }),
  };
}

/** Id de pedido para que un doble clic no duplique la operación. */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
  );
}
