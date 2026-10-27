import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIRECTO_BASE,
  buildFullName,
  buildOrderBody,
  buildRatingBody,
  clampTimeoutSeconds,
  classifyError,
  clearTokenCache,
  decideIntentUpdate,
  directoClient,
  directoEnv,
  dniFromDocument,
  extractNotificationId,
  isAuthFailure,
  isOfficialBase,
  mapDirectoStatus,
  normalizeBaseUrl,
  normalizeDni,
  parseCreds,
  parseDeadlinesResponse,
  parseOrderResponse,
  parseOrderStatus,
  parseRatingResponse,
  resolveBaseUrl,
  sexTypeId,
  splitCustomerName,
  tokenUntil,
  type DirectoCreds,
} from "@/supabase/functions/_shared/directo";
import { directoErrorCopy } from "@/lib/payments/directo";

const QA = DIRECTO_BASE.qa;
const CREDS: DirectoCreds = {
  username: "comercio",
  password: "secreto",
  policyProduct: "62",
  timeoutMs: 30_000,
  baseUrl: null,
};

const res = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {}, calls.length);
  });
  return { f, calls };
}
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));
const authOf = (c: Call) => (c.init.headers as Record<string, string>).Authorization;

const ORDER = {
  amount: 2356.75,
  fullName: "PEREZ,JUAN CARLOS",
  dni: "25555777",
  notifyUrl: "https://hooks.soft.ninja/directo?intent=abc",
  returnUrlSuccess: "https://pos.soft.ninja/pagar/listo?estado=ok&medio=directo",
  returnUrlError: "https://pos.soft.ninja/pagar/listo?estado=error&medio=directo",
};

beforeEach(() => clearTokenCache());

describe("directo · hosts y conexión", () => {
  it("hosts oficiales por ambiente (switch Sandbox = QA)", () => {
    expect(DIRECTO_BASE.qa).toBe("https://public.qa.directo.com.ar/ecommerce-qa");
    expect(DIRECTO_BASE.prod).toBe("https://public.pro.directo.com.ar/ecommerce-pro");
    expect(directoEnv(true)).toBe("qa");
    expect(directoEnv(false)).toBe("prod");
    expect(directoEnv(null)).toBe("prod");
    expect(resolveBaseUrl("qa", null)).toBe(QA);
    expect(resolveBaseUrl("prod", "")).toBe(DIRECTO_BASE.prod);
  });

  it("override avanzado: sólo https, normalizado sin barra final", () => {
    expect(normalizeBaseUrl("https://public.qa.directo.com.ar/ecommerce-qa/")).toBe(QA);
    expect(normalizeBaseUrl("http://x.com")).toBeNull();
    expect(normalizeBaseUrl("https://u:p@x.com")).toBeNull();
    expect(normalizeBaseUrl("https://x.com/?a=1")).toBeNull();
    expect(resolveBaseUrl("prod", "https://otro.example/api")).toBe("https://otro.example/api");
    expect(resolveBaseUrl("prod", "http://inseguro")).toBe(DIRECTO_BASE.prod);
    expect(isOfficialBase(`${QA}/`)).toBe(true);
    expect(isOfficialBase("https://otro.example")).toBe(false);
  });

  it("parseCreds 2.0 con policy product y timeout acotado", () => {
    const c = parseCreds({ username: " u ", password: "p", policy_product: "BNPL", timeout_seconds: "500" });
    expect(c).toEqual({ username: "u", password: "p", policyProduct: "BNPL", timeoutMs: 120_000, baseUrl: null });
    expect(parseCreds({ username: "u", password: "p", timeout_seconds: "2" })?.timeoutMs).toBe(5_000);
    expect(parseCreds({ username: "u", password: "p" })?.timeoutMs).toBe(30_000);
    expect(parseCreds({ username: "u" })).toBeNull();
    expect(parseCreds(null)).toBeNull();
  });

  it("compatibilidad: secretos viejos (ADR-041) se mapean e ignoran api_key, hash y su URL", () => {
    const c = parseCreds({
      api_key: "ak",
      subscription_key: "sk",
      merchant_name: "Kiosco",
      merchant_username: "viejo",
      merchant_password: "clave",
      api_base_url: "https://gateway.viejo.example/",
    });
    expect(c).toEqual({ username: "viejo", password: "clave", policyProduct: null, timeoutMs: 30_000, baseUrl: null });
  });

  it("timeout técnico: 30 por defecto, entre 5 y 120", () => {
    expect(clampTimeoutSeconds(undefined)).toBe(30);
    expect(clampTimeoutSeconds("abc")).toBe(30);
    expect(clampTimeoutSeconds(1)).toBe(5);
    expect(clampTimeoutSeconds(45)).toBe(45);
    expect(clampTimeoutSeconds(999)).toBe(120);
  });
});

