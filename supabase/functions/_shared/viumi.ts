// =============================================================================
// Viumi (Banco Macro, plataforma Geopagos) · Checkout API v2 (ADR-173). Lógica
// pura compartida por las Edge `viumi` y `viumi_webhook` y por
// `pending_charges_sync` (testeada con Vitest en tests/unit/viumi.test.ts).
// Sin imports: corre igual en Deno y en Node. Usa WebCrypto
// (globalThis.crypto.subtle) sólo para la clave de la cache del token.
//
// VERIFICADO contra la documentación pública (developers.viumi.com.ar) y el
// plugin público de WooCommerce "cool-payment-gateway-viumi-for-woocommerce"
// (detalle y links en docs/47-viumi.md):
//   * Hosts de la doc: auth https://auth.{stg|prd}.geopagos.io y checkout
//     https://api-mpos-macro.stg.geopagos.io (prueba) o https://api.viumi.com.ar
//     (producción). El plugin usa auth.geopagos.com y auth.sandbox.geopagos.com:
//     se prueban en ese orden si el primero no responde o da 404.
//   * Token: POST {auth}/oauth/token { grant_type: "client_credentials",
//     client_id, client_secret, scope: "api_orders_post" } → { token_type:
//     "Bearer", expires_in, access_token }.
//   * Orden: POST {checkout}/api/v2/orders (JSON:API, application/vnd.api+json)
//     { data: { attributes: { currency: "032", items: [{ id, name, quantity,
//     unitPrice: { currency, amount (CENTAVOS) } }], redirect_urls: { success,
//     failed }, webhookUrl, expireLimitMinutes } } } → data.id (uuid) y el link
//     en data.links.checkout (doc) o data.links[0].checkout (plugin).
//   * Consulta: GET {checkout}/api/v2/orders/{uuid} → data.attributes: uuid,
//     orderNumber, status ("SUCCESS" pagada), hasPendingPayment, payment {
//     status "APPROVED" }, payments[], price { amount, currency }, items.
//   * Webhook: POST a webhookUrl { data: { type: "Payment", order: { uuid,
//     status, source }, payment: { id, authorizationCode, refNumber, status } } }
//     SIN firma documentada.
// INFERIDO (a confirmar con credenciales de prueba):
//   * expires_in: el ejemplo de la doc parece un timestamp unix; el plugin lo
//     toma como segundos. > 1e9 = timestamp en segundos; si no, duración.
//   * Estados de orden distintos de SUCCESS: REJECTED / DECLINED / FAILED →
//     rechazado; EXPIRED / CANCELLED / CANCELED → cancelado; el resto, pendiente.
//   * Montos mínimo y máximo: la doc no los menciona.
//   * Sin referencia externa documentada: el intent viaja como items[0].id y
//     en la query del webhookUrl, pero lo que se verifica es el uuid de la orden
//     guardado en el intent.
//
// Como el webhook no viene firmado, NUNCA se confía en su cuerpo: sólo dice
// qué orden re-consultar con la credencial del negocio. Se acredita sólo si la
// orden consultada es la guardada en el intent, tiene un pago aprobado y el
// monto coincide. Sin devoluciones ni anulación por API (no están documentadas).
// =============================================================================

export type ViumiEnv = "stage" | "prod";

/** Hosts de auth por ambiente, en orden: el segundo es el del plugin. */
export const VIUMI_AUTH_HOSTS: Record<ViumiEnv, string[]> = {
  stage: ["https://auth.stg.geopagos.io", "https://auth.sandbox.geopagos.com"],
  prod: ["https://auth.prd.geopagos.io", "https://auth.geopagos.com"],
};

export const VIUMI_CHECKOUT_BASE: Record<ViumiEnv, string> = {
  stage: "https://api-mpos-macro.stg.geopagos.io",
  prod: "https://api.viumi.com.ar",
};

