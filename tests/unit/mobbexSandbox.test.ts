import { describe, expect, it } from "vitest";
import {
  MOBBEX_WEBHOOKS_TYPE,
  buildCheckoutBody,
  decideMobbex,
  mobbexCustomer,
  mobbexStatus,
  operationLookupUrls,
  parseCheckoutResponse,
  pickOperationFromList,
  pickPayment,
  unwrapOperation,
  webhookPaymentId,
  webhookType,
} from "@/supabase/functions/_shared/mobbex";

// Respuestas REALES de la API de Mobbex con las credenciales demo públicas de
// mobbex.dev (sandbox-check/out/mobbex*.txt y verify2.txt, 2026-10-11) y los
// ejemplos de webhook de la doc oficial (mobbex.dev/webhooks).
const INTENT = "66366bd3-e44d-4d6c-b421-c214f3bdd10f";

const CHECKOUT_OK = {
  result: true,
  data: {
    id: "CHK:O75UE4JC1PM32MMIUO",
    url: "https://mobbex.com/p/checkout/v2/CHK:O75UE4JC1PM32MMIUO",
    description: "Venta",
    currency: "ARS",
    total: 1234.5,
    timeout: 60,
    created: 1791766037579,
    intent: { token: "66366bd3-e44d-4d6c-b421-c214f3bdd10f" },
    paymentMethods: [{ group: "card", subgroup: "card_input", type: "card" }],
    warnings: [
      {
        type: "customer",
        message: "No customer declared. Please review or your checkout won't be created on the future",
      },
    ],
  },
};
const CHECKOUT_MISSING_PARAMS = {
  result: false,
  code: "MRPERR",
  error: "Parametros obligatorios faltantes",
};
const OPERATION_EFCS = {
  result: false,
  code: "GENERIC:EFCS",
  error: "Execution failed. Please contact support with the case ID.  ID: f69d59c9-4873-421c-a4bc-b93b18d82a0b",
};
const LIST_EMPTY = {
  result: true,
  data: {
    docs: [],
    total: 0,
    page: 1,
    prevPage: -1,
    nextPage: -1,
    nextCursor: null,
    limit: 5,
    windowClamped: false,
  },
};

// Ejemplo oficial "WebHook de Checkout" (status.code string, requestedTotal).
const WEBHOOK_APPROVED = {
  type: "checkout",
  data: {
    checkout: { currency: "ARS", total: 145170, uid: "CHK:UOUIOWAM3NU1BE19WB" },
    customer: { identification: "12123123", name: "Bruce Wayne" },
    payment: {
      id: "3Z6D9YF71L0LGGRR8DRT3W",
      reference: INTENT,
      requestedTotal: 145170,
      status: { code: "200", text: "Aprobado", message: "Transacción Aprobada" },
      total: 145170,
    },
    result: true,
  },
};
const WEBHOOK_CASH_WAITING = {
  type: "checkout",
  data: {
    result: true,
    payment: {
      id: "xcnAQ5dDO",
      status: { code: "2", text: "En Espera" },
      total: 1333,
      reference: INTENT,
    },
    checkout: { uid: "TK0L70HEE9M4T6EBPH" },
  },
};
const WEBHOOK_EXPIRED = {
  type: "checkout:expired",
  data: {
    payment: {
      id: "QL18TN2SG5ETDMAEFMP951",
      reference: INTENT,
      status: { code: "400", text: "Rechazado" },
      total: 10,
    },
    result: true,
  },
  status: { code: 401 },
};
// Forma documentada de GET /p/operations/{uid}: data.transaction.payment.
const OPERATION_OK = {
  result: true,
  data: {
    transactions: [{ uid: "3Z6D9YF71L0LGGRR8DRT3W", status: "200", total: 145170 }],
    transaction: {
      result: true,
      payment: {
        id: "3Z6D9YF71L0LGGRR8DRT3W",
        reference: INTENT,
        status: { code: "200", text: "Aprobado" },
        total: 145170,
      },
    },
  },
};
// Forma documentada de GET /p/entity/operations: status string plano, uid.
const LIST_WITH_DOCS = {
  result: true,
  data: {
    docs: [
      { uid: "FAIL1", reference: INTENT, status: "400", total: 1451.7 },
      { uid: "3Z6D9YF71L0LGGRR8DRT3W", reference: INTENT, status: "200", total: 1451.7 },
    ],
    page: 0,
    limit: 20,
  },
};

