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
// Modo TEST (staff interno, body {test:true}): responde SIEMPRE 200 con un
// sobre { ok }. Si el proveedor falla → { ok:false, error, detail } con el
// motivo real; si anda → { ok:true, reply }. Así el panel interno muestra la
// causa (invoke colapsa cualquier non-2xx a un error genérico sin cuerpo). El
// chat real (no-test) NO cambia: sigue 502 ante error del proveedor.
//
// Contexto READ-ONLY scoped por tenant (nunca SQL libre): snapshot agregado de
// catálogo (cant. de productos, stock bajo, valor de inventario), clientes y
// complementos activos vía RPC ai_tenant_snapshot (COUNT/SUM en SQL, cero filas
// transferidas — seguro con cientos de miles de productos); ventas hoy/7d, mes
// en curso vs mes anterior + ticket promedio, medios de pago, cuenta corriente
// (deudores), estado de caja, devoluciones, suscripción, top productos, stock
// bajo y estado de config. + guía fija de pantallas. System prompt cerrado al
// POS. Proveedor Gemini | Claude según ai_config. Cuota mensual por tenant
// configurable (ai_config.monthly_quota, ai_usage). NO deployar (lo hace el
// controller).
//
// FUNCTION-CALLING (Gemini): además del contexto base, el chat real con Gemini
// expone un catálogo CURADO de herramientas de SOLO LECTURA (RPCs ai_*, todas
// tenant-scoped y EXECUTE solo service_role) para drill-down: search_products,
// sales_summary, top_products, list_customers, cash_status, stock_report,
// business_overview. Loop multi-turno (cap 5): si el modelo responde
// functionCall, la edge fn ejecuta la RPC con su admin client pasando SIEMPRE el
// tenant_id resuelto SERVER-SIDE (jamás del modelo) y devuelve functionResponse;
// repite hasta texto final. Ninguna tool toca datos sensibles (platform_secrets,
// tokens/credenciales de Mercado Pago, claves, contraseñas, datos de otros
// tenants). Respuesta incluye tools_used. (Claude usa solo el contexto base.)
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

// Tope mensual de tokens por tenant (estimado), POR DEFECTO. Por encima → 429.
// Configurable por NinjaSoft vía ai_config.monthly_quota (número). Si la config
// trae un valor válido (>0), gana sobre este default.
const DEFAULT_MONTHLY_TOKEN_CAP = 500_000;

// Resuelve el tope mensual de tokens desde ai_config (monthly_quota). Acepta el
// valor como número o string numérico; cualquier cosa inválida/≤0 cae al default.
function resolveMonthlyCap(cfg: Record<string, unknown>): number {
  const raw = cfg.monthly_quota;
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MONTHLY_TOKEN_CAP;
}

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

// =============================================================================
// Function-calling (tool use) de Gemini — acceso de SOLO LECTURA a TODOS los
// datos NO sensibles del negocio del tenant.
//
// Catálogo CURADO de herramientas read-only. Cada una mapea a una RPC `ai_*`
// (SECURITY DEFINER, EXECUTE solo service_role, scoped por p_tenant_id) que se
// invoca con el admin client de la edge function pasando SIEMPRE el tenant_id
// resuelto SERVER-SIDE del usuario autenticado — NUNCA un tenant que venga del
// modelo. El modelo solo elige QUÉ tool y con qué parámetros SEGUROS (query
// string, period, limit, flags booleanos). Ninguna tool toca platform_secrets,
// tokens/credenciales de Mercado Pago, claves API, contraseñas ni datos de
// otros tenants. Límites clampeados también en SQL (defensa en profundidad).
// =============================================================================

