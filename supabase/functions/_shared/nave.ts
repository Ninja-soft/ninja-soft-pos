// =============================================================================
// Nave (Banco Galicia / Naranja X, plataforma Ranty): lógica PURA compartida por
// las Edge Functions `nave` (QR + link), `nave_point` (terminal smart_pos) y
// `nave_webhook`. Sin APIs de Deno ni imports: la importan las Edge con
// "../_shared/nave.ts" y Vitest con "@/supabase/functions/_shared/nave"
// (tests/unit/nave.test.ts). ADR-030.
//
// Contrato (docs oficiales developer-portal-doc-mfe-website-mfe.ranty.io, guía
// "Nave Dynamic QR Integration" V1.1 y la sección Nave Point):
//   * Auth: POST {auth}/security-ms/api/security/auth0/b2b/m2msPrivate
//     { client_id, client_secret, audience } → { access_token, expires_in (s) }.
//     401 en cualquier llamada → descartar token, re-autenticar, reintentar UNA vez.
//   * QR + link: POST {api}/integrations/payment_requests/ecommerce
//     → { id, external_payment_id, checkout_url, qr_data }.
//   * Point:     POST {api}/integrations/payment_requests/smart_pos (al terminal
//     del seller.pos_id) → { id, external_payment_id }.
//   * Consultar: GET {api}/integrations/payment_requests/{id} (fallback) y
//     GET {api}/integrations/payments/{payment_id} (fuente de verdad).
//   * Baja: DELETE {api}/integrations/payment_requests/{id}.
//   * Webhook (URL registrada en el onboarding, no por request):
//     { payment_id, payment_check_url, external_payment_id }. NUNCA se confía
//     en el cuerpo: se valida el host (anti-SSRF) o se construye la URL desde la
//     base confiable, y se acredita sólo con status.name=APPROVED + monto exacto.
// =============================================================================

export type NaveEnv = "sandbox" | "prod";
export type NaveChannel = "qr" | "point";

export const NAVE_AUDIENCE_DEFAULT = "https://naranja.com/ranty/merchants/api";

const AUTH_PATH = "/security-ms/api/security/auth0/b2b/m2msPrivate";

const HOSTS = {
  sandbox: {
    auth: "https://homoservices.apinaranja.com",
    // La guía de QR usa api-sandbox; la de Nave Point documenta e3-api.
    qr: "https://api-sandbox.ranty.io",
    point: "https://e3-api.ranty.io",
    allowed: ["api-sandbox.ranty.io", "e3-api.ranty.io"],
  },
  prod: {
    auth: "https://services.apinaranja.com",
    qr: "https://api.ranty.io",
    point: "https://api.ranty.io",
    allowed: ["api.ranty.io"],
  },
} as const;

export function naveEnv(sandbox: boolean | null | undefined): NaveEnv {
  return sandbox === true ? "sandbox" : "prod";
}

export function naveAuthUrl(env: NaveEnv): string {
  return `${HOSTS[env].auth}${AUTH_PATH}`;
}

export function naveApiBase(env: NaveEnv, channel: NaveChannel): string {
  return HOSTS[env][channel];
}

// Ids de Nave (uuid) o ids propios: sólo caracteres seguros para un path.
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
export function isSafeNaveId(v: unknown): v is string {
  return typeof v === "string" && SAFE_ID.test(v);
}

// Montos: string con dos decimales ("25.00"), como pide la API.
export function formatNaveAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("invalid_amount");
  return (Math.round(amount * 100) / 100).toFixed(2);
}

export type BuildPaymentRequestInput = {
  externalPaymentId: string;
  posId: string;
  amount: number;
  title: string;
  durationSeconds: number;
  callbackUrl?: string;
};

// Body de payment_requests (ecommerce y smart_pos comparten forma). El monto
// autoritativo es transactions[].amount.value; el producto es informativo (un
// único ítem con el total: el POS no detalla la venta a Nave). Sin buyer: los
// opcionales se omiten (nada de placeholders).
export function buildPaymentRequest(input: BuildPaymentRequestInput): Record<string, unknown> {
  const ext = String(input.externalPaymentId ?? "");
  if (ext.length < 1 || ext.length > 36) throw new Error("invalid_external_payment_id");
  if (!String(input.posId ?? "").trim()) throw new Error("invalid_pos_id");
  const value = formatNaveAmount(input.amount);
  const name = (String(input.title ?? "").trim() || "Venta").slice(0, 120);
  const body: Record<string, unknown> = {
    external_payment_id: ext,
    seller: { pos_id: String(input.posId).trim() },
    transactions: [
      {
        amount: { currency: "ARS", value },
        products: [
          {
            name,
            description: name,
            quantity: 1,
            unit_price: { currency: "ARS", value },
          },
        ],
      },
    ],
    duration_time: Math.max(60, Math.round(input.durationSeconds)),
  };
  if (input.callbackUrl) body.additional_info = { callback_url: input.callbackUrl };
  return body;
}

