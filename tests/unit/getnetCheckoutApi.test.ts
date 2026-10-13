import { describe, expect, it, vi } from "vitest";
import {
  API_HOSTS,
  apiBrand,
  apiCredsOf,
  apiHeaders,
  apiPayHttpResponse,
  buildApiPaymentBody,
  buildApiTokenRequest,
  buildQuotesBody,
  buildTokenizeBody,
  classifyApiFailure,
  classifyApiPayResponse,
  classifyCredential,
  cleanCard,
  decideApiPaymentInfo,
  decodeJwtClaims,
  finalAmountWithSurcharge,
  hasWebCheckoutCreds,
  isApiPaymentId,
  isOwnCheckoutIntent,
  makeAttempt,
  ownCheckoutUrl,
  parseApiError,
  parseQuotes,
  pickQuote,
  requestApiToken,
  scrub,
  SLOT_MISMATCH_COPY,
  webCheckoutSaveVerdict,
} from "@/supabase/functions/_shared/getnet_api";
import { normalizeGetnetOrder } from "@/supabase/functions/_shared/processorData";
import {
  GETNET_VTEX_IN_WEB_CHECKOUT,
  GETNET_VTEX_WARNING,
  getnetSaveError,
  getnetSlotClearKeys,
  getnetSlotError,
  getnetSlotSave,
  getnetSlotsFromKeys,
  getnetSlotsOf,
  GETNET_SLOT_BY_KEY,
  visibleGetnetSlots,
} from "@/lib/payments/getnetSlots";
import { buildGetnetPayBody, checkoutProviderOf, CHECKOUT_EDGE, SECURE_COPY } from "@/lib/payments/checkoutProviders";
import { probeSecrets } from "@/lib/payments/getnetProbe";
import { paywayPayMessage } from "@/lib/payments/paywayMessages";
import { resolveTenders, TENDER_BY_ID, type ProviderStatus, type TenderContext } from "@/lib/pos/tenders";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// JWT de ejemplo con los claims que documenta Getnet (sellerId, country, scope).
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.firma`;
}
const SELLER = "54f88e68-7764-4e87-8830-756b1e2c02f8";

// Respuestas reales con credenciales de mentira (2026-10-12):
//   POST api-sbx.../access_token con Basic → 401 invalid_client.
//   POST .../tokens/card con Bearer inválido → 401 {statusCode, message}.
const BASIC_401 = () => ok({ error_description: "Client authentication failed", error: "invalid_client" }, 401);

const CARD = { number: "4507990000004905", exp_month: "12", exp_year: "30", cvv: "123", holder: "JUAN PEREZ", dni: "30123456" };

describe("Checkout API · credencial y token", () => {
  it("lee el slot Checkout API sin mezclarlo con Web Checkout", () => {
    expect(apiCredsOf({ client_id: "a", client_secret: "b" })).toBeNull();
    const c = apiCredsOf({ api_client_id: " id ", api_client_secret: "sec", api_environment: "test", api_seller_id: SELLER });
    expect(c).toEqual({ clientId: "id", clientSecret: "sec", env: "test", channelEntry: null, sellerId: SELLER });
    expect(apiCredsOf({ api_client_id: "id", api_client_secret: "sec", api_seller_id: "x" })?.sellerId).toBeNull();
    expect(hasWebCheckoutCreds({ client_id: "a", client_secret: "b" })).toBe(true);
    expect(hasWebCheckoutCreds({ api_client_id: "a", api_client_secret: "b" })).toBe(false);
  });

  it("pide el token con Basic auth y grant_type en el form", () => {
    const { url, init } = buildApiTokenRequest("https://api-sbx.globalgetnet.com", "id", "secret");
    expect(url).toBe("https://api-sbx.globalgetnet.com/authentication/oauth2/access_token");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(h["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBe("grant_type=client_credentials");
  });

  it("lee sellerId, país y scope del JWT", () => {
    const c = decodeJwtClaims(jwt({ sellerId: SELLER, country: "ar", scope: ["digital-platform:gateway-api"] }));
    expect(c).toEqual({ sellerId: SELLER, country: "AR", scope: ["digital-platform:gateway-api"] });
    expect(decodeJwtClaims("no-es-jwt")).toEqual({ sellerId: null, country: null, scope: [] });
  });

  it("prueba los hosts del ambiente en orden y devuelve el que dio token", async () => {
    const token = jwt({ sellerId: SELLER, country: "AR" });
    const f = vi.fn(async (url: string) =>
      url.startsWith(API_HOSTS.test[0]!) ? BASIC_401() : ok({ access_token: token, expires_in: 3599 }),
    );
    const r = await requestApiToken({ clientId: "id", clientSecret: "sec", env: "test" }, f);
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe(API_HOSTS.test[1]);
      expect(r.claims.sellerId).toBe(SELLER);
    }
  });

  it("sin token devuelve cada intento clasificado y sin secretos", async () => {
    const f = vi.fn(async () => ok({ error: "invalid_client", error_description: "bad client idSECRETO" }, 401));
    const r = await requestApiToken({ clientId: "idSECRETO", clientSecret: "otroSecreto", env: "prod" }, f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.attempts).toHaveLength(1);
      expect(r.attempts[0]!.kind).toBe("invalid_credentials");
      expect(r.attempts[0]!.endpoint).toBe("api.globalgetnet.com/authentication/oauth2/access_token");
      expect(JSON.stringify(r.attempts)).not.toContain("idSECRETO");
    }
  });

  it("clasifica los errores del gateway", () => {
    expect(parseApiError(JSON.stringify({ statusCode: 401, message: "Invalid token" }))).toEqual({ code: "401", message: "Invalid token" });
    expect(
      parseApiError(
        JSON.stringify({ message: "Forbidden", details: [{ status: "DENIED", error_code: "CONFIG-403", description_detail: "Product not enabled" }] }),
      ),
    ).toEqual({ code: "CONFIG-403", message: "Product not enabled" });
    expect(classifyApiFailure(403, "CONFIG-403", "tokenize")).toBe("forbidden");
    expect(classifyApiFailure(400, "invalid_client", "token")).toBe("invalid_credentials");
    expect(classifyApiFailure(0, null, "pay")).toBe("network");
    expect(classifyApiFailure(503, null, "pay")).toBe("provider_down");
    expect(makeAttempt("tokenize", "https://api.globalgetnet.com/dpm/cofre-gw-proxy/v1/tokens/card?x=1", 403, "{}").endpoint).toBe(
      "api.globalgetnet.com/dpm/cofre-gw-proxy/v1/tokens/card",
    );
  });

  it("scrub borra secretos y cualquier número de tarjeta", () => {
    expect(scrub("card 4507990000004905 secret abcd1234", ["abcd1234"])).toBe("card **** secret ***");
  });

  it("headers con seller y canal sólo si existen", () => {
    expect(apiHeaders("t")).not.toHaveProperty("x-seller-id");
    const h = apiHeaders("t", { sellerId: SELLER, channelEntry: "XX" });
    expect(h["x-seller-id"]).toBe(SELLER);
    expect(h["x-transaction-channel-entry"]).toBe("XX");
    expect(h.Authorization).toBe("Bearer t");
  });
});

describe("Checkout API · detección de slot", () => {
  it("Checkout API cargada en Web Checkout: avisa", () => {
    const v = classifyCredential({ slot: "web_checkout", webToken: true, webProduct: false, apiToken: true });
    expect(v).toEqual({ looksLike: "checkout_api", mismatch: true });
    expect(classifyCredential({ slot: "web_checkout", webToken: false, webProduct: null, apiToken: true }).mismatch).toBe(true);
    expect(SLOT_MISMATCH_COPY.web_checkout).toBe(
      "Estas credenciales son de Checkout API / Plugin VTEX. Cargá las de Web Checkout / Plugin Magento / Plugin WooCommerce.",
    );
    // El front muestra el mismo texto que la Edge.
    expect(GETNET_VTEX_IN_WEB_CHECKOUT).toBe(SLOT_MISMATCH_COPY.web_checkout);
  });

  it("Web Checkout cargada en Checkout API: avisa", () => {
    const v = classifyCredential({ slot: "checkout_api", webToken: true, webProduct: true, apiToken: false });
    expect(v).toEqual({ looksLike: "web_checkout", mismatch: true });
    expect(SLOT_MISMATCH_COPY.checkout_api).toMatch(/Web Checkout \/ Plugin Magento \/ Plugin WooCommerce/);
  });

  it("cada una en su lugar: sin aviso", () => {
    expect(classifyCredential({ slot: "web_checkout", webToken: true, webProduct: true, apiToken: true }).mismatch).toBe(false);
    expect(classifyCredential({ slot: "checkout_api", webToken: false, webProduct: null, apiToken: true }).mismatch).toBe(false);
    expect(classifyCredential({ slot: "checkout_api", webToken: true, webProduct: null, apiToken: true }).looksLike).toBe("both");
  });
});

describe("Checkout API · tarjeta, cuotas y cobro", () => {
  it("valida la tarjeta en el servidor", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    expect(cleanCard({ ...CARD, number: "4507 9900 0000 4905", holder: " juan  perez " }, now)).toEqual({
      ok: true,
      card: { ...CARD, holder: "JUAN PEREZ" },
    });
    expect(cleanCard({ ...CARD, number: "4507990000004906" }, now)).toEqual({ ok: false, error: "invalid_card" });
    expect(cleanCard({ ...CARD, exp_year: "25" }, now)).toEqual({ ok: false, error: "card_expired" });
    expect(cleanCard({ ...CARD, cvv: "1" }, now)).toEqual({ ok: false, error: "invalid_card" });
    expect(cleanCard(null, now)).toEqual({ ok: false, error: "invalid_card" });
  });

  it("mapea marcas del checkout a Getnet (débito incluido)", () => {
    expect(apiBrand("visa_debito")).toEqual({ key: "visa_debito", brand: "VISA", debit: true });
    expect(apiBrand("master")?.brand).toBe("MASTERCARD");
    expect(apiBrand("diners")).toBeNull();
  });

  it("arma tokenización y cotización", () => {
    expect(buildTokenizeBody("4507 9900 0000 4905", "intent")).toEqual({ card_number: "4507990000004905", customer_id: "intent" });
    expect(buildQuotesBody({ amountCents: 110000, bin: "450799000000", numberToken: "tok" })).toEqual({
      amount: 110000,
      bin: "450799000",
      number_token: "tok",
      installment_type_filter: "no_interest",
    });
  });

  it("elige la cotización de las cuotas pedidas sin interés y con el mismo total", () => {
    const opts = parseQuotes({
      options: [
        { quote_id: "q1", schema: "plan_emisor", type: "with_interest", number: 3, total_amount: "120000" },
        { quote_id: "q2", schema: "plan_ahora", type: "no_interest", number: 3, total_amount: "110000" },
        { quote_id: "q3", schema: "plan_ahora", type: "no_interest", number: 6, total_amount: "110000" },
        { bad: true },
      ],
    });
    expect(opts).toHaveLength(3);
    expect(pickQuote(opts, 3, 110000)?.quote_id).toBe("q2");
    expect(pickQuote(opts, 3, 999)).toBeNull();
    expect(pickQuote(opts, 12, 110000)).toBeNull();
  });

  it("payload del cobro: 1 pago FULL, cuotas con quote, débito siempre 1 pago", () => {
    const base = {
      intentId: "i",
      paymentId: "p",
      idempotencyKey: "k",
      amountCents: 110000,
      installments: 1,
      debit: false,
      brand: "VISA",
      numberToken: "tok",
      card: CARD,
      quote: null,
    };
    const one = buildApiPaymentBody(base);
    expect(one.data.currency).toBe("ARS");
    expect(one.data.amount).toBe(110000);
    expect(one.data.payment.transaction_type).toBe("FULL");
    expect(one.data.payment.card).not.toHaveProperty("number");
    expect(one.data.payment.card.number_token).toBe("tok");
    expect(one.data).not.toHaveProperty("additional_data");

    const quote = { quote_id: "q2", schema: "plan_ahora", type: "no_interest", number: 3, total_amount: 110000 };
    const three = buildApiPaymentBody({ ...base, installments: 3, quote });
    expect(three.data.payment.transaction_type).toBe("INSTALL_NO_INTEREST");
    expect(three.data.payment.number_installments).toBe(3);
    expect(three.data.additional_data).toEqual({ installment: { quote_id: "q2", schema: "plan_ahora" } });

    const debit = buildApiPaymentBody({ ...base, debit: true, installments: 6 });
    expect(debit.data.payment.payment_method).toBe("DEBIT");
    expect(debit.data.payment.number_installments).toBe(1);

    expect(() => buildApiPaymentBody({ ...base, installments: 3 })).toThrow("quote_required");
    expect(() => buildApiPaymentBody({ ...base, amountCents: 0 })).toThrow("invalid_amount");
  });

  it("recargo con el mismo redondeo que Payway", () => {
    expect(finalAmountWithSurcharge(1000, 10)).toBe(1100);
    expect(finalAmountWithSurcharge(999.99, 7.5)).toBe(1074.99);
  });
});

describe("Checkout API · respuestas y estados", () => {
  it("aprobado sólo con monto exacto", () => {
    const body = { payment_id: "pid", amount: "110000", status: "APPROVED", authorization_code: "502050", brand: "VISA" };
    expect(classifyApiPayResponse(200, body, 110000)).toEqual({
      kind: "approved",
      paymentId: "pid",
      amountCents: 110000,
      authCode: "502050",
      brand: "VISA",
    });
    expect(classifyApiPayResponse(200, body, 120000).kind).toBe("amount_mismatch");
    expect(classifyApiPayResponse(201, { ...body, status: "CAPTURED" }, 110000).kind).toBe("approved");
  });

  it("DENIED es rechazo del emisor; ERROR y HTTP 4xx no culpan a la tarjeta", () => {
    expect(classifyApiPayResponse(200, { payment_id: "pid", status: "DENIED", reason_message: "insufficient" }, 1).kind).toBe(
      "rejected",
    );
    expect(classifyApiPayResponse(200, { status: "ERROR" }, 1).kind).toBe("error");
    const forb = classifyApiPayResponse(403, { message: "Forbidden", details: [{ error_code: "CONFIG-403" }] }, 1);
    expect(forb).toMatchObject({ kind: "error", reason: "not_enabled" });
    expect(classifyApiPayResponse(422, { message: "Validation" }, 1)).toMatchObject({ kind: "error", reason: "card_data" });
    expect(classifyApiPayResponse(200, { status: "AUTHORIZED", payment_id: "pid" }, 1).kind).toBe("pending");
  });

  it("respuesta HTTP igual al checkout de Payway", () => {
    expect(apiPayHttpResponse({ kind: "approved", paymentId: "p", amountCents: 1, authCode: null, brand: null }, 10)).toEqual({
      status: 200,
      body: { ok: true, status: "approved", amount: 10 },
    });
    expect(apiPayHttpResponse({ kind: "rejected", paymentId: "p", reason: null }, 10).status).toBe(402);
    expect(apiPayHttpResponse({ kind: "pending", paymentId: "p", state: "AUTHORIZED" }, 10).status).toBe(202);
    expect(apiPayHttpResponse({ kind: "error", httpStatus: 500, reason: "gateway", detail: "" }, 10).body.error).toBe("getnet_error");
  });

  it("estado: acredita si cubre la base y devuelve el total cobrado", () => {
    expect(decideApiPaymentInfo({ status: "APPROVED", payment: { amount: 110000 } }, 1000)).toEqual({
      status: "approved",
      state: "APPROVED",
      amountCents: 110000,
    });
    expect(decideApiPaymentInfo({ status: "APPROVED", amount: "50000" }, 1000).reason).toBe("amount_mismatch");
    expect(decideApiPaymentInfo({ status: "APPROVED" }, 1000).reason).toBe("amount_unverified");
    expect(decideApiPaymentInfo({ status: "DENIED" }, 1000).status).toBe("rejected");
    expect(decideApiPaymentInfo({ status: "CANCELED" }, 1000).status).toBe("cancelled");
    expect(decideApiPaymentInfo({ status: "PENDING" }, 1000).status).toBe("pending");
    expect(decideApiPaymentInfo(null, 1000).status).toBe("pending");
  });

  it("reconoce el intent del checkout propio y el payment_id", () => {
    const id = "3f2a3c1e-1111-4222-8333-444455556666";
    const url = ownCheckoutUrl("https://pos.soft.ninja/", id);
    expect(url).toBe(`https://pos.soft.ninja/pagar/${id}?p=getnet`);
    expect(isOwnCheckoutIntent(url)).toBe(true);
    expect(isOwnCheckoutIntent("https://checkout.globalgetnet.com/abc")).toBe(false);
    expect(isApiPaymentId(id)).toBe(true);
    expect(isApiPaymentId("12345")).toBe(false);
  });

  it("normaliza el pago de la Checkout API para el detalle de la venta", () => {
    const d = normalizeGetnetOrder({
      payment_id: "173f9e8d-4e0b-4503-8016-5cdafba89bee",
      order_id: "intent",
      status: "APPROVED",
      amount: "110000",
      currency: "ARS",
      brand: "VISA",
      authorization_code: "502050",
      authorized_at: "2026-10-12T12:00:00Z",
      payment: { number_installments: 3, payment_method: "CREDIT" },
    });
    expect(d.status).toBe("approved");
    expect(d.gross).toBe(1100);
    expect(d.installments).toBe(3);
    expect(d.authorization).toBe("502050");
    expect(d.external_id).toBe("173f9e8d-4e0b-4503-8016-5cdafba89bee");
  });
});

