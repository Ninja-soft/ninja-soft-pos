// =============================================================================
// Mobbex · lógica pura compartida por las Edge `mobbex_create_qr` y
// `mobbex_webhook` (testeada con Vitest en tests/unit/mobbexSandbox.test.ts con
// respuestas REALES de la API demo de mobbex.dev y los ejemplos de su doc).
// Sin imports: corre igual en Deno (Edge) y en Node (tests).
//
// VERIFICADO (credenciales demo públicas, 2026-10-11):
//   * POST /p/checkout → HTTP 200 SIEMPRE; éxito { result:true, data:{ id:'CHK:…',
//     url, warnings? } }; error { result:false, code, error } (p. ej. MRPERR
//     "Parametros obligatorios faltantes"). Montos en pesos con decimales.
//   * Sin `customer` Mobbex avisa "No customer declared … your checkout won't be
//     created on the future". Con customer {email,name,identification} el aviso
//     desaparece (identification "0" aceptado como consumidor final).
//   * `webhooksType` (raíz del body; doc: all | none | final |
//     intermediateAndFinal) aceptado. Con "final" sólo llegan los estados 200,
//     3, 300, 301, 2 + el webhook especial `checkout:expired`.
//   * GET /p/operations/{CHK:…} → 200 { result:false, code:'GENERIC:EFCS' }: el
//     id del checkout NO es una operación. La operación es data.payment.id del
//     webhook (GET /p/operations/{uid} → data.transaction.payment) o se busca por
//     referencia en GET /p/entity/operations?reference= (docs[] con `status`
//     string plano y `uid`).
//   * `installments` documentado = array de referencias de planes de la cuenta
//     Mobbex (["1","3","ahora_12"], "-ref" para ocultar). Nuestro formato
//     {enabled,list:[{months,recharge}]} no existe en la API: NO se envía.
// Códigos (mobbex.dev/codigos-de-estado): 200 Paga · 300 Acreditado · 301
// Liquidado · 0/1 · 2 En espera · 3 Autorizada · 100 En revisión · 210 Retenida
// · 4xx denegada/expirada/abandonada · 6xx cancelada/devuelta.
// =============================================================================

export const MOBBEX_API = "https://api.mobbex.com";
export const MOBBEX_WEBHOOKS_TYPE = "final";
// Consumidor final sin datos: Mobbex exige customer.identification; "0" lo
// acepta (sin warning) y no inventa un DNI real.
export const MOBBEX_PLACEHOLDER_IDENTIFICATION = "0";
export const MOBBEX_PLACEHOLDER_NAME = "Consumidor Final";
export const MOBBEX_PLACEHOLDER_EMAIL = "consumidor.final@pos.soft.ninja";
const AMOUNT_TOLERANCE = 0.01;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Checkout ─────────────────────────────────────────────────────────────────
export type MobbexCustomer = { email: string; name: string; identification: string };

export function mobbexCustomer(
  c: { name?: string | null; email?: string | null; document_number?: string | null } | null,
  fallback: { email?: string | null },
): MobbexCustomer {
  const email = [c?.email, fallback.email].map((e) => str(e)).find((e) => e && EMAIL_RE.test(e));
  const doc = (str(c?.document_number) ?? "").replace(/\D/g, "");
  return {
    email: email ?? MOBBEX_PLACEHOLDER_EMAIL,
    name: (str(c?.name) ?? MOBBEX_PLACEHOLDER_NAME).slice(0, 120),
    identification: doc || MOBBEX_PLACEHOLDER_IDENTIFICATION,
  };
}

export function buildCheckoutBody(p: {
  amount: number;
  reference: string;
  description: string;
  webhookUrl: string;
  customer: MobbexCustomer;
}) {
  return {
    total: Math.round(p.amount * 100) / 100,
    currency: "ARS",
    reference: p.reference,
    description: p.description,
    webhook: p.webhookUrl,
    return_url: p.webhookUrl,
    webhooksType: MOBBEX_WEBHOOKS_TYPE,
    customer: p.customer,
  };
}

export type CheckoutResult =
  | { ok: true; id: string | null; url: string; warnings: string[] }
  | { ok: false; code: string; error: string };

export function parseCheckoutResponse(httpStatus: number, body: unknown): CheckoutResult {
  if (!isObj(body)) return { ok: false, code: `http_${httpStatus}`, error: "respuesta ilegible" };
  if (body.result === false || httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      code: str(body.code) ?? `http_${httpStatus}`,
      error: (str(body.error) ?? str(body.message) ?? "").slice(0, 300),
    };
  }
  const data = isObj(body.data) ? body.data : {};
  const url = str(data.url);
  if (!url) return { ok: false, code: "no_url", error: "checkout sin url" };
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter(isObj).map((w) => `${str(w.type) ?? "warning"}: ${str(w.message) ?? ""}`)
    : [];
  return { ok: true, id: str(data.id), url, warnings };
}

