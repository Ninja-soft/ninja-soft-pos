// =============================================================================
// Edge Function: getnet · Getnet Argentina canal QR + link (F8 · H18, ADR-031,
// ADR-065). Dos APIs según la credencial (secrets.api_profile):
//   * geopagos: OAuth auth.geopagos.com + Checkout API v2
//     (api.globalgetnet.com.ar/api/v2/orders). Sólo producción.
//   * global_*: Web Checkout del portal global (api.globalgetnet.com /
//     api.pre / api-sbx): POST /payment-intent → redirect_url.
// La orden devuelve un checkout hosted que el POS muestra como QR y como
// "Abrir link de pago" (QrCheckoutModal, provider 'getnet').
//
// Actions (body.action):
//   * probe {client_id?, client_secret?, environment?, store_id?} → prueba las
//     credenciales (las del body o las guardadas del alcance) contra cada API
//     del ambiente, en orden, y devuelve cuál funcionó y el diagnóstico de
//     cada intento (endpoint, HTTP, código del proveedor). Sólo dueño o
//     encargado. No guarda nada.
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='getnet'; habilita el gating fino del trigger de payments)
//     + orden en Getnet. preference_id guarda el id de la orden o del payment
//     intent; init_point, el checkout.
//   * status {intent_id} → re-consulta la orden y sincroniza (sólo acredita
//     con la confirmación de la API y monto verificado).
//
// Ambiente: secrets.environment (lo fija el wizard); si falta, el switch
// Sandbox del medio. Un perfil de prueba nunca se usa en producción.
// Gating real: tenant_has_feature_for(tenant,'getnet') en create.
// Lógica pura: ../_shared/getnet.ts (Vitest).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  createGetnetCheckout,
  decideFor,
  describeDetectFailure,
  describeDiag,
  detectGetnetProfile,
  fetchGetnetOrderFor,
  fetchGetnetSeller,
  type GetnetEnv,
  getnetEnvOf,
  logGetnetError,
} from "../_shared/getnet.ts";
import { getnetAuth, loadGetnetSandbox } from "../_shared/getnet_server.ts";
import {
  bodyStoreId,
  insertIntentWithScope,
  intentSecretScope,
  isScopeUuid,
  loadProviderSecret,
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

  // ── probe: prueba credenciales sin guardarlas ───────────────────────────────
  if (action === "probe") {
    if (!["owner", "manager"].includes(String(mem.role))) return json({ error: "forbidden" }, 403);
    let clientId = typeof b.client_id === "string" ? b.client_id.trim() : "";
    let clientSecret = typeof b.client_secret === "string" ? b.client_secret.trim() : "";
    let saved: Record<string, unknown> = {};
    if (!clientId || !clientSecret) {
      const scope = isScopeUuid(b.store_id) ? b.store_id : null;
      const row = await loadProviderSecret(admin, tenantId, "getnet", { scopeStoreId: scope });
      saved = row?.secrets ?? {};
      clientId = clientId || String(saved.client_id ?? "");
      clientSecret = clientSecret || String(saved.client_secret ?? "");
    }
    if (!clientId || !clientSecret) return json({ ok: false, error: "not_connected" });

    const env: GetnetEnv = b.environment === "test" || b.environment === "prod"
      ? b.environment
      : getnetEnvOf(saved, await loadGetnetSandbox(admin, tenantId));
    const r = await detectGetnetProfile(clientId, clientSecret, {
      env,
      preferred: saved.api_profile,
      crossEnv: true,
    });
    for (const d of r.attempts) logGetnetError("getnet.probe", d, { tenant_id: tenantId, ok: r.ok });
    if (!r.ok) {
      return json({
        ok: false,
        environment: env,
        mismatch: r.mismatch,
        summary: describeDetectFailure(r),
        attempts: r.attempts,
      });
    }

    const warnings: string[] = [];
    let seller = null;
    if (r.profile.api === "global") {
      const s = await fetchGetnetSeller(r.profile, r.token);
      if (s.ok) {
        seller = s.seller;
        if (s.seller.checkout_enabled === false) {
          warnings.push("Getnet indica que Web Checkout no está habilitado para tu comercio: pedile que lo activen.");
        }
        if (s.seller.country && s.seller.country !== "AR") {
          warnings.push(`El comercio está dado de alta en ${s.seller.country}, no en Argentina.`);
        }
      } else {
        logGetnetError("getnet.probe", s.diag, { tenant_id: tenantId });
        warnings.push(`El token anda, pero no pudimos leer los datos del comercio: ${describeDiag(s.diag)}`);
      }
      warnings.push(
        "Con esta API, Getnet avisa los pagos a una única URL que se configura en su Portal. Sin ella el cobro igual se confirma desde el POS.",
      );
    }
    return json({
      ok: true,
      environment: env,
      profile: r.profile.key,
      api: r.profile.api,
      label: r.profile.label,
      seller,
      warnings,
      attempts: r.attempts,
      webhook_url: `${url}/functions/v1/getnet_webhook`,
    });
  }

  const secretRow = await loadProviderSecret(
    admin,
    tenantId,
    "getnet",
    action === "create"
      ? { storeId: bodyStoreId(b) }
      : { scopeStoreId: await intentSecretScope(admin, String(b.intent_id ?? "")) },
  );
  const sec = (secretRow?.secrets ?? {}) as { client_id?: string; client_secret?: string };
  if (!secretRow || !sec.client_id || !sec.client_secret) {
    return json({ error: "not_connected" }, 400);
  }

  // ── create: intent local + orden en Getnet ──────────────────────────────────
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

    const auth = await getnetAuth(admin, tenantId, secretRow, "getnet.create");
    if (!auth.ok) {
      return json({ error: "getnet_no_token", detail: auth.detail, environment: auth.env, attempts: auth.attempts }, 502);
    }

    const { data: intent, error: intErr } = await insertIntentWithScope<{ id: string }>(
      admin,
      { tenant_id: tenantId, amount, provider_key: "getnet", mp_env: auth.env === "test" ? "test" : "prod" },
      secretRow.scopeStoreId ?? null,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    const hook = `${url}/functions/v1/getnet_webhook`;
    const res = await createGetnetCheckout(auth.profile, auth.token, {
      amount,
      title,
      intentId: intent.id,
      webhookUrl: `${hook}?intent=${intent.id}`,
      successUrl: `${hook}?view=success`,
      failedUrl: `${hook}?view=failed`,
      secrets: secretRow.secrets,
    });
    if (!res.ok) {
      logGetnetError("getnet.create", res.diag, { tenant_id: tenantId, intent_id: intent.id });
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json({ error: "getnet_error", detail: describeDiag(res.diag), diag: res.diag }, 502);
    }
    const created = res.created;

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
        api_profile: auth.profile.key,
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

    const auth = await getnetAuth(admin, tenantId, secretRow, "getnet.status");
    if (!auth.ok) return json({ error: "getnet_no_token", detail: auth.detail }, 502);
    const res = await fetchGetnetOrderFor(auth.profile, auth.token, String(row.preference_id));
    if (!res.ok) {
      if (res.httpStatus === 404) return json({ status: "pending", mp_payment_id: null });
      console.error(JSON.stringify({
        fn: "getnet.status",
        step: "status",
        profile: auth.profile.key,
        status: res.httpStatus,
        detail: res.detail.slice(0, 200),
      }));
      return json({ error: "getnet_error", detail: res.detail }, 502);
    }

    const d = decideFor(auth.profile, res.order, Number(row.amount));
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
        mp_payment_id: d.status === "approved" ? (d.paymentId ?? orderId) : null,
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
          payment_id: d.paymentId,
          state: d.state,
          reason: d.reason ?? null,
          amount: Number(row.amount),
          api_profile: auth.profile.key,
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
