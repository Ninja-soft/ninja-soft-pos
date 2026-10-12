// =============================================================================
// Payway (ex Decidir) · lógica pura compartida por las Edge `payway`,
// `payway_checkout` y `payway_webhook` (testeada con Vitest en
// tests/unit/paywaySandbox.test.ts con respuestas REALES del sandbox público).
// Sin imports: corre igual en Deno (Edge) y en Node (tests).
//
// VERIFICADO en el sandbox público (developers.decidir.com, 2026-10-11):
//   * POST {v2}/tokens (apikey PÚBLICA) → 201 { id, bin, … }; datos inválidos →
//     400 { error_type:'invalid_request_error', validation_errors:[{code,param}] }
//     (p. ej. {code:'CardData', param:'expired card'}).
//   * POST {v2}/payments (apikey PRIVADA), amount entero en CENTAVOS:
//       - 201 { id (número), site_transaction_id, amount, status:'approved' }
//       - 402 { id, status:'rejected', status_details.error.reason.description }
//       - 404 { error_type:'not_found_error', entity_name:'OperationResource' }
//         (token inexistente) · 400 validation_errors [{code:'repeated',
//         param:'token'}] (token reusado) · 400 { error_type:'api_error',
//         message } (falla interna del gateway).
//     Sólo `status:'rejected'` es un rechazo del emisor; el resto son errores
//     de request/gateway y NO deben mostrarse como "tarjeta rechazada".
//   * GET {v2}/payments/{id} → mismo cuerpo que el 201 (amount en centavos);
//     id inexistente → 404 not_found_error.
// =============================================================================

export const PAYWAY_V2 = {
  sandbox: "https://developers.decidir.com/api/v2",
  prod: "https://ventasonline.payway.com.ar/api/v2",
} as const;

export const paywayV2Base = (sandbox: unknown): string =>
  sandbox === true ? PAYWAY_V2.sandbox : PAYWAY_V2.prod;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ── Marcas → payment_method_id ───────────────────────────────────────────────
// verified:
//   sandbox_approved → cobro aprobado en el sandbox con la tarjeta de prueba.
//   sandbox_accepted → el sandbox aceptó el id con la tarjeta de la marca (el
//                      emisor de prueba respondió; no hubo aprobación).
//   docs             → id de la tabla pública de Decidir, SIN verificar en
//                      sandbox (Mastercard: el sandbox respondió api_error de
//                      3DS). Confirmar con el primer cobro real.
export type PaywayBrand = {
  key: string;
  label: string;
  methodId: number;
  debit: boolean;
  verified: "sandbox_approved" | "sandbox_accepted" | "docs";
};
export const PAYWAY_BRANDS: readonly PaywayBrand[] = [
  { key: "visa", label: "Visa", methodId: 1, debit: false, verified: "sandbox_approved" },
  { key: "visa_debito", label: "Visa Débito", methodId: 31, debit: true, verified: "sandbox_approved" },
  { key: "master", label: "Mastercard", methodId: 104, debit: false, verified: "docs" },
  { key: "maestro", label: "Maestro", methodId: 106, debit: true, verified: "docs" },
  { key: "cabal", label: "Cabal", methodId: 63, debit: false, verified: "docs" },
  { key: "amex", label: "Amex", methodId: 65, debit: false, verified: "sandbox_accepted" },
  { key: "naranja", label: "Naranja X", methodId: 24, debit: false, verified: "docs" },
  { key: "diners", label: "Diners", methodId: 8, debit: false, verified: "docs" },
];

export function paywayBrand(brand: unknown): PaywayBrand | null {
  const k = String(brand ?? "").toLowerCase();
  return PAYWAY_BRANDS.find((b) => b.key === k) ?? null;
}
export const paywayMethodId = (brand: unknown): number | null => paywayBrand(brand)?.methodId ?? null;

// ── Montos ───────────────────────────────────────────────────────────────────
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const toCents = (amount: number) => Math.round(round2(amount) * 100);
export const finalAmountWithSurcharge = (base: number, pct: number) =>
  round2(base * (1 + (Number(pct) || 0) / 100));

export function buildPaymentBody(p: {
  siteTransactionId: string;
  token: string;
  methodId: number;
  bin: string;
  finalAmount: number;
  installments: number;
}) {
  return {
    site_transaction_id: p.siteTransactionId,
    token: p.token,
    payment_method_id: p.methodId,
    bin: String(p.bin ?? "").slice(0, 6),
    amount: toCents(p.finalAmount),
    currency: "ARS",
    installments: p.installments,
    description: "Venta NinjaPos",
    payment_type: "single",
    sub_payments: [],
  };
}

// Id de pago de Payway: entero. Nunca devuelve el string "null".
export function paywayPaymentId(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v.trim())) return v.trim();
  return null;
}

// ── Errores ──────────────────────────────────────────────────────────────────
export type PaywayErrorReason = "token" | "card_data" | "gateway" | "unknown";

function validationErrors(b: Obj): { code: string; param: string }[] {
  const v = b.validation_errors;
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((e) => ({ code: String(e.code ?? ""), param: String(e.param ?? "") }));
}

