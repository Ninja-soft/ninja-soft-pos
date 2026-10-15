// Ualá Bis (ADR-143): lógica pura de la API Cobros Online v2. Sin red: el
// fetch se inyecta (nunca se hace un cobro real).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  amountMatches,
  buildOrderBody,
  classifyRefundResponse,
  clearTokenCache,
  decideIntentUpdate,
  isAuthFailure,
  mapUalaStatus,
  orderAmount,
  parseCreds,
  parseOrderResponse,
  parseTokenResponse,
  parseWebhook,
  refundStateFromOrder,
  ualabisClient,
  ualabisEnv,
  UALABIS_AUTH_BASE,
  UALABIS_CHECKOUT_BASE,
  type UalaCreds,
} from "@/supabase/functions/_shared/ualabis";

const INTENT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const ORDER = "613d8938-8dab-41fd-9905-09d52e5312d0";
const CREDS: UalaCreds = { username: "kiosco", clientId: "client-123456", clientSecret: "secret-abcdef" };

const res = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const order = (over: Record<string, unknown> = {}) => ({
  uuid: ORDER,
  external_reference: INTENT,
  status: "APPROVED",
  amount: 1250.5,
  ...over,
});

beforeEach(() => clearTokenCache());

describe("ambientes y credenciales", () => {
  it("el switch Sandbox elige stage", () => {
    expect(ualabisEnv(true)).toBe("stage");
    expect(ualabisEnv(false)).toBe("prod");
    expect(ualabisEnv(null)).toBe("prod");
    expect(UALABIS_AUTH_BASE.stage).toBe("https://auth.stage.developers.ar.ua.la/v2/api");
    expect(UALABIS_CHECKOUT_BASE.prod).toBe("https://checkout.developers.ar.ua.la/v2/api");
  });

  it("parseCreds exige las tres claves", () => {
    expect(parseCreds({ username: " kiosco ", client_id: "c", client_secret_id: "s" })).toEqual({
      username: "kiosco",
      clientId: "c",
      clientSecret: "s",
    });
    expect(parseCreds({ username: "k", client_id: "c" })).toBeNull();
    expect(parseCreds(null)).toBeNull();
    expect(parseCreds({ username: "k".repeat(201), client_id: "c", client_secret_id: "s" })).toBeNull();
  });
});

