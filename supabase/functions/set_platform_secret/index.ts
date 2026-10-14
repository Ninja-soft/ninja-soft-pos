// =============================================================================
// Edge Function: set_platform_secret — guarda/lee credenciales GLOBALES de
// NinjaSoft (ej. la app de Mercado Pago: client_id/secret para OAuth + el
// access_token propio para cobrar suscripciones). SOLO staff internal.
// platform_secrets tiene RLS deny a todos → service_role solo acá.
// Devuelve un estado enmascarado (qué llaves hay), nunca los valores.
//
// F20-0b (H126): Mercado Pago suma `webhook_secret` (clave de firma del
// webhook, secreta) y `environment` (production | test). Se valida el formato
// de cada credencial antes de guardar (_shared/mpCredentials.ts): un Client ID
// que no es numérico se rechaza. `hints` devuelve los últimos 4 caracteres de
// los secretos (nunca el valor). action "test" prueba el Access Token contra
// GET /users/me y devuelve la cuenta (nickname, id, país, si es de prueba).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  credentialEnvironment,
  secretHint,
  validateMpCredential,
  type MpCredentialField,
} from "../_shared/mpCredentials.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Llaves permitidas por proveedor de plataforma.
const ALLOWED_KEYS: Record<string, Set<string>> = {
  mercadopago: new Set([
    "client_id",
    "client_secret",
    "access_token",
    "public_key",
    "redirect_uri",
    "webhook_secret",
    "environment",
  ]),
  // Config del Asistente IA (Fase F): proveedor/modelo/api_key (secreta) +
  // beta_owner_email (pública). La api_key nunca se devuelve en claro.
  // Campos públicos del addon (avatar, texto comercial, precio y trial) para
  // el explicador de la burbuja: NO son secretos, se devuelven en claro.
  ai_config: new Set([
    "provider",
    "model",
    "api_key", // legacy (fallback de Gemini)
    "gemini_api_key",
    "claude_api_key",
    "beta_owner_email",
    "image_url", // legacy (avatar único; fallback de Gemini)
    // Avatar del asistente POR proveedor (el del activo es el ícono del cliente
    // con el addon). NO son secretos: se devuelven en claro en el status.
    "gemini_image_url",
    "claude_image_url",
    "commercial_text",
    "addon_price_ars",
    "addon_trial_days",
    // Estado activo/inactivo del addon IA ("true"/"false"). NO es secreto: se
    // devuelve en claro en el status para que la card pueda prefijar el toggle.
    "active",
    // Tope mensual de tokens por negocio (número como string). NO es secreto:
    // se devuelve en claro para prefijar el campo de la card. La Edge Function
    // ai_assistant lo lee con fallback al default (500k).
    "monthly_quota",
  ]),
};
// Llaves que nunca se devuelven en claro (solo se reporta si están seteadas).
const SECRET_KEYS = new Set([
  "client_secret",
  "webhook_secret",
  "access_token",
  "api_key",
  "gemini_api_key",
  "claude_api_key",
]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);

  const isInternal = Boolean(
    (user.app_metadata as { is_internal?: boolean } | null)?.is_internal,
  );
  if (!isInternal) return json({ error: "forbidden" }, 403);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const key = String(b.key ?? "").trim();
  const allowed = ALLOWED_KEYS[key];
  if (!allowed) return json({ error: "invalid_key" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Estado enmascarado: qué llaves están configuradas (sin valores secretos).
  const maskedStatus = async () => {
    const { data } = await admin
      .from("platform_secrets")
      .select("secrets, updated_at")
      .eq("key", key)
      .maybeSingle();
    const secrets = (data?.secrets ?? {}) as Record<string, unknown>;
    const status: Record<string, unknown> = { updated_at: data?.updated_at ?? null };
    const hints: Record<string, string | null> = {};
    for (const k of allowed) {
      const v = secrets[k];
      status[k] = SECRET_KEYS.has(k)
        ? Boolean(v) // solo si está seteada
        : (v ?? null); // públicas (client_id, public_key, redirect_uri) en claro
      if (SECRET_KEYS.has(k)) hints[k] = typeof v === "string" ? secretHint(v) : null;
    }
    if (key === "mercadopago") {
      status.hints = hints;
      // Ambiente que sugiere el prefijo del token (sin exponerlo).
      status.token_environment =
        typeof secrets.access_token === "string" ? credentialEnvironment(secrets.access_token) : null;
    }
    return status;
  };

  // GET de estado.
  if (b.action === "status") {
    return json({ ok: true, status: await maskedStatus() });
  }

  // Probar conexión: GET /users/me con el Access Token guardado.
  if (b.action === "test") {
    if (key !== "mercadopago") return json({ error: "invalid_action" }, 400);
    const { data } = await admin
      .from("platform_secrets")
      .select("secrets")
      .eq("key", key)
      .maybeSingle();
    const token = (data?.secrets as { access_token?: string } | null)?.access_token;
    if (!token) return json({ ok: false, error: "no_access_token" });
    let result: Record<string, unknown>;
    try {
      const r = await fetch("https://api.mercadopago.com/users/me", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        result = { ok: false, error: r.status === 401 || r.status === 403 ? "invalid_token" : `mp_http_${r.status}` };
      } else {
        const me = (await r.json()) as {
          id?: number;
          nickname?: string;
          site_id?: string;
          country_id?: string;
          tags?: string[];
        };
        result = {
          ok: true,
          account: {
            id: me.id ?? null,
            nickname: me.nickname ?? null,
            site_id: me.site_id ?? null,
            country_id: me.country_id ?? null,
            is_test: Array.isArray(me.tags) && me.tags.includes("test_user"),
          },
          token_environment: credentialEnvironment(token),
        };
      }
    } catch {
      result = { ok: false, error: "mp_unreachable" };
    }
    await admin.from("audit_logs").insert({
      tenant_id: null,
      actor_user_id: user.id,
      entity_type: "platform_secrets",
      entity_id: null,
      action: "platform_secret_tested",
      after_data: { key, ok: result.ok === true, error: result.error ?? null },
    });
    return json(result);
  }

  // Merge parcial: solo pisa las llaves enviadas con valor no vacío.
  const incoming = (b.secrets ?? {}) as Record<string, unknown>;
  const patch: Record<string, string> = {};
  for (const k of allowed) {
    const v = incoming[k];
    if (typeof v === "string" && v.trim()) patch[k] = v.trim();
  }
  if (Object.keys(patch).length === 0) return json({ error: "empty_secrets" }, 400);

  // Formato de las credenciales de Mercado Pago (barrera real; la UI avisa).
  if (key === "mercadopago") {
    const invalid: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch)) {
      const msg = validateMpCredential(k as MpCredentialField, v);
      if (msg) invalid[k] = msg;
    }
    if (Object.keys(invalid).length > 0) {
      return json({ error: "invalid_format", fields: invalid }, 400);
    }
  }

  const { data: cur } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", key)
    .maybeSingle();
  const merged = { ...((cur?.secrets as Record<string, unknown>) ?? {}), ...patch };

  const up = await admin
    .from("platform_secrets")
    .upsert({ key, secrets: merged }, { onConflict: "key" });
  if (up.error) return json({ error: "save_failed", detail: up.error.message }, 500);

  await admin.from("audit_logs").insert({
    tenant_id: null,
    actor_user_id: user.id,
    entity_type: "platform_secrets",
    entity_id: null,
    action: "platform_secret_set",
    after_data: { key, keys: Object.keys(patch) },
  });

  return json({ ok: true, status: await maskedStatus() });
});
