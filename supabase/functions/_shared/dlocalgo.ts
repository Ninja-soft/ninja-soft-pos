// =============================================================================
// dLocal Go · Payments API (ADR-180). Lógica pura compartida por las Edge
// `dlocalgo` y `dlocalgo_webhook` y por `pending_charges_sync` (testeada con
// Vitest en tests/unit/dlocalgo.test.ts). Sin imports: corre igual en Deno y en
// Node. Usa WebCrypto (globalThis.crypto.subtle) para la firma HMAC.
//
// VERIFICADO contra la documentación pública (docs.dlocalgo.com/integration-api,
// leída 2026-10-20; detalle y links en docs/49-dlocal-go.md):
//   * Hosts: https://api-sbx.dlocalgo.com (prueba) y https://api.dlocalgo.com
//     (producción). Cada ambiente tiene su par de claves.
//   * Auth: header "Authorization: Bearer <API_KEY>:<SECRET_KEY>".
//   * Crear: POST /v1/payments { currency*, amount*, country, order_id
//     (≤ 128), description (≤ 100), success_url, back_url, notification_url,
//     ... } → { id: "DP-...", amount, currency, status: "PENDING", order_id,
//     redirect_url, ... }. El redirect_url es el checkout hosted: no es
//     reutilizable y vence a las 24 h.
//   * Consultar: GET /v1/payments/{payment_id} → { id, amount, currency,
//     status: PENDING | PAID | REJECTED | CANCELLED | EXPIRED, order_id, ... }.
//   * Devolver: POST /v1/refunds { payment_id*, amount?, notification_url? }
//     → { id: "REF-...", amount, status: PENDING }. GET /v1/refunds/{id} →
//     status PENDING | SUCCESS | REJECTED | CANCELLED.
//   * Notificación: POST al notification_url con { "payment_id": "..." } y el
//     header "Authorization: V2-HMAC-SHA256, Signature: <hex>", donde la firma
//     es HMAC-SHA256(clave = SECRET_KEY, mensaje = API_KEY + cuerpo crudo).
//     Ante una respuesta distinta de 200 reintenta cada 10 min hasta 30 días.
//   * Errores: 403 3001 credenciales inválidas, 404 4000 pago inexistente,
//     400 5007 monto excedido, 5016 monto muy bajo, 5009 order_id duplicado.
//   * Validar credenciales sin efectos: GET /v1/currency-exchanges.
// INFERIDO (a confirmar con credenciales de prueba):
//   * Cuerpo de la notificación de una devolución (la doc sólo dice que trae
//     el id): se ignora el cuerpo y se re-consulta GET /v1/refunds/{id} con el
//     id que guardamos.
//   * Con country "AR" y currency "ARS" no hay conversión: el monto informado
//     es el mismo del intent.
//
// NUNCA se confía en el cuerpo de la notificación: la firma sólo prueba que
// vino de dLocal Go, y el pago igual se RE-CONSULTA con la credencial del
// negocio. Se acredita sólo si el pago consultado es el guardado en el intent,
// trae el intent como order_id, está PAID, en ARS y con el monto exacto.
// =============================================================================

export type DlocalEnv = "sandbox" | "prod";

export const DLOCALGO_BASE: Record<DlocalEnv, string> = {
  sandbox: "https://api-sbx.dlocalgo.com",
  prod: "https://api.dlocalgo.com",
};

/** La doc no publica un mínimo: el POS no deja crear cobros de menos de $1. */
export const DLOCALGO_MIN_AMOUNT = 1;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Id de pago (DP-54354) o de devolución (REF-213): nada que altere el path.
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

export function isProviderId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

export function dlocalEnv(sandbox: boolean | null | undefined): DlocalEnv {
  return sandbox === true ? "sandbox" : "prod";
}

// ── Conexión del negocio ─────────────────────────────────────────────────────

export type DlocalCreds = { apiKey: string; secretKey: string };

