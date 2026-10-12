import { describe, expect, it, vi } from "vitest";
import {
  NAVE_AUDIENCE_DEFAULT,
  approvedPaymentIdFromRequest,
  buildPaymentRequest,
  createNaveClient,
  evaluatePayment,
  formatNaveAmount,
  naveApiBase,
  naveAuthUrl,
  naveEnv,
  parseNotification,
  parsePointTerminals,
  paymentRequestOutcome,
  resolvePaymentCheckUrl,
} from "@/supabase/functions/_shared/nave";

const INTENT = "7a20779f-5d3e-4dc4-9c3f-fb778d12134b";
const PAY = "534eb791-de67-4a23-9667-09e1a2406103";
const PR = "cbdcf5ef-6ee2-4dc7-b4ad-e4cf507d6239";

describe("ambientes Nave", () => {
  it("sandbox por el switch del medio, prod por defecto", () => {
    expect(naveEnv(true)).toBe("sandbox");
    expect(naveEnv(false)).toBe("prod");
    expect(naveEnv(null)).toBe("prod");
  });
  it("auth en apinaranja (homo / prod)", () => {
    expect(naveAuthUrl("sandbox")).toBe(
      "https://homoservices.apinaranja.com/security-ms/api/security/auth0/b2b/m2msPrivate",
    );
    expect(naveAuthUrl("prod")).toBe(
      "https://services.apinaranja.com/security-ms/api/security/auth0/b2b/m2msPrivate",
    );
  });
  it("API: QR en api-sandbox, Point en e3-api; prod siempre api.ranty.io", () => {
    expect(naveApiBase("sandbox", "qr")).toBe("https://api-sandbox.ranty.io");
    expect(naveApiBase("sandbox", "point")).toBe("https://e3-api.ranty.io");
    expect(naveApiBase("prod", "qr")).toBe("https://api.ranty.io");
    expect(naveApiBase("prod", "point")).toBe("https://api.ranty.io");
  });
  it("audience por defecto de merchants", () => {
    expect(NAVE_AUDIENCE_DEFAULT).toBe("https://naranja.com/ranty/merchants/api");
  });
});

describe("formatNaveAmount", () => {
  it("siempre dos decimales como string", () => {
    expect(formatNaveAmount(25)).toBe("25.00");
    expect(formatNaveAmount(1234.5)).toBe("1234.50");
    expect(formatNaveAmount(0.1 + 0.2)).toBe("0.30");
  });
  it("rechaza montos inválidos", () => {
    expect(() => formatNaveAmount(0)).toThrow();
    expect(() => formatNaveAmount(-1)).toThrow();
    expect(() => formatNaveAmount(Number.NaN)).toThrow();
  });
});

describe("buildPaymentRequest", () => {
  it("arma el body con external_payment_id, pos_id, monto string y producto", () => {
    const body = buildPaymentRequest({
      externalPaymentId: INTENT,
      posId: "pos-1",
      amount: 1500,
      title: "Venta NinjaPos",
      durationSeconds: 900,
      callbackUrl: "https://x.supabase.co/functions/v1/nave_webhook?view=return",
    });
    expect(body).toEqual({
      external_payment_id: INTENT,
      seller: { pos_id: "pos-1" },
      transactions: [
        {
          amount: { currency: "ARS", value: "1500.00" },
          products: [
            {
              name: "Venta NinjaPos",
              description: "Venta NinjaPos",
              quantity: 1,
              unit_price: { currency: "ARS", value: "1500.00" },
            },
          ],
        },
      ],
      duration_time: 900,
      additional_info: {
        callback_url: "https://x.supabase.co/functions/v1/nave_webhook?view=return",
      },
    });
  });
  it("omite additional_info sin callback y no manda buyer", () => {
    const body = buildPaymentRequest({
      externalPaymentId: INTENT,
      posId: "pos-1",
      amount: 10,
      title: "",
      durationSeconds: 300,
    }) as Record<string, unknown>;
    expect(body.additional_info).toBeUndefined();
    expect(body.buyer).toBeUndefined();
    const tx = (body.transactions as { products: { name: string }[] }[])[0]!;
    expect(tx.products[0]!.name).toBe("Venta");
  });
  it("external_payment_id de más de 36 caracteres es inválido", () => {
    expect(() =>
      buildPaymentRequest({
        externalPaymentId: "x".repeat(37),
        posId: "p",
        amount: 1,
        title: "t",
        durationSeconds: 60,
      }),
    ).toThrow();
  });
});

