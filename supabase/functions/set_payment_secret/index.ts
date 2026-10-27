// =============================================================================
// Edge Function: set_payment_secret — guarda secretos de un proveedor de pago
// (ej. Access Token de Mercado Pago) por tenant. SOLO owner/manager del tenant.
// service_role solo acá: payment_secrets tiene RLS deny a todos.
// Marca tenant_payment_methods.config.connected = true (no secreto) para la UI.
//
// ADR-057: body.store_id opcional = credencial propia de esa sucursal (pisa a
// la del negocio). Validado en el servidor con payment_secret_scope_check
// (dueño o encargado con acceso a la sucursal, plan con multi_sucursal). Una
// credencial de sucursal NO toca tenant_payment_methods.config.connected (eso
// refleja la del negocio); la UI lee payment_secret_scopes().
//
// Getnet (ADR-069 adenda): rechaza las claves del slot Checkout API mientras
// el checkout propio esté apagado y prueba un Client ID / Secret nuevo de Web
// Checkout antes de guardarlo (no guarda credenciales de Checkout API / Plugin
// VTEX ni credenciales que Getnet rechaza).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  deleteProviderSecret,
  isScopeUuid,
  loadProviderSecret,
  saveProviderSecret,
  scopeErrorStatus,
} from "../_shared/paymentSecrets.ts";
import { assessGetnetCredential, getnetPanRelayEnabled } from "../_shared/getnet_server.ts";
import { webCheckoutSaveVerdict } from "../_shared/getnet_api.ts";
import { isAuthFailure, parseCreds as parseUalaCreds, ualabisClient } from "../_shared/ualabis.ts";
import {
  isAuthFailure as isViumiAuthFailure,
  parseCreds as parseViumiCreds,
  viumiClient,
} from "../_shared/viumi.ts";
import { isAuthFailure as isTaloAuthFailure, parseCreds as parseTaloCreds, taloClient } from "../_shared/talo.ts";
import {
  clampTimeoutSeconds as clampDirectoTimeout,
  directoClient,
  isAuthFailure as isDirectoAuthFailure,
  normalizeBaseUrl as normalizeDirectoBase,
  normalizePolicyProduct as normalizeDirectoPolicy,
  parseCreds as parseDirectoCreds,
} from "../_shared/directo.ts";

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

