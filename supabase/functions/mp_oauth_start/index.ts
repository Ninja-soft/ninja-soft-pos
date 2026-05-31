// =============================================================================
// Edge Function: mp_oauth_start — inicia el OAuth de Mercado Pago para un tenant.
// Valida owner/manager, crea un state anti-CSRF y devuelve la URL de
// autorización de MP. El client_id/redirect_uri salen de platform_secrets
// (cuenta de app de NinjaSoft), no de env, para poder editarlos desde internal.
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

  // Credenciales de la app de MP de NinjaSoft (plataforma).
  const { data: plat } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  const ps = (plat?.secrets ?? {}) as {
    client_id?: string;
    redirect_uri?: string;
  };
  if (!ps.client_id || !ps.redirect_uri) {
    return json({ error: "platform_not_configured" }, 400);
  }

  // state anti-CSRF.
  const state = crypto.randomUUID();
  const ins = await admin
    .from("mp_oauth_states")
    .insert({ state, tenant_id: tenantId, user_id: user.id });
  if (ins.error) return json({ error: "state_failed" }, 500);

  const authUrl =
    "https://auth.mercadopago.com.ar/authorization" +
    `?client_id=${encodeURIComponent(ps.client_id)}` +
    "&response_type=code&platform_id=mp" +
    `&state=${encodeURIComponent(state)}` +
    `&redirect_uri=${encodeURIComponent(ps.redirect_uri)}`;

  return json({ url: authUrl });
});