// ── Estados ──────────────────────────────────────────────────────────────────
const APPROVED = new Set([200, 300, 301]);
const PENDING = new Set([0, 1, 2, 3, 100, 210]);

export function mobbexStatus(code: unknown): "approved" | "pending" | "rejected" | null {
  const s = str(code);
  if (s === null || !/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  if (APPROVED.has(n)) return "approved";
  if (PENDING.has(n)) return "pending";
  return "rejected";
}

// ── Operación ────────────────────────────────────────────────────────────────
export type MobbexPayment = {
  id: string | null;
  reference: string | null;
  code: string | null;
  total: number | null;
  requestedTotal: number | null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// Normaliza una operación de cualquiera de las formas documentadas:
// data.transaction.payment (GET /p/operations/{uid}), data.payment (webhook) o
// plana (docs[] del listado, con `status` string y `uid`).
export function pickPayment(data: unknown): MobbexPayment | null {
  if (!isObj(data)) return null;
  const tx = isObj(data.transaction) ? data.transaction : null;
  const candidates: unknown[] = [tx?.payment, data.payment, data];
  for (const c of candidates) {
    if (!isObj(c)) continue;
    if (c.status === undefined && c.total === undefined && c.reference === undefined) continue;
    const status = isObj(c.status) ? c.status.code : c.status;
    const checkout = isObj(c.checkout) ? c.checkout : null;
    return {
      id: str(c.id) ?? str(c.uid),
      reference: str(c.reference) ?? str(checkout?.reference),
      code: str(status),
      total: num(c.total),
      requestedTotal: num(c.requestedTotal),
    };
  }
  return null;
}

export function webhookPaymentId(body: unknown): string | null {
  if (!isObj(body) || !isObj(body.data)) return null;
  const pay = isObj(body.data.payment) ? body.data.payment : null;
  const id = str(pay?.id);
  if (!id || id.toUpperCase().startsWith("CHK:")) return null;
  return id;
}

export function webhookType(body: unknown): string {
  return (isObj(body) && str(body.type)) || "checkout";
}

export function operationLookupUrls(paymentId: string | null, intentId: string): string[] {
  const list = `${MOBBEX_API}/p/entity/operations?page=0&limit=20&reference=${encodeURIComponent(intentId)}`;
  return paymentId ? [`${MOBBEX_API}/p/operations/${encodeURIComponent(paymentId)}`, list] : [list];
}

export function unwrapOperation(body: unknown): MobbexPayment | null {
  if (!isObj(body) || body.result === false) return null;
  return pickPayment(body.data);
}

export function pickOperationFromList(body: unknown, paymentId: string | null): MobbexPayment | null {
  if (!isObj(body) || body.result === false || !isObj(body.data)) return null;
  const docs = Array.isArray(body.data.docs) ? body.data.docs : [];
  const ops = docs.map(pickPayment).filter((p): p is MobbexPayment => p !== null);
  if (!ops.length) return null;
  return (
    (paymentId ? ops.find((o) => o.id === paymentId) : undefined) ??
    ops.find((o) => mobbexStatus(o.code) === "approved") ??
    ops[0] ??
    null
  );
}

// ── Decisión ─────────────────────────────────────────────────────────────────
// status null = no tocar el intent. Un intento fallido mientras el checkout
// sigue abierto NO rechaza (el cliente puede reintentar con otro medio); sólo
// el webhook `checkout:expired` sin pago aprobado cierra el intent.
export function decideMobbex(p: {
  payment: MobbexPayment | null;
  intentId: string;
  expectedAmount: number;
  webhookType: string;
}): { status: "approved" | "pending" | "rejected" | null; reason: string } {
  const expired = p.webhookType === "checkout:expired";
  if (!p.payment) {
    return expired
      ? { status: "rejected", reason: "checkout_expired" }
      : { status: null, reason: "operation_not_found" };
  }
  if (p.payment.reference !== p.intentId) return { status: null, reason: "reference_mismatch" };
  const mapped = mobbexStatus(p.payment.code);
  if (!mapped) return { status: null, reason: "no_status_code" };
  if (mapped === "approved") {
    // requestedTotal = lo que pidió el checkout (si Mobbex suma financiación,
    // `total` incluye ese costo). Sin requestedTotal se usa total.
    const paid = p.payment.requestedTotal ?? p.payment.total;
    if (paid === null || Math.abs(paid - Number(p.expectedAmount)) > AMOUNT_TOLERANCE) {
      return { status: null, reason: "amount_mismatch" };
    }
    return { status: "approved", reason: "approved" };
  }
  if (mapped === "pending") return { status: "pending", reason: "pending" };
  return expired
    ? { status: "rejected", reason: "checkout_expired" }
    : { status: "pending", reason: "attempt_failed_checkout_open" };
}
