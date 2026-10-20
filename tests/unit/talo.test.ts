// Talo (ADR-175): lógica pura de la Payments API. Sin red: el fetch se
// inyecta (nunca se hace un cobro real).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  amountString,
  buildPaymentBody,
  buildRefundBody,
  checkAmount,
  classifyRefundResponse,
  clearTokenCache,
  decideIntentUpdate,
  isAuthFailure,
  parseCreatedPayment,
  parseCreds,
  parseTokenResponse,
  parseWebhook,
  planRefund,
  refundStatusByRef,
  taloClient,
  taloEnv,
  tokenExpiry,
  transferInfo,
  TALO_API_BASE,
  type TaloCreds,
} from "@/supabase/functions/_shared/talo";

const INTENT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const USER = "f61876b0-10a5-4e39-8e2c-17343b3fa1b6";
const PAY = `VAR-${USER}-${INTENT}`;
const CREDS: TaloCreds = { kind: "client", userId: USER, clientId: "A13NDKD3534JEM", clientSecret: "secret-abcdef" };

const res = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// Pago con la forma del GET /payments/{id} de la doc.
const payment = (over: Record<string, unknown> = {}, paid?: string) => ({
  message: "ok",
  error: false,
  code: 200,
  data: {
    id: PAY,
    external_id: INTENT,
    payment_status: "SUCCESS",
    price: { amount: 1500, currency: "ARS" },
    quotes: [{ currency: "ARS", network: "POLLUX", amount: "1500", address: "0000630500000060195375", alias: "talo.ago.1468" }],
    payment_url: "https://talo.com.ar/payments/" + PAY,
    expiration_timestamp: "2026-10-25T14:00:15.411Z",
    ...(paid !== undefined ? { transaction_fields: { total_paid: { amount: paid, currency: "ARS" } } } : {}),
    ...over,
  },
});

beforeEach(() => clearTokenCache());

describe("conexión", () => {
  it("parseCreds acepta las credenciales del comercio y el token de partner", () => {
    expect(parseCreds({ user_id: USER, client_id: "cid-123", client_secret: "sec-456" })).toEqual({
      kind: "client",
      userId: USER,
      clientId: "cid-123",
      clientSecret: "sec-456",
    });
    expect(parseCreds({ user_id: USER, access_token: "PAR-abc" })).toEqual({ kind: "partner", userId: USER, accessToken: "PAR-abc" });
    expect(parseCreds({ client_id: "a", client_secret: "b" })).toBeNull();
    expect(parseCreds({ user_id: "../x", client_id: "a", client_secret: "b" })).toBeNull();
    expect(parseCreds({ user_id: USER })).toBeNull();
  });

  it("ambiente por el switch Sandbox", () => {
    expect(taloEnv(true)).toBe("sandbox");
    expect(taloEnv(false)).toBe("prod");
    expect(TALO_API_BASE.sandbox).toBe("https://sandbox-api.talo.com.ar");
    expect(TALO_API_BASE.prod).toBe("https://api.talo.com.ar");
  });

  it("isAuthFailure", () => {
    expect(isAuthFailure(401)).toBe(true);
    expect(isAuthFailure(404)).toBe(true);
    expect(isAuthFailure(500)).toBe(false);
    expect(isAuthFailure(0)).toBe(false);
  });

  it("token: lee data.token y el vencimiento del JWT", () => {
    expect(parseTokenResponse({ message: "ok", error: false, data: { token: "TL-abc" } })).toBe("TL-abc");
    expect(parseTokenResponse({ data: {} })).toBeNull();
    const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url");
    expect(tokenExpiry(`TL-h.${payload}.s`)).toBe(2_000_000_000_000);
    expect(tokenExpiry("TL-qrdf892ljsdf")).toBeNull();
  });
});

