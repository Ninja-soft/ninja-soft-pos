"use client";

// Listas de precios PRO (F18 · H100, ADR-058). Las tablas y RPC nuevas no
// están en los tipos generados (no se regeneran): se castean. Las listas del
// panel filtran por el negocio actual además de la RLS (ADR-052).

import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { withPriceSource } from "@/lib/prices/priceSource";
import type { RoundingRule } from "@/lib/prices/rounding";
import type {
  FxRateLike,
  ListCostBasis,
  ListKind,
  MarkupMode,
  PaymentTermLike,
  PriceScheduleLike,
  PricingTax,
  PricingWorld,
  ProPriceItem,
  ProPriceList,
  ProductCostsLike,
  ProductTaxLike,
  QtyBreak,
} from "@/lib/prices/resolve";
import type { BulkPreviewRow, TermRateMode } from "@/lib/prices/bulk";
import type { BulkFlag, BulkV2Mode, RepriceMode, UtilityMode } from "@/lib/prices/costing";
import type { PriceChannel } from "./api";

// Filas y respuestas de RPC fuera de los tipos generados.
// eslint-disable-next-line
type Any = any;
const db = () => createClient() as unknown as Any;

export type FxSource = "oficial" | "mep" | "bna" | "manual";

export const FX_SOURCES: { value: FxSource; label: string }[] = [
  { value: "oficial", label: "Dólar oficial" },
  { value: "bna", label: "BNA vendedor" },
  { value: "mep", label: "Dólar MEP" },
  { value: "manual", label: "Manual" },
];

export const LIST_KINDS: { value: ListKind; label: string; hint: string }[] = [
  { value: "fixed", label: "Fija", hint: "Porcentaje o monto sobre el precio de venta, con precios fijos por producto." },
  { value: "derived", label: "Derivada", hint: "Sale de otra lista con un porcentaje o un monto." },
  { value: "cost", label: "Sobre costo", hint: "Costo del producto con markup o margen objetivo." },
  { value: "currency", label: "Moneda extranjera", hint: "Precios en dólares (u otra moneda) convertidos con la cotización del día." },
];

export const COST_BASES: { value: ListCostBasis; label: string }[] = [
  { value: "cost", label: "Costo del producto" },
  { value: "replacement", label: "Costo de reposición" },
  { value: "average", label: "Costo promedio" },
  { value: "last", label: "Último costo" },
  { value: "final", label: "Costo final (con flete e impuestos)" },
];

export interface ProList extends ProPriceList {
  name: string;
  channel: PriceChannel;
  kind: ListKind;
  notes?: string | null;
  deleted_at?: string | null;
}

export type ProListInput = {
  name: string;
  channel: PriceChannel;
  adjustment_pct: number | null;
  adjustment_amount?: number | null;
  kind?: ListKind;
  base_list_id?: string | null;
  cost_basis?: ListCostBasis | null;
  markup_mode?: MarkupMode | null;
  markup_value?: number | null;
  currency?: string | null;
  fx_source?: FxSource | null;
  rounding?: RoundingRule | null;
  min_margin_pct?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  pos_selectable?: boolean;
  /** ADR-068: false = precios netos (sin IVA). */
  prices_include_tax?: boolean;
  notes?: string | null;
};

export interface PriceSettings {
  mode: "simple" | "pro";
  require_approval: boolean;
  label_queue: boolean;
  pro: boolean;
  /** ADR-140: piso global de margen sobre el costo final (PRO, sólo el dueño). */
  floor_margin_pct: number | null;
  /** ADR-140: fuente del dólar por defecto. */
  fx_source: FxSource;
  /** ADR-140: el plan tiene precios_usd. */
  usd: boolean;
  /** ADR-140: el plan tiene costo_final (BASE). */
  final_cost: boolean;
}

export const DEFAULT_PRICE_SETTINGS: PriceSettings = {
  mode: "simple",
  require_approval: false,
  label_queue: true,
  pro: false,
  floor_margin_pct: null,
  fx_source: "oficial",
  usd: false,
  final_cost: true,
};

