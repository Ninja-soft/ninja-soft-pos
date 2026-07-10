// =============================================================================
// Edge Function: payway — Formulario de pago hosted de Payway/Prisma
// (F8 · H17). Dialecto del SDK oficial payway-ar/sdk-node-ventaonline
// ("checkout payment button"):
//
//   * Crear link:  POST {checkout}/link
//       headers { apikey: <PRIVATE apikey>, Content-Type, X-Source }
//       body { origin_platform, payment_description, currency:'ARS',
//              total_price, site, success_url, cancel_url, notifications_url,
//              template_id:1, installments:[1], plan_gobierno:false,
//              public_apikey, auth_3ds:false }
//       → { payment_id … } y el formulario vive en {web}/checkout/{payment_id}
//   * Estado:      GET {v2}/payments/{payment_id}  headers { apikey: private }
//       → { status: approved | rejected | annulled | … , amount (CENTAVOS) }
//
// Bases (elige tenant_payment_methods.sandbox):
//   sandbox  checkout https://developers.decidir.com/api/v1/checkout-payment-button
//            v2       https://developers.decidir.com/api/v2
//            web      https://developers.decidir.com/web/checkout/{id}
//   prod     checkout https://ventasonline.payway.com.ar/api/v1/checkout-payment-button
//            v2       https://ventasonline.payway.com.ar/api/v2
//            web      https://live.decidir.com/web/checkout/{id}
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='payway') + link; init_point = URL del formulario hosted.
//   * status {intent_id}      → sincroniza contra la API v2: approved + monto
//     exacto (centavos) → approved · rejected/annulled → rejected. Sólo se
//     acredita con confirmación de la API (conservador).
//
// El webhook (notifications_url → Edge payway_webhook) NO acredita a ciegas:
// re-verifica contra GET /payments. Gating real: tenant_has_feature_for
// (tenant,'payway') en create. Credenciales: public_apikey + private_apikey +
// site (nº de comercio), en payment_secrets provider_key='payway'.
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

const BASES = {
  sandbox: {
    checkout: "https://developers.decidir.com/api/v1/checkout-payment-button",
    v2: "https://developers.decidir.com/api/v2",
    web: "https://developers.decidir.com/web/checkout",
  },
  prod: {
    checkout: "https://ventasonline.payway.com.ar/api/v1/checkout-payment-button",
    v2: "https://ventasonline.payway.com.ar/api/v2",
    web: "https://live.decidir.com/web/checkout",
  },
};

