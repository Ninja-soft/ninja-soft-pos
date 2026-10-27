// =============================================================================
// Directo (Crédito Directo S.A.) · API Ecommerce 2.0 (ADR-181, reemplaza las
// suposiciones de ADR-041). Lógica pura compartida por las Edge `directo`,
// `directo_webhook`, `set_payment_secret` y `pending_charges_sync`, testeada
// con Vitest en tests/unit/directo.test.ts. Sin imports: corre igual en Deno
// (Edge) y en Node (tests).
//
// VERIFICADO contra el documento oficial "Documento de integración API
// (versión Directo 2.0) · Generación de orden en Directo · Ecommerce"
// (docs/payments/directo/IntegracionApiCommerce20.pdf, 2026-10-27):
//   * Hosts: QA https://public.qa.directo.com.ar/ecommerce-qa · producción
//     https://public.pro.directo.com.ar/ecommerce-pro.
//   * Login POST {base}/api/v1/auth/token { username, password } → { token }.
//     El resto lleva `Authorization: Bearer <token>`. HTTP 403 en cualquier
//     llamada = el token venció: se vuelve a loguear (una vez) y se reintenta.
//   * get_by_dni_type (GET, sexTypeId 2|M masculino, 3|F femenino), rating
//     (POST { name "APELLIDOS,NOMBRES", dni, sexTypeId, policyProduct } →
//     { pendingRequestId, offer[], campaignMessage? }), deadlines (POST
//     { amount, pendingRequestId } → { deadlines[] }).
//   * create_order POST { price, fullName, dni, notifyUrl, returnUrlSuccess,
//     returnUrlError, policyProduct } → { merchantOrderId, creationDate,
//     redirectUrl }. merchantOrderId lo genera Directo.
//   * get_order_status/{merchantOrderId} y get_by_notification/{id} devuelven
//     { status: Success|Cancel|Pending, merchantOrderId, installments,
//     installmentAmount, amount (capital del crédito), creditNumber }.
//   * Webhook: POST { notification_id } al notifyUrl. Sin firma: siempre se
//     re-consulta get_by_notification con la credencial del comercio.
//   * Errores { status: "Error", message }: Invalid Person, policyProduct
//     field is spected, Rejected, InvalidPlan, No Installments found, Invalid
//     Request, Comunication error, Error creating order.
//   * No hay API Key, Subscription Key ni MerchantHash.
// INFERIDO (pendiente con Directo):
//   * Duración del token: si es un JWT se usa su `exp`; si no, 30 minutos.
//   * Código HTTP de un login con credenciales malas (se toma 400/401/403).
//   * price como número con 2 decimales (así está en el ejemplo).
// =============================================================================

export type DirectoEnv = "qa" | "prod";

export const DIRECTO_BASE: Record<DirectoEnv, string> = {
  qa: "https://public.qa.directo.com.ar/ecommerce-qa",
  prod: "https://public.pro.directo.com.ar/ecommerce-pro",
};

export const DIRECTO_TIMEOUT_DEFAULT_S = 30;
export const DIRECTO_TIMEOUT_MIN_S = 5;
export const DIRECTO_TIMEOUT_MAX_S = 120;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
};

// Lee una propiedad sin importar mayúsculas.
export function pick(o: unknown, ...names: string[]): unknown {
  if (!isObj(o)) return undefined;
  const wanted = names.map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(o)) {
    if (wanted.includes(k.toLowerCase())) return v;
  }
  return undefined;
}

// Ids que viajan en el path: nada que pueda alterarlo.
const PATH_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const isPathId = (v: unknown): v is string => typeof v === "string" && PATH_ID_RE.test(v);

export function directoEnv(sandbox: boolean | null | undefined): DirectoEnv {
  return sandbox === true ? "qa" : "prod";
}

export function toCents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

// ── Conexión del tenant ──────────────────────────────────────────────────────

export type DirectoCreds = {
  username: string;
  password: string;
  /** Producto (BNPL, ELECTRO…) o código de política. null = no se manda. */
  policyProduct: string | null;
  /** Timeout técnico por llamada, en milisegundos. */
  timeoutMs: number;
  /** URL base avanzada (sólo https). null = la oficial del ambiente. */
  baseUrl: string | null;
};

