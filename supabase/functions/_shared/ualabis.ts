// =============================================================================
// Ualá Bis · API Cobros Online v2 (ADR-143). Lógica pura compartida por las
// Edge `ualabis` y `ualabis_webhook` y por `pending_charges_sync` (testeada con
// Vitest en tests/unit/ualabis.test.ts). Sin imports: corre igual en Deno y en
// Node. Usa WebCrypto (globalThis.crypto.subtle) sólo para la clave de la
// cache del token.
//
// VERIFICADO contra la documentación pública (developers.ualabis.com.ar/v2,
// leída 2026-10-15; detalle y links en docs/44-uala-bis.md):
//   * Hosts: auth.{stage.}developers.ar.ua.la/v2/api y
//     checkout.{stage.}developers.ar.ua.la/v2/api ("stage" = ambiente de
//     prueba, sin plata real).
//   * Token: POST {auth}/auth/token { username, client_id, client_secret_id,
//     grant_type: "client_credentials" } → { access_token, expires_in (86400),
//     token_type: "Bearer" }.
//   * Orden: POST {checkout}/checkout con Bearer { amount (string, CENTAVOS,
//     "2500" a "999999900"), description, callback_fail, callback_success,
//     notification_url?, external_reference? } → { uuid, amount, status:
//     "PENDING", external_reference, links: { checkout_link, success, failed } }.
//   * Consulta: GET {checkout}/orders/{uuid} → { uuid, amount, status,
//     external_reference, customer, commissions, taxes, changelog, ... }.
//     Estados: PENDING, PROCESSED (pagada, desembolso pendiente), APPROVED
//     (pagada y desembolsada), REJECTED, REFUNDED. Algunos ejemplos de la doc
//     escriben "PROCCESED": se aceptan las dos formas.
//   * Webhook de orden: POST a notification_url { uuid, external_reference,
//     status, created_date, api_version } SIN firma ni header propio. Hay que
//     responder 200; si no, reintenta 3 veces más (4 en total).
//   * Devolución: POST {checkout}/orders/{uuid}/refund { amount,
//     notification_url? } → { status: "INITIATED" }. Sólo órdenes APPROVED, sin
//     otra devolución en curso y dentro de los 90 días. Webhook de devolución
//     { uuid, external_reference, status: REFUNDED | NOT_REFUNDED, ... }.
// INFERIDO (a confirmar con credenciales de prueba):
//   * Unidad de `amount` en la RESPUESTA (la doc muestra 3005 sin aclarar):
//     se acepta como centavos o como pesos, siempre contra el monto del intent.
//   * Devolución parcial: la doc no la menciona; se pide siempre el total, en
//     centavos como la orden.
//
// Como el webhook no viene firmado, NUNCA se confía en su cuerpo: sólo dice
// qué orden re-consultar con la credencial del negocio. Se acredita sólo si la
// orden consultada es la guardada en el intent, trae el intent como
// external_reference, está PROCESSED o APPROVED y el monto coincide.
// =============================================================================

export type UalaEnv = "stage" | "prod";

export const UALABIS_AUTH_BASE: Record<UalaEnv, string> = {
  stage: "https://auth.stage.developers.ar.ua.la/v2/api",
  prod: "https://auth.developers.ar.ua.la/v2/api",
};

export const UALABIS_CHECKOUT_BASE: Record<UalaEnv, string> = {
  stage: "https://checkout.stage.developers.ar.ua.la/v2/api",
  prod: "https://checkout.developers.ar.ua.la/v2/api",
};

/** Límites del monto de una orden, en centavos (doc de "Crear orden"). */
export const UALABIS_MIN_CENTS = 2500;
export const UALABIS_MAX_CENTS = 999_999_900;
/** Monto mínimo en pesos (espejo para la UI: tender minAmount). */
export const UALABIS_MIN_AMOUNT = UALABIS_MIN_CENTS / 100;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Uuid de orden de Ualá: nada que pueda alterar el path.
const ORDER_UUID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function isOrderUuid(v: unknown): v is string {
  return typeof v === "string" && ORDER_UUID_RE.test(v);
}

