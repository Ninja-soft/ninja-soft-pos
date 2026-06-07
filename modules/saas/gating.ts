"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Json } from "@/types/database";

// ── Tipos del resumen de gating (RPC gating_summary) ────────────────────────

export type GatingLimitKey =
  | "max_stores"
  | "max_users"
  | "max_products"
  | "max_sales_per_month";

export interface GatingSummary {
  features: Record<string, boolean>;
  limits: Record<GatingLimitKey, number | null>;
  plan: { key: string; name: string } | null;
}

const EMPTY_SUMMARY: GatingSummary = {
  features: {},
  limits: {
    max_stores: null,
    max_users: null,
    max_products: null,
    max_sales_per_month: null,
  },
  plan: null,
};

// Normaliza el jsonb que devuelve la RPC a nuestra forma tipada (defensivo:
// si falta algo, cae a EMPTY_SUMMARY).
function parseSummary(raw: Json | null): GatingSummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SUMMARY;
  const obj = raw as Record<string, unknown>;
  const features: Record<string, boolean> = {};
  if (obj.features && typeof obj.features === "object") {
    for (const [k, v] of Object.entries(obj.features as Record<string, unknown>)) {
      features[k] = v === true;
    }
  }
  const limitsRaw = (obj.limits ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const plan =
    obj.plan && typeof obj.plan === "object"
      ? {
          key: String((obj.plan as Record<string, unknown>).key ?? ""),
          name: String((obj.plan as Record<string, unknown>).name ?? ""),
        }
      : null;
  return {
    features,
    limits: {
      max_stores: num(limitsRaw.max_stores),
      max_users: num(limitsRaw.max_users),
      max_products: num(limitsRaw.max_products),
      max_sales_per_month: num(limitsRaw.max_sales_per_month),
    },
    plan,
  };
}

// ── Hooks ───────────────────────────────────────────────────────────────────

// Resumen completo de gating del tenant actual (un solo round-trip). staleTime
// 60s: el gating cambia rara vez (upgrade de plan) y no vale la pena refetchear.
export function useGating() {
  return useQuery({
    queryKey: ["gating"],
    queryFn: async (): Promise<GatingSummary> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("gating_summary");
      if (error) throw error;
      return parseSummary(data as Json | null);
    },
    staleTime: 60_000,
  });
}

// ¿El tenant tiene acceso a la feature `key`? Mientras carga devuelve `true`
// (optimista — no parpadea el bloqueo). undefined hasta que hay datos.
export function useFeature(key: string): boolean | undefined {
  const { data } = useGating();
  if (!data) return undefined;
  return data.features[key] ?? false;
}

// Límite numérico efectivo de `key`. null = ilimitado o sin datos aún.
export function useLimit(key: GatingLimitKey): number | null {
  const { data } = useGating();
  return data?.limits[key] ?? null;
}

// ── Helper puro: primer plan que incluye una feature ─────────────────────────

export interface PlanForUpgrade {
  key: string;
  name: string;
  monthly_price_ars: number;
  sort: number | null;
  limits: { modules?: Record<string, unknown> | null } | null;
}

// Dada la lista de planes globales activos, devuelve el más accesible (menor
// sort, desempate por precio) cuyo `limits.modules[featureKey]` sea true.
// Devuelve null si ninguno la incluye. Puro y testeable.
export function firstPlanWithFeature(
  plans: PlanForUpgrade[],
  featureKey: string,
): PlanForUpgrade | null {
  const matching = plans.filter(
    (p) => p.limits?.modules?.[featureKey] === true,
  );
  if (matching.length === 0) return null;
  const sorted = [...matching].sort((a, b) => {
    const sa = a.sort ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sort ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return (a.monthly_price_ars ?? 0) - (b.monthly_price_ars ?? 0);
  });
  return sorted[0] ?? null;
}

// Catálogo de planes globales activos (para el UpgradeModal). Incluye limits
// para resolver firstPlanWithFeature client-side sin otro round-trip.
export function useGlobalPlansForUpgrade() {
  return useQuery({
    queryKey: ["gating", "global-plans"],
    queryFn: async (): Promise<PlanForUpgrade[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("plans")
        .select("key, name, monthly_price_ars, sort, limits")
        .is("tenant_id", null)
        .eq("is_active", true)
        .order("sort")
        .order("monthly_price_ars");
      if (error) throw error;
      return (data ?? []).map((p) => ({
        key: p.key,
        name: p.name,
        monthly_price_ars: Number(p.monthly_price_ars ?? 0),
        sort: p.sort ?? null,
        limits: (p.limits ?? null) as PlanForUpgrade["limits"],
      }));
    },
    staleTime: 5 * 60_000,
  });
}
