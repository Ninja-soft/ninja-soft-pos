"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { presetsApi } from "./api";
import type { PresetKey, SellsMode } from "./presets";
import { servicesApi } from "@/modules/services/api";
import { CATALOG_MODE_KEY } from "@/modules/services/hooks";

// Aplica un preset de rubro y refresca productos/categorías/onboarding para que
// la grilla rápida del POS (H36) y el checklist reflejen el catálogo sembrado.
export function useApplyPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { preset: PresetKey; sells: SellsMode; seedCatalog: boolean }) => {
      const out = await presetsApi.apply(v.preset, v.sells, v.seedCatalog);
      // ADR-116: lo que vende el negocio define el vocabulario del catálogo
      // ("Servicios", "Productos y servicios"). Sin la migración, sigue igual.
      await servicesApi
        .setCatalogMode(v.sells === "ambos" ? "mixto" : v.sells)
        .catch(() => undefined);
      return out;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATALOG_MODE_KEY });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["pos-settings"] });
      qc.invalidateQueries({ queryKey: ["onboarding-status"] });
      qc.invalidateQueries({ queryKey: ["preset-samples"] });
      // Los presets gastronómicos prenden dining/delivery: refrescar el nav.
      qc.invalidateQueries({ queryKey: ["dining", "enabled"] });
      qc.invalidateQueries({ queryKey: ["delivery", "enabled"] });
    },
  });
}

// ¿Cuántos productos de muestra (sembrados por presets) tiene el catálogo?
// Gatea el botón "Borrar productos de prueba" de la card de Rubro.
export function usePresetSampleCount() {
  return useQuery({
    queryKey: ["preset-samples", "count"],
    queryFn: () => presetsApi.sampleCount(),
    staleTime: 30_000,
  });
}

// Da de baja (lógica) todos los productos de muestra del tenant.
export function useDeletePresetSamples() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => presetsApi.deleteSamples(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["preset-samples"] });
    },
  });
}