describe("pago", () => {
  it("cuerpo del POST /payments/: ARS, sólo transferencia, external_id y webhook", () => {
    expect(
      buildPaymentBody({ userId: USER, amount: 1500.004, externalId: INTENT, webhookUrl: "https://hooks.soft.ninja/talo?intent=x", motive: "  Venta   NinjaPos " }),
    ).toEqual({
      user_id: USER,
      price: { amount: 1500, currency: "ARS" },
      payment_options: ["transfer"],
      external_id: INTENT,
      webhook_url: "https://hooks.soft.ninja/talo?intent=x",
      motive: "Venta NinjaPos",
    });
    expect(() => buildPaymentBody({ userId: USER, amount: 0, externalId: INTENT, webhookUrl: "x" })).toThrow("invalid_amount");
    expect(checkAmount(100_000_000)).toEqual({ ok: false, error: "talo_max_amount" });
  });

  it("respuesta del create: CVU y alias de quotes[0], con o sin envelope", () => {
    const body = {
      data: {
        id: PAY,
        payment_status: "PENDING",
        quotes: [{ cvu: "0000630500000060195375", alias: "talo.ago.1468" }],
        payment_url: "https://talo.com.ar/payments/x",
        expiration_timestamp: "2024-09-02T14:00:15.411Z",
      },
    };
    expect(parseCreatedPayment(body)).toEqual({
      id: PAY,
      paymentUrl: "https://talo.com.ar/payments/x",
      cvu: "0000630500000060195375",
      alias: "talo.ago.1468",
      expiresAt: "2024-09-02T14:00:15.411Z",
    });
    expect(parseCreatedPayment(body.data)?.id).toBe(PAY);
    expect(parseCreatedPayment({ data: { id: PAY, quotes: [] } })).toBeNull();
    expect(parseCreatedPayment({ data: { id: "../x", payment_url: "https://a" } })).toBeNull();
  });

  it("transferInfo lee address en el GET y descarta datos raros", () => {
    expect(transferInfo(payment())).toEqual({ cvu: "0000630500000060195375", alias: "talo.ago.1468" });
    expect(transferInfo({ data: { quotes: [{ address: "123", alias: "<script>" }] } })).toEqual({ cvu: null, alias: null });
  });
});

describe("decideIntentUpdate (siempre sobre el pago re-consultado)", () => {
  const exp = { amount: 1500, intentId: INTENT, paymentId: PAY };

  it("SUCCESS con el precio del intent → approved", () => {
    expect(decideIntentUpdate(payment({}, "1500"), exp)).toMatchObject({ status: "approved", state: "SUCCESS", paid: 1500 });
    expect(decideIntentUpdate(payment(), exp).status).toBe("approved");
  });

  it("precio distinto o total recibido distinto → rejected (amount_mismatch)", () => {
    expect(decideIntentUpdate(payment({ price: { amount: 1000, currency: "ARS" } }), exp)).toMatchObject({
      status: "rejected",
      reason: "amount_mismatch",
    });
    expect(decideIntentUpdate(payment({}, "1400"), exp)).toMatchObject({ status: "rejected", reason: "amount_mismatch" });
    expect(decideIntentUpdate(payment({ price: { amount: 1500, currency: "USDT" } }), exp).status).toBe("rejected");
  });

  it("OVERPAID → approved con la diferencia", () => {
    expect(decideIntentUpdate(payment({ payment_status: "OVERPAID" }, "1700.5"), exp)).toMatchObject({
      status: "approved",
      state: "OVERPAID",
      overpaid: 200.5,
    });
  });

  it("UNDERPAID → sigue pending con lo que falta", () => {
    expect(decideIntentUpdate(payment({ payment_status: "UNDERPAID" }, "1000"), exp)).toMatchObject({
      status: "pending",
      state: "UNDERPAID",
      paid: 1000,
      missing: 500,
    });
  });

  it("EXPIRED → cancelled; PENDING → pending", () => {
    expect(decideIntentUpdate(payment({ payment_status: "EXPIRED" }), exp).status).toBe("cancelled");
    expect(decideIntentUpdate(payment({ payment_status: "PENDING" }), exp).status).toBe("pending");
  });

  it("otro pago u otra referencia → no cuenta", () => {
    expect(decideIntentUpdate(payment({ id: "VAR-otro-pago" }), exp)).toMatchObject({ status: "pending", reason: "payment_mismatch" });
    expect(decideIntentUpdate(payment({ external_id: "otro" }), exp)).toMatchObject({ status: "pending", reason: "reference_mismatch" });
    expect(decideIntentUpdate(null, exp).status).toBe("pending");
  });
});

describe("webhook", () => {
  it("sólo toma el paymentId como pista", () => {
    expect(parseWebhook({ message: "Pago Actualizado", paymentId: PAY, externalId: INTENT })).toEqual({ paymentId: PAY, externalId: INTENT });
    expect(parseWebhook({ paymentId: "../../x" })).toBeNull();
    expect(parseWebhook("hola")).toBeNull();
  });
});

