"use client";

// Contabilidad (ADR-066): lectura por tablas y vista con RLS (dueño o
// encargado) y escritura sólo por RPC SECURITY DEFINER con auditoría. Las
// listas filtran por el negocio activo además de la RLS (ADR-052). Tablas y
// RPC fuera de los tipos generados: se castean.

import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import type { AccountKind, JournalLine, TrialRow } from "@/lib/accounting/journal";
import type { VatMode } from "@/lib/accounting/vat";
import type { MappingRow } from "@/lib/accounting/mappings";

export interface AccSettings {
  tenant_id: string;
  enabled: boolean;
  template: string;
  start_date: string;
  vat_mode: VatMode;
  default_vat_rate: number;
  cmv_mode: "none" | "perpetual";
  fiscal_year_start_month: number;
  export_config: Record<string, unknown>;
}

export interface AccAccount {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  kind: AccountKind;
  imputable: boolean;
  external_code: string | null;
  system_key: string | null;
  is_active: boolean;
  notes: string | null;
}

export interface AccountInput {
  code: string;
  name: string;
  parent_id: string | null;
  kind: AccountKind;
  imputable: boolean;
  external_code: string | null;
  is_active: boolean;
  notes: string | null;
}

export interface CostCenter {
  id: string;
  code: string;
  name: string;
  store_id: string | null;
  is_active: boolean;
}

export interface Mapping extends MappingRow {
  id: string;
}

export interface AccEntry {
  id: string;
  number: number;
  official_number: number | null;
  entry_date: string;
  kind: string;
  source_type: string | null;
  source_id: string | null;
  source_event: string | null;
  description: string;
  store_id: string | null;
  reversal_of: string | null;
  reversed_by: string | null;
  total: number;
  created_at: string;
}

export interface EntryFilters {
  from?: string | null;
  to?: string | null;
  sourceType?: string | null;
  kind?: string | null;
  storeId?: string | null;
  accountId?: string | null;
  search?: string | null;
}

export interface ManualLineInput {
  account_id: string;
  cost_center_id?: string | null;
  debit: number;
  credit: number;
  description?: string | null;
}

export interface ManualEntryInput {
  date: string;
  description: string;
  store_id?: string | null;
  kind?: "manual" | "opening";
  lines: ManualLineInput[];
}

export interface PeriodRow {
  period: string;
  status: "open" | "closed";
  entries: number;
  total: number;
  closed_at: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  notes: string | null;
}

