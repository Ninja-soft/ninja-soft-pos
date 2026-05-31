// =============================================================================
// Edge Function: mp_oauth_callback — cierra el OAuth de Mercado Pago.
// Público (sin JWT): la seguridad es el `state` de un solo uso creado por
// mp_oauth_start + el intercambio del `code` contra MP. Intercambia el code por
// tokens, los guarda en payment_secrets del tenant y marca el medio conectado.
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
    return json({ error: "exchange_failed", detail: detail.slice(0, 300) }, 502);
  }
  const tok = (await tokRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    public_key?: string;
    user_id?: number | string;
    expires_in?: number;
  };
  if (!tok.access_token) return json({ error: "no_access_token" }, 502);

  const expiresAt = tok.expires_in
    ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
    : null;

  const secrets = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? null,
    public_key: tok.public_key ?? null,
    mp_user_id: tok.user_id ? String(tok.user_id) : null,
    expires_at: expiresAt,
    via: "oauth",
  };

  const up = await admin
    .from("payment_secrets")
    .upsert(
      { tenant_id: tenantId, provider_key: "mercadopago", secrets },
      { onConflict: "tenant_id,provider_key" },
    );
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
  await admin.from("tenant_payment_methods").upsert(
    { tenant_id: tenantId, provider_key: "mercadopago", config },
    { onConflict: "tenant_id,provider_key" },
  );

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
    after_data: { provider_key: "mercadopago", mp_user_id: secrets.mp_user_id },
  });

  return json({ ok: true });
});