describe("montos", () => {
  it("la orden viaja en PESOS como string (cobro real: centavos cobraban x100)", () => {
    expect(orderAmount(30.21)).toEqual({ ok: true, value: "30.21" });
    expect(orderAmount(1250.5)).toEqual({ ok: true, value: "1250.50" });
    expect(orderAmount(0.1 + 0.2 + 99.7)).toEqual({ ok: true, value: "100" });
    expect(orderAmount(100)).toEqual({ ok: true, value: "100" });
  });

  it("respeta el mínimo de $25 y el máximo de $9.999.999", () => {
    expect(orderAmount(24.99)).toEqual({ ok: false, error: "ualabis_min_amount" });
    expect(orderAmount(25)).toEqual({ ok: true, value: "25" });
    expect(orderAmount(9_999_999)).toEqual({ ok: true, value: "9999999" });
    expect(orderAmount(10_000_000)).toEqual({ ok: false, error: "ualabis_max_amount" });
    expect(orderAmount(-1)).toEqual({ ok: false, error: "invalid_amount" });
    expect(orderAmount(Number.NaN)).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("el monto informado vale sólo en pesos (nunca como centavos)", () => {
    expect(amountMatches(125050, 1250.5)).toBe(false);
    expect(amountMatches("10000", 100)).toBe(false);
    expect(amountMatches(1250.5, 1250.5)).toBe(true);
    expect(amountMatches("1250.50", 1250.5)).toBe(true);
    expect(amountMatches(125000, 1250.5)).toBe(false);
    expect(amountMatches(undefined, 10)).toBeNull();
    expect(amountMatches("diez", 10)).toBeNull();
  });

  it("buildOrderBody arma el cuerpo de la doc y recorta la descripción", () => {
    const b = buildOrderBody({
      amount: 1500,
      description: "  Venta   NinjaPos  ",
      callbackSuccess: "https://hooks.soft.ninja/ualabis?view=success",
      callbackFail: "https://hooks.soft.ninja/ualabis?view=failed",
      notificationUrl: `https://hooks.soft.ninja/ualabis?intent=${INTENT}`,
      externalReference: INTENT,
    });
    expect(b).toEqual({
      amount: "1500",
      description: "Venta NinjaPos",
      callback_success: "https://hooks.soft.ninja/ualabis?view=success",
      callback_fail: "https://hooks.soft.ninja/ualabis?view=failed",
      notification_url: `https://hooks.soft.ninja/ualabis?intent=${INTENT}`,
      external_reference: INTENT,
    });
    expect(() =>
      buildOrderBody({ amount: 10, callbackSuccess: "", callbackFail: "", notificationUrl: "", externalReference: INTENT }),
    ).toThrow("ualabis_min_amount");
  });
});

describe("respuestas", () => {
  it("token", () => {
    expect(parseTokenResponse({ access_token: "tk", expires_in: 86400, token_type: "Bearer" })).toEqual({
      token: "tk",
      expiresIn: 86400,
    });
    expect(parseTokenResponse({})).toBeNull();
  });

  it("orden creada: uuid y checkout_link https", () => {
    expect(
      parseOrderResponse({
        uuid: ORDER,
        status: "PENDING",
        links: { checkout_link: "https://uala-checkout.com/orders/abc", success: "x", failed: "y" },
      }),
    ).toEqual({ uuid: ORDER, checkoutLink: "https://uala-checkout.com/orders/abc", status: "PENDING" });
    expect(parseOrderResponse({ uuid: ORDER, links: { checkout_link: "http://inseguro" } })).toBeNull();
    expect(parseOrderResponse({ uuid: "../../x", links: { checkout_link: "https://a" } })).toBeNull();
  });
});

describe("mapeo de estados", () => {
  it.each([
    ["APPROVED", "approved"],
    ["PROCESSED", "approved"],
    ["PROCCESED", "approved"],
    ["processed", "approved"],
    ["REJECTED", "rejected"],
    ["REFUNDED", "cancelled"],
    ["PENDING", "pending"],
    ["", "pending"],
    [undefined, "pending"],
  ])("%s → %s", (input, out) => {
    expect(mapUalaStatus(input)).toBe(out);
  });
});

describe("decideIntentUpdate (orden re-consultada)", () => {
  const exp = { amount: 1250.5, intentId: INTENT, orderUuid: ORDER };

  it("aprueba con la orden propia, la referencia y el monto exacto", () => {
    expect(decideIntentUpdate(order(), exp)).toEqual({ status: "approved", state: "APPROVED" });
    expect(decideIntentUpdate(order({ status: "PROCESSED" }), exp).status).toBe("approved");
  });

  it("no acredita una orden ajena ni otra referencia", () => {
    expect(decideIntentUpdate(order({ uuid: "11111111-2222-4333-8444-555555555555" }), exp)).toMatchObject({
      status: "pending",
      reason: "order_mismatch",
    });
    expect(decideIntentUpdate(order({ external_reference: "otra" }), exp)).toMatchObject({
      status: "pending",
      reason: "reference_mismatch",
    });
  });

  it("monto distinto → rechazado; sin monto → sigue pendiente", () => {
    expect(decideIntentUpdate(order({ amount: 100 }), exp)).toMatchObject({ status: "rejected", reason: "amount_mismatch" });
    expect(decideIntentUpdate(order({ amount: undefined }), exp)).toMatchObject({
      status: "pending",
      reason: "amount_not_reported",
    });
  });

  it("rechazada y pendiente pasan tal cual", () => {
    expect(decideIntentUpdate(order({ status: "REJECTED" }), exp).status).toBe("rejected");
    expect(decideIntentUpdate(order({ status: "PENDING" }), exp).status).toBe("pending");
    expect(decideIntentUpdate(null, exp).status).toBe("pending");
  });
});

describe("webhook (sin firma: sólo una pista)", () => {
  it("lee el uuid y descarta lo que no sirve", () => {
    expect(parseWebhook({ uuid: ORDER, external_reference: INTENT, status: "approved", api_version: "2" })).toEqual({
      uuid: ORDER,
      externalReference: INTENT,
      status: "APPROVED",
    });
    expect(parseWebhook({ uuid: "../orders" })).toBeNull();
    expect(parseWebhook({})).toBeNull();
    expect(parseWebhook("x")).toBeNull();
  });

  it("devolución: REFUNDED por la orden; NOT_REFUNDED sólo si sigue pagada", () => {
    expect(refundStateFromOrder(order({ status: "REFUNDED" }), "NOT_REFUNDED")).toBe("refunded");
    expect(refundStateFromOrder(order(), "NOT_REFUNDED")).toBe("not_refunded");
    expect(refundStateFromOrder(order(), "REFUNDED")).toBeNull();
    expect(refundStateFromOrder(order({ status: "PENDING" }), "NOT_REFUNDED")).toBeNull();
  });

  it("clasifica la respuesta del POST /refund", () => {
    expect(classifyRefundResponse(200, { status: "INITIATED" })).toEqual({ state: "initiated", code: null });
    expect(classifyRefundResponse(400, { code: "request_error", message: "The order is not valid to refund." })).toEqual({
      state: "failed",
      code: "request_error",
    });
    expect(classifyRefundResponse(500, null)).toEqual({ state: "failed", code: "retry_500" });
    expect(classifyRefundResponse(0, null)).toEqual({ state: "failed", code: "retry_network" });
    expect(isAuthFailure(401)).toBe(true);
    expect(isAuthFailure(500)).toBe(false);
  });
});

describe("cliente HTTP (fetch simulado)", () => {
  it("pide token una vez, crea la orden con Bearer y cachea el token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/token")) return res(200, { access_token: "tk-1", expires_in: 86400 });
      if (url.endsWith("/checkout"))
        return res(200, { uuid: ORDER, status: "PENDING", links: { checkout_link: "https://uala-checkout.com/o/1" } });
      return res(200, order());
    });
    const c = ualabisClient({ creds: CREDS, env: "stage", fetchImpl });
    const created = await c.createOrder({
      amount: 1250.5,
      callbackSuccess: "https://h/s",
      callbackFail: "https://h/f",
      notificationUrl: "https://h/n",
      externalReference: INTENT,
    });
    expect(created).toEqual({ ok: true, value: { uuid: ORDER, checkoutLink: "https://uala-checkout.com/o/1", status: "PENDING" } });
    await c.getOrder(ORDER);

    const tokenCalls = calls.filter((x) => x.url.endsWith("/auth/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.url).toBe("https://auth.stage.developers.ar.ua.la/v2/api/auth/token");
    expect(JSON.parse(String(tokenCalls[0]!.init?.body))).toEqual({
      username: "kiosco",
      client_id: "client-123456",
      client_secret_id: "secret-abcdef",
      grant_type: "client_credentials",
    });
    const checkout = calls.find((x) => x.url.endsWith("/checkout"))!;
    expect(checkout.url).toBe("https://checkout.stage.developers.ar.ua.la/v2/api/checkout");
    expect((checkout.init?.headers as Record<string, string>).Authorization).toBe("Bearer tk-1");
    expect(JSON.parse(String(checkout.init?.body)).amount).toBe("1250.50");
    expect(calls.at(-1)!.url).toBe(`https://checkout.stage.developers.ar.ua.la/v2/api/orders/${ORDER}`);
  });

  it("si el token venció del lado de Ualá, pide otro y reintenta una vez", async () => {
    let tokens = 0;
    let orders = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/token")) return res(200, { access_token: `tk-${++tokens}`, expires_in: 86400 });
      orders++;
      return orders === 1 ? res(403, { message: "User is not authorized" }) : res(200, order());
    });
    const c = ualabisClient({ creds: CREDS, env: "prod", fetchImpl });
    const r = await c.getOrder(ORDER);
    expect(r.ok).toBe(true);
    expect(tokens).toBe(2);
  });

  it("no manda órdenes fuera de rango ni uuids raros", async () => {
    const fetchImpl = vi.fn(async () => res(200, {}));
    const c = ualabisClient({ creds: CREDS, env: "prod", fetchImpl });
    const r = await c.createOrder({ amount: 10, callbackSuccess: "", callbackFail: "", notificationUrl: "", externalReference: INTENT });
    expect(r).toMatchObject({ ok: false, detail: "ualabis_min_amount" });
    expect(await c.getOrder("../../admin")).toMatchObject({ ok: false, httpStatus: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("los errores no devuelven el cuerpo crudo", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/auth/token") ? res(401, { code: "response_error", message: "Invalid username" }) : res(200, {}),
    );
    const r = await ualabisClient({ creds: CREDS, env: "prod", fetchImpl }).token();
    expect(r).toEqual({ ok: false, httpStatus: 401, detail: "Invalid username" });
  });

  it("devolución: total en pesos con notification_url", async () => {
    let body: unknown = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/token")) return res(200, { access_token: "tk", expires_in: 86400 });
      body = JSON.parse(String(init?.body));
      expect(url).toBe(`https://checkout.developers.ar.ua.la/v2/api/orders/${ORDER}/refund`);
      return res(200, { status: "INITIATED" });
    });
    const r = await ualabisClient({ creds: CREDS, env: "prod", fetchImpl }).refund(ORDER, 1250.5, "https://h/r");
    expect(r).toEqual({ httpStatus: 200, body: { status: "INITIATED" } });
    expect(body).toEqual({ amount: "1250.50", notification_url: "https://h/r" });
  });
});