export function paywayErrorDetail(body: unknown): string {
  if (!isObj(body)) return "";
  const parts: string[] = [];
  if (body.error_type) parts.push(String(body.error_type));
  const ve = validationErrors(body);
  if (ve.length) parts.push(ve.map((e) => `${e.code}:${e.param}`).join(", "));
  if (body.entity_name) parts.push(String(body.entity_name));
  if (body.message) parts.push(String(body.message));
  if (body.description) parts.push(String(body.description));
  return parts.join(" | ").slice(0, 300);
}

function errorReason(body: Obj): PaywayErrorReason {
  const type = String(body.error_type ?? "");
  const ve = validationErrors(body);
  if (ve.some((e) => e.param === "token")) return "token";
  if (type === "not_found_error" && String(body.entity_name ?? "") === "OperationResource") return "token";
  if (ve.some((e) => /card/i.test(e.code) || /card|bin|security_code|expir/i.test(e.param))) {
    return "card_data";
  }
  if (type === "api_error") return "gateway";
  return "unknown";
}

// ── POST /payments ───────────────────────────────────────────────────────────
export type PayOutcome =
  | { kind: "approved"; paymentId: string | null; amountCents: number }
  | { kind: "amount_mismatch"; paymentId: string | null; expectedCents: number; gotCents: number | null }
  | { kind: "rejected"; paymentId: string | null; reason: string | null }
  | { kind: "pending"; paymentId: string | null; state: string }
  | { kind: "error"; httpStatus: number; errorType: string; reason: PaywayErrorReason; detail: string };

function rejectReason(body: Obj): string | null {
  const sd = body.status_details;
  if (!isObj(sd) || !isObj(sd.error)) return null;
  const reason = sd.error.reason;
  if (isObj(reason) && reason.description) return String(reason.description).slice(0, 200);
  return sd.error.type ? String(sd.error.type) : null;
}

export function classifyPayResponse(httpStatus: number, body: unknown, expectedCents: number): PayOutcome {
  if (!isObj(body)) {
    return { kind: "error", httpStatus, errorType: "", reason: "unknown", detail: `http_${httpStatus}` };
  }
  const state = String(body.status ?? "").toLowerCase();
  const paymentId = paywayPaymentId(body.id);

  // Rechazo del emisor: Payway responde 402 con status 'rejected'.
  if (state === "rejected") return { kind: "rejected", paymentId, reason: rejectReason(body) };

  if (httpStatus >= 200 && httpStatus < 300 && state) {
    if (state === "approved" || state === "accredited") {
      const got = typeof body.amount === "number" || typeof body.amount === "string" ? Number(body.amount) : NaN;
      if (Number.isFinite(got) && got === expectedCents) {
        return { kind: "approved", paymentId, amountCents: got };
      }
      return {
        kind: "amount_mismatch",
        paymentId,
        expectedCents,
        gotCents: Number.isFinite(got) ? got : null,
      };
    }
    return { kind: "pending", paymentId, state };
  }

  return {
    kind: "error",
    httpStatus,
    errorType: String(body.error_type ?? ""),
    reason: errorReason(body),
    detail: paywayErrorDetail(body) || `http_${httpStatus}`,
  };
}

// Respuesta HTTP de payway_checkout (action pay) según el resultado.
export function payHttpResponse(o: PayOutcome, finalAmount: number): { status: number; body: Obj } {
  switch (o.kind) {
    case "approved":
      return { status: 200, body: { ok: true, status: "approved", amount: finalAmount } };
    case "rejected":
      return { status: 402, body: { ok: false, status: "rejected_attempt", detail: o.reason ?? "" } };
    case "pending":
      return { status: 202, body: { ok: false, status: "pending_review", state: o.state } };
    case "amount_mismatch":
      return {
        status: 502,
        body: {
          ok: false,
          error: "payway_error",
          reason: "amount_mismatch",
          detail: `expected ${o.expectedCents} got ${o.gotCents ?? "none"}`,
        },
      };
    case "error":
      return {
        status: 502,
        body: {
          ok: false,
          error: "payway_error",
          reason: o.reason,
          error_type: o.errorType,
          http_status: o.httpStatus,
          detail: o.detail,
        },
      };
  }
}

// ── GET /payments/{id} (status del POS y webhook) ────────────────────────────
// Acredita sólo approved + monto EXACTO en centavos (+ site_transaction_id del
// intent cuando se conoce). Sin monto no acredita.
export type StatusDecision =
  | { status: "approved" }
  | { status: "rejected"; reason?: string }
  | { status: "pending"; reason?: string }
  | { status: "ignore"; reason: string };

export function decidePaymentStatus(
  pay: unknown,
  expectedAmount: number,
  expectedSiteTransactionId?: string | null,
): StatusDecision {
  if (!isObj(pay) || pay.error_type) return { status: "pending", reason: "not_found" };
  if (expectedSiteTransactionId && String(pay.site_transaction_id ?? "") !== expectedSiteTransactionId) {
    return { status: "ignore", reason: "site_transaction_mismatch" };
  }
  const state = String(pay.status ?? "").toLowerCase();
  if (state === "approved" || state === "accredited") {
    const got = Number(pay.amount ?? NaN);
    if (Number.isFinite(got) && got === toCents(expectedAmount)) return { status: "approved" };
    return { status: "rejected", reason: "amount_mismatch" };
  }
  if (["rejected", "annulled", "voided"].includes(state)) return { status: "rejected", reason: state };
  return { status: "pending", reason: state || "unknown" };
}
