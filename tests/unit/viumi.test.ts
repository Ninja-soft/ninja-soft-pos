// Viumi (ADR-173): lógica pura de la Checkout API v2. Sin red: el fetch se
// inyecta (nunca se hace un cobro real).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOrderBody,
  clearTokenCache,
  decideIntentUpdate,
  isAuthFailure,
  mapViumiOrder,
  orderAmount,
  orderTotalCents,
  parseCreds,
  parseOrderResponse,
  parseTokenResponse,
  parseWebhook,
  tokenCacheUntil,
  viumiClient,
  viumiEnv,
  VIUMI_AUTH_HOSTS,
  VIUMI_CHECKOUT_BASE,
  VIUMI_EXPIRE_MINUTES,
  type ViumiCreds,
} from "@/supabase/functions/_shared/viumi";
import { PROVIDER_MAX_TTL_MINUTES } from "@/modules/pending-charges/logic";

const INTENT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const ORDER = "613d8938-8dab-41fd-9905-09d52e5312d0";
const CREDS: ViumiCreds = { clientId: "client-123456", clientSecret: "secret-abcdef" };
const LINK = "https://checkout.viumi.com.ar/orders/613d8938";

const res = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const order = (over: Record<string, unknown> = {}) => ({
  data: {
    id: ORDER,
    type: "Order",
    attributes: {
      uuid: ORDER,
      orderNumber: 123,
      status: "SUCCESS",
      hasPendingPayment: false,
      payment: { status: "APPROVED" },
      payments: [{ status: "APPROVED" }],
      price: { amount: 125050, currency: "032" },
      items: [{ id: INTENT, name: "Venta", quantity: 1, unitPrice: { amount: "125050", currency: "032" } }],
      ...over,
    },
  },
});

beforeEach(() => clearTokenCache());

describe("ambientes y credenciales", () => {
  it("el switch Sandbox elige stage y los hosts de la doc van primero", () => {
    expect(viumiEnv(true)).toBe("stage");
    expect(viumiEnv(false)).toBe("prod");
    expect(viumiEnv(null)).toBe("prod");
    expect(VIUMI_AUTH_HOSTS.prod).toEqual(["https://auth.prd.geopagos.io", "https://auth.geopagos.com"]);
    expect(VIUMI_AUTH_HOSTS.stage).toEqual(["https://auth.stg.geopagos.io", "https://auth.sandbox.geopagos.com"]);
    expect(VIUMI_CHECKOUT_BASE.prod).toBe("https://api.viumi.com.ar");
    expect(VIUMI_CHECKOUT_BASE.stage).toBe("https://api-mpos-macro.stg.geopagos.io");
  });

  it("parseCreds exige client_id y client_secret", () => {
    expect(parseCreds({ client_id: " c ", client_secret: "s" })).toEqual({ clientId: "c", clientSecret: "s" });
    expect(parseCreds({ client_id: "c" })).toBeNull();
    expect(parseCreds(null)).toBeNull();
    expect(parseCreds({ client_id: "c".repeat(201), client_secret: "s" })).toBeNull();
  });
});

