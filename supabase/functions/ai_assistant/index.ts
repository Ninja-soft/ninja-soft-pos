// =============================================================================
// Edge Function: ai_assistant — Asistente IA del POS (Fase F).
//
// POST { messages: [{role, content}] } → { reply }
//
// Guard (server-side, todo vía service_role admin):
//   allowed = addon asistente_ia/ai_assistant activo para el tenant
//             OR el owner del tenant == ai_config.beta_owner_email.
//   Si no → 403 { error: 'addon_required' }, SALVO body {intro:true}: ahí
//   devuelve 200 { reply: <texto comercial>, locked: true } para que la
//   burbuja pueda abrirse y mostrar el explicador sin el complemento.
//
// Robustez del proveedor: toda respuesta non-2xx o cuerpo inesperado se
// traduce a 502 { error:'ai_provider_error', detail:<mensaje truncado> }.
// Nunca se deja escapar un throw al runtime (502/503 opaco sin cuerpo).
//
// Contexto READ-ONLY scoped por tenant (nunca SQL libre): ventas de hoy/7d,
// top productos, stock bajo, estado de config. + guía fija de pantallas.
// System prompt cerrado al POS. Proveedor Gemini | Claude según ai_config.
// Cuota mensual por tenant (ai_usage). NO deployar (lo hace el controller).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Tope mensual de tokens por tenant (estimado). Por encima → 429.
const MONTHLY_TOKEN_CAP = 500_000;

// Modelos por defecto cuando ai_config.model viene vacío.
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

// Modelos de Gemini dados de baja por Google: en v1beta:generateContent
// devuelven 404 NOT_FOUND. Si la config trae uno de estos lo remapeamos al
// default vigente para no romper al tenant hasta que edite la config a mano.
// (Causa del 502 histórico: ai_config tenía 'gemini-2.0-flash', shut down.)
const DEAD_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash-001",
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-002",
  "gemini-1.5-pro",
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro-002",
  "gemini-pro",
]);

// Texto comercial por defecto del addon IA (cuando ai_config.commercial_text
// está vacío). Se muestra al abrir la burbuja sin el complemento contratado.
// Tono pro, vendedor y rioplatense (alineado con AiConfigCard).
const DEFAULT_COMMERCIAL_TEXT =
  "Sumá un asistente con IA a tu NinjaPos y tené tu negocio en la palma de la " +
  "mano. Preguntale en lenguaje natural y te responde al toque: cuánto vendiste " +
  "hoy o esta semana, cuáles son tus productos más vendidos, qué se está por " +
  "quedar sin stock, cómo viene la cuenta corriente de tus clientes y dónde está " +
  "cada función del sistema.\n\n" +
  "Es como tener un encargado que conoce tus números y nunca se cansa: te ahorra " +
  "tiempo, te ayuda a decidir con datos reales y te saca las dudas de cómo usar " +
  "cada pantalla.\n\n" +
  "Se activa al instante para todo tu equipo. Probalo y no vas a querer trabajar " +
  "sin él.";

