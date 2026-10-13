// =============================================================================
// Getnet Argentina (Geopagos white-label) · lógica pura compartida por las Edge
// `getnet` y `getnet_webhook` (y testeada con Vitest en tests/unit/getnet.test.ts).
// Sin imports: corre igual en Deno (Edge) y en Node (tests).
//
// VERIFICADO contra el plugin oficial "integrar-getnet-con-woo" v0.1.5
// (autor Getnet Argentina / Wanderlust):
//   * Token: POST https://auth.geopagos.com/oauth/token, JSON
//     { client_id, client_secret, grant_type:'client_credentials', scope:'*' }
//     → { access_token }.
//   * Crear orden: POST https://api.globalgetnet.com.ar/api/v2/orders
//     headers Content-Type/Accept: application/vnd.api+json, Bearer token.
//     body { data: { attributes: { items:[{ id, name, unitPrice:{ currency:'032',
//     amount:'<centavos sin punto>' }, quantity }], redirect_urls:{ success,
//     failed }, webhookUrl, expireLimitMinutes } } }
//     → data.links[0].checkout (URL hosted), data.attributes.payments[0].reference_number.
//   * Webhook: body.data.order.uuid → GET /api/v2/orders/{uuid} y se mira
//     `status` (raíz): APPROVED | PROCESSED | SUCCESS = pago aprobado.
// INFERIDO (no está en el plugin ni en docs públicas de AR):
//   * uuid de la orden en data.id (fallback attributes.uuid / data.uuid).
//   * Forma del monto en el GET (se prioriza la suma de ítems, mismo formato
//     que el request; fallback amount/total/totalAmount).
//   * Estados de rechazo/vencimiento (REJECTED, EXPIRED, …).
//   * Que el GET acepte el mismo Bearer (el plugin arma mal ese header).
//   * No hay sandbox público de la API Geopagos: se valida con cobros reales.
//
// DOS APIs (fix/getnet-credenciales, ADR-065). Getnet Argentina entrega dos
// tipos de credenciales que NO son intercambiables:
//   1. "geopagos": la de arriba (plugin WooCommerce de Getnet AR). Sólo
//      producción.
//   2. "global": Web Checkout API del portal docs.globalgetnet.com (AR con
//      ARS, crédito, débito, Click to Pay y QR interoperable). VERIFICADO en
//      el OpenAPI publicado (Web Checkout API v1.6.0):
//        * Token: POST {host}/authentication/oauth2/access_token,
//          x-www-form-urlencoded grant_type=client_credentials, client_id,
//          client_secret → { access_token, scope, token_type, expires_in }.
//          Error: 400 { error:'invalid_client', error_description }.
//        * Hosts: producción api.globalgetnet.com · homologación
//          api.pre.globalgetnet.com · sandbox api-sbx.globalgetnet.com.
//        * POST {host}/dpy/web-checkout/v1/payment-intent → 201
//          { payment_intent_id, redirect_url, trade_name } (checkout hosted).
//        * GET  {host}/dpy/web-checkout/v1/payment-intent/{id} → status
//          pending|paid|registered|denied|error|expired|cancelled, payment
//          { amount, result.status } y records[] (cada intento).
//        * Webhook: URL única por comercio, configurada en el Portal (no por
//          orden), con Basic auth. Trae payment_intent_id.
//   Un mismo Client ID rechazado por Geopagos puede andar en Web Checkout (y
//   al revés): por eso "Probar credenciales" prueba los perfiles en orden y
//   se guarda el que funcionó (secrets.api_profile + secrets.environment).
// =============================================================================

export const GETNET_AUTH_URL = "https://auth.geopagos.com/oauth/token";
export const GETNET_ORDERS_URL = "https://api.globalgetnet.com.ar/api/v2/orders";
export const GETNET_CURRENCY = "032"; // ISO 4217 numérico de ARS.
export const GETNET_EXPIRE_MINUTES = 30;
const DEFAULT_TITLE = "Venta NinjaPos";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

// Ids de orden de Getnet (uuid u otro token alfanumérico): nada que pueda
// alterar el path del GET.
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function toCents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

export function buildTokenRequest(clientId: string, clientSecret: string) {
  return {
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    grant_type: "client_credentials",
    scope: "*",
  };
}