// ── ADR-140: cotización, asistente v2 y regla automática ─────────────────────

export interface FxQuote {
  rate: number | null;
  rate_date: string | null;
  origin: "negocio" | "plataforma" | null;
  source: FxSource;
}

export interface BulkV2Scope {
  category_ids?: string[];
  brand_ids?: string[];
  supplier_ids?: string[];
  tag?: string | null;
  product_ids?: string[];
  usd_only?: boolean;
  include_inactive?: boolean;
}

export interface BulkV2Request {
  mode: BulkV2Mode;
  value?: number;
  markup_mode?: UtilityMode;
  reprice?: RepriceMode;
  targets: { base: boolean; list_ids: string[] };
  scope: BulkV2Scope;
  rounding?: RoundingRule | null;
  fx?: { source?: FxSource; rate?: number | null } | null;
  effective_at?: string | null;
  reason?: string | null;
}

export interface BulkV2Row {
  product_id: string;
  variant_id: string | null;
  list_id: string | null;
  list_name?: string | null;
  name: string;
  sku: string | null;
  image_url: string | null;
  old_price: number;
  new_price: number;
  old_cost: number | null;
  new_cost: number | null;
  final_cost: number | null;
  margin_pct: number | null;
  flags: BulkFlag[];
}

export interface BulkV2Preview {
  count: number;
  products: number;
  usd_products: number;
  fx: { rate: number; rate_date: string; origin: string; source: string } | null;
  before: number;
  after: number;
  price_changes: number;
  cost_changes: number;
  below_cost: number;
  below_floor: number;
  low_margin: number;
  skipped: number;
  rows: BulkV2Row[];
}

export interface FxRule {
  id: string;
  name: string;
  is_active: boolean;
  threshold_pct: number;
  fx_source: FxSource;
  request: Omit<BulkV2Request, "mode" | "fx" | "effective_at">;
  require_approval: boolean;
  last_rate: number | null;
  last_rate_date: string | null;
  last_checked_at: string | null;
  last_batch_id: string | null;
  last_result: string | null;
}