describe("parseNotification", () => {
  it("exige payment_id, payment_check_url y external_payment_id", () => {
    expect(
      parseNotification({
        payment_id: PAY,
        payment_check_url: `https://api.ranty.io/integrations/payments/${PAY}`,
        external_payment_id: INTENT,
      }),
    ).toEqual({
      kind: "payment",
      paymentId: PAY,
      paymentCheckUrl: `https://api.ranty.io/integrations/payments/${PAY}`,
      externalPaymentId: INTENT,
    });
    expect(parseNotification({ payment_id: PAY, external_payment_id: INTENT })).toBeNull();
    expect(parseNotification({ payment_check_url: "x", external_payment_id: INTENT })).toBeNull();
    expect(parseNotification(null)).toBeNull();
    expect(parseNotification("hola")).toBeNull();
  });
  it("reconoce la baja de una intención (Point)", () => {
    expect(
      parseNotification({
        payment_request_id: PR,
        status: "DISABLED",
        disabled_reason: "low battery",
        external_payment_id: INTENT,
      }),
    ).toEqual({
      kind: "payment_request",
      paymentRequestId: PR,
      externalPaymentId: INTENT,
    });
  });
});

describe("resolvePaymentCheckUrl (anti-SSRF)", () => {
  const n = (url: string, id = PAY) => ({
    kind: "payment" as const,
    paymentId: id,
    paymentCheckUrl: url,
    externalPaymentId: INTENT,
  });
  it("acepta la URL exacta del host Nave del ambiente", () => {
    expect(resolvePaymentCheckUrl(n(`https://api.ranty.io/integrations/payments/${PAY}`), "prod", "qr")).toBe(
      `https://api.ranty.io/integrations/payments/${PAY}`,
    );
    expect(
      resolvePaymentCheckUrl(n(`https://api-sandbox.ranty.io/integrations/payments/${PAY}`), "sandbox", "qr"),
    ).toBe(`https://api-sandbox.ranty.io/integrations/payments/${PAY}`);
    expect(
      resolvePaymentCheckUrl(n(`https://e3-api.ranty.io/integrations/payments/${PAY}`), "sandbox", "point"),
    ).toBe(`https://e3-api.ranty.io/integrations/payments/${PAY}`);
  });
  it("host ajeno, http, puerto, userinfo o path raro → construye desde la base confiable", () => {
    const trusted = `https://api.ranty.io/integrations/payments/${PAY}`;
    for (const bad of [
      `https://evil.com/integrations/payments/${PAY}`,
      `http://api.ranty.io/integrations/payments/${PAY}`,
      `https://api.ranty.io:8443/integrations/payments/${PAY}`,
      `https://user:pw@api.ranty.io/integrations/payments/${PAY}`,
      `https://api.ranty.io.evil.com/integrations/payments/${PAY}`,
      `https://api.ranty.io/integrations/payments/${PAY}/../../admin`,
      `https://api.ranty.io/integrations/payments/otro-id`,
      `https://169.254.169.254/latest/meta-data`,
      `api.ranty.io/integrations/payments/${PAY}`,
      `https://api-sandbox.ranty.io/integrations/payments/${PAY}`, // host de OTRO ambiente
    ]) {
      expect(resolvePaymentCheckUrl(n(bad), "prod", "qr"), bad).toBe(trusted);
    }
  });
  it("payment_id que no es un id seguro → null (no se llama a nada)", () => {
    expect(resolvePaymentCheckUrl(n("https://api.ranty.io/x", "../../etc"), "prod", "qr")).toBeNull();
    expect(resolvePaymentCheckUrl(n("https://api.ranty.io/x", ""), "prod", "qr")).toBeNull();
  });
});