describe("directo · comprador", () => {
  it("fullName APELLIDOS,NOMBRES en mayúsculas y sin comas internas", () => {
    expect(buildFullName("Pérez", "Juan Carlos")).toBe("PÉREZ,JUAN CARLOS");
    expect(buildFullName("  de la  Torre ", "ana, maría")).toBe("DE LA TORRE,ANA MARÍA");
    expect(buildFullName("Pérez", "")).toBeNull();
    expect(buildFullName("", "Juan")).toBeNull();
  });

  it("splitCustomerName propone apellido y nombres", () => {
    expect(splitCustomerName("Pérez, Juan Carlos")).toEqual({ lastName: "Pérez", firstName: "Juan Carlos" });
    expect(splitCustomerName("Juan Carlos Pérez")).toEqual({ lastName: "Pérez", firstName: "Juan Carlos" });
    expect(splitCustomerName("Pérez")).toEqual({ lastName: "Pérez", firstName: "" });
    expect(splitCustomerName(null)).toEqual({ lastName: "", firstName: "" });
  });

  it("DNI desde el documento del cliente", () => {
    expect(normalizeDni("25.555.777")).toBe("25555777");
    expect(normalizeDni("12")).toBeNull();
    expect(dniFromDocument("dni", "25555777")).toBe("25555777");
    expect(dniFromDocument("cuil", "20-25555777-3")).toBe("25555777");
    expect(dniFromDocument("cuit", "30712345678")).toBeNull();
    expect(dniFromDocument("passport", "AB123")).toBeNull();
  });

  it("sexTypeId: 2/M masculino, 3/F femenino", () => {
    expect(sexTypeId("M")).toBe("2");
    expect(sexTypeId("m")).toBe("2");
    expect(sexTypeId(2)).toBe("2");
    expect(sexTypeId("F")).toBe("3");
    expect(sexTypeId("3")).toBe("3");
    expect(sexTypeId("X")).toBeNull();
  });
});

describe("directo · cuerpos", () => {
  it("create_order con la forma del documento (price número, 2 decimales)", () => {
    const b = buildOrderBody({ ...ORDER, amount: 2356.749, policyProduct: "BNPL" });
    expect(b).toEqual({
      price: 2356.75,
      fullName: "PEREZ,JUAN CARLOS",
      dni: "25555777",
      notifyUrl: ORDER.notifyUrl,
      returnUrlSuccess: ORDER.returnUrlSuccess,
      returnUrlError: ORDER.returnUrlError,
      policyProduct: "BNPL",
    });
    expect("policyProduct" in buildOrderBody(ORDER)).toBe(false);
    expect(() => buildOrderBody({ ...ORDER, amount: 0 })).toThrow("invalid_amount");
    expect(() => buildOrderBody({ ...ORDER, fullName: "PEREZ JUAN" })).toThrow("invalid_full_name");
    expect(() => buildOrderBody({ ...ORDER, dni: "x" })).toThrow("invalid_dni");
  });

  it("rating con name, dni, sexTypeId y policyProduct", () => {
    expect(buildRatingBody({ fullName: "PEREZ,JUAN", dni: "25555777", sex: "M", policyProduct: "62" })).toEqual({
      name: "PEREZ,JUAN",
      dni: "25555777",
      sexTypeId: "2",
      policyProduct: "62",
    });
    expect(() => buildRatingBody({ fullName: "PEREZ,JUAN", dni: "25555777", sex: "" })).toThrow("invalid_sex");
  });

  it("respuestas de orden, estado, rating y planes", () => {
    expect(
      parseOrderResponse({
        merchantOrderId: "CZQB334059",
        creationDate: "2024-01-25T11:34:04.0098952",
        redirectUrl: "https://uat-app.directo.com.ar/compra-cuotas?hash=abc",
      }),
    ).toEqual({
      merchantOrderId: "CZQB334059",
      creationDate: "2024-01-25T11:34:04.0098952",
      redirectUrl: "https://uat-app.directo.com.ar/compra-cuotas?hash=abc",
    });
    expect(parseOrderResponse({ merchantOrderId: "X", redirectUrl: "http://inseguro" })).toBeNull();
    expect(parseOrderResponse({ merchantOrderId: "../x", redirectUrl: "https://a" })).toBeNull();

    expect(
      parseOrderStatus({
        status: "Success",
        merchantOrderId: "GSPN891045",
        installments: "3",
        installmentAmount: "13232.43",
        amount: "39697.29",
        creditNumber: "8698",
      }),
    ).toEqual({
      status: "Success",
      merchantOrderId: "GSPN891045",
      installments: 3,
      installmentAmount: 13232.43,
      amount: 39697.29,
      creditNumber: "8698",
    });

    expect(
      parseRatingResponse({
        pendingRequestId: 11222333,
        offer: [{ maximumAmount: 550000, minimumAmount: 1000, maximumRate: 12 }],
        campaignMessage: "RENOVADOR",
      }),
    ).toEqual({
      pendingRequestId: "11222333",
      offers: [{ maximumAmount: 550000, minimumAmount: 1000, maximumRate: 12 }],
      campaignMessage: "RENOVADOR",
    });

    const plans = parseDeadlinesResponse({
      pendingRequestId: 11222333,
      deadlines: [
        {
          quantityRate: 2,
          amountRate: 25000.03,
          expirationDate: "2024-07-07T00:00:00",
          disclaimer: [{ type: "date", content: "se paga la primer cuota hoy" }],
          plan: [{ expiration: "Hoy!", quote: "1", amount: "25000.03" }],
          planType: "DEFERRED_PAYMENT",
        },
      ],
    });
    expect(plans).toEqual([
      {
        installments: 2,
        installmentAmount: 25000.03,
        planType: "DEFERRED_PAYMENT",
        disclaimers: ["se paga la primer cuota hoy"],
        schedule: [{ expiration: "Hoy!", quote: "1", amount: 25000.03 }],
      },
    ]);
  });
});