/** payment_secrets provider 'dlocalgo': { api_key, secret_key }. */
export function parseCreds(secrets: unknown): DlocalCreds | null {
  if (!isObj(secrets)) return null;
  const apiKey = str(secrets.api_key);
  const secretKey = str(secrets.secret_key);
  if (!apiKey || !secretKey) return null;
  if (apiKey.length > 200 || secretKey.length > 400) return null;
  // Van juntas en el header Bearer api_key:secret_key.
  if (/[\s:]/.test(apiKey) || /\s/.test(secretKey)) return null;
  return { apiKey, secretKey };
}

export function authHeader(c: DlocalCreds): string {
  return `Bearer ${c.apiKey}:${c.secretKey}`;
}

// ── Montos ───────────────────────────────────────────────────────────────────

export const toCents = (amount: number) => Math.round(Number(amount) * 100);

export type AmountCheck = { ok: true; value: number } | { ok: false; error: "invalid_amount" | "dlocalgo_min_amount" };

export function paymentAmount(amount: number): AmountCheck {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "invalid_amount" };
  const value = toCents(amount) / 100;
  if (value < DLOCALGO_MIN_AMOUNT) return { ok: false, error: "dlocalgo_min_amount" };
  return { ok: true, value };
}

/** ¿El monto que informa dLocal Go es el del intent? (centavos exactos). */
export function amountMatches(reported: unknown, expected: number): boolean | null {
  let n: number | null = null;
  if (typeof reported === "number" && Number.isFinite(reported)) n = reported;
  else if (typeof reported === "string" && /^\d+(\.\d{1,2})?$/.test(reported.trim())) n = Number(reported.trim());
  if (n === null) return null;
  return toCents(n) === toCents(expected);
}

// ── Pago ─────────────────────────────────────────────────────────────────────

export type PaymentInput = {
  amount: number;
  description?: string | null;
  orderId: string;
  successUrl: string;
  backUrl: string;
  notificationUrl: string;
};

