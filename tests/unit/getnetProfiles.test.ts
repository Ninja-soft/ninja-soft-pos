import { describe, expect, it, vi } from "vitest";
import {
  GETNET_PROFILES,
  GETNET_PROFILE_ORDER,
  GLOBAL_PLACEHOLDER_EMAIL,
  buildPaymentIntentPayload,
  buildProfileTokenRequest,
  classifyFailure,
  createGetnetCheckout,
  decideFor,
  decidePaymentIntent,
  describeDetectFailure,
  describeDiag,
  detectGetnetProfile,
  extractWebhookIntentId,
  fetchGetnetOrderFor,
  fetchGetnetSeller,
  getnetEnvOf,
  globalCustomerFromSecrets,
  makeDiag,
  parsePaymentIntentResponse,
  parseProviderError,
  profileMatchesEnv,
  requestGetnetToken,
  resolveGetnetAuth,
  scrubSecrets,
} from "@/supabase/functions/_shared/getnet";
import { normalizeGetnetOrder } from "@/supabase/functions/_shared/processorData";
import { probeAttemptLine, probeMismatchEnv, probeSecrets } from "@/lib/payments/getnetProbe";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// Respuestas reales leídas de los endpoints públicos con credenciales de mentira
// (2026-10-12): Geopagos 401 authentication_failed; Web Checkout 400 invalid_client.
const GEOPAGOS_401 = () => ok({ error: "authentication_failed", error_description: "Authentication failed" }, 401);
const GLOBAL_400 = () => ok({ error_description: "Client authentication failed", error: "invalid_client" }, 400);

/** fetch simulado por host del token. */
function byHost(map: Record<string, () => Response>) {
  return vi.fn(async (url: string) => {
    const host = new URL(url).host;
    const h = map[host];
    if (!h) throw new Error(`fetch inesperado a ${host}`);
    return h();
  });
}

describe("getnet perfiles · hosts por ambiente", () => {
  it("producción: Geopagos y Web Checkout prod; prueba: sandbox y homologación", () => {
    expect(GETNET_PROFILE_ORDER.prod).toEqual(["geopagos", "global_prod"]);
    expect(GETNET_PROFILE_ORDER.test).toEqual(["global_sbx", "global_pre"]);
    expect(GETNET_PROFILES.geopagos.tokenUrl).toBe("https://auth.geopagos.com/oauth/token");
    expect(GETNET_PROFILES.global_prod.tokenUrl).toBe("https://api.globalgetnet.com/authentication/oauth2/access_token");
    expect(GETNET_PROFILES.global_sbx.tokenUrl).toBe("https://api-sbx.globalgetnet.com/authentication/oauth2/access_token");
    expect(GETNET_PROFILES.global_pre.tokenUrl).toBe("https://api.pre.globalgetnet.com/authentication/oauth2/access_token");
    expect(GETNET_PROFILES.global_prod.apiBase).toBe("https://api.globalgetnet.com/dpy/web-checkout/v1");
  });

  it("un perfil de prueba nunca vale para producción (y al revés)", () => {
    expect(profileMatchesEnv("global_sbx", "prod")).toBe(false);
    expect(profileMatchesEnv("geopagos", "test")).toBe(false);
    expect(profileMatchesEnv("global_prod", "prod")).toBe(true);
    expect(profileMatchesEnv("cualquiera", "prod")).toBe(false);
  });

  it("ambiente: el de la credencial manda; si falta, el switch Sandbox", () => {
    expect(getnetEnvOf({ environment: "test" }, false)).toBe("test");
    expect(getnetEnvOf({ environment: "prod" }, true)).toBe("prod");
    expect(getnetEnvOf({}, true)).toBe("test");
    expect(getnetEnvOf(null)).toBe("prod");
  });
});