describe("directo · estados y webhook", () => {
  it("mapea Success / Cancel / Pending", () => {
    expect(mapDirectoStatus("Success")).toBe("approved");
    expect(mapDirectoStatus("Cancel")).toBe("cancelled");
    expect(mapDirectoStatus("Pending")).toBe("pending");
    expect(mapDirectoStatus("Successful")).toBe("pending");
    expect(mapDirectoStatus(undefined)).toBe("pending");
  });

  it("notification_id del cuerpo: sólo ids seguros para el path", () => {
    expect(extractNotificationId({ notification_id: 1255 })).toBe("1255");
    expect(extractNotificationId({ notification_id: "../x" })).toBeNull();
    expect(extractNotificationId({})).toBeNull();
    expect(extractNotificationId("x")).toBeNull();
  });

  it("aprueba Success sólo con el merchantOrderId de la orden propia", () => {
    const st = { status: "Success", merchantOrderId: "GSPN891045", installments: "3", amount: "39697.29", creditNumber: "8698" };
    const ok = decideIntentUpdate(st, { merchantOrderId: "GSPN891045", amount: 39697.29 });
    expect(ok.status).toBe("approved");
    expect(ok.credit).toEqual({
      credit_number: "8698",
      installments: 3,
      installment_amount: null,
      capital: 39697.29,
      capital_differs: false,
    });
    const other = decideIntentUpdate(st, { merchantOrderId: "OTRA", amount: 39697.29 });
    expect(other).toEqual({ status: "pending", state: "Success", reason: "order_mismatch" });
  });

  it("capital distinto del precio: aprueba y lo marca (ADR-181)", () => {
    const d = decideIntentUpdate(
      { status: "Success", merchantOrderId: "A1", amount: "30000" },
      { merchantOrderId: "A1", amount: 39697.29 },
    );
    expect(d.status).toBe("approved");
    expect(d.credit?.capital_differs).toBe(true);
  });

  it("Cancel cancela y Pending sigue esperando", () => {
    expect(decideIntentUpdate({ status: "Cancel", merchantOrderId: "A1" }, { merchantOrderId: "A1", amount: 1 }).status).toBe(
      "cancelled",
    );
    expect(decideIntentUpdate({ status: "Pending", merchantOrderId: "A1" }, { merchantOrderId: "A1", amount: 1 }).status).toBe(
      "pending",
    );
    expect(decideIntentUpdate(null, { merchantOrderId: "A1", amount: 1 }).status).toBe("pending");
  });
});

