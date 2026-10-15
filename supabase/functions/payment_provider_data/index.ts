// =============================================================================
// Edge Function: payment_provider_data (ADR-061): "Datos del procesador" de un
// cobro, pedidos a la API del proveedor con la credencial que lo creó.
//
// Body: { payment_id?: uuid, intent_id?: uuid, refresh?: boolean }
//   * payment_id: cobro de una venta (payments.reference = id del intent).
//   * intent_id: intent sin venta (cobro sin venta en la conciliación).
//
// Resolución: intent → provider_key + ids del proveedor (mp_payment_id,
// mp_order_id, preference_id) + credencial exacta (secret_store_id, ADR-057)
// y ambiente del intent (mp_env). Normaliza con _shared/processorData.ts y
// guarda la foto en payment_provider_snapshots (service_role). Sin `refresh`
// devuelve la foto si tiene menos de 10 minutos; con `refresh`, como mucho una
// consulta cada 15 segundos por cobro.
//
// Proveedores con consulta: Mercado Pago (pagos y Orders, QR y Point), Payway,
// Nave (QR y Point), GO Cuotas, Clover (Fiserv) y Getnet. Directo, MODO,
// Mobbex y Pagos360 no exponen la consulta de un pago con estos datos: se
// responde `no_api` y el detalle muestra lo guardado en el POS.
//
// Seguridad: usuario autenticado con membresía activa en el negocio actual.
// Comisiones, impuestos, neto y pagador sólo para dueño o encargado (mismo
// criterio que la RLS de la tabla de fotos). Nunca devuelve el crudo.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders, tenantMpCredential } from "../_shared/mpAuth.ts";
import type { MpEnv } from "../_shared/mpOrders.ts";
import { loadProviderSecret } from "../_shared/paymentSecrets.ts";
import { paywayPaymentId, paywayV2Base } from "../_shared/payway.ts";
import { loadNaveConnection, fetchJson as naveFetch, channelOf } from "../_shared/nave_server.ts";
import { isSafeNaveId, naveApiBase } from "../_shared/nave.ts";
import { resolveOrder as goResolveOrder } from "../_shared/gocuotas.ts";
import { envOfIntent as goEnvOf, loadApiKeyScoped as goKey } from "../_shared/gocuotas_server.ts";
import { loadConnectionForIntent as cloverConn } from "../_shared/clover_server.ts";
import { cloverApiBase, isSafeCloverId } from "../_shared/clover.ts";
import { fetchGetnetOrderFor } from "../_shared/getnet.ts";
import { getnetAuth, loadGetnetSlot } from "../_shared/getnet_server.ts";
import { API_INFO_PATH, apiCredsOf, apiHeaders, isApiPaymentId, requestApiToken } from "../_shared/getnet_api.ts";
import { type ProcessorPaymentData, normalizeProcessorPayment } from "../_shared/processorData.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 15 * 1000;

// deno-lint-ignore no-explicit-any
type Admin = any;

type Intent = {
  id: string;
  tenant_id: string;
  provider_key: string;
  status: string;
  amount: number | string;
  mp_payment_id: string | null;
  mp_order_id: string | null;
  preference_id: string | null;
  point_device_id: string | null;
  mp_env: string | null;
  created_at: string;
  secret_store_id: string | null;
};

type Fetched = { ok: true; externalId: string; raw: unknown } | { ok: false; error: string; detail?: string };

const INTENT_COLS =
  "id, tenant_id, provider_key, status, amount, mp_payment_id, mp_order_id, preference_id, point_device_id, mp_env, created_at, secret_store_id";

// ── Fetch por proveedor ──────────────────────────────────────────────────────

async function fetchMercadoPago(admin: Admin, it: Intent): Promise<Fetched> {
  const cred = await tenantMpCredential(admin, it.tenant_id, (it.mp_env as MpEnv | null) ?? "prod", {
    scopeStoreId: it.secret_store_id,
  });
  if (!cred) return { ok: false, error: "not_connected" };
  const get = async (path: string) => {
    const r = await fetch(`${MP_API}${path}`, { headers: mpHeaders(cred.token) });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  };

  let paymentId = it.mp_payment_id && /^\d+$/.test(it.mp_payment_id) ? it.mp_payment_id : null;
  // Orders API (QR dinámico y Point, ADR-032): el id del pago de la order es
  // PAY...; el de /v1/payments viene en reference_id.
  if (!paymentId && it.mp_order_id) {
    const o = await get(`/v1/orders/${encodeURIComponent(it.mp_order_id)}`);
    if (!o.ok) return { ok: false, error: "provider_error", detail: `order ${o.status}` };
    const pays = ((o.body as { transactions?: { payments?: { reference_id?: unknown; id?: unknown }[] } })
      ?.transactions?.payments ?? []);
    const ref = pays.map((p) => String(p.reference_id ?? "")).find((v) => /^\d+$/.test(v));
    if (!ref) return { ok: true, externalId: it.mp_order_id, raw: { order: o.body } };
    paymentId = ref;
  }
  if (!paymentId) return { ok: false, error: "no_external_id" };
  const p = await get(`/v1/payments/${paymentId}`);
  if (!p.ok) return { ok: false, error: p.status === 404 ? "not_found" : "provider_error", detail: `payment ${p.status}` };
  return { ok: true, externalId: paymentId, raw: p.body };
}