// Declaraciones de funciones para Gemini (subset del schema OpenAPI). El
// tenant_id NO es un parámetro: lo inyecta la edge function server-side.
const TOOL_DECLARATIONS = [
  {
    name: "search_products",
    description:
      "Busca productos del catálogo del negocio por nombre, SKU o código de " +
      "barras. Devuelve nombre, precio, costo, stock, stock mínimo, categoría y " +
      "código de barras. Usala para preguntas sobre un producto puntual, su " +
      "precio o su stock. Máximo 25 resultados.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Texto a buscar en nombre/SKU/código de barras. Vacío para listar.",
        },
        only_low_stock: {
          type: "boolean",
          description: "Si es true, solo productos con stock bajo el mínimo.",
        },
        limit: { type: "integer", description: "Cantidad de filas (1-50)." },
      },
    },
  },
  {
    name: "sales_summary",
    description:
      "Resumen de ventas (cantidad, monto total y ticket promedio) para un " +
      "período. Opcionalmente desglosa por día, por medio de pago o por " +
      "categoría de producto. Usala para '¿cuánto vendí hoy/esta semana/este " +
      "mes?' y comparativas.",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description: "Período: today, yesterday, week (7 días) o month.",
          enum: ["today", "yesterday", "week", "month"],
        },
        group_by: {
          type: "string",
          description:
            "Desglose opcional: day, payment_method o category. Omitir para totales.",
          enum: ["day", "payment_method", "category"],
        },
      },
    },
  },
  {
    name: "top_products",
    description:
      "Productos más vendidos (por unidades) en un período, con unidades y " +
      "monto. Usala para '¿qué es lo que más vendo?'.",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description: "Período: today, yesterday, week o month.",
          enum: ["today", "yesterday", "week", "month"],
        },
        limit: { type: "integer", description: "Cantidad de productos (1-50)." },
      },
    },
  },
  {
    name: "list_customers",
    description:
      "Lista clientes con su saldo de cuenta corriente (positivo = debe) y " +
      "contacto (email/teléfono). Usala para deudores, saldo de un cliente o " +
      "buscar un cliente por nombre. Máximo 25 resultados.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Buscar por nombre del cliente." },
        only_debtors: {
          type: "boolean",
          description: "Si es true, solo clientes con saldo deudor.",
        },
        limit: { type: "integer", description: "Cantidad de filas (1-50)." },
      },
    },
  },
  {
    name: "cash_status",
    description:
      "Estado de la caja: turnos abiertos, monto de apertura y efectivo " +
      "esperado en caja (apertura + ingresos − egresos + ventas en efectivo). " +
      "Usala para '¿cómo está la caja?' o '¿cuánto debería tener en caja?'.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "stock_report",
    description:
      "Reporte de stock: valor de inventario a costo y a precio de venta, " +
      "cantidad de productos con stock bajo y un detalle de productos (los de " +
      "menor stock primero). Usala para inventario y faltantes.",
    parameters: {
      type: "object",
      properties: {
        only_low: {
          type: "boolean",
          description: "Si es true, solo productos con stock bajo el mínimo.",
        },
        limit: { type: "integer", description: "Cantidad de filas (1-50)." },
      },
    },
  },
  {
    name: "business_overview",
    description:
      "Panorama general del negocio: cantidad de productos activos, productos " +
      "con stock bajo, valor de inventario, cantidad de clientes y complementos " +
      "activos. Usala como vista global antes de profundizar.",
    parameters: { type: "object", properties: {} },
  },
];

// Periodos válidos para las tools de ventas (defensa: si el modelo manda algo
// raro, la RPC igual cae a un default seguro, pero clampeamos acá también).
const VALID_PERIODS = new Set(["today", "yesterday", "week", "month"]);
const VALID_GROUP_BY = new Set(["day", "payment_method", "category"]);

// Clampa un límite numérico propuesto por el modelo a [1, 50] con un default.
function clampLimit(raw: unknown, def: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, 50);
}