export function buildPaymentBody(i: PaymentInput): Record<string, string | number> {
  const a = paymentAmount(i.amount);
  if (!a.ok) throw new Error(a.error);
  const description = (i.description ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || "Venta";
  return {
    currency: "ARS",
    country: "AR",
    amount: a.value,
    order_id: i.orderId,
    description,
    success_url: i.successUrl,
    back_url: i.backUrl,
    notification_url: i.notificationUrl,
  };
}

export type CreatedPayment = { id: string; redirectUrl: string; status: string };

export function parsePaymentResponse(json: unknown): CreatedPayment | null {
  if (!isObj(json)) return null;
  const id = str(json.id);
  const link = str(json.redirect_url);
  if (!id || !isProviderId(id) || !link || !/^https:\/\//i.test(link)) return null;
  return { id, redirectUrl: link, status: (str(json.status) ?? "PENDING").toUpperCase() };
}

/** Código de error de la API (body.code) → código estable de la Edge. */
export function createErrorCode(httpStatus: number, code: string | null): string {
  if (code === "5016") return "dlocalgo_min_amount";
  if (code === "5007") return "dlocalgo_max_amount";
  if (httpStatus === 401 || httpStatus === 403) return "dlocalgo_auth_failed";
  return "dlocalgo_error";
}

// ── Estados ──────────────────────────────────────────────────────────────────

export type IntentStatus = "approved" | "rejected" | "cancelled" | "expired" | "pending";

export function mapDlocalStatus(status: unknown): IntentStatus {
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "PAID") return "approved";
  if (s === "REJECTED") return "rejected";
  if (s === "CANCELLED" || s === "CANCELED") return "cancelled";
  if (s === "EXPIRED") return "expired";
  return "pending";
}

export type Decision = {
  status: IntentStatus;
  state: string;
  reason?: "payment_mismatch" | "reference_mismatch" | "amount_mismatch" | "currency_mismatch" | "amount_not_reported";
};

/**
 * Decide el estado del intent a partir del pago RE-CONSULTADO a dLocal Go.
 * Sólo cuenta si es el pago guardado en el intent y trae el intent como
 * order_id. Si está PAID, tiene que ser en ARS y con el monto exacto.
 */
export function decideIntentUpdate(
  payment: unknown,
  expected: { amount: number; intentId: string; paymentId: string },
): Decision {
  if (!isObj(payment)) return { status: "pending", state: "" };
  const state = (str(payment.status) ?? "").toUpperCase();
  if (str(payment.id) !== expected.paymentId) return { status: "pending", state, reason: "payment_mismatch" };
  if (str(payment.order_id) !== expected.intentId) return { status: "pending", state, reason: "reference_mismatch" };
  const mapped = mapDlocalStatus(state);
  if (mapped !== "approved") return { status: mapped, state };
  if ((str(payment.currency) ?? "").toUpperCase() !== "ARS") {
    return { status: "rejected", state, reason: "currency_mismatch" };
  }
  const m = amountMatches(payment.amount, expected.amount);
  if (m === null) return { status: "pending", state, reason: "amount_not_reported" };
  if (!m) return { status: "rejected", state, reason: "amount_mismatch" };
  return { status: "approved", state };
}

// ── Notificación ─────────────────────────────────────────────────────────────

/** El cuerpo de la notificación es sólo una PISTA: qué pago re-consultar. */
export function parseNotification(body: unknown): { paymentId: string | null; refundId: string | null } {
  if (!isObj(body)) return { paymentId: null, refundId: null };
  const p = str(body.payment_id);
  const r = str(body.refund_id);
  return { paymentId: p && isProviderId(p) ? p : null, refundId: r && isProviderId(r) ? r : null };
}

/** Firma del header Authorization: "V2-HMAC-SHA256, Signature: <hex>". */
export function parseSignatureHeader(header: string | null | undefined): string | null {
  const m = /^\s*V2-HMAC-SHA256\s*,\s*Signature\s*:\s*([0-9a-fA-F]{64})\s*$/.exec(String(header ?? ""));
  return m?.[1] ? m[1].toLowerCase() : null;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await globalThis.crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await globalThis.crypto.subtle.sign("HMAC", k, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Firma esperada: HMAC-SHA256(secret_key, api_key + cuerpo crudo), en hex. */
export function expectedSignature(creds: DlocalCreds, rawBody: string): Promise<string> {
  return hmacHex(creds.secretKey, `${creds.apiKey}${rawBody}`);
}

export async function verifySignature(creds: DlocalCreds, rawBody: string, header: string | null | undefined): Promise<boolean> {
  const got = parseSignatureHeader(header);
  if (!got) return false;
  return timingSafeEqual(got, await expectedSignature(creds, rawBody));
}

// ── Devolución ───────────────────────────────────────────────────────────────

export type RefundState = "initiated" | "refunded" | "failed";

/** Estado de una devolución de dLocal Go → estado local. */
export function mapRefundStatus(status: unknown): RefundState | null {
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "SUCCESS") return "refunded";
  if (s === "PENDING") return "initiated";
  if (s === "REJECTED" || s === "CANCELLED" || s === "CANCELED") return "failed";
  return null;
}

/** Resultado del POST /v1/refunds. */
export function classifyRefundResponse(
  httpStatus: number,
  json: unknown,
): { state: RefundState; code: string | null; ref: string | null } {
  if (httpStatus >= 200 && httpStatus < 300) {
    const ref = isObj(json) ? str(json.id) : null;
    const st = isObj(json) ? mapRefundStatus(json.status) : null;
    return { state: st ?? "initiated", code: st === "failed" ? "refund_rejected" : null, ref: ref && isProviderId(ref) ? ref : null };
  }
  const code = isObj(json) ? (str(json.code) ?? str(json.message)) : null;
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 404) {
    return { state: "failed", code: (code ?? `http_${httpStatus}`).slice(0, 80), ref: null };
  }
  // 401, 429, 5xx o red: dudoso, se puede reintentar.
  return { state: "failed", code: `retry_${httpStatus || "network"}`, ref: null };
}

// ── Llamadas HTTP (fetch inyectable para tests) ──────────────────────────────

export type ApiResult<T> = { ok: true; value: T } | { ok: false; httpStatus: number; detail: string; code: string | null };

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
      const code = isObj(body) ? str(body.code) : null;
      const msg = isObj(body) ? (str(body.message) ?? code) : null;
      // Nunca se devuelve el cuerpo crudo (podría traer datos del comprador).
      return { ok: false, httpStatus: r.status, detail: (msg ?? `http_${r.status}`).slice(0, 160), code };
    }
    if (body === null) return { ok: false, httpStatus: 502, detail: "invalid_json", code: null };
    return { ok: true, value: body };
  } catch (e) {
    return {
      ok: false,
      httpStatus: 0,
      detail: e instanceof Error && e.name === "AbortError" ? "timeout" : "network",
      code: null,
    };
  } finally {
    clearTimeout(t);
  }
}