/** Timeout técnico en segundos: por defecto 30, entre 5 y 120. */
export function clampTimeoutSeconds(v: unknown): number {
  const n = num(v);
  if (n === null || n <= 0) return DIRECTO_TIMEOUT_DEFAULT_S;
  return Math.min(DIRECTO_TIMEOUT_MAX_S, Math.max(DIRECTO_TIMEOUT_MIN_S, Math.round(n)));
}

/** Policy Product: producto o código, sin caracteres raros (máx. 40). */
export function normalizePolicyProduct(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").slice(0, 40);
  return /^[A-Za-z0-9 _.-]+$/.test(t) ? t : null;
}

// Secretos guardados por set_payment_secret (provider 'directo'). Acepta la
// forma 2.0 { username, password, policy_product, timeout_seconds,
// api_base_url } y la vieja de ADR-041 (merchant_username / merchant_password;
// api_key, subscription_key, merchant_name y su api_base_url se ignoran: eran
// de la API inferida del plugin).
export function parseCreds(secrets: unknown): DirectoCreds | null {
  if (!isObj(secrets)) return null;
  const username = str(secrets.username) ?? str(secrets.merchant_username);
  const password = str(secrets.password) ?? str(secrets.merchant_password);
  if (!username || !password) return null;
  const legacy = !str(secrets.username) && Boolean(str(secrets.merchant_username));
  return {
    username,
    password,
    policyProduct: normalizePolicyProduct(secrets.policy_product),
    timeoutMs: clampTimeoutSeconds(secrets.timeout_seconds) * 1000,
    baseUrl: legacy ? null : normalizeBaseUrl(str(secrets.api_base_url)),
  };
}

// URL base normalizada: https, sin usuario, query ni hash, y SIN "/" final.
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
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** ¿Es uno de los dos hosts oficiales? */
export function isOfficialBase(raw: string | null | undefined): boolean {
  const n = normalizeBaseUrl(raw);
  return n === DIRECTO_BASE.qa || n === DIRECTO_BASE.prod;
}

// Host del ambiente (switch Sandbox = QA). La URL de la conexión es un
// override avanzado: sólo https.
export function resolveBaseUrl(env: DirectoEnv, override: string | null | undefined): string {
  return normalizeBaseUrl(override) ?? DIRECTO_BASE[env];
}

// ── Comprador ────────────────────────────────────────────────────────────────

const NAME_CHARS_RE = /[^A-Za-zÀ-ÖØ-öø-ÿ' .-]/g;
const cleanNamePart = (v: unknown): string =>
  String(v ?? "")
    .replace(/,/g, " ")
    .replace(NAME_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

/** fullName / name de Directo: "APELLIDOS,NOMBRES" (sin espacio tras la coma). */
export function buildFullName(lastNames: unknown, firstNames: unknown): string | null {
  const last = cleanNamePart(lastNames);
  const first = cleanNamePart(firstNames);
  if (!last || !first) return null;
  return `${last},${first}`.slice(0, 120);
}

/**
 * Propuesta de apellido / nombres a partir del nombre del cliente (sólo para
 * prellenar: el cajero la confirma). "PEREZ, JUAN" → apellido PEREZ; sin coma,
 * la última palabra es el apellido.
 */
export function splitCustomerName(name: unknown): { lastName: string; firstName: string } {
  const raw = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { lastName: "", firstName: "" };
  const comma = raw.indexOf(",");
  if (comma > 0) return { lastName: raw.slice(0, comma).trim(), firstName: raw.slice(comma + 1).trim() };
  const parts = raw.split(" ");
  if (parts.length === 1) return { lastName: raw, firstName: "" };
  return { lastName: parts[parts.length - 1] ?? "", firstName: parts.slice(0, -1).join(" ") };
}

/** DNI: sólo dígitos (acepta puntos, espacios y guiones), 6 a 9 cifras. */
export function normalizeDni(v: unknown): string | null {
  const d = String(v ?? "").replace(/[.\s-]/g, "");
  return /^\d{6,9}$/.test(d) ? d.replace(/^0+(?=\d{6})/, "") : null;
}

/** DNI desde el documento del cliente: DNI tal cual, o el del medio de un CUIT/CUIL de persona. */
export function dniFromDocument(type: unknown, number: unknown): string | null {
  const t = String(type ?? "").toLowerCase();
  const digits = String(number ?? "").replace(/\D/g, "");
  if (t === "dni") return normalizeDni(digits);
  if ((t === "cuit" || t === "cuil") && digits.length === 11) {
    // Sólo personas humanas (20, 23, 24, 27): las empresas (30, 33, 34) no tienen DNI.
    if (!/^(20|23|24|27)/.test(digits)) return null;
    return normalizeDni(digits.slice(2, 10));
  }
  return null;
}

/** sexTypeId de Directo: "2" masculino, "3" femenino. */
export function sexTypeId(v: unknown): "2" | "3" | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "2" || s === "M" || s === "MASCULINO") return "2";
  if (s === "3" || s === "F" || s === "FEMENINO") return "3";
  return null;
}

