// =============================================================================
// Edge Function: ai_cover_image — portadas de servicios y productos con el
// modelo de imagen de Gemini ("nano banana", gemini-2.5-flash-image). ADR-122.
//
// POST { action: 'status' }
//   → { configured, allowed, used, limit, model }  (para la UI: si no hay
//     API key configurada lo dice sin romper)
// POST { action: 'generate', product_id, style?, apply? }
//   → { ok: true, generation: { id, url, style, created_at }, applied }
//   → { ok: false, error }  (200: invoke pierde el cuerpo de un non-2xx)
//
// Seguridad:
//   • verify_jwt = true. El negocio sale SIEMPRE del JWT (current_tenant_id).
//   • La API key es de la PLATAFORMA: platform_secrets.ai_config
//     (gemini_api_key, o api_key legacy) o el secret GEMINI_API_KEY. Nunca va
//     al front ni a la respuesta.
//   • Gating y tope en la base: _ai_image_reserve (service_role) exige el
//     complemento Asistente IA (tenant_has_feature_for 'asistente_ia'), que el
//     producto sea del negocio, rol dueño o encargado, y el tope diario por
//     negocio (ai_config.image_daily_limit, default 20) con lock. Cada pedido
//     queda en ai_image_generations (registro de consumo).
//   • El prompt lo arma el servidor (buildCoverPrompt) con los datos del
//     producto y la configuración del negocio; el cliente sólo elige el estilo.
//
// Imagen: se achica a 900 px y se guarda como JPEG en el bucket product-images
// (<tenant>/<product>/<uuid>.jpg, la convención de la galería). imagescript no
// trae encoder WebP en Deno (ver tiendita_copy_image). Se conservan las
// últimas 8 sin elegir por producto; las más viejas se borran.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { PRODUCT_IMAGES_BUCKET, fitWidth, productImagePath } from "../_shared/productImage.ts";
import { buildCoverPrompt, coverStyleInfo, isCoverStyle } from "../_shared/aiCoverPrompt.ts";
import {
  base64ToBytes,
  buildGeminiImageRequest,
  geminiImageUrl,
  parseGeminiImageResponse,
  resolveImageModel,
} from "../_shared/geminiImage.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (error: string, detail?: string) => json({ ok: false, error, ...(detail ? { detail } : {}) });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEEP_PER_PRODUCT = 8;
const TIMEOUT_MS = 60_000;

const INDUSTRY_WORDS: Record<string, string> = {
  servicios: "professional services firm",
  textil: "clothing store",
  kiosco: "kiosk",
  restaurante: "restaurant",
  cafe: "coffee shop",
  almacen: "grocery store",
  ferreteria: "hardware store",
  farmacia: "pharmacy",
  libreria: "stationery store",
  verduleria: "greengrocer",
  peluqueria: "hair salon",
  estetica: "beauty salon",
};

