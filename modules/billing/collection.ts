"use client";

// =============================================================================
// Cobro por cuenta corriente (F20-8 · ADR-120): tipos y hooks sobre las RPC de
// 20261115200000_cobranza_cuenta_corriente y las Edges de suscripción de
// Mercado Pago (mp_subscription_pause / mp_subscription_checkout).
// Todo pasa por RPC security definer: el front nunca escribe tablas.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { appOrigin } from "@/lib/site";
import { proofExtension, type BillingModeKey, type StatementFrequency } from "@/lib/billing/paymentNotice";
import type { TransferAccountType } from "@/lib/payments/transfer";

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const client = createClient() as unknown as RpcClient;
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Invoca una Edge y devuelve el cuerpo; si falla, el código de error del cuerpo. */
async function invokeEdge<T>(name: string, body: Record<string, unknown>): Promise<{ data: T | null; error: string | null }> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return { data: (data ?? null) as T | null, error: null };
  let code: string | null = null;
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      code = ((await ctx.json()) as { error?: string }).error ?? null;
    } catch {
      /* cuerpo no JSON */
    }
  }
  return { data: null, error: code ?? error.message ?? `${name}_failed` };
}

// ── Tipos ───────────────────────────────────────────────────────────────────

export interface PlatformBankAccount {
  id: string;
  bank_slug: string | null;
  bank_name: string;
  holder_name: string;
  cuit: string | null;
  cbu: string | null;
  alias: string | null;
  account_type: TransferAccountType;
  currency: "ARS";
  note: string | null;
  is_default: boolean;
  is_active?: boolean;
  sort?: number;
}

export interface CollectionSettings {
  payment_proof_email: string | null;
  payment_proof_whatsapp: string | null;
  notices_enabled: boolean;
  notice_lead_days_default: number;
  statement_frequency_default: StatementFrequency;
  statement_every_days_default: number;
  statement_day_default: number;
  due_days_default: number;
}

export interface TransferReport {
  id: string;
  tenant_id?: string;
  tenant_name?: string;
  amount_cents: number;
  approved_cents?: number | null;
  paid_on: string;
  reference: string | null;
  note?: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reject_reason?: string | null;
  proof_path?: string;
  proof_mime?: string | null;
  created_at: string;
  verified_at?: string | null;
  bank_account_id?: string | null;
  reported_by_name?: string | null;
  balance_cents?: number;
}

export interface ModeChange {
  id: string;
  from_mode: string | null;
  to_mode: BillingModeKey;
  status: "applied" | "pending_checkout" | "pending_mp_cancel" | "cancelled";
  source?: "staff" | "invite_code" | "system";
  mp_preapproval_id?: string | null;
  mp_cancel_status?: "cancelled" | "failed" | "not_needed" | null;
  mp_detail?: string | null;
  reason?: string | null;
  created_at: string;
  completed_at: string | null;
  created_by_name?: string | null;
}

export interface NoticeRow {
  id: string;
  kind: "notice" | "statement" | "manual";
  amount_cents: number;
  due_date: string | null;
  recipients: string[];
  created_at: string;
}

export interface TenantTermsRow {
  billing_mode: string | null;
  pending_mode: string | null;
  pending_since: string | null;
  due_days: number | null;
  exempt_reason: string | null;
  statement_frequency: StatementFrequency | null;
  statement_every_days: number | null;
  statement_day: number | null;
  notice_lead_days: number | null;
  send_to: string[];
  cc: string[];
}

export interface CollectionView {
  settings: CollectionSettings;
  bank_accounts: PlatformBankAccount[];
  pending_reports: TransferReport[];
  tenant?: {
    stored_mode: BillingModeKey;
    effective_mode: BillingModeKey;
    has_preapproval: boolean;
    terms: TenantTermsRow | null;
    recipients: string[];
    mode_changes: ModeChange[];
    reports: TransferReport[];
    notices: NoticeRow[];
  };
}

export interface MyBillingAccount {
  billing_mode: BillingModeKey;
  pending_mode: "mp_subscription" | null;
  pending_since: string | null;
  due_days: number;
  is_owner: boolean;
  reference: string;
  payment_proof_email: string | null;
  payment_proof_whatsapp: string | null;
  send_to: string[];
  bank_accounts: PlatformBankAccount[];
  reports: TransferReport[];
  mode_changes: ModeChange[];
}

export interface LimitRow {
  key: "max_stores" | "max_registers_per_store" | "max_users" | "max_products" | "max_sales_per_month";
  plan_value: number | null;
  override: number | null;
  usage: number;
}

export interface TenantLimits {
  plan: { id: string; key: string; name: string; is_custom: boolean };
  rows: LimitRow[];
  can_edit: boolean;
}