/** ¿El error es de credenciales? (para el mensaje y para no guardarlas). */
export function isAuthFailure(httpStatus: number): boolean {
  return httpStatus === 401 || httpStatus === 403;
}

export function dlocalgoClient(p: { creds: DlocalCreds; env: DlocalEnv; fetchImpl?: FetchLike }) {
  const f = p.fetchImpl ?? fetch;
  const base = DLOCALGO_BASE[p.env];
  const headers = { Accept: "application/json", "Content-Type": "application/json", Authorization: authHeader(p.creds) };

  return {
    /** Llamada autenticada sin efectos (cotizaciones) para validar la conexión. */
    async probe(): Promise<ApiResult<unknown>> {
      return call(f, `${base}/v1/currency-exchanges`, { method: "GET", headers });
    },
    async createPayment(input: PaymentInput): Promise<ApiResult<CreatedPayment>> {
      let body: Record<string, string | number>;
      try {
        body = buildPaymentBody(input);
      } catch (e) {
        return { ok: false, httpStatus: 400, detail: e instanceof Error ? e.message : "invalid_amount", code: null };
      }
      const r = await call(f, `${base}/v1/payments`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) return r;
      const parsed = parsePaymentResponse(r.value);
      if (!parsed) return { ok: false, httpStatus: 502, detail: "payment_without_link", code: null };
      return { ok: true, value: parsed };
    },
    async getPayment(id: string): Promise<ApiResult<unknown>> {
      if (!isProviderId(id)) return { ok: false, httpStatus: 400, detail: "invalid_payment", code: null };
      return call(f, `${base}/v1/payments/${id}`, { method: "GET", headers });
    },
    async refund(paymentId: string, amount: number, notificationUrl: string): Promise<{ httpStatus: number; body: unknown }> {
      if (!isProviderId(paymentId)) return { httpStatus: 400, body: { code: "invalid_payment" } };
      const a = paymentAmount(amount);
      if (!a.ok) return { httpStatus: 400, body: { code: a.error } };
      const r = await call(f, `${base}/v1/refunds`, {
        method: "POST",
        headers,
        body: JSON.stringify({ payment_id: paymentId, amount: a.value, notification_url: notificationUrl }),
      });
      return r.ok ? { httpStatus: 200, body: r.value } : { httpStatus: r.httpStatus, body: { code: r.code ?? r.detail } };
    },
    async getRefund(id: string): Promise<ApiResult<unknown>> {
      if (!isProviderId(id)) return { ok: false, httpStatus: 400, detail: "invalid_refund", code: null };
      return call(f, `${base}/v1/refunds/${id}`, { method: "GET", headers });
    },
  };
}
