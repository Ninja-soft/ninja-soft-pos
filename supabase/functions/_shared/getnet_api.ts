// =============================================================================
// Getnet Checkout API (Global API, "Single Entry Point") · lógica pura del
// checkout propio /pagar con Getnet (ADR-069). Sin imports: corre igual en
// Deno (Edges `getnet` y `getnet_checkout`) y en Node (Vitest,
// tests/unit/getnetCheckoutApi.test.ts).
//
// Getnet entrega dos juegos de credenciales que NO son intercambiables:
//   * "Web Checkout / Plugin Magento / Plugin WooCommerce": checkout hosted
//     (QR y link). Token con client_id y client_secret en el cuerpo del form.
//     Lo resuelve _shared/getnet.ts (ADR-065).
//   * "Checkout API / Plugin VTEX": esta API. Cobro directo con tarjeta, sin
//     página de Getnet. VERIFICADO en el OpenAPI "Global API GetNet" v1.0.4
//     publicado en docs.globalgetnet.com (regional-api/swagger, 2026-10):
//       - Token: POST {host}/authentication/oauth2/access_token,
//         Authorization: Basic base64(client_id:client_secret),
//         x-www-form-urlencoded grant_type=client_credentials →
//         { access_token (JWT), scope 'digital-platform:gateway-api',
//           token_type, expires_in 3599 }. Error 401 { error:'invalid_client' }.
//         El JWT trae sellerId y country (claims, sin verificar acá).
//       - Hosts: producción api.globalgetnet.com · homologación
//         api.pre.globalgetnet.com · sandbox api-sbx.globalgetnet.com.
//       - Tokenizar: POST /dpm/cofre-gw-proxy/v1/tokens/card
//         { card_number, customer_id } → { number_token } (Bearer, server a
//         server: NO hay tokenización desde el navegador ni CORS; el preflight
//         desde un origen web responde 403/404 sin Access-Control-Allow-Origin).
//       - Cuotas AR: POST /dpm/payments-gwproxy/v2/payments/quotes
//         { amount, bin (9 dígitos), number_token, installment_type_filter }
//         → { options:[{ quote_id, schema, type, number, installment_amount,
//         total_amount }] }. "Sólo Argentina y Chile"; el quote_id es
//         OBLIGATORIO en AR para cobrar en cuotas.
//       - Cobro: POST /dpm/payments-gwproxy/v2/payments { idempotency_key,
//         request_id, order_id, data:{ amount (centavos), currency 'ARS',
//         customer_id, payment:{ payment_id?, payment_method CREDIT|DEBIT,
//         transaction_type FULL|INSTALL_NO_INTEREST|INSTALL_WITH_INTEREST,
//         number_installments, card:{ number_token, expiration_month,
//         expiration_year, cardholder_name, security_code, brand } },
//         additional_data:{ installment:{ quote_id, schema } } } }
//         → { payment_id, amount, status APPROVED|AUTHORIZED|CAPTURED|DENIED|
//         ERROR, reason_code, reason_message, authorization_code, brand }.
//         payment_id lo podemos mandar nosotros: así un corte de red se
//         re-consulta sin duplicar.
//       - Estado: GET /dpm/hub-payment-info/v1/payments/info/{payment_id}
//         → { status AUTHORIZED|APPROVED|CAPTURED|CANCELED|REFUNDED|DENIED|
//         ERROR|PENDING|…, payment, records[] }.
//       - Anular / devolver en AR: legacy Web Checkout
//         POST /digital-checkout/v1/payments/{payment_id}/cancellation | /refund.
// INFERIDO (validar con el primer cobro real):
//   * Que el comercio tenga habilitados tokenización ("cofre") y cuotas.
//   * Que nuestro recargo por cuotas vaya como INSTALL_NO_INTEREST (cuotas del
//     comercio) con un quote de tipo no_interest.
//   * Forma del monto en el GET de estado (se lee payment.amount o amount).
// =============================================================================

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

export type ApiEnv = "prod" | "test";

export const API_HOSTS: Record<ApiEnv, string[]> = {
  prod: ["https://api.globalgetnet.com"],
  test: ["https://api-sbx.globalgetnet.com", "https://api.pre.globalgetnet.com"],
};

