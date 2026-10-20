// =============================================================================
// Edge Function: purchase_invoice_ocr: lee una factura de compra (PDF o foto)
// con la IA de la plataforma y devuelve los datos para precargar el
// comprobante. F24 · H167, ADR-178. NUNCA graba el comprobante.
//
// POST { action: 'status' }
//   → { allowed, configured, provider }
// POST { action: 'extract', inbox_id }
//   → { ok: true, data, warnings, provider }
//   → { ok: false, error, detail? }  (200: invoke pierde el cuerpo de un non-2xx)
//
// Seguridad:
//   • verify_jwt = true. El negocio sale SIEMPRE del JWT (current_tenant_id).
//   • Miembro activo con la capacidad purchases.manage, feature `compras` y el
//     complemento Asistente IA (tenant_has_feature_for 'asistente_ia', como
//     ai_cover_image). Cuota mensual de tokens de ai_config.monthly_quota
//     (la misma del asistente) y cada lectura queda en ai_usage.
//   • El archivo sale del bucket privado purchase-inbox y tiene que ser de una
//     fila de purchase_invoice_inbox del negocio. La API key es de la
//     PLATAFORMA (platform_secrets.ai_config): Claude si hay claude_api_key
//     (lee PDF y fotos), si no Gemini. Nunca va al front ni a la respuesta.
//   • El JSON del modelo se valida estricto (_shared/purchaseInvoiceOcr.ts);
//     lo que no valida queda en null con un aviso.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { userHasCapability } from "../_shared/capabilities.ts";
import {
  DEFAULT_CLAUDE_OCR_MODEL,
  OCR_MIME,
  claudeHeaders,
  claudeRequest,
  claudeText,
  extractJson,
  geminiRequest,
  geminiText,
  validateOcr,
  type OcrMime,
} from "../_shared/purchaseInvoiceOcr.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (error: string, detail?: string) => json({ ok: false, error, ...(detail ? { detail } : {}) });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 90_000;
const MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_MONTHLY_TOKEN_CAP = 500_000;

function keyOf(v: unknown): string {
  const s = String(v ?? "").trim();
  return s.length >= 20 ? s : "";
}

function resolveProvider(cfg: Record<string, unknown>) {
  const claudeKey = keyOf(cfg.claude_api_key);
  if (claudeKey) {
    const configured = String(cfg.ocr_model ?? "").trim();
    const model = configured.startsWith("claude-")
      ? configured
      : cfg.provider === "claude" && String(cfg.model ?? "").trim()
        ? String(cfg.model).trim()
        : DEFAULT_CLAUDE_OCR_MODEL;
    return { provider: "claude" as const, model, apiKey: claudeKey };
  }
  const geminiKey = keyOf(cfg.gemini_api_key) || keyOf(cfg.api_key) || keyOf(Deno.env.get("GEMINI_API_KEY"));
  const configured = String(cfg.ocr_model ?? "").trim();
  const model = configured.startsWith("gemini-") ? configured : DEFAULT_GEMINI_MODEL;
  return { provider: "gemini" as const, model, apiKey: geminiKey };
}

