// =============================================================================
// Edge Function: modo_create_qr — crea una intención de pago de MODO para cobrar
// por QR. Espeja mobbex_create_qr / mp_create_qr: auth del usuario → tenant →
// gating de plan (tenant_has_feature_for 'modo', ANTES de crear el intent) →
// credenciales MODO de payment_secrets (provider_key='modo', service_role) →
// registra un mp_payment_intents (provider_key='modo') → llama a la API de MODO
// para generar el cobro/QR → devuelve el init_point (deeplink/checkout de MODO)
// para mostrar como QR. verify_jwt = true.
//
// ⚠️ API DE MODO — ESTRUCTURA A VALIDAR CONTRA LA DOC/CREDENCIALES REALES ⚠️
// MODO no publica abiertamente el contrato de su API de e-commerce/QR para
// comercios (a diferencia de docs.modo.com.ar, que documenta "Conexiones":
// transferencias/CCT/VITA, otro producto). El flujo de acquiring de retail usa
// un token OAuth2 (client_credentials) + un endpoint de "payment-intentions" que
// devuelve un checkout/QR/deeplink, con webhooks de estado. TODO lo marcado con
// "VALIDAR MODO" abajo (base URL, paths, headers, nombres de campos del payload
// y de la respuesta, códigos de estado del webhook) debe confirmarse contra la
// doc oficial de MODO y las credenciales reales del comercio antes de cobrar en
// producción. La forma del flujo (auth→token→intención→QR→webhook) sí está
// modelada igual que Mobbex/MP y es la correcta; lo que falta verificar es el
// "dialecto" HTTP exacto de MODO.
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

// ⚠️ VALIDAR MODO — base URLs. MODO separa producción de preproducción. Los
// hosts reales se confirman con el alta del comercio (suelen ser del dominio de
// Play Digital / MODO). Se permite override por variable de entorno para no
// hardcodear y poder apuntar a sandbox sin redeploy.
const MODO_API_BASE =
  Deno.env.get("MODO_API_BASE") ?? "https://merchants.preprod.playdigital.com.ar";
// ⚠️ VALIDAR MODO — endpoint del token OAuth2 (client_credentials).
const MODO_TOKEN_URL =
  Deno.env.get("MODO_TOKEN_URL") ?? `${MODO_API_BASE}/merchants/v2/auth/token`;
