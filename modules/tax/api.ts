import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { EmitterCondition, IvaCode } from "@/lib/tax/catalog";
import type { PadronFormat, PadronRow } from "@/lib/tax/padron";
import { retentionErrorMessage, type GananciasCondition, type RetLine } from "@/lib/tax/retentions";
import type { CertificateRow } from "@/lib/tax/retentionCertificate";
import type { ExportAgent, WithholdingExportRow } from "@/lib/tax/sicore";

// Impuestos (ADR-068). Las tablas y RPC nuevas no están en types/database.ts
// (no se regenera en este PR): cliente suelto, mismo enfoque que
// modules/hardware/api.ts. La base valida todo (RLS, RPC y triggers).
type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  insert: (row: Record<string, unknown> | Record<string, unknown>[]) => Q<T>;
  update: (row: Record<string, unknown>) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  is: (col: string, v: null) => Q<T>;
  in: (col: string, v: unknown[]) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
  limit: (n: number) => Q<T>;
  single: () => Q<T>;
}
interface Loose {
  from: <T = unknown>(table: string) => Q<T>;
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Res<T>;
}
const loose = () => createClient() as unknown as Loose;

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export interface TaxSettings {
  iva_condition: EmitterCondition | null;
  cuit: string | null;
  iibb_number: string | null;
  iibb_jurisdiction: string | null;
  convenio_multilateral: boolean;
  activity_start: string | null;
  default_rate_code: IvaCode;
  issues_cbte_m: boolean;
  configured: boolean;
  updated_at: string | null;
  features: { iva: boolean; internos: boolean; percepciones: boolean };
  can_write: boolean;
  /** Es agente de percepción con algún régimen activo. */
  agent: boolean;
  cf_id_threshold: number | null;
}

export type RegimeTax = "iva" | "iibb" | "ganancias" | "suss";
export type RegimeRole = "perception" | "retention";
export type PadronSource = "none" | "arba" | "agip" | "generic";
export type BaseKind = "net" | "net_taxed" | "total" | "vat";

export interface TaxRegime {
  id: string;
  tax: RegimeTax;
  role: RegimeRole;
  jurisdiction: string | null;
  name: string;
  is_active: boolean;
  agent_number: string | null;
  regime_code: string | null;
  padron_source: PadronSource;
  default_rate: number | null;
  rates_by_condition: Record<string, number>;
  base_kind: BaseKind;
  min_base: number;
  min_amount: number;
  applies_to: string[];
  notes: string | null;
}

export type TaxRegimeInput = Omit<TaxRegime, "id">;

export interface PadronImport {
  id: string;
  jurisdiction: string;
  format: PadronFormat;
  kind: "perception" | "retention" | "both";
  file_name: string | null;
  only_known: boolean;
  period_from: string | null;
  period_to: string | null;
  rows_loaded: number;
  rows_skipped: number;
  rows_error: number;
  status: "loading" | "ready" | "error" | "replaced";
  created_at: string;
  finished_at: string | null;
}

export interface TaxExemption {
  id: string;
  party: "customer" | "supplier";
  party_id: string;
  tax: RegimeTax;
  jurisdiction: string | null;
  pct: number;
  valid_from: string;
  valid_to: string | null;
  certificate: string | null;
}

export interface PerceptionLine {
  regime_id: string;
  tax: "iva" | "iibb";
  jurisdiction: string | null;
  name: string;
  rate: number;
  base: number;
  amount: number;
  source: "padron" | "condition" | "default";
}

export interface SaleTaxPreview {
  letter: string | null;
  requires_identification: boolean;
  net_taxed: number;
  net_exempt: number;
  net_untaxed: number;
  iva_total: number;
  internal_total: number;
  iva: { code: IvaCode; base: number; amount: number }[];
  perceptions: PerceptionLine[];
  perception_total: number;
  warnings: string[];
}

export interface PreviewItem {
  product_id: string | null;
  variant_id?: string | null;
  quantity: number;
  unit_price: number;
  discount?: number;
}

