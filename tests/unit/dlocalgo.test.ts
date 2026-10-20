// dLocal Go (ADR-180): lógica pura de la Payments API. Sin red: el fetch se
// inyecta (nunca se hace un cobro real).
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DLOCALGO_BASE,
  amountMatches,
  authHeader,
  buildPaymentBody,
  classifyRefundResponse,
  createErrorCode,
  decideIntentUpdate,
  dlocalEnv,
  dlocalgoClient,
  expectedSignature,
  isProviderId,
  mapDlocalStatus,
  mapRefundStatus,
  parseCreds,
  parseNotification,
  parsePaymentResponse,
  parseSignatureHeader,
  paymentAmount,
  verifySignature,
  type DlocalCreds,
} from "@/supabase/functions/_shared/dlocalgo";
import { PROVIDER_MAX_TTL_MINUTES } from "@/modules/pending-charges/logic";

const INTENT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const PAY = "DP-54354";
const CREDS: DlocalCreds = { apiKey: "MyMerchantApiKey", secretKey: "MyMerchantSecretKey" };
const LINK = "https://checkout-sbx.dlocalgo.com/validate/3aYkAnBW91OVt0ELvQLKrrGC2dVC7Z59";

const res = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const payment = (over: Record<string, unknown> = {}) => ({
  id: PAY,
  amount: 1250.5,
  currency: "ARS",
  country: "AR",
  status: "PAID",
  order_id: INTENT,
  ...over,
});

describe("ambientes y credenciales", () => {
  it("hosts de la doc y switch Sandbox", () => {
    expect(DLOCALGO_BASE.sandbox).toBe("https://api-sbx.dlocalgo.com");
    expect(DLOCALGO_BASE.prod).toBe("https://api.dlocalgo.com");
    expect(dlocalEnv(true)).toBe("sandbox");
    expect(dlocalEnv(false)).toBe("prod");
    expect(dlocalEnv(undefined)).toBe("prod");
  });

  it("api_key + secret_key, sin espacios ni dos puntos en la API Key", () => {
    expect(parseCreds({ api_key: " k1 ", secret_key: "s1" })).toEqual({ apiKey: "k1", secretKey: "s1" });
    expect(parseCreds({ api_key: "k1" })).toBeNull();
    expect(parseCreds({ api_key: "a:b", secret_key: "s" })).toBeNull();
    expect(parseCreds(null)).toBeNull();
    expect(authHeader(CREDS)).toBe("Bearer MyMerchantApiKey:MyMerchantSecretKey");
  });

  it("ids de pago y devolución que no alteran el path", () => {
    expect(isProviderId("DP-54354")).toBe(true);
    expect(isProviderId("REF-213")).toBe(true);
    expect(isProviderId("../x")).toBe(false);
    expect(isProviderId("a")).toBe(false);
  });
});

describe("pago", () => {
  it("cuerpo en ARS con order_id = intent y URLs", () => {
    const body = buildPaymentBody({
      amount: 1250.499,
      description: "  Venta   NinjaPos ",
      orderId: INTENT,
      successUrl: "https://pos.soft.ninja/pagar/listo?estado=ok",
      backUrl: "https://pos.soft.ninja/pagar/listo?estado=error",
      notificationUrl: `https://hooks.soft.ninja/dlocalgo?intent=${INTENT}`,
    });
    expect(body).toMatchObject({ currency: "ARS", country: "AR", amount: 1250.5, order_id: INTENT, description: "Venta NinjaPos" });
    expect(String(body.notification_url)).toContain(INTENT);
  });

  it("monto mínimo propio", () => {
    expect(paymentAmount(0)).toEqual({ ok: false, error: "invalid_amount" });
    expect(paymentAmount(0.5)).toEqual({ ok: false, error: "dlocalgo_min_amount" });
    expect(paymentAmount(10)).toEqual({ ok: true, value: 10 });
  });

  it("respuesta: id + redirect_url https", () => {
    expect(parsePaymentResponse({ id: PAY, redirect_url: LINK, status: "PENDING" })).toEqual({
      id: PAY,
      redirectUrl: LINK,
      status: "PENDING",
    });
    expect(parsePaymentResponse({ id: PAY, redirect_url: "http://x" })).toBeNull();
    expect(parsePaymentResponse({ redirect_url: LINK })).toBeNull();
  });

  it("errores documentados", () => {
    expect(createErrorCode(400, "5016")).toBe("dlocalgo_min_amount");
    expect(createErrorCode(400, "5007")).toBe("dlocalgo_max_amount");
    expect(createErrorCode(403, "3001")).toBe("dlocalgo_auth_failed");
    expect(createErrorCode(500, null)).toBe("dlocalgo_error");
  });
});

