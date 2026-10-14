"use client";

// =============================================================================
// Participación del staff (F21 · ADR-121): lecturas (RLS: el super_admin ve
// todo; cada persona, lo suyo), RPC de escritura (SECURITY DEFINER, auditadas)
// y la Edge staff_payouts (borrador, cierre, proyección, mi participación y
// lectura de MP). El front nunca escribe tablas.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type {
  ClientRuleKind,
  ExpenseAllocation,
  ExpenseCategory,
  ProjectionTenant,
  Recurrence,
  SettlementLine,
  SettlementResult,
} from "@/supabase/functions/_shared/staff/settlement";
import type { MpPayoutCheck, MpPayoutSummary } from "@/supabase/functions/_shared/staff/mpPayout";

type Res = { data: unknown; error: { message: string } | null };
type Client = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<Res>;
  from: (t: string) => {
    select: (cols: string) => {
      is: (c: string, v: null) => { order: (c: string, o?: { ascending: boolean }) => Promise<Res> };
      order: (c: string, o?: { ascending: boolean }) => Promise<Res>;
      eq: (c: string, v: unknown) => { maybeSingle: () => Promise<Res> };
    };
  };
  functions: { invoke: (fn: string, o: { body: unknown }) => Promise<{ data: unknown; error: { message: string; context?: Response } | null }> };
};
const db = () => createClient() as unknown as Client;

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

async function list<T>(table: string, cols = "*", opts: { notDeleted?: string; order?: string; asc?: boolean } = {}): Promise<T[]> {
  const q = db().from(table).select(cols);
  const r = opts.notDeleted
    ? await q.is(opts.notDeleted, null).order(opts.order ?? "created_at", { ascending: opts.asc ?? true })
    : await q.order(opts.order ?? "created_at", { ascending: opts.asc ?? true });
  if (r.error) throw new Error(r.error.message);
  return (r.data ?? []) as T[];
}