describe("guardado de Web Checkout (ADR-069 adenda)", () => {
  it("rechaza credenciales de Checkout API / Plugin VTEX", () => {
    expect(webCheckoutSaveVerdict({ webToken: true, webProduct: false, apiToken: true, webFailKinds: [] })).toBe(
      "checkout_api_credentials",
    );
    expect(
      webCheckoutSaveVerdict({ webToken: false, webProduct: null, apiToken: true, webFailKinds: ["invalid_credentials"] }),
    ).toBe("checkout_api_credentials");
    expect(getnetSaveError("getnet_checkout_api_credentials")).toBe(GETNET_VTEX_IN_WEB_CHECKOUT);
  });

  it("rechaza credenciales inválidas en todas las APIs", () => {
    expect(
      webCheckoutSaveVerdict({
        webToken: false,
        webProduct: null,
        apiToken: false,
        webFailKinds: ["invalid_credentials", "invalid_credentials"],
      }),
    ).toBe("invalid_credentials");
    expect(getnetSaveError("getnet_invalid_credentials")).toMatch(/Web Checkout \/ Plugin Magento \/ Plugin WooCommerce/);
  });

  it("deja guardar Web Checkout y no bloquea por un corte de Getnet", () => {
    expect(webCheckoutSaveVerdict({ webToken: true, webProduct: true, apiToken: true, webFailKinds: [] })).toBe("ok");
    expect(webCheckoutSaveVerdict({ webToken: true, webProduct: true, apiToken: false, webFailKinds: [] })).toBe("ok");
    expect(
      webCheckoutSaveVerdict({ webToken: false, webProduct: null, apiToken: false, webFailKinds: ["network", "provider_down"] }),
    ).toBe("ok");
  });

  it("la Checkout API apagada tiene su texto al guardar", () => {
    expect(getnetSaveError("checkout_api_unavailable")).toMatch(/no está habilitado/);
    expect(getnetSaveError("otro")).toBeNull();
  });
});