export async function fetchGetnetToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const r = await fetchImpl(GETNET_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildTokenRequest(clientId, clientSecret)),
    });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => null)) as { access_token?: unknown } | null;
    return str(j?.access_token);
  } catch {
    return null;
  }
}

export type OrderPayloadInput = {
  amount: number;
  title?: string;
  webhookUrl: string;
  successUrl: string;
  failedUrl: string;
  expireMinutes?: number;
};

// Un único ítem por el total: el monto lo fija el servidor (nunca el cliente)
// y es el mismo que se verifica al acreditar.
export function buildOrderPayload(i: OrderPayloadInput) {
  if (!Number.isFinite(i.amount) || i.amount <= 0) throw new Error("invalid_amount");
  const name = (i.title ?? "").trim().slice(0, 120) || DEFAULT_TITLE;
  return {
    data: {
      attributes: {
        items: [
          {
            id: 1,
            name,
            unitPrice: { currency: GETNET_CURRENCY, amount: String(toCents(i.amount)) },
            quantity: 1,
          },
        ],
        redirect_urls: { success: i.successUrl, failed: i.failedUrl },
        webhookUrl: i.webhookUrl,
        expireLimitMinutes: i.expireMinutes ?? GETNET_EXPIRE_MINUTES,
      },
    },
  };
}

export type CreatedOrder = {
  orderId: string;
  checkoutUrl: string;
  referenceNumber: string | null;
};

export function parseCreateResponse(json: unknown): CreatedOrder | null {
  if (!isObj(json) || !isObj(json.data)) return null;
  const data = json.data;
  const attrs = isObj(data.attributes) ? data.attributes : {};
  const links = Array.isArray(data.links) ? data.links : [];
  const first = links[0];
  const checkout = isObj(first) ? str(first.checkout) : null;
  if (!checkout || !/^https:\/\//i.test(checkout)) return null;
  const orderId = str(data.id) ?? str(attrs.uuid) ?? str(data.uuid);
  if (!orderId || !ORDER_ID_RE.test(orderId)) return null;
  const payments = Array.isArray(attrs.payments) ? attrs.payments : [];
  const p0 = payments[0];
  const referenceNumber = isObj(p0) ? str(p0.reference_number) : null;
  return { orderId, checkoutUrl: checkout, referenceNumber };
}

// El cuerpo del webhook es sólo una PISTA (qué orden re-consultar).
export function extractWebhookOrderId(body: unknown): string | null {
  if (!isObj(body) || !isObj(body.data) || !isObj(body.data.order)) return null;
  const id = str(body.data.order.uuid);
  return id && ORDER_ID_RE.test(id) ? id : null;
}

export function readOrderStatus(order: unknown): string {
  if (!isObj(order)) return "";
  const data = isObj(order.data) ? order.data : null;
  const attrs = data && isObj(data.attributes) ? data.attributes : null;
  return (str(order.status) ?? str(attrs?.status) ?? str(data?.status) ?? "").toUpperCase();
}

export type IntentStatus = "approved" | "rejected" | "cancelled" | "pending";

const APPROVED = new Set(["APPROVED", "PROCESSED", "SUCCESS"]);
const REJECTED = new Set(["REJECTED", "DECLINED", "DENIED", "FAILED"]);
const CANCELLED = new Set(["EXPIRED", "CANCELLED", "CANCELED"]);

export function mapGetnetStatus(status: string): IntentStatus {
  const s = String(status ?? "").trim().toUpperCase();
  if (APPROVED.has(s)) return "approved";
  if (REJECTED.has(s)) return "rejected";
  if (CANCELLED.has(s)) return "cancelled";
  return "pending";
}

// Monto → centavos. Entero (número o string sin punto) = centavos, como el
// request; con decimales = pesos.
function centsOf(v: unknown): number | null {
  if (isObj(v)) return centsOf(v.amount);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) ? v : toCents(v);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (/^\d+\.\d{1,2}$/.test(t)) return toCents(Number(t));
  }
  return null;
}

function sumItems(items: unknown): number | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const it of items) {
    if (!isObj(it)) return null;
    const unit = centsOf(it.unitPrice);
    if (unit === null) return null;
    const q = it.quantity == null ? 1 : Number(it.quantity);
    if (!Number.isInteger(q) || q <= 0) return null;
    total += unit * q;
  }
  return total;
}