describe("getnet perfiles · request del token", () => {
  it("Geopagos: JSON con scope '*'", () => {
    const { url, init } = buildProfileTokenRequest(GETNET_PROFILES.geopagos, " id ", " sec ");
    expect(url).toBe("https://auth.geopagos.com/oauth/token");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      client_id: "id",
      client_secret: "sec",
      grant_type: "client_credentials",
      scope: "*",
    });
  });

  it("Web Checkout: form-urlencoded sin scope", () => {
    const { url, init } = buildProfileTokenRequest(GETNET_PROFILES.global_sbx, "id", "s&c=t");
    expect(url).toBe("https://api-sbx.globalgetnet.com/authentication/oauth2/access_token");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const p = new URLSearchParams(String(init.body));
    expect(p.get("grant_type")).toBe("client_credentials");
    expect(p.get("client_id")).toBe("id");
    expect(p.get("client_secret")).toBe("s&c=t");
    expect(p.has("scope")).toBe(false);
  });
});

describe("getnet perfiles · errores", () => {
  it("lee las formas de error de cada API", () => {
    expect(parseProviderError('{"error":"invalid_client","error_description":"Client authentication failed"}')).toEqual({
      code: "invalid_client",
      message: "Client authentication failed",
    });
    expect(parseProviderError('{"code":"product_is_not_enabled","message":"Checkout product not enabled"}')).toEqual({
      code: "product_is_not_enabled",
      message: "Checkout product not enabled",
    });
    expect(parseProviderError('{"statusCode":401,"message":"Invalid token"}')).toEqual({
      code: "401",
      message: "Invalid token",
    });
    expect(parseProviderError('{"errors":[{"code":"E1","detail":"Bad"}]}')).toEqual({ code: "E1", message: "Bad" });
    expect(parseProviderError("404 page not found")).toEqual({ code: null, message: "404 page not found" });
  });

  it("clasifica: credenciales, servicio, caída, red y producto no habilitado", () => {
    expect(classifyFailure(401, "authentication_failed")).toBe("invalid_credentials");
    expect(classifyFailure(400, "invalid_client")).toBe("invalid_credentials");
    expect(classifyFailure(400, "invalid_request")).toBe("unexpected");
    expect(classifyFailure(404, null)).toBe("endpoint_not_found");
    expect(classifyFailure(503, null)).toBe("provider_down");
    expect(classifyFailure(0, null)).toBe("network");
    expect(classifyFailure(403, "product_is_not_enabled", "create")).toBe("forbidden");
  });

  it("el diagnóstico nunca incluye los secretos", () => {
    expect(scrubSecrets("bad secret SUPERSECRET for id CLIENT1", ["SUPERSECRET", "CLIENT1"])).toBe(
      "bad secret *** for id ***",
    );
    const d = makeDiag(
      GETNET_PROFILES.global_prod,
      "token",
      "https://api.globalgetnet.com/authentication/oauth2/access_token?x=1",
      400,
      '{"error":"invalid_client","error_description":"client SUPERSECRET unknown"}',
      ["SUPERSECRET"],
    );
    expect(d.endpoint).toBe("api.globalgetnet.com/authentication/oauth2/access_token");
    expect(JSON.stringify(d)).not.toContain("SUPERSECRET");
    expect(describeDiag(d)).toContain("HTTP 400");
    expect(describeDiag(d)).toContain("invalid_client");
  });

  it("requestGetnetToken: token ok, rechazo y caída de red", async () => {
    const good = vi.fn().mockResolvedValue(ok({ access_token: "tok", expires_in: 3599 }));
    await expect(requestGetnetToken(GETNET_PROFILES.global_prod, "a", "b", good)).resolves.toMatchObject({
      ok: true,
      token: "tok",
    });
    const bad = vi.fn().mockResolvedValue(GEOPAGOS_401());
    const r = await requestGetnetToken(GETNET_PROFILES.geopagos, "a", "b", bad);
    expect(r).toMatchObject({
      ok: false,
      diag: { profile: "geopagos", http_status: 401, code: "authentication_failed", kind: "invalid_credentials" },
    });
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const n = await requestGetnetToken(GETNET_PROFILES.geopagos, "a", "b", down);
    expect(n).toMatchObject({ ok: false, diag: { http_status: 0, kind: "network" } });
    const empty = vi.fn().mockResolvedValue(ok({}));
    expect(await requestGetnetToken(GETNET_PROFILES.geopagos, "a", "b", empty)).toMatchObject({
      ok: false,
      diag: { kind: "unexpected" },
    });
  });
});