// ── Respuestas ───────────────────────────────────────────────────────────────

export function parseLoginResponse(json: unknown): string | null {
  const t = str(pick(json, "token"));
  return t && t.length <= 8192 ? t : null;
}

export type CreatedOrder = { merchantOrderId: string; creationDate: string | null; redirectUrl: string };

export function parseOrderResponse(json: unknown): CreatedOrder | null {
  const id = str(pick(json, "merchantOrderId"));
  const u = str(pick(json, "redirectUrl"));
  if (!id || !isPathId(id) || !u || !/^https:\/\//i.test(u)) return null;
  return { merchantOrderId: id, creationDate: str(pick(json, "creationDate")), redirectUrl: u };
}

export type DirectoOrderStatus = {
  status: string;
  merchantOrderId: string | null;
  installments: number | null;
  installmentAmount: number | null;
  /** Capital del crédito (sólo en Success, opcional). */
  amount: number | null;
  creditNumber: string | null;
};

export function parseOrderStatus(json: unknown): DirectoOrderStatus | null {
  if (!isObj(json)) return null;
  return {
    status: str(pick(json, "status")) ?? "",
    merchantOrderId: str(pick(json, "merchantOrderId")),
    installments: num(pick(json, "installments")),
    installmentAmount: num(pick(json, "installmentAmount")),
    amount: num(pick(json, "amount")),
    creditNumber: str(pick(json, "creditNumber"))?.slice(0, 60) ?? null,
  };
}

export type Offer = {
  pendingRequestId: string;
  offers: { maximumAmount: number | null; minimumAmount: number | null; maximumRate: number | null }[];
  campaignMessage: string | null;
};

export function parseRatingResponse(json: unknown): Offer | null {
  const id = str(pick(json, "pendingRequestId"));
  if (!id) return null;
  const raw = pick(json, "offer");
  const offers = (Array.isArray(raw) ? raw : []).filter(isObj).map((o) => ({
    maximumAmount: num(pick(o, "maximumAmount")),
    minimumAmount: num(pick(o, "minimumAmount")),
    maximumRate: num(pick(o, "maximumRate")),
  }));
  return { pendingRequestId: id, offers, campaignMessage: str(pick(json, "campaignMessage")) };
}

export type DeadlinePlan = {
  installments: number | null;
  installmentAmount: number | null;
  planType: string | null;
  disclaimers: string[];
  schedule: { expiration: string; quote: string; amount: number | null }[];
};

export function parseDeadlinesResponse(json: unknown): DeadlinePlan[] {
  const raw = pick(json, "deadlines");
  return (Array.isArray(raw) ? raw : []).filter(isObj).map((d) => {
    const disc = pick(d, "disclaimer");
    const plan = pick(d, "plan");
    return {
      installments: num(pick(d, "quantityRate")),
      installmentAmount: num(pick(d, "amountRate")),
      planType: str(pick(d, "planType")),
      disclaimers: (Array.isArray(disc) ? disc : [])
        .map((x) => str(pick(x, "content")))
        .filter((x): x is string => Boolean(x))
        .slice(0, 6),
      schedule: (Array.isArray(plan) ? plan : [])
        .filter(isObj)
        .slice(0, 48)
        .map((p) => ({
          expiration: str(pick(p, "expiration")) ?? "",
          quote: str(pick(p, "quote")) ?? "",
          amount: num(pick(p, "amount")),
        })),
    };
  });
}

// ── Errores ──────────────────────────────────────────────────────────────────

export type DirectoErrorCode =
  | "directo_auth_failed"
  | "directo_timeout"
  | "directo_unreachable"
  | "directo_invalid_person"
  | "directo_policy_required"
  | "directo_rejected"
  | "directo_invalid_plan"
  | "directo_no_installments"
  | "directo_invalid_request"
  | "directo_error";

/** Código estable a partir del HTTP y el `message` de Directo. */
export function classifyError(httpStatus: number, detail: string): DirectoErrorCode {
  const m = String(detail ?? "").toLowerCase();
  if (m === "timeout") return "directo_timeout";
  if (httpStatus === 0) return "directo_unreachable";
  if (httpStatus === 401 || httpStatus === 403) return "directo_auth_failed";
  if (m.includes("policyproduct")) return "directo_policy_required";
  if (m.includes("invalid person")) return "directo_invalid_person";
  if (m.includes("invalidplan") || m.includes("invalid plan")) return "directo_invalid_plan";
  if (m.includes("rejected")) return "directo_rejected";
  if (m.includes("installments")) return "directo_no_installments";
  if (m.includes("invalid request")) return "directo_invalid_request";
  return "directo_error";
}

/** ¿El login falló por credenciales (y no por red o por un 5xx)? */
export function isAuthFailure(httpStatus: number): boolean {
  return httpStatus === 400 || httpStatus === 401 || httpStatus === 403;
}

// ── Notificación y estado ────────────────────────────────────────────────────

// El cuerpo del webhook es sólo una PISTA: qué notificación re-consultar.
export function extractNotificationId(body: unknown): string | null {
  const id = str(pick(body, "notification_id", "notificationId"));
  return id && isPathId(id) ? id : null;
}

export type IntentStatus = "approved" | "cancelled" | "pending";

// Success acredita; Cancel cancela; Pending (o algo desconocido) sigue esperando.
export function mapDirectoStatus(status: unknown): IntentStatus {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "success") return "approved";
  if (s === "cancel") return "cancelled";
  return "pending";
}