describe("evaluatePayment", () => {
  const base = {
    id: PAY,
    external_payment_id: INTENT,
    status: { name: "APPROVED", reason_code: "transaction_successful" },
    transactions: [{ transaction_type: "PURCHASE", amount: { currency: "ARS", value: "1500.00" } }],
    payment_method: { card_type: "DEBIT", type: "card_payment" },
    payment_request: { id: PR },
  };
  const exp = { intentId: INTENT, amount: 1500, paymentRequestId: PR };

  it("APPROVED + monto exacto + correlación → approved (con tipo de tarjeta)", () => {
    expect(evaluatePayment(base, exp)).toMatchObject({
      outcome: "approved",
      status: "APPROVED",
      paymentId: PAY,
      cardType: "debit",
    });
    expect(
      evaluatePayment({ ...base, payment_method: { card_type: "CREDIT" } }, exp).cardType,
    ).toBe("credit");
  });
  it("monto distinto → mismatch (nunca se acredita)", () => {
    expect(
      evaluatePayment(
        { ...base, transactions: [{ transaction_type: "PURCHASE", amount: { value: "1499.00" } }] },
        exp,
      ).outcome,
    ).toBe("mismatch");
  });
  it("la propina no cuenta: compara amount (sin tip)", () => {
    expect(
      evaluatePayment(
        {
          ...base,
          transactions: [
            {
              transaction_type: "PURCHASE",
              amount: { value: "1500.00" },
              tip_amount: { value: "100.00" },
              total_amount: { value: "1600.00" },
            },
          ],
        },
        exp,
      ).outcome,
    ).toBe("approved");
  });
  it("external_payment_id de otro intent → mismatch", () => {
    expect(evaluatePayment({ ...base, external_payment_id: "otro" }, exp).outcome).toBe("mismatch");
  });
  it("sin monto en la respuesta: sólo aprueba si la payment_request es la nuestra", () => {
    const noTx = { ...base, transactions: undefined };
    expect(evaluatePayment(noTx, exp).outcome).toBe("approved");
    expect(evaluatePayment({ ...noTx, payment_request: { id: "otra" } }, exp).outcome).toBe(
      "mismatch",
    );
    expect(evaluatePayment({ ...noTx, payment_request: undefined }, exp).outcome).toBe("mismatch");
  });
  it("PENDING sigue pendiente, REJECTED rechaza, post-pago y desconocidos se preservan", () => {
    expect(evaluatePayment({ ...base, status: { name: "PENDING" } }, exp).outcome).toBe("pending");
    expect(evaluatePayment({ ...base, status: { name: "REJECTED", reason_code: "denied" } }, exp)).toMatchObject({
      outcome: "rejected",
      reasonCode: "denied",
    });
    for (const s of ["CANCELLED", "REFUNDED", "PURCHASE_REVERSED", "CHARGEBACK_REVIEW", "CHARGED_BACK", "RARO"]) {
      expect(evaluatePayment({ ...base, status: { name: s } }, exp)).toMatchObject({
        outcome: "other",
        status: s,
      });
    }
  });
  it("respuesta vacía o rota → other (no rompe)", () => {
    expect(evaluatePayment(null, exp).outcome).toBe("other");
    expect(evaluatePayment({}, exp).outcome).toBe("other");
  });
  it("QR pagado en el Point (transferencia) cuenta como débito", () => {
    expect(
      evaluatePayment({ ...base, payment_method: { type: "transfer" } }, exp).cardType,
    ).toBe("debit");
  });
});

describe("paymentRequestOutcome + approvedPaymentIdFromRequest", () => {
  it("devuelve el payment aprobado de los intentos", () => {
    expect(
      approvedPaymentIdFromRequest({
        payment_attempts: {
          payments: [
            { payment_id: "a", status: "REJECTED" },
            { payment_id: PAY, status: "APPROVED" },
          ],
        },
      }),
    ).toBe(PAY);
    expect(approvedPaymentIdFromRequest({})).toBeNull();
    expect(approvedPaymentIdFromRequest(null)).toBeNull();
  });
  it("mapea estados de la intención por canal", () => {
    expect(paymentRequestOutcome({ status: { name: "PENDING" } }, "qr")).toBe("pending");
    expect(paymentRequestOutcome({ status: { name: "PROCESSED" } }, "point")).toBe("pending");
    expect(paymentRequestOutcome({ status: { name: "EXPIRED" } }, "qr")).toBe("cancelled");
    expect(paymentRequestOutcome({ status: { name: "DISABLED" } }, "point")).toBe("cancelled");
    expect(paymentRequestOutcome({ status: { name: "BLOCKED" } }, "qr")).toBe("cancelled");
    // QR: el cliente puede reintentar con otro medio; Point: hay que crear otra.
    expect(paymentRequestOutcome({ status: { name: "FAILURE_PROCESSED" } }, "qr")).toBe("pending");
    expect(paymentRequestOutcome({ status: { name: "FAILURE_PROCESSED" } }, "point")).toBe("rejected");
    // SUCCESS_PROCESSED NO acredita: hay que verificar el Payment.
    expect(paymentRequestOutcome({ status: { name: "SUCCESS_PROCESSED" } }, "qr")).toBe("check_payment");
    // Algunos ejemplos traen status como string.
    expect(paymentRequestOutcome({ status: "DISABLED" }, "point")).toBe("cancelled");
    expect(paymentRequestOutcome({}, "qr")).toBe("pending");
  });
});

