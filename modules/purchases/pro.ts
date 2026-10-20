"use client";

// Compras PRO (F24 · H167, ADR-178): import de ARCA, bandeja de facturas con
// lectura por IA, factura con renglones, créditos aplicados a facturas y
// ajustes de la cuenta del proveedor. Toda escritura por RPC (el servidor
// exige plan, rol y capacidad). Tablas y RPC nuevas: cliente suelto.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import type { CreditApplicationDraft, OpenCredit } from "@/lib/purchases/credits";
import type { InvoiceLineDraft, InvoiceLineKind } from "@/lib/purchases/invoiceLines";
import type { OcrInvoice } from "@/supabase/functions/_shared/purchaseInvoiceOcr";
import type { InvoiceSaveInput } from "./api";

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

const from = (table: string) => createClient().from(table as never);

async function tenantId(): Promise<string> {
  const user = await getCurrentUser();
  const id = (user?.app_metadata as { current_tenant_id?: string } | undefined)?.current_tenant_id;
  if (!id) throw new Error("no_tenant");
  return id;
}

// ── Tipos ─────────────────────────────────────────────────────────────────

export interface ArcaImportResult {
  applied: boolean;
  created: number;
  skipped: number;
  errors: number;
  suppliers_created: number;
  rows: Array<{
    row: number;
    action: "create" | "skip" | "error";
    message: string | null;
    invoice_id?: string;
    supplier_new?: boolean;
  }>;
}

export interface InvoiceSaveFullInput extends InvoiceSaveInput {
  cae?: string | null;
  cae_due?: string | null;
  source?: "manual" | "arca" | "ia";
}

export interface InvoiceLineRow {
  id: string;
  kind: InvoiceLineKind;
  product_id: string | null;
  variant_id: string | null;
  description: string | null;
  qty: number | null;
  unit_cost: number | null;
  vat_rate: number;
  net: number;
  account_id: string | null;
  receipt_item_id: string | null;
}

export type InboxStatus = "pending" | "processed" | "discarded";

export interface InboxRow {
  id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  note: string | null;
  status: InboxStatus;
  extracted: OcrInvoice | null;
  extracted_at: string | null;
  invoice_id: string | null;
  created_at: string;
}

export type OcrResult =
  | { ok: true; data: OcrInvoice; warnings: string[]; provider: string }
  | { ok: false; error: string; detail?: string };

export interface OcrStatus {
  allowed: boolean;
  configured: boolean;
  addon: boolean;
}

export interface CreditApplicationRow {
  id: string;
  supplier_id: string;
  source_invoice_id: string | null;
  source_payment_id: string | null;
  invoice_id: string;
  payment_id: string | null;
  amount: number;
  created_at: string;
}

export interface AdjustmentRow {
  id: string;
  supplier_id: string;
  kind: "opening" | "adjustment";
  sign: 1 | -1;
  amount: number;
  adj_date: string;
  due_date: string | null;
  reason: string;
  status: "posted" | "voided";
  created_at: string;
}

export interface AdjustmentInput {
  supplier_id: string;
  kind: "opening" | "adjustment";
  sign: 1 | -1;
  amount: number;
  adj_date: string;
  due_date?: string | null;
  reason: string;
}

const EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const INBOX_MIME = Object.keys(EXT);

// ── API ───────────────────────────────────────────────────────────────────

