import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  baseHeaders,
  buildOrderBody,
  decideIntentUpdate,
  directoClient,
  directoEnv,
  extractNotificationId,
  mapDirectoStatus,
  merchantHash,
  normalizeBaseUrl,
  notificationHashPayload,
  parseCreds,
  parseLoginResponse,
  parseOrderResponse,
  pick,
  resolveBaseUrl,
  type DirectoCreds,
} from "@/supabase/functions/_shared/directo";

const INTENT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const OTHER = "11111111-2222-4333-8444-555555555555";
const BASE = "https://api.qa.directo.example/";

const CREDS: DirectoCreds = {
  apiKey: "ak-123",
  username: "comercio",
  password: "secreto",
  merchantName: "Kiosco Ninja",
  subscriptionKey: "sub-456",
  baseUrl: BASE,
};

// Clave/IV de prueba (los reales viven en los secretos de la función).
const DIRECTO_HASH_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const DIRECTO_HASH_IV_B64 = Buffer.alloc(16, 3).toString("base64");
const HASH = { keyB64: DIRECTO_HASH_KEY_B64, ivB64: DIRECTO_HASH_IV_B64 };

const res = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// Mismo cálculo que openssl_encrypt(AES-256-CBC, OPENSSL_RAW_DATA) del plugin.
function opensslHash(plain: string) {
  const c = createCipheriv(
    "aes-256-cbc",
    Buffer.from(DIRECTO_HASH_KEY_B64, "base64"),
    Buffer.from(DIRECTO_HASH_IV_B64, "base64"),
  );
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}

const ORDER = {
  amount: 12500.5,
  merchantOrderId: INTENT,
  notifyUrl: `https://x.supabase.co/functions/v1/directo_webhook?intent=${INTENT}`,
  successUrl: "https://x.supabase.co/functions/v1/directo_webhook?view=success",
  errorUrl: "https://x.supabase.co/functions/v1/directo_webhook?view=failed",
};