export interface IvaReport {
  from: string;
  to: string;
  sales: number;
  sales_without_breakdown: number;
  total: number;
  net_taxed: number;
  net_exempt: number;
  net_untaxed: number;
  iva_total: number;
  internal_total: number;
  perception_total: number;
  by_rate: { code: IvaCode; label: string; arca_id: number; base: number; amount: number; sales: number }[];
  perceptions: { tax: string; jurisdiction: string | null; name: string | null; base: number; amount: number; sales: number }[];
  by_letter: { letter: string; sales: number; total: number }[];
  by_store: { store_id: string; name: string | null; net_taxed: number; iva: number; perceptions: number; total: number }[];
}

export interface RetentionSuggestion {
  kind: RegimeTax;
  description: string;
  amount: number;
  base: number;
  rate: number;
  jurisdiction: string | null;
  source: string;
}

// ---------------------------------------------------------------------------
// Retenciones como agente (ADR-079)
// ---------------------------------------------------------------------------
export interface RetConceptEff {
  tax: "ganancias" | "suss";
  code: string;
  name: string;
  valid_from: string;
  min_non_taxable: number;
  rate_registered: number | null;
  rate_unregistered: number | null;
  uses_scale: boolean;
  scale_code: string | null;
  min_withholding: number;
  sicore_tax_code: number | null;
  sicore_regime_code: string | null;
  is_active: boolean;
  overridden: boolean;
  source: string;
  verify: boolean;
  notes: string | null;
}

export interface RetConceptSetting {
  id: string;
  tax: "ganancias" | "suss";
  code: string;
  is_active: boolean;
  min_non_taxable: number | null;
  rate_registered: number | null;
  rate_unregistered: number | null;
  min_withholding: number | null;
  sicore_regime_code: string | null;
  notes: string | null;
}

export interface SupplierTaxProfile {
  id: string;
  supplier_id: string;
  ganancias_condition: GananciasCondition | null;
  ganancias_concept: string | null;
  suss_code: string | null;
}

export interface RetentionOptions {
  ganancias_concept?: string | null;
  ganancias_condition?: GananciasCondition | null;
  suss_code?: string | null;
}

export type PreviewLine = RetLine & { concept_name: string | null; agent_number: string | null };

export interface RetentionPreview {
  lines: PreviewLine[];
  total: number;
  bases: { net: number; net_taxed: number; total: number; vat: number };
  supplier: {
    id: string;
    name: string;
    cuit: string | null;
    iva_condition: string | null;
    ganancias_condition: GananciasCondition | null;
    ganancias_concept: string | null;
    suss_code: string | null;
    has_profile: boolean;
  };
  warnings: string[];
  date: string;
}

export type WithholdingRecord = CertificateRow &
  WithholdingExportRow & {
    payment_id: string;
    supplier_id: string;
    supplier_name?: string;
    reason: string;
    certificate_number: number | null;
    created_at: string;
    voided_at: string | null;
    void_reason: string | null;
  };

const NUMERIC_WH = [
  "payment_total",
  "payment_base",
  "prior_base",
  "accumulated_base",
  "non_taxable_min",
  "taxable_base",
  "month_total",
  "prior_withheld",
  "exemption_pct",
  "amount",
] as const;

function normWithholding(r: Record<string, unknown>): WithholdingRecord {
  const out: Record<string, unknown> = { ...r };
  for (const k of NUMERIC_WH) out[k] = r[k] == null ? 0 : Number(r[k]);
  out.rate = r.rate == null ? null : Number(r.rate);
  return out as unknown as WithholdingRecord;
}

const LINE_NUMS = [
  "amount",
  "base",
  "exemption_pct",
  "prior_base",
  "accumulated_base",
  "non_taxable_min",
  "taxable_base",
  "month_total",
  "prior_withheld",
  "computed",
  "min_withholding",
] as const;

function normLine(l: Record<string, unknown>): PreviewLine {
  const out: Record<string, unknown> = { ...l };
  for (const k of LINE_NUMS) out[k] = Number(l[k] ?? 0);
  out.rate = l.rate == null ? null : Number(l.rate);
  return out as unknown as PreviewLine;
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const nn = (v: unknown) => (v == null ? null : Number(v));

function normRegime(r: Record<string, unknown>): TaxRegime {
  return {
    ...(r as unknown as TaxRegime),
    default_rate: nn(r.default_rate),
    min_base: n(r.min_base),
    min_amount: n(r.min_amount),
    rates_by_condition: Object.fromEntries(
      Object.entries((r.rates_by_condition ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v)]),
    ),
    applies_to: (r.applies_to as string[]) ?? [],
  };
}