describe("mobbex: crear checkout", () => {
  it("parsea el 200 real (id CHK + url)", () => {
    expect(parseCheckoutResponse(200, CHECKOUT_OK)).toEqual({
      ok: true,
      id: "CHK:O75UE4JC1PM32MMIUO",
      url: "https://mobbex.com/p/checkout/v2/CHK:O75UE4JC1PM32MMIUO",
      warnings: ["customer: No customer declared. Please review or your checkout won't be created on the future"],
    });
  });
  it("HTTP 200 con result:false es error con code/error", () => {
    expect(parseCheckoutResponse(200, CHECKOUT_MISSING_PARAMS)).toEqual({
      ok: false,
      code: "MRPERR",
      error: "Parametros obligatorios faltantes",
    });
  });
  it("HTTP no-2xx o sin url → error", () => {
    expect(parseCheckoutResponse(500, null)).toMatchObject({ ok: false, code: "http_500" });
    expect(parseCheckoutResponse(200, { result: true, data: { id: "CHK:1" } })).toMatchObject({
      ok: false,
      code: "no_url",
    });
  });
  it("body: customer, webhooksType final y SIN installments", () => {
    const body = buildCheckoutBody({
      amount: 1234.499,
      reference: INTENT,
      description: "Venta",
      webhookUrl: "https://x.supabase.co/functions/v1/mobbex_webhook?intent=" + INTENT,
      customer: { email: "a@b.com", name: "Ana", identification: "30111222" },
    });
    expect(body).toEqual({
      total: 1234.5,
      currency: "ARS",
      reference: INTENT,
      description: "Venta",
      webhook: "https://x.supabase.co/functions/v1/mobbex_webhook?intent=" + INTENT,
      return_url: "https://x.supabase.co/functions/v1/mobbex_webhook?intent=" + INTENT,
      webhooksType: "final",
      customer: { email: "a@b.com", name: "Ana", identification: "30111222" },
    });
    expect(MOBBEX_WEBHOOKS_TYPE).toBe("final");
    expect(body).not.toHaveProperty("installments");
  });
});

describe("mobbex: customer", () => {
  it("usa el cliente de la venta si tiene datos", () => {
    expect(
      mobbexCustomer(
        { name: " Ana Pérez ", email: "ana@x.com", document_number: "30.111.222" },
        { email: "caja@negocio.com" },
      ),
    ).toEqual({ email: "ana@x.com", name: "Ana Pérez", identification: "30111222" });
  });
  it("completa con el placeholder neutro lo que falte", () => {
    expect(mobbexCustomer({ name: "Ana", email: null, document_number: null }, { email: "caja@negocio.com" })).toEqual({
      email: "caja@negocio.com",
      name: "Ana",
      identification: "0",
    });
    expect(mobbexCustomer(null, { email: null })).toEqual({
      email: "consumidor.final@pos.soft.ninja",
      name: "Consumidor Final",
      identification: "0",
    });
  });
  it("ignora emails inválidos", () => {
    expect(mobbexCustomer({ name: "X", email: "no-es-mail" }, { email: "caja@n.com" }).email).toBe("caja@n.com");
  });
});

describe("mobbex: estados", () => {
  it("200/300/301 aprobado (Paga, Acreditado, Liquidado), número o string", () => {
    expect(mobbexStatus(200)).toBe("approved");
    expect(mobbexStatus("200")).toBe("approved");
    expect(mobbexStatus("300")).toBe("approved");
    expect(mobbexStatus(301)).toBe("approved");
  });
  it("intermedios pending (0,1,2,3 autorizada,100 revisión,210 retenida)", () => {
    for (const c of [0, 1, "2", 3, 100, "210"]) expect(mobbexStatus(c)).toBe("pending");
  });
  it("4xx/6xx rechazado; basura → null", () => {
    for (const c of [400, "401", 402, 410, 417, 601, 602]) expect(mobbexStatus(c)).toBe("rejected");
    expect(mobbexStatus(undefined)).toBeNull();
    expect(mobbexStatus("abc")).toBeNull();
  });
});