export function extractOrderAmountCents(order: unknown): number | null {
  if (!isObj(order)) return null;
  const data = isObj(order.data) ? order.data : null;
  const attrs = data && isObj(data.attributes) ? data.attributes : null;
  const layers = [attrs, data, order].filter(isObj);
  for (const l of layers) {
    const s = sumItems(l.items);
    if (s !== null) return s;
  }
  for (const l of layers) {
    for (const k of ["amount", "total", "total_amount", "totalAmount"]) {
      const c = centsOf(l[k]);
      if (c !== null) return c;
    }
  }
  return null;
}

export type Decision = {
  status: IntentStatus;
  state: string;
  reason?: "amount_mismatch" | "amount_unverified";
};

// Decide el estado del intent a partir de la orden RE-CONSULTADA a Getnet.
// Aprobado sólo con monto exacto (centavos); sin monto legible no se acredita.
export function decideIntentUpdate(order: unknown, expectedAmount: number): Decision {
  const state = readOrderStatus(order);
  const mapped = mapGetnetStatus(state);
  if (mapped !== "approved") return { status: mapped, state };
  const cents = extractOrderAmountCents(order);
  if (cents === null) return { status: "pending", state, reason: "amount_unverified" };
  if (cents !== toCents(expectedAmount)) {
    return { status: "rejected", state, reason: "amount_mismatch" };
  }
  return { status: "approved", state };
}

export type OrderFetch =
  | { ok: true; order: unknown }
  | { ok: false; httpStatus: number; detail: string };

export async function fetchGetnetOrder(
  token: string,
  orderId: string,
  fetchImpl: FetchLike = fetch,
): Promise<OrderFetch> {
  if (!ORDER_ID_RE.test(orderId)) {
    return { ok: false, httpStatus: 400, detail: "invalid_order_id" };
  }
  try {
    const r = await fetchImpl(`${GETNET_ORDERS_URL}/${orderId}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      return { ok: false, httpStatus: r.status, detail: (await r.text()).slice(0, 300) };
    }
    const order = await r.json().catch(() => null);
    if (order === null) return { ok: false, httpStatus: 502, detail: "invalid_json" };
    return { ok: true, order };
  } catch (e) {
    return { ok: false, httpStatus: 502, detail: String(e).slice(0, 300) };
  }
}

// =============================================================================
// Perfiles de API (tipo de API + ambiente) · ADR-065
// =============================================================================

export type GetnetApi = "geopagos" | "global";
export type GetnetEnv = "prod" | "test";
export type GetnetProfileKey = "geopagos" | "global_prod" | "global_pre" | "global_sbx";

export type GetnetProfile = {
  key: GetnetProfileKey;
  api: GetnetApi;
  env: GetnetEnv;
  label: string;
  tokenUrl: string;
  /** Base de las órdenes: /orders (Geopagos) o el prefijo de Web Checkout. */
  apiBase: string;
};

const GLOBAL_TOKEN_PATH = "/authentication/oauth2/access_token";
const GLOBAL_CHECKOUT_PATH = "/dpy/web-checkout/v1";

export const GETNET_PROFILES: Record<GetnetProfileKey, GetnetProfile> = {
  geopagos: {
    key: "geopagos",
    api: "geopagos",
    env: "prod",
    label: "API Getnet Argentina (Geopagos) · producción",
    tokenUrl: GETNET_AUTH_URL,
    apiBase: GETNET_ORDERS_URL,
  },
  global_prod: {
    key: "global_prod",
    api: "global",
    env: "prod",
    label: "Web Checkout Getnet · producción",
    tokenUrl: `https://api.globalgetnet.com${GLOBAL_TOKEN_PATH}`,
    apiBase: `https://api.globalgetnet.com${GLOBAL_CHECKOUT_PATH}`,
  },
  global_sbx: {
    key: "global_sbx",
    api: "global",
    env: "test",
    label: "Web Checkout Getnet · sandbox",
    tokenUrl: `https://api-sbx.globalgetnet.com${GLOBAL_TOKEN_PATH}`,
    apiBase: `https://api-sbx.globalgetnet.com${GLOBAL_CHECKOUT_PATH}`,
  },
  global_pre: {
    key: "global_pre",
    api: "global",
    env: "test",
    label: "Web Checkout Getnet · homologación",
    tokenUrl: `https://api.pre.globalgetnet.com${GLOBAL_TOKEN_PATH}`,
    apiBase: `https://api.pre.globalgetnet.com${GLOBAL_CHECKOUT_PATH}`,
  },
};

/** Orden de prueba por ambiente (el primero que da token gana). */
export const GETNET_PROFILE_ORDER: Record<GetnetEnv, GetnetProfileKey[]> = {
  prod: ["geopagos", "global_prod"],
  test: ["global_sbx", "global_pre"],
};

export const isGetnetProfileKey = (v: unknown): v is GetnetProfileKey =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(GETNET_PROFILES, v);

/** Valida host por ambiente: un perfil de prueba nunca cobra en producción. */
export function profileMatchesEnv(key: unknown, env: GetnetEnv): key is GetnetProfileKey {
  return isGetnetProfileKey(key) && GETNET_PROFILES[key].env === env;
}

/** Ambiente explícito de la credencial; si no lo tiene, el switch Sandbox del medio. */
export function getnetEnvOf(secrets: Record<string, unknown> | null | undefined, sandboxFlag = false): GetnetEnv {
  const e = secrets?.environment;
  if (e === "test" || e === "prod") return e;
  return sandboxFlag ? "test" : "prod";
}

// ── Token por perfil ──────────────────────────────────────────────────────────

export function buildProfileTokenRequest(
  profile: GetnetProfile,
  clientId: string,
  clientSecret: string,
): { url: string; init: RequestInit } {
  if (profile.api === "geopagos") {
    return {
      url: profile.tokenUrl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildTokenRequest(clientId, clientSecret)),
      },
    };
  }
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
  });
  return {
    url: profile.tokenUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    },
  };
}