describe("directo · ambiente y URL base", () => {
  it("el switch Sandbox elige QA", () => {
    expect(directoEnv(true)).toBe("qa");
    expect(directoEnv(false)).toBe("prod");
    expect(directoEnv(undefined)).toBe("prod");
  });

  it("normaliza la URL base con / final y sólo https", () => {
    expect(normalizeBaseUrl("https://api.directo.example")).toBe("https://api.directo.example/");
    expect(normalizeBaseUrl(" https://api.directo.example/v2 ")).toBe("https://api.directo.example/v2/");
    expect(normalizeBaseUrl("http://api.directo.example/")).toBeNull();
    expect(normalizeBaseUrl("https://u:p@api.directo.example/")).toBeNull();
    expect(normalizeBaseUrl("https://api.directo.example/?x=1")).toBeNull();
    expect(normalizeBaseUrl("no es url")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
  });

  it("usa la URL de la conexión y falla claro si no hay ninguna", () => {
    expect(resolveBaseUrl("prod", "https://a.example")).toBe("https://a.example/");
    expect(() => resolveBaseUrl("qa", null)).toThrow("directo_base_url_missing");
  });
});

describe("directo · credenciales", () => {
  it("exige api_key, usuario, contraseña y nombre del comercio", () => {
    const ok = parseCreds({
      api_key: " ak ",
      merchant_username: "u",
      merchant_password: "p",
      merchant_name: "N",
      api_base_url: BASE,
    });
    expect(ok).toEqual({
      apiKey: "ak",
      username: "u",
      password: "p",
      merchantName: "N",
      subscriptionKey: null,
      baseUrl: BASE,
    });
    expect(parseCreds({ api_key: "ak", merchant_username: "u", merchant_password: "p" })).toBeNull();
    expect(parseCreds(null)).toBeNull();
  });

  it("headers del plugin: ApiKey y la Subscription Key de APIM sólo si existe", () => {
    expect(baseHeaders(CREDS)).toMatchObject({
      ApiKey: "ak-123",
      "Ocp-Apim-Subscription-Key": "sub-456",
      "Content-Type": "application/json",
    });
    expect(baseHeaders({ ...CREDS, subscriptionKey: null })).not.toHaveProperty("Ocp-Apim-Subscription-Key");
  });
});

describe("directo · MerchantHash", () => {
  it("coincide con openssl AES-256-CBC del plugin oficial", async () => {
    const plain = notificationHashPayload("tok", "abc-123");
    expect(await merchantHash(plain, DIRECTO_HASH_KEY_B64, DIRECTO_HASH_IV_B64)).toBe(opensslHash(plain));
    const body = buildOrderBody({ ...ORDER, token: "tok", merchantName: "Kiosco" });
    expect(await merchantHash(body, DIRECTO_HASH_KEY_B64, DIRECTO_HASH_IV_B64)).toBe(opensslHash(body));
  });

  it("sin clave/IV configurados no firma (vienen de los secretos)", async () => {
    await expect(merchantHash("x")).rejects.toThrow("directo_hash_config");
  });

  it("rechaza una clave o IV de largo inválido", async () => {
    await expect(merchantHash("x", "AAAA", DIRECTO_HASH_IV_B64)).rejects.toThrow("directo_hash_config");
  });
});

describe("directo · cuerpo de la orden", () => {
  it("mismos campos y orden que el plugin, con el intent como Merchant_Order_Id", () => {
    const body = buildOrderBody({
      ...ORDER,
      token: "tok",
      merchantName: " Kiosco Ninja ",
      email: "a@b.com",
      phone: "+54 9 11 1234-5678",
    });
    const o = JSON.parse(body);
    expect(Object.keys(o)).toEqual([
      "Currency",
      "Merchant_Name",
      "Products",
      "Document",
      "Phone_Number",
      "Address",
      "Description",
      "Email",
      "Merchant_Order_Id",
      "Notify_Url",
      "Price",
      "Additional_Data",
      "Return_Url_Success",
      "Return_Url_Error",
      "Merchanthash",
      "Integration_Type",
    ]);
    expect(o).toMatchObject({
      Currency: "ARS",
      Merchant_Name: "Kiosco Ninja",
      Products: "Compra en Kiosco Ninja",
      Merchant_Order_Id: INTENT,
      Price: "12500.50",
      Additional_Data: "{}",
      Merchanthash: "tok",
      Email: "a@b.com",
      Phone_Number: "+5491112345678",
      Notify_Url: ORDER.notifyUrl,
    });
  });

  it("monto inválido no arma orden", () => {
    expect(() => buildOrderBody({ ...ORDER, amount: 0, token: "t", merchantName: "N" })).toThrow("invalid_amount");
    expect(() => buildOrderBody({ ...ORDER, amount: NaN, token: "t", merchantName: "N" })).toThrow("invalid_amount");
  });

  it("sin email ni teléfono viajan null", () => {
    const o = JSON.parse(buildOrderBody({ ...ORDER, token: "t", merchantName: "N" }));
    expect(o.Email).toBeNull();
    expect(o.Phone_Number).toBeNull();
  });
});

describe("directo · respuestas", () => {
  it("login devuelve credentials", () => {
    expect(parseLoginResponse({ credentials: "tok" })).toBe("tok");
    expect(parseLoginResponse({ Credentials: "tok2" })).toBe("tok2");
    expect(parseLoginResponse({})).toBeNull();
  });

  it("orden devuelve redirect_Url https", () => {
    expect(parseOrderResponse({ redirect_Url: "https://pay.directo.example/x" })).toEqual({
      redirectUrl: "https://pay.directo.example/x",
    });
    expect(parseOrderResponse({ redirect_Url: "javascript:alert(1)" })).toBeNull();
    expect(parseOrderResponse({ redirect_Url: "http://pay.directo.example" })).toBeNull();
    expect(parseOrderResponse(null)).toBeNull();
  });

  it("pick ignora mayúsculas", () => {
    expect(pick({ merchant_Order_Id: "a" }, "merchant_order_id")).toBe("a");
    expect(pick("x", "a")).toBeUndefined();
  });
});

describe("directo · webhook", () => {
  it("el cuerpo sólo aporta el notification_id (validado)", () => {
    expect(extractNotificationId({ notification_id: "abc-123" })).toBe("abc-123");
    expect(extractNotificationId({ notification_id: 42 })).toBe("42");
    expect(extractNotificationId({ notification_id: "../orders" })).toBeNull();
    expect(extractNotificationId("nada")).toBeNull();
  });

  it("estados: sólo Successful acredita", () => {
    expect(mapDirectoStatus("Successful")).toBe("approved");
    expect(mapDirectoStatus("Approved")).toBe("pending");
    expect(mapDirectoStatus("Cancel")).toBe("cancelled");
    expect(mapDirectoStatus("Rejected")).toBe("rejected");
    expect(mapDirectoStatus("Pending")).toBe("pending");
    expect(mapDirectoStatus(undefined)).toBe("pending");
  });
});

describe("directo · decisión sobre la notificación re-consultada", () => {
  it("acredita Successful con la referencia propia", () => {
    expect(decideIntentUpdate({ merchant_Order_Id: INTENT, status: "Successful" }, 100, INTENT)).toEqual({
      status: "approved",
      state: "Successful",
      reason: "amount_not_reported",
    });
  });

  it("ignora notificaciones de otra orden", () => {
    expect(decideIntentUpdate({ merchant_Order_Id: OTHER, status: "Successful" }, 100, INTENT)).toMatchObject({
      status: "pending",
      reason: "reference_mismatch",
    });
  });

  it("si informa monto, tiene que ser exacto", () => {
    expect(
      decideIntentUpdate({ merchant_Order_Id: INTENT, status: "Successful", price: "100.00" }, 100, INTENT),
    ).toEqual({ status: "approved", state: "Successful" });
    expect(
      decideIntentUpdate({ merchant_Order_Id: INTENT, status: "Successful", Price: 99.5 }, 100, INTENT),
    ).toMatchObject({ status: "rejected", reason: "amount_mismatch" });
  });

  it("Cancel cancela y lo desconocido queda pendiente", () => {
    expect(decideIntentUpdate({ merchant_Order_Id: INTENT, status: "Cancel" }, 100, INTENT).status).toBe(
      "cancelled",
    );
    expect(decideIntentUpdate({ merchant_Order_Id: INTENT, status: "InProgress" }, 100, INTENT).status).toBe(
      "pending",
    );
    expect(decideIntentUpdate(null, 100, INTENT).status).toBe("pending");
  });
});

describe("directo · cliente HTTP", () => {
  it("login una vez por invocación, orden firmada y notificación firmada", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("api/merchant/login")) return res(200, { credentials: "tok" });
      if (url.endsWith("api/merchant/orders")) return res(200, { redirect_Url: "https://pay.example/o/1" });
      return res(200, { merchant_Order_Id: INTENT, status: "Successful" });
    });
    const client = directoClient({ creds: CREDS, baseUrl: BASE, fetchImpl, hash: HASH });

    const order = await client.createOrder(ORDER);
    expect(order).toEqual({ ok: true, value: { redirectUrl: "https://pay.example/o/1" } });
    const n = await client.getNotification("n-1");
    expect(n.ok).toBe(true);

    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}api/merchant/login`,
      `${BASE}api/merchant/orders`,
      `${BASE}api/merchant/notification/n-1`,
    ]);
    const [login, create, notif] = calls as [(typeof calls)[0], (typeof calls)[0], (typeof calls)[0]];
    expect(JSON.parse(String(login.init.body))).toEqual({ user: "comercio", password: "secreto" });

    const orderHeaders = create.init.headers as Record<string, string>;
    expect(orderHeaders.Credentials).toBe("tok");
    expect(orderHeaders.ApiKey).toBe("ak-123");
    expect(orderHeaders.MerchantHash).toBe(opensslHash(String(create.init.body)));

    const nHeaders = notif.init.headers as Record<string, string>;
    expect(notif.init.method).toBe("GET");
    expect(nHeaders.MerchantHash).toBe(opensslHash(notificationHashPayload("tok", "n-1")));
  });

  it("login fallido corta antes de crear la orden", async () => {
    const fetchImpl = vi.fn(async () => res(401, "unauthorized"));
    const client = directoClient({ creds: CREDS, baseUrl: BASE, fetchImpl, hash: HASH });
    expect(await client.createOrder(ORDER)).toMatchObject({ ok: false, httpStatus: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("orden sin redirect_Url es error", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("login") ? res(200, { credentials: "tok" }) : res(200, { ok: true }),
    );
    const client = directoClient({ creds: CREDS, baseUrl: BASE, fetchImpl, hash: HASH });
    expect(await client.createOrder(ORDER)).toMatchObject({ ok: false, detail: "order_without_redirect_url" });
  });

  it("no consulta ids de notificación inválidos", async () => {
    const fetchImpl = vi.fn();
    const client = directoClient({ creds: CREDS, baseUrl: BASE, fetchImpl, hash: HASH });
    expect(await client.getNotification("../x")).toMatchObject({ ok: false, httpStatus: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("error de red se informa como 502", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const client = directoClient({ creds: CREDS, baseUrl: BASE, fetchImpl, hash: HASH });
    expect(await client.login()).toMatchObject({ ok: false, httpStatus: 502 });
  });
});
