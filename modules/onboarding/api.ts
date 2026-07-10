import { createClient } from "@/lib/supabase/client";
import type { ApplyPresetResult, PresetKey, SellsMode } from "./presets";

// F12 · H35 — aplica un preset de rubro: la RPC SECURITY DEFINER siembra
// categorías + productos/servicios de muestra (favoritos) y, en alta limpia, los
// defaults del POS. Es idempotente y auditada server-side. `apply_industry_preset`
// aún no vive en los tipos generados (no se regeneran): casteamos el nombre y el
// resultado.
export const presetsApi = {
  apply: async (
    preset: PresetKey,
    sells: SellsMode,
    // false = el dueño NO quiere precargar productos de muestra: la RPC aplica
    // defaults del POS / suite gastronómica pero saltea categorías e ítems.
    seedCatalog: boolean,
  ): Promise<ApplyPresetResult> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("apply_industry_preset" as never, {
      p_preset: preset,
      p_sells: sells,
      p_seed_catalog: seedCatalog,
    } as never);
    if (error) throw error;
    return data as unknown as ApplyPresetResult;
  },

  // Cantidad de productos de muestra activos (from_preset != null) del tenant.
  sampleCount: async (): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("preset_sample_count" as never);
    if (error) throw error;
    return Number(data ?? 0);
  },

  // Baja lógica de TODOS los productos de muestra del tenant. Devuelve cuántos.
  deleteSamples: async (): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("delete_preset_samples" as never);
    if (error) throw error;
    return Number(data ?? 0);
  },
};