const REGIME_COLS =
  "id, tax, role, jurisdiction, name, is_active, agent_number, regime_code, padron_source, default_rate, rates_by_condition, base_kind, min_base, min_amount, applies_to, notes";

export const taxApi = {
  settings: async (): Promise<TaxSettings> => {
    const r = await loose().rpc<TaxSettings>("tax_settings_get");
    return check(r);
  },

  saveSettings: async (p: Partial<TaxSettings>): Promise<TaxSettings> => {
    const r = await loose().rpc<TaxSettings>("tax_settings_save", { p });
    return check(r);
  },

  regimes: async (): Promise<TaxRegime[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<Record<string, unknown>[]>("tax_regimes")
      .select(REGIME_COLS)
      .eq("tenant_id", t)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (r.error) return [];
    return (r.data ?? []).map(normRegime);
  },

  saveRegime: async (v: { id?: string } & TaxRegimeInput): Promise<void> => {
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    const { id, ...row } = v;
    const r = id
      ? await loose().from("tax_regimes").update(row).eq("id", id).eq("tenant_id", t)
      : await loose().from("tax_regimes").insert({ ...row, tenant_id: t });
    check(r);
  },

  deleteRegime: async (id: string): Promise<void> => {
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    check(await loose().from("tax_regimes").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("tenant_id", t));
  },

  padronImports: async (): Promise<PadronImport[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<PadronImport[]>("tax_padron_imports")
      .select("id, jurisdiction, format, kind, file_name, only_known, period_from, period_to, rows_loaded, rows_skipped, rows_error, status, created_at, finished_at")
      .eq("tenant_id", t)
      .order("created_at", { ascending: false })
      .limit(30);
    if (r.error) return [];
    return r.data ?? [];
  },

  padronStart: async (p: {
    jurisdiction: string;
    format: PadronFormat;
    kind: PadronImport["kind"];
    file_name: string;
    only_known: boolean;
  }): Promise<string> => check(await loose().rpc<string>("tax_padron_import_start", { p })),

  padronRows: async (importId: string, rows: PadronRow[]): Promise<number> => {
    // Un mismo CUIT y vigencia dos veces en la tanda rompería el upsert: se unen.
    const merged = new Map<string, Omit<PadronRow, "name">>();
    for (const { name: _n, ...r } of rows) {
      const k = `${r.cuit}|${r.valid_from}`;
      const prev = merged.get(k);
      merged.set(k, prev ? { ...prev, ...r, perception_rate: r.perception_rate ?? prev.perception_rate, retention_rate: r.retention_rate ?? prev.retention_rate } : r);
    }
    return check(
      await loose().rpc<number>("tax_padron_import_rows", { p_import: importId, p_rows: [...merged.values()] }),
    );
  },

  padronFinish: async (
    importId: string,
    p: { rows_skipped: number; rows_error: number; period_from: string | null; period_to: string | null },
  ): Promise<PadronImport> => check(await loose().rpc<PadronImport>("tax_padron_import_finish", { p_import: importId, p })),

  padronDelete: async (importId: string): Promise<void> => {
    check(await loose().rpc("tax_padron_import_delete", { p_import: importId }));
  },

  padronLookup: async (cuit: string) =>
    check(
      await loose().rpc<
        { jurisdiction: string; name: string; perception_rate: number | null; retention_rate: number | null }[]
      >("tax_padron_lookup", { p_cuit: cuit }),
    ) ?? [],

  /** CUIT de clientes y proveedores (para subir sólo lo que se usa del padrón). */
  knownCuits: async (): Promise<Set<string>> => {
    const t = await getCurrentTenantId();
    const out = new Set<string>();
    if (!t) return out;
    const c = await loose()
      .from<{ document_number: string | null }[]>("customers")
      .select("document_number")
      .eq("tenant_id", t)
      .in("document_type", ["cuit", "cuil"]);
    for (const r of c.data ?? []) {
      const d = String(r.document_number ?? "").replace(/\D/g, "");
      if (d.length === 11) out.add(d);
    }
    const s = await loose().from<{ cuit: string | null }[]>("suppliers").select("cuit").eq("tenant_id", t);
    for (const r of s.data ?? []) if (r.cuit) out.add(r.cuit);
    return out;
  },

  exemptions: async (party: "customer" | "supplier", partyId: string): Promise<TaxExemption[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<TaxExemption[]>("tax_exemptions")
      .select("id, party, party_id, tax, jurisdiction, pct, valid_from, valid_to, certificate")
      .eq("tenant_id", t)
      .eq("party", party)
      .eq("party_id", partyId)
      .is("deleted_at", null)
      .order("valid_from", { ascending: false });
    if (r.error) return [];
    return (r.data ?? []).map((e) => ({ ...e, pct: Number(e.pct) }));
  },

  addExemption: async (v: Omit<TaxExemption, "id">): Promise<void> => {
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    check(await loose().from("tax_exemptions").insert({ ...v, tenant_id: t }));
  },

  removeExemption: async (id: string): Promise<void> => {
    check(await loose().from("tax_exemptions").update({ deleted_at: new Date().toISOString() }).eq("id", id));
  },

  preview: async (items: PreviewItem[], total: number, customerId: string | null): Promise<SaleTaxPreview> =>
    check(
      await loose().rpc<SaleTaxPreview>("sale_tax_preview", {
        p_items: items,
        p_total: total,
        p_customer: customerId,
      }),
    ),

  saleTaxLines: async (saleId: string) => {
    const r = await loose()
      .from<
        { kind: string; tax: string; jurisdiction: string | null; rate_code: string | null; rate: number | null; base: number; amount: number; name: string | null }[]
      >("sale_tax_lines")
      .select("kind, tax, jurisdiction, rate_code, rate, base, amount, name")
      .eq("sale_id", saleId);
    if (r.error) return [];
    return (r.data ?? []).map((l) => ({ ...l, base: Number(l.base), amount: Number(l.amount), rate: nn(l.rate) }));
  },

  ivaReport: async (from: string, to: string, storeId: string | null): Promise<IvaReport> =>
    check(await loose().rpc<IvaReport>("report_iva_ventas", { p_from: from, p_to: to, p_store: storeId })),

  // --- Retenciones como agente (ADR-079) ---------------------------------
  retentionPreview: async (p: {
    supplier_id: string;
    allocations: { invoice_id: string; amount: number }[];
    amount: number;
    date: string;
    options?: RetentionOptions;
  }): Promise<RetentionPreview> => {
    const r = check(await loose().rpc<RetentionPreview>("tax_retention_preview", { p }));
    return {
      ...r,
      total: Number(r.total),
      lines: (r.lines ?? []).map((l) => normLine(l as unknown as Record<string, unknown>)),
    };
  },

  retConcepts: async (): Promise<RetConceptEff[]> => {
    const r = await loose().rpc<RetConceptEff[]>("tax_ret_concepts_list", {});
    if (r.error) return [];
    return (r.data ?? []).map((c) => ({
      ...c,
      min_non_taxable: Number(c.min_non_taxable),
      rate_registered: c.rate_registered == null ? null : Number(c.rate_registered),
      rate_unregistered: c.rate_unregistered == null ? null : Number(c.rate_unregistered),
      min_withholding: Number(c.min_withholding),
    }));
  },

  retConceptSettings: async (): Promise<RetConceptSetting[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<RetConceptSetting[]>("tax_ret_concept_settings")
      .select(
        "id, tax, code, is_active, min_non_taxable, rate_registered, rate_unregistered, min_withholding, sicore_regime_code, notes",
      )
      .eq("tenant_id", t);
    if (r.error) return [];
    return r.data ?? [];
  },

  saveRetConceptSetting: async (v: Omit<RetConceptSetting, "id"> & { id?: string | null }): Promise<void> => {
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    const { id, ...row } = v;
    check(
      id
        ? await loose().from("tax_ret_concept_settings").update(row).eq("id", id).eq("tenant_id", t)
        : await loose().from("tax_ret_concept_settings").insert({ ...row, tenant_id: t }),
    );
  },

  supplierTaxProfile: async (supplierId: string): Promise<SupplierTaxProfile | null> => {
    const t = await getCurrentTenantId();
    if (!t) return null;
    const r = await loose()
      .from<SupplierTaxProfile[]>("supplier_tax_profiles")
      .select("id, supplier_id, ganancias_condition, ganancias_concept, suss_code")
      .eq("tenant_id", t)
      .eq("supplier_id", supplierId)
      .limit(1);
    if (r.error) return null;
    return r.data?.[0] ?? null;
  },

  withholdingsList: async (from: string, to: string): Promise<WithholdingRecord[]> => {
    const r = check(await loose().rpc<Record<string, unknown>[]>("tax_withholdings_list", { p_from: from, p_to: to }));
    return (r ?? []).map(normWithholding);
  },

  withholdingsOfPayment: async (paymentId: string): Promise<WithholdingRecord[]> => {
    const r = await loose()
      .from<Record<string, unknown>[]>("tax_withholdings")
      .select("*")
      .eq("payment_id", paymentId)
      .order("created_at", { ascending: true });
    if (r.error) return [];
    return (r.data ?? []).map(normWithholding).filter((w) => w.amount > 0);
  },

  withholdingsExport: async (
    period: string,
    format: "sicore" | "arba",
  ): Promise<{ period: string; agent: ExportAgent; rows: WithholdingExportRow[] }> => {
    const r = check(
      await loose().rpc<{ period: string; agent: ExportAgent; rows: Record<string, unknown>[] }>(
        "tax_withholdings_export",
        { p_period: period, p_format: format },
      ),
    );
    return { ...r, rows: (r.rows ?? []).map(normWithholding) };
  },

  retentionSuggest: async (
    supplierId: string,
    allocations: { invoice_id: string; amount: number }[],
    amount: number,
  ): Promise<RetentionSuggestion[]> =>
    check(
      await loose().rpc<RetentionSuggestion[]>("tax_retention_suggest", {
        p_supplier: supplierId,
        p_allocations: allocations,
        p_amount: amount,
      }),
    ) ?? [],
};

