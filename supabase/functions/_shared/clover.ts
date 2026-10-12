// =============================================================================
// Clover (Fiserv): lógica PURA compartida por las Edge Functions `clover_point`
// (terminal Clover vía Cloud Pay Display) y `clover_webhook`. Sin APIs de Deno
// ni imports: la importan las Edge con "../_shared/clover.ts" y Vitest con
// "@/supabase/functions/_shared/clover" (tests/unit/clover.test.ts). ADR-047.
//
// Contrato (docs.clover.com, "REST Pay Display API" / Cloud Pay Display):
//   * Base: sandbox https://apisandbox.dev.clover.com (todas las regiones),
//     producción Latinoamérica https://api.la.clover.com. Cloud Pay Display
//     cuelga de {base}/connect.
//   * Headers de cada request: Authorization Bearer (token del comercio),
//     X-Clover-Device-Id (NÚMERO DE SERIE de la terminal), X-POS-Id (libre,
//     identifica al POS) e Idempotency-Key en las operaciones financieras.
//   * Cobro: POST {base}/connect/v1/payments { amount (centavos),
//     externalPaymentId (máx. 32), final } → bloquea hasta que el cliente
//     termina en la terminal y devuelve { payment }. 209 = cancelado,
//     503 = terminal ocupada, 504 = la terminal no respondió a tiempo.
//   * Consultar: GET {base}/connect/v1/payments/external/{externalPaymentId}
//     (fuente de verdad del poll y del webhook).
//   * Cancelar lo que está en curso: PUT {base}/connect/v1/device/reset.
//   * Ping: POST {base}/connect/v1/device/ping → { connected }.
//   * Terminales del comercio: GET {base}/v3/merchants/{mId}/devices
//     → { elements: [{ id, name, model, serial, productName }] }.
//   * Débito o crédito: GET {base}/v3/merchants/{mId}/payments/{id}?expand=tender
//     → tender.labelKey (com.clover.tender.debit_card | ...credit_card).
//   * Argentina: cuotas por regionalExtras.argentina.numInstallments (1 a 99);
//     sin cuotas fijadas, la terminal pregunta.
//   * Token v2/OAuth expiring: POST {base}/oauth/v2/refresh
//     { client_id, refresh_token } → { access_token, refresh_token, ... }.
// =============================================================================

export type CloverEnv = "sandbox" | "prod";

const HOSTS: Record<CloverEnv, string> = {
  sandbox: "https://apisandbox.dev.clover.com",
  prod: "https://api.la.clover.com",
};

export function cloverEnv(sandbox: boolean | null | undefined): CloverEnv {
  return sandbox === true ? "sandbox" : "prod";
}

// Ambiente del intent (mp_payment_intents.mp_env: 'prod' | 'test').
export function cloverEnvFromIntent(mpEnv: string | null | undefined): CloverEnv {
  return mpEnv === "test" ? "sandbox" : "prod";
}

export function intentEnvOf(env: CloverEnv): "prod" | "test" {
  return env === "sandbox" ? "test" : "prod";
}

export function cloverApiBase(env: CloverEnv): string {
  return HOSTS[env];
}

export function cloverConnectBase(env: CloverEnv): string {
  return `${HOSTS[env]}/connect`;
}

export function cloverRefreshUrl(env: CloverEnv): string {
  return `${HOSTS[env]}/oauth/v2/refresh`;
}

// Identificador del POS que viaja en X-POS-Id.
export const CLOVER_POS_ID = "NinjaPos";

// ── Montos ──────────────────────────────────────────────────────────────────
// Pesos (2 decimales) → centavos enteros. null si no es un monto válido.
export function toCents(amount: number): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return cents > 0 ? cents : null;
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

// ── Correlación ─────────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32 = /^[0-9a-f]{32}$/i;

// externalPaymentId admite hasta 32 caracteres: el uuid del intent sin guiones.
export function externalPaymentIdOf(intentId: string): string {
  if (!UUID.test(intentId)) throw new Error("invalid_intent_id");
  return intentId.replace(/-/g, "").toLowerCase();
}

export function intentIdFromExternal(ext: unknown): string | null {
  if (typeof ext !== "string" || !HEX32.test(ext)) return null;
  const h = ext.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Ids de Clover (merchant, payment, serie de terminal): alfanuméricos cortos.
// Se validan antes de armar una URL o un header (anti-inyección).
export function isSafeCloverId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

// ── Request de cobro ────────────────────────────────────────────────────────
export type PayRequest = {
  amount: number;
  externalPaymentId: string;
  final: true;
  regionalExtras?: { argentina: { numInstallments: number } };
};

export function buildPayRequest(opts: {
  intentId: string;
  amountCents: number;
  installments?: number | null;
}): PayRequest {
  if (!Number.isInteger(opts.amountCents) || opts.amountCents <= 0) throw new Error("invalid_amount");
  const body: PayRequest = {
    amount: opts.amountCents,
    externalPaymentId: externalPaymentIdOf(opts.intentId),
    // Venta cerrada (sale): sin preautorización ni ajuste de propina posterior.
    final: true,
  };
  const n = opts.installments;
  if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 99) {
    body.regionalExtras = { argentina: { numInstallments: n } };
  }
  return body;
}