export const PROOF_BUCKET = "platform-payment-proofs";

// ── Límites del plan ────────────────────────────────────────────────────────

export function useTenantLimits(tenantId: string) {
  return useQuery({
    queryKey: ["tenant-limits", tenantId],
    queryFn: () => call<TenantLimits>("internal_tenant_limits", { p_tenant: tenantId }),
    retry: false,
  });
}

export function useSetLimitOverrides(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { overrides: Record<string, number | null>; reason: string }) =>
      call<Record<string, number>>("internal_set_limit_overrides", {
        p_tenant: tenantId,
        p_overrides: v.overrides,
        p_reason: v.reason,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tenant-limits", tenantId] });
      void qc.invalidateQueries({ queryKey: ["internal", "plan-detail", tenantId] });
    },
  });
}

// ── Staff: configuración, bandeja y negocio ─────────────────────────────────

export function useCollection(tenantId?: string | null) {
  return useQuery({
    queryKey: ["billing-collection", tenantId ?? null],
    queryFn: () => call<CollectionView>("internal_billing_collection", { p_tenant: tenantId ?? null }),
    retry: false,
  });
}

export function useCollectionMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["billing-collection"] });
    void qc.invalidateQueries({ queryKey: ["billing-overview"] });
    void qc.invalidateQueries({ queryKey: ["billing-statement"] });
  };
  return {
    saveBankAccount: useMutation({
      mutationFn: (v: { id: string | null; data: Record<string, unknown>; reason: string }) =>
        call<string>("internal_platform_bank_account_save", { p_id: v.id, p_data: v.data, p_reason: v.reason }),
      onSuccess: done,
    }),
    deleteBankAccount: useMutation({
      mutationFn: (v: { id: string; reason: string }) =>
        call<null>("internal_platform_bank_account_delete", { p_id: v.id, p_reason: v.reason }),
      onSuccess: done,
    }),
    setSettings: useMutation({
      mutationFn: (v: { data: Partial<CollectionSettings>; reason: string }) =>
        call<null>("internal_billing_set_collection_settings", { p_data: v.data, p_reason: v.reason }),
      onSuccess: done,
    }),
    verifyTransfer: useMutation({
      mutationFn: (v: { reportId: string; approve: boolean; amountCents: number | null; reason: string }) =>
        call<{ status: string; payment_id?: string }>("internal_billing_verify_transfer", {
          p_report: v.reportId,
          p_approve: v.approve,
          p_amount_cents: v.amountCents,
          p_reason: v.reason,
        }),
      onSuccess: done,
    }),
    setNoticeTerms: useMutation({
      mutationFn: (v: {
        tenantId: string;
        frequency: StatementFrequency | null;
        everyDays: number | null;
        day: number | null;
        leadDays: number | null;
        sendTo: string[];
        cc: string[];
        reason: string;
      }) =>
        call<null>("internal_billing_set_notice_terms", {
          p_tenant: v.tenantId,
          p_frequency: v.frequency,
          p_every_days: v.everyDays,
          p_day: v.day,
          p_lead_days: v.leadDays,
          p_send_to: v.sendTo,
          p_cc: v.cc,
          p_reason: v.reason,
        }),
      onSuccess: done,
    }),
    sendNotice: useMutation({
      mutationFn: (v: { tenantId: string; reason: string }) =>
        call<{ sent: boolean; amount_cents: number }>("internal_billing_send_notice", { p_tenant: v.tenantId, p_reason: v.reason }),
      onSuccess: done,
    }),
  };
}

/** Firma una URL de 10 minutos para ver un comprobante (staff o dueño). */
export async function proofSignedUrl(path: string): Promise<string> {
  const supabase = createClient();
  const { data, error } = await supabase.storage.from(PROOF_BUCKET).createSignedUrl(path, 600);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? "proof_url_failed");
  return data.signedUrl;
}

// ── Cambio de modalidad ─────────────────────────────────────────────────────

export interface ModeChangeResult {
  change_id: string;
  status: ModeChange["status"];
  from_mode: string;
  to_mode: BillingModeKey;
  needs_mp_cancel: boolean;
  needs_checkout: boolean;
  /** Resultado de cancelar el preapproval en MP (si hacía falta). */
  mpCancel: { ok: boolean; detail: string | null } | null;
  /** Link de suscripción de MP para mandarle al cliente (si hacía falta). */
  checkoutUrl: string | null;
  checkoutError: string | null;
}

/** Cancela el preapproval en MP e informa el resultado (también para reintentar). */
async function cancelPreapproval(tenantId: string, changeId: string): Promise<{ ok: boolean; detail: string | null }> {
  const { data, error } = await invokeEdge<{ ok?: boolean; reason?: string; detail?: string; error?: string }>(
    "mp_subscription_pause",
    { tenant_id: tenantId, action: "cancel" },
  );
  const ok = !error && data?.ok === true;
  const detail = ok ? null : (error ?? data?.error ?? data?.detail ?? "mp_unavailable");
  await call("internal_billing_mode_change_mp_result", { p_change: changeId, p_ok: ok, p_detail: detail });
  return { ok, detail };
}

