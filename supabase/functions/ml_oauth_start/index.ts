// =============================================================================
// Edge Function: ml_oauth_start: inicia el OAuth (PKCE S256) de Mercado Libre
// para el negocio del usuario (H87 · ADR-104). Deploy: verify_jwt = true.
//
// Body: { reconnect_id?: uuid }  (reconectar una cuenta que pide reconexión)
// Respuesta: { url } a la pantalla de autorización de ML, o
//            { error: "ml_app_not_configured", message } mientras no estén
//            configurada la app (panel interno o ML_CLIENT_ID / ML_CLIENT_SECRET).
// Sólo dueño o encargado y con la feature `mercadolibre` (ml_edge_guard).
// El state (64 hex, un solo uso, 15 min) y el code_verifier quedan en
// ml_oauth_states (sólo service_role); el redirect_uri es fijo.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { authorizationUrl, codeChallengeS256, newCodeVerifier, newOAuthState } from "../_shared/mercadolibre/oauth.ts";
import { adminClient, cors, json, mlConfig } from "../_shared/mercadolibre/runtime.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  const admin = adminClient();
  const { data: guard, error: gErr } = await admin.rpc("ml_edge_guard", { p_tenant: tenantId, p_user: user.id, p_manage: true });
  if (gErr) return json({ error: "guard_failed" }, 500);
  if (guard) return json({ error: guard }, 403);

  const cfg = await mlConfig(admin);
  if (!cfg.ok) return json({ error: cfg.error, message: cfg.message }, 503);

  let body: { reconnect_id?: unknown } = {};
  try {
    body = await readJsonLimited(req, 4 * 1024);
  } catch {
    body = {};
  }
  let reconnect: string | null = null;
  if (typeof body?.reconnect_id === "string" && UUID_RE.test(body.reconnect_id)) {
    const { data: acc } = await admin
      .from("ml_accounts")
      .select("id")
      .eq("id", body.reconnect_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!acc) return json({ error: "not_found" }, 404);
    reconnect = acc.id as string;
  }

  // Limpieza de estados vencidos del negocio (barata).
  await admin.from("ml_oauth_states").delete().eq("tenant_id", tenantId).lt("expires_at", new Date().toISOString());

  const state = newOAuthState();
  const verifier = newCodeVerifier();
  const ins = await admin.from("ml_oauth_states").insert({
    state,
    tenant_id: tenantId,
    user_id: user.id,
    code_verifier: verifier,
    reconnect_id: reconnect,
  });
  if (ins.error) return json({ error: "state_failed" }, 500);

  const url = authorizationUrl({
    clientId: cfg.config.clientId,
    redirectUri: cfg.config.redirectUri,
    state,
    codeChallenge: await codeChallengeS256(verifier),
  });
  return json({ url });
});