describe("directo · errores", () => {
  it("clasifica los mensajes del documento", () => {
    expect(classifyError(400, "Invalid Person")).toBe("directo_invalid_person");
    expect(classifyError(400, "policyProduct field is spected")).toBe("directo_policy_required");
    expect(classifyError(404, "Rejected")).toBe("directo_rejected");
    expect(classifyError(404, "InvalidPlan")).toBe("directo_invalid_plan");
    expect(classifyError(404, "No Installments found")).toBe("directo_no_installments");
    expect(classifyError(400, "Invalid Request")).toBe("directo_invalid_request");
    expect(classifyError(500, "Comunication error")).toBe("directo_error");
    expect(classifyError(403, "http_403")).toBe("directo_auth_failed");
    expect(classifyError(0, "timeout")).toBe("directo_timeout");
    expect(classifyError(0, "network")).toBe("directo_unreachable");
    expect(isAuthFailure(401)).toBe(true);
    expect(isAuthFailure(500)).toBe(false);
  });

  it("cada código tiene copy en castellano", () => {
    for (const code of [
      "directo_invalid_person",
      "directo_policy_required",
      "directo_rejected",
      "directo_invalid_plan",
      "directo_no_installments",
      "directo_auth_failed",
      "directo_timeout",
      "directo_buyer_required",
      "directo_rate_limited",
    ]) {
      expect(directoErrorCopy(code)).toBeTruthy();
    }
    expect(directoErrorCopy("otra_cosa")).toBeNull();
  });
});

