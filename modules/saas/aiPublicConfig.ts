"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

// Config PÚBLICA del addon IA (avatar + texto comercial + precio + trial). La
// trae el RPC ai_public_config(); NO expone la api_key. La usan el panel del
// dueño y el registro (para vender el complemento y mostrar su precio).
//
// OJO con el registro por email: ai_public_config() está grant a `authenticated`
// (no a anon). En el paso de plan del flujo email todavía no hay sesión, así que
// la llamada falla → devolvemos null y la UI degrada con copy genérico. En SSO
// (sesión Google) y en el panel del dueño sí resuelve.

export interface AiPublicConfig {
  image_url: string;
  commercial_text: string;
  addon_price_ars: string;
  addon_trial_days: string;
}

export function useAiPublicConfig(enabled = true) {
  return useQuery({
    queryKey: ["ai-public-config"],
    enabled,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<AiPublicConfig | null> => {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as (
        fn: string,
      ) => Promise<{ data: unknown; error: unknown }>;
      const { data, error } = await rpc("ai_public_config");
      if (error) return null;
      const c = (data ?? {}) as Partial<AiPublicConfig>;
      return {
        image_url: String(c.image_url ?? ""),
        commercial_text: String(c.commercial_text ?? ""),
        addon_price_ars: String(c.addon_price_ars ?? ""),
        addon_trial_days: String(c.addon_trial_days ?? ""),
      };
    },
  });
}

// Activa el addon IA tras crear el tenant (post-auth). Best-effort: si falla, no
// rompe el alta (el dueño puede activarlo desde el panel). Devuelve ok/false.
export async function activateAiAddon(): Promise<{ ok: boolean }> {
  const supabase = createClient();
  const rpc = supabase.rpc as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ error: unknown }>;
  const { error } = await rpc("activate_addon", { p_addon_key: "ai_assistant" });
  return { ok: !error };
}
