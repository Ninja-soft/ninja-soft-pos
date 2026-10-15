"use client";

// Facturación de Mercado Libre (ADR-141): configuración por cuenta, bandeja de
// ventas por facturar, elección por venta, emisión en lote, subida elegida a
// ML, percepciones con link de pago y nota de crédito. Todo por RPC SECURITY
// DEFINER o por la Edge ml_facturacion: el servidor valida plan, rol, cuenta
// y la matriz de ARCA.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { InboxCounts, InboxFilter, InboxRow, MlInvoicePlan } from "@/lib/mercadolibre/billing";

export interface MlBillingSettings {
  account_id: string;
  invoice_mode: string;
  upload_invoice: boolean;
  pto_vta: number | null;
  concepto: number | null;
  pdf_format: "a4" | "ticket";
  upload_credit_notes: boolean;
  nc_on_refund: "review" | "auto";
  rules: Record<string, unknown>;
  perc_link_days: number;
  perc_on_expire: "invoice_b" | "invoice_a" | "hold";
  perc_message: string | null;
  /** ADR-145: mensaje al comprador al subir la factura y leyenda de la factura. */
  invoice_message_enabled?: boolean;
  invoice_message?: string | null;
  invoice_notes_enabled?: boolean;
  invoice_notes?: string | null;
  /** ADR-145: sucursal y depósito por tipo de envío. */
  logistic_stores?: Record<string, { store_id: string; warehouse_id?: string | null }>;
  account_store?: { store_id: string | null; warehouse_id: string | null } | null;
  stores?: Array<{
    id: string;
    name: string;
    pto_vta: number | null;
    is_default: boolean;
    warehouses: Array<{ id: string; name: string; kind: string }>;
  }>;
  saved: boolean;
  features: { billing: boolean; perceptions: boolean; arca: boolean; mercado_pago: boolean };
  emitter: { iva_condition: string | null; issues_m: boolean };
  store_pto_vta: number | null;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

async function edge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("ml_facturacion", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: { error?: string; message?: string } | null = null;
    try {
      detail = ctx && typeof ctx.json === "function" ? await ctx.json() : null;
    } catch {
      detail = null;
    }
    throw new Error([detail?.error, detail?.message].filter(Boolean).join(": ") || error.message);
  }
  const res = data as (T & { error?: string; message?: string }) | null;
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error([res.error, res.message].filter(Boolean).join(": "));
  return data as T;
}

export function useMlBillingSettings(accountId: string | null) {
  return useQuery({
    queryKey: ["ml", "billing", "settings", accountId],
    queryFn: () => rpc<MlBillingSettings>("ml_billing_settings_get", { p_account: accountId }),
    enabled: Boolean(accountId),
  });
}

export function useMlInvoiceInbox(accountId: string | null, filter: InboxFilter, enabled = true) {
  return useQuery({
    queryKey: ["ml", "billing", "inbox", accountId, filter],
    queryFn: () => rpc<{ counts: InboxCounts; rows: InboxRow[] }>("ml_invoice_inbox", { p_account: accountId, p_filter: filter, p_limit: 150 }),
    enabled: Boolean(accountId) && enabled,
    refetchInterval: 30_000,
  });
}

export interface EmitResult {
  ok: number;
  results: Array<{ id: string; ok: boolean; error?: string; letter?: string }>;
}

export interface PerceptionLinkResult {
  ok: boolean;
  dry_run?: boolean;
  amount: number;
  days?: number;
  message: string;
  init_point?: string;
  sent?: boolean;
  env?: "prod" | "test";
}

export function useMlBillingMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["ml"] });
  return {
    saveSettings: useMutation({
      mutationFn: (v: { accountId: string; p: Record<string, unknown> }) => rpc("ml_billing_settings_save", { p_account: v.accountId, p: v.p }),
      onSuccess: inv,
    }),
    choose: useMutation({
      mutationFn: (v: { planId: string; p: Record<string, unknown> }) => rpc<{ ok: boolean; status: string }>("ml_invoice_choice_set", { p_plan: v.planId, p: v.p }),
      onSuccess: inv,
    }),
    emit: useMutation({
      mutationFn: (v: { planIds: string[]; force?: boolean }) =>
        rpc<EmitResult>("ml_invoice_emit_batch", { p_plans: v.planIds, p_force: v.force ?? false }),
      onSuccess: inv,
    }),
    skip: useMutation({
      mutationFn: (v: { planIds: string[]; skip: boolean; reason?: string }) =>
        rpc<{ ok: boolean; count: number }>("ml_invoice_skip", { p_plans: v.planIds, p_skip: v.skip, p_reason: v.reason ?? null }),
      onSuccess: inv,
    }),
    upload: useMutation({
      mutationFn: (v: { docId: string; sync: boolean; now?: boolean; replace?: boolean }) =>
        rpc("ml_invoice_upload_set", { p_doc: v.docId, p_sync: v.sync, p_now: v.now ?? false, p_replace: v.replace ?? false }),
      onSuccess: inv,
    }),
    creditNote: useMutation({
      mutationFn: (v: { planId: string; reason?: string }) => rpc("ml_invoice_credit_note", { p_plan: v.planId, p_reason: v.reason ?? null }),
      onSuccess: inv,
    }),
    replan: useMutation({
      mutationFn: (v: { accountId: string; packKey: string }) =>
        edge<{ ok: boolean; status: string; plan: MlInvoicePlan }>({ action: "replan", account_id: v.accountId, pack_key: v.packKey }),
      onSuccess: inv,
    }),
    perceptionLink: useMutation({
      mutationFn: (v: { planId: string; dryRun?: boolean; sendMessage?: boolean }) =>
        edge<PerceptionLinkResult>({ action: "perception_link", plan_id: v.planId, dry_run: v.dryRun ?? false, send_message: v.sendMessage ?? false }),
      onSuccess: inv,
    }),
    perceptionMessage: useMutation({
      mutationFn: (planId: string) => edge<{ ok: boolean; sent: boolean; message: string }>({ action: "perception_message", plan_id: planId }),
      onSuccess: inv,
    }),
    perceptionPaid: useMutation({
      mutationFn: (v: { planId: string; reference: string }) => rpc("ml_perception_mark_paid", { p_plan: v.planId, p_reference: v.reference }),
      onSuccess: inv,
    }),
    perceptionCancel: useMutation({
      mutationFn: (v: { planId: string; then: "invoice_b" | "invoice_a" | "hold" }) =>
        rpc("ml_perception_cancel", { p_plan: v.planId, p_then: v.then }),
      onSuccess: inv,
    }),
  };
}