async function fetchPayway(admin: Admin, it: Intent): Promise<Fetched> {
  const sec = (await loadProviderSecret(admin, it.tenant_id, "payway", { scopeStoreId: it.secret_store_id }))
    ?.secrets as { private_apikey?: string } | undefined;
  if (!sec?.private_apikey) return { ok: false, error: "not_connected" };
  const paymentId = paywayPaymentId(it.mp_payment_id);
  if (!paymentId) return { ok: false, error: "no_external_id" };
  const { data: m } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", it.tenant_id)
    .eq("provider_key", "payway")
    .maybeSingle();
  const r = await fetch(`${paywayV2Base(m?.sandbox)}/payments/${paymentId}`, {
    headers: { apikey: sec.private_apikey },
  });
  if (!r.ok) return { ok: false, error: r.status === 404 ? "not_found" : "provider_error", detail: `payway ${r.status}` };
  return { ok: true, externalId: paymentId, raw: await r.json().catch(() => null) };
}

async function fetchNave(admin: Admin, it: Intent): Promise<Fetched> {
  const conn = await loadNaveConnection(admin, it.tenant_id, { scopeStoreId: it.secret_store_id });
  if (!conn) return { ok: false, error: "not_connected" };
  if (!isSafeNaveId(it.mp_payment_id)) return { ok: false, error: "no_external_id" };
  const base = naveApiBase(conn.env, channelOf(it.provider_key));
  const r = await naveFetch(conn.client, "GET", `${base}/integrations/payments/${it.mp_payment_id}`);
  if (!r.ok) return { ok: false, error: "provider_error", detail: `nave ${r.status}` };
  return { ok: true, externalId: it.mp_payment_id, raw: r.body };
}

async function fetchGoCuotas(admin: Admin, it: Intent): Promise<Fetched> {
  const key = await goKey(admin, it.tenant_id, { scopeStoreId: it.secret_store_id });
  if (!key) return { ok: false, error: "not_connected" };
  const look = await goResolveOrder({
    env: goEnvOf(it),
    apiKey: key.key,
    intentId: it.id,
    createdAt: it.created_at,
    hintedOrderId: it.mp_payment_id ?? it.preference_id,
  });
  if (!look.ok) return { ok: false, error: "provider_error", detail: look.detail };
  if (!look.order) return { ok: false, error: "not_found" };
  const id = String((look.order as { id?: unknown }).id ?? it.mp_payment_id ?? it.id);
  return { ok: true, externalId: id, raw: look.order };
}

async function fetchClover(admin: Admin, it: Intent): Promise<Fetched> {
  const conn = await cloverConn(admin, it);
  if (!conn) return { ok: false, error: "not_connected" };
  if (!isSafeCloverId(it.mp_payment_id)) return { ok: false, error: "no_external_id" };
  const r = await conn.request(
    `${cloverApiBase(conn.env)}/v3/merchants/${conn.merchantId}/payments/${it.mp_payment_id}?expand=tender,cardTransaction`,
  );
  if (!r.ok) return { ok: false, error: "provider_error", detail: `clover ${r.status}` };
  return { ok: true, externalId: it.mp_payment_id, raw: await r.json().catch(() => null) };
}

async function fetchGetnet(admin: Admin, it: Intent): Promise<Fetched> {
  // Checkout propio (Checkout API, ADR-069): sin orden hosted, con el
  // payment_id que guardó getnet_checkout.
  if (!it.preference_id && isApiPaymentId(it.mp_payment_id)) {
    const apiRow = await loadGetnetSlot(admin, it.tenant_id, "checkout_api", { scopeStoreId: it.secret_store_id });
    const creds = apiCredsOf(apiRow?.secrets);
    if (!creds) return { ok: false, error: "not_connected" };
    const auth = await requestApiToken(creds);
    if (!auth.ok) return { ok: false, error: "provider_auth_failed" };
    const r = await fetch(`${auth.host}${API_INFO_PATH}/${it.mp_payment_id}`, {
      headers: apiHeaders(auth.token, { sellerId: creds.sellerId ?? auth.claims.sellerId }),
    }).catch(() => null);
    if (!r || !r.ok) return { ok: false, error: "provider_error", detail: `getnet ${r?.status ?? 0}` };
    return { ok: true, externalId: it.mp_payment_id, raw: await r.json().catch(() => null) };
  }
  const row = await loadGetnetSlot(admin, it.tenant_id, "web_checkout", { scopeStoreId: it.secret_store_id });
  if (!row) return { ok: false, error: "not_connected" };
  if (!it.preference_id) return { ok: false, error: "no_external_id" };
  const auth = await getnetAuth(admin, it.tenant_id, row, "payment_provider_data");
  if (!auth.ok) return { ok: false, error: "provider_auth_failed", detail: auth.detail };
  const r = await fetchGetnetOrderFor(auth.profile, auth.token, it.preference_id);
  if (!r.ok) return { ok: false, error: "provider_error", detail: r.detail };
  return { ok: true, externalId: it.preference_id, raw: r.order };
}