export const API_TOKEN_PATH = "/authentication/oauth2/access_token";
export const API_TOKENIZE_PATH = "/dpm/cofre-gw-proxy/v1/tokens/card";
export const API_QUOTES_PATH = "/dpm/payments-gwproxy/v2/payments/quotes";
export const API_PAYMENTS_PATH = "/dpm/payments-gwproxy/v2/payments";
export const API_INFO_PATH = "/dpm/hub-payment-info/v1/payments/info";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const toCents = (amount: number): number => Math.round(Number(amount) * 100);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Total con el recargo del plan. Mismo redondeo que el checkout de Payway. */
export function finalAmountWithSurcharge(base: number, surchargePct: number): number {
  const pct = Number(surchargePct) || 0;
  return round2(Number(base) * (1 + pct / 100));
}

// ── Credencial del slot "Checkout API" ───────────────────────────────────────

/** Claves del slot Checkout API dentro del secreto de Getnet (ADR-069). */
export const API_SLOT_KEYS = [
  "api_client_id",
  "api_client_secret",
  "api_environment",
  "api_channel_entry",
  "api_seller_id",
] as const;

export type ApiCreds = {
  clientId: string;
  clientSecret: string;
  env: ApiEnv;
  /** x-transaction-channel-entry: código que asigna Getnet a la plataforma. */
  channelEntry: string | null;
  /** x-seller-id cargado a mano (si no, sale del JWT). */
  sellerId: string | null;
};

export function apiCredsOf(sec: Record<string, unknown> | null | undefined): ApiCreds | null {
  const s = sec ?? {};
  const id = typeof s.api_client_id === "string" ? s.api_client_id.trim() : "";
  const secret = typeof s.api_client_secret === "string" ? s.api_client_secret.trim() : "";
  if (!id || !secret) return null;
  const env: ApiEnv = s.api_environment === "test" ? "test" : "prod";
  const ch = typeof s.api_channel_entry === "string" ? s.api_channel_entry.trim() : "";
  const seller = typeof s.api_seller_id === "string" ? s.api_seller_id.trim() : "";
  return {
    clientId: id,
    clientSecret: secret,
    env,
    channelEntry: ch ? ch.slice(0, 40) : null,
    sellerId: UUID_RE.test(seller) ? seller : null,
  };
}

/** ¿Hay credencial de Web Checkout (slot QR + link)? */
export function hasWebCheckoutCreds(sec: Record<string, unknown> | null | undefined): boolean {
  const s = sec ?? {};
  return typeof s.client_id === "string" && !!s.client_id.trim() &&
    typeof s.client_secret === "string" && !!s.client_secret.trim();
}

// ── Token ────────────────────────────────────────────────────────────────────

function base64(text: string): string {
  // btoa existe en Deno y en Node >= 16; sólo ASCII (client_id/secret lo son).
  return btoa(text);
}