// ── Diagnóstico (sin secretos) ────────────────────────────────────────────────

export type GetnetDiagKind =
  | "invalid_credentials"
  | "forbidden"
  | "endpoint_not_found"
  | "provider_down"
  | "network"
  | "unexpected";

export type GetnetStep = "token" | "seller" | "create" | "status";

export type GetnetDiag = {
  profile: GetnetProfileKey;
  api: GetnetApi;
  env: GetnetEnv;
  label: string;
  step: GetnetStep;
  /** host + path, sin query ni credenciales. */
  endpoint: string;
  http_status: number;
  code: string | null;
  message: string | null;
  kind: GetnetDiagKind;
};

/** Saca de un texto cualquier aparición de los secretos y lo recorta. */
export function scrubSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    const v = (s ?? "").trim();
    if (v.length >= 4) out = out.split(v).join("***");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Código y mensaje del proveedor. Formas conocidas: OAuth {error,
 * error_description} · Web Checkout {code, message} o {statusCode, message} ·
 * Payment Link {error_code, message} · JSON:API {errors:[{code|title, detail}]}.
 */
export function parseProviderError(text: string): { code: string | null; message: string | null } {
  let j: unknown = null;
  try {
    j = JSON.parse(text);
  } catch {
    const t = (text ?? "").trim();
    return { code: null, message: t ? t.slice(0, 200) : null };
  }
  if (!isObj(j)) return { code: null, message: null };
  const errs = Array.isArray(j.errors) ? j.errors : [];
  const e0 = isObj(errs[0]) ? errs[0] : null;
  const code = str(j.error) ?? str(j.code) ?? str(j.error_code) ??
    (e0 ? (str(e0.code) ?? str(e0.title)) : null) ?? str(j.statusCode);
  const message = str(j.error_description) ?? str(j.message) ?? str(j.detail) ??
    (e0 ? (str(e0.detail) ?? str(e0.title)) : null);
  return { code, message };
}

const CRED_CODES = new Set([
  "invalid_client",
  "authentication_failed",
  "invalid_grant",
  "unauthorized",
  "unauthorized_client",
  "access_denied",
]);

export function classifyFailure(status: number, code: string | null, step: GetnetStep = "token"): GetnetDiagKind {
  if (status === 0) return "network";
  if (status >= 500) return "provider_down";
  if (status === 404) return step === "token" ? "endpoint_not_found" : "unexpected";
  if (status === 401) return "invalid_credentials";
  if (step === "token" && status === 400 && (!code || CRED_CODES.has(code))) return "invalid_credentials";
  if (code && CRED_CODES.has(code)) return "invalid_credentials";
  if (status === 403) return "forbidden";
  return "unexpected";
}