export type NaveNotification =
  | {
      kind: "payment";
      paymentId: string;
      paymentCheckUrl: string;
      externalPaymentId: string;
    }
  | { kind: "payment_request"; paymentRequestId: string; externalPaymentId: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// Notificación de pago ({payment_id, payment_check_url, external_payment_id},
// los tres obligatorios) o de baja de intención de Point ({payment_request_id,
// status, disabled_reason, external_payment_id}). Cualquier otra cosa → null.
export function parseNotification(body: unknown): NaveNotification | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const ext = str(b.external_payment_id);
  if (!ext) return null;
  const paymentId = str(b.payment_id);
  const checkUrl = str(b.payment_check_url);
  if (paymentId && checkUrl) {
    return { kind: "payment", paymentId, paymentCheckUrl: checkUrl, externalPaymentId: ext };
  }
  const prId = str(b.payment_request_id);
  if (prId && !paymentId) {
    return { kind: "payment_request", paymentRequestId: prId, externalPaymentId: ext };
  }
  return null;
}

// URL a consultar para un pago notificado. Opción A de la guía (validación
// estricta: https, host Nave EXACTO del ambiente, sin userinfo/puerto/query/
// fragment, path /integrations/payments/{payment_id} con el mismo id); si no
// valida, opción B: se construye desde la base confiable con el payment_id.
// La URL resultante SIEMPRE apunta a un host Nave del ambiente. payment_id
// inseguro → null (no se llama a nada).
export function resolvePaymentCheckUrl(
  n: { paymentId: string; paymentCheckUrl: string },
  env: NaveEnv,
  channel: NaveChannel,
): string | null {
  if (!isSafeNaveId(n.paymentId)) return null;
  const path = `/integrations/payments/${n.paymentId}`;
  const trusted = `${naveApiBase(env, channel)}${path}`;
  try {
    const u = new URL(n.paymentCheckUrl);
    const allowed = (HOSTS[env].allowed as readonly string[]).includes(u.hostname);
    if (
      u.protocol === "https:" &&
      allowed &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.search &&
      !u.hash &&
      u.pathname === path
    ) {
      return `https://${u.hostname}${path}`;
    }
  } catch {
    /* URL inválida: cae a la base confiable */
  }
  return trusted;
}

export type PaymentOutcome = "approved" | "rejected" | "pending" | "mismatch" | "other";

export type PaymentEvaluation = {
  outcome: PaymentOutcome;
  status: string;
  paymentId: string;
  reasonCode: string | null;
  reasonName: string | null;
  cardType: "debit" | "credit" | null;
  amount: number | null;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);

function statusName(v: unknown): string {
  if (typeof v === "string") return v.toUpperCase();
  const o = obj(v);
  return typeof o?.name === "string" ? o.name.toUpperCase() : "";
}