describe("directo · cliente HTTP", () => {
  it("login + create_order con Bearer, cuerpo oficial y token cacheado", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.endsWith("/api/v1/auth/token")) return res(200, { token: "tok-1" });
      return res(200, { merchantOrderId: "CZQB334059", creationDate: "x", redirectUrl: "https://uat-app.directo.com.ar/c" });
    });
    const c = directoClient({ creds: CREDS, env: "qa", fetchImpl: f });
    const r = await c.createOrder(ORDER);
    expect(r).toEqual({
      ok: true,
      value: { merchantOrderId: "CZQB334059", creationDate: "x", redirectUrl: "https://uat-app.directo.com.ar/c" },
    });
    expect(calls[0]!.url).toBe(`${QA}/api/v1/auth/token`);
    expect(bodyOf(calls[0]!)).toEqual({ username: "comercio", password: "secreto" });
    expect(calls[1]!.url).toBe(`${QA}/api/v1/services/create_order`);
    expect(authOf(calls[1]!)).toBe("Bearer tok-1");
    expect(bodyOf(calls[1]!)).toMatchObject({ price: 2356.75, fullName: "PEREZ,JUAN CARLOS", dni: "25555777", policyProduct: "62" });
    const h = calls[1]!.init.headers as Record<string, string>;
    expect(h.ApiKey).toBeUndefined();
    expect(h.MerchantHash).toBeUndefined();

    // Segunda llamada: reutiliza el token (sin otro login).
    await c.getOrderStatus("CZQB334059");
    expect(calls.filter((x) => x.url.endsWith("/auth/token"))).toHaveLength(1);
    expect(calls[2]!.url).toBe(`${QA}/api/v1/services/get_order_status/CZQB334059`);
  });

  it("403 = token vencido: re-login y un solo reintento", async () => {
    let logins = 0;
    const { f, calls } = fakeFetch((url) => {
      if (url.endsWith("/auth/token")) return res(200, { token: `tok-${++logins}` });
      const auth = (calls[calls.length - 1]!.init.headers as Record<string, string>).Authorization;
      return auth === "Bearer tok-1" ? res(403, "") : res(200, { status: "Pending", merchantOrderId: "A1" });
    });
    const c = directoClient({ creds: CREDS, env: "prod", fetchImpl: f });
    const r = await c.getOrderStatus("A1");
    expect(r.ok).toBe(true);
    expect(logins).toBe(2);
    expect(calls.map((x) => x.url.replace(DIRECTO_BASE.prod, ""))).toEqual([
      "/api/v1/auth/token",
      "/api/v1/services/get_order_status/A1",
      "/api/v1/auth/token",
      "/api/v1/services/get_order_status/A1",
    ]);
  });

  it("403 persistente: no reintenta en loop", async () => {
    const { f, calls } = fakeFetch((url) => (url.endsWith("/auth/token") ? res(200, { token: "t" }) : res(403, "")));
    const r = await directoClient({ creds: CREDS, env: "qa", fetchImpl: f }).getOrderStatus("A1");
    expect(r).toEqual({ ok: false, httpStatus: 403, detail: "http_403" });
    expect(calls).toHaveLength(4);
  });

  it("login rechazado devuelve el HTTP para no guardar credenciales", async () => {
    const { f } = fakeFetch(() => res(401, { status: "Error", message: "Unauthorized" }));
    const t = await directoClient({ creds: CREDS, env: "qa", fetchImpl: f }).token(true);
    expect(t).toEqual({ ok: false, httpStatus: 401, detail: "Unauthorized" });
  });

  it("timeout técnico por AbortController", async () => {
    let signal: AbortSignal | undefined;
    const f = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    // timeoutMs viene de parseCreds (5..120 s); acá se acorta para el test.
    const r = await directoClient({ creds: { ...CREDS, timeoutMs: 30 }, env: "qa", fetchImpl: f }).token(true);
    expect(r).toEqual({ ok: false, httpStatus: 0, detail: "timeout" });
    expect(signal?.aborted).toBe(true);
  });

  it("errores de rating sin exponer el cuerpo crudo", async () => {
    const { f } = fakeFetch((url) =>
      url.endsWith("/auth/token") ? res(200, { token: "t" }) : res(404, { status: "Error", message: "Rejected", dni: "25555777" }),
    );
    const r = await directoClient({ creds: CREDS, env: "qa", fetchImpl: f }).rating({
      fullName: "PEREZ,JUAN",
      dni: "25555777",
      sex: "F",
    });
    expect(r).toEqual({ ok: false, httpStatus: 404, detail: "Rejected" });
  });

  it("rating + deadlines con los cuerpos del documento", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.endsWith("/auth/token")) return res(200, { token: "t" });
      if (url.endsWith("/rating")) return res(200, { pendingRequestId: 11222333, offer: [{ maximumAmount: 550000, minimumAmount: 1000, maximumRate: 12 }] });
      return res(200, { pendingRequestId: 11222333, deadlines: [{ quantityRate: 3, amountRate: 16666.68 }] });
    });
    const c = directoClient({ creds: CREDS, env: "qa", fetchImpl: f });
    const o = await c.rating({ fullName: "PEREZ,JUAN", dni: "25555777", sex: "F" });
    expect(o.ok && o.value.pendingRequestId).toBe("11222333");
    expect(bodyOf(calls[1]!)).toEqual({ name: "PEREZ,JUAN", dni: "25555777", sexTypeId: "3", policyProduct: "62" });
    const d = await c.deadlines(50000, "11222333");
    expect(d.ok && d.value[0]?.installments).toBe(3);
    expect(bodyOf(calls[2]!)).toEqual({ amount: 50000, pendingRequestId: "11222333" });
  });

  it("webhook: re-consulta get_by_notification y valida la orden", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.endsWith("/auth/token")
        ? res(200, { token: "t" })
        : res(200, { status: "Success", merchantOrderId: "GSPN891045", installments: "3", creditNumber: "8698" }),
    );
    const c = directoClient({ creds: CREDS, env: "prod", fetchImpl: f });
    const id = extractNotificationId({ notification_id: 1255 })!;
    const r = await c.getByNotification(id);
    expect(calls[1]!.url).toBe(`${DIRECTO_BASE.prod}/api/v1/services/get_by_notification/1255`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(decideIntentUpdate(r.value, { merchantOrderId: "GSPN891045", amount: 100 }).status).toBe("approved");
    expect(decideIntentUpdate(r.value, { merchantOrderId: "AJENA", amount: 100 }).reason).toBe("order_mismatch");
    expect((await c.getByNotification("../../x")).ok).toBe(false);
  });

  it("buscar persona con sexTypeId y DNI en la query", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.endsWith("/auth/token") ? res(200, { token: "t" }) : res(200, { names: [{ firstName: "MARIA", lastName: "VILLALBA" }] }),
    );
    const r = await directoClient({ creds: CREDS, env: "qa", fetchImpl: f }).findPerson("37.893.234", "F");
    expect(calls[1]!.url).toBe(`${QA}/api/v1/services/get_by_dni_type?sexTypeId=3&dni=37893234`);
    expect(r).toEqual({ ok: true, value: [{ firstName: "MARIA", lastName: "VILLALBA" }] });
  });
});

describe("directo · vencimiento del token", () => {
  it("usa exp del JWT (menos 1 minuto) o 30 minutos", () => {
    const now = 1_700_000_000_000;
    const payload = Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString("base64url");
    expect(tokenUntil(`h.${payload}.s`, now)).toBe(now + 3600_000 - 60_000);
    expect(tokenUntil("opaco", now)).toBe(now + 30 * 60_000);
  });
});