export type CreditInfo = {
  credit_number: string | null;
  installments: number | null;
  installment_amount: number | null;
  capital: number | null;
  /** El capital informado no coincide con el precio de la orden. */
  capital_differs: boolean;
};

export type Decision = {
  status: IntentStatus;
  state: string;
  reason?: "order_mismatch";
  credit?: CreditInfo;
};

// Decide el estado del intent a partir del estado RE-CONSULTADO a Directo.
// Sólo cuenta si merchantOrderId es el de la orden que creamos (guardado en
// el intent). Success aprueba aunque el capital difiera del precio (ADR-181:
// es el capital del crédito; queda registrado para revisar).
export function decideIntentUpdate(
  raw: unknown,
  expected: { merchantOrderId: string; amount: number },
): Decision {
  const s = parseOrderStatus(raw);
  if (!s) return { status: "pending", state: "" };
  if (!s.merchantOrderId || s.merchantOrderId !== expected.merchantOrderId) {
    return { status: "pending", state: s.status, reason: "order_mismatch" };
  }
  const mapped = mapDirectoStatus(s.status);
  if (mapped !== "approved") return { status: mapped, state: s.status };
  return {
    status: "approved",
    state: s.status,
    credit: {
      credit_number: s.creditNumber,
      installments: s.installments,
      installment_amount: s.installmentAmount,
      capital: s.amount,
      capital_differs: s.amount !== null && toCents(s.amount) !== toCents(expected.amount),
    },
  };
}

// ── Cuerpos ──────────────────────────────────────────────────────────────────

const FULL_NAME_RE = /^[^,]+,[^,]+$/;

export type OrderInput = {
  amount: number;
  fullName: string;
  dni: string;
  notifyUrl: string;
  returnUrlSuccess: string;
  returnUrlError: string;
  policyProduct?: string | null;
};

export function buildOrderBody(i: OrderInput): Record<string, unknown> {
  if (!Number.isFinite(i.amount) || i.amount <= 0) throw new Error("invalid_amount");
  if (!FULL_NAME_RE.test(i.fullName)) throw new Error("invalid_full_name");
  const dni = normalizeDni(i.dni);
  if (!dni) throw new Error("invalid_dni");
  const body: Record<string, unknown> = {
    price: toCents(i.amount) / 100,
    fullName: i.fullName,
    dni,
    notifyUrl: i.notifyUrl,
    returnUrlSuccess: i.returnUrlSuccess,
    returnUrlError: i.returnUrlError,
  };
  const pp = normalizePolicyProduct(i.policyProduct);
  if (pp) body.policyProduct = pp;
  return body;
}

