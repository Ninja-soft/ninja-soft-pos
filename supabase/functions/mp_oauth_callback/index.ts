// =============================================================================
// Edge Function: mp_oauth_callback — cierra el OAuth de Mercado Pago.
// Público (sin JWT): la seguridad es el `state` de un solo uso creado por
// mp_oauth_start + el intercambio del `code` contra MP. Intercambia el code por
// tokens, los guarda en payment_secrets del tenant y marca el medio conectado.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  loadProviderSecret,
  saveProviderSecret,
  scopeErrorStatus,
  storeFromOAuthState,
} from "../_shared/paymentSecrets.ts";

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

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const code = String(b.code ?? "").trim();
  const state = String(b.state ?? "").trim();
  if (!code || !state) return json({ error: "missing_params" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Valida y consume el state.
  const { data: stateRow } = await admin
    .from("mp_oauth_states")
    .select("tenant_id, user_id")
    .eq("state", state)
    .maybeSingle();
  if (!stateRow) return json({ error: "invalid_state" }, 400);
  const tenantId = stateRow.tenant_id as string;
  // ADR-057: sucursal (si el OAuth se pidió para una) y re-validación del
  // alcance con quien lo inició.
  const storeId = storeFromOAuthState(state);
  if (storeId) {
    const { data: err, error: rpcErr } = await admin.rpc("payment_secret_scope_check", {
      p_tenant: tenantId,
      p_user: stateRow.user_id,
      p_store: storeId,
    });
    if (rpcErr) return json({ error: "scope_check_failed" }, 500);
    if (err) return json({ error: err }, scopeErrorStatus(String(err)));
  }

  // Credenciales de la app MP de NinjaSoft.
  const { data: plat } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  const ps = (plat?.secrets ?? {}) as {
    client_id?: string;
    client_secret?: string;
    redirect_uri?: string;
  };
  if (!ps.client_id || !ps.client_secret || !ps.redirect_uri) {
    return json({ error: "platform_not_configured" }, 400);
  }

  // Intercambio code -> tokens.
  const tokRes = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: ps.client_id,
      client_secret: ps.client_secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: ps.redirect_uri,
    }),
  });
  if (!tokRes.ok) {
    const detail = await tokRes.text();
    console.error("mp_oauth exchange_failed", tokRes.status, detail.slice(0, 500));
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: stateRow.user_id,
      entity_type: "payment_secrets",
      entity_id: null,
      action: "payment_oauth_error",
      after_data: {
        status: tokRes.status,
        redirect_uri: ps.redirect_uri,
        client_id: ps.client_id,
        detail: detail.slice(0, 500),
      },
    });
    return json({ error: "exchange_failed", detail: detail.slice(0, 300) }, 502);
  }
  const tok = (await tokRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    public_key?: string;
    user_id?: number | string;
    expires_in?: number;
  };
  if (!tok.access_token) {
    console.error("mp_oauth no_access_token", JSON.stringify(tok).slice(0, 300));
    return json({ error: "no_access_token" }, 502);
  }

  const expiresAt = tok.expires_in
    ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
    : null;

  // Conserva el token de PRUEBA (switch Sandbox, ADR-032) si ya estaba cargado.
  // Sólo la fila de ESE alcance (sin heredar el token de prueba del negocio).
  const prevSecret = await loadProviderSecret(admin, tenantId, "mercadopago", { scopeStoreId: storeId });
  const samePrev = prevSecret && prevSecret.scopeStoreId === storeId ? prevSecret : null;
  const prevTest = (samePrev?.secrets as { test_access_token?: string } | undefined)
    ?.test_access_token;

  const secrets = {
    ...(prevTest ? { test_access_token: prevTest } : {}),
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? null,
    public_key: tok.public_key ?? null,
    mp_user_id: tok.user_id ? String(tok.user_id) : null,
    expires_at: expiresAt,
    via: "oauth",
  };

  const up = await saveProviderSecret(admin, {
    tenantId,
    providerKey: "mercadopago",
    storeId,
    secrets,
  });
  if (up.error) return json({ error: "save_failed", detail: up.error.message }, 500);

  // Marca conectado (sin pisar enabled/surcharge si ya existen).
  const { data: cur } = await admin
    .from("tenant_payment_methods")
    .select("config")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago")
    .maybeSingle();
  const config = {
    ...((cur?.config as Record<string, unknown>) ?? {}),
    connected: true,
  };
  // Una cuenta de sucursal no marca conectado al negocio entero (ADR-057):
  // la UI lee payment_secret_scopes().
  if (!storeId) {
    await admin.from("tenant_payment_methods").upsert(
      { tenant_id: tenantId, provider_key: "mercadopago", config },
      { onConflict: "tenant_id,provider_key" },
    );
  }

  await admin
    .from("mp_oauth_states")
    .delete()
    .eq("state", state);

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: stateRow.user_id,
    entity_type: "payment_secrets",
    entity_id: null,
    action: "payment_oauth_connected",
    after_data: { provider_key: "mercadopago", mp_user_id: secrets.mp_user_id, store_id: storeId },
  });

  return json({ ok: true });
});