describe("slots de credenciales (wizard y POS)", () => {
  it("con el checkout propio apagado el asistente muestra sólo Web Checkout", () => {
    expect(visibleGetnetSlots(false).map((s) => s.key)).toEqual(["web_checkout"]);
    expect(visibleGetnetSlots(true).map((s) => s.key)).toEqual(["web_checkout", "checkout_api"]);
    expect(GETNET_SLOT_BY_KEY.web_checkout.title).toBe("Web Checkout / Plugin Magento / Plugin WooCommerce");
    expect(GETNET_SLOT_BY_KEY.web_checkout.credentials).toBe(
      "Estas son las credenciales que tenés que cargar. Las encontrás en el portal de Getnet como Web Checkout, Plugin Magento o Plugin WooCommerce.",
    );
    expect(GETNET_VTEX_WARNING).toBe(
      "No uses las de Checkout API / Plugin VTEX: no funcionan para cobrar con QR ni link desde NinjaSoft.",
    );
  });

  it("una conexión vieja sin flags es Web Checkout", () => {
    expect(getnetSlotsOf({ connected: true })).toEqual({ web_checkout: true, checkout_api: false });
    expect(getnetSlotsOf({ connected: true, web_checkout_connected: false, checkout_api_connected: true })).toEqual({
      web_checkout: false,
      checkout_api: true,
    });
    expect(getnetSlotsOf(null)).toEqual({ web_checkout: false, checkout_api: false });
    expect(getnetSlotsFromKeys(["api_client_id", "api_client_secret"])).toEqual({ web_checkout: false, checkout_api: true });
  });

  it("guarda un slot sin tocar el otro y borra datos viejos del mismo", () => {
    const api = getnetSlotSave("checkout_api", { api_client_id: "id", api_client_secret: "sec" }, "test");
    expect(api.secrets).toEqual({ api_client_id: "id", api_client_secret: "sec", api_environment: "test" });
    expect(api.remove).toEqual([]);
    expect(api.remove.some((k) => k.startsWith("client_"))).toBe(false);

    const web = getnetSlotSave("web_checkout", { client_id: "id", client_secret: "sec" }, "prod");
    expect(web.secrets.environment).toBe("prod");
    expect(web.remove).toContain("api_profile");
    expect(web.remove.some((k) => k.startsWith("api_client"))).toBe(false);
    expect(getnetSlotClearKeys("checkout_api")).toContain("api_client_secret");
    expect(getnetSlotClearKeys("checkout_api")).not.toContain("client_secret");
  });

  it("copy de los slots dice qué credencial usar", () => {
    expect(GETNET_SLOT_BY_KEY.web_checkout.purpose).toMatch(/QR o link/);
    expect(GETNET_SLOT_BY_KEY.web_checkout.credentials).toMatch(/Web Checkout, Plugin Magento o Plugin WooCommerce/);
    expect(GETNET_SLOT_BY_KEY.checkout_api.purpose).toMatch(/como Payway/);
    expect(GETNET_SLOT_BY_KEY.checkout_api.credentials).toMatch(/Checkout API \/ Plugin VTEX/);
    expect(getnetSlotError("web_checkout_not_connected")).toMatch(/Web Checkout/);
    expect(getnetSlotError("otro")).toBeNull();
  });

  it("la prueba de Checkout API guarda el Seller ID del token", () => {
    expect(probeSecrets({ ok: true, slot: "checkout_api", environment: "prod", seller_id: SELLER }, "prod")).toEqual({
      api_seller_id: SELLER,
    });
    expect(probeSecrets({ ok: false, slot: "checkout_api" }, "prod")).toEqual({});
    expect(probeSecrets({ ok: true, slot: "web_checkout", environment: "prod", profile: "global_prod" }, "prod")).toEqual({
      environment: "prod",
      api_profile: "global_prod",
    });
  });

  it("POS: el checkout propio exige Checkout API, su feature y el flag PCI; QR y link, Web Checkout", () => {
    const row = (over: Partial<ProviderStatus>): ProviderStatus => ({ provider_key: "getnet", enabled: true, connected: true, ...over });
    const ctx = (r: ProviderStatus, features?: Record<string, boolean>): TenderContext => ({
      providers: [r],
      features,
      hasCustomer: false,
      storeCreditBalance: 0,
    });
    const ids = (c: TenderContext) => resolveTenders(c).map((t) => t.id).filter((id) => id.startsWith("getnet"));

    expect(ids(ctx(row({})))).toEqual(["getnet:qr", "getnet:link"]);
    // Flag PCI apagado (o sin respuesta de la Edge): el tender propio no aparece.
    expect(ids(ctx(row({ web_checkout_connected: true, checkout_api_connected: true })))).toEqual([
      "getnet:qr",
      "getnet:link",
    ]);
    expect(
      ids(ctx(row({ web_checkout_connected: false, checkout_api_connected: true, own_checkout_enabled: false }))),
    ).toEqual([]);
    expect(
      ids(ctx(row({ web_checkout_connected: false, checkout_api_connected: true, own_checkout_enabled: true }))),
    ).toEqual(["getnet:own"]);
    expect(
      ids(ctx(row({ web_checkout_connected: true, checkout_api_connected: true, own_checkout_enabled: true }))),
    ).toEqual(["getnet:qr", "getnet:link", "getnet:own"]);
    const all = row({ web_checkout_connected: true, checkout_api_connected: true, own_checkout_enabled: true });
    expect(ids(ctx(all, { getnet: true, getnet_checkout_propio: false }))).toEqual(["getnet:qr", "getnet:link"]);
    expect(TENDER_BY_ID["getnet:own"]?.label).toBe("Link (checkout propio)");
  });
});

