// =============================================================================
// Directo (Crédito Directo S.A.) · lógica pura compartida por las Edge
// `directo` y `directo_webhook` (testeada con Vitest en tests/unit/directo.test.ts).
// Sin imports: corre igual en Deno (Edge) y en Node (tests). Usa WebCrypto
// (globalThis.crypto.subtle) para el MerchantHash.
//
// VERIFICADO contra el código del plugin oficial de WooCommerce
// ("Wanderlust Directo" 0.0.1, directo-gateway.php, leído 2026-10-12):
//   * Config del comercio: API_KEY, SUBSCRIPTION_KEY, API_BASE_URL,
//     MERCHANT_USERNAME, MERCHANT_PASSWORD, Nombre del Merchant.
//   * Headers comunes: `ApiKey: <api_key>`,
//     `Ocp-Apim-Subscription-Key: <subscription_key>` (gateway Azure APIM),
//     `Content-Type: application/json`.
//   * Login: POST {base}api/merchant/login con { user, password } →
//     { credentials } (token que viaja tal cual en el header `Credentials`,
//     sin "Bearer").
//   * Orden: POST {base}api/merchant/orders con headers `Credentials: <token>`
//     y `MerchantHash: base64(AES-256-CBC(<cuerpo JSON exacto>))`, cuerpo
//     { Currency, Merchant_Name, Products, Document, Phone_Number, Address,
//     Description, Email, Merchant_Order_Id, Notify_Url, Price (string),
//     Additional_Data ("{}" string), Return_Url_Success, Return_Url_Error,
//     Merchanthash (= el token), Integration_Type } → { redirect_Url }.
//   * Webhook: POST JSON { notification_id } al Notify_Url. El plugin
//     re-consulta GET {base}api/merchant/notification/{notification_id} con
//     Credentials + MerchantHash de { Merchanthash, notification_id } →
//     { merchant_Order_Id, status }. Estados que usa: "Successful" (pagado) y
//     "Cancel" (cancelado).
//   * Clave e IV del MerchantHash: constantes fijas publicadas en el plugin
//     (AES-256-CBC, PKCS#7, salida base64). Se pueden pisar por env.
// INFERIDO (a confirmar con las credenciales QA de Directo o con los PDF
// IntegracionApiCommerce20 / IntegracionApiMulti20):
//   * Hosts: el plugin no trae ninguno (API_BASE_URL lo carga el comercio).
//     Por eso la URL base viaja en la conexión del tenant (api_base_url).
//   * Otros estados de la notificación (rechazo, vencimiento) y si informa el
//     monto: se aceptan varias formas y, si viene un monto, debe ser exacto.
//   * Integration_Type para integraciones propias (el plugin manda "WOO").
// =============================================================================

export type DirectoEnv = "qa" | "prod";

// Hosts oficiales: todavía sin confirmar (ver cabecera). Cuando Directo los
// confirme se completan acá y la URL de la conexión pasa a ser opcional.
export const DIRECTO_BASE: Record<DirectoEnv, string | null> = {
  prod: null,
  qa: null,
};

// Constantes del MerchantHash publicadas en el plugin oficial (base64).
export const DIRECTO_HASH_KEY_B64 = "WNuHEx0cvOwVAsgO85L/PfIgKA8k/hAMCG4K6bhrPt4=";
export const DIRECTO_HASH_IV_B64 = "jN1fGUSzqxpEldcsyUw+Eg==";

export const DIRECTO_INTEGRATION_TYPE = "API";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

// Lee una propiedad sin importar mayúsculas (la API mezcla "redirect_Url",
// "merchant_Order_Id", etc.).
export function pick(o: unknown, ...names: string[]): unknown {
  if (!isObj(o)) return undefined;
  const wanted = names.map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(o)) {
    if (wanted.includes(k.toLowerCase())) return v;
  }
  return undefined;
}

// Ids de notificación: nada que pueda alterar el path.
const NOTIFICATION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function directoEnv(sandbox: boolean | null | undefined): DirectoEnv {
  return sandbox === true ? "qa" : "prod";
}

export function toCents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

// ── Conexión del tenant ──────────────────────────────────────────────────────

export type DirectoCreds = {
  apiKey: string;
  username: string;
  password: string;
  merchantName: string;
  subscriptionKey: string | null;
  baseUrl: string | null;
};

export function parseCreds(secrets: unknown): DirectoCreds | null {
  if (!isObj(secrets)) return null;
  const apiKey = str(secrets.api_key);
  const username = str(secrets.merchant_username);
  const password = str(secrets.merchant_password);
  const merchantName = str(secrets.merchant_name);
  if (!apiKey || !username || !password || !merchantName) return null;
  return {
    apiKey,
    username,
    password,
    merchantName,
    subscriptionKey: str(secrets.subscription_key),
    baseUrl: str(secrets.api_base_url),
  };
}