export const VIUMI_SCOPE = "api_orders_post";
/** ISO 4217 numérico de pesos argentinos. */
export const VIUMI_CURRENCY = "032";
/** Límites del monto de una orden en centavos (INFERIDOS: la doc no los dice). */
export const VIUMI_MIN_CENTS = 100;
export const VIUMI_MAX_CENTS = 999_999_999;
/** Monto mínimo en pesos (espejo para la UI: tender minAmount). */
export const VIUMI_MIN_AMOUNT = VIUMI_MIN_CENTS / 100;
/** Vencimiento del link (minutos). Espejo de pending_charge_max_ttl('viumi'). */
export const VIUMI_EXPIRE_MINUTES = 24 * 60;
export const VIUMI_MIN_EXPIRE_MINUTES = 10;
const ITEM_NAME_MAX = 63;
const WEBHOOK_URL_MAX = 255;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Uuid de orden de Viumi: nada que pueda alterar el path.
const ORDER_UUID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function isOrderUuid(v: unknown): v is string {
  return typeof v === "string" && ORDER_UUID_RE.test(v);
}

export function viumiEnv(sandbox: boolean | null | undefined): ViumiEnv {
  return sandbox === true ? "stage" : "prod";
}

// ── Conexión del negocio ─────────────────────────────────────────────────────

export type ViumiCreds = { clientId: string; clientSecret: string };

/** payment_secrets provider 'viumi': { client_id, client_secret }. */
export function parseCreds(secrets: unknown): ViumiCreds | null {
  if (!isObj(secrets)) return null;
  const clientId = str(secrets.client_id);
  const clientSecret = str(secrets.client_secret);
  if (!clientId || !clientSecret) return null;
  if (clientId.length > 200 || clientSecret.length > 400) return null;
  return { clientId, clientSecret };
}

// ── Montos ───────────────────────────────────────────────────────────────────

export function toCents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

export type AmountCheck =
  | { ok: true; value: string }
  | { ok: false; error: "invalid_amount" | "viumi_min_amount" | "viumi_max_amount" };

/** Monto de la orden en CENTAVOS como string entero ("123456" = $1.234,56). */
export function orderAmount(amount: number): AmountCheck {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "invalid_amount" };
  const cents = toCents(amount);
  if (cents < VIUMI_MIN_CENTS) return { ok: false, error: "viumi_min_amount" };
  if (cents > VIUMI_MAX_CENTS) return { ok: false, error: "viumi_max_amount" };
  return { ok: true, value: String(cents) };
}

