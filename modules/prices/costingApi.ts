"use client";

// Costos del producto (ADR-140): moneda, costo en dólares, componentes y
// utilidad objetivo. Escritura directa sobre products (RLS y role_write_guard
// de siempre); el trigger products_costing_usd valida, gatea (costo_final,
// precios_usd) y mantiene costo = USD × cotización y el costo final.

import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { CostCurrency, CostExtra, UtilityMode } from "@/lib/prices/costing";
import type { FxSource } from "./proApi";

// eslint-disable-next-line
type Any = any;

export interface CostingDraft {
  cost_currency: CostCurrency;
  /** Texto del input (coma o punto). */
  cost_usd: string;
  cost_fx_source: FxSource;
  cost_extras: CostExtra[];
  markup_mode: UtilityMode;
  markup_pct: string;
}

export const EMPTY_COSTING: CostingDraft = {
  cost_currency: "ARS",
  cost_usd: "",
  cost_fx_source: "oficial",
  cost_extras: [],
  markup_mode: "markup",
  markup_pct: "",
};

function numText(v: string): number | null {
  const t = v.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function costingFromProduct(p: unknown): CostingDraft {
  const x = (p ?? {}) as Any;
  return {
    cost_currency: x.cost_currency === "USD" ? "USD" : "ARS",
    cost_usd: x.cost_usd == null ? "" : String(Number(x.cost_usd)).replace(".", ","),
    cost_fx_source: (x.cost_fx_source as FxSource) ?? "oficial",
    cost_extras: Array.isArray(x.cost_extras)
      ? (x.cost_extras as Any[]).map((e) => ({ label: String(e.label ?? ""), type: e.type === "amount" ? "amount" : "pct", value: Number(e.value ?? 0) }))
      : [],
    markup_mode: x.markup_mode === "margin" ? "margin" : "markup",
    markup_pct: x.markup_pct == null ? "" : String(Number(x.markup_pct)).replace(".", ","),
  };
}

export function costingPatch(d: CostingDraft, rate: number | null) {
  const usd = d.cost_currency === "USD" ? numText(d.cost_usd) : null;
  return {
    cost_currency: d.cost_currency,
    cost_usd: usd,
    cost_fx_source: d.cost_currency === "USD" ? d.cost_fx_source : null,
    // Con la cotización que se ve en pantalla; sin cotización, el servidor toma la del día.
    cost_fx_rate: d.cost_currency === "USD" ? rate : null,
    cost_extras: d.cost_extras
      .filter((e) => Number.isFinite(Number(e.value)))
      .map((e) => ({ label: e.label.trim().slice(0, 60), type: e.type, value: Number(e.value) })),
    markup_mode: numText(d.markup_pct) == null ? null : d.markup_mode,
    markup_pct: numText(d.markup_pct),
  };
}

export function costingEquals(a: CostingDraft, b: CostingDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const costingApi = {
  save: async (productId: string, d: CostingDraft, rate: number | null): Promise<void> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) throw new Error("no_tenant");
    const { error } = await (createClient() as unknown as Any)
      .from("products")
      .update(costingPatch(d, rate))
      .eq("id", productId)
      .eq("tenant_id", tenantId);
    if (error) throw error;
  },
};
