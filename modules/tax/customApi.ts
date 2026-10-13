import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { CustomCatalog, CustomValue, HistoryEntry, ScaleRow } from "@/lib/tax/custom";
import type { PadronProfile, PadronProfileConfig } from "@/lib/tax/padronProfile";

// Valores impositivos del negocio (ADR-105). Tablas y RPC fuera de
// types/database.ts (no se regenera en este PR): cliente suelto, como
// modules/tax/api.ts. La base valida todo (RPC, RLS, triggers y gating).
type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  insert: (row: Record<string, unknown> | Record<string, unknown>[]) => Q<T>;
  update: (row: Record<string, unknown>) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  is: (col: string, v: null) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
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

export interface CustomSaveInput {
  id?: string | null;
  catalog: CustomCatalog;
  item_key: string;
  valid_from: string;
  valid_to?: string | null;
  is_active?: boolean;
  is_custom?: boolean;
  data: Record<string, unknown>;
  notes?: string | null;
}

export interface TaxParameterTemplate {
  key: string;
  valid_from: string;
  value: number;
  note: string | null;
}

export interface ScaleInfo {
  scale_code: string;
  customized: boolean;
  custom: ScaleRow[] | null;
  template: ScaleRow[];
}

const nums = (r: ScaleRow) => ({
  from_amount: Number(r.from_amount),
  to_amount: r.to_amount == null ? null : Number(r.to_amount),
  fixed: Number(r.fixed ?? 0),
  rate: Number(r.rate),
});

export const taxCustomApi = {
  /** Versiones vigentes (no borradas) del negocio. */
  values: async (): Promise<CustomValue[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<CustomValue[]>("tax_custom_values")
      .select("id, catalog, item_key, valid_from, valid_to, is_active, is_custom, data, notes, created_at, updated_at")
      .eq("tenant_id", t)
      .is("deleted_at", null)
      .order("valid_from", { ascending: false });
    if (r.error) return [];
    return r.data ?? [];
  },

  save: async (p: CustomSaveInput): Promise<string> => check(await loose().rpc<string>("tax_custom_save", { p })),

  remove: async (id: string): Promise<void> => {
    check(await loose().rpc("tax_custom_delete", { p_id: id }));
  },

  reset: async (catalog: CustomCatalog, itemKey: string): Promise<number> =>
    check(await loose().rpc<number>("tax_custom_reset", { p_catalog: catalog, p_item_key: itemKey })),

  history: async (catalog: string, itemKey: string): Promise<HistoryEntry[]> =>
    check(await loose().rpc<HistoryEntry[]>("tax_custom_history", { p_catalog: catalog, p_item_key: itemKey })) ?? [],

  /** Plantilla de los parámetros (la vigente hoy de cada clave). */
  parameterTemplates: async (): Promise<Record<string, TaxParameterTemplate>> => {
    const r = await loose()
      .from<TaxParameterTemplate[]>("tax_parameters")
      .select("key, valid_from, value, note")
      .order("valid_from", { ascending: false });
    const out: Record<string, TaxParameterTemplate> = {};
    const today = new Date().toISOString().slice(0, 10);
    for (const p of r.data ?? []) {
      if (p.valid_from > today || out[p.key]) continue;
      out[p.key] = { ...p, value: Number(p.value) };
    }
    return out;
  },

  scale: async (code: string): Promise<ScaleInfo> => {
    const r = check(await loose().rpc<ScaleInfo>("tax_ret_scale_get", { p_scale: code }));
    return {
      ...r,
      custom: r.custom ? r.custom.map(nums) : null,
      template: (r.template ?? []).map(nums),
    };
  },

  // --- Perfiles de padrón ------------------------------------------------
  profiles: async (): Promise<PadronProfile[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<(PadronProfile & { id: string })[]>("tax_padron_profiles")
      .select("id, name, jurisdiction, kind, config")
      .eq("tenant_id", t)
      .is("deleted_at", null)
      .order("name", { ascending: true });
    if (r.error) return [];
    return r.data ?? [];
  },

  saveProfile: async (p: {
    id?: string;
    name: string;
    jurisdiction: string;
    kind: PadronProfile["kind"];
    config: PadronProfileConfig;
  }): Promise<string> => {
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    const row = { name: p.name, jurisdiction: p.jurisdiction, kind: p.kind, config: p.config };
    if (p.id) {
      check(await loose().from("tax_padron_profiles").update(row).eq("id", p.id).eq("tenant_id", t));
      return p.id;
    }
    const r = check(
      await loose().from<{ id: string }[]>("tax_padron_profiles").insert({ ...row, tenant_id: t }).select("id"),
    );
    return r?.[0]?.id ?? "";
  },

  removeProfile: async (id: string): Promise<void> => {
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    check(
      await loose().from("tax_padron_profiles").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("tenant_id", t),
    );
  },

  manualRate: async (p: {
    jurisdiction: string;
    cuit: string;
    perception_rate: number | null;
    retention_rate: number | null;
    valid_from: string;
    valid_to: string;
  }): Promise<string> => check(await loose().rpc<string>("tax_padron_manual_set", { p })),
};