/** Centavos informados por Viumi (número entero o string de dígitos). */
export function parseCents(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Total de la orden en centavos: price.amount o, sin él, la suma de los ítems. */
export function orderTotalCents(attrs: Obj): number | null {
  const price = isObj(attrs.price) ? attrs.price : null;
  if (price) {
    const c = parseCents(price.amount);
    if (c !== null) return c;
  }
  if (!Array.isArray(attrs.items) || attrs.items.length === 0) return null;
  let total = 0;
  for (const it of attrs.items) {
    if (!isObj(it)) return null;
    const unit = isObj(it.unitPrice) ? parseCents(it.unitPrice.amount) : null;
    const q = Number(it.quantity ?? 1);
    if (unit === null || !Number.isInteger(q) || q <= 0) return null;
    total += unit * q;
  }
  return total;
}

// ── Orden ────────────────────────────────────────────────────────────────────

export type OrderInput = {
  amount: number;
  description?: string | null;
  /** Id del intent: viaja como id del ítem (no hay referencia externa). */
  intentId: string;
  successUrl: string;
  failedUrl: string;
  webhookUrl: string;
  expireMinutes?: number;
};

export function buildOrderBody(i: OrderInput): { data: { attributes: Obj } } {
  const a = orderAmount(i.amount);
  if (!a.ok) throw new Error(a.error);
  if (i.webhookUrl.length > WEBHOOK_URL_MAX) throw new Error("webhook_url_too_long");
  const name = (i.description ?? "").replace(/\s+/g, " ").trim().slice(0, ITEM_NAME_MAX) || "Venta";
  const expire = Math.max(
    VIUMI_MIN_EXPIRE_MINUTES,
    Math.round(Number.isFinite(i.expireMinutes) ? Number(i.expireMinutes) : VIUMI_EXPIRE_MINUTES),
  );
  return {
    data: {
      attributes: {
        currency: VIUMI_CURRENCY,
        items: [
          {
            id: i.intentId,
            name,
            quantity: 1,
            unitPrice: { currency: VIUMI_CURRENCY, amount: a.value },
          },
        ],
        redirect_urls: { success: i.successUrl, failed: i.failedUrl },
        webhookUrl: i.webhookUrl,
        expireLimitMinutes: expire,
      },
    },
  };
}

/**
 * Token OAuth. expires_in es ambiguo: > 1e9 se toma como timestamp unix en
 * segundos; si no, como duración en segundos. Devuelve la vida en segundos.
 */
export function parseTokenResponse(json: unknown, nowMs: number): { token: string; ttlSeconds: number } | null {
  if (!isObj(json)) return null;
  const token = str(json.access_token);
  if (!token || token.length > 8192) return null;
  const exp = Number(json.expires_in);
  let ttl = 3600;
  if (Number.isFinite(exp) && exp > 0) ttl = exp > 1e9 ? Math.floor(exp - nowMs / 1000) : exp;
  return { token, ttlSeconds: ttl };
}

/** Vence 5 minutos antes que el token, con un mínimo de 60 segundos. */
export function tokenCacheUntil(nowMs: number, ttlSeconds: number): number {
  return nowMs + Math.max(60, ttlSeconds - 300) * 1000;
}

export type CreatedOrder = { uuid: string; checkoutLink: string; status: string };

function checkoutLinkOf(links: unknown): string | null {
  if (isObj(links)) return str(links.checkout);
  if (Array.isArray(links)) {
    for (const l of links) {
      const v = isObj(l) ? str(l.checkout) : null;
      if (v) return v;
    }
  }
  return null;
}

export function parseOrderResponse(json: unknown): CreatedOrder | null {
  if (!isObj(json) || !isObj(json.data)) return null;
  const d = json.data;
  const attrs = isObj(d.attributes) ? d.attributes : {};
  const uuid = str(d.id) ?? str(attrs.uuid);
  const link = checkoutLinkOf(d.links) ?? checkoutLinkOf(attrs.links);
  if (!uuid || !isOrderUuid(uuid) || !link || !/^https:\/\//i.test(link)) return null;
  return { uuid, checkoutLink: link, status: str(attrs.status) ?? "PENDING" };
}

// ── Estados ──────────────────────────────────────────────────────────────────

export type IntentStatus = "approved" | "rejected" | "cancelled" | "pending";

const PAID = new Set(["APPROVED", "PROCESSED"]);
const REJECTED = new Set(["REJECTED", "DECLINED", "FAILED"]);
const CANCELLED = new Set(["EXPIRED", "CANCELLED", "CANCELED"]);

const up = (v: unknown) => String(v ?? "").trim().toUpperCase();

/** ¿La orden tiene un pago aprobado (payment o alguno de payments[])? */
export function hasApprovedPayment(attrs: Obj): boolean {
  if (isObj(attrs.payment) && PAID.has(up(attrs.payment.status))) return true;
  if (Array.isArray(attrs.payments)) {
    return attrs.payments.some((p) => isObj(p) && PAID.has(up(p.status)));
  }
  return false;
}

/**
 * Atributos de la orden → estado del intent. Pagada = pago APPROVED o
 * PROCESSED (con la orden en SUCCESS o todavía sin pasar). Una orden SUCCESS
 * sin pago aprobado a la vista queda pendiente: no se acredita a ciegas.
 */
export function mapViumiOrder(attrs: unknown): IntentStatus {
  if (!isObj(attrs)) return "pending";
  if (hasApprovedPayment(attrs)) return "approved";
  const s = up(attrs.status);
  if (REJECTED.has(s)) return "rejected";
  if (CANCELLED.has(s)) return "cancelled";
  return "pending";
}

/** Normaliza la respuesta del GET (con o sin el envoltorio `data`). */
export function orderAttributes(json: unknown): { uuid: string | null; attrs: Obj } | null {
  if (!isObj(json)) return null;
  const d = isObj(json.data) ? json.data : json;
  const attrs = isObj(d.attributes) ? d.attributes : d;
  return { uuid: str(attrs.uuid) ?? str(d.id), attrs };
}

export type Decision = {
  status: IntentStatus;
  state: string;
  reason?: "order_mismatch" | "amount_mismatch" | "amount_not_reported";
};

/**
 * Decide el estado del intent a partir de la orden RE-CONSULTADA a Viumi.
 * Sólo cuenta si es la orden guardada en el intent. Si está pagada, el monto
 * (centavos) tiene que coincidir con el del intent.
 */
export function decideIntentUpdate(order: unknown, expected: { amount: number; orderUuid: string }): Decision {
  const o = orderAttributes(order);
  if (!o) return { status: "pending", state: "" };
  const state = (str(o.attrs.status) ?? "").slice(0, 40);
  if (o.uuid !== expected.orderUuid) return { status: "pending", state, reason: "order_mismatch" };
  const mapped = mapViumiOrder(o.attrs);
  if (mapped !== "approved") return { status: mapped, state };
  const cents = orderTotalCents(o.attrs);
  if (cents === null) return { status: "pending", state, reason: "amount_not_reported" };
  if (cents !== toCents(expected.amount)) return { status: "rejected", state, reason: "amount_mismatch" };
  return { status: "approved", state };
}

// ── Webhook ──────────────────────────────────────────────────────────────────

export type WebhookHint = { uuid: string; status: string; paymentStatus: string };

/** El cuerpo del webhook es sólo una PISTA: qué orden re-consultar. */
export function parseWebhook(body: unknown): WebhookHint | null {
  if (!isObj(body)) return null;
  const d = isObj(body.data) ? body.data : body;
  const order = isObj(d.order) ? d.order : null;
  const uuid = order ? str(order.uuid) : null;
  if (!uuid || !isOrderUuid(uuid)) return null;
  const payment = isObj(d.payment) ? d.payment : null;
  return {
    uuid,
    status: up(order?.status).slice(0, 40),
    paymentStatus: up(payment?.status).slice(0, 40),
  };
}

// ── Llamadas HTTP (fetch inyectable para tests) ──────────────────────────────

export type ApiResult<T> = { ok: true; value: T } | { ok: false; httpStatus: number; detail: string };

const TIMEOUT_MS = 15_000;
const JSONAPI = "application/vnd.api+json";

function errorDetail(body: unknown): string | null {
  if (!isObj(body)) return null;
  if (Array.isArray(body.errors) && isObj(body.errors[0])) {
    const e = body.errors[0];
    return str(e.detail) ?? str(e.title) ?? str(e.code);
  }
  return str(body.error_description) ?? str(body.message) ?? str(body.error);
}

async function call(f: FetchLike, url: string, init: RequestInit): Promise<ApiResult<unknown>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
      return { ok: false, httpStatus: r.status, detail: (errorDetail(body) ?? `http_${r.status}`).slice(0, 160) };
    }
    if (body === null) return { ok: false, httpStatus: 502, detail: "invalid_json" };
    return { ok: true, value: body };
  } catch (e) {
    return { ok: false, httpStatus: 0, detail: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(t);
  }
}