function nn(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function normalizeV2Row(r: Any): BulkV2Row {
  return {
    ...r,
    old_price: num(r.old_price),
    new_price: num(r.new_price),
    old_cost: nn(r.old_cost),
    new_cost: nn(r.new_cost),
    final_cost: nn(r.final_cost),
    margin_pct: nn(r.margin_pct),
    flags: (r.flags ?? []) as BulkFlag[],
  };
}

export interface PaymentTerm extends PaymentTermLike {
  rate_mode: TermRateMode;
  monthly_rate: number | null;
  sort: number;
}

export interface Assignment {
  id: string;
  price_list_id: string;
  scope: "customer" | "customer_group" | "store" | "store_group";
  scope_id: string;
}

export interface BulkScope {
  category_id?: string | null;
  brand_id?: string | null;
  supplier_id?: string | null;
  tag?: string | null;
  product_ids?: string[];
}

export type BulkIndex =
  | { kind: "fx"; currency: string; source: FxSource; from: string; to?: string | null; cap_pct?: number | null }
  | { kind: "index"; key: string; from: string; to?: string | null; cap_pct?: number | null };

export interface BulkRequest {
  mode: "pct" | "amount" | "index";
  value?: number;
  index?: BulkIndex;
  list_id?: string | null;
  scope: BulkScope;
  rounding?: RoundingRule | null;
  effective_at?: string | null;
  reason?: string | null;
}

export interface BulkPreview {
  count: number;
  pct: number | null;
  before: number;
  after: number;
  below_cost: number;
  rows: BulkPreviewRow[];
}

export interface BulkBatch {
  id: string;
  target_list_id: string | null;
  scope: BulkScope & BulkV2Scope;
  mode: "pct" | "amount" | "index" | BulkV2Mode;
  /** ADR-140: 2 = asistente con costos, varias listas y dólar. */
  engine?: number;
  origin?: "manual" | "auto";
  list_ids?: string[] | null;
  fx_rate?: number | null;
  fx_rate_date?: string | null;
  options?: { targets?: { base?: boolean; list_ids?: string[] }; reprice?: RepriceMode; markup_mode?: UtilityMode } | null;
  value: number;
  index_info: (BulkIndex & { pct?: number }) | null;
  effective_at: string | null;
  status: "pending_approval" | "scheduled" | "applied" | "rejected" | "reverted";
  reason: string | null;
  line_count: number;
  created_by: string | null;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  applied_at: string | null;
  reverted_at: string | null;
}

export interface FxRate extends FxRateLike {
  id: string;
}

export interface IndexValue {
  id: string;
  index_key: string;
  period: string;
  value: number;
}

export interface ProductPricesOverview {
  base: number;
  lists: {
    list_id: string;
    name: string;
    channel: string;
    kind: ListKind;
    is_active: boolean;
    valid: boolean;
    item_price: number | null;
    price: number | null;
  }[];
  upcoming: {
    id: string;
    list_id: string | null;
    list_name: string | null;
    variant_id: string | null;
    price: number;
    effective_at: string;
    status: string;
    batch_id: string | null;
  }[];
}

export interface LabelQueueRow {
  id: string;
  store_id: string;
  product_id: string;
  variant_id: string | null;
  list_id: string | null;
  old_price: number | null;
  new_price: number | null;
  source: string;
  created_at: string;
}

export interface PricingSnapshot extends PricingWorld {
  at: string;
  lists: ProList[];
  terms: PaymentTerm[];
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}

function normalizeSnapshot(raw: Any): PricingSnapshot {
  return {
    pro: Boolean(raw.pro),
    at: String(raw.at ?? new Date().toISOString()),
    lists: (raw.lists ?? []).map((l: Any) => ({
      ...l,
      adjustment_pct: l.adjustment_pct == null ? null : Number(l.adjustment_pct),
      adjustment_amount: l.adjustment_amount == null ? null : Number(l.adjustment_amount),
      markup_value: l.markup_value == null ? null : Number(l.markup_value),
      min_margin_pct: l.min_margin_pct == null ? null : Number(l.min_margin_pct),
    })),
    items: (raw.items ?? []).map((i: Any) => ({ ...i, price: num(i.price) })) as ProPriceItem[],
    schedules: (raw.schedules ?? []).map((s: Any) => ({ ...s, price: num(s.price) })) as PriceScheduleLike[],
    breaks: (raw.breaks ?? []).map((b: Any) => ({ ...b, min_qty: num(b.min_qty), value: num(b.value) })) as QtyBreak[],
    terms: (raw.terms ?? []).map((t: Any) => ({ ...t, surcharge_pct: num(t.surcharge_pct) })) as PaymentTerm[],
    fx: (raw.fx ?? []).map((r: Any) => ({ ...r, rate: num(r.rate) })) as FxRateLike[],
    costs: Object.fromEntries(
      Object.entries((raw.costs ?? {}) as Record<string, Any>).map(([k, c]) => [
        k,
        {
          cost: c.cost == null ? null : Number(c.cost),
          last_cost: c.last_cost == null ? null : Number(c.last_cost),
          avg_cost: c.avg_cost == null ? null : Number(c.avg_cost),
          replacement_cost: c.replacement_cost == null ? null : Number(c.replacement_cost),
          min_price: c.min_price == null ? null : Number(c.min_price),
          final_cost: c.final_cost == null ? null : Number(c.final_cost),
          iva_pct: c.iva_pct == null ? null : Number(c.iva_pct),
        } satisfies ProductCostsLike,
      ]),
    ),
    assigned: (raw.assigned ?? []) as (string | null)[],
    customerTermId: raw.customerTermId ?? null,
    tax: normalizeTax(raw.tax),
    floorMarginPct: raw.floorMarginPct == null ? null : Number(raw.floorMarginPct),
  };
}

// ADR-068: datos fiscales para llevar el precio a final (lista neta o internos).
function normalizeTax(raw: Any): PricingTax | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    discriminates: raw.discriminates !== false,
    internalEnabled: Boolean(raw.internalEnabled),
    products: Object.fromEntries(
      Object.entries((raw.products ?? {}) as Record<string, Any>).map(([k, p]) => [
        k,
        {
          rate_code: p.rate_code ?? "21",
          mode: p.mode ?? "none",
          base: p.base ?? "price",
          rate: p.rate == null ? null : Number(p.rate),
          amount: p.amount == null ? null : Number(p.amount),
          included: p.included !== false,
          cost: p.cost == null ? null : Number(p.cost),
          variants: p.variants ?? null,
        } satisfies ProductTaxLike,
      ]),
    ),
  };
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw error;
  return data as T;
}

