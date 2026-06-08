"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { catalogPriceApi, type PriceReference } from "./priceReference";

// ¿El tenant compró/recibió algún catálogo? Determina si mostramos el control de
// configuración y las flechas de precio. staleTime alto: cambia muy rara vez.
export function useHasCatalog() {
  return useQuery({
    queryKey: ["catalog", "has-purchase"],
    queryFn: () => catalogPriceApi.hasPurchasedCatalog(),
    staleTime: 5 * 60_000,
  });
}

// Lectura del toggle pos_settings.show_catalog_price_hints (default true). La
// columna aún no vive en los tipos generados (no se regeneran): select("*") + cast.
export function useCatalogHintSetting() {
  return useQuery({
    queryKey: ["catalog", "hint-setting"],
    queryFn: async (): Promise<boolean> => {
      const supabase = createClient();
      const { data } = await supabase
        .from("pos_settings")
        .select("*")
        .maybeSingle();
      const row =
        (data as unknown as { show_catalog_price_hints?: boolean } | null) ??
        null;
      // Default true cuando no hay fila o la columna viene null.
      return row?.show_catalog_price_hints ?? true;
    },
    staleTime: 60_000,
  });
}

// Decide en un solo lugar si se muestran las flechas de precio: el tenant compró
// un catálogo Y tiene la sugerencia activada en config. `ready` evita parpadeos
// (no mostramos nada hasta saber ambas cosas).
export function useCatalogHintsActive(): { active: boolean; ready: boolean } {
  const { data: hasCatalog, isSuccess: hasLoaded } = useHasCatalog();
  const { data: enabled, isSuccess: settingLoaded } = useCatalogHintSetting();
  const ready = hasLoaded && settingLoaded;
  return {
    active: Boolean(hasCatalog) && (enabled ?? true),
    ready,
  };
}

// Referencias de precio para los EANs visibles (batch, sin N+1). Sólo corre si
// `enabled` (flechas activas) y hay EANs. La key incluye los EANs ordenados para
// cachear por página visible.
export function useCatalogPriceReferences(
  eans: string[],
  enabled: boolean,
): { data: Map<string, PriceReference> | undefined; isLoading: boolean } {
  const clean = Array.from(
    new Set(eans.map((e) => (e ?? "").trim()).filter(Boolean)),
  ).sort();
  const q = useQuery({
    queryKey: ["catalog", "price-references", clean],
    queryFn: () => catalogPriceApi.referenceForEans(clean),
    enabled: enabled && clean.length > 0,
    staleTime: 60_000,
  });
  return { data: q.data, isLoading: q.isLoading };
}