export const purchasesProApi = {
  arcaImport: (rows: Record<string, unknown>[], apply: boolean, fileName: string | null, createSuppliers = true) =>
    rpc<ArcaImportResult>("purchase_arca_import", {
      p_rows: rows,
      p_apply: apply,
      p_file_name: fileName,
      p_create_suppliers: createSuppliers,
    }),

  saveInvoiceFull: (v: {
    id: string | null;
    input: InvoiceSaveFullInput;
    receiptIds: string[];
    lines: InvoiceLineDraft[] | null;
    storeId: string | null;
  }) =>
    rpc<string>("supplier_invoice_save_full", {
      p_id: v.id,
      p: v.input,
      p_receipt_ids: v.receiptIds,
      p_lines: v.lines,
      p_store_id: v.storeId,
    }),

  invoiceLines: async (invoiceId: string): Promise<InvoiceLineRow[]> => {
    const { data, error } = await from("supplier_invoice_lines")
      .select("id, kind, product_id, variant_id, description, qty, unit_cost, vat_rate, net, account_id, receipt_item_id")
      .eq("tenant_id", await tenantId())
      .eq("invoice_id", invoiceId)
      .is("deleted_at", null)
      .order("sort");
    if (error) throw error;
    return ((data ?? []) as unknown as InvoiceLineRow[]).map((l) => ({
      ...l,
      qty: l.qty == null ? null : Number(l.qty),
      unit_cost: l.unit_cost == null ? null : Number(l.unit_cost),
      vat_rate: Number(l.vat_rate),
      net: Number(l.net),
    }));
  },

  // Bandeja
  inbox: async (status: InboxStatus | "all" = "pending"): Promise<InboxRow[]> => {
    let q = from("purchase_invoice_inbox")
      .select("id, storage_path, file_name, mime_type, size_bytes, note, status, extracted, extracted_at, invoice_id, created_at")
      .eq("tenant_id", await tenantId())
      .order("created_at", { ascending: false })
      .limit(300);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as InboxRow[];
  },

  uploadToInbox: async (file: File, note?: string | null): Promise<string> => {
    const ext = EXT[file.type];
    if (!ext) throw new Error("unsupported_file");
    if (file.size > 10 * 1024 * 1024) throw new Error("file_too_large");
    const path = `${await tenantId()}/${crypto.randomUUID()}.${ext}`;
    const up = await createClient().storage.from("purchase-inbox").upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (up.error) throw up.error;
    return rpc<string>("purchase_inbox_add", {
      p_path: path,
      p_file_name: file.name || `factura.${ext}`,
      p_mime_type: file.type,
      p_size_bytes: file.size,
      p_note: note ?? null,
    });
  },

  inboxSetStatus: (id: string, status: InboxStatus, invoiceId?: string | null) =>
    rpc<void>("purchase_inbox_set_status", { p_id: id, p_status: status, p_invoice_id: invoiceId ?? null }),

  inboxFileUrl: async (path: string): Promise<string | null> => {
    const { data } = await createClient().storage.from("purchase-inbox").createSignedUrl(path, 600);
    return data?.signedUrl ?? null;
  },

  ocrStatus: async (): Promise<OcrStatus> => {
    const { data, error } = await createClient().functions.invoke("purchase_invoice_ocr", { body: { action: "status" } });
    if (error) return { allowed: false, configured: false, addon: false };
    return data as OcrStatus;
  },

  ocrExtract: async (inboxId: string): Promise<OcrResult> => {
    const { data, error } = await createClient().functions.invoke("purchase_invoice_ocr", {
      body: { action: "extract", inbox_id: inboxId },
    });
    if (error) return { ok: false, error: "ai_provider_error" };
    return data as OcrResult;
  },

  // Créditos
  openCredits: async (supplierId: string): Promise<OpenCredit[]> => {
    const { data, error } = await from("supplier_credit_open")
      .select("source_type, source_id, label, doc_date, amount_ars, applied_ars, available_ars")
      .eq("tenant_id", await tenantId())
      .eq("supplier_id", supplierId)
      .order("doc_date")
      .limit(500);
    if (error) throw error;
    return ((data ?? []) as unknown as OpenCredit[]).map((c) => ({
      ...c,
      amount_ars: Number(c.amount_ars),
      applied_ars: Number(c.applied_ars),
      available_ars: Number(c.available_ars),
    }));
  },

  creditApplications: async (supplierId?: string | null): Promise<CreditApplicationRow[]> => {
    let q = from("supplier_credit_applications")
      .select("id, supplier_id, source_invoice_id, source_payment_id, invoice_id, payment_id, amount, created_at")
      .eq("tenant_id", await tenantId())
      .is("released_at", null)
      .limit(10000);
    if (supplierId) q = q.eq("supplier_id", supplierId);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as CreditApplicationRow[]).map((a) => ({ ...a, amount: Number(a.amount) }));
  },

  applyCredits: (supplierId: string, items: CreditApplicationDraft[], notes?: string | null) =>
    rpc<number>("supplier_credit_apply", { p_supplier_id: supplierId, p_items: items, p_notes: notes ?? null }),

  unapplyCredit: (id: string, reason: string) => rpc<void>("supplier_credit_unapply", { p_id: id, p_reason: reason }),

  // Ajustes
  adjustments: async (supplierId: string): Promise<AdjustmentRow[]> => {
    const { data, error } = await from("supplier_account_adjustments")
      .select("id, supplier_id, kind, sign, amount, adj_date, due_date, reason, status, created_at")
      .eq("tenant_id", await tenantId())
      .eq("supplier_id", supplierId)
      .order("adj_date", { ascending: false })
      .limit(500);
    if (error) throw error;
    return ((data ?? []) as unknown as AdjustmentRow[]).map((a) => ({ ...a, amount: Number(a.amount) }));
  },

  createAdjustment: (v: AdjustmentInput) => rpc<string>("supplier_adjustment_create", { p: v }),

  voidAdjustment: (id: string, reason: string) =>
    rpc<void>("supplier_adjustment_void", { p_id: id, p_reason: reason }),
};

