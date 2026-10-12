"use client";

// Integración NubCeo (ADR-062): configuración, credenciales, monitor de envíos
// y asientos contables. Lectura de tablas con RLS (dueño o encargado, ADR-052:
// además se filtra por el negocio activo); escritura sólo por RPC SECURITY
// DEFINER; lo que habla con NubCeo pasa por la Edge `nubceo_sync`. Tablas y
// RPC fuera de los tipos generados: se castean.

import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { LedgerHeaderInput } from "@/lib/integrations/nubceo/ledgerCsv";

export type NubceoEnv = "test" | "prod";

export type SyncStatus =
  | "pending"
  | "sending"
  | "synced"
  | "excluded"
  | "error"
  | "simulated"
  | "delete_pending"
  | "deleted";

export interface NubceoSettingsRow {
  tenant_id: string;
  enabled: boolean;
  environment: NubceoEnv;
  simulate: boolean;
  start_at: string | null;
  every_minutes: number;
  window_start: string;
  window_end: string;
  window_days: number[];
  store_ids: string[] | null;
  batch_size: number;
  max_attempts: number;
  mapping: unknown;
  ledger_auto: boolean;
  ledger_since: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: "ok" | "partial" | "error" | "skipped" | "simulated" | null;
  last_run_message: string | null;
  last_run_counts: Record<string, number> | null;
  consecutive_failures: number;
  paused_until: string | null;
  ledger_last_import_at: string | null;
  ledger_last_message: string | null;
  updated_at: string;
}

export interface NubceoCredentialView {
  configured: boolean;
  api_key_hint: string;
  nubceo_tenant: string;
  tax_code: string | null;
  api_url: string | null;
  company_id: string | null;
  company_name: string | null;
  verified_at: string | null;
  updated_at: string;
}

export interface NubceoConfig {
  settings: NubceoSettingsRow | null;
  credentials: Partial<Record<NubceoEnv, NubceoCredentialView>>;
  feature: boolean;
}

export interface SyncRow {
  id: string;
  kind: "sale" | "return";
  sale_id: string;
  return_id: string | null;
  venta_id: string;
  store_id: string | null;
  sale_number: number | null;
  sale_date: string;
  amount: number;
  status: SyncStatus;
  excluded_by: "rule" | "user" | "void" | null;
  excluded_reason: string | null;
  error_kind: string | null;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  last_http_status: number | null;
  last_response: unknown;
  payload: unknown;
  payload_hash: string | null;
  environment: NubceoEnv | null;
  already_existed: boolean;
  sent_at: string | null;
  synced_at: string | null;
  deleted_in_nubceo_at: string | null;
  updated_at: string;
}

export interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: "cron" | "manual";
  environment: NubceoEnv | null;
  simulate: boolean;
  status: "ok" | "partial" | "error" | "skipped" | "simulated";
  counts: Record<string, number>;
  message: string | null;
}

export interface DailyTotal {
  day: string;
  synced: number;
  synced_amount: number;
  pending: number;
  errors: number;
  excluded: number;
}

export interface LedgerEntryRow {
  id: string;
  position: number;
  account_code: string | null;
  account_name: string | null;
  subaccount_code: string | null;
  subaccount_name: string | null;
  cost_center: string | null;
  amount: number;
}

export interface LedgerHeaderRow {
  id: string;
  source: "api" | "csv";
  nubceo_id: string;
  number: string | null;
  category: string | null;
  status: "confirmed" | "not_confirmed";
  entry_date: string;
  currency: string;
  total_debit: number;
  total_credit: number;
  deleted_in_nubceo: boolean;
  imported_at: string;
  nubceo_ledger_entries?: LedgerEntryRow[];
}

export type MonitorTab = "synced" | "pending" | "error" | "excluded";

export const TAB_STATUSES: Record<MonitorTab, SyncStatus[]> = {
  synced: ["synced", "deleted"],
  pending: ["pending", "sending", "simulated", "delete_pending"],
  error: ["error"],
  excluded: ["excluded"],
};

export interface MonitorFilters {
  tab: MonitorTab;
  from: string;
  to: string;
  storeId: string | null;
  search: string;
  page: number;
  pageSize: number;
}