// Ejecuta la tool pedida por el modelo contra su RPC `ai_*`. SIEMPRE inyecta el
// `tenantId` resuelto server-side; el modelo NUNCA puede elegir el tenant. Los
// parámetros del modelo se sanean (query truncada, period/group_by validados,
// limit clampeado) antes de tocar la base. Devuelve el jsonb del RPC o un sobre
// { error } legible (que también se le pasa al modelo como functionResponse).
async function runTool(
  // deno-lint-ignore no-explicit-any
  admin: any,
  tenantId: string,
  name: string,
  // deno-lint-ignore no-explicit-any
  args: Record<string, any>,
): Promise<unknown> {
  const a = args ?? {};
  const query =
    typeof a.query === "string" ? a.query.slice(0, 120).trim() || null : null;
  try {
    switch (name) {
      case "search_products": {
        const { data, error } = await admin.rpc("ai_search_products", {
          p_tenant_id: tenantId,
          p_query: query,
          p_only_low_stock: a.only_low_stock === true,
          p_limit: clampLimit(a.limit, 25),
        });
        if (error) throw error;
        return data;
      }
      case "sales_summary": {
        const period = VALID_PERIODS.has(String(a.period))
          ? String(a.period)
          : "today";
        const groupBy = VALID_GROUP_BY.has(String(a.group_by))
          ? String(a.group_by)
          : null;
        const { data, error } = await admin.rpc("ai_sales_summary", {
          p_tenant_id: tenantId,
          p_period: period,
          p_group_by: groupBy,
        });
        if (error) throw error;
        return data;
      }
      case "top_products": {
        const period = VALID_PERIODS.has(String(a.period))
          ? String(a.period)
          : "week";
        const { data, error } = await admin.rpc("ai_top_products", {
          p_tenant_id: tenantId,
          p_period: period,
          p_limit: clampLimit(a.limit, 10),
        });
        if (error) throw error;
        return data;
      }
      case "list_customers": {
        const { data, error } = await admin.rpc("ai_list_customers", {
          p_tenant_id: tenantId,
          p_query: query,
          p_only_debtors: a.only_debtors === true,
          p_limit: clampLimit(a.limit, 25),
        });
        if (error) throw error;
        return data;
      }
      case "cash_status": {
        const { data, error } = await admin.rpc("ai_cash_status", {
          p_tenant_id: tenantId,
        });
        if (error) throw error;
        return data;
      }
      case "stock_report": {
        const { data, error } = await admin.rpc("ai_stock_report", {
          p_tenant_id: tenantId,
          p_only_low: a.only_low === true,
          p_limit: clampLimit(a.limit, 25),
        });
        if (error) throw error;
        return data;
      }
      case "business_overview": {
        const { data, error } = await admin.rpc("ai_business_overview", {
          p_tenant_id: tenantId,
        });
        if (error) throw error;
        return data;
      }
      default:
        return { error: `tool_desconocida: ${name}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`runTool ${name} failed:`, msg);
    return { error: "No se pudo obtener el dato.", detail: msg.slice(0, 200) };
  }
}

// Tipos mínimos del wire de Gemini (contents/parts) para el loop con tools.
type GeminiPart = {
  text?: string;
  functionCall?: { name: string; id?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; id?: string; response: unknown };
};
type GeminiContent = { role: string; parts: GeminiPart[] };

// Resultado del loop de function-calling: texto final + qué tools se usaron +
// tokens acumulados de todas las vueltas.
type ToolLoopResult =
  | { ok: true; reply: string; tokens: number; toolsUsed: string[] }
  | { ok: false; status: number; error: string; detail: string };

// Loop multi-turno de function-calling de Gemini (cap 5 iteraciones). En cada
// vuelta: manda contents + tools; si el modelo responde con functionCall(s),
// ejecuta la(s) RPC(s) con el tenantId server-side, agrega el turno del modelo
// y el turno role:"user" con los functionResponse, y repite. Cuando el modelo
// devuelve texto (sin functionCall), termina. Misma robustez que callProvider
// (non-2xx, cuerpo inesperado, timeout → ai_provider_error). El tope de
// iteraciones evita loops infinitos si el modelo insiste en llamar tools.
async function callGeminiWithTools(
  // deno-lint-ignore no-explicit-any
  admin: any,
  tenantId: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  messages: { role: string; content: string }[],
): Promise<ToolLoopResult> {
  const contents: GeminiContent[] = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const toolsUsed: string[] = [];
  let tokens = 0;
  const MAX_ITERS = 5;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let r: Response;
    try {
      r = await withTimeout(
        fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model,
          )}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents,
              tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
              generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
            }),
          },
        ),
        30_000,
        "gemini",
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("gemini(tools) fetch failed:", detail);
      return { ok: false, status: 502, error: "ai_provider_error", detail: detail.slice(0, 300) };
    }
    if (!r.ok) {
      const detail = providerErrText(await safeText(r), model);
      console.error("gemini(tools) non-200:", r.status, detail);
      return { ok: false, status: 502, error: "ai_provider_error", detail };
    }
    const data = (await safeJson(r)) as {
      candidates?: {
        content?: { parts?: GeminiPart[]; role?: string };
        finishReason?: string;
      }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { totalTokenCount?: number };
    } | null;
    tokens += data?.usageMetadata?.totalTokenCount ?? 0;
    const cand = data?.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (calls.length === 0) {
      // No hay tool: respuesta final en texto.
      const text = parts.map((p) => p.text ?? "").join("").trim();
      if (!text) {
        const reason =
          data?.promptFeedback?.blockReason || cand?.finishReason || "sin_contenido";
        console.error("gemini(tools) empty:", reason);
        return {
          ok: false,
          status: 502,
          error: "ai_provider_error",
          detail: `El proveedor no devolvió texto (motivo: ${reason}).`,
        };
      }
      return { ok: true, reply: text, tokens, toolsUsed };
    }

    // El modelo pidió una o más tools: las ejecutamos y respondemos.
    contents.push({ role: "model", parts });
    const responseParts: GeminiPart[] = [];
    for (const p of calls) {
      const fc = p.functionCall!;
      toolsUsed.push(fc.name);
      const result = await runTool(admin, tenantId, fc.name, fc.args ?? {});
      responseParts.push({
        functionResponse: {
          name: fc.name,
          ...(fc.id ? { id: fc.id } : {}),
          // Gemini espera response como objeto; envolvemos en { result }.
          response: { result },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  // Se agotaron las iteraciones sin texto final: cortamos con un aviso claro en
  // vez de dejar al usuario sin respuesta.
  console.error("gemini(tools) max iters reached");
  return {
    ok: false,
    status: 502,
    error: "ai_provider_error",
    detail: "El asistente consultó varios datos pero no cerró una respuesta. Probá reformular.",
  };
}

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
    // proveedor activo con su api_key. No registra consumo (no hay tenant).
    //
    // IMPORTANTE: este path SIEMPRE responde 200 con un sobre { ok }. Si el
    // proveedor falla, devuelve 200 { ok:false, error, detail } con el MOTIVO
    // real (ej. "API key not valid"). Esto es a propósito: supabase.functions
    // .invoke trata cualquier non-2xx como un error genérico ("Edge Function
    // returned a non-2xx status code") y pierde el cuerpo, así que el staff
    // nunca veía la causa. Devolviendo 200 con { ok:false }, el cliente lee el
    // detalle. (El chat real —no-test— sigue devolviendo 502 ante error.)
    if (body.test === true) {
      if (!isInternal) return json({ ok: false, error: "forbidden" }, 200);
      const { data: cfgRow } = await admin
        .from("platform_secrets")
        .select("secrets")
        .eq("key", "ai_config")
        .maybeSingle();
      const cfg = (cfgRow?.secrets ?? {}) as Record<string, string>;
      const { provider, model, apiKey } = resolveProviderConfig(cfg);
      if (!apiKey) {
        return json({
          ok: false,
          error: "ai_not_configured",
          detail: `Falta la API key de ${provider}.`,
        });
      }
      const testMessages = [{ role: "user", content: "ping" }];
      const systemPrompt =
        "Sos el asistente de NinjaPos. Esto es una prueba de conexión del panel " +
        "interno. Respondé en una sola línea breve confirmando que estás operativo.";
      const out = await callProvider(provider, model, apiKey, systemPrompt, testMessages);
      if (!out.ok) {
        return json({ ok: false, error: out.error, detail: out.detail });
      }
      return json({ ok: true, reply: out.reply.trim() || "OK", provider, model });
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
    // Tope configurable por NinjaSoft (ai_config.monthly_quota); fallback 500k.
    const monthlyCap = resolveMonthlyCap(cfg);
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
    if (usedTokens >= monthlyCap) {
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

    // Solo Gemini tiene function-calling habilitado (tools de drill-down). Con
    // Claude se usa el contexto base (single-shot). Lo anticipamos para ajustar
    // el system prompt: con tools, le indicamos que puede consultar datos finos.
    const useTools = provider === "gemini";

    const systemPrompt =
      "Sos el asistente de NinjaPos, un sistema POS. Respondé SOLO sobre el uso " +
      "del sistema y los datos del negocio. No inventes datos. Español " +
      "rioplatense. Si te preguntan algo fuera del POS, redirigí amablemente. " +
      "Usá '•' no '—'.\n\n" +
      (useTools
        ? "Tenés HERRAMIENTAS de solo lectura para consultar datos reales del " +
          "negocio cuando el contexto no alcanza: search_products (buscar " +
          "productos/precio/stock), sales_summary (ventas por período, con " +
          "desglose por día/medio de pago/categoría), top_products (más " +
          "vendidos), list_customers (clientes y deudas), cash_status (caja) y " +
          "stock_report (inventario). Usalas para preguntas puntuales (un " +
          "producto, un cliente, un período específico). Para panoramas generales " +
          "alcanza con el contexto de abajo. Nunca inventes números: si no los " +
          "tenés, usá una herramienta o decí que no hay datos.\n\n"
        : "") +
      "=== CONTEXTO DEL NEGOCIO ===\n" +
      context +
      "\n\n=== GUÍA DE PANTALLAS ===\n" +
      HELP_GUIDE;

    // ── Llamada al proveedor ────────────────────────────────────────────────
    // Gemini: loop de function-calling (cap 5) — el modelo puede pedir tools de
    // solo lectura (RPCs ai_*) que se ejecutan con el tenantId server-side.
    // Claude: single-shot con contexto base. En ambos casos la robustez
    // (non-2xx, cuerpo inesperado, timeout) se traduce a ai_provider_error (502)
    // sin dejar escapar throws al runtime.
    const out = useTools
      ? await callGeminiWithTools(
          admin,
          tenantId,
          model,
          apiKey,
          systemPrompt,
          messages,
        )
      : await callProvider(provider, model, apiKey, systemPrompt, messages);
    if (!out.ok) {
      return json({ error: out.error, detail: out.detail }, out.status);
    }
    const reply = out.reply;
    let tokens = out.tokens;
    // Tools usadas (únicas) en esta respuesta, para microcopy en el front.
    const toolsUsed =
      "toolsUsed" in out ? [...new Set(out.toolsUsed)] : [];

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

    // Bitácora de consumo (best-effort: no altera la respuesta del chat).
    // OJO: supabase-js NO tira en error de DB; devuelve { error }. Por eso el
    // try/catch viejo nunca se disparaba y un fallo de insert quedaba invisible
    // (ai_usage en 0). Chequeamos el .error explícitamente y lo logueamos para
    // que cualquier rechazo (RLS, FK, etc.) aparezca en los logs de la función.
    try {
      const { error: usageErr } = await admin.from("ai_usage").insert({
        tenant_id: tenantId,
        user_id: user.id,
        provider,
        tokens,
      });
      if (usageErr) {
        console.error("ai_usage insert failed:", usageErr.message ?? usageErr);
      }
    } catch (e) {
      console.error("ai_usage insert threw:", e instanceof Error ? e.message : e);
    }

    return json({
      reply: reply.trim(),
      quota: { used: usedTokens + tokens, cap: monthlyCap },
      // Nombres de las tools consultadas (vacío si respondió solo con contexto).
      // El front lo usa para un microcopy "consulté tus datos".
      tools_used: toolsUsed,
    });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});

// Formatea un monto como pesos AR sin decimales (contexto compacto para el LLM).
function ars(n: number): string {
  return `$${Math.round(Number(n) || 0).toLocaleString("es-AR")}`;
}

// Variación porcentual de `cur` respecto de `prev`, como texto legible.
function pctText(cur: number, prev: number): string {
  if (prev <= 0) return cur > 0 ? "sin base de comparación" : "sin cambios";
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}% vs mes anterior`;
}

// Construye el bloque de contexto del negocio. Todo READ-ONLY y scoped al tenant
// vía service_role (filtros explícitos por tenant_id). Funciones predefinidas,
// nunca SQL libre. Cada bloque va en su propio try/catch: un fallo aislado deja
// una línea de aviso pero NO tumba el resto del contexto. Formato compacto para
// no inflar el prompt (montos sin decimales, una línea por métrica).
async function buildContext(
  // deno-lint-ignore no-explicit-any
  admin: any,
  tenantId: string,
): Promise<string> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const days30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  // Mes en curso (UTC) y mes anterior, para la comparación.
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const prevMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );
  const lines: string[] = [];

  // ── Snapshot de catálogo / clientes / addons (agregados en SQL) ───────────
  // Todo se calcula con COUNT/SUM dentro del RPC ai_tenant_snapshot (cero filas
  // transferidas): seguro para tenants con cientos de miles de productos.
  // Responde "¿cuántos productos tengo?", stock bajo, valor de inventario,
  // cantidad de clientes y addons activos.
  try {
    const { data: snap, error: snapErr } = await admin.rpc("ai_tenant_snapshot", {
      p_tenant_id: tenantId,
    });
    if (snapErr) throw snapErr;
    const s = (snap ?? {}) as {
      products_active?: number;
      low_stock?: number;
      inventory_value_cost?: number;
      inventory_value_sale?: number;
      customers_active?: number;
      active_addons?: string[];
    };
    const prods = Number(s.products_active) || 0;
    const low = Number(s.low_stock) || 0;
    const invCost = Number(s.inventory_value_cost) || 0;
    const invSale = Number(s.inventory_value_sale) || 0;
    lines.push(
      `Catálogo: ${prods} productos activos cargados` +
        (low > 0 ? `, ${low} con stock bajo` : "") +
        `. Valor de inventario: ${ars(invCost)} a costo / ${ars(invSale)} a precio de venta.`,
    );
    lines.push(`Clientes: ${Number(s.customers_active) || 0} clientes cargados.`);

    // Addons activos: traducimos las claves a etiquetas legibles vía plan_addons.
    const addonKeys = Array.isArray(s.active_addons)
      ? s.active_addons.map((k) => String(k)).filter(Boolean)
      : [];
    if (addonKeys.length === 0) {
      lines.push("Complementos activos: ninguno.");
    } else {
      const { data: addonRows } = await admin
        .from("plan_addons")
        .select("key, label")
        .in("key", addonKeys);
      const labelByKey = new Map<string, string>();
      for (const a of addonRows ?? []) {
        labelByKey.set(
          String((a as { key?: string }).key ?? ""),
          String((a as { label?: string }).label ?? ""),
        );
      }
      const names = addonKeys.map((k) => labelByKey.get(k) || k);
      lines.push(`Complementos activos: ${names.join(", ")}.`);
    }
  } catch (e) {
    lines.push("(No se pudo cargar el resumen de catálogo y clientes.)");
    console.error("buildContext snapshot error:", e);
  }

  // ── Ventas hoy / 7 días ───────────────────────────────────────────────────
  try {
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
    lines.push(`Ventas de hoy: ${todayCount} ventas por ${ars(todayTotal)}.`);

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
      `Ventas últimos 7 días: ${weekCount} ventas por ${ars(weekTotal)}.`,
    );
  } catch (e) {
    lines.push("(No se pudieron cargar las ventas recientes.)");
    console.error("buildContext sales(day/week) error:", e);
  }

  // ── Ventas del mes en curso vs mes anterior + ticket promedio ─────────────
  try {
    // Mes en curso (desde el día 1 hasta ahora).
    const { data: monthSales } = await admin
      .from("sales")
      .select("total")
      .eq("tenant_id", tenantId)
      .eq("status", "completed")
      .gte("created_at", monthStart.toISOString());
    const monthCount = monthSales?.length ?? 0;
    const monthTotal = (monthSales ?? []).reduce(
      (a: number, s: { total?: number }) => a + (Number(s.total) || 0),
      0,
    );
    // Mismo tramo del mes anterior (día 1 → mismo "ahora" desplazado un mes), para
    // comparar manzanas con manzanas (mes corriente parcial vs igual tramo previo).
    const prevCutoff = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - 1,
        now.getUTCDate(),
        now.getUTCHours(),
        now.getUTCMinutes(),
        now.getUTCSeconds(),
      ),
    );
    const { data: prevSales } = await admin
      .from("sales")
      .select("total")
      .eq("tenant_id", tenantId)
      .eq("status", "completed")
      .gte("created_at", prevMonthStart.toISOString())
      .lt("created_at", prevCutoff.toISOString());
    const prevTotal = (prevSales ?? []).reduce(
      (a: number, s: { total?: number }) => a + (Number(s.total) || 0),
      0,
    );
    const avgTicket = monthCount > 0 ? monthTotal / monthCount : 0;
    lines.push(
      `Ventas del mes en curso: ${monthCount} ventas por ${ars(monthTotal)} ` +
        `(${pctText(monthTotal, prevTotal)}; mismo tramo mes anterior ` +
        `${ars(prevTotal)}). Ticket promedio del mes: ${ars(avgTicket)}.`,
    );
  } catch (e) {
    lines.push("(No se pudo cargar el comparativo mensual.)");
    console.error("buildContext month error:", e);
  }

  // ── Ventas por medio de pago (últimos 7 días) ─────────────────────────────
  // payments.method es el detalle por medio de pago. Filtramos por created_at
  // del pago (aprox.: incluye pagos de ventas luego anuladas, marginal en este
  // contexto orientativo). Etiquetas legibles en español.
  try {
    const methodLabels: Record<string, string> = {
      cash: "Efectivo",
      debit: "Débito",
      credit: "Crédito",
      transfer: "Transferencia",
      qr: "QR / Mercado Pago",
      store_credit: "Crédito en tienda",
      account: "Cuenta corriente",
      other: "Otros",
    };
    const { data: pays } = await admin
      .from("payments")
      .select("method, amount")
      .eq("tenant_id", tenantId)
      .gte("created_at", weekStart.toISOString())
      .limit(5000);
    const byMethod = new Map<string, number>();
    for (const p of pays ?? []) {
      const m = String((p as { method?: string }).method ?? "other");
      byMethod.set(
        m,
        (byMethod.get(m) ?? 0) + (Number((p as { amount?: number }).amount) || 0),
      );
    }
    const parts = [...byMethod.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, amt]) => `${methodLabels[m] ?? m} ${ars(amt)}`);
    lines.push(
      parts.length
        ? `Ventas por medio de pago (7 días): ${parts.join(", ")}.`
        : "Ventas por medio de pago (7 días): sin pagos registrados.",
    );
  } catch (e) {
    lines.push("(No se pudieron cargar los medios de pago.)");
    console.error("buildContext payments error:", e);
  }

  // ── Top 5 productos por cantidad (últimos 7 días) ─────────────────────────
  try {
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
  } catch (e) {
    lines.push("(No se pudieron cargar los productos más vendidos.)");
    console.error("buildContext top products error:", e);
  }

  // ── Productos con stock bajo (stock <= stock_min) ─────────────────────────
  // El CONTEO global ya viene del snapshot (RPC). Acá solo listamos NOMBRES de
  // hasta 10 para dar color; ventana acotada (500 filas) para no inflar.
  try {
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
      .map((p: { name?: string; stock?: number }) => `${p.name} (${p.stock})`);
    lines.push(
      low.length
        ? `Detalle de stock bajo (muestra): ${low.join(", ")}.`
        : "Detalle de stock bajo: sin productos por debajo del mínimo.",
    );
  } catch (e) {
    lines.push("(No se pudo cargar el detalle de stock bajo.)");
    console.error("buildContext low stock error:", e);
  }

  // ── Cuenta corriente: top clientes con saldo deudor ───────────────────────
  // Saldo (deuda) por cliente = sum(delta) en customer_account_movements
  // (delta>0 fía, delta<0 paga). Reportamos los de saldo positivo, ordenados.
  try {
    const { data: movs } = await admin
      .from("customer_account_movements")
      .select("customer_id, delta, due_date")
      .eq("tenant_id", tenantId)
      .limit(10000);
    const balByCustomer = new Map<string, number>();
    const overdueByCustomer = new Map<string, boolean>();
    const todayDateStr = now.toISOString().slice(0, 10);
    for (const m of movs ?? []) {
      const cid = String((m as { customer_id?: string }).customer_id ?? "");
      if (!cid) continue;
      const delta = Number((m as { delta?: number }).delta) || 0;
      balByCustomer.set(cid, (balByCustomer.get(cid) ?? 0) + delta);
      const due = (m as { due_date?: string | null }).due_date;
      // Cargo vencido = delta>0 con due_date pasada (señal de mora).
      if (delta > 0 && due && due < todayDateStr) overdueByCustomer.set(cid, true);
    }
    const debtors = [...balByCustomer.entries()].filter(([, bal]) => bal > 0.5);
    const totalDebt = debtors.reduce((a, [, bal]) => a + bal, 0);
    if (debtors.length === 0) {
      lines.push("Cuenta corriente: sin clientes con saldo deudor.");
    } else {
      const topDebtors = debtors.sort((a, b) => b[1] - a[1]).slice(0, 8);
      const ids = topDebtors.map(([cid]) => cid);
      const { data: custs } = await admin
        .from("customers")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .in("id", ids);
      const nameById = new Map<string, string>();
      for (const c of custs ?? []) {
        nameById.set(
          String((c as { id?: string }).id ?? ""),
          String((c as { name?: string }).name ?? "Cliente"),
        );
      }
      const parts = topDebtors.map(([cid, bal]) => {
        const overdue = overdueByCustomer.get(cid) ? " (vencido)" : "";
        return `${nameById.get(cid) ?? "Cliente"} ${ars(bal)}${overdue}`;
      });
      lines.push(
        `Cuenta corriente: ${debtors.length} clientes deben ${ars(totalDebt)} ` +
          `en total. Top deudores: ${parts.join(", ")}.`,
      );
    }
  } catch (e) {
    lines.push("(No se pudo cargar la cuenta corriente.)");
    console.error("buildContext account movements error:", e);
  }

  // ── Estado de caja: turno abierto y saldo de efectivo esperado ────────────
  // Saldo efectivo del turno = apertura + ingresos − egresos + ventas cash −
  // anulaciones cash (mismo cálculo que close_cash_shift / módulo cash).
  try {
    const { data: openShifts } = await admin
      .from("cash_shifts")
      .select("id, opening_amount, opened_at")
      .eq("tenant_id", tenantId)
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .limit(5);
    if (!openShifts || openShifts.length === 0) {
      lines.push("Caja: no hay turno abierto en este momento.");
    } else {
      const shiftIds = openShifts.map((s: { id: string }) => s.id);
      const { data: mvs } = await admin
        .from("cash_movements")
        .select("cash_shift_id, type, amount, payment_method")
        .eq("tenant_id", tenantId)
        .in("cash_shift_id", shiftIds)
        .limit(10000);
      const expectedByShift = new Map<string, number>();
      for (const s of openShifts) {
        expectedByShift.set(s.id, Number(s.opening_amount) || 0);
      }
      for (const m of mvs ?? []) {
        const sid = String((m as { cash_shift_id?: string }).cash_shift_id ?? "");
        if (!expectedByShift.has(sid)) continue;
        const type = String((m as { type?: string }).type ?? "");
        const amt = Number((m as { amount?: number }).amount) || 0;
        const pm = String((m as { payment_method?: string }).payment_method ?? "");
        let delta = 0;
        if (type === "income") delta = amt;
        else if (type === "expense") delta = -amt;
        else if (type === "sale" && pm === "cash") delta = amt;
        else if (type === "sale_void" && pm === "cash") delta = -amt;
        expectedByShift.set(sid, (expectedByShift.get(sid) ?? 0) + delta);
      }
      const total = [...expectedByShift.values()].reduce((a, b) => a + b, 0);
      lines.push(
        `Caja: ${openShifts.length} turno(s) abierto(s). ` +
          `Efectivo esperado en caja: ${ars(total)}.`,
      );
    }
  } catch (e) {
    lines.push("(No se pudo cargar el estado de caja.)");
    console.error("buildContext cash error:", e);
  }

  // ── Devoluciones recientes (7 y 30 días) ──────────────────────────────────
  try {
    const { data: rets } = await admin
      .from("sale_returns")
      .select("total, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", days30Start.toISOString())
      .limit(5000);
    let c7 = 0;
    let t7 = 0;
    let c30 = 0;
    let t30 = 0;
    const week = weekStart.getTime();
    for (const r of rets ?? []) {
      const amt = Number((r as { total?: number }).total) || 0;
      const ts = new Date(
        String((r as { created_at?: string }).created_at ?? ""),
      ).getTime();
      c30 += 1;
      t30 += amt;
      if (ts >= week) {
        c7 += 1;
        t7 += amt;
      }
    }
    lines.push(
      `Devoluciones: ${c7} por ${ars(t7)} en 7 días; ` +
        `${c30} por ${ars(t30)} en 30 días.`,
    );
  } catch (e) {
    lines.push("(No se pudieron cargar las devoluciones.)");
    console.error("buildContext returns error:", e);
  }

  // ── Resumen de suscripción (plan, estado, vencimiento/trial) ──────────────
  // service_role scoped al tenant: subscriptions + plans + tenants.trial_ends_at.
  try {
    const { data: sub } = await admin
      .from("subscriptions")
      .select(
        "status, billing_cycle, current_period_end, cancel_at_period_end, is_lifetime, plan_id",
      )
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!sub) {
      lines.push("Suscripción: sin datos de plan.");
    } else {
      const s = sub as {
        status?: string;
        billing_cycle?: string;
        current_period_end?: string | null;
        cancel_at_period_end?: boolean;
        is_lifetime?: boolean;
        plan_id?: string | null;
      };
      let planName = "—";
      if (s.plan_id) {
        const { data: plan } = await admin
          .from("plans")
          .select("name, secondary_name")
          .eq("id", s.plan_id)
          .maybeSingle();
        const pn = plan as { name?: string; secondary_name?: string } | null;
        if (pn?.name) {
          planName = pn.secondary_name
            ? `${pn.name} (${pn.secondary_name})`
            : pn.name;
        }
      }
      const statusLabels: Record<string, string> = {
        trial: "en prueba",
        active: "activa",
        past_due: "con pago vencido",
        suspended: "suspendida",
        cancelled: "cancelada",
      };
      const statusTxt = statusLabels[s.status ?? ""] ?? (s.status ?? "—");
      // Para trial, la fecha canónica es tenants.trial_ends_at; si no, el período.
      let endIso: string | null = s.current_period_end ?? null;
      if (s.status === "trial") {
        const { data: t } = await admin
          .from("tenants")
          .select("trial_ends_at")
          .eq("id", tenantId)
          .maybeSingle();
        endIso = (t as { trial_ends_at?: string | null } | null)?.trial_ends_at ??
          endIso;
      }
      let tail = "";
      if (s.is_lifetime) {
        tail = " Plan de por vida (sin vencimiento).";
      } else if (endIso) {
        const end = new Date(endIso);
        const daysLeft = Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
        const when = end.toISOString().slice(0, 10);
        const label = s.status === "trial" ? "Prueba termina" : "Próximo vencimiento";
        tail =
          daysLeft >= 0
            ? ` ${label} el ${when} (faltan ${daysLeft} día(s)).`
            : ` ${label} el ${when} (venció hace ${Math.abs(daysLeft)} día(s)).`;
      }
      const cancelTxt = s.cancel_at_period_end
        ? " Marcada para no renovar al fin del período."
        : "";
      lines.push(
        `Suscripción: plan ${planName}, ${statusTxt} ` +
          `(ciclo ${s.billing_cycle ?? "—"}).${tail}${cancelTxt}`,
      );
    }
  } catch (e) {
    lines.push("(No se pudo cargar la suscripción.)");
    console.error("buildContext subscription error:", e);
  }

  // ── Estado de configuración ───────────────────────────────────────────────
  try {
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
        `email de comprobantes ${smtp?.host ? "configurado" : "sin configurar"}.`,
    );
  } catch (e) {
    lines.push("(No se pudo cargar el estado de configuración.)");
    console.error("buildContext config error:", e);
  }

  return lines.join("\n");
}