const KIND_COPY: Record<GetnetDiagKind, string> = {
  invalid_credentials: "rechazó el Client ID / Client Secret",
  forbidden: "aceptó las credenciales pero el producto no está habilitado para tu comercio",
  endpoint_not_found: "no encontró el servicio",
  provider_down: "no está respondiendo bien",
  network: "no respondió (sin conexión o tiempo agotado)",
  unexpected: "respondió algo inesperado",
};

function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? "";
  }
}

export function makeDiag(
  profile: GetnetProfile,
  step: GetnetStep,
  url: string,
  httpStatus: number,
  body: string,
  secrets: (string | null | undefined)[] = [],
): GetnetDiag {
  const { code, message } = parseProviderError(body);
  return {
    profile: profile.key,
    api: profile.api,
    env: profile.env,
    label: profile.label,
    step,
    endpoint: endpointOf(url),
    http_status: httpStatus,
    code: code ? scrubSecrets(code, secrets).slice(0, 60) : null,
    message: message ? scrubSecrets(message, secrets) : null,
    kind: classifyFailure(httpStatus, code, step),
  };
}

/** Una línea legible para el dueño y para los logs. */
export function describeDiag(d: GetnetDiag): string {
  const http = d.http_status ? `HTTP ${d.http_status}` : "sin respuesta";
  const prov = [d.code, d.message].filter(Boolean).join(": ");
  return `${d.label} ${KIND_COPY[d.kind]} (${http}${prov ? ` · ${prov}` : ""} · ${d.endpoint})`;
}

/** Log estructurado para Supabase (sin secretos). */
export function logGetnetError(fn: string, d: GetnetDiag, extra: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({
      fn,
      step: d.step,
      profile: d.profile,
      env: d.env,
      endpoint: d.endpoint,
      status: d.http_status,
      provider_code: d.code,
      provider_message: d.message,
      kind: d.kind,
      ...extra,
    }),
  );
}

export type TokenResult =
  | { ok: true; profile: GetnetProfile; token: string }
  | { ok: false; diag: GetnetDiag };