// X-Source que manda el SDK oficial (metadata del integrador, base64 JSON).
const X_SOURCE = btoa(JSON.stringify({ service: "NinjaPos", version: "1.0" }));

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

  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "payway")
    .maybeSingle();
  const sec = (secretRow?.secrets ?? {}) as {
    public_apikey?: string;
    private_apikey?: string;
    site?: string;
  };
  if (!sec.public_apikey || !sec.private_apikey || !sec.site) {
    return json({ error: "not_connected" }, 400);
  }

  const { data: methodRow } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "payway")
    .maybeSingle();
  const base = methodRow?.sandbox ? BASES.sandbox : BASES.prod;
  const pwHeaders = {
    apikey: sec.private_apikey,
    "Content-Type": "application/json",
    "X-Source": X_SOURCE,
  };

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "payway",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }
    const title = String(b.title ?? "Venta NinjaPos").slice(0, 120);

    const { data: intent, error: intErr } = await admin
      .from("mp_payment_intents")
      .insert({ tenant_id: tenantId, amount, provider_key: "payway" })
      .select("id")
      .single();
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    // El webhook re-verifica contra la API; el retorno del cliente es una
    // pantalla neutra servida por payway_webhook (GET). OJO (validado contra
    // producción, 2026-07-10): el validador de URLs rechaza las de MÁS DE
    // ~100 caracteres y las de más de un query param (el '&' o un UUID entero
    // disparan param_required) → cada URL lleva UN parámetro CORTO. La
    // correlación usa los primeros 12 hex del intent (?i=), que el webhook
    // resuelve contra los intents payway pendientes.
    const backBase = `${url}/functions/v1/payway_webhook`;
    const shortRef = intent.id.replace(/-/g, "").slice(0, 12);
    const r = await fetch(`${base.checkout}/link`, {
      method: "POST",
      headers: pwHeaders,
      body: JSON.stringify({
        origin_platform: "NinjaPos",
        payment_description: title,
        currency: "ARS",
        total_price: Math.round(amount * 100) / 100,
        site: sec.site,
        success_url: `${backBase}?view=success`,
        cancel_url: `${backBase}?view=cancel`,
        notifications_url: `${backBase}?i=${shortRef}`,
        template_id: 1,
        installments: [1],
        plan_gobierno: false,
        public_apikey: sec.public_apikey,
        auth_3ds: false,
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json({ error: "payway_error", detail: detail.slice(0, 300) }, 502);
    }
    // Producción devuelve { payment_link: "https://live.decidir.com/web/checkout/<HASH>" }
    // (validado 2026-07-10 con credenciales reales). El HASH identifica el
    // checkout pero NO es consultable por /payments: la confirmación llega por
    // el webhook (notifications_url) con el payment_id real.
    const pr = (await r.json()) as {
      payment_link?: string;
      payment_id?: number | string;
      id?: number | string;
      link?: string;
      url?: string;
    };
    const initPoint =
      pr.payment_link ||
      pr.link ||
      pr.url ||
      (pr.payment_id ?? pr.id ? `${base.web}/${pr.payment_id ?? pr.id}` : "");
    const paymentId =
      pr.payment_id ?? pr.id ?? (initPoint ? initPoint.split("/").pop() : null);
    if (!paymentId || !initPoint) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json(
        { error: "payway_error", detail: JSON.stringify(pr).slice(0, 300) },
        502,
      );
    }
    await admin
      .from("mp_payment_intents")
      .update({ preference_id: String(paymentId), init_point: initPoint })
      .eq("id", intent.id);
    return json({ intent_id: intent.id, init_point: initPoint });
  }

  // ── status ─────────────────────────────────────────────────────────────────
  if (action === "status") {
    const intentId = String(b.intent_id ?? "");
    if (!intentId) return json({ error: "invalid_intent" }, 400);
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select("id, status, amount, preference_id, mp_payment_id")
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "payway")
      .maybeSingle();
    if (!row) return json({ error: "intent_not_found" }, 404);

    if (row.status !== "pending") {
      return json({ status: row.status, mp_payment_id: row.mp_payment_id });
    }

    // El hash del checkout NO es consultable en /payments: la confirmación la
    // trae el webhook (notifications_url) con el payment_id real. Si el webhook
    // dejó un id numérico sin resolver el estado, re-verificamos acá; si no,
    // seguimos pendientes (el POS sondea y el webhook resuelve).
    const numericId = /^[0-9]+$/.test(String(row.mp_payment_id ?? ""))
      ? String(row.mp_payment_id)
      : null;
    if (!numericId) {
      return json({ status: "pending", mp_payment_id: null });
    }
    const r = await fetch(`${base.v2}/payments/${numericId}`, {
      headers: { apikey: sec.private_apikey },
    });
    if (r.status === 404) {
      return json({ status: "pending", mp_payment_id: null });
    }
    if (!r.ok) {
      return json(
        { error: "payway_error", detail: (await r.text()).slice(0, 300) },
        502,
      );
    }
    const pay = (await r.json()) as { status?: string; amount?: number };
    const state = String(pay.status ?? "").toLowerCase();

    if (state === "approved" || state === "accredited") {
      // v2 informa el monto en CENTAVOS.
      const amountOk =
        pay.amount == null ||
        Math.abs(Number(pay.amount) - Math.round(Number(row.amount) * 100)) < 1;
      if (amountOk) {
        await admin
          .from("mp_payment_intents")
          .update({ status: "approved", mp_payment_id: String(row.preference_id) })
          .eq("id", row.id);
        return json({ status: "approved", mp_payment_id: String(row.preference_id) });
      }
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", row.id);
      return json({ status: "rejected", mp_payment_id: null });
    }
    if (["rejected", "annulled", "voided"].includes(state)) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", row.id);
      return json({ status: "rejected", mp_payment_id: null });
    }
    return json({ status: "pending", mp_payment_id: null, state });
  }

  return json({ error: "invalid_action" }, 400);
});
