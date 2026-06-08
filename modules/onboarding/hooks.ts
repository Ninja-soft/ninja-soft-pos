"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { presetsApi } from "./api";
import type { PresetKey, SellsMode } from "./presets";

// Aplica un preset de rubro y refresca productos/categorías/onboarding para que
// la grilla rápida del POS (H36) y el checklist reflejen el catálogo sembrado.
export function useApplyPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { preset: PresetKey; sells: SellsMode }) =>
      presetsApi.apply(v.preset, v.sells),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["pos-settings"] });
      qc.invalidateQueries({ queryKey: ["onboarding-status"] });
    },
  });
}