async function tenantOrThrow(): Promise<string> {
  const t = await getCurrentTenantId();
  if (!t) throw new Error("no_tenant");
  return t;
}

export const priceProApi = {
  // ── Configuración ─────────────────────────────────────────────────────────
  settings: async (): Promise<PriceSettings> => {
    try {
      return { ...DEFAULT_PRICE_SETTINGS, ...(await rpc<PriceSettings>("price_settings_get")) };
    } catch {
      // Base sin la migración: modo simple.
      return DEFAULT_PRICE_SETTINGS;
    }
  },
  saveSettings: (p: Partial<Omit<PriceSettings, "pro" | "usd" | "final_cost">>) =>
    rpc<PriceSettings>("price_settings_save", { p }),

  // ── Dólar (ADR-140): del día o la última anterior, negocio o plataforma ────
  fxQuote: async (source: FxSource = "oficial"): Promise<FxQuote | null> => {
    try {
      const raw = await rpc<Any>("price_fx_quote", { p_date: null, p_source: source });
      return { rate: nn(raw?.rate), rate_date: raw?.rate_date ?? null, origin: raw?.origin ?? null, source };
    } catch {
      return null;
    }
  },

  // ── Asistente v2 (ADR-140) ────────────────────────────────────────────────
  bulkV2Preview: async (p: BulkV2Request): Promise<BulkV2Preview> => {
    const raw = await rpc<Any>("price_bulk_v2_preview", { p });
    return {
      count: num(raw.count),
      products: num(raw.products),
      usd_products: num(raw.usd_products),
      fx: raw.fx ? { ...raw.fx, rate: num(raw.fx.rate) } : null,
      before: num(raw.before),
      after: num(raw.after),
      price_changes: num(raw.price_changes),
      cost_changes: num(raw.cost_changes),
      below_cost: num(raw.below_cost),
      below_floor: num(raw.below_floor),
      low_margin: num(raw.low_margin),
      skipped: num(raw.skipped),
      rows: ((raw.rows ?? []) as Any[]).map(normalizeV2Row),
    };
  },
  bulkV2Create: (p: BulkV2Request) =>
    withPriceSource("bulk", () =>
      rpc<{ id: string; status: BulkBatch["status"]; count: number }>("price_bulk_v2_create", { p }),
    ),
  bulkLines: async (batchId: string): Promise<BulkV2Row[]> =>
    ((await rpc<Any[]>("price_bulk_lines_get", { p_batch: batchId })) ?? []).map(normalizeV2Row),

  // ── Regla automática por dólar (ADR-140) ──────────────────────────────────
  fxRules: async (): Promise<FxRule[]> => {
    const tenantId = await tenantOrThrow();
    const { data, error } = await db()
      .from("price_fx_rules")
      .select("*")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("created_at");
    if (error) return [];
    return ((data ?? []) as Any[]).map((r) => ({
      ...r,
      threshold_pct: num(r.threshold_pct),
      last_rate: nn(r.last_rate),
    }));
  },
  saveFxRule: (
    p: Partial<Omit<FxRule, "last_rate" | "last_rate_date" | "last_checked_at" | "last_batch_id" | "last_result">>,
  ) => rpc<string>("price_fx_rule_save", { p }),
  deleteFxRule: (id: string) => rpc<void>("price_fx_rule_delete", { p_id: id }),

  // ── Listas ────────────────────────────────────────────────────────────────
  lists: async (): Promise<ProList[]> => {
    const tenantId = await tenantOrThrow();
    const { data, error } = await db()
      .from("price_lists")
      .select("*")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("channel")
      .order("name");
    if (error) throw error;
    return (data ?? []) as ProList[];
  },
  createList: async (input: ProListInput): Promise<ProList> => {
    const tenantId = await tenantOrThrow();
    const { base_list_id, kind, ...rest } = input;
    // La derivada se crea fija y se le pone la madre después (el check exige madre).
    const { data, error } = await db()
      .from("price_lists")
      .insert({ ...rest, kind: kind === "derived" ? "fixed" : (kind ?? "fixed"), tenant_id: tenantId })
      .select("*")
      .single();
    if (error) throw error;
    if (kind === "derived") {
      const { error: e2 } = await db().from("price_lists").update({ kind, base_list_id }).eq("id", data.id);
      if (e2) throw e2;
    }
    return data as ProList;
  },
  updateList: async (id: string, patch: Partial<ProListInput> & { is_active?: boolean }): Promise<void> => {
    const tenantId = await tenantOrThrow();
    const { error } = await db().from("price_lists").update(patch).eq("id", id).eq("tenant_id", tenantId);
    if (error) throw error;
  },

  // ── Asignaciones ──────────────────────────────────────────────────────────
  assignments: async (): Promise<Assignment[]> => {
    const tenantId = await tenantOrThrow();
    const { data, error } = await db().from("price_list_assignments").select("*").eq("tenant_id", tenantId);
    if (error) return [];
    return (data ?? []) as Assignment[];
  },
  setAssignment: async (scope: Assignment["scope"], scopeId: string, listId: string | null): Promise<void> => {
    const tenantId = await tenantOrThrow();
    const { error: dErr } = await db()
      .from("price_list_assignments")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("scope", scope)
      .eq("scope_id", scopeId);
    if (dErr) throw dErr;
    if (!listId) return;
    const { error } = await db()
      .from("price_list_assignments")
      .insert({ tenant_id: tenantId, price_list_id: listId, scope, scope_id: scopeId });
    if (error) throw error;
  },

  // ── Escalas ───────────────────────────────────────────────────────────────
  breaks: async (listId: string): Promise<(QtyBreak & { id: string })[]> => {
    const { data, error } = await db().from("price_list_breaks").select("*").eq("price_list_id", listId).order("min_qty");
    if (error) throw error;
    return ((data ?? []) as Any[]).map((b) => ({ ...b, min_qty: num(b.min_qty), value: num(b.value) }));
  },
  addBreak: async (b: QtyBreak): Promise<void> => {
    const tenantId = await tenantOrThrow();
    const { error } = await db().from("price_list_breaks").insert({ ...b, tenant_id: tenantId });
    if (error) throw error;
  },
  removeBreak: async (id: string): Promise<void> => {
    const { error } = await db().from("price_list_breaks").delete().eq("id", id);
    if (error) throw error;
  },

  // ── Condiciones de pago ───────────────────────────────────────────────────
  terms: async (): Promise<PaymentTerm[]> => {
    const tenantId = await tenantOrThrow();
    const { data, error } = await db()
      .from("payment_terms")
      .select("*")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("sort")
      .order("days");
    if (error) return [];
    return ((data ?? []) as Any[]).map((t) => ({ ...t, surcharge_pct: num(t.surcharge_pct) }));
  },
  saveTerm: async (t: Partial<PaymentTerm> & { name: string; days: number; surcharge_pct: number }): Promise<void> => {
    const tenantId = await tenantOrThrow();
    const row = {
      name: t.name,
      days: t.days,
      surcharge_pct: t.surcharge_pct,
      rate_mode: t.rate_mode ?? "flat",
      monthly_rate: t.monthly_rate ?? null,
      is_active: t.is_active ?? true,
      sort: t.sort ?? 0,
    };
    const q = t.id
      ? db().from("payment_terms").update(row).eq("id", t.id).eq("tenant_id", tenantId)
      : db().from("payment_terms").insert({ ...row, tenant_id: tenantId });
    const { error } = await q;
    if (error) throw error;
  },
  removeTerm: async (id: string): Promise<void> => {
    const tenantId = await tenantOrThrow();
    const { error } = await db()
      .from("payment_terms")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) throw error;
  },
  setCustomerTerm: async (customerId: string, termId: string | null): Promise<void> => {
    const tenantId = await tenantOrThrow();
    const { error } = await db()
      .from("customers")
      .update({ payment_term_id: termId })
      .eq("id", customerId)
      .eq("tenant_id", tenantId);
    if (error) throw error;
  },

  // ── Cotizaciones e índices ────────────────────────────────────────────────
  fxRates: async (): Promise<FxRate[]> => {
    const tenantId = await tenantOrThrow();
    const { data, error } = await db()
      .from("fx_rates")
      .select("id, currency, source, rate_date, rate")
      .eq("tenant_id", tenantId)
      .order("rate_date", { ascending: false })
      .limit(120);
    if (error) return [];
    return ((data ?? []) as Any[]).map((r) => ({ ...r, rate: num(r.rate) }));
  },
  saveFxRate: async (r: { currency: string; source: FxSource; rate_date: string; rate: number }): Promise<void> => {
    const tenantId = await tenantOrThrow();
    const { error } = await db()
      .from("fx_rates")
      .upsert({ ...r, tenant_id: tenantId }, { onConflict: "tenant_id,currency,source,rate_date" });
    if (error) throw error;
  },
  indexValues: async (): Promise<IndexValue[]> => {
    const tenantId = await tenantOrThrow();
    const { data, error } = await db()
      .from("price_index_values")
      .select("id, index_key, period, value")
      .eq("tenant_id", tenantId)
      .order("period", { ascending: false })
      .limit(120);
    if (error) return [];
    return ((data ?? []) as Any[]).map((r) => ({ ...r, value: num(r.value) }));
  },
  saveIndexValue: async (r: { index_key: string; period: string; value: number }): Promise<void> => {
    const tenantId = await tenantOrThrow();
    const { error } = await db()
      .from("price_index_values")
      .upsert({ ...r, tenant_id: tenantId }, { onConflict: "tenant_id,index_key,period" });
    if (error) throw error;
  },
  /**
   * Cotización pública del día (dolarapi.com, sin credenciales). Es una ayuda
   * para cargar: el valor que manda es el que queda guardado en fx_rates.
   */
  fetchPublicUsd: async (source: Exclude<FxSource, "manual">): Promise<number | null> => {
    const path = source === "mep" ? "bolsa" : "oficial";
    try {
      const res = await fetch(`https://dolarapi.com/v1/dolares/${path}`, { cache: "no-store" });
      if (!res.ok) return null;
      const j = (await res.json()) as { venta?: number };
      return typeof j.venta === "number" && j.venta > 0 ? j.venta : null;
    } catch {
      return null;
    }
  },

  // ── Actualización masiva ──────────────────────────────────────────────────
  bulkPreview: async (p: BulkRequest): Promise<BulkPreview> => {
    const raw = await rpc<Any>("price_bulk_preview", { p });
    return {
      count: num(raw.count),
      pct: raw.pct == null ? null : Number(raw.pct),
      before: num(raw.before),
      after: num(raw.after),
      below_cost: num(raw.below_cost),
      rows: ((raw.rows ?? []) as Any[]).map((r) => ({
        ...r,
        old_price: num(r.old_price),
        new_price: num(r.new_price),
        cost: r.cost == null ? null : Number(r.cost),
      })),
    };
  },
  bulkCreate: (p: BulkRequest) =>
    withPriceSource("bulk", () => rpc<{ id: string; status: BulkBatch["status"]; count: number }>("price_bulk_create", { p })),
  bulkDecide: (id: string, approve: boolean, note?: string) =>
    rpc<{ id: string; status: string }>("price_bulk_decide", { p_batch: id, p_approve: approve, p_note: note ?? null }),
  bulkRevert: (id: string) =>
    rpc<{ reverted: number; skipped: number; cancelled: number; costs?: number }>("price_bulk_revert", { p_batch: id }),
  batches: async (): Promise<BulkBatch[]> => {
    const tenantId = await tenantOrThrow();
    const { data, error } = await db()
      .from("price_bulk_batches")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return [];
    return (data ?? []) as BulkBatch[];
  },

  // ── Programados ───────────────────────────────────────────────────────────
  applyDue: async (): Promise<number> => {
    try {
      return await rpc<number>("price_schedules_apply_due");
    } catch {
      return 0;
    }
  },
  scheduleSet: (p: { list_id: string | null; product_id: string; variant_id?: string | null; price: number; effective_at: string }) =>
    rpc<string>("price_schedule_set", { p }),
  scheduleCancel: (id: string) => rpc<void>("price_schedule_cancel", { p_id: id }),
  upcoming: async (): Promise<(PriceScheduleLike & { id: string; batch_id: string | null })[]> => {
    const tenantId = await tenantOrThrow();
    const { data, error } = await db()
      .from("price_schedules")
      .select("id, list_id, product_id, variant_id, price, effective_at, status, created_at, batch_id")
      .eq("tenant_id", tenantId)
      .in("status", ["scheduled", "pending"])
      .gt("effective_at", new Date().toISOString())
      .order("effective_at")
      .limit(500);
    if (error) return [];
    return ((data ?? []) as Any[]).map((s) => ({ ...s, price: num(s.price) }));
  },

  // ── Import ────────────────────────────────────────────────────────────────
  importList: (listId: string | null, rows: { product_id: string; variant_id?: string | null; price: number; effective_at?: string | null }[]) =>
    withPriceSource("import", () =>
      rpc<{ applied: number; scheduled: number; invalid: number }>("price_list_import", { p_list: listId, p_rows: rows }),
    ),

  // ── POS y ficha ───────────────────────────────────────────────────────────
  snapshot: async (storeId: string | null, customerId: string | null): Promise<PricingSnapshot | null> => {
    const { data, error } = await db().rpc("price_context_snapshot", { p_store: storeId, p_customer: customerId });
    if (error) {
      // Base sin la migración (PGRST202): el POS sigue con la lista mostrador.
      if (String(error.code) === "PGRST202" || /price_context_snapshot/.test(String(error.message))) return null;
      throw error;
    }
    return normalizeSnapshot(data);
  },
  productOverview: async (productId: string): Promise<ProductPricesOverview | null> => {
    const { data, error } = await db().rpc("product_prices_overview", { p_product: productId });
    if (error) return null;
    const raw = data as Any;
    return {
      base: num(raw.base),
      lists: ((raw.lists ?? []) as Any[]).map((l) => ({
        ...l,
        item_price: l.item_price == null ? null : Number(l.item_price),
        price: l.price == null ? null : Number(l.price),
      })),
      upcoming: ((raw.upcoming ?? []) as Any[]).map((s) => ({ ...s, price: num(s.price) })),
    };
  },

  // ── Etiquetas ─────────────────────────────────────────────────────────────
  labelQueue: async (storeId: string | null): Promise<LabelQueueRow[]> => {
    const tenantId = await tenantOrThrow();
    let q = db()
      .from("price_label_queue")
      .select("id, store_id, product_id, variant_id, list_id, old_price, new_price, source, created_at")
      .eq("tenant_id", tenantId)
      .is("printed_at", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (storeId) q = q.eq("store_id", storeId);
    const { data, error } = await q;
    if (error) return [];
    return ((data ?? []) as Any[]).map((r) => ({
      ...r,
      old_price: r.old_price == null ? null : Number(r.old_price),
      new_price: r.new_price == null ? null : Number(r.new_price),
    }));
  },
  markPrinted: (ids: string[]) => rpc<number>("price_labels_mark_printed", { p_ids: ids }),
};
