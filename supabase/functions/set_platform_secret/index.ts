// =============================================================================
// Edge Function: set_platform_secret — guarda/lee credenciales GLOBALES de
// NinjaSoft (ej. la app de Mercado Pago: client_id/secret para OAuth + el
// access_token propio para cobrar suscripciones). SOLO staff internal.
// platform_secrets tiene RLS deny a todos → service_role solo acá.
// Devuelve un estado enmascarado (qué llaves hay), nunca los valores.
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

// Llaves permitidas por proveedor de plataforma.
const ALLOWED_KEYS: Record<string, Set<string>> = {
  mercadopago: new Set([
    "client_id",
    "client_secret",
    "access_token",
    "public_key",
    "redirect_uri",
  ]),
  // Config del Asistente IA (Fase F): proveedor/modelo/api_key (secreta) +
  // beta_owner_email (pública). La api_key nunca se devuelve en claro.
  ai_config: new Set([
    "provider",
    "model",
    "api_key",
    "beta_owner_email",
  ]),
};
// Llaves que nunca se devuelven en claro (solo se reporta si están seteadas).
const SECRET_KEYS = new Set(["client_secret", "access_token", "api_key"]);

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
    for (const k of allowed) {
      const v = secrets[k];
      status[k] = SECRET_KEYS.has(k)
        ? Boolean(v) // solo si está seteada
        : (v ?? null); // públicas (client_id, public_key, redirect_uri) en claro
    }
    return status;
  };

  // GET de estado.
  if (b.action === "status") {
    return json({ ok: true, status: await maskedStatus() });
  }

  // Merge parcial: solo pisa las llaves enviadas con valor no vacío.
  const incoming = (b.secrets ?? {}) as Record<string, unknown>;
  const patch: Record<string, string> = {};
  for (const k of allowed) {
    const v = incoming[k];
    if (typeof v === "string" && v.trim()) patch[k] = v.trim();
  }
  if (Object.keys(patch).length === 0) return json({ error: "empty_secrets" }, 400);

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