export function ualabisEnv(sandbox: boolean | null | undefined): UalaEnv {
  return sandbox === true ? "stage" : "prod";
}

// ── Conexión del negocio ─────────────────────────────────────────────────────

export type UalaCreds = { username: string; clientId: string; clientSecret: string };

/** payment_secrets provider 'ualabis': { username, client_id, client_secret_id }. */
export function parseCreds(secrets: unknown): UalaCreds | null {
  if (!isObj(secrets)) return null;
  const username = str(secrets.username);
  const clientId = str(secrets.client_id);
  const clientSecret = str(secrets.client_secret_id);
  if (!username || !clientId || !clientSecret) return null;
  if (username.length > 200 || clientId.length > 200 || clientSecret.length > 400) return null;
  return { username, clientId, clientSecret };
}

// ── Montos ───────────────────────────────────────────────────────────────────

export function toCents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

export type AmountCheck = { ok: true; cents: string } | { ok: false; error: "invalid_amount" | "ualabis_min_amount" | "ualabis_max_amount" };

/** Monto de la orden como string de centavos enteros ("1021" = $10,21). */
export function orderAmount(amount: number): AmountCheck {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "invalid_amount" };
  const cents = toCents(amount);
  if (cents < UALABIS_MIN_CENTS) return { ok: false, error: "ualabis_min_amount" };
  if (cents > UALABIS_MAX_CENTS) return { ok: false, error: "ualabis_max_amount" };
  return { ok: true, cents: String(cents) };
}

/**
 * ¿El monto que informa Ualá es el del intent? La doc no aclara la unidad de
 * la respuesta: vale si coincide como centavos o como pesos.
 */
export function amountMatches(reported: unknown, expected: number): boolean | null {
  let n: number | null = null;
  if (typeof reported === "number" && Number.isFinite(reported)) n = reported;
  else if (typeof reported === "string" && /^\d+(\.\d{1,2})?$/.test(reported.trim())) n = Number(reported.trim());
  if (n === null) return null;
  const cents = toCents(expected);
  if (Number.isInteger(n) && n === cents) return true; // centavos
  return toCents(n) === cents; // pesos
}

// ── Orden ────────────────────────────────────────────────────────────────────

export type OrderInput = {
  amount: number;
  description?: string | null;
  callbackSuccess: string;
  callbackFail: string;
  notificationUrl: string;
  externalReference: string;
};

