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
  ): Promise<ApplyPresetResult> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("apply_industry_preset" as never, {
      p_preset: preset,
      p_sells: sells,
    } as never);
    if (error) throw error;
    return data as unknown as ApplyPresetResult;
  },
};