export function buildApiTokenRequest(host: string, clientId: string, clientSecret: string): { url: string; init: RequestInit } {
  return {
    url: `${host}${API_TOKEN_PATH}`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64(`${clientId.trim()}:${clientSecret.trim()}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    },
  };
}

export type JwtClaims = { sellerId: string | null; country: string | null; scope: string[] };

/** Lee (sin verificar) los claims del JWT de Getnet: sellerId, country, scope. */
export function decodeJwtClaims(token: string): JwtClaims {
  const empty: JwtClaims = { sellerId: null, country: null, scope: [] };
  const part = String(token ?? "").split(".")[1];
  if (!part) return empty;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const j = JSON.parse(atob(b64)) as Obj;
    const seller = str(j.sellerId) ?? str(j.seller_id);
    const scope = Array.isArray(j.scope)
      ? j.scope.filter((x): x is string => typeof x === "string")
      : typeof j.scope === "string"
        ? j.scope.split(/\s+/).filter(Boolean)
        : [];
    return {
      sellerId: seller && UUID_RE.test(seller) ? seller : null,
      country: str(j.country)?.toUpperCase().slice(0, 2) ?? null,
      scope,
    };
  } catch {
    return empty;
  }
}

export type ApiFailKind = "invalid_credentials" | "forbidden" | "endpoint_not_found" | "provider_down" | "network" | "unexpected";

export type ApiAttempt = {
  step: "token" | "product" | "tokenize" | "quotes" | "pay" | "status";
  endpoint: string;
  http_status: number;
  code: string | null;
  message: string | null;
  kind: ApiFailKind;
};

/** Saca de un texto cualquier aparición de los secretos y lo recorta. */
export function scrub(text: string, secrets: (string | null | undefined)[]): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    const v = (s ?? "").trim();
    if (v.length >= 4) out = out.split(v).join("***");
  }
  // Un PAN que se colara en un mensaje del proveedor (13 a 19 dígitos).
  out = out.replace(/\b\d{13,19}\b/g, "****");
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Código y mensaje del error de Getnet. Formas: OAuth {error,
 * error_description} · gateway {message, name, status_code, details:[{status,
 * error_code, description, description_detail}]} · {statusCode, message} ·
 * {code, message}.
 */
export function parseApiError(text: string): { code: string | null; message: string | null } {
  let j: unknown = null;
  try {
    j = JSON.parse(text);
  } catch {
    const t = String(text ?? "").trim();
    return { code: null, message: t ? t.slice(0, 200) : null };
  }
  if (!isObj(j)) return { code: null, message: null };
  const d0 = Array.isArray(j.details) && isObj(j.details[0]) ? (j.details[0] as Obj) : null;
  const code = str(j.error) ?? str(d0?.error_code) ?? str(j.code) ?? str(j.statusCode) ?? str(j.status_code);
  const message = str(j.error_description) ?? str(d0?.description_detail) ?? str(d0?.description) ?? str(j.message);
  return { code, message };
}

export function classifyApiFailure(status: number, code: string | null, step: ApiAttempt["step"]): ApiFailKind {
  if (status === 0) return "network";
  if (status >= 500) return "provider_down";
  if (status === 401) return "invalid_credentials";
  if (step === "token" && status === 400) return "invalid_credentials";
  if (code && /invalid_client|AUTHENTICATION-401/i.test(code)) return "invalid_credentials";
  if (status === 403) return "forbidden";
  if (status === 404) return step === "token" ? "endpoint_not_found" : "unexpected";
  return "unexpected";
}

function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url).split("?")[0] ?? "";
  }
}

export function makeAttempt(
  step: ApiAttempt["step"],
  url: string,
  httpStatus: number,
  body: string,
  secrets: (string | null | undefined)[] = [],
): ApiAttempt {
  const { code, message } = parseApiError(body);
  return {
    step,
    endpoint: endpointOf(url),
    http_status: httpStatus,
    code: code ? scrub(code, secrets).slice(0, 60) : null,
    message: message ? scrub(message, secrets) : null,
    kind: classifyApiFailure(httpStatus, code, step),
  };
}

export type ApiAuth = { ok: true; host: string; token: string; claims: JwtClaims } | { ok: false; attempts: ApiAttempt[] };

/** Token de la Checkout API: prueba los hosts del ambiente en orden. */
export async function requestApiToken(
  creds: Pick<ApiCreds, "clientId" | "clientSecret" | "env">,
  fetchImpl: FetchLike = fetch,
  envOverride?: ApiEnv,
): Promise<ApiAuth> {
  const env = envOverride ?? creds.env;
  const attempts: ApiAttempt[] = [];
  const secrets = [creds.clientId, creds.clientSecret];
  for (const host of API_HOSTS[env]) {
    const { url, init } = buildApiTokenRequest(host, creds.clientId, creds.clientSecret);
    let r: Response;
    try {
      r = await fetchImpl(url, init);
    } catch (e) {
      const a = makeAttempt("token", url, 0, "", secrets);
      a.message = scrub(String(e), secrets);
      attempts.push(a);
      continue;
    }
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      attempts.push(makeAttempt("token", url, r.status, text, secrets));
      continue;
    }
    let token: string | null = null;
    try {
      token = str((JSON.parse(text) as Obj | null)?.access_token);
    } catch {
      token = null;
    }
    if (!token) {
      const a = makeAttempt("token", url, r.status, "", secrets);
      a.kind = "unexpected";
      a.message = "La respuesta no trae access_token";
      attempts.push(a);
      continue;
    }
    return { ok: true, host, token, claims: decodeJwtClaims(token) };
  }
  return { ok: false, attempts };
}

export function apiHeaders(token: string, opts: { sellerId?: string | null; channelEntry?: string | null } = {}): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts.sellerId) h["x-seller-id"] = opts.sellerId;
  if (opts.channelEntry) h["x-transaction-channel-entry"] = opts.channelEntry;
  return h;
}

// ── Detección de slot ("¿qué credencial cargó el dueño?") ────────────────────

export type SlotKey = "web_checkout" | "checkout_api";

/**
 * Lectura de las pruebas contra las dos APIs. `webToken`/`webProduct`: token
 * y GET /sellers de Web Checkout; `apiToken`: token de la Checkout API (Basic).
 * Devuelve qué tipo parece la credencial y si está en el slot equivocado.
 */
export function classifyCredential(r: {
  slot: SlotKey;
  webToken: boolean;
  webProduct: boolean | null;
  apiToken: boolean;
}): { looksLike: SlotKey | "unknown" | "both"; mismatch: boolean } {
  const web = r.webToken && r.webProduct !== false;
  const api = r.apiToken;
  let looksLike: SlotKey | "unknown" | "both" = "unknown";
  if (web && api) looksLike = r.webProduct === true ? "web_checkout" : "both";
  else if (web) looksLike = "web_checkout";
  else if (api) looksLike = "checkout_api";
  const mismatch =
    (r.slot === "web_checkout" && looksLike === "checkout_api") ||
    (r.slot === "checkout_api" && looksLike === "web_checkout" && !api);
  return { looksLike, mismatch };
}

export const SLOT_MISMATCH_COPY: Record<SlotKey, string> = {
  web_checkout:
    "Estas credenciales parecen de Checkout API / Plugin VTEX: sirven para el checkout propio, no para QR ni link. Cargalas en \"Checkout API\" y acá usá las que dicen Web Checkout / Plugin Magento / Plugin WooCommerce.",
  checkout_api:
    "Estas credenciales parecen de Web Checkout / Plugin Magento / Plugin WooCommerce: sirven para QR y link. Cargalas en \"Web Checkout\" y acá usá las que dicen Checkout API / Plugin VTEX.",
};

// ── Tarjeta ──────────────────────────────────────────────────────────────────

/** Marca del checkout → marca de Getnet (card.brand). */
export const GETNET_API_BRANDS: { key: string; brand: string; debit: boolean }[] = [
  { key: "visa", brand: "VISA", debit: false },
  { key: "visa_debito", brand: "VISA", debit: true },
  { key: "master", brand: "MASTERCARD", debit: false },
  { key: "maestro", brand: "MAESTRO", debit: true },
  { key: "amex", brand: "AMEX", debit: false },
  { key: "cabal", brand: "CABAL", debit: false },
  { key: "naranja", brand: "NARANJA", debit: false },
];

export function apiBrand(key: unknown): { key: string; brand: string; debit: boolean } | null {
  return GETNET_API_BRANDS.find((b) => b.key === key) ?? null;
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export type CardInput = {
  number: string;
  exp_month: string;
  exp_year: string;
  cvv: string;
  holder: string;
  dni: string;
};

/** Valida la tarjeta del body (server-side). Devuelve la tarjeta limpia o el error. */
export function cleanCard(raw: unknown, now: Date = new Date()): { ok: true; card: CardInput } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "invalid_card" };
  const number = String(raw.number ?? "").replace(/\D/g, "");
  const month = String(raw.exp_month ?? "").replace(/\D/g, "").padStart(2, "0").slice(-2);
  const year = String(raw.exp_year ?? "").replace(/\D/g, "").slice(-2);
  const cvv = String(raw.cvv ?? "").replace(/\D/g, "");
  const holder = String(raw.holder ?? "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 26);
  const dni = String(raw.dni ?? "").replace(/\D/g, "");
  if (number.length < 13 || number.length > 19 || !luhn(number)) return { ok: false, error: "invalid_card" };
  const m = Number(month);
  const y = 2000 + Number(year);
  if (!(m >= 1 && m <= 12) || year.length !== 2) return { ok: false, error: "invalid_card" };
  if (y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1)) {
    return { ok: false, error: "card_expired" };
  }
  if (cvv.length < 3 || cvv.length > 4) return { ok: false, error: "invalid_card" };
  if (holder.length < 3) return { ok: false, error: "invalid_card" };
  if (dni.length < 6 || dni.length > 9) return { ok: false, error: "invalid_card" };
  return { ok: true, card: { number, exp_month: month, exp_year: year, cvv, holder, dni } };
}

// ── Requests ─────────────────────────────────────────────────────────────────

export function buildTokenizeBody(cardNumber: string, customerId: string) {
  return { card_number: cardNumber.replace(/\D/g, ""), customer_id: customerId.slice(0, 100) };
}

export function buildQuotesBody(i: { amountCents: number; bin: string; numberToken: string }) {
  return {
    amount: i.amountCents,
    bin: i.bin.replace(/\D/g, "").slice(0, 9),
    number_token: i.numberToken,
    installment_type_filter: "no_interest",
  };
}

export type QuoteOption = { quote_id: string; schema: string | null; type: string | null; number: number; total_amount: number | null };

export function parseQuotes(json: unknown): QuoteOption[] {
  if (!isObj(json) || !Array.isArray(json.options)) return [];
  const out: QuoteOption[] = [];
  for (const o of json.options) {
    if (!isObj(o)) continue;
    const id = str(o.quote_id);
    const n = Number(o.number);
    if (!id || !Number.isInteger(n) || n < 1) continue;
    const total = Number(o.total_amount);
    out.push({
      quote_id: id,
      schema: str(o.schema),
      type: str(o.type),
      number: n,
      total_amount: Number.isFinite(total) ? total : null,
    });
  }
  return out;
}

/**
 * Cotización para las cuotas elegidas: misma cantidad, sin interés del emisor
 * (el recargo ya está en nuestro total) y, si trae total, igual al monto.
 */
export function pickQuote(options: QuoteOption[], installments: number, amountCents: number): QuoteOption | null {
  const same = options.filter((o) => o.number === installments && (o.type == null || /no_interest/i.test(o.type)));
  return same.find((o) => o.total_amount == null || o.total_amount === amountCents) ?? null;
}

export type ApiPaymentInput = {
  intentId: string;
  paymentId: string;
  idempotencyKey: string;
  amountCents: number;
  installments: number;
  debit: boolean;
  brand: string;
  numberToken: string;
  card: CardInput;
  quote: QuoteOption | null;
};

export function buildApiPaymentBody(i: ApiPaymentInput) {
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) throw new Error("invalid_amount");
  const n = i.debit ? 1 : Math.max(1, Math.trunc(i.installments));
  if (n > 1 && !i.quote) throw new Error("quote_required");
  return {
    idempotency_key: i.idempotencyKey,
    request_id: i.idempotencyKey,
    order_id: i.intentId,
    data: {
      amount: i.amountCents,
      currency: "ARS",
      customer_id: i.intentId,
      payment: {
        payment_id: i.paymentId,
        payment_method: i.debit ? "DEBIT" : "CREDIT",
        save_card_data: false,
        transaction_type: n > 1 ? "INSTALL_NO_INTEREST" : "FULL",
        number_installments: n,
        card: {
          number_token: i.numberToken,
          expiration_month: i.card.exp_month,
          expiration_year: i.card.exp_year,
          cardholder_name: i.card.holder,
          security_code: i.card.cvv,
          brand: i.brand,
        },
      },
      ...(n > 1 && i.quote
        ? { additional_data: { installment: { quote_id: i.quote.quote_id, ...(i.quote.schema ? { schema: i.quote.schema } : {}) } } }
        : {}),
    },
  };
}

// ── Respuestas ───────────────────────────────────────────────────────────────

/** Centavos de un monto de Getnet (entero o string sin punto = centavos). */
export function apiCents(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Number.isInteger(v) ? v : Math.round(v * 100);
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (/^\d+\.\d{1,2}$/.test(t)) return Math.round(Number(t) * 100);
  }
  return null;
}

const OK_STATES = new Set(["APPROVED", "CAPTURED", "PAID"]);
const PENDING_STATES = new Set(["AUTHORIZED", "PENDING", "REGISTERED"]);
const REJECT_STATES = new Set(["DENIED", "DECLINED", "REJECTED"]);
const VOID_STATES = new Set(["CANCELED", "CANCELLED", "REFUNDED", "REVERSED"]);

export type ApiPayOutcome =
  | { kind: "approved"; paymentId: string | null; amountCents: number; authCode: string | null; brand: string | null }
  | { kind: "amount_mismatch"; paymentId: string | null; expectedCents: number; gotCents: number | null }
  | { kind: "rejected"; paymentId: string | null; reason: string | null }
  | { kind: "pending"; paymentId: string | null; state: string }
  | { kind: "error"; httpStatus: number; reason: "credentials" | "card_data" | "not_enabled" | "gateway"; detail: string };

/** Resultado del POST /payments. Aprobado sólo con monto EXACTO en centavos. */
export function classifyApiPayResponse(httpStatus: number, body: unknown, expectedCents: number): ApiPayOutcome {
  const b = isObj(body) ? body : {};
  const state = (str(b.status) ?? "").toUpperCase();
  const paymentId = str(b.payment_id);
  if (httpStatus >= 200 && httpStatus < 300) {
    if (OK_STATES.has(state)) {
      const got = apiCents(b.amount);
      if (got !== expectedCents) return { kind: "amount_mismatch", paymentId, expectedCents, gotCents: got };
      return { kind: "approved", paymentId, amountCents: got, authCode: str(b.authorization_code), brand: str(b.brand) };
    }
    if (REJECT_STATES.has(state)) {
      return { kind: "rejected", paymentId, reason: str(b.reason_message) ?? str(b.reason_code) };
    }
    if (state === "ERROR") {
      return { kind: "error", httpStatus, reason: "gateway", detail: (str(b.reason_message) ?? "ERROR").slice(0, 200) };
    }
    return { kind: "pending", paymentId, state: state || "UNKNOWN" };
  }
  const { code, message } = isObj(body) ? parseApiError(JSON.stringify(body)) : { code: null, message: null };
  const detailState = isObj(body) && Array.isArray(body.details) && isObj(body.details[0])
    ? (str((body.details[0] as Obj).status) ?? "").toUpperCase()
    : "";
  // Rechazo del emisor que llega como 402/422 con status DENIED.
  if ((httpStatus === 402 || httpStatus === 422) && (REJECT_STATES.has(state) || detailState === "DENIED") && paymentId) {
    return { kind: "rejected", paymentId, reason: message };
  }
  const reason = httpStatus === 401
    ? "credentials"
    : httpStatus === 403
      ? "not_enabled"
      : httpStatus === 400 || httpStatus === 422
        ? "card_data"
        : "gateway";
  return { kind: "error", httpStatus, reason, detail: [code, message].filter(Boolean).join(": ").slice(0, 200) };
}

export function apiPayHttpResponse(o: ApiPayOutcome, finalAmount: number): { status: number; body: Obj } {
  switch (o.kind) {
    case "approved":
      return { status: 200, body: { ok: true, status: "approved", amount: finalAmount } };
    case "rejected":
      return { status: 402, body: { ok: false, status: "rejected_attempt", detail: o.reason ?? "" } };
    case "pending":
      return { status: 202, body: { ok: false, status: "pending_review", state: o.state } };
    case "amount_mismatch":
      return {
        status: 502,
        body: { ok: false, error: "getnet_error", reason: "amount_mismatch", detail: `expected ${o.expectedCents} got ${o.gotCents ?? "none"}` },
      };
    case "error":
      return { status: 502, body: { ok: false, error: "getnet_error", reason: o.reason, http_status: o.httpStatus, detail: o.detail } };
  }
}

export type ApiStatusDecision = {
  status: "approved" | "rejected" | "cancelled" | "pending";
  state: string;
  reason?: string;
  /** Monto cobrado (centavos) cuando está aprobado. */
  amountCents?: number;
};

/**
 * Estado desde GET /payments/info/{payment_id}. El payment_id lo generó y lo
 * cobró nuestro servidor con el total calculado acá, así que se acredita si
 * el monto cobrado cubre la base del cobro (el recargo de cuotas puede sumar)
 * y se devuelve el monto real para registrar la venta por ese total.
 */
export function decideApiPaymentInfo(info: unknown, baseAmount: number): ApiStatusDecision {
  if (!isObj(info)) return { status: "pending", state: "" };
  const state = (str(info.status) ?? "").toUpperCase();
  if (OK_STATES.has(state)) {
    const pay = isObj(info.payment) ? info.payment : null;
    const cents = apiCents(pay?.amount) ?? apiCents(info.amount);
    if (cents === null) return { status: "pending", state, reason: "amount_unverified" };
    if (cents < toCents(baseAmount)) return { status: "rejected", state, reason: "amount_mismatch" };
    return { status: "approved", state, amountCents: cents };
  }
  if (REJECT_STATES.has(state) || state === "ERROR") return { status: "rejected", state };
  if (VOID_STATES.has(state)) return { status: "cancelled", state };
  if (PENDING_STATES.has(state)) return { status: "pending", state };
  return { status: "pending", state };
}

/** ¿El id guardado en el intent es un payment_id de la Checkout API? */
export const isApiPaymentId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** Intent del checkout propio: su init_point es la página /pagar de NinjaPos. */
export function isOwnCheckoutIntent(initPoint: unknown): boolean {
  return typeof initPoint === "string" && /\/pagar\/[0-9a-f-]{36}/i.test(initPoint);
}

/** Link del checkout propio de Getnet (la página elige el backend por ?p=). */
export function ownCheckoutUrl(origin: string, intentId: string): string {
  return `${origin.replace(/\/+$/, "")}/pagar/${intentId}?p=getnet`;
}