/** Genera el link de suscripción de MP para el negocio (staff). */
export async function createCheckoutLink(tenantId: string): Promise<{ url: string | null; error: string | null }> {
  const { data, error } = await invokeEdge<{ init_point?: string; error?: string }>("mp_subscription_checkout", {
    tenant_id: tenantId,
    back_url: `${appOrigin()}/dashboard-team#estado-de-cuenta`,
  });
  if (error || !data?.init_point) return { url: null, error: error ?? data?.error ?? "sin_link" };
  return { url: data.init_point, error: null };
}

export function useModeChange(tenantId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["billing-collection"] });
    void qc.invalidateQueries({ queryKey: ["billing-statement", tenantId] });
    void qc.invalidateQueries({ queryKey: ["billing-overview"] });
  };
  return {
    change: useMutation({
      mutationFn: async (v: {
        to: BillingModeKey;
        dueDays: number | null;
        exemptReason: string | null;
        reason: string;
      }): Promise<ModeChangeResult> => {
        const res = await call<Omit<ModeChangeResult, "mpCancel" | "checkoutUrl" | "checkoutError">>(
          "internal_billing_change_mode",
          {
            p_tenant: tenantId,
            p_to: v.to,
            p_due_days: v.dueDays,
            p_exempt_reason: v.exemptReason,
            p_reason: v.reason,
          },
        );
        // 1) Pasó a una modalidad sin MP: cancelar el débito para no cobrar doble.
        const mpCancel = res.needs_mp_cancel ? await cancelPreapproval(tenantId, res.change_id) : null;
        // 2) Pasó a MP: generar el checkout; hasta el primer débito sigue igual.
        let checkoutUrl: string | null = null;
        let checkoutError: string | null = null;
        if (res.needs_checkout) {
          const link = await createCheckoutLink(tenantId);
          checkoutUrl = link.url;
          checkoutError = link.error;
        }
        return { ...res, mpCancel, checkoutUrl, checkoutError };
      },
      onSettled: done,
    }),
    retryCancel: useMutation({
      mutationFn: (changeId: string) => cancelPreapproval(tenantId, changeId),
      onSettled: done,
    }),
    checkout: useMutation({
      mutationFn: () => createCheckoutLink(tenantId),
    }),
  };
}

// ── Negocio ─────────────────────────────────────────────────────────────────

export function useMyBillingAccount(enabled = true) {
  return useQuery({
    queryKey: ["my-billing-account"],
    queryFn: () => call<MyBillingAccount>("my_billing_account"),
    enabled,
    retry: false,
  });
}

async function sha256Hex(file: Blob): Promise<string | null> {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export function useReportTransfer(tenantId: string | null) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["my-billing-account"] });
  };
  return {
    report: useMutation({
      mutationFn: async (v: {
        amountCents: number;
        paidOn: string;
        bankAccountId: string | null;
        reference: string;
        note: string;
        file: File;
      }) => {
        if (!tenantId) throw new Error("forbidden");
        const supabase = createClient();
        const hash = await sha256Hex(v.file);
        const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
        const path = `${tenantId}/${new Date().toISOString().slice(0, 7)}/${id}.${proofExtension(v.file.type)}`;
        const up = await supabase.storage.from(PROOF_BUCKET).upload(path, v.file, {
          contentType: v.file.type,
          upsert: false,
        });
        if (up.error) throw new Error("invalid_proof");
        return call<string>("owner_report_transfer", {
          p_amount_cents: v.amountCents,
          p_paid_on: v.paidOn,
          p_bank_account: v.bankAccountId,
          p_reference: v.reference || null,
          p_note: v.note || null,
          p_proof_path: path,
          p_proof_sha256: hash,
          p_proof_mime: v.file.type,
        });
      },
      onSuccess: done,
    }),
    cancel: useMutation({
      mutationFn: (id: string) => call<null>("owner_cancel_transfer_report", { p_id: id }),
      onSuccess: done,
    }),
  };
}

/** El dueño completa el pase a débito automático (su propio checkout). */
export async function ownerSubscriptionCheckout(): Promise<string> {
  const { data, error } = await invokeEdge<{ init_point?: string; error?: string }>("mp_subscription_checkout", {
    back_url: `${appOrigin()}/dashboard-team#estado-de-cuenta`,
  });
  if (error || !data?.init_point) throw new Error(error ?? data?.error ?? "sin_link");
  return data.init_point;
}
