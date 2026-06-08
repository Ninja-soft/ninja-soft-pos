"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Json } from "@/types/database";

// Catálogo de planes globales para el SELECTOR DEL REGISTRO. Es público (la
// policy plans_select es `using (true)` para anon y authenticated), así que se
// puede listar sin sesión iniciada (el flujo email elige plan antes de crear la
// cuenta). Se ordena SIEMPRE por `sort` (Start → Pro → Business → Enterprise).

export interface SignupPlan {
  key: string;
  name: string;
  secondaryName: string | null;
  imageUrl: string | null;
  icon: string | null;
  monthlyPriceArs: number;
  sort: number;
  trialDays: number;
  isRecommended: boolean;
  // limits.{limits,modules} crudo: lo usamos para derivar los "highlights" de la
  // tarjeta (límites de sucursales/usuarios/productos + módulos destacados).
  limits: PlanLimits | null;
}

export interface PlanLimits {
  limits?: Record<string, number | null> | null;
  modules?: Record<string, boolean> | null;
  support?: { level?: string } | null;
}

function asPlanLimits(raw: Json | null): PlanLimits | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as PlanLimits;
}

// Lee los planes globales activos ordenados por sort. staleTime alto: el set de
// planes cambia rara vez y no queremos refetch en cada paso del wizard.
export function useSignupPlans() {
  return useQuery({
    queryKey: ["signup", "plans"],
    queryFn: async (): Promise<SignupPlan[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("plans")
        .select(
          "key, name, secondary_name, image_url, icon, monthly_price_ars, sort, trial_days, is_recommended, limits",
        )
        .is("tenant_id", null)
        .eq("is_active", true)
        .order("sort")
        .order("monthly_price_ars");
      if (error) throw error;
      return (data ?? []).map((p) => ({
        key: p.key,
        name: p.name,
        secondaryName: p.secondary_name ?? null,
        imageUrl: p.image_url ?? null,
        icon: p.icon ?? null,
        monthlyPriceArs: Number(p.monthly_price_ars ?? 0),
        sort: p.sort ?? Number.MAX_SAFE_INTEGER,
        trialDays: Number(p.trial_days ?? 0),
        isRecommended: p.is_recommended === true,
        limits: asPlanLimits((p.limits ?? null) as Json | null),
      }));
    },
    staleTime: 5 * 60_000,
  });
}

// Precio mensual formateado sin decimales (ej. "$90.000"). Los planes usan
// montos redondos en ARS; los centavos sólo ensucian la tarjeta.
const arsCompact = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});

export function formatPlanPrice(value: number): string {
  return arsCompact.format(value);
}
