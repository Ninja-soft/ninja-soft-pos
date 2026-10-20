// =============================================================================
// Talo · cobro por transferencia con CVU / alias único por pago (ADR-175).
// Lógica pura compartida por las Edge `talo`, `talo_webhook` y
// `pending_charges_sync` (testeada con Vitest en tests/unit/talo.test.ts). Sin
// imports: corre igual en Deno y en Node. Usa WebCrypto sólo para la clave de
// la cache del token.
//
// VERIFICADO contra la documentación pública (docs.talo.com.ar, leída
// 2026-10-20; detalle y links en docs/48-talo.md):
//   * Hosts: https://api.talo.com.ar (producción) y
//     https://sandbox-api.talo.com.ar (sandbox, cuenta aparte, con simulador).
//   * Credenciales de un comercio (sin programa de partners): Dashboard >
//     Usuario > Credenciales → client_id + client_secret. Token: POST
//     /users/{user_id}/tokens { client_id, client_secret } → { data: { token:
//     "TL-..." } }. Se usa como Authorization: Bearer. La doc no da su vida útil.
//   * Crear pago: POST /payments/ (público, sin Authorization; user_id en el
//     cuerpo identifica al comercio) { user_id, price: { amount, currency:
//     "ARS" }, payment_options: ["transfer"], external_id?, webhook_url?,
//     redirect_url?, motive? } → { data: { id, payment_status: "PENDING",
//     quotes: [{ cvu, alias }], payment_url, expiration_timestamp } }.
//   * Consultar: GET /payments/{id} (Bearer) → { data: { id, external_id,
//     payment_status, price: { amount, currency }, quotes: [{ address, alias
//     }], payment_url, expiration_timestamp, transaction_fields: { total_paid:
//     { amount }, total_refunded?, net_paid? }, refunds?: [...] } }.
//     Estados: PENDING, SUCCESS (monto exacto), OVERPAID, UNDERPAID, EXPIRED
//     (el CVU vence a los ~5 días).
//   * Webhook: POST a webhook_url { message: "Pago Actualizado", paymentId,
//     externalId } SIN firma (la firma HMAC X-Talo-Signature está "próximamente").
//     La doc pide confirmar siempre con GET /payments/{id} y responder 200 rápido.
//   * Devolución: POST /payments/{id}/refunds (Bearer) { refund_type: "FULL" |
//     "PARTIAL", amount? (string, sólo PARTIAL), currency: "ARS", blame: {
//     team_id, mail } (obligatorio: quién la pide), user_id } → envelope con el
//     PAGO actualizado en data; la devolución nueva es el último de
//     data.refunds[] (refund_status PENDING | SUCCESS | FAILED).
// INFERIDO (a confirmar con credenciales de sandbox):
//   * El cuerpo de creación puede venir con o sin envelope { data }: se aceptan
//     las dos formas (la doc muestra ambas según el endpoint).
//   * Una segunda transferencia al mismo CVU suma a total_paid (UNDERPAID que
//     se completa pasa a SUCCESS u OVERPAID).
//
// Como el webhook no viene firmado, NUNCA se confía en su cuerpo: sólo dice qué
// pago re-consultar con la credencial del negocio. Se acredita sólo si el pago
// consultado es el guardado en el intent, trae el intent como external_id, el
// precio es el del intent y el estado es SUCCESS u OVERPAID.
// =============================================================================

export type TaloEnv = "sandbox" | "prod";