export function cloverHeaders(opts: {
  token: string;
  deviceId?: string | null;
  idempotencyKey?: string | null;
  posId?: string;
}): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "NinjaPos/1.0 (NinjaSoft POS)",
  };
  if (opts.deviceId) {
    h["X-Clover-Device-Id"] = opts.deviceId;
    h["X-POS-Id"] = opts.posId ?? CLOVER_POS_ID;
  }
  if (opts.idempotencyKey) h["Idempotency-Key"] = opts.idempotencyKey;
  return h;
}

// ── Evaluación de un pago ───────────────────────────────────────────────────
export type CloverOutcome = "approved" | "rejected" | "cancelled" | "pending" | "mismatch";

export type CloverEvaluation = {
  outcome: CloverOutcome;
  paymentId: string | null;
  result: string | null;
  amountCents: number | null;
  tipCents: number;
  reason: string | null;
};

type RawPayment = {
  id?: unknown;
  amount?: unknown;
  tipAmount?: unknown;
  result?: unknown;
  externalPaymentId?: unknown;
  voidReason?: unknown;
};

// Desenvuelve { payment } (REST Pay) o el pago directo (API de plataforma).
export function unwrapPayment(body: unknown): RawPayment | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { payment?: unknown };
  if (b.payment && typeof b.payment === "object") return b.payment as RawPayment;
  return body as RawPayment;
}

// Sólo `result = SUCCESS` + externalPaymentId del intent + monto EXACTO (en
// centavos, sin contar la propina) acredita. Nunca se confía en otra cosa.
export function evaluateCloverPayment(
  body: unknown,
  expected: { intentId: string; amount: number },
): CloverEvaluation {
  const p = unwrapPayment(body);
  const base: CloverEvaluation = {
    outcome: "pending",
    paymentId: null,
    result: null,
    amountCents: null,
    tipCents: 0,
    reason: null,
  };
  if (!p) return base;
  const paymentId = isSafeCloverId(p.id) ? p.id : null;
  const result = typeof p.result === "string" ? p.result.toUpperCase() : null;
  const amountCents = typeof p.amount === "number" && Number.isFinite(p.amount) ? Math.round(p.amount) : null;
  const tipCents = typeof p.tipAmount === "number" && Number.isFinite(p.tipAmount) ? Math.round(p.tipAmount) : 0;
  const ev: CloverEvaluation = { ...base, paymentId, result, amountCents, tipCents };

  let ext: string;
  try {
    ext = externalPaymentIdOf(expected.intentId);
  } catch {
    return { ...ev, outcome: "mismatch", reason: "reference_mismatch" };
  }
  if (typeof p.externalPaymentId !== "string" || p.externalPaymentId.toLowerCase() !== ext) {
    return { ...ev, outcome: "mismatch", reason: "reference_mismatch" };
  }

  switch (result) {
    case "SUCCESS":
    // El intento de anular falló: el cobro sigue en pie.
    case "VOID_FAILED": {
      const want = toCents(expected.amount);
      if (want === null || amountCents !== want) {
        return { ...ev, outcome: "mismatch", reason: "amount_mismatch" };
      }
      return { ...ev, outcome: "approved" };
    }
    case "FAIL":
      return { ...ev, outcome: "rejected", reason: "declined" };
    case "VOIDED":
    case "VOIDING":
      return {
        ...ev,
        outcome: "cancelled",
        reason: typeof p.voidReason === "string" ? p.voidReason.toLowerCase() : "voided",
      };
    default:
      // INITIATED, AUTH (autorizado sin capturar) o desconocido: seguir esperando.
      return ev;
  }
}

// Respuesta HTTP del POST /v1/payments que NO trae un pago (errores).
//   209 → el cobro se canceló (en la terminal o por reset).
//   400 / 415 / 501 → request inválido o no soportado: no se reintenta.
//   401 → token inválido o vencido.
//   503 → la terminal está ocupada con otra operación.
//   500 / 504 / red → indeterminado: el poll consulta por externalPaymentId.
export type PayErrorOutcome =
  | { outcome: "cancelled"; reason: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "pending"; reason: string };