// Monto de la compra (sin propina) de la transacción PURCHASE (o la primera).
function purchaseAmount(p: Obj): number | null {
  const txs = Array.isArray(p.transactions) ? (p.transactions as unknown[]) : [];
  const list = txs.map(obj).filter(Boolean) as Obj[];
  const tx =
    list.find((t) => String(t.transaction_type ?? "").toUpperCase() === "PURCHASE") ?? list[0];
  const value = obj(tx?.amount)?.value;
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

// Evalúa el Payment devuelto por GET /integrations/payments/{id} (fuente de
// verdad). Sólo APPROVED + correlación (external_payment_id = intent) + monto
// exacto acredita. Sin monto en la respuesta, se exige que el pago pertenezca a
// NUESTRA payment_request (que creamos con el monto exacto y amount cerrado).
// Estados post-pago (CANCELLED/REFUNDED/…) o desconocidos → "other": se
// preservan en auditoría, no se remapean.
export function evaluatePayment(
  payment: unknown,
  expected: { intentId: string; amount: number; paymentRequestId?: string | null },
): PaymentEvaluation {
  const p = obj(payment) ?? {};
  const status = statusName(p.status);
  const st = obj(p.status);
  const pm = obj(p.payment_method);
  const cardRaw = String(pm?.card_type ?? "").toUpperCase();
  const cardType: "debit" | "credit" | null =
    cardRaw === "DEBIT"
      ? "debit"
      : cardRaw === "CREDIT"
        ? "credit"
        : String(pm?.type ?? "").toLowerCase() === "transfer"
          ? "debit"
          : null;
  const amount = purchaseAmount(p);
  const base: Omit<PaymentEvaluation, "outcome"> = {
    status,
    paymentId: typeof p.id === "string" ? p.id : String(p.id ?? ""),
    reasonCode: typeof st?.reason_code === "string" ? st.reason_code : null,
    reasonName: typeof st?.reason_name === "string" ? st.reason_name : null,
    cardType,
    amount: amount !== null && Number.isFinite(amount) ? amount : null,
  };

  if (status === "APPROVED") {
    const ext = p.external_payment_id;
    if (typeof ext === "string" && ext && ext !== expected.intentId) {
      return { ...base, outcome: "mismatch" };
    }
    const prId = obj(p.payment_request)?.id;
    if (
      typeof prId === "string" &&
      prId &&
      expected.paymentRequestId &&
      prId !== expected.paymentRequestId
    ) {
      return { ...base, outcome: "mismatch" };
    }
    if (amount !== null) {
      const ok = Number.isFinite(amount) && Math.abs(amount - Number(expected.amount)) < 0.005;
      return { ...base, outcome: ok ? "approved" : "mismatch" };
    }
    const ours =
      typeof prId === "string" && !!expected.paymentRequestId && prId === expected.paymentRequestId;
    return { ...base, outcome: ours ? "approved" : "mismatch" };
  }
  if (status === "PENDING") return { ...base, outcome: "pending" };
  if (status === "REJECTED") return { ...base, outcome: "rejected" };
  return { ...base, outcome: "other" };
}

// payment_id APROBADO entre los intentos de una payment_request (fallback
// manual cuando el webhook no llegó). Hay que verificarlo igual contra
// GET /payments/{id} antes de acreditar.
export function approvedPaymentIdFromRequest(pr: unknown): string | null {
  const attempts = obj(obj(pr)?.payment_attempts);
  const list = Array.isArray(attempts?.payments) ? (attempts!.payments as unknown[]) : [];
  for (const it of list) {
    const o = obj(it);
    if (o && statusName(o.status) === "APPROVED" && isSafeNaveId(o.payment_id)) {
      return o.payment_id as string;
    }
  }
  return null;
}

export type RequestOutcome = "pending" | "cancelled" | "rejected" | "check_payment";

// Estado de una payment_request (NO es el estado del pago). SUCCESS_PROCESSED
// no acredita por sí solo: obliga a verificar el Payment.
export function paymentRequestOutcome(pr: unknown, channel: NaveChannel): RequestOutcome {
  const s = statusName(obj(pr)?.status);
  if (s === "SUCCESS_PROCESSED") return "check_payment";
  if (s === "EXPIRED" || s === "DISABLED" || s === "BLOCKED") return "cancelled";
  // QR: el cliente puede reintentar con otro medio en la misma intención.
  // Point: la terminal la descarta; hay que crear una nueva.
  if (s === "FAILURE_PROCESSED") return channel === "point" ? "rejected" : "pending";
  return "pending";
}

export type PointTerminal = { id: string; label: string };

// Terminales Nave Point configuradas por el dueño (ids de punto de venta del
// archivo de Nave › Integraciones › Sistema de gestión). Formato libre: un id
// por renglón o separados por coma, opcionalmente "Nombre: id".
export function parsePointTerminals(raw: unknown): PointTerminal[] {
  if (typeof raw !== "string") return [];
  const out: PointTerminal[] = [];
  for (const part of raw.split(/[,\n;]+/)) {
    const s = part.trim();
    if (!s) continue;
    const idx = s.lastIndexOf(":");
    const id = (idx >= 0 ? s.slice(idx + 1) : s).trim();
    const label = (idx >= 0 ? s.slice(0, idx) : "").trim().slice(0, 40);
    if (!isSafeNaveId(id) || out.some((t) => t.id === id)) continue;
    out.push({ id, label: label || `Terminal ${out.length + 1}` });
  }
  return out;
}

// ── Cliente HTTP con token (cache por isolate + 401 → re-auth una vez) ───────

type TokenEntry = { token: string; exp: number };
const MODULE_TOKEN_CACHE = new Map<string, TokenEntry>();

export type NaveClient = {
  request: (method: "GET" | "POST" | "DELETE", url: string, body?: unknown) => Promise<Response>;
};

export function createNaveClient(opts: {
  env: NaveEnv;
  clientId: string;
  clientSecret: string;
  audience?: string | null;
  fetchFn?: typeof fetch;
  tokenCache?: Map<string, TokenEntry>;
}): NaveClient {
  const f = opts.fetchFn ?? fetch;
  const cache = opts.tokenCache ?? MODULE_TOKEN_CACHE;
  const key = `${opts.env}:${opts.clientId}`;

  async function fetchToken(): Promise<string> {
    const r = await f(naveAuthUrl(opts.env), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        audience: opts.audience || NAVE_AUDIENCE_DEFAULT,
      }),
    });
    if (!r.ok) throw new Error("nave_auth_failed");
    const t = (await r.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: string | number;
    } | null;
    if (!t?.access_token) throw new Error("nave_auth_failed");
    const ttl = Number(t.expires_in) || 3600;
    // Se renueva 60 s antes del vencimiento informado.
    cache.set(key, { token: t.access_token, exp: Date.now() + Math.max(0, ttl - 60) * 1000 });
    return t.access_token;
  }

  async function getToken(): Promise<string> {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.token;
    return fetchToken();
  }

  async function call(method: string, url: string, token: string, body?: unknown) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return f(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  return {
    async request(method, url, body) {
      const r = await call(method, url, await getToken(), body);
      if (r.status !== 401) return r;
      cache.delete(key);
      return call(method, url, await fetchToken(), body);
    },
  };
}