const ALLOWED = new Set([
  "mercadopago",
  "mercadopago_point",
  "modo",
  "payway",
  "getnet",
  "fiserv",
  "mobbex",
  "pagos360",
  // H21c — Nave (ADR-030): client_id, client_secret, pos_id (QR + link),
  // point_pos_ids y audience opcionales. Nave Point reutiliza ESTA conexión
  // (no hay provider 'nave_point' de secretos).
  "nave",
  // GO Cuotas (ADR-033): { api_key } de la sucursal (Bearer). El ambiente lo
  // define el switch Sandbox del medio (sandbox.gocuotas.com vs www).
  "gocuotas",
  // Directo (ADR-181, API Ecommerce 2.0): username, password, policy_product
  // (opcional, producto o código de política), timeout_seconds (opcional,
  // 5..120) y api_base_url (avanzado, https). El host sale del switch Sandbox
  // (QA o producción). Se prueban con un login antes de guardarlas (nunca un
  // scoring).
  "directo",
  // Ualá Bis (ADR-143): username, client_id y client_secret_id de Ualá Bis ›
  // Cobros online › API. El ambiente lo define el switch Sandbox del medio
  // (stage vs producción). Se prueban antes de guardarlas.
  "ualabis",
  // Viumi (ADR-173): client_id y client_secret que Viumi le manda al comercio.
  // El ambiente lo define el switch Sandbox del medio (stg vs producción). Se
  // prueban antes de guardarlas.
  "viumi",
  // Talo (ADR-175): user_id, client_id y client_secret del Dashboard de Talo ›
  // Usuario › Credenciales. El ambiente lo define el switch Sandbox del medio
  // (sandbox-api vs api). Se prueban antes de guardarlas.
  "talo",
]);

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
  const providerKey = String(b.provider_key ?? "").trim();
  if (!ALLOWED.has(providerKey)) return json({ error: "invalid_provider" }, 400);

  const action = b.action === "clear" ? "clear" : "set";
  const secrets = (b.secrets ?? {}) as Record<string, unknown>;
  if (b.store_id != null && !isScopeUuid(b.store_id)) return json({ error: "invalid_store" }, 400);
  const storeId = isScopeUuid(b.store_id) ? b.store_id : null;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Guard: owner/manager activo del tenant (y, por sucursal, acceso a ella y
  // multi_sucursal en el plan).
  const { data: scopeErr, error: scopeRpcErr } = await admin.rpc("payment_secret_scope_check", {
    p_tenant: tenantId,
    p_user: user.id,
    p_store: storeId,
  });
  if (scopeRpcErr) {
    // Base sin la migración: sólo existe la credencial del negocio.
    if (storeId) return json({ error: "store_scope_unavailable" }, 409);
    const { data: mem } = await admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!mem || !["owner", "manager"].includes(mem.role as string)) {
      return json({ error: "forbidden" }, 403);
    }
  } else if (scopeErr) {
    return json({ error: scopeErr }, scopeErrorStatus(String(scopeErr)));
  }

  if (action === "clear") {
    await deleteProviderSecret(admin, { tenantId, providerKey, storeId });
    if (!storeId) {
      await admin.from("tenant_payment_methods").upsert(
        { tenant_id: tenantId, provider_key: providerKey, config: { connected: false } },
        { onConflict: "tenant_id,provider_key" },
      );
    }
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "payment_secrets",
      entity_id: null,
      action: "payment_secret_cleared",
      after_data: { provider_key: providerKey, store_id: storeId },
    });
    return json({ ok: true, connected: false, store_id: storeId });
  }

  // Limpia/recorta strings de los secretos.
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string" && v.trim()) clean[k] = v.trim();
  }
  // Getnet (ADR-069 adenda): sólo se cargan las credenciales de Web Checkout.
  //   * Las claves api_* (slot Checkout API) se rechazan mientras el checkout
  //     propio esté apagado (secret GETNET_CHECKOUT_API_PCI_ATTESTED).
  //   * Un Client ID / Secret nuevo en Web Checkout se prueba antes de
  //     guardarlo: si es de Checkout API / Plugin VTEX, o Getnet lo rechaza
  //     como inválido, no se guarda.
  if (providerKey === "getnet") {
    if (Object.keys(clean).some((k) => k.startsWith("api_")) && !getnetPanRelayEnabled()) {
      return json({ error: "checkout_api_unavailable" }, 409);
    }
    if (clean.client_id && clean.client_secret) {
      const a = await assessGetnetCredential({
        slot: "web_checkout",
        clientId: clean.client_id,
        clientSecret: clean.client_secret,
        env: clean.environment === "test" ? "test" : "prod",
        preferred: clean.api_profile,
      });
      const verdict = webCheckoutSaveVerdict({
        webToken: a.web.ok,
        webProduct: a.webProduct,
        apiToken: a.api.ok,
        webFailKinds: a.web.attempts.map((d) => d.kind),
      });
      if (verdict === "checkout_api_credentials") return json({ error: "getnet_checkout_api_credentials" }, 422);
      if (verdict === "invalid_credentials") return json({ error: "getnet_invalid_credentials" }, 422);
    }
  }

  // Ualá Bis (ADR-143): credenciales nuevas se prueban pidiendo un token en el
  // ambiente elegido. Si Ualá las rechaza, no se guardan (un corte de red no
  // frena el guardado: "Probar conexión" lo muestra después).
  if (providerKey === "ualabis") {
    const creds = parseUalaCreds(clean);
    if (!creds) return json({ error: "ualabis_missing_fields" }, 400);
    const env = clean.environment === "test" ? "stage" : "prod";
    const t = await ualabisClient({ creds, env }).token(true);
    if (!t.ok && isAuthFailure(t.httpStatus)) return json({ error: "ualabis_invalid_credentials" }, 422);
    delete clean.environment;
  }

  // Viumi (ADR-173): igual que Ualá Bis, se pide un token en el ambiente
  // elegido antes de guardar. Rechazo de credenciales = no se guardan.
  if (providerKey === "viumi") {
    const creds = parseViumiCreds(clean);
    if (!creds) return json({ error: "viumi_missing_fields" }, 400);
    const env = clean.environment === "test" ? "stage" : "prod";
    const t = await viumiClient({ creds, env }).token(true);
    if (!t.ok && isViumiAuthFailure(t.httpStatus)) return json({ error: "viumi_invalid_credentials" }, 422);
    delete clean.environment;
  }

  // Talo (ADR-175): credenciales nuevas se prueban pidiendo un token TL- en el
  // ambiente elegido. Si Talo las rechaza, no se guardan (un corte de red no
  // frena el guardado: "Probar conexión" lo muestra después).
  if (providerKey === "talo") {
    const creds = parseTaloCreds(clean);
    if (!creds || creds.kind !== "client") return json({ error: "talo_missing_fields" }, 400);
    const env = clean.environment === "test" ? "sandbox" : "prod";
    const t = await taloClient({ creds, env }).token(true);
    if (!t.ok && isTaloAuthFailure(t.httpStatus)) return json({ error: "talo_invalid_credentials" }, 422);
    delete clean.environment;
  }

  // Directo (ADR-181): sólo usuario y contraseña son obligatorios. Se prueba
  // un login en el ambiente elegido; si Directo rechaza las credenciales, no
  // se guardan (un corte de red no frena el guardado). Las claves de la API
  // vieja (api_key, subscription_key, merchant_*) no se guardan más.
  if (providerKey === "directo") {
    const env = clean.environment === "test" ? "qa" : "prod";
    delete clean.environment;
    const next: Record<string, string> = {};
    const username = clean.username ?? clean.merchant_username;
    const password = clean.password ?? clean.merchant_password;
    if (!username || !password) return json({ error: "directo_missing_fields" }, 400);
    next.username = username;
    next.password = password;
    if (clean.policy_product) {
      const pp = normalizeDirectoPolicy(clean.policy_product);
      if (!pp) return json({ error: "directo_invalid_policy_product" }, 400);
      next.policy_product = pp;
    }
    if (clean.timeout_seconds) next.timeout_seconds = String(clampDirectoTimeout(clean.timeout_seconds));
    if (clean.api_base_url) {
      const base = normalizeDirectoBase(clean.api_base_url);
      if (!base) return json({ error: "directo_invalid_base_url" }, 400);
      next.api_base_url = base;
    }
    const creds = parseDirectoCreds(next);
    if (!creds) return json({ error: "directo_missing_fields" }, 400);
    const t = await directoClient({ creds, env }).token(true);
    if (!t.ok && isDirectoAuthFailure(t.httpStatus)) return json({ error: "directo_invalid_credentials" }, 422);
    for (const k of Object.keys(clean)) delete clean[k];
    Object.assign(clean, next);
  }

  // merge (ADR-032): agrega/quita claves sin pisar el resto del secreto. Lo
  // usa Mercado Pago para el token de PRUEBA (test_access_token), que convive
  // con la conexión de producción (OAuth o token manual).
  const merge = b.merge === true;
  const remove = Array.isArray(b.remove)
    ? (b.remove as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  if (Object.keys(clean).length === 0 && !(merge && remove.length > 0)) {
    return json({ error: "empty_secrets" }, 400);
  }

  // Fila previa de ESTE alcance (nunca la del negocio para una sucursal).
  const prevOfScope = async (): Promise<Record<string, unknown>> => {
    const prev = await loadProviderSecret(admin, tenantId, providerKey, { scopeStoreId: storeId });
    return prev && prev.scopeStoreId === storeId ? prev.secrets : {};
  };

  let next: Record<string, unknown> = clean;
  if (merge) {
    next = { ...(await prevOfScope()), ...clean };
    for (const k of remove) delete next[k];
  } else if (providerKey === "mercadopago") {
    // Reemplazo del token de producción: conserva el de prueba si había.
    const testToken = ((await prevOfScope()) as { test_access_token?: string }).test_access_token;
    if (testToken && !clean.test_access_token) next = { ...clean, test_access_token: testToken };
  }

  const up = await saveProviderSecret(admin, { tenantId, providerKey, storeId, secrets: next });
  if (up.error) return json({ error: "save_failed", detail: up.error.message }, 500);

  if (storeId) {
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "payment_secrets",
      entity_id: null,
      action: "payment_secret_set",
      after_data: {
        provider_key: providerKey,
        store_id: storeId,
        keys: Object.keys(clean),
        ...(merge ? { merge: true, removed: remove } : {}),
      },
    });
    return json({ ok: true, connected: true, store_id: storeId });
  }

  // Marca conectado (sin exponer el secreto) para la UI, sin pisar otros flags.
  // test_connected: hay token de prueba (switch Sandbox de Mercado Pago).
  const { data: cur } = await admin
    .from("tenant_payment_methods")
    .select("config")
    .eq("tenant_id", tenantId)
    .eq("provider_key", providerKey)
    .maybeSingle();
  const hasSecret = Object.keys(next).some((k) => k !== "test_access_token");
  const config: Record<string, unknown> = {
    ...((cur?.config as Record<string, unknown>) ?? {}),
    connected: hasSecret || Boolean(next.test_access_token),
  };
  if (providerKey === "mercadopago") config.test_connected = Boolean(next.test_access_token);
  // Getnet (ADR-069): dos slots en la misma credencial. `connected` = alguno
  // cargado; el POS ofrece QR y link sólo con Web Checkout y el checkout
  // propio sólo con Checkout API.
  if (providerKey === "getnet") {
    const has = (k: string) => typeof next[k] === "string" && (next[k] as string).trim() !== "";
    config.web_checkout_connected = has("client_id") && has("client_secret");
    config.checkout_api_connected = has("api_client_id") && has("api_client_secret");
    config.connected = config.web_checkout_connected === true || config.checkout_api_connected === true;
  }
  await admin.from("tenant_payment_methods").upsert(
    { tenant_id: tenantId, provider_key: providerKey, config },
    { onConflict: "tenant_id,provider_key" },
  );

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "payment_secrets",
    entity_id: null,
    action: "payment_secret_set",
    after_data: {
      provider_key: providerKey,
      store_id: null,
      keys: Object.keys(clean),
      ...(merge ? { merge: true, removed: remove } : {}),
    },
  });

  return json({ ok: true, connected: true });
});