describe("parsePointTerminals", () => {
  it("acepta ids sueltos o 'Nombre: id', separados por coma o renglón", () => {
    expect(
      parsePointTerminals(
        "Caja 1: 08d1118b-2bfa-4a7e-bb46-c1e61f1956e1\n43e0e11c-8d63-457f-b3f9-ff3ba3bfdc4a, ",
      ),
    ).toEqual([
      { id: "08d1118b-2bfa-4a7e-bb46-c1e61f1956e1", label: "Caja 1" },
      { id: "43e0e11c-8d63-457f-b3f9-ff3ba3bfdc4a", label: "Terminal 2" },
    ]);
  });
  it("vacío o basura → lista vacía, sin duplicados", () => {
    expect(parsePointTerminals(undefined)).toEqual([]);
    expect(parsePointTerminals("  ,\n ")).toEqual([]);
    expect(parsePointTerminals("abc-1,abc-1")).toEqual([{ id: "abc-1", label: "Terminal 1" }]);
    expect(parsePointTerminals("<script>")).toEqual([]);
  });
});

describe("createNaveClient (token + 401)", () => {
  const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  function setup(responses: Response[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const r = responses.shift();
      if (!r) throw new Error("sin respuesta");
      return r;
    });
    const client = createNaveClient({
      env: "sandbox",
      clientId: "cid",
      clientSecret: "secret",
      audience: NAVE_AUDIENCE_DEFAULT,
      fetchFn: fetchFn as unknown as typeof fetch,
      tokenCache: new Map(),
    });
    return { client, calls };
  }

  it("autentica una vez y reutiliza el token", async () => {
    const { client, calls } = setup([
      ok({ access_token: "T1", expires_in: "86400", token_type: "Bearer" }),
      ok({ a: 1 }),
      ok({ b: 2 }),
    ]);
    const r1 = await client.request("GET", "https://api-sandbox.ranty.io/integrations/payments/x");
    const r2 = await client.request("GET", "https://api-sandbox.ranty.io/integrations/payments/y");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(naveAuthUrl("sandbox"));
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      client_id: "cid",
      client_secret: "secret",
      audience: NAVE_AUDIENCE_DEFAULT,
    });
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer T1");
  });

  it("401 → descarta el token, re-autentica y reintenta UNA vez", async () => {
    const { client, calls } = setup([
      ok({ access_token: "T1", expires_in: "86400" }),
      ok({}, 401),
      ok({ access_token: "T2", expires_in: "86400" }),
      ok({ ok: true }),
    ]);
    const r = await client.request("GET", "https://api-sandbox.ranty.io/integrations/payments/x");
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(4);
    expect((calls[3]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer T2");
  });

  it("401 dos veces → devuelve el 401 sin loop", async () => {
    const { client, calls } = setup([
      ok({ access_token: "T1", expires_in: "86400" }),
      ok({}, 401),
      ok({ access_token: "T2", expires_in: "86400" }),
      ok({}, 401),
    ]);
    const r = await client.request("GET", "https://api-sandbox.ranty.io/integrations/payments/x");
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(4);
  });

  it("credenciales inválidas → error nave_auth_failed sin exponer el secreto", async () => {
    const { client } = setup([ok({ error: "access_denied" }, 403)]);
    await expect(
      client.request("GET", "https://api-sandbox.ranty.io/integrations/payments/x"),
    ).rejects.toThrow("nave_auth_failed");
    await client
      .request("GET", "https://api-sandbox.ranty.io/integrations/payments/x")
      .catch((e: Error) => expect(e.message).not.toContain("secret"));
  });

  it("manda el body JSON en POST", async () => {
    const { client, calls } = setup([ok({ access_token: "T1", expires_in: 86400 }), ok({ id: PR })]);
    await client.request("POST", "https://api-sandbox.ranty.io/integrations/payment_requests/ecommerce", {
      a: 1,
    });
    expect(calls[1]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ a: 1 });
  });
});