describe("devolución", () => {
  it("planRefund: total, saldo después de otra devolución y diferencia de un OVERPAID", () => {
    expect(planRefund(payment({}, "1500"), "full", 1500)).toEqual({ ok: true, type: "FULL", amount: 1500 });
    const partial = payment({ transaction_fields: { total_paid: { amount: "1700" }, total_refunded: { amount: "200" } } });
    expect(planRefund(partial, "full", 1500)).toEqual({ ok: true, type: "PARTIAL", amount: 1500 });
    expect(planRefund(payment({ payment_status: "OVERPAID" }, "1700"), "excess", 1500)).toEqual({ ok: true, type: "PARTIAL", amount: 200 });
    expect(planRefund(partial, "excess", 1500)).toEqual({ ok: false, error: "no_excess" });
    expect(planRefund(payment(), "full", 1500)).toEqual({ ok: false, error: "not_paid" });
  });

  it("cuerpo: blame obligatorio, amount como string sólo en PARTIAL", () => {
    expect(buildRefundBody({ type: "FULL", amount: 1500, userId: USER, blameMail: "duenio@negocio.com" })).toEqual({
      refund_type: "FULL",
      currency: "ARS",
      blame: { team_id: "ninjasoft-pos", mail: "duenio@negocio.com" },
      user_id: USER,
    });
    expect(buildRefundBody({ type: "PARTIAL", amount: 200.5, userId: USER, blameMail: "a@b.c" }).amount).toBe("200.50");
    expect(amountString(1000)).toBe("1000.00");
  });

  it("clasifica la respuesta por el último refund del pago", () => {
    const ok = { message: "ok", error: false, code: 200, data: { refunds: [{ refund_status: "SUCCESS", transaction_ids: ["t-1"] }] } };
    expect(classifyRefundResponse(200, ok)).toEqual({ state: "refunded", code: null, ref: "t-1" });
    const pend = { data: { refunds: [{ refund_status: "PENDING", creation_timestamp: "2026-07-15T16:19:02.379Z" }] } };
    expect(classifyRefundResponse(200, pend)).toEqual({ state: "initiated", code: null, ref: "2026-07-15T16:19:02.379Z" });
    expect(classifyRefundResponse(400, { error: true, message: "Monto excedido" })).toEqual({ state: "failed", code: "Monto excedido", ref: null });
    expect(classifyRefundResponse(502, null).code).toBe("retry_502");
    expect(classifyRefundResponse(0, null).code).toBe("retry_network");
  });

  it("refundStatusByRef sigue una devolución en curso", () => {
    const p = { data: { refunds: [{ refund_status: "SUCCESS", transaction_ids: ["t-9"] }] } };
    expect(refundStatusByRef(p, "t-9")).toBe("refunded");
    expect(refundStatusByRef(p, "t-1")).toBeNull();
  });
});

describe("cliente HTTP", () => {
  it("token con user_id en el path, create sin Authorization, GET con Bearer", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith(`/users/${USER}/tokens`)) return res(200, { data: { token: "TL-tok" } });
      if (url.endsWith("/payments/")) {
        return res(200, { data: { id: PAY, quotes: [{ cvu: "0000630500000060195375", alias: "a.b.c" }], payment_url: "https://talo.com.ar/p" } });
      }
      return res(200, payment());
    });
    const c = taloClient({ creds: CREDS, env: "sandbox", fetchImpl });
    const created = await c.createPayment({ amount: 1500, externalId: INTENT, webhookUrl: "https://h/talo" });
    expect(created.ok && created.value.cvu).toBe("0000630500000060195375");
    const create = calls.find((x) => x.url.endsWith("/payments/"))!;
    expect(create.url).toBe("https://sandbox-api.talo.com.ar/payments/");
    expect((create.init?.headers as Record<string, string>).Authorization).toBeUndefined();

    const got = await c.getPayment(PAY);
    expect(got.ok).toBe(true);
    const get = calls[calls.length - 1]!;
    expect((get.init?.headers as Record<string, string>).Authorization).toBe("Bearer TL-tok");
    const tok = calls.find((x) => x.url.includes("/tokens"))!;
    expect(JSON.parse(String(tok.init?.body))).toEqual({ client_id: "A13NDKD3534JEM", client_secret: "secret-abcdef" });
  });

  it("401 renueva el token una vez", async () => {
    let tokens = 0;
    let gets = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/tokens")) {
        tokens++;
        return res(200, { data: { token: `TL-${tokens}` } });
      }
      gets++;
      return gets === 1 ? res(401, { error: true, message: "expired" }) : res(200, payment());
    });
    const r = await taloClient({ creds: CREDS, env: "prod", fetchImpl }).getPayment(PAY);
    expect(r.ok).toBe(true);
    expect(tokens).toBe(2);
  });

  it("credenciales rechazadas: el error no trae el cuerpo crudo", async () => {
    const fetchImpl = vi.fn(async () => res(400, { error: true, message: "Invalid credentials", code: 400 }));
    const r = await taloClient({ creds: CREDS, env: "prod", fetchImpl }).token(true);
    expect(r).toEqual({ ok: false, httpStatus: 400, detail: "Invalid credentials" });
  });

  it("token de partner: va directo como Bearer", async () => {
    const fetchImpl = vi.fn(async () => res(200, payment()));
    const c = taloClient({ creds: { kind: "partner", userId: USER, accessToken: "PAR-x" }, env: "prod", fetchImpl });
    await c.getPayment(PAY);
    const init = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init[1].headers as Record<string, string>).Authorization).toBe("Bearer PAR-x");
  });
});