export function payErrorOutcome(status: number, body: unknown): PayErrorOutcome {
  const msg =
    body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? String((body as { message: string }).message).slice(0, 120)
      : "";
  if (status === 209) return { outcome: "cancelled", reason: "cancelled_on_device" };
  if (status === 503) return { outcome: "rejected", reason: "device_busy" };
  if (status === 401) return { outcome: "rejected", reason: "clover_auth_failed" };
  if (status === 400 || status === 415 || status === 501) {
    return { outcome: "rejected", reason: msg ? `invalid_request: ${msg}` : "invalid_request" };
  }
  return { outcome: "pending", reason: status ? `indeterminate_${status}` : "indeterminate" };
}

// Débito o crédito según el tender del pago (API de plataforma). null si no
// se puede saber (el POS lo registra como crédito, igual que Mercado Point).
export function cardKindOf(body: unknown): "debit" | "credit" | null {
  if (!body || typeof body !== "object") return null;
  const tender = (body as { tender?: { labelKey?: unknown; label?: unknown } }).tender;
  const key = `${typeof tender?.labelKey === "string" ? tender.labelKey : ""} ${
    typeof tender?.label === "string" ? tender.label : ""
  }`.toLowerCase();
  if (/debit|d[eé]bito/.test(key)) return "debit";
  if (/credit|cr[eé]dito/.test(key)) return "credit";
  return null;
}

// ── Terminales ──────────────────────────────────────────────────────────────
export type CloverDevice = { id: string; label: string };

// Terminales cargadas a mano en la conexión: "Caja 1: C043UQ12345, C043UQ999"
// (el id es el número de serie). Sin etiqueta, la etiqueta es la serie.
export function parseDeviceSerials(raw: unknown): CloverDevice[] {
  if (typeof raw !== "string") return [];
  const out: CloverDevice[] = [];
  for (const part of raw.split(/[,\n;]/)) {
    const t = part.trim();
    if (!t) continue;
    const idx = t.lastIndexOf(":");
    const label = idx > 0 ? t.slice(0, idx).trim() : "";
    const id = (idx > 0 ? t.slice(idx + 1) : t).trim();
    if (!isSafeCloverId(id) || out.some((d) => d.id === id)) continue;
    out.push({ id, label: label || id });
  }
  return out;
}

// GET /v3/merchants/{mId}/devices → terminales con número de serie.
export function parseCloverDevices(body: unknown): CloverDevice[] {
  const els = (body as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(els)) return [];
  const out: CloverDevice[] = [];
  for (const e of els) {
    if (!e || typeof e !== "object") continue;
    const d = e as { serial?: unknown; name?: unknown; productName?: unknown; model?: unknown };
    if (!isSafeCloverId(d.serial) || out.some((x) => x.id === d.serial)) continue;
    const name = [d.name, d.productName, d.model].find((v) => typeof v === "string" && v.trim()) as
      | string
      | undefined;
    out.push({ id: d.serial, label: name ? `${name.trim()} (${d.serial})` : d.serial });
  }
  return out;
}

// Terminales donde el comercio permite cobrar: si cargó series a mano, sólo
// esas (con su etiqueta); si no, todas las que informa Clover.
export function allowedDevices(configured: CloverDevice[], fromApi: CloverDevice[]): CloverDevice[] {
  if (configured.length === 0) return fromApi;
  return configured.map((c) => fromApi.find((a) => a.id === c.id && c.label === c.id) ?? c);
}

// ── Webhook ─────────────────────────────────────────────────────────────────
// Clover manda, por app: { verificationCode } al registrar la URL, y después
// { appId, merchants: { [mId]: [{ objectId: "P:<id>", type, ts }] } }.
export type CloverWebhook =
  | { kind: "verification"; code: string }
  | { kind: "events"; merchants: { merchantId: string; paymentIds: string[] }[] }
  | null;

export function parseCloverWebhook(raw: unknown): CloverWebhook {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { verificationCode?: unknown; merchants?: unknown };
  if (typeof r.verificationCode === "string" && r.verificationCode.length <= 100) {
    return { kind: "verification", code: r.verificationCode };
  }
  if (!r.merchants || typeof r.merchants !== "object") return null;
  const merchants: { merchantId: string; paymentIds: string[] }[] = [];
  for (const [mId, events] of Object.entries(r.merchants as Record<string, unknown>)) {
    if (!isSafeCloverId(mId) || !Array.isArray(events)) continue;
    const ids: string[] = [];
    for (const ev of events) {
      const oid = (ev as { objectId?: unknown } | null)?.objectId;
      if (typeof oid !== "string" || !oid.startsWith("P:")) continue;
      const id = oid.slice(2);
      if (isSafeCloverId(id) && !ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) merchants.push({ merchantId: mId, paymentIds: ids });
  }
  return { kind: "events", merchants };
}

// Comparación de tiempo constante para el header X-Clover-Auth.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