// URL base normalizada (https y con "/" final, como la concatena el plugin).
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  return `${u.origin}${path}`;
}

// La URL de la conexión manda (es la que Directo le dio al comercio); si no
// hay, el host conocido del ambiente.
export function resolveBaseUrl(env: DirectoEnv, override: string | null | undefined): string {
  const base = normalizeBaseUrl(override) ?? normalizeBaseUrl(DIRECTO_BASE[env]);
  if (!base) throw new Error("directo_base_url_missing");
  return base;
}

export function baseHeaders(c: DirectoCreds): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ApiKey: c.apiKey,
  };
  if (c.subscriptionKey) h["Ocp-Apim-Subscription-Key"] = c.subscriptionKey;
  return h;
}

// ── MerchantHash ─────────────────────────────────────────────────────────────

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// base64(AES-256-CBC(PKCS#7)(texto)), igual que openssl_encrypt(...,
// OPENSSL_RAW_DATA) del plugin.
export async function merchantHash(
  plaintext: string,
  keyB64: string = DIRECTO_HASH_KEY_B64,
  ivB64: string = DIRECTO_HASH_IV_B64,
): Promise<string> {
  const key = b64ToBytes(keyB64);
  const iv = b64ToBytes(ivB64);
  if (key.length !== 32 || iv.length !== 16) throw new Error("directo_hash_config");
  const subtle = globalThis.crypto.subtle;
  const k = await subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  const data = new TextEncoder().encode(plaintext);
  const buf = new Uint8Array(new ArrayBuffer(data.length));
  buf.set(data);
  const enc = await subtle.encrypt({ name: "AES-CBC", iv }, k, buf);
  return bytesToB64(new Uint8Array(enc));
}

// ── Orden ────────────────────────────────────────────────────────────────────

export type OrderInput = {
  amount: number;
  merchantOrderId: string;
  merchantName: string;
  token: string;
  notifyUrl: string;
  successUrl: string;
  errorUrl: string;
  description?: string | null;
  email?: string | null;
  phone?: string | null;
};

// Cuerpo JSON EXACTO de la orden (el MerchantHash se calcula sobre este mismo
// texto). Mismo orden de campos que el plugin. El monto lo fija el servidor.
export function buildOrderBody(i: OrderInput): string {
  if (!Number.isFinite(i.amount) || i.amount <= 0) throw new Error("invalid_amount");
  const email = (i.email ?? "").trim();
  const phone = (i.phone ?? "").replace(/[^\d+]/g, "");
  const name = i.merchantName.trim();
  return JSON.stringify({
    Currency: "ARS",
    Merchant_Name: name,
    Products: `Compra en ${name}`,
    Document: null,
    Phone_Number: phone || null,
    Address: null,
    Description: (i.description ?? "").trim() || `Venta ${i.merchantOrderId.slice(0, 8)}`,
    Email: email || null,
    Merchant_Order_Id: i.merchantOrderId,
    Notify_Url: i.notifyUrl,
    Price: (toCents(i.amount) / 100).toFixed(2),
    Additional_Data: "{}",
    Return_Url_Success: i.successUrl,
    Return_Url_Error: i.errorUrl,
    Merchanthash: i.token,
    Integration_Type: DIRECTO_INTEGRATION_TYPE,
  });
}

export function parseLoginResponse(json: unknown): string | null {
  const t = str(pick(json, "credentials", "token", "access_token"));
  return t && t.length <= 4096 ? t : null;
}

export function parseOrderResponse(json: unknown): { redirectUrl: string } | null {
  const u = str(pick(json, "redirect_url", "redirecturl", "payment_url", "url"));
  if (!u || !/^https:\/\//i.test(u)) return null;
  return { redirectUrl: u };
}

// ── Notificación ─────────────────────────────────────────────────────────────

// El cuerpo del webhook es sólo una PISTA: qué notificación re-consultar.
export function extractNotificationId(body: unknown): string | null {
  const id = str(pick(body, "notification_id", "notificationid", "id"));
  return id && NOTIFICATION_ID_RE.test(id) ? id : null;
}

export function notificationHashPayload(token: string, notificationId: string): string {
  return JSON.stringify({ Merchanthash: token, notification_id: notificationId });
}

export type IntentStatus = "approved" | "rejected" | "cancelled" | "pending";

// Sólo "Successful" acredita (es el único estado de pago que usa el plugin).
export function mapDirectoStatus(status: unknown): IntentStatus {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "successful") return "approved";
  if (s === "cancel" || s === "cancelled" || s === "canceled" || s === "expired") return "cancelled";
  if (s === "rejected" || s === "denied" || s === "declined" || s === "failed" || s === "error") {
    return "rejected";
  }
  return "pending";
}

