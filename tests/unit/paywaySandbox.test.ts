import { describe, expect, it } from "vitest";
import {
  PAYWAY_BRANDS,
  buildPaymentBody,
  classifyPayResponse,
  decidePaymentStatus,
  finalAmountWithSurcharge,
  payHttpResponse,
  paywayMethodId,
  paywayPaymentId,
  paywayV2Base,
  toCents,
} from "@/supabase/functions/_shared/payway";
import { paywayPayMessage, paywayTokenMessage } from "@/lib/payments/paywayMessages";

// Respuestas REALES del sandbox público de Payway (developers.decidir.com),
// capturadas el 2026-10-11 (sandbox-check/out/payway*.txt y verify2.txt).
const INTENT = "4beab0b5-138b-416e-8cd4-26c65ed50447";

const APPROVED_201 = {
  id: 16142075,
  site_transaction_id: INTENT,
  payment_method_id: 1,
  card_brand: "Visa",
  amount: 10000,
  currency: "ars",
  status: "approved",
  status_details: {
    ticket: "4031",
    card_authorization_code: "214637",
    address_validation_code: "VTE0011",
    error: null,
  },
  date: "2026-10-11T21:46Z",
  bin: "450799",
  installments: 1,
  payment_type: "single",
  sub_payments: [],
  site_id: "28464383",
  token: "f1f588aa-29fd-4982-83b1-e912cfa077f8",
};

const APPROVED_6_CUOTAS = {
  id: 16142076,
  site_transaction_id: "1b03afed-24e8-4ede-8b90-3907da9090b6",
  payment_method_id: 1,
  card_brand: "Visa",
  amount: 12345,
  currency: "ars",
  status: "approved",
  status_details: { ticket: "2196", card_authorization_code: "214702", error: null },
  installments: 6,
};

const VISA_DEBITO_201 = {
  id: 16142077,
  site_transaction_id: "b1cf1b72-c1c4-4620-9cca-dd48cb14ee6b",
  payment_method_id: 31,
  card_brand: "Visa Débito",
  amount: 1000,
  currency: "ars",
  status: "approved",
  status_details: { ticket: "887", card_authorization_code: "215445", error: null },
};

const REJECTED_402 = {
  id: 16142079,
  site_transaction_id: "843179f7-882f-498d-8709-85d24333a052",
  payment_method_id: 65,
  card_brand: "Amex",
  amount: 1000,
  currency: "ars",
  status: "rejected",
  status_details: {
    ticket: "1001",
    card_authorization_code: "",
    address_validation_code: null,
    error: {
      type: "invalid_card",
      reason: { id: 91, description: "EMISOR FUERA LINEA", additional_description: "" },
    },
  },
};

const TOKEN_NOT_FOUND_404 = {
  error_type: "not_found_error",
  entity_name: "OperationResource",
  id: "00000000-0000-0000-0000-000000000000",
};
const PAYMENT_NOT_FOUND_404 = { error_type: "not_found_error", entity_name: "payments", id: "1" };
const TOKEN_REPEATED_400 = {
  error_type: "invalid_request_error",
  validation_errors: [{ code: "repeated", param: "token" }],
};
const EXPIRED_CARD_400 = {
  error_type: "invalid_request_error",
  validation_errors: [{ code: "CardData", param: "expired card" }],
};
const API_ERROR_400 = {
  error_type: "api_error",
  message: "auth-3ds-svc: Name does not resolve",
  code: "internal_server_error",
};