// Las llamadas HTTP a los proveedores pueden rechazar fuera de nuestro await;
// sin handlers globales Deno mata el worker (503). Mirror de los siblings.
addEventListener("unhandledrejection", (e) => {
  console.error("unhandledrejection:", (e as PromiseRejectionEvent).reason);
  (e as PromiseRejectionEvent).preventDefault();
});
addEventListener("error", (e) => {
  console.error("uncaught error:", (e as ErrorEvent).message);
  (e as ErrorEvent).preventDefault();
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label}_timeout`)), ms),
    ),
  ]);
}

// Lee el cuerpo de error de un Response sin tirar si ya se consumió/no hay body.
async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

// Parsea JSON de un Response devolviendo null si el cuerpo no es JSON válido
// (evita que un 200 con HTML/garbage del proveedor explote el handler).
async function safeJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

// Extrae un mensaje legible del cuerpo de error del proveedor (Gemini/Claude
// devuelven { error: { message } }). Trunca para no filtrar payloads enormes.
function providerErrText(raw: string, model: string): string {
  let msg = raw;
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string };
    if (j && typeof j.error === "object" && j.error?.message) {
      msg = j.error.message;
    } else if (typeof j?.error === "string") {
      msg = j.error;
    }
  } catch {
    /* raw no era JSON: se usa tal cual */
  }
  msg = (msg || "error del proveedor").slice(0, 300);
  return `[${model}] ${msg}`;
}

// Guía fija de pantallas del POS (rutas reales de la app). El asistente la usa
// para orientar al usuario sobre dónde está cada función.
const HELP_GUIDE = `Mapa de pantallas de NinjaPos:
• Vender (Punto de venta) — /pos: cargás productos, cobrás (efectivo, débito, crédito, transferencia, QR Mercado Pago) e imprimís el ticket.
• Caja — /caja: abrís y cerrás la caja, hacés arqueo y ves el cierre Z.
• Ventas — /ventas: historial de ventas, ver detalle y anular.
• Devoluciones — /devoluciones: notas de crédito y devoluciones de productos.
• Productos — /productos: catálogo, precios, stock, variantes y listas de precios.
• Etiquetas — /etiquetas: impresión de etiquetas/códigos de barras.
• Clientes — /clientes: alta de clientes, grupos y cuenta corriente.
• Reportes — /reportes: reportes de ventas por período, por producto y por cliente.
• Configuración — /configuracion: diseño de ticket, medios de pago (Mercado Pago), email de comprobantes (SMTP), datos del negocio.
• Panel del dueño — /dashboard-team: visión del negocio para dueños y encargados.
Para conectar Mercado Pago o configurar el email de comprobantes, andá a Configuración.`;

type ProviderResult =
  | { ok: true; reply: string; tokens: number }
  | { ok: false; status: number; error: string; detail: string };

// Llama al proveedor (Gemini | Claude) con la config dada y devuelve un
// resultado tipado. Centraliza la robustez (non-2xx, cuerpo inesperado,
// timeout) para reusar el mismo camino en el chat real y en el ping de test.
async function callProvider(
  provider: "gemini" | "claude",
  model: string,
  apiKey: string,
  systemPrompt: string,
  messages: { role: string; content: string }[],
): Promise<ProviderResult> {
  try {
    if (provider === "claude") {
      const r = await withTimeout(
        fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            system: systemPrompt,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
          }),
        }),
        30_000,
        "claude",
      );
      if (!r.ok) {
        const detail = providerErrText(await safeText(r), model);
        console.error("claude non-200:", r.status, detail);
        return { ok: false, status: 502, error: "ai_provider_error", detail };
      }
      const data = (await safeJson(r)) as {
        content?: { text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      } | null;
      const text = data?.content?.[0]?.text;
      if (typeof text !== "string") {
        console.error("claude bad shape:", JSON.stringify(data).slice(0, 500));
        return {
          ok: false,
          status: 502,
          error: "ai_provider_error",
          detail: "Respuesta del proveedor sin texto utilizable.",
        };
      }
      const tokens =
        (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0);
      return { ok: true, reply: text, tokens };
    }
    // Gemini v1beta: system en systemInstruction; historial en contents.
    const r = await withTimeout(
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model,
        )}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: messages.map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            })),
            generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
          }),
        },
      ),
      30_000,
      "gemini",
    );
    if (!r.ok) {
      const detail = providerErrText(await safeText(r), model);
      console.error("gemini non-200:", r.status, detail);
      return { ok: false, status: 502, error: "ai_provider_error", detail };
    }
    const data = (await safeJson(r)) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
        finishReason?: string;
      }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { totalTokenCount?: number };
    } | null;
    const cand = data?.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const text = parts.map((p) => p?.text ?? "").join("").trim();
    if (!text) {
      const reason =
        data?.promptFeedback?.blockReason || cand?.finishReason || "sin_contenido";
      console.error("gemini empty:", reason, JSON.stringify(data).slice(0, 400));
      return {
        ok: false,
        status: 502,
        error: "ai_provider_error",
        detail: `El proveedor no devolvió texto (motivo: ${reason}).`,
      };
    }
    return { ok: true, reply: text, tokens: data?.usageMetadata?.totalTokenCount ?? 0 };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("provider call failed:", detail);
    return { ok: false, status: 502, error: "ai_provider_error", detail: detail.slice(0, 300) };
  }
}

// Resuelve provider/model/apiKey desde ai_config (remapeo de modelos muertos de
// Gemini y fallback de key legacy). Compartido por el chat real y el test.
function resolveProviderConfig(cfg: Record<string, string>): {
  provider: "gemini" | "claude";
  model: string;
  apiKey: string;
} {
  const provider = (cfg.provider === "claude" ? "claude" : "gemini") as
    | "gemini"
    | "claude";
  let model = (cfg.model ?? "").trim();
  if (provider === "claude") {
    if (!model) model = DEFAULT_CLAUDE_MODEL;
  } else {
    if (!model || DEAD_GEMINI_MODELS.has(model)) model = DEFAULT_GEMINI_MODEL;
  }
  const apiKey = (
    provider === "claude"
      ? (cfg.claude_api_key ?? "")
      : (cfg.gemini_api_key ?? "") || (cfg.api_key ?? "")
  ).trim();
  return { provider, model, apiKey };
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
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // ── Body ────────────────────────────────────────────────────────────────
    // Se parsea ANTES del guard de tenant para poder atender dos flags:
    //  • {intro:true}: tenant sin acceso que abre la burbuja → 200 con el
    //    explicador comercial (no 403) para que el panel pueda mostrarlo.
    //  • {test:true} (SOLO staff interno): ping al proveedor configurado sin
    //    tenant/addon/cuota, para que el botón "Probar" del panel interno ande
    //    aunque el staff no tenga tenant ni el complemento.
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const wantsIntro = body.intro === true;
    const isInternal = Boolean(
      (user.app_metadata as { is_internal?: boolean } | null)?.is_internal,
    );

    // ── Modo TEST (solo staff interno) ───────────────────────────────────────
    // Saltea TODO el guard (tenant/addon/cuota) y simplemente pinguea al
    // proveedor activo con su api_key. Devuelve {reply} si anda o {error,detail}
    // claro si falla. No registra consumo (no hay tenant).
    if (body.test === true) {
      if (!isInternal) return json({ error: "forbidden" }, 403);
      const { data: cfgRow } = await admin
        .from("platform_secrets")
        .select("secrets")
        .eq("key", "ai_config")
        .maybeSingle();
      const cfg = (cfgRow?.secrets ?? {}) as Record<string, string>;
      const { provider, model, apiKey } = resolveProviderConfig(cfg);
      if (!apiKey) {
        return json(
          { error: "ai_not_configured", detail: `Falta la API key de ${provider}.` },
          400,
        );
      }
      const testMessages = [{ role: "user", content: "ping" }];
      const systemPrompt =
        "Sos el asistente de NinjaPos. Esto es una prueba de conexión del panel " +
        "interno. Respondé en una sola línea breve confirmando que estás operativo.";
      const out = await callProvider(provider, model, apiKey, systemPrompt, testMessages);
      if (!out.ok) {
        return json({ error: out.error, detail: out.detail }, out.status);
      }
      return json({ reply: out.reply.trim() || "OK", provider, model });
    }

    const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
      ?.current_tenant_id;
    if (!tenantId) return json({ error: "no_tenant" }, 400);

    // ── Guard server-side (todo con service_role) ───────────────────────────
    // 1) addon accesible: status='active' OR (cancel_at_period_end y el período
    //    sigue vigente). El addon dado de baja a fin de período conserva acceso
    //    hasta current_period_end (semántica de cancel_addon).
    const { data: addonRow } = await admin
      .from("subscription_addons")
      .select("status, cancel_at_period_end, current_period_end")
      .eq("tenant_id", tenantId)
      .in("addon_key", ["asistente_ia", "ai_assistant"])
      .limit(1)
      .maybeSingle();
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (date)
    const addonActive = (() => {
      if (!addonRow) return false;
      const a = addonRow as {
        status?: string;
        cancel_at_period_end?: boolean;
        current_period_end?: string | null;
      };
      if (a.status === "active") return true;
      if (a.cancel_at_period_end && a.current_period_end) {
        // Acceso hasta fin de período inclusive.
        return a.current_period_end >= todayStr;
      }
      return false;
    })();
    let allowed = addonActive;

    // Config IA (se necesita para el guard de beta y para llamar al proveedor).
    const { data: cfgRow } = await admin
      .from("platform_secrets")
      .select("secrets")
      .eq("key", "ai_config")
      .maybeSingle();
    const cfg = (cfgRow?.secrets ?? {}) as Record<string, string>;
    const betaEmail = (cfg.beta_owner_email ?? "").trim().toLowerCase();
    // Toggle "Asistente IA activo" (ai_config.active). undefined o "true" →
    // comportamiento normal; "false" explícito → el asistente NO responde a
    // mensajes reales. El explicador {intro:true} puede seguir mostrándose.
    const aiDisabled = (cfg.active ?? "").trim().toLowerCase() === "false";

    // 2) beta: el owner del tenant == beta_owner_email.
    if (!allowed && betaEmail) {
      const { data: owner } = await admin
        .from("tenant_users")
        .select("users!inner(email)")
        .eq("tenant_id", tenantId)
        .eq("role", "owner")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      const ownerEmail = (
        (owner as { users?: { email?: string } } | null)?.users?.email ?? ""
      )
        .trim()
        .toLowerCase();
      if (ownerEmail && ownerEmail === betaEmail) allowed = true;
    }

    if (!allowed) {
      // Sin acceso pero abriendo la burbuja (intro): explicador comercial 200.
      if (wantsIntro) {
        const commercialText =
          (cfg.commercial_text ?? "").trim() || DEFAULT_COMMERCIAL_TEXT;
        return json({ reply: commercialText, locked: true });
      }
      // Mensaje real sin acceso → 403.
      return json(
        {
          error: "addon_required",
          detail: "El Asistente IA es un complemento. Activalo desde tu plan.",
        },
        403,
      );
    }

    // ── Toggle activo/inactivo del addon ────────────────────────────────────
    // Con acceso pero el asistente desactivado globalmente (ai_config.active
    // === "false"): no respondemos mensajes reales. El explicador {intro:true}
    // sí puede mostrarse (el dueño ve la presentación aunque esté apagado).
    if (aiDisabled) {
      if (wantsIntro) {
        const commercialText =
          (cfg.commercial_text ?? "").trim() || DEFAULT_COMMERCIAL_TEXT;
        return json({ reply: commercialText, locked: true });
      }
      return json(
        {
          error: "ai_disabled",
          detail: "El Asistente IA está temporalmente desactivado.",
        },
        403,
      );
    }

    // ── Config del proveedor ────────────────────────────────────────────────
    // Cada proveedor usa SU propia key (Gemini acepta api_key legacy de fallback;
    // Claude exige claude_api_key) y se remapea cualquier modelo Gemini muerto.
    const { provider, model, apiKey } = resolveProviderConfig(cfg);
    if (!apiKey) {
      return json(
        { error: "ai_not_configured", detail: `Falta la API key de ${provider}.` },
        400,
      );
    }

    // ── Cuota mensual ───────────────────────────────────────────────────────
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { data: usageRows } = await admin
      .from("ai_usage")
      .select("tokens")
      .eq("tenant_id", tenantId)
      .gte("created_at", monthStart.toISOString());
    const usedTokens = (usageRows ?? []).reduce(
      (acc, r) => acc + (Number((r as { tokens?: number }).tokens) || 0),
      0,
    );
    if (usedTokens >= MONTHLY_TOKEN_CAP) {
      return json({ error: "quota_exceeded" }, 429);
    }

    // ── Mensajes del historial (el body ya se parseó arriba) ─────────────────
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages
      .map((m) => {
        const role = (m as { role?: string })?.role === "assistant"
          ? "assistant"
          : "user";
        const content = String((m as { content?: unknown })?.content ?? "")
          .slice(0, 4000)
          .trim();
        return { role, content };
      })
      .filter((m) => m.content.length > 0)
      .slice(-12);
    if (messages.length === 0) return json({ error: "empty_messages" }, 400);

    // ── Contexto READ-ONLY scoped por tenant ────────────────────────────────
    const context = await buildContext(admin, tenantId);

    const systemPrompt =
      "Sos el asistente de NinjaPos, un sistema POS. Respondé SOLO sobre el uso " +
      "del sistema y los datos del negocio que se te dan en el contexto. No " +
      "inventes datos. Español rioplatense. Si te preguntan algo fuera del POS, " +
      "redirigí amablemente. Usá '•' no '—'.\n\n" +
      "=== CONTEXTO DEL NEGOCIO ===\n" +
      context +
      "\n\n=== GUÍA DE PANTALLAS ===\n" +
      HELP_GUIDE;

    // ── Llamada al proveedor ────────────────────────────────────────────────
    // Robustez centralizada en callProvider: cualquier respuesta non-2xx o
    // cuerpo inesperado se traduce a `ai_provider_error` (502) con el detalle
    // truncado. Nunca se deja escapar un throw al runtime.
    const out = await callProvider(provider, model, apiKey, systemPrompt, messages);
    if (!out.ok) {
      return json({ error: out.error, detail: out.detail }, out.status);
    }
    const reply = out.reply;
    let tokens = out.tokens;

    if (!reply.trim()) {
      return json(
        { error: "ai_provider_error", detail: "Respuesta vacía del proveedor." },
        502,
      );
    }

    // Estimación de tokens si el proveedor no la dio.
    if (!tokens) {
      const chars =
        systemPrompt.length +
        messages.reduce((a, m) => a + m.content.length, 0) +
        reply.length;
      tokens = Math.ceil(chars / 4);
    }

    // Bitácora de consumo (best-effort: no altera la respuesta).
    try {
      await admin.from("ai_usage").insert({
        tenant_id: tenantId,
        user_id: user.id,
        provider,
        tokens,
      });
    } catch (_) {
      /* noop */
    }

    return json({
      reply: reply.trim(),
      quota: { used: usedTokens + tokens, cap: MONTHLY_TOKEN_CAP },
    });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});

// Construye el bloque de contexto del negocio. Todo READ-ONLY y scoped al tenant
// vía service_role (filtros explícitos por tenant_id). Funciones predefinidas,
// nunca SQL libre.
async function buildContext(
  // deno-lint-ignore no-explicit-any
  admin: any,
  tenantId: string,
): Promise<string> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lines: string[] = [];

  try {
    // Ventas de hoy (completadas).
    const { data: todaySales } = await admin
      .from("sales")
      .select("total")
      .eq("tenant_id", tenantId)
      .eq("status", "completed")
      .gte("created_at", todayStart.toISOString());
    const todayCount = todaySales?.length ?? 0;
    const todayTotal = (todaySales ?? []).reduce(
      (a: number, s: { total?: number }) => a + (Number(s.total) || 0),
      0,
    );
    lines.push(
      `Ventas de hoy: ${todayCount} ventas por $${todayTotal.toFixed(2)}.`,
    );

    // Ventas últimos 7 días.
    const { data: weekSales } = await admin
      .from("sales")
      .select("total")
      .eq("tenant_id", tenantId)
      .eq("status", "completed")
      .gte("created_at", weekStart.toISOString());
    const weekCount = weekSales?.length ?? 0;
    const weekTotal = (weekSales ?? []).reduce(
      (a: number, s: { total?: number }) => a + (Number(s.total) || 0),
      0,
    );
    lines.push(
      `Ventas últimos 7 días: ${weekCount} ventas por $${weekTotal.toFixed(2)}.`,
    );

    // Top 5 productos (por cantidad) en los últimos 7 días.
    const { data: items } = await admin
      .from("sale_items")
      .select("product_name, quantity, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", weekStart.toISOString())
      .limit(2000);
    const agg = new Map<string, number>();
    for (const it of items ?? []) {
      const name = String((it as { product_name?: string }).product_name ?? "")
        .trim();
      if (!name) continue;
      const qty = Number((it as { quantity?: number }).quantity) || 0;
      agg.set(name, (agg.get(name) ?? 0) + qty);
    }
    const top = [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => `${name} (${qty})`);
    lines.push(
      top.length
        ? `Top productos (7 días): ${top.join(", ")}.`
        : "Top productos (7 días): sin ventas registradas.",
    );

    // Productos con stock bajo (stock <= stock_min).
    const { data: lowStock } = await admin
      .from("products")
      .select("name, stock, stock_min")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .limit(500);
    const low = (lowStock ?? [])
      .filter(
        (p: { stock?: number; stock_min?: number }) =>
          Number(p.stock_min) > 0 && Number(p.stock) <= Number(p.stock_min),
      )
      .slice(0, 10)
      .map(
        (p: { name?: string; stock?: number }) => `${p.name} (${p.stock})`,
      );
    lines.push(
      low.length
        ? `Productos con stock bajo: ${low.join(", ")}.`
        : "Productos con stock bajo: ninguno.",
    );

    // Estado de configuración.
    const { data: ticket } = await admin
      .from("ticket_templates")
      .select("id")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .eq("is_default", true)
      .limit(1)
      .maybeSingle();
    const { data: mp } = await admin
      .from("tenant_payment_methods")
      .select("enabled")
      .eq("tenant_id", tenantId)
      .eq("provider_key", "mercadopago")
      .maybeSingle();
    const { data: smtp } = await admin
      .from("tenant_email_smtp")
      .select("host")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    lines.push(
      `Config: ticket de impresión ${ticket ? "configurado" : "sin configurar"}; ` +
        `Mercado Pago ${mp?.enabled ? "habilitado" : "deshabilitado"}; ` +
        `email de comprobantes ${
          smtp?.host ? "configurado" : "sin configurar"
        }.`,
    );
  } catch (e) {
    lines.push("(No se pudo cargar parte del contexto del negocio.)");
    console.error("buildContext error:", e);
  }

  return lines.join("\n");
}
