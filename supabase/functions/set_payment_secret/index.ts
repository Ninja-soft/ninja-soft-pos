// =============================================================================
// Edge Function: set_payment_secret — guarda secretos de un proveedor de pago
// (ej. Access Token de Mercado Pago) por tenant. SOLO owner/manager del tenant.
// service_role solo acá: payment_secrets tiene RLS deny a todos.
// Marca tenant_payment_methods.config.connected = true (no secreto) para la UI.
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

const ALLOWED = new Set([
  "mercadopago",
  "mercadopago_point",
  "modo",
  "payway",
  "getnet",
  "fiserv",
  "mobbex",
  "pagos360",
  // H21c — Nave: el backend ya acepta credenciales (paridad con el resto de
  // proveedores del catálogo); la integración de cobro sigue pendiente y la UI
  // lo muestra como "Próximamente".
  "nave",
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

  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
    ?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const providerKey = String(b.provider_key ?? "").trim();
  if (!ALLOWED.has(providerKey)) return json({ error: "invalid_provider" }, 400);

  const action = b.action === "clear" ? "clear" : "set";
  const secrets = (b.secrets ?? {}) as Record<string, unknown>;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Guard: owner/manager activo del tenant.
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem || !["owner", "manager"].includes(mem.role as string)) {
    return json({ error: "forbidden" }, 403);
  }

  if (action === "clear") {
    await admin
      .from("payment_secrets")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("provider_key", providerKey);
    await admin.from("tenant_payment_methods").upsert(
      { tenant_id: tenantId, provider_key: providerKey, config: { connected: false } },
      { onConflict: "tenant_id,provider_key" },
    );
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "payment_secrets",
      entity_id: null,
      action: "payment_secret_cleared",
      after_data: { provider_key: providerKey },
    });
    return json({ ok: true, connected: false });
  }

  // Limpia/recorta strings de los secretos.
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string" && v.trim()) clean[k] = v.trim();
  }
  if (Object.keys(clean).length === 0) return json({ error: "empty_secrets" }, 400);

  const up = await admin
    .from("payment_secrets")
    .upsert(
      { tenant_id: tenantId, provider_key: providerKey, secrets: clean },
      { onConflict: "tenant_id,provider_key" },
    );
  if (up.error) return json({ error: "save_failed", detail: up.error.message }, 500);

  // Marca conectado (sin exponer el secreto) para la UI, sin pisar otros flags.
  const { data: cur } = await admin
    .from("tenant_payment_methods")
    .select("config")
    .eq("tenant_id", tenantId)
    .eq("provider_key", providerKey)
    .maybeSingle();
  const config = { ...((cur?.config as Record<string, unknown>) ?? {}), connected: true };
  await admin.from("tenant_payment_methods").upsert(
    { tenant_id: tenantId, provider_key: providerKey, config },
    { onConflict: "tenant_id,provider_key" },
  );

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "payment_secrets",
    entity_id: null,
    action: "payment_secret_set",
    after_data: { provider_key: providerKey, keys: Object.keys(clean) },
  });

  return json({ ok: true, connected: true });
});