function apiKeyOf(cfg: Record<string, unknown>): string {
  // Una clave claramente inválida (muy corta) no tapa a la otra guardada.
  const ok = (v: unknown) => {
    const s = String(v ?? "").trim();
    return s.length >= 20 ? s : "";
  };
  const fromCfg = ok(cfg.gemini_api_key) || ok(cfg.api_key);
  return fromCfg || (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
}

async function toJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  const img = await Image.decode(bytes);
  const { width, height } = fitWidth(img.width, img.height);
  if (width !== img.width) img.resize(width, height);
  return await img.encodeJPEG(85);
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
    const { data: cfgRow } = await admin.from("platform_secrets").select("secrets").eq("key", "ai_config").maybeSingle();
    const cfg = (cfgRow?.secrets ?? {}) as Record<string, unknown>;
    const apiKey = apiKeyOf(cfg);
    const model = resolveImageModel(cfg.image_model);

    // Membresía del usuario en el negocio del JWT.
    const { data: member } = await admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!member) return json({ error: "forbidden" }, 403);

    if (body.action === "status") {
      const [{ data: allowed }, { data: limit }] = await Promise.all([
        admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "asistente_ia" }),
        admin.rpc("ai_image_daily_limit"),
      ]);
      const since = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10) + "T03:00:00Z";
      const { count } = await admin
        .from("ai_image_generations")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "ok"])
        .gte("created_at", since);
      return json({
        configured: Boolean(apiKey),
        allowed: Boolean(allowed),
        used: count ?? 0,
        limit: Number(limit ?? 20),
        model,
      });
    }

    if (body.action !== "generate") return json({ error: "invalid_action" }, 400);
    const productId = String(body.product_id ?? "");
    if (!UUID_RE.test(productId)) return fail("invalid_product");
    if (!apiKey) return fail("not_configured", "La generación de imágenes todavía no está configurada.");

    const { data: product } = await admin
      .from("products")
      .select("id, name, description, invoice_detail, is_service, service_type_id, category_id")
      .eq("id", productId)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!product) return fail("product_not_found");

    const [{ data: settings }, { data: tenant }, typeRes, catRes] = await Promise.all([
      admin.from("ai_image_settings").select("style, accent, base_prompt").eq("tenant_id", tenantId).maybeSingle(),
      admin.from("tenants").select("industry").eq("id", tenantId).maybeSingle(),
      product.service_type_id
        ? admin.from("service_types").select("name").eq("id", product.service_type_id).eq("tenant_id", tenantId).maybeSingle()
        : Promise.resolve({ data: null }),
      product.category_id
        ? admin.from("categories").select("name").eq("id", product.category_id).eq("tenant_id", tenantId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const style = isCoverStyle(body.style) ? body.style : coverStyleInfo(settings?.style).key;
    const industry = String((tenant as { industry?: string } | null)?.industry ?? "");
    const prompt = buildCoverPrompt({
      name: product.name,
      type: (typeRes.data as { name?: string } | null)?.name ?? (product.is_service ? "service" : "product"),
      description: product.invoice_detail || product.description,
      business: INDUSTRY_WORDS[industry] ?? (product.is_service ? "professional services firm" : "store"),
      style,
      accent: settings?.accent ?? null,
      basePrompt: settings?.base_prompt ?? null,
      // Productos: prompt centrado en el producto, sin el rubro del negocio.
      kind: product.is_service ? "service" : "product",
      category: (catRes.data as { name?: string } | null)?.name ?? null,
    });

    // Reserva (gating del addon, rol, producto y tope del día en la base).
    const { data: genId, error: resErr } = await admin.rpc("_ai_image_reserve", {
      p_tenant: tenantId,
      p_user: user.id,
      p_product: productId,
      p_style: style,
      p_prompt: prompt,
      p_model: model,
    });
    if (resErr || !genId) {
      const msg = String(resErr?.message ?? "");
      for (const code of ["addon_required", "daily_limit", "forbidden", "product_not_found"]) {
        if (msg.includes(code)) return fail(code);
      }
      console.error("[ai_cover_image] reserve", msg);
      return fail("internal");
    }
    const markError = async (error: string) => {
      await admin.from("ai_image_generations").update({ status: "error", error: error.slice(0, 500) }).eq("id", genId);
    };

    // Gemini.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let parsed;
    try {
      const res = await fetch(geminiImageUrl(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(buildGeminiImageRequest(prompt)),
        signal: ctrl.signal,
      });
      const resBody = await res.json().catch(() => ({}));
      parsed = parseGeminiImageResponse(res.status, resBody);
    } catch (e) {
      parsed = { ok: false as const, error: "provider_error" as const, detail: String(e).slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
    if (!parsed.ok) {
      await markError(`${parsed.error}: ${parsed.detail}`);
      return fail(parsed.error, parsed.error === "blocked" ? "El modelo no generó la imagen para este pedido." : undefined);
    }

    let jpeg: Uint8Array;
    try {
      jpeg = await toJpeg(base64ToBytes(parsed.base64));
    } catch (e) {
      await markError(`decode: ${String(e)}`);
      return fail("image_invalid");
    }

    const path = productImagePath(tenantId, productId, crypto.randomUUID(), "jpg");
    const up = await admin.storage.from(PRODUCT_IMAGES_BUCKET).upload(path, jpeg, { contentType: "image/jpeg", upsert: false });
    if (up.error) {
      await markError(`upload: ${up.error.message}`);
      return fail("upload_failed");
    }
    const publicUrl = admin.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path).data.publicUrl;
    const { data: gen } = await admin
      .from("ai_image_generations")
      .update({ status: "ok", path, url: publicUrl, bytes: jpeg.byteLength, units: 1 })
      .eq("id", genId)
      .select("id, url, style, created_at")
      .single();

    // Uso: también en ai_usage (consumo del complemento por negocio).
    await admin.from("ai_usage").insert({ tenant_id: tenantId, user_id: user.id, provider: `gemini-image:${model}`, tokens: 0 });

    // Historial: quedan las últimas KEEP_PER_PRODUCT sin elegir.
    const { data: old } = await admin
      .from("ai_image_generations")
      .select("id, path")
      .eq("tenant_id", tenantId)
      .eq("product_id", productId)
      .eq("status", "ok")
      .is("chosen_at", null)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(KEEP_PER_PRODUCT, KEEP_PER_PRODUCT + 50);
    if (old?.length) {
      await admin.storage.from(PRODUCT_IMAGES_BUCKET).remove(old.map((o) => o.path).filter(Boolean) as string[]);
      await admin
        .from("ai_image_generations")
        .update({ deleted_at: new Date().toISOString() })
        .in("id", old.map((o) => o.id));
    }

    let applied = false;
    if (body.apply === true && (member.role === "owner" || member.role === "manager")) {
      const { error: apErr } = await admin.rpc("_ai_image_apply", { p_tenant: tenantId, p_generation: genId, p_actor: user.id });
      applied = !apErr;
      if (apErr) console.error("[ai_cover_image] apply", apErr.message);
    }

    return json({ ok: true, generation: gen ?? { id: genId, url: publicUrl, style }, applied });
  } catch (e) {
    console.error("[ai_cover_image]", String(e));
    return json({ ok: false, error: "internal" });
  }
});