export function buildOrderBody(i: OrderInput): Record<string, string> {
  const a = orderAmount(i.amount);
  if (!a.ok) throw new Error(a.error);
  const description = (i.description ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Venta";
  return {
    amount: a.cents,
    description,
    callback_success: i.callbackSuccess,
    callback_fail: i.callbackFail,
    notification_url: i.notificationUrl,
    external_reference: i.externalReference,
  };
}

export function parseTokenResponse(json: unknown): { token: string; expiresIn: number } | null {
  if (!isObj(json)) return null;
  const token = str(json.access_token);
  if (!token || token.length > 8192) return null;
  const exp = Number(json.expires_in);
  return { token, expiresIn: Number.isFinite(exp) && exp > 0 ? exp : 3600 };
}

export type CreatedOrder = { uuid: string; checkoutLink: string; status: string };

export function parseOrderResponse(json: unknown): CreatedOrder | null {
  if (!isObj(json)) return null;
  const uuid = str(json.uuid);
  const links = isObj(json.links) ? json.links : {};
  const link = str(links.checkout_link) ?? str(links.checkoutLink);
  if (!uuid || !isOrderUuid(uuid) || !link || !/^https:\/\//i.test(link)) return null;
  return { uuid, checkoutLink: link, status: str(json.status) ?? "PENDING" };
}

// ── Estados ──────────────────────────────────────────────────────────────────

export type IntentStatus = "approved" | "rejected" | "cancelled" | "pending";

/**
 * Estado de la orden → estado del intent. PROCESSED ya es un pago exitoso
 * (falta el desembolso a la cuenta Ualá); REFUNDED sin venta = no se cobra.
 */
export function mapUalaStatus(status: unknown): IntentStatus {
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "APPROVED" || s === "PROCESSED" || s === "PROCCESED") return "approved";
  if (s === "REJECTED") return "rejected";
  if (s === "REFUNDED") return "cancelled";
  return "pending";
}

export type Decision = {
  status: IntentStatus;
  state: string;
  reason?: "reference_mismatch" | "order_mismatch" | "amount_mismatch" | "amount_not_reported";
};

/**
 * Decide el estado del intent a partir de la orden RE-CONSULTADA a Ualá.
 * Sólo cuenta si es la orden guardada en el intent y trae el intent como
 * external_reference. Si está pagada, el monto tiene que coincidir.
 */
export function decideIntentUpdate(
  order: unknown,
  expected: { amount: number; intentId: string; orderUuid: string },
): Decision {
  if (!isObj(order)) return { status: "pending", state: "" };
  const state = str(order.status) ?? "";
  if (str(order.uuid) !== expected.orderUuid) return { status: "pending", state, reason: "order_mismatch" };
  if (str(order.external_reference) !== expected.intentId) {
    return { status: "pending", state, reason: "reference_mismatch" };
  }
  const mapped = mapUalaStatus(state);
  if (mapped !== "approved") return { status: mapped, state };
  const m = amountMatches(order.amount, expected.amount);
  if (m === null) return { status: "pending", state, reason: "amount_not_reported" };
  if (!m) return { status: "rejected", state, reason: "amount_mismatch" };
  return { status: "approved", state };
}

// ── Webhook ──────────────────────────────────────────────────────────────────

export type WebhookHint = { uuid: string; externalReference: string | null; status: string };

/** El cuerpo del webhook es sólo una PISTA: qué orden re-consultar. */
export function parseWebhook(body: unknown): WebhookHint | null {
  if (!isObj(body)) return null;
  const uuid = str(body.uuid);
  if (!uuid || !isOrderUuid(uuid)) return null;
  const ref = str(body.external_reference);
  return {
    uuid,
    externalReference: ref && ref.length <= 80 ? ref : null,
    status: (str(body.status) ?? "").toUpperCase().slice(0, 40),
  };
}

// ── Devolución ───────────────────────────────────────────────────────────────

export type RefundState = "initiated" | "refunded" | "not_refunded" | "failed";

/** Resultado del POST /refund: INITIATED queda esperando el webhook. */
export function classifyRefundResponse(httpStatus: number, json: unknown): { state: RefundState; code: string | null } {
  if (httpStatus >= 200 && httpStatus < 300) {
    const s = isObj(json) ? String(json.status ?? "").toUpperCase() : "";
    if (s === "REFUNDED") return { state: "refunded", code: null };
    return { state: "initiated", code: null };
  }
  const code = isObj(json) ? (str(json.code) ?? str(json.message)) : null;
  // 400 "order is not valid to refund", 403, 404: rechazo definitivo.
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 404) {
    return { state: "failed", code: (code ?? `http_${httpStatus}`).slice(0, 80) };
  }
  // 401 (token), 5xx o red: dudoso, se puede reintentar.
  return { state: "failed", code: `retry_${httpStatus || "network"}` };
}

/** Estado de la devolución a partir de la ORDEN re-consultada. */
export function refundStateFromOrder(order: unknown, hintStatus: string | null): RefundState | null {
  if (!isObj(order)) return null;
  const s = String(order.status ?? "").toUpperCase();
  if (s === "REFUNDED") return "refunded";
  // La orden sigue pagada: sólo el webhook dice que no se pudo devolver.
  if (hintStatus === "NOT_REFUNDED" && (s === "APPROVED" || s === "PROCESSED" || s === "PROCCESED")) {
    return "not_refunded";
  }
  return null;
}

// ── Llamadas HTTP (fetch inyectable para tests) ──────────────────────────────

export type ApiResult<T> = { ok: true; value: T } | { ok: false; httpStatus: number; detail: string };

