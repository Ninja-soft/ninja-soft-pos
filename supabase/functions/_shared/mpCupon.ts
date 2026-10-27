// =============================================================================
// _shared/mpCupon.ts · cupones de pago en efectivo (Rapipago / Pago Fácil) con
// la Orders API de Mercado Pago (ADR-180). Lógica PURA (sin imports ni APIs de
// Deno): la usa la Edge `mp_cupon` y la testea Vitest (tests/unit/mpCupon.test.ts).
//
// VERIFICADO contra la doc de Checkout API vía Orders, "Rapipago y Pago Fácil"
// (mercadopago.com.ar/developers/es/docs/checkout-api-orders/payment-integration/
// rapipago-pagofacil, leída 2026-10-20):
//   * POST /v1/orders con X-Idempotency-Key { type: "online", processing_mode:
//     "automatic", total_amount (string), external_reference, payer: { email*,
//     first_name, last_name, identification: { type*, number* } },
//     transactions: { payments: [{ amount, expiration_time (ISO 8601, 1 a 30
//     días; recomiendan P3D), payment_method: { id: rapipago | pagofacil,
//     type: "ticket" } }] } }. En modo automatic NO va expiration_time a nivel
//     order.
//   * La creación es asíncrona: la order puede volver "processing" sin datos.
//     Después queda status "action_required" / status_detail "waiting_payment"
//     y el pago trae payment_method.{ ticket_url, barcode_content, reference,
//     verification_code }.
//   * Se sigue por el webhook topic Order (mp_orders_webhook) o GET
//     /v1/orders/{id}. Un pago action_required se puede cancelar.
// INFERIDO: el estado final de un cupón pagado es el de cualquier order online
// acreditada (processed / accredited), que resolveOrder ya acredita con monto
// exacto y external_reference. La doc dice que barcode_content es "EAN-13",
// pero el ejemplo trae 46 dígitos: el POS no dibuja el código, muestra el
// número y el cupón oficial de Mercado Pago (ticket_url).
// =============================================================================

export type CuponMethod = "rapipago" | "pagofacil";
export const CUPON_METHODS: readonly CuponMethod[] = ["rapipago", "pagofacil"];
/** Vencimiento del cupón (lo que recomienda la doc). Espejo del tope de cobros en espera. */
export const CUPON_EXPIRATION = "P3D";
export const CUPON_EXPIRATION_DAYS = 3;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

export function isCuponMethod(v: unknown): v is CuponMethod {
  return v === "rapipago" || v === "pagofacil";
}

// ── Pagador ──────────────────────────────────────────────────────────────────

export type CuponPayer = {
  email: string;
  firstName: string;
  lastName: string;
  docType: "DNI" | "CUIT" | "CUIL";
  docNumber: string;
};

export type PayerError = "payer_email_invalid" | "payer_doc_invalid" | "payer_name_invalid";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

/** "Juan Carlos Pérez" → { first: "Juan Carlos", last: "Pérez" }. */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (parts.length < 2) return { first: parts[0] ?? "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] ?? "" };
}

/**
 * Normaliza y valida al pagador. El documento acepta DNI (7 u 8 dígitos) o
 * CUIT / CUIL (11 dígitos), con o sin guiones o puntos.
 */
export function parsePayer(input: {
  email?: unknown;
  name?: unknown;
  doc_type?: unknown;
  doc_number?: unknown;
}): { ok: true; payer: CuponPayer } | { ok: false; error: PayerError } {
  const email = (str(input.email) ?? "").toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: "payer_email_invalid" };
  const digits = (str(input.doc_number) ?? "").replace(/[\s.-]/g, "");
  if (!/^\d+$/.test(digits)) return { ok: false, error: "payer_doc_invalid" };
  let docType: CuponPayer["docType"];
  const wanted = String(input.doc_type ?? "").toUpperCase();
  if (digits.length === 7 || digits.length === 8) docType = "DNI";
  else if (digits.length === 11) docType = wanted === "CUIL" ? "CUIL" : "CUIT";
  else return { ok: false, error: "payer_doc_invalid" };
  const name = (str(input.name) ?? "").slice(0, 120);
  const { first, last } = splitName(name);
  if (!first || !last) return { ok: false, error: "payer_name_invalid" };
  return {
    ok: true,
    payer: { email, firstName: first.slice(0, 60), lastName: last.slice(0, 60), docType, docNumber: digits },
  };
}

// ── Order ────────────────────────────────────────────────────────────────────

const amountString = (n: number) => (Math.round(Number(n) * 100) / 100).toFixed(2);