describe("payway: bases y montos", () => {
  it("sandbox vs prod por el switch del medio", () => {
    expect(paywayV2Base(true)).toBe("https://developers.decidir.com/api/v2");
    expect(paywayV2Base(false)).toBe("https://ventasonline.payway.com.ar/api/v2");
    expect(paywayV2Base(null)).toBe("https://ventasonline.payway.com.ar/api/v2");
  });
  it("monto en centavos enteros (sandbox: 100 → 10000, 123.45 → 12345)", () => {
    expect(toCents(100)).toBe(10000);
    expect(toCents(123.45)).toBe(12345);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
  it("recargo del plan redondeado a 2 decimales", () => {
    expect(finalAmountWithSurcharge(100, 0)).toBe(100);
    expect(finalAmountWithSurcharge(100, 23.45)).toBe(123.45);
    expect(finalAmountWithSurcharge(99.99, 10)).toBe(109.99);
  });
  it("body del pago igual al validado en sandbox", () => {
    expect(
      buildPaymentBody({
        siteTransactionId: INTENT,
        token: "tok",
        methodId: 1,
        bin: "450799123",
        finalAmount: 123.45,
        installments: 6,
      }),
    ).toEqual({
      site_transaction_id: INTENT,
      token: "tok",
      payment_method_id: 1,
      bin: "450799",
      amount: 12345,
      currency: "ARS",
      installments: 6,
      description: "Venta NinjaPos",
      payment_type: "single",
      sub_payments: [],
    });
  });
});

describe("payway: marcas → payment_method_id", () => {
  it("Visa = 1 y Visa Débito = 31 (aprobados en sandbox)", () => {
    expect(paywayMethodId("visa")).toBe(1);
    expect(paywayMethodId("visa_debito")).toBe(31);
    expect(paywayMethodId("VISA")).toBe(1);
    expect(paywayMethodId("inexistente")).toBeNull();
  });
  it("la tabla documenta qué ids están verificados", () => {
    const byKey = Object.fromEntries(PAYWAY_BRANDS.map((b) => [b.key, b]));
    expect(byKey.visa?.verified).toBe("sandbox_approved");
    expect(byKey.visa_debito?.verified).toBe("sandbox_approved");
    expect(byKey.amex?.verified).toBe("sandbox_accepted");
    expect(byKey.master?.verified).toBe("docs");
    expect(byKey.visa_debito?.debit).toBe(true);
    // Cada marca con id único.
    const ids = PAYWAY_BRANDS.map((b) => b.methodId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("payway: id del pago", () => {
  it("sólo ids numéricos; nunca el string 'null'", () => {
    expect(paywayPaymentId(16142075)).toBe("16142075");
    expect(paywayPaymentId("16142075")).toBe("16142075");
    expect(paywayPaymentId(null)).toBeNull();
    expect(paywayPaymentId(undefined)).toBeNull();
    expect(paywayPaymentId("null")).toBeNull();
    expect(paywayPaymentId("abc-hash")).toBeNull();
  });
});

describe("payway: respuesta del POST /payments", () => {
  it("201 approved con monto exacto → approved", () => {
    expect(classifyPayResponse(201, APPROVED_201, 10000)).toEqual({
      kind: "approved",
      paymentId: "16142075",
      amountCents: 10000,
    });
    expect(classifyPayResponse(201, APPROVED_6_CUOTAS, 12345).kind).toBe("approved");
    expect(classifyPayResponse(201, VISA_DEBITO_201, 1000).kind).toBe("approved");
  });
  it("approved con monto distinto o sin monto → amount_mismatch (no aprueba)", () => {
    expect(classifyPayResponse(201, APPROVED_201, 10001)).toEqual({
      kind: "amount_mismatch",
      paymentId: "16142075",
      expectedCents: 10001,
      gotCents: 10000,
    });
    const { amount: _a, ...sinMonto } = APPROVED_201;
    expect(classifyPayResponse(201, sinMonto, 10000).kind).toBe("amount_mismatch");
  });
  it("402 status rejected → rejected con el motivo del emisor", () => {
    expect(classifyPayResponse(402, REJECTED_402, 1000)).toEqual({
      kind: "rejected",
      paymentId: "16142079",
      reason: "EMISOR FUERA LINEA",
    });
  });
  it("404 token inexistente → error not_found (no es rechazo)", () => {
    const o = classifyPayResponse(404, TOKEN_NOT_FOUND_404, 10000);
    expect(o).toMatchObject({ kind: "error", httpStatus: 404, errorType: "not_found_error", reason: "token" });
  });
  it("400 token repetido → error de validación sobre el token", () => {
    const o = classifyPayResponse(400, TOKEN_REPEATED_400, 12345);
    expect(o).toMatchObject({ kind: "error", errorType: "invalid_request_error", reason: "token" });
    expect(o.kind === "error" && o.detail).toContain("repeated:token");
  });
  it("400 datos de tarjeta → reason card_data", () => {
    expect(classifyPayResponse(400, EXPIRED_CARD_400, 100)).toMatchObject({
      kind: "error",
      reason: "card_data",
    });
  });
  it("400 api_error del gateway → reason gateway", () => {
    const o = classifyPayResponse(400, API_ERROR_400, 1000);
    expect(o).toMatchObject({ kind: "error", errorType: "api_error", reason: "gateway" });
    expect(o.kind === "error" && o.detail).toContain("auth-3ds-svc");
  });
  it("2xx con estado intermedio → pending", () => {
    expect(classifyPayResponse(201, { ...APPROVED_201, status: "review" }, 10000)).toEqual({
      kind: "pending",
      paymentId: "16142075",
      state: "review",
    });
  });
  it("cuerpo ilegible → error", () => {
    expect(classifyPayResponse(500, null, 100)).toMatchObject({ kind: "error", httpStatus: 500 });
  });
});

describe("payway: respuesta HTTP de payway_checkout pay", () => {
  it("approved → 200 ok", () => {
    const r = payHttpResponse(classifyPayResponse(201, APPROVED_201, 10000), 100);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: "approved", amount: 100 });
  });
  it("sólo rejected → 402 rejected_attempt", () => {
    const r = payHttpResponse(classifyPayResponse(402, REJECTED_402, 1000), 10);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ ok: false, status: "rejected_attempt", detail: "EMISOR FUERA LINEA" });
  });
  it("errores 400/404 → 502 payway_error con detalle", () => {
    for (const [s, b] of [
      [404, TOKEN_NOT_FOUND_404],
      [400, TOKEN_REPEATED_400],
      [400, API_ERROR_400],
    ] as const) {
      const r = payHttpResponse(classifyPayResponse(s, b, 1000), 10);
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ ok: false, error: "payway_error" });
      expect(String(r.body.detail)).not.toBe("");
    }
  });
  it("monto distinto → 502 payway_error amount_mismatch", () => {
    const r = payHttpResponse(classifyPayResponse(201, APPROVED_201, 1), 0.01);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: "payway_error", reason: "amount_mismatch" });
  });
  it("estado intermedio → 202 pending_review", () => {
    const r = payHttpResponse(classifyPayResponse(201, { ...APPROVED_201, status: "review" }, 10000), 100);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: false, status: "pending_review" });
  });
});

