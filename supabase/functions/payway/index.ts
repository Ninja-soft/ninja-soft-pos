// =============================================================================
// Edge Function: payway (F8 · H17 / H17b). Cobro con Payway por el CHECKOUT
// PROPIO de NinjaPos: el formulario hosted (checkout-payment-button) ya no se
// usa (su link no se pudo validar en sandbox: 412 con las keys públicas).
//
// Actions (body.action):
//   * create {amount, origin} → intent local (mp_payment_intents,
//     provider_key='payway') y init_point = {origin}/pagar/{intent}. Ahí el
//     cliente tokeniza la tarjeta contra Payway y la Edge payway_checkout
//     (action pay) cobra con la API Key privada. No se manda notifications_url.
//   * status {intent_id} → si el intent sigue pendiente y payway_checkout dejó
//     un id de pago (mp_payment_id numérico, caso "en revisión"), re-verifica
//     contra GET {v2}/payments/{id}: approved + monto EXACTO en centavos +
//     site_transaction_id del intent → approved; rejected/annulled o monto
//     distinto → rejected. Sin id → pending (el cobro sincrónico de
//     payway_checkout es el que aprueba en el caso normal).
//
// Bases v2 (elige tenant_payment_methods.sandbox): sandbox
// https://developers.decidir.com/api/v2 · prod
// https://ventasonline.payway.com.ar/api/v2. Lógica pura en _shared/payway.ts.
// Gating real: tenant_has_feature_for(tenant,'payway') en create.
// Credenciales: public_apikey + private_apikey + site en payment_secrets
// provider_key='payway'.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { decidePaymentStatus, paywayPaymentId, paywayV2Base } from "../_shared/payway.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope, loadProviderSecret } from "../_shared/paymentSecrets.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ninja-scope",
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

  const secretRow = await loadProviderSecret(admin, tenantId, "payway", action === "create" ? { storeId: bodyStoreId(b) } : { scopeStoreId: await intentSecretScope(admin, String(b.intent_id ?? "")) });
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
  const v2 = paywayV2Base(methodRow?.sandbox);

  // ── create ─────────────────────────────────────────────────────────────────
  // Checkout PROPIO (H17b): ya no se usa el formulario hosted de Payway. El
  // POS recibe como init_point la página pública /pagar/{intent} de la app
  // (marca del negocio, cuotas de los Planes, tarjeta). El cobro real lo hace
  // payway_checkout (action pay) con el token del navegador.
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
    // Origen de la app que abre el checkout (multi-dominio: lo manda el POS).
    let origin = "";
    try {
      const o = new URL(String(b.origin ?? ""));
      if (o.protocol !== "https:" && o.hostname !== "localhost") {
        return json({ error: "invalid_origin" }, 400);
      }
      origin = o.origin;
    } catch {
      return json({ error: "invalid_origin" }, 400);
    }

    const { data: intent, error: intErr } = await insertIntentWithScope<{ id: string }>(
      admin,
      { tenant_id: tenantId, amount, provider_key: "payway" },
      secretRow?.scopeStoreId ?? null,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    const initPoint = `${origin}/pagar/${intent.id}`;
    await admin
      .from("mp_payment_intents")
      .update({ init_point: initPoint })
      .eq("id", intent.id);
    return json({ intent_id: intent.id, init_point: initPoint });
  }

  // ── status ─────────────────────────────────────────────────────────────────
  if (action === "status") {
    const intentId = String(b.intent_id ?? "");
    if (!intentId) return json({ error: "invalid_intent" }, 400);
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select("id, status, amount, mp_payment_id")
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "payway")
      .maybeSingle();
    if (!row) return json({ error: "intent_not_found" }, 404);

    if (row.status !== "pending") {
      // amount: el checkout propio puede haber sumado recargo de cuotas — el
      // POS registra la venta por el TOTAL final.
      return json({
        status: row.status,
        mp_payment_id: paywayPaymentId(row.mp_payment_id),
        amount: Number(row.amount),
      });
    }

    // Sólo hay algo que verificar si payway_checkout guardó un id de pago.
    const paymentId = paywayPaymentId(row.mp_payment_id);
    if (!paymentId) {
      return json({ status: "pending", mp_payment_id: null });
    }
    let r: Response;
    try {
      r = await fetch(`${v2}/payments/${paymentId}`, {
        headers: { apikey: sec.private_apikey },
      });
    } catch {
      return json({ status: "pending", mp_payment_id: null });
    }
    if (r.status === 404) {
      return json({ status: "pending", mp_payment_id: null });
    }
    if (!r.ok) {
      return json(
        { error: "payway_error", detail: (await r.text()).slice(0, 300) },
        502,
      );
    }
    const decision = decidePaymentStatus(
      await r.json().catch(() => null),
      Number(row.amount),
      row.id,
    );
    if (decision.status === "approved" || decision.status === "rejected") {
      await admin
        .from("mp_payment_intents")
        .update({ status: decision.status })
        .eq("id", row.id)
        .eq("status", "pending");
      return json({
        status: decision.status,
        mp_payment_id: decision.status === "approved" ? paymentId : null,
        amount: Number(row.amount),
      });
    }
    return json({ status: "pending", mp_payment_id: null });
  }

  return json({ error: "invalid_action" }, 400);
});