export function buildCuponOrderBody(p: {
  intentId: string;
  amount: number;
  method: CuponMethod;
  payer: CuponPayer;
  description?: string | null;
}) {
  const amount = amountString(p.amount);
  return {
    type: "online",
    processing_mode: "automatic",
    total_amount: amount,
    external_reference: p.intentId,
    description: (p.description || "Venta NinjaPos").replace(/\s+/g, " ").trim().slice(0, 150),
    payer: {
      email: p.payer.email,
      first_name: p.payer.firstName,
      last_name: p.payer.lastName,
      identification: { type: p.payer.docType, number: p.payer.docNumber },
    },
    transactions: {
      payments: [
        {
          amount,
          expiration_time: CUPON_EXPIRATION,
          payment_method: { id: p.method, type: "ticket" },
        },
      ],
    },
  };
}

export type Voucher = {
  payment_method: CuponMethod;
  ticket_url: string;
  barcode_content: string | null;
  reference: string | null;
  verification_code: string | null;
  expires_at: string | null;
};

/**
 * Datos del cupón de una order (respuesta del POST o GET /v1/orders/{id}).
 * null mientras la order sigue "processing" (sin ticket_url todavía).
 */
export function parseVoucher(order: unknown, createdAt: Date = new Date()): Voucher | null {
  if (!isObj(order)) return null;
  const tx = isObj(order.transactions) ? order.transactions : {};
  const pays = Array.isArray(tx.payments) ? tx.payments : [];
  for (const p of pays) {
    if (!isObj(p) || !isObj(p.payment_method)) continue;
    const pm = p.payment_method;
    const method = str(pm.id);
    const ticket = str(pm.ticket_url);
    if (!isCuponMethod(method) || !ticket || !/^https:\/\/[^\s]+$/i.test(ticket) || ticket.length > 1000) continue;
    const barcode = str(pm.barcode_content);
    const exp = str(p.date_of_expiration) ?? str(p.expiration_date);
    const expMs = exp ? Date.parse(exp) : Number.NaN;
    return {
      payment_method: method,
      ticket_url: ticket,
      barcode_content: barcode && /^\d{6,80}$/.test(barcode) ? barcode : null,
      reference: (str(pm.reference) ?? "").slice(0, 60) || null,
      verification_code: (str(pm.verification_code) ?? "").slice(0, 60) || null,
      // La doc no devuelve la fecha: se calcula con el vencimiento pedido.
      expires_at: Number.isFinite(expMs)
        ? new Date(expMs).toISOString()
        : new Date(createdAt.getTime() + CUPON_EXPIRATION_DAYS * 86_400_000).toISOString(),
    };
  }
  return null;
}

/**
 * Resumen del error de la Orders API para la auditoría: sólo códigos y
 * mensajes de `errors[]` (o `error` / `message`), recortados. Nunca el cuerpo
 * entero ni headers.
 */
export function mpErrorSummary(detail: string): { code: string | null; message: string | null } {
  let body: unknown = null;
  try {
    body = JSON.parse(detail);
  } catch {
    return { code: null, message: detail.replace(/\s+/g, " ").trim().slice(0, 200) || null };
  }
  if (!isObj(body)) return { code: null, message: null };
  const errs = Array.isArray(body.errors) ? body.errors.filter(isObj) : [];
  const codes = errs.map((e) => str(e.code)).filter(Boolean);
  const msgs = errs.map((e) => str(e.message) ?? str(e.details)).filter(Boolean);
  const code = (codes.join(",") || str(body.error) || str(body.code) || "").slice(0, 120) || null;
  const message = (msgs.join(" | ") || str(body.message) || "").slice(0, 200) || null;
  return { code, message };
}

/** Error de la Orders API → código estable para el POS. */
export function cuponErrorCode(httpStatus: number, detail: string): string {
  const d = detail.toLowerCase();
  // 401 = token inválido o vencido. 403 = el token vale pero la cuenta o la
  // aplicación no tiene permiso para órdenes online (no es "reconectá").
  if (httpStatus === 401 || (httpStatus === 403 && /invalid[_ ]token|expired/.test(d))) return "mp_cupon_auth_failed";
  if (httpStatus === 403) return "mp_cupon_forbidden";
  if (d.includes("identification") || d.includes("payer")) return "mp_cupon_payer_rejected";
  if (d.includes("amount")) return "mp_cupon_amount_rejected";
  if (d.includes("payment_method")) return "mp_cupon_method_unavailable";
  return "mp_error";
}
