import { describe, expect, it } from "vitest";
import {
  allowedDevices,
  buildPayRequest,
  cardKindOf,
  cloverApiBase,
  cloverConnectBase,
  cloverEnv,
  cloverEnvFromIntent,
  cloverHeaders,
  cloverRefreshUrl,
  evaluateCloverPayment,
  externalPaymentIdOf,
  fromCents,
  intentEnvOf,
  intentIdFromExternal,
  isSafeCloverId,
  parseCloverDevices,
  parseCloverWebhook,
  parseDeviceSerials,
  payErrorOutcome,
  safeEqual,
  toCents,
} from "@/supabase/functions/_shared/clover";

const INTENT = "7a20779f-5d3e-4dc4-9c3f-fb778d12134b";
const EXT = "7a20779f5d3e4dc49c3ffb778d12134b";

const payment = (over: Record<string, unknown> = {}) => ({
  payment: {
    id: "JQ2PXBQZ9QK6E",
    amount: 152050,
    tipAmount: 0,
    result: "SUCCESS",
    externalPaymentId: EXT,
    ...over,
  },
});

describe("ambientes", () => {
  it("sandbox global y producción de Latinoamérica", () => {
    expect(cloverEnv(true)).toBe("sandbox");
    expect(cloverEnv(false)).toBe("prod");
    expect(cloverEnv(null)).toBe("prod");
    expect(cloverApiBase("sandbox")).toBe("https://apisandbox.dev.clover.com");
    expect(cloverApiBase("prod")).toBe("https://api.la.clover.com");
    expect(cloverConnectBase("prod")).toBe("https://api.la.clover.com/connect");
    expect(cloverRefreshUrl("sandbox")).toBe("https://apisandbox.dev.clover.com/oauth/v2/refresh");
  });

  it("el intent guarda el ambiente como mp_env prod/test", () => {
    expect(intentEnvOf("sandbox")).toBe("test");
    expect(intentEnvOf("prod")).toBe("prod");
    expect(cloverEnvFromIntent("test")).toBe("sandbox");
    expect(cloverEnvFromIntent("prod")).toBe("prod");
    expect(cloverEnvFromIntent(null)).toBe("prod");
  });
});

describe("montos en centavos", () => {
  it("convierte pesos a centavos enteros sin errores de coma flotante", () => {
    expect(toCents(1520.5)).toBe(152050);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(19.99)).toBe(1999);
    expect(fromCents(152050)).toBe(1520.5);
  });

  it("rechaza montos inválidos", () => {
    expect(toCents(0)).toBeNull();
    expect(toCents(-5)).toBeNull();
    expect(toCents(Number.NaN)).toBeNull();
    expect(toCents(Infinity)).toBeNull();
    expect(toCents(0.001)).toBeNull();
  });
});

describe("correlación", () => {
  it("externalPaymentId = uuid del intent sin guiones (máx. 32)", () => {
    expect(externalPaymentIdOf(INTENT)).toBe(EXT);
    expect(externalPaymentIdOf(INTENT)).toHaveLength(32);
    expect(intentIdFromExternal(EXT)).toBe(INTENT);
    expect(intentIdFromExternal("nope")).toBeNull();
    expect(() => externalPaymentIdOf("no-es-uuid")).toThrow();
  });

  it("valida ids de Clover antes de usarlos en URLs o headers", () => {
    expect(isSafeCloverId("C043UQ12345678")).toBe(true);
    expect(isSafeCloverId("../v3/merchants")).toBe(false);
    expect(isSafeCloverId("a b")).toBe(false);
    expect(isSafeCloverId("")).toBe(false);
    expect(isSafeCloverId(12)).toBe(false);
  });
});