describe("payway: GET /payments/{id} (status y webhook)", () => {
  it("approved + monto exacto + correlación → approved", () => {
    expect(decidePaymentStatus(APPROVED_201, 100, INTENT)).toEqual({ status: "approved" });
  });
  it("monto distinto → rejected (amount_mismatch)", () => {
    expect(decidePaymentStatus(APPROVED_201, 100.01, INTENT)).toEqual({
      status: "rejected",
      reason: "amount_mismatch",
    });
  });
  it("sin monto → no se acredita", () => {
    const { amount: _a, ...sinMonto } = APPROVED_201;
    expect(decidePaymentStatus(sinMonto, 100, INTENT).status).toBe("rejected");
  });
  it("site_transaction_id de otro intent → ignore", () => {
    expect(decidePaymentStatus(APPROVED_201, 100, "otro")).toEqual({
      status: "ignore",
      reason: "site_transaction_mismatch",
    });
  });
  it("sin site_transaction_id → ignore", () => {
    const { site_transaction_id: _s, ...sinSite } = APPROVED_201;
    expect(decidePaymentStatus(sinSite, 100, INTENT).status).toBe("ignore");
    expect(decidePaymentStatus(sinSite, 100).status).toBe("approved");
  });
  it("rejected/annulled → rejected; otros → pending", () => {
    expect(decidePaymentStatus(REJECTED_402, 10, REJECTED_402.site_transaction_id).status).toBe("rejected");
    expect(decidePaymentStatus({ ...APPROVED_201, status: "annulled" }, 100, INTENT).status).toBe("rejected");
    expect(decidePaymentStatus({ ...APPROVED_201, status: "review" }, 100, INTENT).status).toBe("pending");
  });
  it("404 del GET (cuerpo de error) → pending", () => {
    expect(decidePaymentStatus(PAYMENT_NOT_FOUND_404, 100, INTENT).status).toBe("pending");
  });
});

describe("copy para el cliente en /pagar", () => {
  it("rechazo del emisor", () => {
    expect(paywayPayMessage({ status: "rejected_attempt" })).toMatch(/rechazado por el emisor/);
  });
  it("error del procesador no culpa al emisor", () => {
    const m = paywayPayMessage({ error: "payway_error", reason: "gateway" });
    expect(m).not.toMatch(/rechazado/);
    expect(m).toMatch(/procesador/);
  });
  it("token / datos de tarjeta", () => {
    expect(paywayPayMessage({ error: "payway_error", reason: "token" })).toMatch(/de nuevo/);
    expect(paywayPayMessage({ error: "payway_error", reason: "card_data" })).toMatch(/datos de la tarjeta/);
  });
  it("monto distinto y revisión piden avisar al cajero", () => {
    expect(paywayPayMessage({ error: "payway_error", reason: "amount_mismatch" })).toMatch(/cajero/);
    expect(paywayPayMessage({ status: "pending_review" })).toMatch(/cajero/);
    expect(paywayPayMessage({ error: "payment_in_review" })).toMatch(/cajero/);
  });
  it("intent no disponible", () => {
    expect(paywayPayMessage({ error: "intent_not_pending" })).toMatch(/ya no está disponible/);
  });
  it("tokenización: tarjeta vencida y datos inválidos", () => {
    expect(paywayTokenMessage(EXPIRED_CARD_400)).toMatch(/vencida/);
    expect(
      paywayTokenMessage({
        error_type: "invalid_request_error",
        validation_errors: [{ code: "invalid_param", param: "card_number" }],
      }),
    ).toMatch(/Revisá los datos/);
    expect(paywayTokenMessage(null)).toMatch(/Revisá los datos/);
  });
  it("sin guion largo en ningún mensaje", () => {
    const all = [
      paywayPayMessage({ status: "rejected_attempt" }),
      paywayPayMessage({ error: "payway_error", reason: "gateway" }),
      paywayPayMessage({ error: "payway_error", reason: "token" }),
      paywayPayMessage({ error: "payway_error", reason: "card_data" }),
      paywayPayMessage({ error: "payway_error", reason: "amount_mismatch" }),
      paywayPayMessage({ status: "pending_review" }),
      paywayPayMessage({}),
      paywayTokenMessage(EXPIRED_CARD_400),
    ];
    for (const m of all) expect(m).not.toContain("—");
  });
});
