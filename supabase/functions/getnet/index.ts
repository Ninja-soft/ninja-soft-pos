// =============================================================================
// Edge Function: getnet · Getnet Argentina (F8 · H18, ADR-031, ADR-065,
// ADR-069). Dos juegos de credenciales en la misma conexión (slots):
//   * web_checkout ("Web Checkout / Plugin Magento / Plugin WooCommerce"):
//     QR + link hosted. Dos APIs según secrets.api_profile:
//       - geopagos: OAuth auth.geopagos.com + api.globalgetnet.com.ar/api/v2.
//       - global_*: Web Checkout (api.globalgetnet.com / api.pre / api-sbx):
//         POST /payment-intent → redirect_url.
//   * checkout_api ("Checkout API / Plugin VTEX"): checkout PROPIO de NinjaPos
//     (/pagar/{intent}?p=getnet). Acá sólo se crea el intent; el cobro lo
//     hace la Edge pública getnet_checkout.
//
// Actions (body.action):
//   * capabilities → { own_checkout_enabled } (booleano del flag PCI, nunca
//     el secret). Cualquier miembro del negocio.
//   * probe {slot?, client_id?, client_secret?, environment?, store_id?} →
//     prueba las credenciales de un slot (las del body o las guardadas del
//     alcance) y avisa si parecen del otro slot. Sólo dueño o encargado. No
//     guarda nada.
//   * create {amount, title?, mode?, origin?} → intent local
//     (mp_payment_intents, provider_key='getnet'). mode 'own' = checkout
//     propio (init_point = {origin}/pagar/{intent}?p=getnet, sin llamar a
//     Getnet); si no, orden hosted en Getnet (preference_id = id de la orden).
//   * status {intent_id} → re-consulta en Getnet y sincroniza (sólo acredita
//     con la confirmación de la API y monto verificado). Para el checkout
//     propio consulta el payment_id guardado por getnet_checkout.
//
// Gating real: tenant_has_feature_for(tenant,'getnet') en create, y además
// 'getnet_checkout_propio' para mode 'own'.
// Lógica pura: ../_shared/getnet.ts y ../_shared/getnet_api.ts (Vitest).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  createGetnetCheckout,
  decideFor,
  describeDetectFailure,
  describeDiag,
  fetchGetnetOrderFor,
  type GetnetEnv,
  getnetEnvOf,
  logGetnetError,
} from "../_shared/getnet.ts";
import {
  API_INFO_PATH,
  type ApiAttempt,
  apiCredsOf,
  apiHeaders,
  decideApiPaymentInfo,
  isApiPaymentId,
  isOwnCheckoutIntent,
  makeAttempt,
  ownCheckoutUrl,
  requestApiToken,
  SLOT_MISMATCH_COPY,
  type SlotKey,
} from "../_shared/getnet_api.ts";
import {
  assessGetnetCredential,
  getnetAuth,
  getnetPanRelayEnabled,
  loadGetnetSandbox,
  loadGetnetSlot,
} from "../_shared/getnet_server.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope, isScopeUuid } from "../_shared/paymentSecrets.ts";

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

  // ── capabilities: ¿está habilitado el checkout propio? (ADR-069 adenda) ────
  // Sólo un booleano: nunca el valor del secret. Lo leen el asistente de
  // conexión (muestra o no la tarjeta Checkout API) y el POS (tender propio).
  if (action === "capabilities") {
    return json({ own_checkout_enabled: getnetPanRelayEnabled() });
  }

  // ── probe: prueba credenciales de un slot sin guardarlas ────────────────────
  if (action === "probe") {
    if (!["owner", "manager"].includes(String(mem.role))) return json({ error: "forbidden" }, 403);
    const slot: SlotKey = b.slot === "checkout_api" ? "checkout_api" : "web_checkout";
    // Checkout API sólo con el checkout propio habilitado (ADR-069 adenda).
    if (slot === "checkout_api" && !getnetPanRelayEnabled()) {
      return json({ ok: false, slot, error: "checkout_api_unavailable" });
    }
    const keyId = slot === "checkout_api" ? "api_client_id" : "client_id";
    const keySecret = slot === "checkout_api" ? "api_client_secret" : "client_secret";
    let clientId = typeof b.client_id === "string" ? b.client_id.trim() : "";
    let clientSecret = typeof b.client_secret === "string" ? b.client_secret.trim() : "";
    let saved: Record<string, unknown> = {};
    if (!clientId || !clientSecret) {
      const scope = isScopeUuid(b.store_id) ? b.store_id : null;
      const row = await loadGetnetSlot(admin, tenantId, slot, { scopeStoreId: scope });
      saved = row?.secrets ?? {};
      clientId = clientId || String(saved[keyId] ?? "");
      clientSecret = clientSecret || String(saved[keySecret] ?? "");
    }
    if (!clientId || !clientSecret) return json({ ok: false, slot, error: "not_connected" });

    const savedEnv = slot === "checkout_api" ? saved.api_environment : saved.environment;
    const env: GetnetEnv = b.environment === "test" || b.environment === "prod"
      ? b.environment
      : savedEnv === "test" || savedEnv === "prod"
        ? savedEnv
        : getnetEnvOf(saved, await loadGetnetSandbox(admin, tenantId));

    // Web Checkout: token (form) + GET /sellers. Checkout API: token (Basic).
    // Se prueban las dos para detectar credenciales del otro juego.
    const { web, webProduct, seller, sellerDiag, api, verdict } = await assessGetnetCredential({
      slot,
      clientId,
      clientSecret,
      env,
      preferred: slot === "web_checkout" ? saved.api_profile : undefined,
      crossEnv: slot === "web_checkout",
    });
    const pciReady = getnetPanRelayEnabled();
    for (const d of web.attempts) logGetnetError("getnet.probe", d, { tenant_id: tenantId, slot });

    if (slot === "checkout_api") {
      const attempts: ApiAttempt[] = api.ok ? [] : api.attempts;
      if (!api.ok) {
        console.error(JSON.stringify({ fn: "getnet.probe", slot, env, attempts }));
        return json({
          ok: false,
          slot,
          environment: env,
          slot_mismatch: verdict.mismatch,
          summary: verdict.mismatch
            ? SLOT_MISMATCH_COPY.checkout_api
            : "Getnet rechazó estas credenciales en la Checkout API. Revisá que sean las que dicen Checkout API / Plugin VTEX y el ambiente.",
          api_attempts: attempts,
        });
      }
      const warnings: string[] = [];
      if (api.claims.country && api.claims.country !== "AR") {
        warnings.push(`El comercio de estas credenciales está dado de alta en ${api.claims.country}, no en Argentina.`);
      }
      if (!api.claims.sellerId) {
        warnings.push("Getnet no informó el Seller ID en el token: cargalo a mano (te lo da tu ejecutivo).");
      }
      if (!pciReady) {
        warnings.push(
          "Las credenciales funcionan, pero el checkout propio con Getnet todavía no está habilitado en NinjaPos: Getnet no permite cargar la tarjeta sin que pase por nuestro servidor, y eso exige una certificación PCI que estamos tramitando. Mientras tanto cobrá con Web Checkout (QR y link).",
        );
      }
      return json({
        ok: true,
        slot,
        environment: env,
        api: "checkout_api",
        label: `Checkout API Getnet · ${env === "test" ? "prueba" : "producción"}`,
        seller_id: api.claims.sellerId,
        country: api.claims.country,
        own_checkout_ready: pciReady,
        warnings,
      });
    }

    // slot web_checkout. Credenciales de Checkout API / Plugin VTEX: se
    // rechazan con un texto único (no se guardan, ADR-069 adenda).
    if (!web.ok || webProduct === false) {
      if (verdict.mismatch) {
        return json({
          ok: false,
          slot,
          environment: env,
          slot_mismatch: true,
          summary: SLOT_MISMATCH_COPY.web_checkout,
          attempts: web.attempts,
        });
      }
      if (!web.ok) {
        return json({
          ok: false,
          slot,
          environment: env,
          mismatch: web.mismatch,
          summary: describeDetectFailure(web),
          attempts: web.attempts,
        });
      }
    }
    const warnings: string[] = [];
    if (web.ok && web.profile.api === "global") {
      if (seller?.checkout_enabled === false) {
        warnings.push("Getnet indica que Web Checkout no está habilitado para tu comercio: pedile que lo activen.");
      }
      if (seller?.country && seller.country !== "AR") {
        warnings.push(`El comercio está dado de alta en ${seller.country}, no en Argentina.`);
      }
      if (sellerDiag) {
        logGetnetError("getnet.probe", sellerDiag, { tenant_id: tenantId });
        warnings.push(`El token anda, pero no pudimos leer los datos del comercio: ${describeDiag(sellerDiag)}`);
      }
      warnings.push(
        "Con esta API, Getnet avisa los pagos a una única URL que se configura en su Portal. Sin ella el cobro igual se confirma desde el POS.",
      );
    }
    if (!web.ok) return json({ ok: false, slot, environment: env, summary: "No pudimos validar las credenciales." });
    return json({
      ok: true,
      slot,
      environment: env,
      profile: web.profile.key,
      api: web.profile.api,
      label: web.profile.label,
      seller,
      warnings,
      attempts: web.attempts,
      webhook_url: `${url}/functions/v1/getnet_webhook`,
    });
  }

  // ── create: intent local (+ orden en Getnet si es Web Checkout) ─────────────
  if (action === "create") {
    const own = b.mode === "own";
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "getnet",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);
    if (own) {
      const { data: ownAllowed } = await admin.rpc("tenant_has_feature_for", {
        p_tenant: tenantId,
        p_key: "getnet_checkout_propio",
      });
      if (ownAllowed !== true) return json({ error: "feature_not_in_plan", feature: "getnet_checkout_propio" }, 403);
    }

    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }
    const title = String(b.title ?? "Venta NinjaPos");

    if (own) {
      const row = await loadGetnetSlot(admin, tenantId, "checkout_api", { storeId: bodyStoreId(b) });
      const creds = apiCredsOf(row?.secrets);
      if (!row || !creds) return json({ error: "checkout_api_not_connected" }, 400);
      if (!getnetPanRelayEnabled()) return json({ error: "checkout_api_unavailable" }, 503);
      // Origen de la app que abre el checkout (multi-dominio: lo manda el POS).
      let origin = "";
      try {
        const o = new URL(String(b.origin ?? ""));
        if (o.protocol !== "https:" && o.hostname !== "localhost") return json({ error: "invalid_origin" }, 400);
        origin = o.origin;
      } catch {
        return json({ error: "invalid_origin" }, 400);
      }
      const { data: intent, error: intErr } = await insertIntentWithScope<{ id: string }>(
        admin,
        { tenant_id: tenantId, amount, provider_key: "getnet", mp_env: creds.env === "test" ? "test" : "prod" },
        row.scopeStoreId ?? null,
      );
      if (intErr || !intent) return json({ error: "intent_failed" }, 500);
      const initPoint = ownCheckoutUrl(origin, intent.id);
      await admin.from("mp_payment_intents").update({ init_point: initPoint }).eq("id", intent.id);
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: user.id,
        entity_type: "mp_payment_intents",
        entity_id: intent.id,
        action: "getnet_own_checkout_created",
        after_data: { amount, env: creds.env, title: title.slice(0, 120) },
      });
      return json({ intent_id: intent.id, init_point: initPoint });
    }

    const secretRow = await loadGetnetSlot(admin, tenantId, "web_checkout", { storeId: bodyStoreId(b) });
    if (!secretRow) {
      // Sólo hay Checkout API: no sirve para QR ni link hosted.
      const apiOnly = await loadGetnetSlot(admin, tenantId, "checkout_api", { storeId: bodyStoreId(b) });
      return json({ error: apiOnly ? "web_checkout_not_connected" : "not_connected" }, 400);
    }

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

  // ── status: re-consulta en Getnet y sincroniza el intent ────────────────────
  if (action === "status") {
    const intentId = String(b.intent_id ?? "");
    if (!intentId) return json({ error: "invalid_intent" }, 400);
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select("id, status, amount, preference_id, mp_payment_id, init_point")
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "getnet")
      .maybeSingle();
    if (!row) return json({ error: "intent_not_found" }, 404);
    const own = isOwnCheckoutIntent(row.init_point);

    if (row.status !== "pending") {
      // amount: el checkout propio puede sumar recargo de cuotas; el POS
      // registra la venta por el TOTAL final.
      return json({ status: row.status, mp_payment_id: row.mp_payment_id, amount: Number(row.amount) });
    }

    const scope = await intentSecretScope(admin, row.id);

    // Checkout propio: sólo hay algo que verificar si getnet_checkout guardó
    // el payment_id de un intento en curso.
    if (own) {
      if (!isApiPaymentId(row.mp_payment_id)) return json({ status: "pending", mp_payment_id: null });
      const apiRow = await loadGetnetSlot(admin, tenantId, "checkout_api", { scopeStoreId: scope });
      const creds = apiCredsOf(apiRow?.secrets);
      if (!creds) return json({ error: "checkout_api_not_connected" }, 400);
      const auth = await requestApiToken(creds);
      if (!auth.ok) return json({ error: "getnet_no_token", attempts: auth.attempts }, 502);
      const infoUrl = `${auth.host}${API_INFO_PATH}/${row.mp_payment_id}`;
      let r: Response;
      try {
        r = await fetch(infoUrl, {
          headers: apiHeaders(auth.token, { sellerId: creds.sellerId ?? auth.claims.sellerId }),
        });
      } catch {
        return json({ status: "pending", mp_payment_id: null });
      }
      if (r.status === 404) return json({ status: "pending", mp_payment_id: null });
      if (!r.ok) {
        const a = makeAttempt("status", infoUrl, r.status, await r.text().catch(() => ""), [creds.clientId, creds.clientSecret]);
        console.error(JSON.stringify({ fn: "getnet.status", own: true, ...a }));
        return json({ error: "getnet_error", detail: a.message ?? `HTTP ${a.http_status}` }, 502);
      }
      const d = decideApiPaymentInfo(await r.json().catch(() => null), Number(row.amount));
      if (d.status === "pending") return json({ status: "pending", mp_payment_id: null, state: d.state });
      if (d.status === "approved") {
        const paid = (d.amountCents ?? Math.round(Number(row.amount) * 100)) / 100;
        const { data: changed } = await admin
          .from("mp_payment_intents")
          .update({ status: "approved", amount: paid })
          .eq("id", row.id)
          .eq("status", "pending")
          .select("id");
        if (changed && changed.length > 0) {
          await admin.from("audit_logs").insert({
            tenant_id: tenantId,
            actor_user_id: user.id,
            entity_type: "mp_payment_intents",
            entity_id: row.id,
            action: "getnet_payment_approved",
            after_data: { payment_id: row.mp_payment_id, state: d.state, amount: paid, base: Number(row.amount), via: "status", channel: "checkout_api" },
          });
        }
        return json({ status: "approved", mp_payment_id: row.mp_payment_id, amount: paid });
      }
      if (d.reason === "amount_mismatch") {
        // Getnet confirmó menos que la base: no se acredita.
        await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", row.id).eq("status", "pending");
        return json({ status: "rejected", mp_payment_id: null });
      }
      // Rechazo o anulación del intento en curso: el intent sigue pendiente
      // para que el cliente reintente con otra tarjeta.
      await admin
        .from("mp_payment_intents")
        .update({ mp_payment_id: null })
        .eq("id", row.id)
        .eq("status", "pending")
        .eq("mp_payment_id", row.mp_payment_id);
      return json({ status: "pending", mp_payment_id: null, state: d.state });
    }

    if (!row.preference_id) return json({ status: "pending", mp_payment_id: null });
    const secretRow = await loadGetnetSlot(admin, tenantId, "web_checkout", { scopeStoreId: scope });
    if (!secretRow) return json({ error: "not_connected" }, 400);

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