describe("getnet perfiles · autodetección", () => {
  it("producción: si Geopagos rechaza, prueba Web Checkout y se queda con ese", async () => {
    const f = byHost({
      "auth.geopagos.com": GEOPAGOS_401,
      "api.globalgetnet.com": () => ok({ access_token: "g-tok" }),
    });
    const r = await detectGetnetProfile("id", "sec", { env: "prod" }, f);
    expect(r).toMatchObject({ ok: true, token: "g-tok", profile: { key: "global_prod" } });
    expect(f.mock.calls.map((c) => new URL(c[0] as string).host)).toEqual(["auth.geopagos.com", "api.globalgetnet.com"]);
    if (r.ok) expect(r.attempts.map((a) => a.profile)).toEqual(["geopagos"]);
  });

  it("el perfil guardado se prueba primero", async () => {
    const f = byHost({ "api.globalgetnet.com": () => ok({ access_token: "t" }) });
    const r = await detectGetnetProfile("id", "sec", { env: "prod", preferred: "global_prod" }, f);
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("un perfil guardado de OTRO ambiente se ignora", async () => {
    const f = byHost({
      "api-sbx.globalgetnet.com": GLOBAL_400,
      "api.pre.globalgetnet.com": () => ok({ access_token: "pre" }),
    });
    const r = await detectGetnetProfile("id", "sec", { env: "test", preferred: "geopagos" }, f);
    expect(r).toMatchObject({ ok: true, profile: { key: "global_pre" } });
  });

  it("credenciales de sandbox con ambiente producción: avisa el error de ambiente", async () => {
    const f = byHost({
      "auth.geopagos.com": GEOPAGOS_401,
      "api.globalgetnet.com": GLOBAL_400,
      "api-sbx.globalgetnet.com": () => ok({ access_token: "sbx" }),
    });
    const r = await detectGetnetProfile("id", "sec", { env: "prod", crossEnv: true }, f);
    expect(r).toMatchObject({ ok: false, mismatch: "global_sbx" });
    if (!r.ok) {
      expect(r.attempts).toHaveLength(2);
      expect(describeDetectFailure(r)).toContain("son de prueba");
    }
  });

  it("todas rechazadas: mensaje claro y un intento por API", async () => {
    const f = byHost({
      "auth.geopagos.com": GEOPAGOS_401,
      "api.globalgetnet.com": GLOBAL_400,
      "api-sbx.globalgetnet.com": GLOBAL_400,
      "api.pre.globalgetnet.com": GLOBAL_400,
    });
    const r = await detectGetnetProfile("id", "sec", { env: "prod", crossEnv: true }, f);
    expect(r).toMatchObject({ ok: false, mismatch: null });
    if (!r.ok) {
      expect(r.attempts.map((a) => a.profile)).toEqual(["geopagos", "global_prod", "global_sbx", "global_pre"]);
      expect(describeDetectFailure(r)).toContain("rechazó el Client ID / Client Secret en todas");
    }
  });

  it("sin crossEnv no toca los hosts del otro ambiente", async () => {
    const f = byHost({ "auth.geopagos.com": GEOPAGOS_401, "api.globalgetnet.com": GLOBAL_400 });
    const r = await detectGetnetProfile("id", "sec", { env: "prod" }, f);
    expect(r.ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("resolveGetnetAuth marca 'detected' cuando el perfil cambió", async () => {
    const f = byHost({ "auth.geopagos.com": GEOPAGOS_401, "api.globalgetnet.com": () => ok({ access_token: "t" }) });
    const r = await resolveGetnetAuth({ client_id: "a", client_secret: "b" }, false, f);
    expect(r).toMatchObject({ ok: true, detected: true, env: "prod", profile: { key: "global_prod" } });
    const g = byHost({ "api.globalgetnet.com": () => ok({ access_token: "t" }) });
    const r2 = await resolveGetnetAuth(
      { client_id: "a", client_secret: "b", api_profile: "global_prod", environment: "prod" },
      true,
      g,
    );
    expect(r2).toMatchObject({ ok: true, detected: false, env: "prod" });
  });
});

describe("getnet Web Checkout · payment intent", () => {
  const customer = globalCustomerFromSecrets({}, "intent-1");

  it("comprador Consumidor Final con defaults válidos para el esquema", () => {
    expect(customer).toMatchObject({
      customer_id: "intent-1",
      name: "Consumidor Final",
      email: GLOBAL_PLACEHOLDER_EMAIL,
      document_type: "DNI",
      document_number: "99999999",
      billing_address: { street: "Sin calle", number: "0", country: "AR", postal_code: "1000" },
    });
    const c = globalCustomerFromSecrets(
      {
        customer_email: "ventas@negocio.com",
        customer_document: "30-71234567-8",
        customer_address: "Av. Corrientes 1234",
        customer_postal_code: "C1043AAZ",
      },
      "x",
    );
    expect(c).toMatchObject({
      email: "ventas@negocio.com",
      document_type: "CUIT",
      document_number: "30712345678",
      billing_address: { street: "Av. Corrientes", number: "1234", postal_code: "C1043AAZ" },
    });
  });

  it("payload: ARS en centavos enteros, un producto y vencimiento", () => {
    const p = buildPaymentIntentPayload({
      amount: 1500.5,
      orderId: "0b6c1f2e-1111-2222-3333-444455556666",
      successUrl: "https://x/ok",
      errorUrl: "https://x/err",
      customer,
    });
    expect(p).toMatchObject({
      order_id: "0b6c1f2e-1111-2222-3333-444455556666",
      payment: { currency: "ARS", amount: 150050 },
      product: [{ title: "Venta NinjaPos", value: 150050, quantity: 1 }],
      configurations: { success_url: "https://x/ok", error_url: "https://x/err" },
      expires_at: "30m",
    });
    expect(() => buildPaymentIntentPayload({ ...p, amount: 0, orderId: "a", successUrl: "", errorUrl: "", customer })).toThrow();
  });

  it("respuesta: payment_intent_id + redirect_url https", () => {
    expect(
      parsePaymentIntentResponse({
        payment_intent_id: "ee0b7dd5-92da-4ef4-ad3b-0ba369ad0efe",
        trade_name: "Smart Shop",
        redirect_url: "https://www.globalgetnet.com/hosted-web-checkout/abc",
      }),
    ).toEqual({
      orderId: "ee0b7dd5-92da-4ef4-ad3b-0ba369ad0efe",
      checkoutUrl: "https://www.globalgetnet.com/hosted-web-checkout/abc",
      referenceNumber: null,
    });
    expect(parsePaymentIntentResponse({ payment_intent_id: "x", redirect_url: "http://inseguro" })).toBeNull();
    expect(parsePaymentIntentResponse({ redirect_url: "https://a" })).toBeNull();
  });

  it("createGetnetCheckout usa el endpoint de cada API", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ payment_intent_id: "pi-1", redirect_url: "https://www.globalgetnet.com/hosted-web-checkout/x" }, 201),
    );
    const input = {
      amount: 100,
      intentId: "i-1",
      webhookUrl: "https://h/w?intent=i-1",
      successUrl: "https://h/w?view=success",
      failedUrl: "https://h/w?view=failed",
      secrets: {},
    };
    const r = await createGetnetCheckout(GETNET_PROFILES.global_sbx, "tok", input, f);
    expect(r).toEqual({
      ok: true,
      created: { orderId: "pi-1", checkoutUrl: "https://www.globalgetnet.com/hosted-web-checkout/x", referenceNumber: null },
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api-sbx.globalgetnet.com/dpy/web-checkout/v1/payment-intent");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body).payment).toEqual({ currency: "ARS", amount: 10000 });

    const g = vi.fn().mockResolvedValue(ok({ code: "product_is_not_enabled", message: "Checkout product not enabled" }, 403));
    const e = await createGetnetCheckout(GETNET_PROFILES.global_prod, "tok", input, g);
    expect(e).toMatchObject({ ok: false, diag: { step: "create", http_status: 403, kind: "forbidden", code: "product_is_not_enabled" } });

    const h = vi.fn().mockResolvedValue(
      ok({ data: { id: "o-1", links: [{ checkout: "https://checkout.globalgetnet.com.ar/o-1" }], attributes: {} } }),
    );
    const geo = await createGetnetCheckout(GETNET_PROFILES.geopagos, "tok", input, h);
    expect(geo).toMatchObject({ ok: true, created: { orderId: "o-1" } });
    expect(h.mock.calls[0]![0]).toBe("https://api.globalgetnet.com.ar/api/v2/orders");
    expect(JSON.parse(h.mock.calls[0]![1].body).data.attributes.webhookUrl).toBe("https://h/w?intent=i-1");
  });

  it("consulta: GET /payment-intent/{id} en el host del perfil", async () => {
    const f = vi.fn().mockResolvedValue(ok({ status: "pending", records: [] }));
    await expect(fetchGetnetOrderFor(GETNET_PROFILES.global_pre, "tok", "pi-1", f)).resolves.toMatchObject({ ok: true });
    expect(f.mock.calls[0]![0]).toBe("https://api.pre.globalgetnet.com/dpy/web-checkout/v1/payment-intent/pi-1");
    const g = vi.fn();
    await expect(fetchGetnetOrderFor(GETNET_PROFILES.global_pre, "tok", "../x", g)).resolves.toMatchObject({ ok: false, httpStatus: 400 });
    expect(g).not.toHaveBeenCalled();
  });

  it("estados: paid con monto → approved; denied → rejected; expired → cancelled", () => {
    const paid = {
      status: "paid",
      payment_intent_id: "pi",
      payment: { method: "credit", amount: 50000, currency: "ARS", result: { status: "Authorized" } },
      records: [
        { payment: { amount: 50000, result: { payment_id: "p-den", status: "Denied" } } },
        { payment: { amount: 50000, result: { payment_id: "p-ok", status: "Authorized" } } },
      ],
    };
    expect(decidePaymentIntent(paid, 500)).toEqual({ status: "approved", state: "paid", paymentId: "p-ok" });
    expect(decidePaymentIntent(paid, 600)).toMatchObject({ status: "rejected", reason: "amount_mismatch" });
    // Cuotas con interés: cobra más que la venta, se acredita igual.
    expect(decidePaymentIntent({ ...paid, payment: { amount: 55000 } }, 500).status).toBe("approved");
    expect(decidePaymentIntent({ status: "paid", records: [] }, 500)).toMatchObject({
      status: "pending",
      reason: "amount_unverified",
    });
    expect(decidePaymentIntent({ status: "denied" }, 1).status).toBe("rejected");
    expect(decidePaymentIntent({ status: "error" }, 1).status).toBe("rejected");
    expect(decidePaymentIntent({ status: "expired" }, 1).status).toBe("cancelled");
    expect(decidePaymentIntent({ status: "cancelled" }, 1).status).toBe("cancelled");
    expect(decidePaymentIntent({ status: "registered" }, 1).status).toBe("pending");
    expect(decidePaymentIntent(null, 1).status).toBe("pending");
  });

  it("decideFor despacha por API", () => {
    expect(decideFor(GETNET_PROFILES.global_prod, { status: "expired" }, 1).status).toBe("cancelled");
    expect(decideFor(GETNET_PROFILES.geopagos, { status: "EXPIRED" }, 1)).toMatchObject({ status: "cancelled", paymentId: null });
  });

  it("webhook: payment_intent_id del cuerpo", () => {
    expect(extractWebhookIntentId({ payment_intent_id: "q1r234ed-65cc-4fbf-a407-0f17df9a2e2c" })).toBe(
      "q1r234ed-65cc-4fbf-a407-0f17df9a2e2c",
    );
    expect(extractWebhookIntentId({ payment_intent_id: "../x" })).toBeNull();
    expect(extractWebhookIntentId("x")).toBeNull();
  });

  it("GET /sellers: datos del comercio y producto habilitado", async () => {
    const f = vi.fn().mockResolvedValue(ok({ trade_name: "Smart Shop", country: "AR", checkout: { enabled: true } }));
    await expect(fetchGetnetSeller(GETNET_PROFILES.global_prod, "tok", f)).resolves.toEqual({
      ok: true,
      seller: { trade_name: "Smart Shop", country: "AR", checkout_enabled: true },
    });
    expect(f.mock.calls[0]![0]).toBe("https://api.globalgetnet.com/dpy/web-checkout/v1/sellers");
    const g = vi.fn().mockResolvedValue(ok({ code: "seller_not_found", message: "Seller not found" }, 404));
    await expect(fetchGetnetSeller(GETNET_PROFILES.global_prod, "tok", g)).resolves.toMatchObject({
      ok: false,
      diag: { step: "seller", code: "seller_not_found" },
    });
  });

  it("detalle del procesador desde un payment intent", () => {
    const d = normalizeGetnetOrder({
      status: "paid",
      payment_intent_id: "pi-1",
      order_id: "ORDER_1",
      payment: { method: "credit", amount: 50000, currency: "ARS", installment: { number: 3 } },
      records: [
        {
          payment: {
            method: "credit",
            brand: "VISA",
            last_four_digits: "4242",
            amount: 50000,
            installment: { number: 3 },
            result: { payment_id: "p", status: "Authorized", authorization_code: "111111", transaction_datetime: "2026-03-30T20:15:12.000Z" },
          },
        },
      ],
    });
    expect(d).toMatchObject({ external_id: "pi-1", status: "approved", gross: 500, installments: 3, authorization: "111111" });
    expect(d.card?.last4).toBe("4242");
  });
});

describe("getnet · lectura de la prueba en el wizard", () => {
  it("línea por intento, ambiente a sugerir y secretos a guardar", () => {
    expect(
      probeAttemptLine({
        profile: "geopagos",
        api: "geopagos",
        env: "prod",
        label: "API Getnet Argentina (Geopagos) · producción",
        step: "token",
        endpoint: "auth.geopagos.com/oauth/token",
        http_status: 401,
        code: "authentication_failed",
        message: "Authentication failed",
        kind: "invalid_credentials",
      }),
    ).toBe(
      "API Getnet Argentina (Geopagos) · producción: credenciales rechazadas (HTTP 401 · authentication_failed: Authentication failed) en auth.geopagos.com/oauth/token",
    );
    expect(probeMismatchEnv({ ok: false, mismatch: "global_sbx" })).toBe("test");
    expect(probeMismatchEnv({ ok: false, mismatch: "global_prod" })).toBe("prod");
    expect(probeMismatchEnv({ ok: true })).toBeNull();
    expect(probeSecrets({ ok: true, profile: "global_prod", environment: "prod" }, "prod")).toEqual({
      environment: "prod",
      api_profile: "global_prod",
    });
    // Prueba hecha en otro ambiente: no se guarda la API detectada.
    expect(probeSecrets({ ok: true, profile: "global_sbx", environment: "test" }, "prod")).toEqual({ environment: "prod" });
    expect(probeSecrets(null, "test")).toEqual({ environment: "test" });
  });
});
