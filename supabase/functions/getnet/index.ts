// =============================================================================
// Edge Function: getnet · Getnet Argentina canal QR + link (F8 · H18, ADR-031).
// Getnet AR corre sobre Geopagos: OAuth2 client_credentials + Checkout API v2
// (POST/GET https://api.globalgetnet.com.ar/api/v2/orders). La orden devuelve
// un checkout hosted (data.links[0].checkout) que el POS muestra como QR y
// como "Abrir link de pago" (QrCheckoutModal, provider 'getnet').
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='getnet'; habilita el gating fino del trigger de payments)
//     + orden en Getnet con webhookUrl por orden (Edge getnet_webhook?intent=).
//     preference_id guarda el uuid de la orden; init_point, el checkout.
//   * status {intent_id}      → re-consulta GET /orders/{uuid} y sincroniza:
//     APPROVED/PROCESSED/SUCCESS + monto exacto (centavos) → approved ·
//     rechazo → rejected · vencida → cancelled. Sólo acredita con la
//     confirmación de la API (conservador, patrón pagos360/payway).
//
// Sin sandbox: no hay ambiente de prueba público de Getnet AR (ADR-031); el
// switch sandbox del medio NO aplica. Gating real: tenant_has_feature_for
// (tenant,'getnet') en create. Credenciales: client_id + client_secret en
// payment_secrets provider_key='getnet' (set_payment_secret).
// Lógica pura (payload, estados, monto): ../_shared/getnet.ts (Vitest).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  buildOrderPayload,
  decideIntentUpdate,
  fetchGetnetOrder,
  fetchGetnetToken,
  GETNET_ORDERS_URL,
  parseCreateResponse,
} from "../_shared/getnet.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope, loadProviderSecret } from "../_shared/paymentSecrets.ts";

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

  const secretRow = await loadProviderSecret(admin, tenantId, "getnet", action === "create" ? { storeId: bodyStoreId(b) } : { scopeStoreId: await intentSecretScope(admin, String(b.intent_id ?? "")) });
  const sec = (secretRow?.secrets ?? {}) as {
    client_id?: string;
    client_secret?: string;
  };
  if (!sec.client_id || !sec.client_secret) {
    return json({ error: "not_connected" }, 400);
  }

  // ── create: intent local + orden de Checkout en Getnet ──────────────────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "getnet",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }
    const title = String(b.title ?? "Venta NinjaPos");

    const token = await fetchGetnetToken(sec.client_id, sec.client_secret);
    if (!token) return json({ error: "getnet_no_token" }, 502);

    const { data: intent, error: intErr } = await insertIntentWithScope<{ id: string }>(
      admin,
      { tenant_id: tenantId, amount, provider_key: "getnet" },
      secretRow?.scopeStoreId ?? null,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    const hook = `${url}/functions/v1/getnet_webhook`;
    const payload = buildOrderPayload({
      amount,
      title,
      webhookUrl: `${hook}?intent=${intent.id}`,
      successUrl: `${hook}?view=success`,
      failedUrl: `${hook}?view=failed`,
    });

    let created: ReturnType<typeof parseCreateResponse> = null;
    let detail = "";
    try {
      const r = await fetch(GETNET_ORDERS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          Accept: "application/vnd.api+json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      if (r.ok) {
        try {
          created = parseCreateResponse(JSON.parse(text));
        } catch {
          created = null;
        }
      }
      if (!created) detail = `${r.status} ${text}`.slice(0, 300);
    } catch (e) {
      detail = String(e).slice(0, 300);
    }
    if (!created) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json({ error: "getnet_error", detail }, 502);
    }

    await admin
      .from("mp_payment_intents")
      .update({ preference_id: created.orderId, init_point: created.checkoutUrl })
      .eq("id", intent.id);

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "mp_payment_intents",
      entity_id: intent.id,
      action: "getnet_order_created",
      after_data: {
        amount,
        order_id: created.orderId,
        reference_number: created.referenceNumber,
      },
    });

    return json({ intent_id: intent.id, init_point: created.checkoutUrl });
  }

  // ── status: re-consulta la orden y sincroniza el intent ─────────────────────
  if (action === "status") {
    const intentId = String(b.intent_id ?? "");
    if (!intentId) return json({ error: "invalid_intent" }, 400);
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select("id, status, amount, preference_id, mp_payment_id")
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "getnet")
      .maybeSingle();
    if (!row) return json({ error: "intent_not_found" }, 404);

    if (row.status !== "pending") {
      return json({ status: row.status, mp_payment_id: row.mp_payment_id });
    }
    if (!row.preference_id) return json({ status: "pending", mp_payment_id: null });

    const token = await fetchGetnetToken(sec.client_id, sec.client_secret);
    if (!token) return json({ error: "getnet_no_token" }, 502);
    const res = await fetchGetnetOrder(token, String(row.preference_id));
    if (!res.ok) {
      if (res.httpStatus === 404) return json({ status: "pending", mp_payment_id: null });
      return json({ error: "getnet_error", detail: res.detail }, 502);
    }

    const d = decideIntentUpdate(res.order, Number(row.amount));
    if (d.status === "pending") {
      return json({ status: "pending", mp_payment_id: null, state: d.state });
    }

    const orderId = String(row.preference_id);
    // Update condicional (sólo desde pending): si el webhook ya resolvió el
    // intent en paralelo, no se pisa ni se duplica la auditoría.
    const { data: changed } = await admin
      .from("mp_payment_intents")
      .update({
        status: d.status,
        mp_payment_id: d.status === "approved" ? orderId : null,
      })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (changed && changed.length > 0) {
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: user.id,
        entity_type: "mp_payment_intents",
        entity_id: row.id,
        action: `getnet_payment_${d.status}`,
        after_data: {
          order_id: orderId,
          state: d.state,
          reason: d.reason ?? null,
          amount: Number(row.amount),
          via: "status",
        },
      });
    }

    const { data: fresh } = await admin
      .from("mp_payment_intents")
      .select("status, mp_payment_id")
      .eq("id", row.id)
      .maybeSingle();
    return json({
      status: fresh?.status ?? d.status,
      mp_payment_id: fresh?.mp_payment_id ?? null,
    });
  }

  return json({ error: "invalid_action" }, 400);
});