// ── Hooks ─────────────────────────────────────────────────────────────────

const PRO_KEYS = [
  "suppliers",
  "supplier-invoices",
  "supplier-payments",
  "supplier-balances",
  "supplier-entries",
  "supplier-invoice-open",
  "supplier-payment-allocations",
  "supplier-payment-order",
  "supplier-credit-open",
  "supplier-adjustments",
  "supplier-invoice-lines",
  "purchase-inbox",
  "goods-receipts",
  "goods-receipt",
  "products",
  "product",
];

function useProInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of PRO_KEYS) void qc.invalidateQueries({ queryKey: [key] });
  };
}

export function useInvoiceLines(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: ["supplier-invoice-lines", invoiceId],
    queryFn: () => purchasesProApi.invoiceLines(invoiceId!),
    enabled: Boolean(invoiceId),
  });
}

export function usePurchaseInbox(status: InboxStatus | "all", enabled = true) {
  return useQuery({
    queryKey: ["purchase-inbox", status],
    queryFn: () => purchasesProApi.inbox(status),
    enabled,
  });
}

export function useOcrStatus(enabled = true) {
  return useQuery({
    queryKey: ["purchase-ocr-status"],
    queryFn: () => purchasesProApi.ocrStatus(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useOpenCredits(supplierId: string | null) {
  return useQuery({
    queryKey: ["supplier-credit-open", supplierId],
    queryFn: () => purchasesProApi.openCredits(supplierId!),
    enabled: Boolean(supplierId),
  });
}

export function useSupplierAdjustments(supplierId: string | null) {
  return useQuery({
    queryKey: ["supplier-adjustments", supplierId],
    queryFn: () => purchasesProApi.adjustments(supplierId!),
    enabled: Boolean(supplierId),
  });
}

export function usePurchasesProMutations() {
  const inv = useProInvalidate();
  return {
    arcaImport: useMutation({
      mutationFn: (v: { rows: Record<string, unknown>[]; apply: boolean; fileName: string | null }) =>
        purchasesProApi.arcaImport(v.rows, v.apply, v.fileName),
      onSuccess: (r) => {
        if (r.applied) inv();
      },
    }),
    saveInvoiceFull: useMutation({
      mutationFn: (v: Parameters<typeof purchasesProApi.saveInvoiceFull>[0]) => purchasesProApi.saveInvoiceFull(v),
      onSuccess: inv,
    }),
    uploadToInbox: useMutation({
      mutationFn: (v: { file: File; note?: string | null }) => purchasesProApi.uploadToInbox(v.file, v.note),
      onSuccess: inv,
    }),
    inboxSetStatus: useMutation({
      mutationFn: (v: { id: string; status: InboxStatus; invoiceId?: string | null }) =>
        purchasesProApi.inboxSetStatus(v.id, v.status, v.invoiceId),
      onSuccess: inv,
    }),
    ocrExtract: useMutation({
      mutationFn: (inboxId: string) => purchasesProApi.ocrExtract(inboxId),
      onSuccess: inv,
    }),
    applyCredits: useMutation({
      mutationFn: (v: { supplierId: string; items: CreditApplicationDraft[]; notes?: string | null }) =>
        purchasesProApi.applyCredits(v.supplierId, v.items, v.notes),
      onSuccess: inv,
    }),
    unapplyCredit: useMutation({
      mutationFn: (v: { id: string; reason: string }) => purchasesProApi.unapplyCredit(v.id, v.reason),
      onSuccess: inv,
    }),
    createAdjustment: useMutation({
      mutationFn: (v: AdjustmentInput) => purchasesProApi.createAdjustment(v),
      onSuccess: inv,
    }),
    voidAdjustment: useMutation({
      mutationFn: (v: { id: string; reason: string }) => purchasesProApi.voidAdjustment(v.id, v.reason),
      onSuccess: inv,
    }),
  };
}