const from = (table: string) => createClient().from(table as never);

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

async function tenantId(): Promise<string> {
  const id = await getCurrentTenantId();
  if (!id) throw new Error("no_tenant");
  return id;
}

/** Llama a la Edge y devuelve el cuerpo aunque la respuesta sea un error HTTP. */
async function edge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("nubceo_sync", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: { error?: string; message?: string } | null = null;
    try {
      detail = ctx ? await ctx.json() : null;
    } catch {
      detail = null;
    }
    throw new Error(detail?.error ?? detail?.message ?? error.message);
  }
  return data as T;
}

const SYNC_COLS =
  "id, kind, sale_id, return_id, venta_id, store_id, sale_number, sale_date, amount, status, excluded_by, excluded_reason, error_kind, attempts, next_attempt_at, last_error, last_http_status, last_response, payload, payload_hash, environment, already_existed, sent_at, synced_at, deleted_in_nubceo_at, updated_at";

export const nubceoApi = {
  config: () => rpc<NubceoConfig>("nubceo_settings_get"),

  saveSettings: (patch: Record<string, unknown>) =>
    rpc<{ ok: boolean; requeued: number }>("nubceo_settings_save", { p: patch }),

  setCredentials: (v: {
    environment: NubceoEnv;
    apiKey: string;
    apiSecret: string;
    nubceoTenant: string;
    taxCode: string | null;
    apiUrl: string | null;
  }) =>
    rpc<{ ok: boolean }>("nubceo_credentials_set", {
      p_environment: v.environment,
      p_api_key: v.apiKey,
      p_api_secret: v.apiSecret,
      p_nubceo_tenant: v.nubceoTenant,
      p_tax_code: v.taxCode,
      p_api_url: v.apiUrl,
    }),

  clearCredentials: (environment: NubceoEnv) => rpc<{ ok: boolean }>("nubceo_credentials_clear", { p_environment: environment }),

  testConnection: (environment: NubceoEnv) =>
    edge<{
      ok: boolean;
      error?: string;
      message?: string;
      companies?: { id: string; name: string; taxCode: string }[];
      company?: { id: string; name: string } | null;
    }>({ action: "test", environment }),

  runNow: () =>
    edge<{ ok: boolean; status: string; message: string; counts: Record<string, number> }>({ action: "run" }),

  preview: (syncId: string) =>
    edge<{ ok: boolean; action: string; reason?: string; payload?: unknown }>({ action: "preview", sync_id: syncId }),

  list: async (f: MonitorFilters): Promise<{ rows: SyncRow[]; total: number }> => {
    let q = from("nubceo_sync")
      .select(SYNC_COLS, { count: "exact" })
      .eq("tenant_id", await tenantId())
      .in("status", TAB_STATUSES[f.tab])
      .gte("sale_date", f.from)
      .lt("sale_date", f.to)
      .order("sale_date", { ascending: false })
      .range(f.page * f.pageSize, f.page * f.pageSize + f.pageSize - 1);
    if (f.storeId) q = q.eq("store_id", f.storeId);
    const s = f.search.trim();
    if (s) {
      const n = Number(s.replace(/\D/g, ""));
      q = /^\d+$/.test(s) && Number.isFinite(n)
        ? q.or(`sale_number.eq.${n},venta_id.ilike.%${s}%`)
        : q.ilike("venta_id", `%${s.replace(/[%,()]/g, "")}%`);
    }
    const { data, error, count } = await q;
    if (error) throw error;
    return {
      rows: ((data ?? []) as unknown as SyncRow[]).map((r) => ({ ...r, amount: Number(r.amount) })),
      total: count ?? 0,
    };
  },

  counts: (fromIso: string, toIso: string, storeId: string | null) =>
    rpc<Record<string, number>>("nubceo_status_counts", { p_from: fromIso, p_to: toIso, p_store: storeId }),

  daily: async (fromDay: string, toDay: string): Promise<DailyTotal[]> => {
    const rows = await rpc<DailyTotal[]>("nubceo_daily_totals", { p_from: fromDay, p_to: toDay });
    return (rows ?? []).map((r) => ({ ...r, synced_amount: Number(r.synced_amount) }));
  },

  runs: async (): Promise<RunRow[]> => {
    const { data, error } = await from("nubceo_runs")
      .select("id, started_at, finished_at, trigger, environment, simulate, status, counts, message")
      .eq("tenant_id", await tenantId())
      .order("started_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return (data ?? []) as unknown as RunRow[];
  },

  retry: (ids: string[]) => rpc<number>("nubceo_retry", { p_ids: ids }),
  retryBulk: (status: "error" | "simulated", fromIso: string, toIso: string) =>
    rpc<number>("nubceo_retry_bulk", { p_status: status, p_from: fromIso, p_to: toIso }),
  exclude: (ids: string[], reason: string) => rpc<number>("nubceo_exclude", { p_ids: ids, p_reason: reason }),
  requestDelete: (ids: string[], reason: string) => rpc<number>("nubceo_request_delete", { p_ids: ids, p_reason: reason }),

  ledger: async (f: { from: string; to: string; status: "all" | "confirmed" | "not_confirmed" }): Promise<LedgerHeaderRow[]> => {
    let q = from("nubceo_ledger_headers")
      .select(
        "id, source, nubceo_id, number, category, status, entry_date, currency, total_debit, total_credit, deleted_in_nubceo, imported_at, nubceo_ledger_entries(id, position, account_code, account_name, subaccount_code, subaccount_name, cost_center, amount)",
      )
      .eq("tenant_id", await tenantId())
      .gte("entry_date", f.from)
      .lte("entry_date", f.to)
      .order("entry_date", { ascending: false })
      .order("number", { ascending: false })
      .limit(300);
    if (f.status !== "all") q = q.eq("status", f.status);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as LedgerHeaderRow[]).map((h) => ({
      ...h,
      total_debit: Number(h.total_debit),
      total_credit: Number(h.total_credit),
      nubceo_ledger_entries: (h.nubceo_ledger_entries ?? [])
        .map((e) => ({ ...e, amount: Number(e.amount) }))
        .sort((a, b) => a.position - b.position),
    }));
  },

  ledgerImportApi: (since: string | null) =>
    edge<{ ok: boolean; headers: number; entries: number; message: string }>({ action: "ledger_import", since }),

  ledgerImportCsv: (headers: LedgerHeaderInput[]) =>
    rpc<{ headers: number; entries: number; skipped: number }>("nubceo_ledger_import", { p_headers: headers }),

  ledgerStatus: (ids: string[], status: "confirmed" | "not_confirmed") =>
    edge<{ ok: boolean; updated?: string[]; error?: string }>({ action: "ledger_status", ids, status }),
};

