"use client";

// Portadas con IA (ADR-122). La generación corre en la Edge ai_cover_image
// (API key de la plataforma, gating del complemento Asistente IA y tope
// diario en la base). Acá: configuración del negocio, historial por
// producto, generar y elegir.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { useFeature } from "@/modules/saas/gating";
import type { CoverStyle } from "@/supabase/functions/_shared/aiCoverPrompt";

export interface AiImageSettings {
  auto_cover: boolean;
  style: CoverStyle;
  accent: string | null;
  base_prompt: string | null;
}

export const DEFAULT_AI_IMAGE_SETTINGS: AiImageSettings = {
  auto_cover: false,
  style: "flat_icon",
  accent: null,
  base_prompt: null,
};

export interface AiCoverStatus {
  configured: boolean;
  allowed: boolean;
  used: number;
  limit: number;
  model?: string;
}

export interface AiGeneration {
  id: string;
  url: string | null;
  style: string;
  status: "pending" | "ok" | "error";
  chosen_at: string | null;
  created_at: string;
}

export type GenerateResult =
  | { ok: true; generation: { id: string; url: string; style: string; created_at?: string }; applied: boolean }
  | { ok: false; error: string; detail?: string };

type Res = { data: unknown; error: { message: string } | null };
interface LooseQuery extends PromiseLike<Res> {
  eq: (c: string, v: unknown) => LooseQuery;
  is: (c: string, v: null) => LooseQuery;
  order: (c: string, o?: { ascending?: boolean }) => LooseQuery;
  limit: (n: number) => LooseQuery;
  maybeSingle: () => PromiseLike<Res>;
}
interface Loose {
  from: (t: string) => {
    select: (c: string) => LooseQuery;
    upsert: (v: unknown, o?: { onConflict?: string }) => PromiseLike<Res>;
  };
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<Res>;
}
const loose = () => createClient() as unknown as Loose;

export const aiCoversApi = {
  status: async (): Promise<AiCoverStatus | null> => {
    const { data, error } = await createClient().functions.invoke("ai_cover_image", { body: { action: "status" } });
    if (error) return null;
    return data as AiCoverStatus;
  },
  settings: async (): Promise<AiImageSettings> => {
    const { data } = await loose().from("ai_image_settings").select("auto_cover, style, accent, base_prompt").maybeSingle();
    return { ...DEFAULT_AI_IMAGE_SETTINGS, ...((data ?? {}) as Partial<AiImageSettings>) };
  },
  saveSettings: async (s: AiImageSettings): Promise<void> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) throw new Error("no_tenant");
    const { error } = await loose()
      .from("ai_image_settings")
      .upsert(
        {
          tenant_id: tenantId,
          auto_cover: s.auto_cover,
          style: s.style,
          accent: s.accent && /^#[0-9a-fA-F]{6}$/.test(s.accent) ? s.accent : null,
          base_prompt: s.base_prompt?.trim() ? s.base_prompt.trim().slice(0, 1500) : null,
        },
        { onConflict: "tenant_id" },
      );
    if (error) throw new Error(error.message);
  },
  generations: async (productId: string): Promise<AiGeneration[]> => {
    const { data, error } = await loose()
      .from("ai_image_generations")
      .select("id, url, style, status, chosen_at, created_at")
      .eq("product_id", productId)
      .eq("status", "ok")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(8);
    if (error) throw new Error(error.message);
    return (data ?? []) as AiGeneration[];
  },
  generate: async (productId: string, opts: { style?: CoverStyle; apply?: boolean } = {}): Promise<GenerateResult> => {
    const { data, error } = await createClient().functions.invoke("ai_cover_image", {
      body: { action: "generate", product_id: productId, ...opts },
    });
    if (error) return { ok: false, error: "network" };
    return data as GenerateResult;
  },
  choose: async (generationId: string): Promise<void> => {
    const { error } = await loose().rpc("ai_image_choose", { p_generation: generationId });
    if (error) throw new Error(error.message);
  },
};

const AI_ERRORS: Record<string, string> = {
  not_configured: "La generación de imágenes todavía no está configurada en NinjaSoft.",
  addon_required: "Las portadas con IA son parte del complemento Asistente IA.",
  daily_limit: "Llegaste al máximo de imágenes de hoy. Mañana podés generar más.",
  forbidden: "Sólo el dueño o un encargado genera portadas.",
  forbidden_role: "Sólo el dueño o un encargado elige la portada.",
  blocked: "El modelo no generó una imagen para este servicio. Probá con otro estilo o cambiá la descripción.",
  provider_error: "El servicio de imágenes no respondió. Probá de nuevo en un rato.",
  product_not_found: "Guardá el servicio antes de generar la portada.",
  upload_failed: "No se pudo guardar la imagen. Probá de nuevo.",
  image_invalid: "La imagen generada vino dañada. Probá de nuevo.",
  network: "No hay conexión con el servidor.",
};

export function aiCoverError(code: string | undefined | null): string {
  const c = code ?? "";
  if (AI_ERRORS[c]) return AI_ERRORS[c]!;
  const hit = Object.keys(AI_ERRORS)
    .sort((a, b) => b.length - a.length)
    .find((k) => c.includes(k));
  return hit ? AI_ERRORS[hit]! : "No se pudo generar la imagen.";
}

export const AI_COVERS_KEY = ["ai-covers"] as const;

/** ¿El negocio tiene el complemento? (gating real en la base y la Edge). */
export function useAiCoversEnabled(): boolean | undefined {
  return useFeature("asistente_ia");
}

export function useAiCoverStatus(enabled = true) {
  return useQuery({
    queryKey: [...AI_COVERS_KEY, "status"],
    queryFn: () => aiCoversApi.status(),
    enabled,
    staleTime: 60_000,
  });
}

export function useAiImageSettings(enabled = true) {
  return useQuery({ queryKey: [...AI_COVERS_KEY, "settings"], queryFn: () => aiCoversApi.settings(), enabled, staleTime: 60_000 });
}

export function useAiGenerations(productId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...AI_COVERS_KEY, "generations", productId],
    queryFn: () => aiCoversApi.generations(productId!),
    enabled: Boolean(productId) && enabled,
  });
}

export function useAiCoverMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: AI_COVERS_KEY });
  return {
    saveSettings: useMutation({ mutationFn: aiCoversApi.saveSettings, onSuccess: inv }),
    generate: useMutation({
      mutationFn: (v: { productId: string; style?: CoverStyle; apply?: boolean }) =>
        aiCoversApi.generate(v.productId, { style: v.style, apply: v.apply }),
      onSuccess: (_r, v) => {
        inv();
        if (v.apply) {
          qc.invalidateQueries({ queryKey: ["product-images", v.productId] });
          qc.invalidateQueries({ queryKey: ["products"] });
        }
      },
    }),
    choose: useMutation({
      mutationFn: (v: { generationId: string; productId: string }) => aiCoversApi.choose(v.generationId),
      onSuccess: (_r, v) => {
        inv();
        qc.invalidateQueries({ queryKey: ["product-images", v.productId] });
        qc.invalidateQueries({ queryKey: ["products"] });
      },
    }),
  };
}