/** Mensaje en castellano para los errores del servidor. */
export function taxErrorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  const ret = retentionErrorMessage(m);
  if (ret) return ret;
  if (m.includes("tax_ret_concept_settings_key")) return "Ese concepto ya tiene un ajuste: editalo.";
  if (m.includes("feature_not_in_plan: percepciones_retenciones"))
    return "Percepciones y retenciones vienen desde el plan Business.";
  if (m.includes("feature_not_in_plan: impuestos_internos")) return "Impuestos internos vienen desde el plan Pro.";
  if (m.includes("feature_not_in_plan: impuestos_iva")) return "Tu plan no incluye la configuración de IVA.";
  if (m.includes("forbidden")) return "Sólo el dueño o un encargado pueden cambiar esto.";
  if (m.includes("invalid_cuit")) return "El CUIT no es válido (revisá el dígito verificador).";
  if (m.includes("invalid_dni")) return "El DNI tiene que tener 7 u 8 dígitos.";
  if (m.includes("invalid_tax_rate")) return "Alícuota de IVA inválida.";
  if (m.includes("tax_regimes_unique")) return "Ya hay un régimen igual para ese impuesto y jurisdicción.";
  if (m.includes("tax_regimes_padron_check")) return "El padrón de ARBA es de Buenos Aires y el de AGIP de CABA.";
  if (m.includes("tax_regimes_jurisdiction_check")) return "IIBB necesita jurisdicción; IVA, Ganancias y SUSS no.";
  if (m.includes("format_jurisdiction_mismatch")) return "El formato del padrón no corresponde a esa jurisdicción.";
  if (m.includes("invalid_rows")) return "El archivo tiene filas inválidas (CUIT, fechas o alícuotas).";
  if (m.includes("period_too_long")) return "Elegí un período de hasta 400 días.";
  return "No se pudo completar. Probá de nuevo.";
}