describe("estados y antifraude", () => {
  it("mapeo de estados", () => {
    expect(mapDlocalStatus("PAID")).toBe("approved");
    expect(mapDlocalStatus("REJECTED")).toBe("rejected");
    expect(mapDlocalStatus("CANCELLED")).toBe("cancelled");
    expect(mapDlocalStatus("EXPIRED")).toBe("expired");
    expect(mapDlocalStatus("PENDING")).toBe("pending");
  });

  const exp = { amount: 1250.5, intentId: INTENT, paymentId: PAY };

  it("PAID + mismo pago + order_id + ARS + monto exacto = approved", () => {
    expect(decideIntentUpdate(payment(), exp)).toEqual({ status: "approved", state: "PAID" });
  });

  it("otro pago u otro order_id: no se toca", () => {
    expect(decideIntentUpdate(payment({ id: "DP-1" }), exp).reason).toBe("payment_mismatch");
    expect(decideIntentUpdate(payment({ order_id: "otro" }), exp).reason).toBe("reference_mismatch");
  });

  it("monto distinto u otra moneda: rejected", () => {
    expect(decideIntentUpdate(payment({ amount: 1250.49 }), exp)).toMatchObject({ status: "rejected", reason: "amount_mismatch" });
    expect(decideIntentUpdate(payment({ currency: "USD" }), exp)).toMatchObject({ status: "rejected", reason: "currency_mismatch" });
    expect(decideIntentUpdate(payment({ amount: undefined }), exp)).toMatchObject({ status: "pending", reason: "amount_not_reported" });
  });

  it("monto en string o número", () => {
    expect(amountMatches("100.00", 100)).toBe(true);
    expect(amountMatches(100, 100.004)).toBe(true);
    expect(amountMatches("abc", 100)).toBeNull();
  });
});

describe("notificación firmada", () => {
  const raw = '{"payment_id":"DP-283"}';

  it("cuerpo: sólo una pista", () => {
    expect(parseNotification(JSON.parse(raw))).toEqual({ paymentId: "DP-283", refundId: null });
    expect(parseNotification({ payment_id: "../../x" }).paymentId).toBeNull();
    expect(parseNotification("x")).toEqual({ paymentId: null, refundId: null });
  });

  it("header V2-HMAC-SHA256", () => {
    const sig = "b71712639e6d93e289e2ec0532a81ef27da72f875d81fdab2328ffffef90b833";
    expect(parseSignatureHeader(`V2-HMAC-SHA256, Signature: ${sig}`)).toBe(sig);
    expect(parseSignatureHeader("Bearer x")).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
  });

  it("firma = HMAC-SHA256(secret_key, api_key + cuerpo) como el ejemplo de la doc", async () => {
    const want = createHmac("sha256", CREDS.secretKey).update(`${CREDS.apiKey}${raw}`).digest("hex");
    expect(await expectedSignature(CREDS, raw)).toBe(want);
    expect(await verifySignature(CREDS, raw, `V2-HMAC-SHA256, Signature: ${want}`)).toBe(true);
    expect(await verifySignature(CREDS, raw.replace("283", "284"), `V2-HMAC-SHA256, Signature: ${want}`)).toBe(false);
    expect(await verifySignature({ ...CREDS, secretKey: "otra" }, raw, `V2-HMAC-SHA256, Signature: ${want}`)).toBe(false);
    expect(await verifySignature(CREDS, raw, null)).toBe(false);
  });
});

describe("devoluciones", () => {
  it("estados de la doc", () => {
    expect(mapRefundStatus("SUCCESS")).toBe("refunded");
    expect(mapRefundStatus("PENDING")).toBe("initiated");
    expect(mapRefundStatus("REJECTED")).toBe("failed");
    expect(mapRefundStatus("CANCELLED")).toBe("failed");
    expect(mapRefundStatus("?")).toBeNull();
  });

  it("resultado del POST /v1/refunds", () => {
    expect(classifyRefundResponse(200, { id: "REF-213", amount: 60, status: "PENDING" })).toEqual({
      state: "initiated",
      code: null,
      ref: "REF-213",
    });
    expect(classifyRefundResponse(200, { id: "REF-1", status: "SUCCESS" }).state).toBe("refunded");
    expect(classifyRefundResponse(404, { code: 4000 })).toEqual({ state: "failed", code: "4000", ref: null });
    expect(classifyRefundResponse(503, null).code).toBe("retry_503");
    expect(classifyRefundResponse(0, null).code).toBe("retry_network");
  });
});

describe("cliente HTTP", () => {
  it("crea el pago con Bearer api_key:secret_key en el host del ambiente", async () => {
    const f = vi.fn(async () => res(200, { id: PAY, redirect_url: LINK, status: "PENDING" }));
    const c = dlocalgoClient({ creds: CREDS, env: "sandbox", fetchImpl: f });
    const r = await c.createPayment({
      amount: 100,
      orderId: INTENT,
      successUrl: "https://a",
      backUrl: "https://b",
      notificationUrl: "https://c",
    });
    expect(r).toEqual({ ok: true, value: { id: PAY, redirectUrl: LINK, status: "PENDING" } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api-sbx.dlocalgo.com/v1/payments");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer MyMerchantApiKey:MyMerchantSecretKey");
  });

  it("probe: GET /v1/currency-exchanges; 403 = credenciales", async () => {
    const f = vi.fn(async () => res(403, { code: 3001, message: "Invalid Credentials." }));
    const r = await dlocalgoClient({ creds: CREDS, env: "prod", fetchImpl: f }).probe();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("3001");
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.dlocalgo.com/v1/currency-exchanges");
  });

  it("no consulta ids raros", async () => {
    const f = vi.fn();
    const r = await dlocalgoClient({ creds: CREDS, env: "prod", fetchImpl: f }).getPayment("../x");
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("tope de cobros en espera = 24 h del redirect_url", () => {
    expect(PROVIDER_MAX_TTL_MINUTES.dlocalgo).toBe(1440);
  });
});