function fetcherFor(providerKey: string): ((admin: Admin, it: Intent) => Promise<Fetched>) | null {
  switch (providerKey) {
    case "mercadopago":
    case "mercadopago_point":
      return fetchMercadoPago;
    case "payway":
    case "payway_point":
      return fetchPayway;
    case "nave":
    case "nave_point":
      return fetchNave;
    case "gocuotas":
      return fetchGoCuotas;
    case "fiserv_point":
      return fetchClover;
    case "getnet":
      return fetchGetnet;
    default:
      return null;
  }
}

/** Sin comisiones, neto ni pagador para quien no es dueño o encargado. */
function forRole(d: ProcessorPaymentData, manager: boolean): ProcessorPaymentData {
  if (manager) return d;
  return { ...d, fees: [], fee_total: 0, taxes_total: 0, net: null, payer: null };
}

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
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);
  const manager = mem.role === "owner" || mem.role === "manager";

  const paymentId = typeof b.payment_id === "string" && UUID_RE.test(b.payment_id) ? b.payment_id : null;
  let intentId = typeof b.intent_id === "string" && UUID_RE.test(b.intent_id) ? b.intent_id : null;
  if (!paymentId && !intentId) return json({ error: "invalid_args" }, 400);

  if (paymentId) {
    const { data: pay } = await admin
      .from("payments")
      .select("id, reference")
      .eq("id", paymentId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!pay) return json({ error: "payment_not_found" }, 404);
    const ref = String(pay.reference ?? "");
    if (UUID_RE.test(ref)) intentId = ref;
  }
  if (!intentId) return json({ status: "no_provider" });

  const { data: intent } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!intent) return json({ status: "no_provider" });
  const it = intent as Intent;

  const fetcher = fetcherFor(it.provider_key);
  if (!fetcher) return json({ status: "no_api", provider: it.provider_key });

  // Foto vigente.
  const { data: snaps } = await admin
    .from("payment_provider_snapshots")
    .select("id, external_id, normalized, fetched_at, error")
    .eq("tenant_id", tenantId)
    .eq("intent_id", it.id)
    .order("fetched_at", { ascending: false })
    .limit(1);
  const snap = (snaps ?? [])[0] as
    | { id: string; external_id: string; normalized: ProcessorPaymentData; fetched_at: string; error: string | null }
    | undefined;
  const age = snap ? Date.now() - Date.parse(snap.fetched_at) : Infinity;
  if (snap && !snap.error && (age < (b.refresh === true ? MIN_REFRESH_MS : CACHE_MS))) {
    return json({ status: "ok", cached: true, fetched_at: snap.fetched_at, data: forRole(snap.normalized, manager) });
  }

  let res: Fetched;
  try {
    res = await fetcher(admin, it);
  } catch (e) {
    res = { ok: false, error: "provider_error", detail: String(e).slice(0, 200) };
  }
  if (!res.ok) {
    // Si hay una foto anterior, se devuelve con el aviso.
    if (snap) {
      return json({
        status: "stale",
        error: res.error,
        fetched_at: snap.fetched_at,
        data: forRole(snap.normalized, manager),
      });
    }
    return json({ status: "error", error: res.error, detail: res.detail ?? null, provider: it.provider_key });
  }

  const normalized = normalizeProcessorPayment(it.provider_key, res.raw);
  if (!normalized.external_id) normalized.external_id = res.externalId;
  const now = new Date().toISOString();
  await admin.from("payment_provider_snapshots").upsert(
    {
      tenant_id: tenantId,
      ...(paymentId ? { payment_id: paymentId } : {}),
      intent_id: it.id,
      provider_key: it.provider_key,
      external_id: res.externalId,
      normalized,
      raw: res.raw,
      error: null,
      fetched_at: now,
      fetched_by: user.id,
    },
    { onConflict: "tenant_id,provider_key,external_id" },
  );
  return json({ status: "ok", cached: false, fetched_at: now, data: forRole(normalized, manager) });
});