export async function requestGetnetToken(
  profile: GetnetProfile,
  clientId: string,
  clientSecret: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenResult> {
  const { url, init } = buildProfileTokenRequest(profile, clientId, clientSecret);
  const secrets = [clientId, clientSecret];
  let r: Response;
  try {
    r = await fetchImpl(url, init);
  } catch (e) {
    const d = makeDiag(profile, "token", url, 0, "", secrets);
    d.message = scrubSecrets(String(e), secrets);
    return { ok: false, diag: d };
  }
  const text = await r.text().catch(() => "");
  if (!r.ok) return { ok: false, diag: makeDiag(profile, "token", url, r.status, text, secrets) };
  let token: string | null = null;
  try {
    token = str((JSON.parse(text) as { access_token?: unknown } | null)?.access_token);
  } catch {
    token = null;
  }
  if (!token) {
    const d = makeDiag(profile, "token", url, r.status, "", secrets);
    d.kind = "unexpected";
    d.message = "La respuesta no trae access_token";
    return { ok: false, diag: d };
  }
  return { ok: true, profile, token };
}

export type DetectResult =
  | { ok: true; profile: GetnetProfile; token: string; attempts: GetnetDiag[] }
  | { ok: false; attempts: GetnetDiag[]; mismatch: GetnetProfileKey | null };

/**
 * Prueba los perfiles del ambiente elegido (el guardado primero) y devuelve el
 * primero que da token. Con crossEnv, si ninguno anda prueba los del OTRO
 * ambiente sólo para avisar el error de ambiente (nunca cobra con ellos).
 */
export async function detectGetnetProfile(
  clientId: string,
  clientSecret: string,
  opts: { env: GetnetEnv; preferred?: unknown; crossEnv?: boolean },
  fetchImpl: FetchLike = fetch,
): Promise<DetectResult> {
  const order = [...GETNET_PROFILE_ORDER[opts.env]];
  const preferred = opts.preferred;
  if (profileMatchesEnv(preferred, opts.env)) {
    order.splice(order.indexOf(preferred), 1);
    order.unshift(preferred);
  }
  const attempts: GetnetDiag[] = [];
  for (const key of order) {
    const r = await requestGetnetToken(GETNET_PROFILES[key], clientId, clientSecret, fetchImpl);
    if (r.ok) return { ok: true, profile: r.profile, token: r.token, attempts };
    attempts.push(r.diag);
  }
  if (opts.crossEnv) {
    const other: GetnetEnv = opts.env === "prod" ? "test" : "prod";
    for (const key of GETNET_PROFILE_ORDER[other]) {
      const r = await requestGetnetToken(GETNET_PROFILES[key], clientId, clientSecret, fetchImpl);
      if (r.ok) return { ok: false, attempts, mismatch: key };
      attempts.push(r.diag);
    }
  }
  return { ok: false, attempts, mismatch: null };
}

/** Resumen para el dueño cuando ningún perfil dio token. */
export function describeDetectFailure(r: { attempts: GetnetDiag[]; mismatch: GetnetProfileKey | null }): string {
  if (r.mismatch) {
    const p = GETNET_PROFILES[r.mismatch];
    return p.env === "test"
      ? `Las credenciales son de prueba (${p.label}). Elegí el ambiente Prueba o pedile a Getnet las de producción.`
      : `Las credenciales son de producción (${p.label}). Elegí el ambiente Producción.`;
  }
  if (r.attempts.length === 0) return "No se probó ningún servicio de Getnet.";
  if (r.attempts.every((a) => a.kind === "invalid_credentials")) {
    return "Getnet rechazó el Client ID / Client Secret en todas sus APIs de cobro online. Revisá que estén completos y que sean de la API de cobros online (no del portal de comercios ni de la terminal).";
  }
  return r.attempts.map(describeDiag).join(" | ");
}

// =============================================================================
// Web Checkout (API global) · payment intent
// =============================================================================

export const GLOBAL_PLACEHOLDER_EMAIL = "consumidor.final@pos.soft.ninja";

export type GlobalCustomer = {
  customer_id: string;
  first_name: string;
  last_name: string;
  name: string;
  email: string;
  document_type: string;
  document_number: string;
  billing_address: { street: string; number: string; city?: string; country: string; postal_code: string };
};

/**
 * Comprador del payment intent. Web Checkout exige customer (id, nombre,
 * email, documento y domicilio) aunque en el mostrador el cliente no se
 * identifique: va "Consumidor Final" con los datos opcionales del comercio
 * (secrets.customer_*). INFERIDO: que Getnet acepte estos valores genéricos.
 */
export function globalCustomerFromSecrets(sec: Record<string, unknown>, ref: string): GlobalCustomer {
  const s = (k: string) => (typeof sec[k] === "string" ? (sec[k] as string).trim() : "");
  const rawEmail = s("customer_email");
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail) ? rawEmail : GLOBAL_PLACEHOLDER_EMAIL;
  const doc = s("customer_document").replace(/\D/g, "");
  const docOk = doc.length >= 8 && doc.length <= 15;
  const addr = s("customer_address");
  const m = addr.match(/^(.*?)[\s,]+(\d{1,6})\s*$/);
  const postal = s("customer_postal_code").slice(0, 11);
  const city = s("customer_city").slice(0, 40);
  return {
    customer_id: ref.slice(0, 100),
    first_name: "Consumidor",
    last_name: "Final",
    name: "Consumidor Final",
    email,
    document_type: docOk && doc.length === 11 ? "CUIT" : "DNI",
    document_number: docOk ? doc : "99999999",
    billing_address: {
      street: (m ? m[1]! : addr).slice(0, 60) || "Sin calle",
      number: m ? m[2]! : "0",
      ...(city ? { city } : {}),
      country: "AR",
      postal_code: postal || "1000",
    },
  };
}

export type PaymentIntentInput = {
  amount: number;
  title?: string;
  orderId: string;
  successUrl: string;
  errorUrl: string;
  customer: GlobalCustomer;
  expiresMinutes?: number;
};

export function buildPaymentIntentPayload(i: PaymentIntentInput) {
  if (!Number.isFinite(i.amount) || i.amount <= 0) throw new Error("invalid_amount");
  const title = (i.title ?? "").trim().slice(0, 128) || DEFAULT_TITLE;
  const cents = toCents(i.amount);
  const minutes = Math.max(15, i.expiresMinutes ?? GETNET_EXPIRE_MINUTES);
  return {
    order_id: i.orderId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36),
    payment: { currency: "ARS", amount: cents },
    product: [{ product_type: "physical_goods", title, value: cents, quantity: 1 }],
    customer: i.customer,
    configurations: { success_url: i.successUrl, error_url: i.errorUrl },
    expires_at: `${minutes}m`,
  };
}