describe("/pagar por procesador", () => {
  it("elige el backend por ?p= (links viejos = Payway)", () => {
    expect(checkoutProviderOf(null)).toBe("payway");
    expect(checkoutProviderOf("getnet")).toBe("getnet");
    expect(checkoutProviderOf("otro")).toBe("payway");
    expect(CHECKOUT_EDGE.getnet).toBe("getnet_checkout");
    expect(SECURE_COPY.getnet).not.toMatch(/directo a/);
  });

  it("body del cobro de Getnet con la tarjeta limpia", () => {
    expect(
      buildGetnetPayBody("i", "master", 3, { number: "5155 9012 2226 0000", exp: "9/30", cvv: "123", holder: " ana ", dni: "30.123.456" }),
    ).toEqual({
      action: "pay",
      intent_id: "i",
      brand: "master",
      installments: 3,
      card: { number: "5155901222260000", exp_month: "09", exp_year: "30", cvv: "123", holder: "ANA", dni: "30123456" },
    });
  });

  it("mensajes del cliente para Getnet", () => {
    expect(paywayPayMessage({ error: "getnet_error", reason: "card_data" })).toMatch(/Revisá los datos/);
    expect(paywayPayMessage({ error: "card_expired" })).toMatch(/vencida/);
    expect(paywayPayMessage({ error: "checkout_api_unavailable" })).toMatch(/otro medio/);
  });
});