describe("montos", () => {
  it("la orden viaja en CENTAVOS como string entero", () => {
    expect(orderAmount(1234.56)).toEqual({ ok: true, value: "123456" });
    expect(orderAmount(100)).toEqual({ ok: true, value: "10000" });
    expect(orderAmount(0.1 + 0.2 + 99.7)).toEqual({ ok: true, value: "10000" });
    expect(orderAmount(0.5)).toEqual({ ok: false, error: "viumi_min_amount" });
    expect(orderAmount(10_000_000)).toEqual({ ok: false, error: "viumi_max_amount" });
    expect(orderAmount(-1)).toEqual({ ok: false, error: "invalid_amount" });
    expect(orderAmount(Number.NaN)).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("total de la orden: price.amount o la suma de los ítems", () => {
    expect(orderTotalCents({ price: { amount: 125050 } })).toBe(125050);
    expect(orderTotalCents({ price: { amount: "125050" } })).toBe(125050);
    expect(
      orderTotalCents({ items: [{ quantity: 2, unitPrice: { amount: "1000" } }, { quantity: 1, unitPrice: { amount: 50 } }] }),
    ).toBe(2050);
    expect(orderTotalCents({ price: { amount: "12.50" } })).toBeNull();
    expect(orderTotalCents({})).toBeNull();
  });

  it("buildOrderBody arma el cuerpo JSON:API con el intent como ítem", () => {
    const b = buildOrderBody({
      amount: 1250.5,
      description: "  Venta   NinjaPos  ",
      intentId: INTENT,
      successUrl: "https://pos/ok",
      failedUrl: "https://pos/error",
      webhookUrl: `https://hooks.soft.ninja/viumi?intent=${INTENT}`,
      expireMinutes: VIUMI_EXPIRE_MINUTES,
    });
    expect(b).toEqual({
      data: {
        attributes: {
          currency: "032",
          items: [{ id: INTENT, name: "Venta NinjaPos", quantity: 1, unitPrice: { currency: "032", amount: "125050" } }],
          redirect_urls: { success: "https://pos/ok", failed: "https://pos/error" },
          webhookUrl: `https://hooks.soft.ninja/viumi?intent=${INTENT}`,
          expireLimitMinutes: 1440,
        },
      },
    });
    const short = buildOrderBody({ amount: 10, description: "x".repeat(100), intentId: INTENT, successUrl: "", failedUrl: "", webhookUrl: "", expireMinutes: 2 });
    expect(short.data.attributes.expireLimitMinutes).toBe(10);
    expect((short.data.attributes.items as { name: string }[])[0]!.name).toHaveLength(63);
    expect(() =>
      buildOrderBody({ amount: 10, intentId: INTENT, successUrl: "", failedUrl: "", webhookUrl: "https://x/" + "a".repeat(260) }),
    ).toThrow("webhook_url_too_long");
    expect(() => buildOrderBody({ amount: 0.5, intentId: INTENT, successUrl: "", failedUrl: "", webhookUrl: "" })).toThrow(
      "viumi_min_amount",
    );
  });

  it("el vencimiento del link es el tope de cobros en espera", () => {
    expect(PROVIDER_MAX_TTL_MINUTES.viumi).toBe(VIUMI_EXPIRE_MINUTES);
  });
});

describe("respuestas", () => {
  const NOW = 1_800_000_000_000;

  it("token: expires_in como duración o como timestamp unix", () => {
    expect(parseTokenResponse({ access_token: "tk", expires_in: 3600, token_type: "Bearer" }, NOW)).toEqual({
      token: "tk",
      ttlSeconds: 3600,
    });
    expect(parseTokenResponse({ access_token: "tk", expires_in: NOW / 1000 + 7200 }, NOW)).toEqual({
      token: "tk",
      ttlSeconds: 7200,
    });
    expect(parseTokenResponse({ access_token: "tk" }, NOW)?.ttlSeconds).toBe(3600);
    expect(parseTokenResponse({}, NOW)).toBeNull();
  });

  it("cache: vence 5 minutos antes, con un mínimo de 60 segundos", () => {
    expect(tokenCacheUntil(NOW, 3600)).toBe(NOW + 3300 * 1000);
    expect(tokenCacheUntil(NOW, 100)).toBe(NOW + 60 * 1000);
    expect(tokenCacheUntil(NOW, -50)).toBe(NOW + 60 * 1000);
  });

  it("orden creada: link en data.links.checkout (doc) o data.links[0].checkout (plugin)", () => {
    expect(parseOrderResponse({ data: { id: ORDER, attributes: { status: "PENDING" }, links: { checkout: LINK } } })).toEqual({
      uuid: ORDER,
      checkoutLink: LINK,
      status: "PENDING",
    });
    expect(parseOrderResponse({ data: { attributes: { uuid: ORDER }, links: [{ checkout: LINK }] } })).toEqual({
      uuid: ORDER,
      checkoutLink: LINK,
      status: "PENDING",
    });
    expect(parseOrderResponse({ data: { id: ORDER, links: { checkout: "http://inseguro" } } })).toBeNull();
    expect(parseOrderResponse({ data: { id: "../../x", links: { checkout: LINK } } })).toBeNull();
    expect(parseOrderResponse({ id: ORDER })).toBeNull();
  });
});

describe("mapeo de estados", () => {
  it.each([
    [{ status: "SUCCESS", payment: { status: "APPROVED" } }, "approved"],
    [{ status: "PENDING", payments: [{ status: "REJECTED" }, { status: "processed" }] }, "approved"],
    [{ status: "SUCCESS" }, "pending"],
    [{ status: "REJECTED" }, "rejected"],
    [{ status: "DECLINED" }, "rejected"],
    [{ status: "FAILED" }, "rejected"],
    [{ status: "EXPIRED" }, "cancelled"],
    [{ status: "CANCELLED" }, "cancelled"],
    [{ status: "CANCELED" }, "cancelled"],
    [{ status: "PENDING", payment: { status: "REJECTED" } }, "pending"],
    [{}, "pending"],
    [null, "pending"],
  ])("%j → %s", (input, out) => {
    expect(mapViumiOrder(input)).toBe(out);
  });
});

describe("decideIntentUpdate (orden re-consultada)", () => {
  const exp = { amount: 1250.5, orderUuid: ORDER };

  it("aprueba con la orden propia, el pago aprobado y el monto exacto", () => {
    expect(decideIntentUpdate(order(), exp)).toEqual({ status: "approved", state: "SUCCESS" });
    // Sin el envoltorio data también se entiende.
    expect(decideIntentUpdate(order().data, exp).status).toBe("approved");
  });

  it("no acredita una orden ajena", () => {
    expect(decideIntentUpdate(order({ uuid: "11111111-2222-4333-8444-555555555555" }), exp)).toMatchObject({
      status: "pending",
      reason: "order_mismatch",
    });
  });

  it("monto en centavos distinto → rechazado; sin monto → pendiente; sin price usa los ítems", () => {
    expect(decideIntentUpdate(order({ price: { amount: 1250 } }), exp)).toMatchObject({
      status: "rejected",
      reason: "amount_mismatch",
    });
    expect(decideIntentUpdate(order({ price: undefined, items: undefined }), exp)).toMatchObject({
      status: "pending",
      reason: "amount_not_reported",
    });
    expect(decideIntentUpdate(order({ price: undefined }), exp).status).toBe("approved");
  });

  it("rechazada, vencida y pendiente pasan tal cual", () => {
    const none = { payment: null, payments: [] };
    expect(decideIntentUpdate(order({ ...none, status: "REJECTED" }), exp).status).toBe("rejected");
    expect(decideIntentUpdate(order({ ...none, status: "EXPIRED" }), exp).status).toBe("cancelled");
    expect(decideIntentUpdate(order({ ...none, status: "PENDING" }), exp).status).toBe("pending");
    expect(decideIntentUpdate(null, exp).status).toBe("pending");
  });
});

describe("webhook (sin firma: sólo una pista)", () => {
  it("lee el uuid de la orden y descarta lo que no sirve", () => {
    expect(
      parseWebhook({
        data: {
          type: "Payment",
          order: { uuid: ORDER, status: "success", source: "checkout" },
          payment: { id: 1, authorizationCode: "A1", refNumber: "R1", status: "approved" },
        },
      }),
    ).toEqual({ uuid: ORDER, status: "SUCCESS", paymentStatus: "APPROVED" });
    expect(parseWebhook({ data: { order: { uuid: "../orders" } } })).toBeNull();
    expect(parseWebhook({ data: {} })).toBeNull();
    expect(parseWebhook("x")).toBeNull();
    expect(isAuthFailure(401)).toBe(true);
    expect(isAuthFailure(500)).toBe(false);
  });
});

describe("cliente HTTP (fetch simulado)", () => {
  const input = {
    amount: 1250.5,
    intentId: INTENT,
    successUrl: "https://h/s",
    failedUrl: "https://h/f",
    webhookUrl: `https://h/n?intent=${INTENT}`,
  };

  it("pide token una vez, crea la orden con Bearer JSON:API y cachea el token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth/token")) return res(200, { token_type: "Bearer", access_token: "tk-1", expires_in: 3600 });
      if (url.endsWith("/api/v2/orders")) return res(201, { data: { id: ORDER, links: [{ checkout: LINK }] } });
      return res(200, order());
    });
    const c = viumiClient({ creds: CREDS, env: "stage", fetchImpl });
    expect(await c.createOrder(input)).toEqual({ ok: true, value: { uuid: ORDER, checkoutLink: LINK, status: "PENDING" } });
    await c.getOrder(ORDER);

    const tokenCalls = calls.filter((x) => x.url.endsWith("/oauth/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.url).toBe("https://auth.stg.geopagos.io/oauth/token");
    expect(JSON.parse(String(tokenCalls[0]!.init?.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "client-123456",
      client_secret: "secret-abcdef",
      scope: "api_orders_post",
    });
    const create = calls.find((x) => x.url.endsWith("/api/v2/orders"))!;
    expect(create.url).toBe("https://api-mpos-macro.stg.geopagos.io/api/v2/orders");
    const headers = create.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tk-1");
    expect(headers["Content-Type"]).toBe("application/vnd.api+json");
    expect(headers.Accept).toBe("application/vnd.api+json");
    const body = JSON.parse(String(create.init?.body));
    expect(body.data.attributes.items[0].unitPrice.amount).toBe("125050");
    expect(body.data.attributes.expireLimitMinutes).toBe(1440);
    expect(calls.at(-1)!.url).toBe(`https://api-mpos-macro.stg.geopagos.io/api/v2/orders/${ORDER}`);
  });

  it("token con expires_in vencido según el reloj: se vuelve a pedir", async () => {
    let now = 1_800_000_000_000;
    let tokens = 0;
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/oauth/token") ? res(200, { access_token: `tk-${++tokens}`, expires_in: 600 }) : res(200, order()),
    );
    const c = viumiClient({ creds: CREDS, env: "prod", fetchImpl, now: () => now });
    await c.getOrder(ORDER);
    now += 200_000; // < 300 s: sigue en cache
    await c.getOrder(ORDER);
    expect(tokens).toBe(1);
    now += 200_000; // 400 s > 300 s (600 - 300)
    await c.getOrder(ORDER);
    expect(tokens).toBe(2);
  });

  it("si el token venció del lado de Viumi (401), pide otro y reintenta una vez", async () => {
    let tokens = 0;
    let orders = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth/token")) return res(200, { access_token: `tk-${++tokens}`, expires_in: 3600 });
      orders++;
      return orders === 1 ? res(401, { errors: [{ detail: "Unauthenticated" }] }) : res(200, order());
    });
    const r = await viumiClient({ creds: CREDS, env: "prod", fetchImpl }).getOrder(ORDER);
    expect(r.ok).toBe(true);
    expect(tokens).toBe(2);
    expect(orders).toBe(2);
  });

  it("auth: si el host de la doc no responde o da 404, prueba el del plugin", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith("https://auth.prd.geopagos.io")) throw new TypeError("fetch failed");
      return res(200, { access_token: "tk", expires_in: 3600 });
    });
    expect(await viumiClient({ creds: CREDS, env: "prod", fetchImpl }).token()).toEqual({ ok: true, value: "tk" });
    expect(urls).toEqual(["https://auth.prd.geopagos.io/oauth/token", "https://auth.geopagos.com/oauth/token"]);

    clearTokenCache();
    urls.length = 0;
    const notFound = vi.fn(async (url: string) => {
      urls.push(url);
      return url.startsWith("https://auth.stg.geopagos.io") ? res(404, "") : res(200, { access_token: "tk2" });
    });
    expect(await viumiClient({ creds: CREDS, env: "stage", fetchImpl: notFound }).token()).toEqual({ ok: true, value: "tk2" });
    expect(urls).toEqual(["https://auth.stg.geopagos.io/oauth/token", "https://auth.sandbox.geopagos.com/oauth/token"]);
  });

  it("credenciales rechazadas: no prueba el otro host y no devuelve el cuerpo crudo", async () => {
    const fetchImpl = vi.fn(async () => res(401, { error: "invalid_client", error_description: "Client authentication failed" }));
    const r = await viumiClient({ creds: CREDS, env: "prod", fetchImpl }).token();
    expect(r).toEqual({ ok: false, httpStatus: 401, detail: "Client authentication failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("no manda órdenes fuera de rango ni uuids raros", async () => {
    const fetchImpl = vi.fn(async () => res(200, {}));
    const c = viumiClient({ creds: CREDS, env: "prod", fetchImpl });
    expect(await c.createOrder({ ...input, amount: 0.5 })).toMatchObject({ ok: false, detail: "viumi_min_amount" });
    expect(await c.getOrder("../../admin")).toMatchObject({ ok: false, httpStatus: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("orden sin link https → error claro", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/oauth/token") ? res(200, { access_token: "tk" }) : res(201, { data: { id: ORDER } }),
    );
    const r = await viumiClient({ creds: CREDS, env: "prod", fetchImpl }).createOrder(input);
    expect(r).toEqual({ ok: false, httpStatus: 502, detail: "order_without_link" });
  });
});