describe("mobbex: webhook y re-consulta", () => {
  it("id del pago del body, nunca el CHK", () => {
    expect(webhookPaymentId(WEBHOOK_APPROVED)).toBe("3Z6D9YF71L0LGGRR8DRT3W");
    expect(webhookPaymentId({ data: { payment: { id: "CHK:XX" } } })).toBeNull();
    expect(webhookPaymentId({ data: { id: "CHK:XX" } })).toBeNull();
    expect(webhookPaymentId(null)).toBeNull();
    expect(webhookType(WEBHOOK_EXPIRED)).toBe("checkout:expired");
    expect(webhookType({})).toBe("checkout");
  });
  it("URLs de re-consulta: operación por id y listado por referencia", () => {
    expect(operationLookupUrls("3Z6D9YF71L0LGGRR8DRT3W", INTENT)).toEqual([
      "https://api.mobbex.com/p/operations/3Z6D9YF71L0LGGRR8DRT3W",
      `https://api.mobbex.com/p/entity/operations?page=0&limit=20&reference=${INTENT}`,
    ]);
    expect(operationLookupUrls(null, INTENT)).toEqual([
      `https://api.mobbex.com/p/entity/operations?page=0&limit=20&reference=${INTENT}`,
    ]);
  });
  it("result:false (GENERIC:EFCS real) no es operación", () => {
    expect(unwrapOperation(OPERATION_EFCS)).toBeNull();
    expect(pickOperationFromList(OPERATION_EFCS, null)).toBeNull();
  });
  it("operación por id: data.transaction.payment", () => {
    expect(unwrapOperation(OPERATION_OK)).toEqual({
      id: "3Z6D9YF71L0LGGRR8DRT3W",
      reference: INTENT,
      code: "200",
      total: 145170,
      requestedTotal: null,
    });
  });
  it("listado vacío real → null; con docs prefiere el id notificado o el aprobado", () => {
    expect(pickOperationFromList(LIST_EMPTY, null)).toBeNull();
    expect(pickOperationFromList(LIST_WITH_DOCS, null)?.id).toBe("3Z6D9YF71L0LGGRR8DRT3W");
    expect(pickOperationFromList(LIST_WITH_DOCS, "FAIL1")?.id).toBe("FAIL1");
    expect(pickOperationFromList(LIST_WITH_DOCS, null)?.code).toBe("200");
  });
  it("pickPayment acepta status objeto o string/número plano", () => {
    expect(pickPayment({ payment: { id: "a", status: { code: 200 }, total: 1 } })?.code).toBe("200");
    expect(pickPayment({ uid: "b", status: "400", total: 1, reference: "r" })?.code).toBe("400");
    expect(pickPayment({ id: "c", status: 2, total: 1 })?.code).toBe("2");
    expect(pickPayment(null)).toBeNull();
    expect(pickPayment({ foo: 1 })).toBeNull();
  });
});

describe("mobbex: decisión", () => {
  const approved = pickPayment(WEBHOOK_APPROVED.data);
  it("aprobado + referencia + monto (requestedTotal) → approved", () => {
    expect(
      decideMobbex({ payment: approved, intentId: INTENT, expectedAmount: 145170, webhookType: "checkout" }),
    ).toEqual({ status: "approved", reason: "approved" });
  });
  it("monto distinto → no se toca (null)", () => {
    expect(
      decideMobbex({ payment: approved, intentId: INTENT, expectedAmount: 145169, webhookType: "checkout" }),
    ).toEqual({ status: null, reason: "amount_mismatch" });
  });
  it("requestedTotal manda sobre total (financiación sumada por Mobbex)", () => {
    const p = pickPayment({ payment: { id: "x", reference: INTENT, status: { code: "200" }, total: 120, requestedTotal: 100 } });
    expect(decideMobbex({ payment: p, intentId: INTENT, expectedAmount: 100, webhookType: "checkout" }).status).toBe("approved");
  });
  it("referencia de otro intent → null", () => {
    expect(
      decideMobbex({ payment: approved, intentId: "otro", expectedAmount: 145170, webhookType: "checkout" }),
    ).toEqual({ status: null, reason: "reference_mismatch" });
  });
  it("en espera → pending", () => {
    expect(
      decideMobbex({
        payment: pickPayment(WEBHOOK_CASH_WAITING.data),
        intentId: INTENT,
        expectedAmount: 1333,
        webhookType: "checkout",
      }).status,
    ).toBe("pending");
  });
  it("intento fallido con el checkout abierto → pending (el cliente puede reintentar)", () => {
    const p = pickPayment({ payment: { id: "f", reference: INTENT, status: { code: "400" }, total: 10 } });
    expect(decideMobbex({ payment: p, intentId: INTENT, expectedAmount: 10, webhookType: "checkout" })).toEqual({
      status: "pending",
      reason: "attempt_failed_checkout_open",
    });
  });
  it("checkout vencido sin pago aprobado → rejected", () => {
    expect(
      decideMobbex({
        payment: pickPayment(WEBHOOK_EXPIRED.data),
        intentId: INTENT,
        expectedAmount: 10,
        webhookType: "checkout:expired",
      }).status,
    ).toBe("rejected");
    expect(
      decideMobbex({ payment: null, intentId: INTENT, expectedAmount: 10, webhookType: "checkout:expired" }).status,
    ).toBe("rejected");
  });
  it("sin operación verificable → null", () => {
    expect(decideMobbex({ payment: null, intentId: INTENT, expectedAmount: 10, webhookType: "checkout" })).toEqual({
      status: null,
      reason: "operation_not_found",
    });
  });
});