// ⚠️ VALIDAR MODO — endpoint para crear la intención de pago (cobro/QR).
const MODO_INTENT_URL =
  Deno.env.get("MODO_INTENT_URL") ??
  `${MODO_API_BASE}/merchants/v2/payment-intentions`;

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
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
  const title = String(b.title ?? "Venta").slice(0, 120);

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

  // Gating de plan (enforcement real): el botón "Cobrar con QR · MODO" del POS
  // sólo se oculta en la UI; acá se bloquea de verdad. Esta Edge corre con
  // service_role (saltea RLS) y crea el intent ANTES del cobro. Sin el feature
  // 'modo' no se genera el QR. (El trigger en `payments` es la red de seguridad
  // para el registro de la venta — resuelve el proveedor por
  // mp_payment_intents.provider_key='modo'.)
  const { data: modoAllowed } = await admin.rpc("tenant_has_feature_for", {
    p_tenant: tenantId,
    p_key: "modo",
  });
  if (modoAllowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

  // Credenciales MODO del tenant (payment_secrets, RLS deny-all, sólo service_role).
  // ⚠️ VALIDAR MODO — nombres de los campos de credenciales. MODO entrega al
  // comercio un client_id + client_secret (para el token) y suele asociar un
  // store_id / merchant_id. Acá se leen los tres; se ajustan a lo que pida la
  // doc real. La UI de conexión (PaymentMethodsCard) guarda exactamente estas
  // claves vía set_payment_secret(provider_key='modo').
  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "modo")
    .maybeSingle();
  const sec = (secretRow?.secrets ?? {}) as {
    client_id?: string;
    client_secret?: string;
    store_id?: string;
  };
  if (!sec.client_id || !sec.client_secret) return json({ error: "not_connected" }, 400);

  // Intent pendiente (provider_key='modo' → habilita el gate fino del trigger).
  const { data: intent, error: intErr } = await admin
    .from("mp_payment_intents")
    .insert({ tenant_id: tenantId, amount, provider_key: "modo" })
    .select("id")
    .single();
  if (intErr || !intent) return json({ error: "intent_failed" }, 500);

  const webhook = `${url}/functions/v1/modo_webhook?intent=${intent.id}`;

  // ── Paso 1: token OAuth2 (client_credentials). ───────────────────────────
  // ⚠️ VALIDAR MODO — formato del request del token. Se modela como
  // client_credentials JSON; algunas integraciones MODO usan Basic Auth o
  // x-www-form-urlencoded. Confirmar contra la doc real.
  let accessToken = "";
  try {
    const tokRes = await fetch(MODO_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: sec.client_id,
        client_secret: sec.client_secret,
        grant_type: "client_credentials",
      }),
    });
    if (!tokRes.ok) {
      const detail = await tokRes.text();
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
      return json({ error: "modo_auth_error", detail: detail.slice(0, 300) }, 502);
    }
    const tok = (await tokRes.json()) as { access_token?: string; token?: string };
    accessToken = tok.access_token ?? tok.token ?? "";
  } catch (e) {
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json({ error: "modo_auth_unreachable", detail: String(e).slice(0, 200) }, 502);
  }
  if (!accessToken) {
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json({ error: "modo_no_token" }, 502);
  }

  // ── Paso 2: crear la intención de pago. ──────────────────────────────────
  // ⚠️ VALIDAR MODO — payload y nombres de campos de la intención. Modelado a
  // partir del patrón de e-commerce de MODO (intención con monto, moneda,
  // referencia externa del comercio, descripción y URLs de callback/webhook).
  // El monto se manda en unidades de la moneda (ARS, 2 decimales). Confirmar si
  // MODO espera centavos (entero) o decimal.
  const intentBody: Record<string, unknown> = {
    price: Math.round(amount * 100) / 100, // ⚠️ VALIDAR MODO: ¿`price`/`amount`/`total`? ¿decimal o centavos?
    currency: "ARS",
    external_intention_id: intent.id, // ⚠️ VALIDAR MODO: referencia del comercio (para conciliar el webhook).
    description: title,
    callback_url: webhook,
    webhook_url: webhook,
    store_id: sec.store_id, // ⚠️ VALIDAR MODO: requerido si el comercio tiene varias sucursales.
  };

  let intentRes: Response;
  try {
    intentRes = await fetch(MODO_INTENT_URL, {
      method: "POST",
      headers: {
        // ⚠️ VALIDAR MODO — esquema de auth del request de intención (Bearer es lo típico).
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(intentBody),
    });
  } catch (e) {
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json({ error: "modo_unreachable", detail: String(e).slice(0, 200) }, 502);
  }

  if (!intentRes.ok) {
    const detail = await intentRes.text();
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json({ error: "modo_error", detail: detail.slice(0, 300) }, 502);
  }

  // ⚠️ VALIDAR MODO — forma de la respuesta. MODO devuelve un id de la intención
  // y una/varias URLs para que el cliente pague: un "qr" (string para generar el
  // QR) y/o un "checkout"/"deeplink" (URL). El POS genera el QR a partir del
  // init_point, así que preferimos la URL de checkout/deeplink; si MODO sólo
  // diera un string de QR, ese string también sirve como `data` del QR.
  const out = (await intentRes.json()) as {
    id?: string;
    payment_intention_id?: string;
    qr?: string;
    deeplink?: string;
    checkout_url?: string;
    checkout?: { url?: string };
  };
  const initPoint =
    out.checkout_url ??
    out.checkout?.url ??
    out.deeplink ??
    out.qr ??
    "";
  const modoIntentId = out.id ?? out.payment_intention_id ?? null;
  if (!initPoint) {
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json({ error: "modo_no_checkout" }, 502);
  }

  await admin
    .from("mp_payment_intents")
    .update({ preference_id: modoIntentId, init_point: initPoint })
    .eq("id", intent.id);

  return json({ intent_id: intent.id, init_point: initPoint });
});