/** Mensaje legible de un error del servidor. */
export function nubceoErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
  const map: [RegExp, string][] = [
    [/feature_not_in_plan/, "Tu plan no incluye la integración con NubCeo."],
    [/forbidden/, "Sólo el dueño o un encargado pueden hacer esto."],
    [/credentials_missing/, "Primero cargá las credenciales de ese ambiente."],
    [/invalid_api_secret/, "Falta el API secret."],
    [/invalid_api_key/, "Falta la API key."],
    [/invalid_nubceo_tenant/, "El tenant de NubCeo sólo lleva letras, números, guion y guion bajo."],
    [/invalid_tax_code/, "El CUIT tiene que tener 11 números."],
    [/invalid_api_url/, "La URL de la API tiene que ser https de nubceo.com."],
    [/invalid_stores/, "Alguna sucursal elegida no es de este negocio."],
    [/invalid_window/, "Revisá la franja horaria."],
    [/invalid_every_minutes/, "Elegí un ritmo de la lista."],
    [/invalid_mapping: saleIdPrefix/, "El prefijo sólo lleva letras, números, guion y guion bajo (hasta 12)."],
    [/reason_required/, "Escribí el motivo."],
    [/invalid_credentials/, "NubCeo rechazó la API key o el secreto."],
    [/unreachable/, "No se pudo hablar con NubCeo. Probá de nuevo en unos minutos."],
  ];
  for (const [re, text] of map) if (re.test(msg)) return text;
  return msg || "No se pudo completar.";
}