export interface AccIssue {
  id: string;
  source_type: string;
  source_id: string;
  message: string;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface VatSalesRow {
  day: string;
  store_id: string | null;
  kind: "venta" | "anulacion" | "devolucion";
  rate: number;
  net: number;
  vat: number;
  gross: number;
  docs: number;
}

export interface VatPurchaseRow {
  invoice_id: string;
  issue_date: string;
  supplier_name: string;
  supplier_cuit: string | null;
  supplier_iva: string | null;
  kind: string;
  letter: string;
  point_of_sale: number;
  number: number;
  vat_lines: Array<{ rate: number; net: number; vat: number }>;
  net_total: number;
  vat_total: number;
  exempt: number;
  non_taxed: number;
  perc_iva: number;
  perc_iibb: number;
  perc_ganancias: number;
  internos: number;
  otros: number;
  total: number;
}

const from = (table: string) => createClient().from(table as never);

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

async function tenantId(): Promise<string> {
  const user = await getCurrentUser();
  const id = (user?.app_metadata as { current_tenant_id?: string } | undefined)?.current_tenant_id;
  if (!id) throw new Error("no_tenant");
  return id;
}

const num = (v: unknown) => Number(v ?? 0);

const JOURNAL_COLS =
  "entry_id, number, official_number, entry_date, kind, source_type, source_id, source_event, entry_description, store_id, line_no, account_id, account_code, account_name, account_external_code, account_kind, cost_center_id, cost_center_code, cost_center_name, debit, credit, description";

function toLine(r: Record<string, unknown>): JournalLine {
  return {
    ...(r as unknown as JournalLine),
    number: num(r.number),
    official_number: r.official_number == null ? null : num(r.official_number),
    line_no: num(r.line_no),
    debit: num(r.debit),
    credit: num(r.credit),
  };
}

const PAGE = 1000;

export const accountingApi = {
  settings: async (): Promise<AccSettings | null> => {
    const { data, error } = await from("acc_settings").select("*").eq("tenant_id", await tenantId()).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const d = data as unknown as AccSettings;
    return { ...d, default_vat_rate: num(d.default_vat_rate), fiscal_year_start_month: num(d.fiscal_year_start_month) };
  },

  setup: (p: Partial<Pick<AccSettings, "start_date" | "vat_mode" | "cmv_mode" | "fiscal_year_start_month">>) =>
    rpc<void>("acc_setup", { p }),

  saveSettings: (p: Partial<AccSettings>) => rpc<void>("acc_settings_save", { p }),

  accounts: async (): Promise<AccAccount[]> => {
    const { data, error } = await from("acc_accounts")
      .select("id, code, name, parent_id, kind, imputable, external_code, system_key, is_active, notes")
      .eq("tenant_id", await tenantId())
      .is("deleted_at", null)
      .order("code");
    if (error) throw error;
    return (data ?? []) as unknown as AccAccount[];
  },

  saveAccount: (id: string | null, p: AccountInput) => rpc<string>("acc_account_save", { p_id: id, p }),
  deleteAccount: (id: string) => rpc<void>("acc_account_delete", { p_id: id }),

  costCenters: async (): Promise<CostCenter[]> => {
    const { data, error } = await from("acc_cost_centers")
      .select("id, code, name, store_id, is_active")
      .eq("tenant_id", await tenantId())
      .is("deleted_at", null)
      .order("code");
    if (error) throw error;
    return (data ?? []) as unknown as CostCenter[];
  },

  saveCostCenter: (id: string | null, p: { code: string; name: string; store_id: string | null; is_active: boolean }) =>
    rpc<string>("acc_cost_center_save", { p_id: id, p }),

  mappings: async (): Promise<Mapping[]> => {
    const { data, error } = await from("acc_mappings")
      .select("id, concept, qualifier, store_id, account_id")
      .eq("tenant_id", await tenantId());
    if (error) throw error;
    return (data ?? []) as unknown as Mapping[];
  },

  setMapping: (v: { concept: string; qualifier: string; storeId: string | null; accountId: string | null }) =>
    rpc<void>("acc_mapping_set", {
      p_concept: v.concept,
      p_qualifier: v.qualifier,
      p_store: v.storeId,
      p_account: v.accountId,
    }),

  entries: async (f: EntryFilters, page: number, pageSize: number): Promise<{ rows: AccEntry[]; total: number }> => {
    const select = f.accountId
      ? "id, number, official_number, entry_date, kind, source_type, source_id, source_event, description, store_id, reversal_of, reversed_by, total, created_at, acc_entry_lines!inner(account_id)"
      : "id, number, official_number, entry_date, kind, source_type, source_id, source_event, description, store_id, reversal_of, reversed_by, total, created_at";
    let q = from("acc_entries")
      .select(select, { count: "exact" })
      .eq("tenant_id", await tenantId())
      .is("deleted_at", null);
    if (f.from) q = q.gte("entry_date", f.from);
    if (f.to) q = q.lte("entry_date", f.to);
    if (f.sourceType === "manual") q = q.is("source_type", null);
    else if (f.sourceType) q = q.eq("source_type", f.sourceType);
    if (f.kind) q = q.eq("kind", f.kind);
    if (f.storeId) q = q.eq("store_id", f.storeId);
    if (f.accountId) q = q.eq("acc_entry_lines.account_id", f.accountId);
    if (f.search?.trim()) q = q.ilike("description", `%${f.search.trim().replace(/[%_]/g, "")}%`);
    const start = (page - 1) * pageSize;
    const { data, error, count } = await q
      .order("entry_date", { ascending: false })
      .order("number", { ascending: false })
      .range(start, start + pageSize - 1);
    if (error) throw error;
    const rows = ((data ?? []) as unknown as AccEntry[]).map((e) => {
      const { acc_entry_lines: _drop, ...rest } = e as AccEntry & { acc_entry_lines?: unknown };
      void _drop;
      return { ...rest, total: num(rest.total), number: num(rest.number) };
    });
    return { rows, total: count ?? rows.length };
  },

  entryLines: async (entryId: string): Promise<JournalLine[]> => {
    const { data, error } = await from("acc_journal_lines")
      .select(JOURNAL_COLS)
      .eq("tenant_id", await tenantId())
      .eq("entry_id", entryId)
      .order("line_no");
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(toLine);
  },

  /** Todos los renglones del rango (paginado de a 1000), en orden del Diario. */
  journal: async (f: { from: string; to: string; storeId?: string | null; accountId?: string | null }): Promise<JournalLine[]> => {
    const tenant = await tenantId();
    const out: JournalLine[] = [];
    for (let page = 0; page < 200; page++) {
      let q = from("acc_journal_lines")
        .select(JOURNAL_COLS)
        .eq("tenant_id", tenant)
        .gte("entry_date", f.from)
        .lte("entry_date", f.to);
      if (f.storeId) q = q.eq("store_id", f.storeId);
      if (f.accountId) q = q.eq("account_id", f.accountId);
      const { data, error } = await q
        .order("entry_date")
        .order("number")
        .order("line_no")
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      const rows = ((data ?? []) as Record<string, unknown>[]).map(toLine);
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  },

  trialBalance: async (f: { from: string; to: string; storeId?: string | null }): Promise<TrialRow[]> => {
    const data = await rpc<Record<string, unknown>[]>("acc_trial_balance", {
      p_from: f.from,
      p_to: f.to,
      p_store: f.storeId ?? null,
    });
    return (data ?? []).map((r) => ({
      ...(r as unknown as TrialRow),
      opening: num(r.opening),
      debit: num(r.debit),
      credit: num(r.credit),
    }));
  },

  vatSales: async (f: { from: string; to: string }): Promise<VatSalesRow[]> => {
    const data = await rpc<Record<string, unknown>[]>("acc_vat_sales", { p_from: f.from, p_to: f.to });
    return (data ?? []).map((r) => ({
      ...(r as unknown as VatSalesRow),
      rate: num(r.rate),
      net: num(r.net),
      vat: num(r.vat),
      gross: num(r.gross),
      docs: num(r.docs),
    }));
  },

  vatPurchases: async (f: { from: string; to: string }): Promise<VatPurchaseRow[]> => {
    const data = await rpc<Record<string, unknown>[]>("acc_vat_purchases", { p_from: f.from, p_to: f.to });
    const keys = ["net_total", "vat_total", "exempt", "non_taxed", "perc_iva", "perc_iibb", "perc_ganancias", "internos", "otros", "total"] as const;
    return (data ?? []).map((r) => {
      const row = { ...(r as unknown as VatPurchaseRow) };
      for (const k of keys) (row as unknown as Record<string, number>)[k] = num(r[k]);
      row.vat_lines = ((r.vat_lines as VatPurchaseRow["vat_lines"]) ?? []).map((l) => ({
        rate: num(l.rate),
        net: num(l.net),
        vat: num(l.vat),
      }));
      return row;
    });
  },

  periods: async (): Promise<PeriodRow[]> => {
    const data = await rpc<Record<string, unknown>[]>("acc_periods_overview", { p_months: 18 });
    return (data ?? []).map((r) => ({
      ...(r as unknown as PeriodRow),
      period: String(r.period).slice(0, 10),
      entries: num(r.entries),
      total: num(r.total),
    }));
  },

  issues: async (): Promise<AccIssue[]> => {
    const { data, error } = await from("acc_issues")
      .select("id, source_type, source_id, message, attempts, created_at, updated_at")
      .eq("tenant_id", await tenantId())
      .is("resolved_at", null)
      .is("dismissed_at", null)
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []) as unknown as AccIssue[];
  },

  generate: (v: { from: string; to: string; regenerate: boolean }) =>
    rpc<{ created: number; deleted: number; failed: number }>("acc_generate", {
      p_from: v.from,
      p_to: v.to,
      p_regenerate: v.regenerate,
    }),

  saveManual: (p: ManualEntryInput) => rpc<string>("acc_entry_manual_save", { p }),
  reverse: (v: { id: string; reason: string; date?: string | null }) =>
    rpc<string>("acc_entry_reverse", { p_id: v.id, p_reason: v.reason, p_date: v.date ?? null }),
  closePeriod: (v: { period: string; notes?: string | null }) =>
    rpc<{ entries: number; total: number; open_issues: number }>("acc_period_close", {
      p_period: v.period,
      p_notes: v.notes ?? null,
    }),
  reopenPeriod: (v: { period: string; reason: string }) =>
    rpc<void>("acc_period_reopen", { p_period: v.period, p_reason: v.reason }),
  retryIssue: (id: string) => rpc<boolean>("acc_issue_retry", { p_id: id }),
  dismissIssue: (id: string) => rpc<void>("acc_issue_dismiss", { p_id: id }),
};