/** ¿El error es de credenciales? (para el mensaje y para no guardarlas). */
export function isAuthFailure(httpStatus: number): boolean {
  return httpStatus === 400 || httpStatus === 401 || httpStatus === 403;
}

// Cache del token entre invocaciones de la misma instancia (se renueva 5
// minutos antes de vencer). La clave es un hash de la credencial: nunca guarda
// el secreto en claro.
type CachedToken = { token: string; until: number };
const TOKEN_CACHE = new Map<string, CachedToken>();
const TOKEN_CACHE_MAX = 200;

async function cacheKey(env: ViumiEnv, c: ViumiCreds): Promise<string> {
  const data = new TextEncoder().encode(`viumi\n${env}\n${c.clientId}\n${c.clientSecret}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sólo para tests. */
export function clearTokenCache() {
  TOKEN_CACHE.clear();
}

/** Sólo para tests: cantidad de tokens cacheados. */
export function tokenCacheSize(): number {
  return TOKEN_CACHE.size;
}

export function viumiClient(p: { creds: ViumiCreds; env: ViumiEnv; fetchImpl?: FetchLike; now?: () => number }) {
  const f = p.fetchImpl ?? fetch;
  const now = p.now ?? (() => Date.now());
  const authHosts = VIUMI_AUTH_HOSTS[p.env];
  const base = VIUMI_CHECKOUT_BASE[p.env];

  async function token(force = false): Promise<ApiResult<string>> {
    const key = await cacheKey(p.env, p.creds);
    const hit = TOKEN_CACHE.get(key);
    if (!force && hit && hit.until > now()) return { ok: true, value: hit.token };
    let r: ApiResult<unknown> = { ok: false, httpStatus: 0, detail: "network" };
    // Host de la doc primero; si no responde o da 404, el del plugin.
    for (const host of authHosts) {
      r = await call(f, `${host}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: p.creds.clientId,
          client_secret: p.creds.clientSecret,
          scope: VIUMI_SCOPE,
        }),
      });
      if (r.ok || (r.httpStatus !== 0 && r.httpStatus !== 404)) break;
    }
    if (!r.ok) {
      TOKEN_CACHE.delete(key);
      return r;
    }
    const t = parseTokenResponse(r.value, now());
    if (!t) return { ok: false, httpStatus: 502, detail: "token_missing" };
    if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.clear();
    TOKEN_CACHE.set(key, { token: t.token, until: tokenCacheUntil(now(), t.ttlSeconds) });
    return { ok: true, value: t.token };
  }

  // Llamada autenticada: si el token cacheado venció del lado de Viumi
  // (401/403), pide uno nuevo y reintenta una sola vez.
  async function authed(url: string, init: RequestInit): Promise<ApiResult<unknown>> {
    let t = await token();
    if (!t.ok) return t;
    const run = (tk: string) =>
      call(f, url, {
        ...init,
        headers: { Accept: JSONAPI, "Content-Type": JSONAPI, Authorization: `Bearer ${tk}` },
      });
    let r = await run(t.value);
    if (!r.ok && (r.httpStatus === 401 || r.httpStatus === 403)) {
      t = await token(true);
      if (!t.ok) return t;
      r = await run(t.value);
    }
    return r;
  }

  return {
    token,
    async createOrder(input: OrderInput): Promise<ApiResult<CreatedOrder>> {
      let body: ReturnType<typeof buildOrderBody>;
      try {
        body = buildOrderBody(input);
      } catch (e) {
        return { ok: false, httpStatus: 400, detail: e instanceof Error ? e.message : "invalid_amount" };
      }
      const r = await authed(`${base}/api/v2/orders`, { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) return r;
      const parsed = parseOrderResponse(r.value);
      if (!parsed) return { ok: false, httpStatus: 502, detail: "order_without_link" };
      return { ok: true, value: parsed };
    },
    async getOrder(uuid: string): Promise<ApiResult<unknown>> {
      if (!isOrderUuid(uuid)) return { ok: false, httpStatus: 400, detail: "invalid_order" };
      return authed(`${base}/api/v2/orders/${uuid}`, { method: "GET" });
    },
  };
}