describe("buildPayRequest", () => {
  it("venta cerrada en centavos con el id del intent", () => {
    expect(buildPayRequest({ intentId: INTENT, amountCents: 152050 })).toEqual({
      amount: 152050,
      externalPaymentId: EXT,
      final: true,
    });
  });

  it("cuotas fijas por regionalExtras de Argentina", () => {
    expect(buildPayRequest({ intentId: INTENT, amountCents: 1000, installments: 6 }).regionalExtras).toEqual({
      argentina: { numInstallments: 6 },
    });
    // Fuera de rango: la terminal pregunta.
    expect(buildPayRequest({ intentId: INTENT, amountCents: 1000, installments: 0 }).regionalExtras).toBeUndefined();
    expect(buildPayRequest({ intentId: INTENT, amountCents: 1000, installments: 120 }).regionalExtras).toBeUndefined();
  });

  it("no acepta montos que no sean centavos enteros positivos", () => {
    expect(() => buildPayRequest({ intentId: INTENT, amountCents: 10.5 })).toThrow();
    expect(() => buildPayRequest({ intentId: INTENT, amountCents: 0 })).toThrow();
  });
});

describe("cloverHeaders", () => {
  it("manda terminal, POS e idempotencia sólo cuando corresponde", () => {
    const h = cloverHeaders({ token: "tok", deviceId: "C043UQ1", idempotencyKey: INTENT });
    expect(h.Authorization).toBe("Bearer tok");
    expect(h["X-Clover-Device-Id"]).toBe("C043UQ1");
    expect(h["X-POS-Id"]).toBe("NinjaPos");
    expect(h["Idempotency-Key"]).toBe(INTENT);
    const plain = cloverHeaders({ token: "tok" });
    expect(plain["X-Clover-Device-Id"]).toBeUndefined();
    expect(plain["Idempotency-Key"]).toBeUndefined();
  });
});

describe("evaluateCloverPayment", () => {
  const exp = { intentId: INTENT, amount: 1520.5 };

  it("SUCCESS + id + monto exacto acredita", () => {
    const ev = evaluateCloverPayment(payment(), exp);
    expect(ev.outcome).toBe("approved");
    expect(ev.paymentId).toBe("JQ2PXBQZ9QK6E");
  });

  it("acepta el pago sin envoltorio (API de plataforma)", () => {
    expect(evaluateCloverPayment(payment().payment, exp).outcome).toBe("approved");
  });

  it("la propina no cuenta para el monto", () => {
    expect(evaluateCloverPayment(payment({ tipAmount: 5000 }), exp).outcome).toBe("approved");
  });

  it("monto distinto o de otro intent no acredita", () => {
    expect(evaluateCloverPayment(payment({ amount: 152049 }), exp)).toMatchObject({
      outcome: "mismatch",
      reason: "amount_mismatch",
    });
    expect(evaluateCloverPayment(payment({ externalPaymentId: "otro" }), exp)).toMatchObject({
      outcome: "mismatch",
      reason: "reference_mismatch",
    });
    expect(evaluateCloverPayment(payment({ externalPaymentId: undefined }), exp).outcome).toBe("mismatch");
  });

  it("mapea los resultados de Clover", () => {
    expect(evaluateCloverPayment(payment({ result: "FAIL" }), exp).outcome).toBe("rejected");
    expect(evaluateCloverPayment(payment({ result: "VOIDED", voidReason: "USER_CANCEL" }), exp)).toMatchObject({
      outcome: "cancelled",
      reason: "user_cancel",
    });
    expect(evaluateCloverPayment(payment({ result: "VOID_FAILED" }), exp).outcome).toBe("approved");
    expect(evaluateCloverPayment(payment({ result: "INITIATED" }), exp).outcome).toBe("pending");
    expect(evaluateCloverPayment(payment({ result: "AUTH" }), exp).outcome).toBe("pending");
    expect(evaluateCloverPayment(null, exp).outcome).toBe("pending");
  });
});

