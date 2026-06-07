// =============================================================================
// Edge Function: ai_assistant — Asistente IA del POS (Fase F).
//
// POST { messages: [{role, content}] } → { reply }
//
// Guard (server-side, todo vía service_role admin):
//   allowed = addon asistente_ia/ai_assistant activo para el tenant
//             OR el owner del tenant == ai_config.beta_owner_email.
//   Si no → 403 { error: 'addon_required' }.
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

    const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
      ?.current_tenant_id;
    if (!tenantId) return json({ error: "no_tenant" }, 400);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // ── Guard server-side (todo con service_role) ───────────────────────────
    // 1) addon activo (asistente_ia | ai_assistant).
    const { data: addon } = await admin
      .from("subscription_addons")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("addon_key", ["asistente_ia", "ai_assistant"])
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    let allowed = Boolean(addon);

    // Config IA (se necesita para el guard de beta y para llamar al proveedor).
    const { data: cfgRow } = await admin
      .from("platform_secrets")
      .select("secrets")
      .eq("key", "ai_config")
      .maybeSingle();
    const cfg = (cfgRow?.secrets ?? {}) as Record<string, string>;
    const betaEmail = (cfg.beta_owner_email ?? "").trim().toLowerCase();

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
      return json(
        {
          error: "addon_required",
          detail: "El Asistente IA es un complemento. Activalo desde tu plan.",
        },
        403,
      );
    }

    // ── Config del proveedor ────────────────────────────────────────────────
    const provider = (cfg.provider === "claude" ? "claude" : "gemini") as
      | "gemini"
      | "claude";
    const model =
      (cfg.model ?? "").trim() ||
      (provider === "claude" ? "claude-haiku-4-5-20251001" : "gemini-2.0-flash");
    const apiKey = (cfg.api_key ?? "").trim();
    if (!apiKey) return json({ error: "ai_not_configured" }, 400);

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

    // ── Body ────────────────────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
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
    let reply = "";
    let tokens = 0;
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
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          }),
        }),
        30_000,
        "claude",
      );
      if (!r.ok) {
        const detail = (await r.text()).slice(0, 500);
        return json({ error: "provider_error", detail }, 502);
      }
      const data = (await r.json()) as {
        content?: { text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      reply = data.content?.[0]?.text ?? "";
      tokens =
        (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);
    } else {
      // Gemini: el system va en systemInstruction; el historial en contents.
      const r = await withTimeout(
        fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model,
          )}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: messages.map((m) => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }],
              })),
            }),
          },
        ),
        30_000,
        "gemini",
      );
      if (!r.ok) {
        const detail = (await r.text()).slice(0, 500);
        return json({ error: "provider_error", detail }, 502);
      }
      const data = (await r.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { totalTokenCount?: number };
      };
      reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      tokens = data.usageMetadata?.totalTokenCount ?? 0;
    }

    if (!reply.trim()) return json({ error: "empty_reply" }, 502);

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
