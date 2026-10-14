// =============================================================================
// Generación de imágenes con Gemini ("nano banana", gemini-2.5-flash-image)
// (ADR-122). Lógica PURA de pedido y respuesta, compartida por la Edge
// `ai_cover_image` y los tests (que mockean la respuesta: nunca se llama a la
// API real). Sin imports: corre en Deno y Node.
// =============================================================================

export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Modelo de imagen válido (evita inyectar rutas en la URL). */
export function resolveImageModel(raw: unknown): string {
  const m = typeof raw === "string" ? raw.trim() : "";
  return /^gemini-[a-z0-9.\-]{3,60}$/i.test(m) && m.includes("image") ? m : DEFAULT_IMAGE_MODEL;
}

export function geminiImageUrl(model: string): string {
  return `${GEMINI_BASE}/${encodeURIComponent(resolveImageModel(model))}:generateContent`;
}

/** Cuerpo de generateContent pidiendo sólo imagen, cuadrada. */
export function buildGeminiImageRequest(prompt: string): Record<string, unknown> {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "1:1" },
    },
  };
}

export type GeminiImageResult =
  | { ok: true; mimeType: string; base64: string }
  | { ok: false; error: "no_image" | "blocked" | "provider_error"; detail: string };

/**
 * Lee la respuesta de generateContent: la primera parte con inlineData de
 * imagen. Contempla el bloqueo por seguridad (promptFeedback / finishReason).
 */
export function parseGeminiImageResponse(status: number, body: unknown): GeminiImageResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status < 200 || status >= 300) {
    const err = (b.error ?? {}) as { message?: string };
    return { ok: false, error: "provider_error", detail: String(err.message ?? `HTTP ${status}`).slice(0, 300) };
  }
  const feedback = (b.promptFeedback ?? {}) as { blockReason?: string };
  if (feedback.blockReason) return { ok: false, error: "blocked", detail: feedback.blockReason };
  const candidates = Array.isArray(b.candidates) ? (b.candidates as Record<string, unknown>[]) : [];
  for (const c of candidates) {
    const parts = ((c.content ?? {}) as { parts?: unknown[] }).parts ?? [];
    for (const p of parts as Record<string, unknown>[]) {
      const inline = (p.inlineData ?? p.inline_data) as { mimeType?: string; mime_type?: string; data?: string } | undefined;
      const mime = inline?.mimeType ?? inline?.mime_type ?? "";
      if (inline?.data && /^image\//.test(mime)) {
        return { ok: true, mimeType: mime, base64: inline.data };
      }
    }
    const reason = String(c.finishReason ?? "");
    if (reason && reason !== "STOP") return { ok: false, error: "blocked", detail: reason };
  }
  return { ok: false, error: "no_image", detail: "La respuesta no trajo imagen." };
}

/** base64 → bytes (Deno y Node). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