export function buildRatingBody(i: {
  fullName: string;
  dni: string;
  sex: unknown;
  policyProduct?: string | null;
}): Record<string, unknown> {
  const dni = normalizeDni(i.dni);
  const st = sexTypeId(i.sex);
  if (!dni) throw new Error("invalid_dni");
  if (!st) throw new Error("invalid_sex");
  if (!FULL_NAME_RE.test(i.fullName)) throw new Error("invalid_full_name");
  const body: Record<string, unknown> = { name: i.fullName, dni, sexTypeId: st };
  const pp = normalizePolicyProduct(i.policyProduct);
  if (pp) body.policyProduct = pp;
  return body;
}

// ── Llamadas HTTP (fetch inyectable para tests) ──────────────────────────────

export type ApiResult<T> = { ok: true; value: T } | { ok: false; httpStatus: number; detail: string };

async function call(f: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<ApiResult<unknown>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await f(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!r.ok) {
      // Nunca se devuelve el cuerpo crudo (podría traer datos del comprador).
      const msg = isObj(body) ? str(body.message) : null;
      return { ok: false, httpStatus: r.status, detail: (msg ?? `http_${r.status}`).slice(0, 120) };
    }
    if (body === null) return { ok: false, httpStatus: 502, detail: "invalid_json" };
    return { ok: true, value: body };
  } catch (e) {
    const aborted = ctrl.signal.aborted || (e instanceof Error && e.name === "AbortError");
    return { ok: false, httpStatus: 0, detail: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(t);
  }
}

// Cache del token entre invocaciones de la misma instancia. La clave es un
// hash de ambiente + URL + credencial: nunca guarda el secreto en claro.
type CachedToken = { token: string; until: number };
const TOKEN_CACHE = new Map<string, CachedToken>();
const TOKEN_CACHE_MAX = 200;
const TOKEN_FALLBACK_TTL_MS = 30 * 60_000;