const TIMEOUT_MS = 15_000;

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
      const msg = isObj(body) ? (str(body.message) ?? str(body.code)) : null;
      // Nunca se devuelve el cuerpo crudo (podría traer datos del comprador).
      return { ok: false, httpStatus: r.status, detail: (msg ?? `http_${r.status}`).slice(0, 160) };
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

// Cache del token entre invocaciones de la misma instancia (vence a las 24 h;
// se renueva 5 minutos antes). La clave es un hash de la credencial: nunca
// guarda el secreto en claro.
type CachedToken = { token: string; until: number };
const TOKEN_CACHE = new Map<string, CachedToken>();
const TOKEN_CACHE_MAX = 200;

async function cacheKey(env: UalaEnv, c: UalaCreds): Promise<string> {
  const data = new TextEncoder().encode(`${env}\n${c.username}\n${c.clientId}\n${c.clientSecret}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sólo para tests. */
export function clearTokenCache() {
  TOKEN_CACHE.clear();
}

export function ualabisClient(p: { creds: UalaCreds; env: UalaEnv; fetchImpl?: FetchLike; now?: () => number }) {
  const f = p.fetchImpl ?? fetch;
  const now = p.now ?? (() => Date.now());
  const auth = UALABIS_AUTH_BASE[p.env];
  const base = UALABIS_CHECKOUT_BASE[p.env];

  async function token(force = false): Promise<ApiResult<string>> {
    const key = await cacheKey(p.env, p.creds);
    const hit = TOKEN_CACHE.get(key);
    if (!force && hit && hit.until > now()) return { ok: true, value: hit.token };
    const r = await call(f, `${auth}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        username: p.creds.username,
        client_id: p.creds.clientId,
        client_secret_id: p.creds.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!r.ok) {
      TOKEN_CACHE.delete(key);
      return r;
    }
    const t = parseTokenResponse(r.value);
    if (!t) return { ok: false, httpStatus: 502, detail: "token_missing" };
    if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.clear();
    TOKEN_CACHE.set(key, { token: t.token, until: now() + Math.max(60, t.expiresIn - 300) * 1000 });
    return { ok: true, value: t.token };
  }

  // Llamada autenticada: si el token cacheado venció del lado de Ualá (401/403),
  // pide uno nuevo y reintenta una sola vez.
  async function authed(url: string, init: RequestInit): Promise<ApiResult<unknown>> {
    let t = await token();
    if (!t.ok) return t;
    const run = (tk: string) =>
      call(f, url, {
        ...init,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${tk}` },
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
      let body: Record<string, string>;
      try {
        body = buildOrderBody(input);
      } catch (e) {
        return { ok: false, httpStatus: 400, detail: e instanceof Error ? e.message : "invalid_amount" };
      }
      const r = await authed(`${base}/checkout`, { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) return r;
      const parsed = parseOrderResponse(r.value);
      if (!parsed) return { ok: false, httpStatus: 502, detail: "order_without_link" };
      return { ok: true, value: parsed };
    },
    async getOrder(uuid: string): Promise<ApiResult<unknown>> {
      if (!isOrderUuid(uuid)) return { ok: false, httpStatus: 400, detail: "invalid_order" };
      return authed(`${base}/orders/${uuid}`, { method: "GET" });
    },
    async refund(
      uuid: string,
      amount: number,
      notificationUrl: string,
    ): Promise<{ httpStatus: number; body: unknown }> {
      if (!isOrderUuid(uuid)) return { httpStatus: 400, body: { code: "invalid_order" } };
      const a = orderAmount(amount);
      if (!a.ok) return { httpStatus: 400, body: { code: a.error } };
      const r = await authed(`${base}/orders/${uuid}/refund`, {
        method: "POST",
        body: JSON.stringify({ amount: a.cents, notification_url: notificationUrl }),
      });
      return r.ok ? { httpStatus: 200, body: r.value } : { httpStatus: r.httpStatus, body: { code: r.detail } };
    },
  };
}
