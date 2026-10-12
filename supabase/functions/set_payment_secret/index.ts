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
  // H21c — Nave (ADR-030): client_id, client_secret, pos_id (QR + link),
  // point_pos_ids y audience opcionales. Nave Point reutiliza ESTA conexión
  // (no hay provider 'nave_point' de secretos).
  "nave",
  // GO Cuotas (ADR-033): { api_key } de la sucursal (Bearer). El ambiente lo
  // define el switch Sandbox del medio (sandbox.gocuotas.com vs www).
  "gocuotas",
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
  // merge (ADR-032): agrega/quita claves sin pisar el resto del secreto. Lo
  // usa Mercado Pago para el token de PRUEBA (test_access_token), que convive
  // con la conexión de producción (OAuth o token manual).
  const merge = b.merge === true;
  const remove = Array.isArray(b.remove)
    ? (b.remove as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  if (Object.keys(clean).length === 0 && !(merge && remove.length > 0)) {
    return json({ error: "empty_secrets" }, 400);
  }

  let next: Record<string, unknown> = clean;
  if (merge) {
    const { data: prev } = await admin
      .from("payment_secrets")
      .select("secrets")
      .eq("tenant_id", tenantId)
      .eq("provider_key", providerKey)
      .maybeSingle();
    next = { ...((prev?.secrets as Record<string, unknown>) ?? {}), ...clean };
    for (const k of remove) delete next[k];
  } else if (providerKey === "mercadopago") {
    // Reemplazo del token de producción: conserva el de prueba si había.
    const { data: prev } = await admin
      .from("payment_secrets")
      .select("secrets")
      .eq("tenant_id", tenantId)
      .eq("provider_key", providerKey)
      .maybeSingle();
    const testToken = (prev?.secrets as { test_access_token?: string } | null)?.test_access_token;
    if (testToken && !clean.test_access_token) next = { ...clean, test_access_token: testToken };
  }

  const up = await admin
    .from("payment_secrets")
    .upsert(
      { tenant_id: tenantId, provider_key: providerKey, secrets: next },
      { onConflict: "tenant_id,provider_key" },
    );
  if (up.error) return json({ error: "save_failed", detail: up.error.message }, 500);

  // Marca conectado (sin exponer el secreto) para la UI, sin pisar otros flags.
  // test_connected: hay token de prueba (switch Sandbox de Mercado Pago).
  const { data: cur } = await admin
    .from("tenant_payment_methods")
    .select("config")
    .eq("tenant_id", tenantId)
    .eq("provider_key", providerKey)
    .maybeSingle();
  const hasSecret = Object.keys(next).some((k) => k !== "test_access_token");
  const config: Record<string, unknown> = {
    ...((cur?.config as Record<string, unknown>) ?? {}),
    connected: hasSecret || Boolean(next.test_access_token),
  };
  if (providerKey === "mercadopago") config.test_connected = Boolean(next.test_access_token);
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
    after_data: {
      provider_key: providerKey,
      keys: Object.keys(clean),
      ...(merge ? { merge: true, removed: remove } : {}),
    },
  });

  return json({ ok: true, connected: true });
});