describe("payErrorOutcome", () => {
  it("clasifica las respuestas sin pago del POST /v1/payments", () => {
    expect(payErrorOutcome(209, null)).toEqual({ outcome: "cancelled", reason: "cancelled_on_device" });
    expect(payErrorOutcome(503, null)).toEqual({ outcome: "rejected", reason: "device_busy" });
    expect(payErrorOutcome(401, null)).toEqual({ outcome: "rejected", reason: "clover_auth_failed" });
    expect(payErrorOutcome(400, { message: "Device serial number does not match" })).toEqual({
      outcome: "rejected",
      reason: "invalid_request: Device serial number does not match",
    });
    // Indeterminado: decide la consulta por externalPaymentId.
    expect(payErrorOutcome(504, null).outcome).toBe("pending");
    expect(payErrorOutcome(500, null).outcome).toBe("pending");
    expect(payErrorOutcome(0, null).outcome).toBe("pending");
  });
});

describe("cardKindOf", () => {
  it("débito o crédito según el tender", () => {
    expect(cardKindOf({ tender: { labelKey: "com.clover.tender.debit_card" } })).toBe("debit");
    expect(cardKindOf({ tender: { labelKey: "com.clover.tender.credit_card" } })).toBe("credit");
    expect(cardKindOf({ tender: { label: "Tarjeta de débito" } })).toBe("debit");
    expect(cardKindOf({ tender: { labelKey: "com.clover.tender.cash" } })).toBeNull();
    expect(cardKindOf(null)).toBeNull();
  });
});

describe("terminales", () => {
  it("parsea las series cargadas a mano", () => {
    expect(parseDeviceSerials("Caja 1: C043UQ1, C043UQ2\nmal id!, Caja 1: C043UQ1")).toEqual([
      { id: "C043UQ1", label: "Caja 1" },
      { id: "C043UQ2", label: "C043UQ2" },
    ]);
    expect(parseDeviceSerials(undefined)).toEqual([]);
  });

  it("parsea GET devices usando el número de serie", () => {
    expect(
      parseCloverDevices({
        elements: [
          { id: "X1", serial: "C043UQ1", name: "Mostrador", model: "Clover_C503" },
          { id: "X2", serial: "C043UQ2", productName: "Clover Flex" },
          { id: "X3" },
        ],
      }),
    ).toEqual([
      { id: "C043UQ1", label: "Mostrador (C043UQ1)" },
      { id: "C043UQ2", label: "Clover Flex (C043UQ2)" },
    ]);
    expect(parseCloverDevices({})).toEqual([]);
  });

  it("las series cargadas acotan las de Clover", () => {
    const api = [
      { id: "A", label: "Flex (A)" },
      { id: "B", label: "Mini (B)" },
    ];
    expect(allowedDevices([], api)).toEqual(api);
    expect(allowedDevices([{ id: "B", label: "B" }], api)).toEqual([{ id: "B", label: "Mini (B)" }]);
    expect(allowedDevices([{ id: "B", label: "Caja 2" }], api)).toEqual([{ id: "B", label: "Caja 2" }]);
  });
});

describe("webhook", () => {
  it("reconoce el código de verificación", () => {
    expect(parseCloverWebhook({ verificationCode: "abc-123" })).toEqual({ kind: "verification", code: "abc-123" });
  });

  it("extrae sólo los pagos (P:) por merchant", () => {
    expect(
      parseCloverWebhook({
        appId: "APP",
        merchants: {
          MERCH1: [
            { objectId: "P:PAY1", type: "CREATE" },
            { objectId: "O:ORDER1", type: "UPDATE" },
            { objectId: "P:PAY1", type: "UPDATE" },
          ],
          "../x": [{ objectId: "P:PAY2" }],
          MERCH2: [{ objectId: "O:ORDER2" }],
        },
      }),
    ).toEqual({ kind: "events", merchants: [{ merchantId: "MERCH1", paymentIds: ["PAY1"] }] });
    expect(parseCloverWebhook(null)).toBeNull();
    expect(parseCloverWebhook({})).toBeNull();
  });

  it("compara el X-Clover-Auth en tiempo constante", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
  });
});
