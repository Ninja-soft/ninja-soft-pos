import { describe, expect, it, vi } from "vitest";
import {
  GETNET_AUTH_URL,
  GETNET_ORDERS_URL,
  buildOrderPayload,
  buildTokenRequest,
  decideIntentUpdate,
  extractOrderAmountCents,
  extractWebhookOrderId,
  fetchGetnetOrder,
  fetchGetnetToken,
  mapGetnetStatus,
  parseCreateResponse,
  readOrderStatus,
  toCents,
} from "@/supabase/functions/_shared/getnet";

describe("getnet · endpoints", () => {
  it("usa el OAuth de Geopagos y la Checkout API v2 de Getnet AR", () => {
    expect(GETNET_AUTH_URL).toBe("https://auth.geopagos.com/oauth/token");
    expect(GETNET_ORDERS_URL).toBe("https://api.globalgetnet.com.ar/api/v2/orders");
  });
});

describe("getnet · montos", () => {
  it("toCents redondea a centavos sin errores de coma flotante", () => {
    expect(toCents(1234.5)).toBe(123450);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(19.99)).toBe(1999);
  });
});

describe("getnet · token", () => {
  it("arma el body client_credentials como el plugin oficial", () => {
    expect(buildTokenRequest(" id ", " sec ")).toEqual({
      client_id: "id",
      client_secret: "sec",
      grant_type: "client_credentials",
      scope: "*",
    });
  });

  it("fetchGetnetToken devuelve el access_token", async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }),
    );
    await expect(fetchGetnetToken("a", "b", f)).resolves.toBe("tok");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(GETNET_AUTH_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).grant_type).toBe("client_credentials");
  });

  it("fetchGetnetToken devuelve null si las credenciales no sirven", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(fetchGetnetToken("a", "b", f)).resolves.toBeNull();
    const g = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(fetchGetnetToken("a", "b", g)).resolves.toBeNull();
  });
});

describe("getnet · payload de la orden", () => {
  const base = {
    amount: 1500.5,
    title: "Venta NinjaPos",
    webhookUrl: "https://x.supabase.co/functions/v1/getnet_webhook?intent=abc",
    successUrl: "https://x.supabase.co/functions/v1/getnet_webhook?view=success",
    failedUrl: "https://x.supabase.co/functions/v1/getnet_webhook?view=failed",
  };

  it("un único ítem por el total, en centavos como string y moneda 032", () => {
    const p = buildOrderPayload(base);
    expect(p).toEqual({
      data: {
        attributes: {
          items: [
            {
              id: 1,
              name: "Venta NinjaPos",
              unitPrice: { currency: "032", amount: "150050" },
              quantity: 1,
            },
          ],
          redirect_urls: { success: base.successUrl, failed: base.failedUrl },
          webhookUrl: base.webhookUrl,
          expireLimitMinutes: 30,
        },
      },
    });
  });

  it("recorta el nombre del ítem y usa un default si viene vacío", () => {
    expect(
      buildOrderPayload({ ...base, title: "x".repeat(300) }).data.attributes.items[0]!.name,
    ).toHaveLength(120);
    expect(buildOrderPayload({ ...base, title: "  " }).data.attributes.items[0]!.name).toBe(
      "Venta NinjaPos",
    );
  });

  it("rechaza montos inválidos", () => {
    expect(() => buildOrderPayload({ ...base, amount: 0 })).toThrow("invalid_amount");
    expect(() => buildOrderPayload({ ...base, amount: Number.NaN })).toThrow("invalid_amount");
  });
});

describe("getnet · respuesta de creación", () => {
  it("toma el checkout de data.links[0].checkout y el uuid de data.id", () => {
    expect(
      parseCreateResponse({
        data: {
          id: "6f1c-uuid",
          attributes: { payments: [{ reference_number: "R-1" }] },
          links: [{ checkout: "https://checkout.globalgetnet.com.ar/x" }],
        },
      }),
    ).toEqual({
      orderId: "6f1c-uuid",
      checkoutUrl: "https://checkout.globalgetnet.com.ar/x",
      referenceNumber: "R-1",
    });
  });

  it("acepta el uuid en attributes.uuid", () => {
    const r = parseCreateResponse({
      data: { attributes: { uuid: "u-2" }, links: [{ checkout: "https://c/x" }] },
    });
    expect(r?.orderId).toBe("u-2");
  });

  it("sin checkout https o sin id devuelve null", () => {
    expect(parseCreateResponse({ data: { id: "a", links: [] } })).toBeNull();
    expect(
      parseCreateResponse({ data: { id: "a", links: [{ checkout: "javascript:alert(1)" }] } }),
    ).toBeNull();
    expect(parseCreateResponse({ data: { links: [{ checkout: "https://c/x" }] } })).toBeNull();
    expect(parseCreateResponse(null)).toBeNull();
  });
});

describe("getnet · webhook", () => {
  it("lee el uuid de la orden en data.order.uuid (sólo como pista)", () => {
    expect(extractWebhookOrderId({ data: { order: { uuid: "u-1" } } })).toBe("u-1");
    expect(extractWebhookOrderId({ data: {} })).toBeNull();
    expect(extractWebhookOrderId("nope")).toBeNull();
    expect(extractWebhookOrderId({ data: { order: { uuid: "../x" } } })).toBeNull();
  });
});