async function cacheKey(env: DirectoEnv, base: string, c: DirectoCreds): Promise<string> {
  const data = new TextEncoder().encode(`${env}\n${base}\n${c.username}\n${c.password}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Vencimiento del token: `exp` si es un JWT (menos 1 minuto, máx. 24 h), si no 30 min. */
export function tokenUntil(token: string, nowMs: number): number {
  try {
    const part = token.split(".")[1];
    if (part) {
      const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
      const exp = num(isObj(payload) ? payload.exp : null);
      if (exp && exp * 1000 - 60_000 > nowMs) return Math.min(exp * 1000 - 60_000, nowMs + 24 * 3600_000);
    }
  } catch {
    /* no es un JWT legible */
  }
  return nowMs + TOKEN_FALLBACK_TTL_MS;
}

/** Sólo para tests. */
export function clearTokenCache() {
  TOKEN_CACHE.clear();
}

export function directoClient(p: {
  creds: DirectoCreds;
  env: DirectoEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
}) {
  const f = p.fetchImpl ?? fetch;
  const now = p.now ?? (() => Date.now());
  const base = resolveBaseUrl(p.env, p.creds.baseUrl);
  const timeoutMs = p.creds.timeoutMs;

  async function token(force = false): Promise<ApiResult<string>> {
    const key = await cacheKey(p.env, base, p.creds);
    const hit = TOKEN_CACHE.get(key);
    if (!force && hit && hit.until > now()) return { ok: true, value: hit.token };
    const r = await call(
      f,
      `${base}/api/v1/auth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: p.creds.username, password: p.creds.password }),
      },
      timeoutMs,
    );
    if (!r.ok) {
      TOKEN_CACHE.delete(key);
      return r;
    }
    const t = parseLoginResponse(r.value);
    if (!t) return { ok: false, httpStatus: 502, detail: "token_missing" };
    if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.clear();
    TOKEN_CACHE.set(key, { token: t, until: tokenUntil(t, now()) });
    return { ok: true, value: t };
  }

  // Llamada autenticada: 403 = token vencido → login nuevo y un solo reintento.
  async function authed(path: string, init: RequestInit): Promise<ApiResult<unknown>> {
    let t = await token();
    if (!t.ok) return t;
    const run = (tk: string) =>
      call(
        f,
        `${base}${path}`,
        {
          ...init,
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${tk}` },
        },
        timeoutMs,
      );
    let r = await run(t.value);
    if (!r.ok && r.httpStatus === 403) {
      t = await token(true);
      if (!t.ok) return t;
      r = await run(t.value);
    }
    return r;
  }

  const statusOf = (r: ApiResult<unknown>): ApiResult<DirectoOrderStatus> => {
    if (!r.ok) return r;
    const s = parseOrderStatus(r.value);
    return s ? { ok: true, value: s } : { ok: false, httpStatus: 502, detail: "invalid_status" };
  };

  return {
    baseUrl: base,
    token,
    async createOrder(input: Omit<OrderInput, "policyProduct">): Promise<ApiResult<CreatedOrder>> {
      let body: Record<string, unknown>;
      try {
        body = buildOrderBody({ ...input, policyProduct: p.creds.policyProduct });
      } catch (e) {
        return { ok: false, httpStatus: 400, detail: e instanceof Error ? e.message : "invalid_request" };
      }
      const r = await authed("/api/v1/services/create_order", { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) return r;
      const parsed = parseOrderResponse(r.value);
      return parsed ? { ok: true, value: parsed } : { ok: false, httpStatus: 502, detail: "order_without_redirect_url" };
    },
    async getOrderStatus(merchantOrderId: string): Promise<ApiResult<DirectoOrderStatus>> {
      if (!isPathId(merchantOrderId)) return { ok: false, httpStatus: 400, detail: "invalid_order" };
      return statusOf(await authed(`/api/v1/services/get_order_status/${merchantOrderId}`, { method: "GET" }));
    },
    async getByNotification(notificationId: string): Promise<ApiResult<DirectoOrderStatus>> {
      if (!isPathId(notificationId)) return { ok: false, httpStatus: 400, detail: "invalid_notification_id" };
      return statusOf(await authed(`/api/v1/services/get_by_notification/${notificationId}`, { method: "GET" }));
    },
    async findPerson(dni: string, sex: unknown): Promise<ApiResult<{ firstName: string; lastName: string }[]>> {
      const d = normalizeDni(dni);
      const st = sexTypeId(sex);
      if (!d || !st) return { ok: false, httpStatus: 400, detail: "invalid_person_query" };
      const r = await authed(`/api/v1/services/get_by_dni_type?sexTypeId=${st}&dni=${d}`, { method: "GET" });
      if (!r.ok) return r;
      const names = pick(r.value, "names");
      return {
        ok: true,
        value: (Array.isArray(names) ? names : []).filter(isObj).map((n) => ({
          firstName: str(pick(n, "firstName")) ?? "",
          lastName: str(pick(n, "lastName")) ?? "",
        })),
      };
    },
    async rating(i: { fullName: string; dni: string; sex: unknown }): Promise<ApiResult<Offer>> {
      let body: Record<string, unknown>;
      try {
        body = buildRatingBody({ ...i, policyProduct: p.creds.policyProduct });
      } catch (e) {
        return { ok: false, httpStatus: 400, detail: e instanceof Error ? e.message : "invalid_request" };
      }
      const r = await authed("/api/v1/services/rating", { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) return r;
      const o = parseRatingResponse(r.value);
      return o ? { ok: true, value: o } : { ok: false, httpStatus: 502, detail: "invalid_rating" };
    },
    async deadlines(amount: number, pendingRequestId: string): Promise<ApiResult<DeadlinePlan[]>> {
      if (!Number.isFinite(amount) || amount <= 0 || !isPathId(pendingRequestId)) {
        return { ok: false, httpStatus: 400, detail: "invalid_request" };
      }
      const r = await authed("/api/v1/services/deadlines", {
        method: "POST",
        body: JSON.stringify({ amount: toCents(amount) / 100, pendingRequestId }),
      });
      if (!r.ok) return r;
      return { ok: true, value: parseDeadlinesResponse(r.value) };
    },
  };
}