export function parsePaymentIntentResponse(json: unknown): CreatedOrder | null {
  if (!isObj(json)) return null;
  const id = str(json.payment_intent_id);
  const redirect = str(json.redirect_url);
  if (!id || !ORDER_ID_RE.test(id)) return null;
  if (!redirect || !/^https:\/\//i.test(redirect)) return null;
  return { orderId: id, checkoutUrl: redirect, referenceNumber: null };
}

/** payment_intent_id del webhook de Web Checkout (sólo una pista). */
export function extractWebhookIntentId(body: unknown): string | null {
  if (!isObj(body)) return null;
  const data = isObj(body.data) ? body.data : null;
  const id = str(body.payment_intent_id) ?? (data ? str(data.payment_intent_id) : null);
  return id && ORDER_ID_RE.test(id) ? id : null;
}

const RECORD_OK = new Set(["AUTHORIZED", "APPROVED", "CAPTURED", "PAID"]);

export type GlobalDecision = Decision & { paymentId: string | null };

/**
 * Estado del intent desde GET /payment-intent/{id}. paid = aprobado sólo si el
 * monto cobrado cubre el esperado (las cuotas con interés pueden sumar);
 * denied/error = rechazado; expired/cancelled = cancelado.
 */
export function decidePaymentIntent(details: unknown, expectedAmount: number): GlobalDecision {
  if (!isObj(details)) return { status: "pending", state: "", paymentId: null };
  const state = (str(details.status) ?? "").toLowerCase();
  const records = Array.isArray(details.records) ? details.records.filter(isObj) : [];
  let paymentId: string | null = null;
  let recordAmount: number | null = null;
  for (const rec of records) {
    const p = isObj(rec.payment) ? rec.payment : null;
    const res = p && isObj(p.result) ? p.result : null;
    if (p && res && RECORD_OK.has((str(res.status) ?? "").toUpperCase())) {
      paymentId = str(res.payment_id) ?? paymentId;
      recordAmount = centsOf(p.amount) ?? recordAmount;
    }
  }
  if (state === "paid") {
    const pay = isObj(details.payment) ? details.payment : null;
    const cents = (pay ? centsOf(pay.amount) : null) ?? recordAmount;
    if (cents === null) return { status: "pending", state, reason: "amount_unverified", paymentId };
    if (cents < toCents(expectedAmount)) return { status: "rejected", state, reason: "amount_mismatch", paymentId };
    return { status: "approved", state, paymentId };
  }
  if (state === "denied" || state === "error") return { status: "rejected", state, paymentId: null };
  if (state === "expired" || state === "cancelled" || state === "canceled") {
    return { status: "cancelled", state, paymentId: null };
  }
  return { status: "pending", state, paymentId: null };
}

// =============================================================================
// Operaciones por perfil (Edge getnet, getnet_webhook y payment_provider_data)
// =============================================================================

export type CreateResult = { ok: true; created: CreatedOrder } | { ok: false; diag: GetnetDiag };

export async function createGetnetCheckout(
  profile: GetnetProfile,
  token: string,
  input: {
    amount: number;
    title?: string;
    intentId: string;
    webhookUrl: string;
    successUrl: string;
    failedUrl: string;
    secrets: Record<string, unknown>;
  },
  fetchImpl: FetchLike = fetch,
): Promise<CreateResult> {
  const isGlobal = profile.api === "global";
  const url = isGlobal ? `${profile.apiBase}/payment-intent` : profile.apiBase;
  const body = isGlobal
    ? buildPaymentIntentPayload({
      amount: input.amount,
      title: input.title,
      orderId: input.intentId,
      successUrl: input.successUrl,
      errorUrl: input.failedUrl,
      customer: globalCustomerFromSecrets(input.secrets, input.intentId),
    })
    : buildOrderPayload({
      amount: input.amount,
      title: input.title,
      webhookUrl: input.webhookUrl,
      successUrl: input.successUrl,
      failedUrl: input.failedUrl,
    });
  const ct = isGlobal ? "application/json" : "application/vnd.api+json";
  let r: Response;
  try {
    r = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": ct, Accept: ct, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const d = makeDiag(profile, "create", url, 0, "");
    d.message = String(e).slice(0, 200);
    return { ok: false, diag: d };
  }
  const text = await r.text().catch(() => "");
  if (r.ok) {
    let created: CreatedOrder | null = null;
    try {
      const j = JSON.parse(text);
      created = isGlobal ? parsePaymentIntentResponse(j) : parseCreateResponse(j);
    } catch {
      created = null;
    }
    if (created) return { ok: true, created };
    const d = makeDiag(profile, "create", url, r.status, "");
    d.kind = "unexpected";
    d.message = "La respuesta no trae el link del checkout";
    return { ok: false, diag: d };
  }
  return { ok: false, diag: makeDiag(profile, "create", url, r.status, text) };
}

export async function fetchGetnetOrderFor(
  profile: GetnetProfile,
  token: string,
  orderId: string,
  fetchImpl: FetchLike = fetch,
): Promise<OrderFetch> {
  if (profile.api === "geopagos") return fetchGetnetOrder(token, orderId, fetchImpl);
  if (!ORDER_ID_RE.test(orderId)) return { ok: false, httpStatus: 400, detail: "invalid_order_id" };
  try {
    const r = await fetchImpl(`${profile.apiBase}/payment-intent/${orderId}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { ok: false, httpStatus: r.status, detail: (await r.text()).slice(0, 300) };
    const order = await r.json().catch(() => null);
    if (order === null) return { ok: false, httpStatus: 502, detail: "invalid_json" };
    return { ok: true, order };
  } catch (e) {
    return { ok: false, httpStatus: 502, detail: String(e).slice(0, 300) };
  }
}

/** Decisión común: Geopagos (orden v2) o Web Checkout (payment intent). */
export function decideFor(profile: GetnetProfile, order: unknown, expectedAmount: number): GlobalDecision {
  if (profile.api === "global") return decidePaymentIntent(order, expectedAmount);
  return { ...decideIntentUpdate(order, expectedAmount), paymentId: null };
}

export type SellerInfo = { trade_name: string | null; country: string | null; checkout_enabled: boolean | null };

/** GET /sellers (sólo Web Checkout): confirma que el producto esté activo. */
export async function fetchGetnetSeller(
  profile: GetnetProfile,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; seller: SellerInfo } | { ok: false; diag: GetnetDiag }> {
  const url = `${profile.apiBase}/sellers`;
  try {
    const r = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) return { ok: false, diag: makeDiag(profile, "seller", url, r.status, text) };
    let j: unknown = null;
    try {
      j = JSON.parse(text);
    } catch {
      j = null;
    }
    const o = isObj(j) ? j : {};
    const checkout = isObj(o.checkout) ? o.checkout : null;
    return {
      ok: true,
      seller: {
        trade_name: str(o.trade_name),
        country: str(o.country),
        checkout_enabled: checkout && typeof checkout.enabled === "boolean" ? checkout.enabled : null,
      },
    };
  } catch (e) {
    const d = makeDiag(profile, "seller", url, 0, "");
    d.message = String(e).slice(0, 200);
    return { ok: false, diag: d };
  }
}

export type ResolvedAuth =
  | { ok: true; profile: GetnetProfile; token: string; detected: boolean; env: GetnetEnv }
  | { ok: false; env: GetnetEnv; attempts: GetnetDiag[]; mismatch: GetnetProfileKey | null };

/**
 * Credencial guardada → token. Usa el perfil guardado si es del ambiente; si
 * no hay o falla, detecta. `detected` = hay que persistir el perfil nuevo.
 */
export async function resolveGetnetAuth(
  sec: Record<string, unknown>,
  sandboxFlag: boolean,
  fetchImpl: FetchLike = fetch,
): Promise<ResolvedAuth> {
  const env = getnetEnvOf(sec, sandboxFlag);
  const id = String(sec.client_id ?? "");
  const secret = String(sec.client_secret ?? "");
  const r = await detectGetnetProfile(id, secret, { env, preferred: sec.api_profile, crossEnv: true }, fetchImpl);
  if (!r.ok) return { ok: false, env, attempts: r.attempts, mismatch: r.mismatch };
  return { ok: true, profile: r.profile, token: r.token, env, detected: r.profile.key !== sec.api_profile };
}