describe("getnet · estado", () => {
  it("APPROVED / PROCESSED / SUCCESS son aprobados (plugin oficial)", () => {
    for (const s of ["APPROVED", "PROCESSED", "SUCCESS", "approved"]) {
      expect(mapGetnetStatus(s)).toBe("approved");
    }
  });

  it("rechazos y vencimientos", () => {
    for (const s of ["REJECTED", "DECLINED", "DENIED", "FAILED"]) {
      expect(mapGetnetStatus(s)).toBe("rejected");
    }
    for (const s of ["EXPIRED", "CANCELLED", "CANCELED"]) {
      expect(mapGetnetStatus(s)).toBe("cancelled");
    }
  });

  it("todo lo desconocido queda pendiente (conservador)", () => {
    for (const s of ["", "PENDING", "CREATED", "IN_PROCESS", "whatever"]) {
      expect(mapGetnetStatus(s)).toBe("pending");
    }
  });

  it("readOrderStatus lee status en la raíz o en data.attributes", () => {
    expect(readOrderStatus({ status: "approved" })).toBe("APPROVED");
    expect(readOrderStatus({ data: { attributes: { status: "SUCCESS" } } })).toBe("SUCCESS");
    expect(readOrderStatus({ data: { status: "PROCESSED" } })).toBe("PROCESSED");
    expect(readOrderStatus({})).toBe("");
  });
});

describe("getnet · monto de la orden", () => {
  it("prioriza la suma de ítems (mismo formato que mandamos: centavos)", () => {
    expect(
      extractOrderAmountCents({
        data: {
          attributes: {
            items: [
              { unitPrice: { currency: "032", amount: "100000" }, quantity: 1 },
              { unitPrice: { currency: "032", amount: 2500 }, quantity: 2 },
            ],
          },
        },
      }),
    ).toBe(105000);
  });

  it("acepta ítems en la raíz", () => {
    expect(
      extractOrderAmountCents({ items: [{ unitPrice: { amount: "150050" }, quantity: 1 }] }),
    ).toBe(150050);
  });

  it("cae a amount/total si no hay ítems (entero = centavos, decimal = pesos)", () => {
    expect(extractOrderAmountCents({ amount: { currency: "032", amount: "150050" } })).toBe(150050);
    expect(extractOrderAmountCents({ data: { attributes: { total: 150050 } } })).toBe(150050);
    expect(extractOrderAmountCents({ totalAmount: "1500.50" })).toBe(150050);
  });

  it("sin monto legible devuelve null", () => {
    expect(extractOrderAmountCents({ status: "APPROVED" })).toBeNull();
    expect(extractOrderAmountCents({ items: [{ unitPrice: { amount: "abc" } }] })).toBeNull();
  });
});

describe("getnet · decisión (nunca confiar en el webhook)", () => {
  const order = (status: string, cents: string) => ({
    status,
    data: { attributes: { items: [{ unitPrice: { amount: cents }, quantity: 1 }] } },
  });

  it("aprobado + monto exacto → approved", () => {
    expect(decideIntentUpdate(order("APPROVED", "150050"), 1500.5)).toEqual({
      status: "approved",
      state: "APPROVED",
    });
  });

  it("aprobado con monto distinto → rejected (amount_mismatch)", () => {
    expect(decideIntentUpdate(order("SUCCESS", "150049"), 1500.5)).toEqual({
      status: "rejected",
      state: "SUCCESS",
      reason: "amount_mismatch",
    });
  });

  it("aprobado sin monto verificable → sigue pending", () => {
    expect(decideIntentUpdate({ status: "APPROVED" }, 1500.5)).toEqual({
      status: "pending",
      state: "APPROVED",
      reason: "amount_unverified",
    });
  });

  it("rechazo / vencimiento / intermedio", () => {
    expect(decideIntentUpdate(order("REJECTED", "1"), 1).status).toBe("rejected");
    expect(decideIntentUpdate(order("EXPIRED", "1"), 1).status).toBe("cancelled");
    expect(decideIntentUpdate(order("PENDING", "100"), 1).status).toBe("pending");
  });
});

describe("getnet · consulta de la orden", () => {
  it("GET /api/v2/orders/{id} con Bearer; 404 → null", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "APPROVED" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("nf", { status: 404 }));
    await expect(fetchGetnetOrder("tok", "u-1", f)).resolves.toEqual({
      ok: true,
      order: { status: "APPROVED" },
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${GETNET_ORDERS_URL}/u-1`);
    expect(init.headers.Authorization).toBe("Bearer tok");
    await expect(fetchGetnetOrder("tok", "u-1", f)).resolves.toEqual({
      ok: false,
      httpStatus: 404,
      detail: "nf",
    });
  });

  it("rechaza ids con caracteres raros sin llamar a la API", async () => {
    const f = vi.fn();
    await expect(fetchGetnetOrder("tok", "../admin", f)).resolves.toEqual({
      ok: false,
      httpStatus: 400,
      detail: "invalid_order_id",
    });
    expect(f).not.toHaveBeenCalled();
  });
});
