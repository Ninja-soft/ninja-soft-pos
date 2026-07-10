// =============================================================================
// Edge Function: modo_create_qr — cobro por QR/deeplink de MODO (F8 · H16).
//
// DIALECTO REAL validado contra el SDK del plugin oficial de WooCommerce
// ("paga-con-modo", Ecomerciar\MODO\Sdk\MODOSdk) y el instructivo de alta que
// MODO manda a los comercios (credenciales Username/Password [+ Store ID
// opcional + Processor code]):
//
//   * Token:   POST {base}/middleman/token  body {username, password}
//              → { accessToken }  (JWT; se manda como "Bearer <jwt>").
//   * Crear:   POST {base}/ecommerce/payment-intention
//              body { productName, price, quantity, terminalId, storeId?,
//                     externalIntentionId, currency:'ARS' }
//              → { status:'CREATED', id, qr?, deeplink? … }
//   * Estado:  GET  {base}/ecommerce/payment-intention/{id}
//              → { status: CREATED | ACCEPTED | REJECTED | CANCELLED … }
//
// Bases: producción https://merchants.playdigital.com.ar/merchants ·
// preprod https://merchants.preprod.playdigital.com.ar/merchants (elige
// tenant_payment_methods.sandbox; override por env por si MODO los mueve).
//
// Actions (body.action; sin action = "create", backward-compatible con el POS
// ya deployado):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='modo') + payment-intention en MODO; init_point =
//     deeplink ?? qr (el POS lo muestra como QR).
//   * status {intent_id} → sincroniza contra MODO (patrón pagos360/mp_point):
//     ACCEPTED → approved · REJECTED → rejected · CANCELLED/EXPIRED →
//     cancelled. Sólo se acredita con confirmación de la API (conservador).
//
// El webhook account-level de MODO (PATCH /middleman/ {callbackUrl}) queda
// como mejora futura; el polling server-side cubre el cobro completo. El
// processor_code y los cc_codes (planes de cuotas) los administra MODO por
// comercio: se guardan con las credenciales pero no viajan en la intención
// (el plugin oficial tampoco los manda).
// Gating real de plan: tenant_has_feature_for(tenant,'modo') en create.
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

const MODO_BASE_PROD =
  Deno.env.get("MODO_API_BASE") ??
  "https://merchants.playdigital.com.ar/merchants";
const MODO_BASE_PREPROD =
  Deno.env.get("MODO_API_BASE_PREPROD") ??
  "https://merchants.preprod.playdigital.com.ar/merchants";

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
  const action = String(b.action ?? "create");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Miembro activo del tenant.
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  // Credenciales del comercio. Acepta las keys nuevas (username/password, el
  // esquema real de MODO) y las históricas (client_id/client_secret) para no
  // romper conexiones guardadas antes de validar el dialecto.
  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "modo")
    .maybeSingle();
  const sec = (secretRow?.secrets ?? {}) as {
    username?: string;
    password?: string;
    client_id?: string;
    client_secret?: string;
    store_id?: string;
    processor_code?: string;
  };
  const username = sec.username ?? sec.client_id;
  const password = sec.password ?? sec.client_secret;
  if (!username || !password) return json({ error: "not_connected" }, 400);

  const { data: methodRow } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "modo")
    .maybeSingle();
  const base = methodRow?.sandbox ? MODO_BASE_PREPROD : MODO_BASE_PROD;

  // ── Token (middleman) ────────────────────────────────────────────────────
  let tokRes: Response;
  try {
    tokRes = await fetch(`${base}/middleman/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    return json({ error: "modo_unreachable", detail: String(e).slice(0, 200) }, 502);
  }
  if (!tokRes.ok) {
    return json(
      { error: "modo_no_token", detail: (await tokRes.text()).slice(0, 300) },
      502,
    );
  }
  const tok = (await tokRes.json()) as { accessToken?: string };
  if (!tok.accessToken) return json({ error: "modo_no_token" }, 502);
  const modoHeaders = {
    Authorization: `Bearer ${tok.accessToken}`,
    "Content-Type": "application/json",
    accept: "application/json",
  };

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    // Gating de plan (enforcement real): la UI nunca es la única barrera. El
    // trigger en `payments` es la red de seguridad para el registro de la
    // venta (resuelve el proveedor por mp_payment_intents.provider_key).
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "modo",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }
    const title = String(b.title ?? "Venta NinjaPos").slice(0, 120);

    const { data: intent, error: intErr } = await admin
      .from("mp_payment_intents")
      .insert({ tenant_id: tenantId, amount, provider_key: "modo" })
      .select("id")
      .single();
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    let r: Response;
    try {
      r = await fetch(`${base}/ecommerce/payment-intention`, {
        method: "POST",
        headers: modoHeaders,
        body: JSON.stringify({
          productName: title,
          price: Math.round(amount * 100) / 100,
          quantity: 1,
          // El plugin oficial manda un terminalId fijo para e-commerce.
          terminalId: "123",
          ...(sec.store_id ? { storeId: sec.store_id } : {}),
          externalIntentionId: intent.id,
          currency: "ARS",
        }),
      });
    } catch (e) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json({ error: "modo_unreachable", detail: String(e).slice(0, 200) }, 502);
    }
    if (!r.ok) {
      const detail = await r.text();
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json({ error: "modo_error", detail: detail.slice(0, 300) }, 502);
    }
    const pi = (await r.json()) as {
      status?: string;
      id?: string;
      qr?: string;
      deeplink?: string;
    };
    if (String(pi.status ?? "").toUpperCase() !== "CREATED" || !pi.id) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json(
        { error: "modo_error", detail: JSON.stringify(pi).slice(0, 300) },
        502,
      );
    }
    // El POS renderiza init_point como QR; el deeplink abre la app de MODO.
    const initPoint = pi.deeplink || pi.qr || "";
    if (!initPoint) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json({ error: "modo_no_checkout" }, 502);
    }
    await admin
      .from("mp_payment_intents")
      .update({ preference_id: String(pi.id), init_point: initPoint })
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
      .eq("provider_key", "modo")
      .maybeSingle();
    if (!row) return json({ error: "intent_not_found" }, 404);

    if (row.status !== "pending") {
      return json({ status: row.status, mp_payment_id: row.mp_payment_id });
    }

    const r = await fetch(
      `${base}/ecommerce/payment-intention/${row.preference_id}`,
      { headers: modoHeaders },
    );
    if (!r.ok) {
      return json(
        { error: "modo_error", detail: (await r.text()).slice(0, 300) },
        502,
      );
    }
    const pi = (await r.json()) as { status?: string; price?: number };
    const state = String(pi.status ?? "").toUpperCase();

    if (state === "ACCEPTED") {
      // Verificación de monto cuando la API lo informa (conservador).
      const amountOk =
        pi.price == null ||
        Math.abs(Number(pi.price) - Number(row.amount)) < 0.01;
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
    if (state === "REJECTED") {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", row.id);
      return json({ status: "rejected", mp_payment_id: null });
    }
    if (["CANCELLED", "CANCELED", "EXPIRED"].includes(state)) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "cancelled" })
        .eq("id", row.id);
      return json({ status: "cancelled", mp_payment_id: null });
    }
    return json({ status: "pending", mp_payment_id: null, state });
  }

  return json({ error: "invalid_action" }, 400);
});
