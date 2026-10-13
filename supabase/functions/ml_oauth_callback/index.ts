// =============================================================================
// Edge Function: ml_oauth_callback: cierra el OAuth de Mercado Libre
// (H87 · ADR-104). PÚBLICA: verify_jwt = false (la llama la ruta
// /api/ml/oauth/callback de Next con el code y el state del redirect de ML).
//
// Seguridad: el `state` es de un solo uso (se BORRA al leerlo) y vence a los
// 15 min; el canje del `code` usa el code_verifier PKCE guardado y el
// client_secret (secret de Edge, nunca en el front ni en la base). Cuerpo
// limitado (requestGuard). Los tokens van a ml_tokens (sólo service_role).
//
// Body: { code, state }. Respuesta: { ok, account_id } o { error }.
// Errores: invalid_state, ml_app_not_configured, exchange_failed,
// operator_user (colaborador en vez del administrador), ml_account_taken
// (la cuenta ya está en otro negocio), feature_not_in_plan.
// =============================================================================
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { MlApiError, createMlClient } from "../_shared/mercadolibre/client.ts";
import { exchangeCode, expiresAtFrom } from "../_shared/mercadolibre/oauth.ts";
import type { MlUser } from "../_shared/mercadolibre/types.ts";
import { adminClient, cors, fetcher, json, mlConfig } from "../_shared/mercadolibre/runtime.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let b: Record<string, unknown>;
  try {
    b = await readJsonLimited(req, 8 * 1024);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const code = String(b.code ?? "").trim();
  const state = String(b.state ?? "").trim();
  if (!code || code.length > 400 || !/^[0-9a-f]{64}$/.test(state)) return json({ error: "missing_params" }, 400);

  const admin = adminClient();
  // Consume el state (un solo uso).
  const { data: rows } = await admin
    .from("ml_oauth_states")
    .delete()
    .eq("state", state)
    .select("tenant_id, user_id, code_verifier, expires_at");
  const st = (rows ?? [])[0] as { tenant_id: string; user_id: string; code_verifier: string; expires_at: string } | undefined;
  if (!st || Date.parse(st.expires_at) < Date.now()) return json({ error: "invalid_state" }, 400);

  const cfg = mlConfig();
  if (!cfg.ok) return json({ error: cfg.error, message: cfg.message }, 503);

  const audit = (action: string, after: Record<string, unknown>) =>
    admin.from("audit_logs").insert({
      tenant_id: st.tenant_id,
      actor_user_id: st.user_id,
      entity_type: "ml_accounts",
      entity_id: null,
      action,
      after_data: after,
    });

  let tok;
  try {
    tok = await exchangeCode(fetcher, {
      clientId: cfg.config.clientId,
      clientSecret: cfg.config.clientSecret,
      redirectUri: cfg.config.redirectUri,
      code,
      codeVerifier: st.code_verifier,
    });
  } catch (e) {
    const err = e instanceof MlApiError ? e : null;
    await audit("ml_oauth_error", { code: err?.code ?? "network", status: err?.status ?? 0, detail: String(err?.message ?? e).slice(0, 300) });
    return json({ error: err?.code === "operator_user" ? "operator_user" : "exchange_failed" }, 502);
  }

  // Datos de la cuenta (nickname, sitio, tags: user_product_seller, etc.).
  let me: MlUser;
  try {
    const client = createMlClient({ fetch: fetcher, getToken: async () => tok.access_token });
    me = await client.get<MlUser>("/users/me");
  } catch (e) {
    await audit("ml_oauth_error", { code: "users_me_failed", detail: String(e instanceof Error ? e.message : e).slice(0, 300) });
    return json({ error: "exchange_failed" }, 502);
  }
  if (String(me.id) !== String(tok.user_id)) return json({ error: "exchange_failed" }, 502);

  const { data: res, error } = await admin.rpc("ml_account_upsert", {
    p_tenant: st.tenant_id,
    p_user: st.user_id,
    p: {
      ml_user_id: String(me.id),
      nickname: me.nickname,
      site_id: me.site_id,
      tags: me.tags ?? [],
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      expires_at: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
    },
  });
  if (error) return json({ error: "save_failed" }, 500);
  const r = res as { ok: boolean; error?: string; account_id?: string };
  if (!r.ok) {
    await audit("ml_oauth_error", { code: r.error, ml_user_id: String(me.id) });
    return json({ error: r.error }, 409);
  }

  // La primera sincronización (órdenes recientes) la hace ml-reconcile: la
  // cuenta nueva tiene last_orders_poll_at vacío.
  return json({ ok: true, account_id: r.account_id });
});