export const TALO_API_BASE: Record<TaloEnv, string> = {
  sandbox: "https://sandbox-api.talo.com.ar",
  prod: "https://api.talo.com.ar",
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Id de pago de Talo ("VAR-<user>-<external_id>"): nada que altere el path.
const PAYMENT_ID_RE = /^[A-Za-z0-9_.:-]{6,200}$/;
// user_id de Talo (uuid en los ejemplos): sólo caracteres seguros para el path.
const USER_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

export function isPaymentId(v: unknown): v is string {
  return typeof v === "string" && PAYMENT_ID_RE.test(v);
}

export function taloEnv(sandbox: boolean | null | undefined): TaloEnv {
  return sandbox === true ? "sandbox" : "prod";
}

// ── Conexión del negocio ─────────────────────────────────────────────────────

/**
 * payment_secrets provider 'talo':
 *   * { user_id, client_id, client_secret } (credenciales del comercio, camino
 *     principal), o
 *   * { user_id, access_token } (token PAR- del programa de partners; queda
 *     listo para cuando NinjaSoft tenga credenciales de partner, ver ADR-175).
 */
export type TaloCreds =
  | { kind: "client"; userId: string; clientId: string; clientSecret: string }
  | { kind: "partner"; userId: string; accessToken: string };

export function parseCreds(secrets: unknown): TaloCreds | null {
  if (!isObj(secrets)) return null;
  const userId = str(secrets.user_id);
  if (!userId || !USER_ID_RE.test(userId)) return null;
  const clientId = str(secrets.client_id);
  const clientSecret = str(secrets.client_secret);
  if (clientId && clientSecret) {
    if (clientId.length > 200 || clientSecret.length > 400) return null;
    return { kind: "client", userId, clientId, clientSecret };
  }
  const token = str(secrets.access_token);
  if (token && token.length <= 4096) return { kind: "partner", userId, accessToken: token };
  return null;
}

// ── Montos ───────────────────────────────────────────────────────────────────

export const toCents = (amount: number): number => Math.round(Number(amount) * 100);
const fromCents = (c: number): number => c / 100;

/** Límite propio (la doc no fija uno): evita montos absurdos por error. */
export const TALO_MAX_AMOUNT = 99_999_999;

export function checkAmount(amount: number): { ok: true; value: number } | { ok: false; error: "invalid_amount" | "talo_max_amount" } {
  if (!Number.isFinite(amount) || amount <= 0 || toCents(amount) < 1) return { ok: false, error: "invalid_amount" };
  if (amount > TALO_MAX_AMOUNT) return { ok: false, error: "talo_max_amount" };
  return { ok: true, value: fromCents(toCents(amount)) };
}

/** "1000.00": formato de amount de la devolución parcial. */
export const amountString = (amount: number): string => fromCents(toCents(amount)).toFixed(2);

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

// ── Pago ─────────────────────────────────────────────────────────────────────

export type PaymentInput = {
  userId: string;
  amount: number;
  externalId: string;
  webhookUrl: string;
  redirectUrl?: string | null;
  motive?: string | null;
};

export function buildPaymentBody(i: PaymentInput): Obj {
  const a = checkAmount(i.amount);
  if (!a.ok) throw new Error(a.error);
  const body: Obj = {
    user_id: i.userId,
    price: { amount: a.value, currency: "ARS" },
    payment_options: ["transfer"],
    external_id: i.externalId,
    webhook_url: i.webhookUrl,
  };
  if (i.redirectUrl) body.redirect_url = i.redirectUrl;
  const motive = (i.motive ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (motive) body.motive = motive;
  return body;
}

/** Desenvuelve { data } cuando viene con el envelope de la API. */
export function unwrap(json: unknown): Obj | null {
  if (!isObj(json)) return null;
  if (isObj(json.data)) return json.data;
  return json;
}

export type TransferInfo = { cvu: string | null; alias: string | null };

/** CVU y alias del pago: quotes[0].cvu (al crear) o quotes[0].address (GET). */
export function transferInfo(payment: unknown): TransferInfo {
  const p = unwrap(payment);
  const q = p && Array.isArray(p.quotes) && isObj(p.quotes[0]) ? (p.quotes[0] as Obj) : null;
  const cvu = q ? (str(q.cvu) ?? str(q.address)) : null;
  const alias = q ? str(q.alias) : null;
  return {
    cvu: cvu && /^\d{22}$/.test(cvu) ? cvu : null,
    alias: alias && /^[A-Za-z0-9._-]{3,40}$/.test(alias) ? alias : null,
  };
}

export function paymentUrlOf(payment: unknown): string | null {
  const p = unwrap(payment);
  if (!p) return null;
  const ui = isObj(p.user_info) ? p.user_info : {};
  const url = str(p.payment_url) ?? str(ui.payment_url);
  return url && /^https:\/\//i.test(url) && url.length < 600 ? url : null;
}

export function expirationOf(payment: unknown): string | null {
  const p = unwrap(payment);
  if (!p) return null;
  const ui = isObj(p.user_info) ? p.user_info : {};
  const t = str(p.expiration_timestamp) ?? str(ui.expiration_timestamp);
  return t && Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : null;
}

export type CreatedPayment = {
  id: string;
  paymentUrl: string | null;
  cvu: string | null;
  alias: string | null;
  expiresAt: string | null;
};

export function parseCreatedPayment(json: unknown): CreatedPayment | null {
  const p = unwrap(json);
  if (!p) return null;
  const id = str(p.id);
  if (!id || !isPaymentId(id)) return null;
  const t = transferInfo(p);
  const paymentUrl = paymentUrlOf(p);
  // Sin CVU ni link no hay forma de que el cliente pague.
  if (!t.cvu && !t.alias && !paymentUrl) return null;
  return { id, paymentUrl, cvu: t.cvu, alias: t.alias, expiresAt: expirationOf(p) };
}

export function parseTokenResponse(json: unknown): string | null {
  const d = unwrap(json);
  const token = d ? str(d.token) : null;
  return token && token.length <= 8192 ? token : null;
}

/** Vencimiento del token si es un JWT (TL-<jwt>); si no, null. */
export function tokenExpiry(token: string): number | null {
  const jwt = token.replace(/^[A-Z]{2,4}-/, "");
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// ── Estados ──────────────────────────────────────────────────────────────────

export type IntentStatus = "approved" | "rejected" | "cancelled" | "pending";

export type PaymentFacts = {
  state: string;
  /** Total recibido según Talo (transaction_fields.total_paid), si lo informa. */
  paid: number | null;
  /** Total devuelto (transaction_fields.total_refunded), si lo informa. */
  refunded: number | null;
};

export function paymentFacts(payment: unknown): PaymentFacts {
  const p = unwrap(payment);
  if (!p) return { state: "", paid: null, refunded: null };
  const tf = isObj(p.transaction_fields) ? p.transaction_fields : {};
  const tp = isObj(tf.total_paid) ? tf.total_paid : null;
  const tr = isObj(tf.total_refunded) ? tf.total_refunded : null;
  return {
    state: (str(p.payment_status) ?? "").toUpperCase().slice(0, 40),
    paid: tp ? num(tp.amount) : null,
    refunded: tr ? num(tr.amount) : null,
  };
}

export type Decision = {
  status: IntentStatus;
  state: string;
  /** Monto recibido (pesos) cuando Talo lo informa. */
  paid: number | null;
  /** Diferencia a favor del cliente (OVERPAID) o faltante (UNDERPAID), en pesos. */
  overpaid?: number;
  missing?: number;
  reason?: "reference_mismatch" | "payment_mismatch" | "amount_mismatch";
};

/**
 * Decide el estado del intent a partir del pago RE-CONSULTADO a Talo. Sólo
 * cuenta si es el pago guardado en el intent, trae el intent como external_id
 * y su precio es el del intent.
 *   SUCCESS → approved · OVERPAID → approved (con la diferencia a devolver) ·
 *   UNDERPAID → sigue pending (con lo que falta) · EXPIRED → cancelled.
 */
export function decideIntentUpdate(
  payment: unknown,
  expected: { amount: number; intentId: string; paymentId: string },
): Decision {
  const p = unwrap(payment);
  if (!p) return { status: "pending", state: "", paid: null };
  const f = paymentFacts(p);
  const base = { state: f.state, paid: f.paid };
  if (str(p.id) !== expected.paymentId) return { status: "pending", ...base, reason: "payment_mismatch" };
  if (str(p.external_id) !== expected.intentId) return { status: "pending", ...base, reason: "reference_mismatch" };

  const price = isObj(p.price) ? num(p.price.amount) : null;
  const currency = isObj(p.price) ? (str(p.price.currency) ?? "ARS").toUpperCase() : "ARS";
  const want = toCents(expected.amount);
  const priceOk = price !== null && toCents(price) === want && currency === "ARS";
  const paidC = f.paid === null ? null : toCents(f.paid);

  switch (f.state) {
    case "SUCCESS":
      if (!priceOk || (paidC !== null && paidC !== want)) {
        return { status: "rejected", ...base, reason: "amount_mismatch" };
      }
      return { status: "approved", ...base };
    case "OVERPAID":
      if (!priceOk || (paidC !== null && paidC <= want)) {
        return { status: "rejected", ...base, reason: "amount_mismatch" };
      }
      return {
        status: "approved",
        ...base,
        ...(paidC !== null ? { overpaid: fromCents(paidC - want) } : {}),
      };
    case "UNDERPAID":
      if (!priceOk) return { status: "rejected", ...base, reason: "amount_mismatch" };
      return {
        status: "pending",
        ...base,
        ...(paidC !== null && paidC < want ? { missing: fromCents(want - paidC) } : {}),
      };
    case "EXPIRED":
      return { status: "cancelled", ...base };
    default:
      return { status: "pending", ...base };
  }
}

// ── Webhook ──────────────────────────────────────────────────────────────────

export type WebhookHint = { paymentId: string; externalId: string | null };

/** El cuerpo del webhook es sólo una PISTA: qué pago re-consultar. */
export function parseWebhook(body: unknown): WebhookHint | null {
  if (!isObj(body)) return null;
  const paymentId = str(body.paymentId) ?? str(body.payment_id);
  if (!paymentId || !isPaymentId(paymentId)) return null;
  const ext = str(body.externalId) ?? str(body.external_id);
  return { paymentId, externalId: ext && ext.length <= 80 ? ext : null };
}

// ── Devolución ───────────────────────────────────────────────────────────────

export type RefundState = "initiated" | "refunded" | "failed";

export type RefundPlan =
  | { ok: true; type: "FULL" | "PARTIAL"; amount: number }
  | { ok: false; error: "nothing_to_refund" | "no_excess" | "not_paid" };

/**
 * Qué devolver según el pago re-consultado:
 *   * "full": todo lo cobrado que queda sin devolver (FULL si no hubo otra
 *     devolución; si hubo, PARTIAL por el saldo).
 *   * "excess": sólo la diferencia de un OVERPAID (PARTIAL), menos lo ya devuelto.
 */
export function planRefund(payment: unknown, kind: "full" | "excess", intentAmount: number): RefundPlan {
  const f = paymentFacts(payment);
  if (f.paid === null || toCents(f.paid) <= 0) return { ok: false, error: "not_paid" };
  const paid = toCents(f.paid);
  const refunded = Math.max(0, toCents(f.refunded ?? 0));
  if (kind === "excess") {
    const excess = paid - toCents(intentAmount) - refunded;
    if (excess <= 0) return { ok: false, error: "no_excess" };
    return { ok: true, type: "PARTIAL", amount: fromCents(excess) };
  }
  const left = paid - refunded;
  if (left <= 0) return { ok: false, error: "nothing_to_refund" };
  return refunded > 0 ? { ok: true, type: "PARTIAL", amount: fromCents(left) } : { ok: true, type: "FULL", amount: fromCents(left) };
}

export function buildRefundBody(p: {
  type: "FULL" | "PARTIAL";
  amount: number;
  userId: string;
  blameMail: string;
}): Obj {
  const body: Obj = {
    refund_type: p.type,
    currency: "ARS",
    // blame es obligatorio: identifica al equipo y a la persona que la pide.
    blame: { team_id: "ninjasoft-pos", mail: p.blameMail.slice(0, 200) },
    user_id: p.userId,
  };
  if (p.type === "PARTIAL") body.amount = amountString(p.amount);
  return body;
}

/** Última devolución del pago (la recién creada es la última de refunds[]). */
export function lastRefund(payment: unknown): { status: string; ref: string | null } | null {
  const p = unwrap(payment);
  const list = p && Array.isArray(p.refunds) ? p.refunds.filter(isObj) : [];
  const r = list[list.length - 1] as Obj | undefined;
  if (!r) return null;
  const ids = Array.isArray(r.transaction_ids) ? r.transaction_ids : [];
  const ref = str(ids[0]) ?? str(r.creation_timestamp);
  return { status: (str(r.refund_status) ?? "").toUpperCase(), ref: ref ? ref.slice(0, 120) : null };
}

/** Estado de una devolución buscada por su referencia en refunds[]. */
export function refundStatusByRef(payment: unknown, ref: string): RefundState | null {
  const p = unwrap(payment);
  const list = p && Array.isArray(p.refunds) ? p.refunds.filter(isObj) : [];
  for (const r of list as Obj[]) {
    const ids = Array.isArray(r.transaction_ids) ? r.transaction_ids.map(str) : [];
    if (ids.includes(ref) || str(r.creation_timestamp) === ref) {
      return mapRefundStatus(r.refund_status);
    }
  }
  return null;
}

export function mapRefundStatus(s: unknown): RefundState {
  const v = String(s ?? "").toUpperCase();
  if (v === "SUCCESS") return "refunded";
  if (v === "FAILED") return "failed";
  return "initiated";
}

/** Resultado del POST /refunds. */
export function classifyRefundResponse(
  httpStatus: number,
  json: unknown,
): { state: RefundState; code: string | null; ref: string | null } {
  if (httpStatus >= 200 && httpStatus < 300) {
    const last = lastRefund(json);
    if (!last) return { state: "initiated", code: null, ref: null };
    const state = mapRefundStatus(last.status);
    return { state, code: state === "failed" ? "talo_refund_failed" : null, ref: last.ref };
  }
  const msg = isObj(json) ? (str(json.message) ?? str(json.code)) : null;
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 401 && httpStatus !== 408 && httpStatus !== 429) {
    return { state: "failed", code: (msg ?? `http_${httpStatus}`).slice(0, 80), ref: null };
  }
  // 401 (token), 5xx o red: dudoso, se puede reintentar.
  return { state: "failed", code: `retry_${httpStatus || "network"}`, ref: null };
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
      // Nunca se devuelve el cuerpo crudo (puede traer datos del que transfirió).
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
  return httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 404;
}

// Cache del token entre invocaciones de la misma instancia. La doc no dice la
// vida útil: se usa el exp del JWT si viene (renovado 2 minutos antes) y, si
// no, 10 minutos. Un 401 fuerza uno nuevo. La clave es un hash de la
// credencial: nunca guarda el secreto en claro.
type CachedToken = { token: string; until: number };
const TOKEN_CACHE = new Map<string, CachedToken>();
const TOKEN_CACHE_MAX = 200;
const DEFAULT_TOKEN_MS = 10 * 60_000;

async function cacheKey(env: TaloEnv, c: TaloCreds): Promise<string> {
  const raw = c.kind === "client" ? `${c.clientId}\n${c.clientSecret}` : c.accessToken;
  const data = new TextEncoder().encode(`${env}\n${c.userId}\n${raw}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sólo para tests. */
export function clearTokenCache() {
  TOKEN_CACHE.clear();
}

export function taloClient(p: { creds: TaloCreds; env: TaloEnv; fetchImpl?: FetchLike; now?: () => number }) {
  const f = p.fetchImpl ?? fetch;
  const now = p.now ?? (() => Date.now());
  const base = TALO_API_BASE[p.env];
  const creds = p.creds;

  async function token(force = false): Promise<ApiResult<string>> {
    if (creds.kind === "partner") return { ok: true, value: creds.accessToken };
    const key = await cacheKey(p.env, creds);
    const hit = TOKEN_CACHE.get(key);
    if (!force && hit && hit.until > now()) return { ok: true, value: hit.token };
    const r = await call(f, `${base}/users/${encodeURIComponent(creds.userId)}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret }),
    });
    if (!r.ok) {
      TOKEN_CACHE.delete(key);
      return r;
    }
    const t = parseTokenResponse(r.value);
    if (!t) return { ok: false, httpStatus: 502, detail: "token_missing" };
    const exp = tokenExpiry(t);
    const until = exp ? Math.max(now() + 60_000, exp - 120_000) : now() + DEFAULT_TOKEN_MS;
    if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.clear();
    TOKEN_CACHE.set(key, { token: t, until });
    return { ok: true, value: t };
  }

  // Llamada autenticada: si el token cacheado venció del lado de Talo (401),
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
    if (!r.ok && r.httpStatus === 401 && creds.kind === "client") {
      t = await token(true);
      if (!t.ok) return t;
      r = await run(t.value);
    }
    return r;
  }

  return {
    token,
    async createPayment(input: Omit<PaymentInput, "userId">): Promise<ApiResult<CreatedPayment>> {
      let body: Obj;
      try {
        body = buildPaymentBody({ ...input, userId: creds.userId });
      } catch (e) {
        return { ok: false, httpStatus: 400, detail: e instanceof Error ? e.message : "invalid_amount" };
      }
      // Endpoint público (la doc: sin Authorization).
      const r = await call(f, `${base}/payments/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) return r;
      const parsed = parseCreatedPayment(r.value);
      if (!parsed) return { ok: false, httpStatus: 502, detail: "payment_without_cvu" };
      return { ok: true, value: parsed };
    },
    async getPayment(id: string): Promise<ApiResult<unknown>> {
      if (!isPaymentId(id)) return { ok: false, httpStatus: 400, detail: "invalid_payment" };
      return authed(`${base}/payments/${encodeURIComponent(id)}`, { method: "GET" });
    },
    async refund(id: string, body: Obj): Promise<{ httpStatus: number; body: unknown }> {
      if (!isPaymentId(id)) return { httpStatus: 400, body: { code: "invalid_payment" } };
      const r = await authed(`${base}/payments/${encodeURIComponent(id)}/refunds`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return r.ok ? { httpStatus: 200, body: r.value } : { httpStatus: r.httpStatus, body: { message: r.detail } };
    },
  };
}