/** Edge staff_payouts: devuelve el cuerpo aunque la respuesta sea un error HTTP. */
async function edge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().functions.invoke("staff_payouts", { body });
  if (error) {
    const ctx = error.context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const b = (await ctx.json()) as { error?: string };
        throw new Error(b.error ?? error.message);
      } catch (e) {
        if (e instanceof Error && e.message !== error.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  const d = data as { ok?: boolean; error?: string };
  if (d && d.ok === false && d.error) throw new Error(d.error);
  return data as T;
}

// ── Tipos de filas ──────────────────────────────────────────────────────────

export interface StaffAccess {
  is_staff: boolean;
  is_owner: boolean;
  member_ids: string[];
  locked_until: string | null;
}

export interface PayoutSettings {
  start_period: string;
  house_label: string;
  house_absorbs_expenses: boolean;
  negative_carry: boolean;
  income_tax_reserve_bp: number;
  projection_collection_rate_bp: number;
  mp_amount_tolerance_cents: number;
  notify_on_payment: boolean;
}

export interface StaffMemberRow {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

export interface ShareRow {
  id: string;
  member_id: string;
  share_bp: number;
  expense_bp: number | null;
  valid_from: string;
  valid_to: string | null;
  reason: string;
  created_at: string;
}

export interface RuleRow {
  id: string;
  member_id: string;
  tenant_id: string;
  kind: ClientRuleKind;
  value: number;
  valid_from: string;
  valid_to: string | null;
  reason: string;
  tenants?: { name: string } | null;
}

export interface ExpenseRow {
  id: string;
  name: string;
  category: ExpenseCategory;
  vendor: string | null;
  amount_cents: number;
  currency: "ARS" | "USD";
  recurrence: Recurrence;
  interval_n: number | null;
  start_date: string;
  end_date: string | null;
  spread_months: number;
  allocation: ExpenseAllocation;
  member_id: string | null;
  tenant_id: string | null;
  proof_path: string | null;
  notes: string | null;
  staff_expense_splits?: { member_id: string | null; share_bp: number }[];
  staff_expense_exemptions?: { member_id: string; valid_from: string | null; valid_to: string | null }[];
  staff_expense_period_amounts?: { period: string; amount_cents: number; note: string | null }[];
}

export interface FxRow {
  period: string;
  rate: number;
  source: string | null;
  updated_at: string;
}

export interface AdjustmentRow {
  id: string;
  member_id: string;
  period: string;
  amount_cents: number;
  reason: string;
  run_id: string | null;
  created_at: string;
}

export interface RunRow {
  id: string;
  period: string;
  status: "closed" | "partially_paid" | "paid";
  gross_cents: number;
  fees_cents: number;
  reversals_cents: number;
  net_cents: number;
  reserve_cents: number;
  distributable_cents: number;
  expenses_cents: number;
  to_share_cents: number;
  house_net_cents: number;
  house_cash_cents: number;
  late_net_cents: number;
  snapshot: SettlementResult;
  notes: string | null;
  closed_at: string;
}

export interface LineRow {
  id: string;
  run_id: string;
  member_id: string;
  share_bp_end: number;
  income_cents: number;
  signup_cents: number;
  expense_cents: number;
  adjustment_cents: number;
  carry_in_cents: number;
  net_cents: number;
  payable_cents: number;
  carry_out_cents: number;
  detail: { name?: string; by_tenant?: SettlementLine["by_tenant"]; by_expense?: SettlementLine["by_expense"] };
}

export interface PaymentRow {
  id: string;
  line_id: string;
  run_id: string;
  member_id: string;
  amount_cents: number;
  method: "transfer" | "mercadopago" | "cash" | "other";
  paid_on: string;
  bank_account_id: string | null;
  account_snapshot: { bank_name?: string; alias?: string | null; cbu?: string | null; bank_slug?: string | null } | null;
  reference: string | null;
  mp_operation_id: string | null;
  mp_summary: (MpPayoutSummary & { check?: MpPayoutCheck; account?: { nickname: string | null } }) | null;
  notes: string | null;
  email_queued_at: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

export interface BankAccountRow {
  id: string;
  member_id: string;
  bank_slug: string | null;
  bank_name: string;
  holder_name: string;
  cuit: string | null;
  cbu: string | null;
  alias: string | null;
  account_type: "caja_ahorro" | "cuenta_corriente" | "cuenta_virtual" | "otra";
  currency: "ARS" | "USD";
  note: string | null;
  is_default: boolean;
}

export interface PreviewResponse {
  house_label: string;
  start_period: string;
  locked_until: string | null;
  open_period: string;
  this_month: string;
  draft: { result: SettlementResult; can_close: boolean };
  current: SettlementResult | null;
  projection: { result: SettlementResult; assumptions: ProjectionAssumptionsOut };
  settings: { houseAbsorbsExpenses: boolean; negativeCarry: boolean; incomeTaxReserveBp: number; collectionRateBp: number };
}

export interface ProjectionAssumptionsOut {
  period: string;
  collection_rate_bp: number;
  fee_rate_bp: number;
  tenants: number;
  expected_cents?: number;
  detail?: ProjectionTenant[];
  notes: string[];
}

export interface MineResponse {
  member: boolean;
  current?: { period: string; line: SettlementLine | null };
  projection?: { period: string; line: SettlementLine | null; assumptions: ProjectionAssumptionsOut };
}

export interface MySummary {
  member: { id: string; name: string; email: string | null; is_active: boolean } | null;
  shares?: { share_bp: number; expense_bp: number | null; valid_from: string; valid_to: string | null }[];
  rules?: { id: string; tenant_name: string; kind: ClientRuleKind; value: number; valid_from: string; valid_to: string | null }[];
  lines?: (Omit<LineRow, "run_id" | "member_id"> & {
    period: string;
    status: RunRow["status"];
    paid_cents: number;
    payments: { id: string; amount_cents: number; method: string; paid_on: string; reference: string | null; account: string | null }[];
  })[];
  accounts?: BankAccountRow[];
}

export interface MpLookupResponse {
  lookup_id: string | null;
  summary: MpPayoutSummary & { account?: { id: string | number | null; nickname: string | null } };
  check: MpPayoutCheck;
}

// ── Lecturas ────────────────────────────────────────────────────────────────

const K = ["staff-payouts"] as const;

export const useStaffAccess = () => useQuery({ queryKey: [...K, "access"], queryFn: () => rpc<StaffAccess>("internal_staff_access") });

export function useStaffData(enabled = true) {
  return useQuery({
    queryKey: [...K, "data"],
    enabled,
    queryFn: async () => {
      const [settingsRes, members, shares, rules, expenses, fx, adjustments, runs, lines, payments, accounts] = await Promise.all([
        list<PayoutSettings>("staff_payout_settings", "*", { order: "updated_at" }),
        list<StaffMemberRow>("staff_members", "*", { notDeleted: "deleted_at" }),
        list<ShareRow>("staff_shares", "*", { notDeleted: "voided_at", order: "valid_from" }),
        list<RuleRow>("staff_client_rules", "*, tenants(name)", { notDeleted: "voided_at", order: "valid_from" }),
        list<ExpenseRow>(
          "staff_expenses",
          "*, staff_expense_splits(member_id, share_bp), staff_expense_exemptions(member_id, valid_from, valid_to), staff_expense_period_amounts(period, amount_cents, note)",
          { notDeleted: "deleted_at" },
        ),
        list<FxRow>("staff_fx_rates", "*", { order: "period", asc: false }),
        list<AdjustmentRow>("staff_adjustments", "*", { notDeleted: "voided_at", asc: false }),
        list<RunRow>("staff_payout_runs", "*", { order: "period", asc: false }),
        list<LineRow>("staff_payout_lines", "*", { order: "id" }),
        list<PaymentRow>("staff_payout_payments", "*", { asc: false }),
        list<BankAccountRow>("staff_bank_accounts", "*", { notDeleted: "deleted_at" }),
      ]);
      return { settings: settingsRes[0] ?? null, members, shares, rules, expenses, fx, adjustments, runs, lines, payments, accounts };
    },
  });
}
export type StaffData = NonNullable<ReturnType<typeof useStaffData>["data"]>;

export const useStaffPreview = (period: string | null, enabled = true) =>
  useQuery({
    queryKey: [...K, "preview", period],
    enabled,
    queryFn: () => edge<PreviewResponse>({ action: "preview", ...(period ? { period } : {}) }),
  });

export const useTenantsForStaff = (enabled = true) =>
  useQuery({
    queryKey: [...K, "tenants"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => list<{ id: string; name: string }>("tenants", "id, name", { notDeleted: "deleted_at", order: "name" }),
  });

export const useInternalStaffUsers = (enabled = true) =>
  useQuery({
    queryKey: [...K, "users"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => rpc<{ id: string; email: string; full_name: string | null; internal_level: string }[]>("internal_list_staff"),
  });

export const useMySummary = () => useQuery({ queryKey: [...K, "my-summary"], queryFn: () => rpc<MySummary>("my_staff_summary") });
export const useMine = (enabled = true) => useQuery({ queryKey: [...K, "mine"], enabled, queryFn: () => edge<MineResponse>({ action: "mine" }) });

// ── Escrituras ──────────────────────────────────────────────────────────────

export function useStaffMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: K });
  const m = <A,>(fn: (a: A) => Promise<unknown>) => useMutation({ mutationFn: fn, onSuccess: done });
  /* eslint-disable react-hooks/rules-of-hooks */
  return {
    saveSettings: m((a: { patch: Partial<PayoutSettings>; reason: string }) => rpc("internal_staff_save_settings", { p: a.patch, p_reason: a.reason })),
    saveMember: m(
      (a: { id: string | null; user_id: string | null; display_name: string; email: string | null; notes: string | null; is_active: boolean; reason: string }) =>
        rpc("internal_staff_save_member", {
          p_id: a.id,
          p_user_id: a.user_id,
          p_display_name: a.display_name,
          p_email: a.email,
          p_notes: a.notes,
          p_is_active: a.is_active,
          p_reason: a.reason,
        }),
    ),
    setShare: m((a: { member: string; share_bp: number; expense_bp: number | null; valid_from: string; reason: string }) =>
      rpc("internal_staff_set_share", { p_member: a.member, p_share_bp: a.share_bp, p_expense_bp: a.expense_bp, p_valid_from: a.valid_from, p_reason: a.reason }),
    ),
    saveRule: m(
      (a: { member: string; tenant: string; kind: ClientRuleKind; value: number; valid_from: string; valid_to: string | null; reason: string }) =>
        rpc("internal_staff_save_rule", {
          p_member: a.member,
          p_tenant: a.tenant,
          p_kind: a.kind,
          p_value: a.value,
          p_valid_from: a.valid_from,
          p_valid_to: a.valid_to,
          p_reason: a.reason,
        }),
    ),
    endRule: m((a: { id: string; end: string | null; reason: string }) => rpc("internal_staff_end_rule", { p_id: a.id, p_end: a.end, p_reason: a.reason })),
    saveExpense: m((a: { id: string | null; payload: Record<string, unknown>; reason: string }) =>
      rpc("internal_staff_save_expense", { p_id: a.id, p: a.payload, p_reason: a.reason }),
    ),
    deleteExpense: m((a: { id: string; reason: string }) => rpc("internal_staff_delete_expense", { p_id: a.id, p_reason: a.reason })),
    setExpenseMonth: m((a: { expense: string; period: string; amount_cents: number | null; note: string | null }) =>
      rpc("internal_staff_set_expense_month", { p_expense: a.expense, p_period: a.period, p_amount_cents: a.amount_cents, p_note: a.note }),
    ),
    setFx: m((a: { period: string; rate: number; source: string | null }) => rpc("internal_staff_set_fx", { p_period: a.period, p_rate: a.rate, p_source: a.source })),
    addAdjustment: m((a: { member: string; period: string; amount_cents: number; reason: string }) =>
      rpc("internal_staff_add_adjustment", { p_member: a.member, p_period: a.period, p_amount_cents: a.amount_cents, p_reason: a.reason }),
    ),
    voidAdjustment: m((a: { id: string; reason: string }) => rpc("internal_staff_void_adjustment", { p_id: a.id, p_reason: a.reason })),
    saveAccount: m((a: { id: string | null; member: string; payload: Record<string, unknown>; is_default: boolean }) =>
      rpc("internal_staff_save_bank_account", { p_id: a.id, p_member: a.member, p: a.payload, p_is_default: a.is_default }),
    ),
    deleteAccount: m((a: { id: string }) => rpc("internal_staff_delete_bank_account", { p_id: a.id })),
    closeRun: m((a: { period: string; notes: string | null }) => edge({ action: "close", period: a.period, notes: a.notes })),
    registerPayment: m(
      (a: {
        line: string;
        amount_cents: number;
        method: PaymentRow["method"];
        paid_on: string;
        account: string | null;
        reference: string | null;
        mp_operation: string | null;
        notes: string | null;
        notify: boolean;
      }) =>
        rpc("internal_staff_register_payment", {
          p_line: a.line,
          p_amount_cents: a.amount_cents,
          p_method: a.method,
          p_paid_on: a.paid_on,
          p_bank_account: a.account,
          p_reference: a.reference,
          p_mp_operation: a.mp_operation,
          p_proof_path: null,
          p_notes: a.notes,
          p_notify: a.notify,
        }),
    ),
    voidPayment: m((a: { id: string; reason: string }) => rpc("internal_staff_void_payment", { p_id: a.id, p_reason: a.reason })),
  };
  /* eslint-enable react-hooks/rules-of-hooks */
}

export const mpLookup = (operation_id: string, expected_cents: number) =>
  edge<MpLookupResponse>({ action: "mp_lookup", operation_id, expected_cents });
