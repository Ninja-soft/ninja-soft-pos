// =============================================================================
// Edge Function: directo · crédito Directo por QR + link (F8 · ADR-041).
// API de comercios de Directo (la misma que usa su plugin oficial de
// WooCommerce): login con usuario/contraseña del comercio + ApiKey, y orden
// firmada con MerchantHash.
//
// Actions (body.action):
//   * create {amount, title?, email?, phone?} → intent local
//     (mp_payment_intents, provider_key='directo', mp_env por el switch
//     Sandbox = QA) + orden POST api/merchant/orders con
//     Merchant_Order_Id = intent.id y Notify_Url por intent. El redirect_Url
//     es el init_point que el POS muestra como QR y link.
//   * status {intent_id} → si el webhook ya dejó el id de notificación, la
//     re-consulta y sincroniza (Successful + referencia propia + monto exacto
//     si viene → approved). Si no, devuelve el estado local.
//   * cancel {intent_id} → baja local del intent (no hay endpoint conocido
//     para anular una orden). Si el cliente igual paga, el webhook lo
//     registra como approved y queda en la conciliación.
//
// Gating real: tenant_has_feature_for(tenant,'directo') en create (y el
// trigger de payments vía payment_method_plan_key('directo')).
// Credencial: payment_secrets provider 'directo' (set_payment_secret).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { buildOrderBody } from "../_shared/directo.ts";
import {
  INTENT_COLS,
  clientFor,
  intentEnvValue,
  loadCreds,
  loadEnv,
  syncIntent,
  type IntentRow,
} from "../_shared/directo_server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  const creds = await loadCreds(admin, tenantId);
  if (!creds) return json({ error: "not_connected" }, 400);

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "directo",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    const env = await loadEnv(admin, tenantId);
    const hook = `${url}/functions/v1/directo_webhook`;
    const orderInput = {
      amount,
      merchantOrderId: "",
      notifyUrl: "",
      successUrl: `${hook}?view=success`,
      errorUrl: `${hook}?view=failed`,
      description: typeof b.title === "string" ? b.title.slice(0, 120) : null,
      email: typeof b.email === "string" ? b.email : null,
      phone: typeof b.phone === "string" ? b.phone : null,
    };

    // Valida monto y URL base ANTES de crear el intent.
    let client;
    try {
      buildOrderBody({ ...orderInput, merchantOrderId: "x", notifyUrl: hook, token: "x", merchantName: "x" });
      client = clientFor(creds, env);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "invalid_amount" }, 400);
    }

    const { data: intent, error: intErr } = await admin
      .from("mp_payment_intents")
      .insert({
        tenant_id: tenantId,
        amount,
        provider_key: "directo",
        mp_env: intentEnvValue(env),
      })
      .select("id")
      .single();
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const intentId = (intent as { id: string }).id;

    const reject = () =>
      admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);

    const login = await client.login();
    if (!login.ok) {
      await reject();
      const auth = login.httpStatus === 401 || login.httpStatus === 403;
      return json(
        { error: auth ? "directo_auth_failed" : "directo_error", detail: login.detail },
        502,
      );
    }

    const created = await client.createOrder({
      ...orderInput,
      merchantOrderId: intentId,
      notifyUrl: `${hook}?intent=${intentId}`,
    });
    if (!created.ok) {
      await reject();
      const auth = created.httpStatus === 401 || created.httpStatus === 403;
      return json(
        { error: auth ? "directo_auth_failed" : "directo_error", detail: created.detail },
        502,
      );
    }

    const { error: upErr } = await admin
      .from("mp_payment_intents")
      .update({ init_point: created.value.redirectUrl })
      .eq("id", intentId);
    if (upErr) return json({ error: "intent_failed" }, 500);

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "mp_payment_intents",
      entity_id: intentId,
      action: "directo_order_created",
      after_data: { amount, env },
    });

    return json({ intent_id: intentId, init_point: created.value.redirectUrl });
  }

  // ── status / cancel ─────────────────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!intentId) return json({ error: "invalid_intent" }, 400);
  const { data: rowData } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "directo")
    .maybeSingle();
  const row = rowData as IntentRow | null;
  if (!row) return json({ error: "intent_not_found" }, 404);

  // Re-verifica contra Directo sólo si ya hay una notificación conocida.
  const resync = async () =>
    row.status === "pending" && row.preference_id
      ? await syncIntent(admin, row, creds, "status", row.preference_id, user.id)
      : null;

  if (action === "status") {
    const res = await resync();
    if (!res) return json({ status: row.status, mp_payment_id: row.mp_payment_id });
    if ("error" in res) return json(res, 502);
    return json({ status: res.status, mp_payment_id: res.mp_payment_id });
  }

  if (action === "cancel") {
    if (row.status !== "pending") return json({ ok: true, status: row.status });
    // Última verificación: si el cliente justo pagó, gana el pago.
    const res = await resync();
    if (res && !("error" in res) && res.status !== "pending") {
      return json({ ok: true, status: res.status });
    }
    const { data: changed } = await admin
      .from("mp_payment_intents")
      .update({ status: "cancelled" })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (changed && changed.length > 0) {
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: user.id,
        entity_type: "mp_payment_intents",
        entity_id: row.id,
        action: "directo_order_cancelled",
        after_data: { amount: Number(row.amount) },
      });
    }
    return json({ ok: true, status: "cancelled" });
  }

  return json({ error: "invalid_action" }, 400);
});