function amountOf(n: unknown): number | null {
  const v = pick(n, "price", "amount", "total_amount");
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v.trim())) return Number(v.trim());
  return null;
}

export type Decision = {
  status: IntentStatus;
  state: string;
  reason?: "reference_mismatch" | "amount_mismatch" | "amount_not_reported";
};

// Decide el estado del intent a partir de la notificación RE-CONSULTADA a
// Directo. Sólo cuenta si merchant_Order_Id es el intent (lo mandamos al crear
// la orden). Si la notificación informa el monto, tiene que ser exacto.
export function decideIntentUpdate(
  notification: unknown,
  expectedAmount: number,
  intentId: string,
): Decision {
  if (!isObj(notification)) return { status: "pending", state: "" };
  const state = str(pick(notification, "status")) ?? "";
  if (str(pick(notification, "merchant_order_id")) !== intentId) {
    return { status: "pending", state, reason: "reference_mismatch" };
  }
  const mapped = mapDirectoStatus(state);
  if (mapped !== "approved") return { status: mapped, state };
  const amount = amountOf(notification);
  if (amount === null) return { status: "approved", state, reason: "amount_not_reported" };
  if (toCents(amount) !== toCents(expectedAmount)) {
    return { status: "rejected", state, reason: "amount_mismatch" };
  }
  return { status: "approved", state };
}

// ── Llamadas HTTP (fetch inyectable para tests) ──────────────────────────────

export type ApiResult<T> = { ok: true; value: T } | { ok: false; httpStatus: number; detail: string };

async function call(
  f: FetchLike,
  url: string,
  init: RequestInit,
): Promise<ApiResult<unknown>> {
  try {
    const r = await f(url, init);
    const text = await r.text();
    if (!r.ok) return { ok: false, httpStatus: r.status, detail: text.slice(0, 300) };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, httpStatus: 502, detail: "invalid_json" };
    }
  } catch (e) {
    return { ok: false, httpStatus: 502, detail: String(e).slice(0, 300) };
  }
}

export type HashConfig = { keyB64?: string; ivB64?: string };

// Cliente por invocación: hace login una sola vez y reutiliza el token.
export function directoClient(p: {
  creds: DirectoCreds;
  baseUrl: string;
  hash?: HashConfig;
  fetchImpl?: FetchLike;
}) {
  const f = p.fetchImpl ?? fetch;
  let token: string | null = null;

  async function login(): Promise<ApiResult<string>> {
    if (token) return { ok: true, value: token };
    const r = await call(f, `${p.baseUrl}api/merchant/login`, {
      method: "POST",
      headers: baseHeaders(p.creds),
      body: JSON.stringify({ user: p.creds.username, password: p.creds.password }),
    });
    if (!r.ok) return r;
    const t = parseLoginResponse(r.value);
    if (!t) return { ok: false, httpStatus: 502, detail: "login_without_credentials" };
    token = t;
    return { ok: true, value: t };
  }

  async function signed(payload: string, t: string) {
    return {
      ...baseHeaders(p.creds),
      Credentials: t,
      MerchantHash: await merchantHash(payload, p.hash?.keyB64, p.hash?.ivB64),
    };
  }

  return {
    login,
    async createOrder(
      input: Omit<OrderInput, "token" | "merchantName">,
    ): Promise<ApiResult<{ redirectUrl: string }>> {
      const l = await login();
      if (!l.ok) return l;
      const body = buildOrderBody({ ...input, token: l.value, merchantName: p.creds.merchantName });
      const r = await call(f, `${p.baseUrl}api/merchant/orders`, {
        method: "POST",
        headers: await signed(body, l.value),
        body,
      });
      if (!r.ok) return r;
      const parsed = parseOrderResponse(r.value);
      if (!parsed) return { ok: false, httpStatus: 502, detail: "order_without_redirect_url" };
      return { ok: true, value: parsed };
    },
    async getNotification(notificationId: string): Promise<ApiResult<unknown>> {
      if (!NOTIFICATION_ID_RE.test(notificationId)) {
        return { ok: false, httpStatus: 400, detail: "invalid_notification_id" };
      }
      const l = await login();
      if (!l.ok) return l;
      return call(f, `${p.baseUrl}api/merchant/notification/${notificationId}`, {
        method: "GET",
        headers: await signed(notificationHashPayload(l.value, notificationId), l.value),
      });
    },
  };
}