function monthlyCap(cfg: Record<string, unknown>): number {
  const n = Number(String(cfg.monthly_quota ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MONTHLY_TOKEN_CAP;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const tenantId = String((user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id ?? "");
    if (!UUID_RE.test(tenantId)) return json({ error: "no_tenant" }, 400);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: member } = await admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!member) return json({ error: "forbidden" }, 403);
    const role = (member as { role?: string }).role ?? null;

    const [{ data: cfgRow }, compras, addon, canWrite] = await Promise.all([
      admin.from("platform_secrets").select("secrets").eq("key", "ai_config").maybeSingle(),
      admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "compras" }),
      admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "asistente_ia" }),
      userHasCapability(admin, tenantId, user.id, "purchases.manage", ["owner", "manager"], role),
    ]);
    const cfg = (cfgRow?.secrets ?? {}) as Record<string, unknown>;
    const { provider, model, apiKey } = resolveProvider(cfg);
    const aiOff = String(cfg.active ?? "").trim().toLowerCase() === "false";
    const allowed = compras.data === true && addon.data === true && canWrite && !aiOff;

    if (body.action === "status") {
      return json({ allowed, configured: Boolean(apiKey), provider, addon: addon.data === true });
    }
    if (body.action !== "extract") return json({ error: "invalid_action" }, 400);
    if (compras.data !== true) return fail("feature_not_in_plan");
    if (!canWrite) return fail("forbidden");
    if (addon.data !== true) return fail("addon_required", "Leer facturas con IA viene con el complemento Asistente IA.");
    if (aiOff) return fail("ai_disabled");
    if (!apiKey) return fail("not_configured", "La lectura con IA todavía no está configurada.");

    const inboxId = String(body.inbox_id ?? "");
    if (!UUID_RE.test(inboxId)) return fail("invalid_inbox");
    const { data: row } = await admin
      .from("purchase_invoice_inbox")
      .select("id, storage_path, mime_type, size_bytes, status")
      .eq("id", inboxId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!row) return fail("inbox_not_found");
    const mime = String(row.mime_type) as OcrMime;
    if (!OCR_MIME.includes(mime)) return fail("unsupported_file");
    if (!String(row.storage_path).startsWith(`${tenantId}/`)) return fail("inbox_not_found");

    // Cuota mensual (misma bolsa que el asistente).
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { data: usage } = await admin
      .from("ai_usage")
      .select("tokens")
      .eq("tenant_id", tenantId)
      .gte("created_at", monthStart.toISOString());
    const used = (usage ?? []).reduce((t, r) => t + (Number((r as { tokens?: number }).tokens) || 0), 0);
    if (used >= monthlyCap(cfg)) return fail("quota_exceeded");

    const file = await admin.storage.from("purchase-inbox").download(String(row.storage_path));
    if (file.error || !file.data) return fail("file_not_found");
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return fail("file_too_large");
    const b64 = toBase64(bytes);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let text = "";
    let tokens = 0;
    try {
      if (provider === "claude") {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            ...claudeHeaders(model),
          },
          body: JSON.stringify(claudeRequest(model, mime, b64)),
          signal: ctrl.signal,
        });
        const resBody = await r.json().catch(() => ({}));
        if (!r.ok) {
          console.error("[purchase_invoice_ocr] claude", r.status, JSON.stringify(resBody).slice(0, 300));
          return fail("ai_provider_error");
        }
        const out = claudeText(resBody);
        if (out.refused) return fail("ai_refused");
        text = out.text;
        tokens = out.tokens;
      } else {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(geminiRequest(mime, b64)),
            signal: ctrl.signal,
          },
        );
        const resBody = await r.json().catch(() => ({}));
        if (!r.ok) {
          console.error("[purchase_invoice_ocr] gemini", r.status, JSON.stringify(resBody).slice(0, 300));
          return fail("ai_provider_error");
        }
        const out = geminiText(resBody);
        text = out.text;
        tokens = out.tokens;
      }
    } catch (e) {
      console.error("[purchase_invoice_ocr] fetch", e instanceof Error ? e.message : e);
      return fail("ai_provider_error");
    } finally {
      clearTimeout(timer);
    }

    // Consumo del complemento (best-effort; el error se loguea).
    const { error: usageErr } = await admin.from("ai_usage").insert({
      tenant_id: tenantId,
      user_id: user.id,
      provider: `${provider}-ocr:${model}`,
      tokens: tokens || Math.ceil(b64.length / 4 / 50),
    });
    if (usageErr) console.error("[purchase_invoice_ocr] ai_usage", usageErr.message);

    let parsed;
    try {
      parsed = validateOcr(extractJson(text));
    } catch {
      return fail("ai_unreadable", "No pudimos leer el comprobante. Probá con una foto más nítida o cargalo a mano.");
    }
    if (!parsed.ok) return fail("ai_unreadable");

    await admin
      .from("purchase_invoice_inbox")
      .update({ extracted: parsed.data, extracted_at: new Date().toISOString(), ai_provider: `${provider}:${model}` })
      .eq("id", inboxId)
      .eq("tenant_id", tenantId);

    return json({ ok: true, data: parsed.data, warnings: parsed.warnings, provider });
  } catch (e) {
    console.error("[purchase_invoice_ocr]", e instanceof Error ? e.message : e);
    return fail("internal");
  }
});
