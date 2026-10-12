import { describe, expect, it, vi } from "vitest";
import {
  GOCUOTAS_BASE,
  GOCUOTAS_MIN_CENTS,
  buildCheckoutUrl,
  decideIntentUpdate,
  extractWebhookHint,
  formatArDateTime,
  gocuotasEnv,
  mapGoCuotasStatus,
  normalizeOrders,
  parseCheckoutResponse,
  resolveOrder,
  toCents,
} from "@/supabase/functions/_shared/gocuotas";

const INTENT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const OTHER = "11111111-2222-4333-8444-555555555555";

const res = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("gocuotas · ambiente", () => {
  it("producción y sandbox según el switch del medio", () => {
    expect(GOCUOTAS_BASE.prod).toBe("https://www.gocuotas.com");
    expect(GOCUOTAS_BASE.sandbox).toBe("https://sandbox.gocuotas.com");
    expect(gocuotasEnv(true)).toBe("sandbox");
    expect(gocuotasEnv(false)).toBe("prod");
    expect(gocuotasEnv(null)).toBe("prod");
  });
});

describe("gocuotas · montos", () => {
  it("toCents redondea a centavos", () => {
    expect(toCents(1500)).toBe(150000);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
  it("el mínimo de GO Cuotas es $1.500", () => {
    expect(GOCUOTAS_MIN_CENTS).toBe(150000);
  });
});

describe("gocuotas · checkout redirect", () => {
  const base = {
    amount: 2500.5,
    orderReferenceId: INTENT,
    webhookUrl: "https://x.supabase.co/functions/v1/gocuotas_webhook?intent=" + INTENT,
    successUrl: "https://x.supabase.co/functions/v1/gocuotas_webhook?view=success",
    failureUrl: "https://x.supabase.co/functions/v1/gocuotas_webhook?view=failed",
  };

  it("arma POST /api_redirect/v1/checkouts con los parámetros documentados", () => {
    const u = new URL(buildCheckoutUrl("sandbox", base));
    expect(u.origin + u.pathname).toBe("https://sandbox.gocuotas.com/api_redirect/v1/checkouts");
    expect(u.searchParams.get("amount_in_cents")).toBe("250050");
    expect(u.searchParams.get("order_reference_id")).toBe(INTENT);
    expect(u.searchParams.get("webhook_url")).toBe(base.webhookUrl);
    expect(u.searchParams.get("url_success")).toBe(base.successUrl);
    expect(u.searchParams.get("url_failure")).toBe(base.failureUrl);
    expect(u.searchParams.has("email")).toBe(false);
    expect(u.searchParams.has("phone_number")).toBe(false);
  });

  it("email y teléfono son opcionales (sólo dígitos en el teléfono)", () => {
    const u = new URL(
      buildCheckoutUrl("prod", { ...base, email: " a@b.com ", phone: "(11) 4567-6567" }),
    );
    expect(u.origin).toBe("https://www.gocuotas.com");
    expect(u.searchParams.get("email")).toBe("a@b.com");
    expect(u.searchParams.get("phone_number")).toBe("1145676567");
  });

  it("rechaza montos inválidos o por debajo del mínimo", () => {
    expect(() => buildCheckoutUrl("prod", { ...base, amount: 0 })).toThrow("invalid_amount");
    expect(() => buildCheckoutUrl("prod", { ...base, amount: Number.NaN })).toThrow(
      "invalid_amount",
    );
    expect(() => buildCheckoutUrl("prod", { ...base, amount: 1499.99 })).toThrow(
      "gocuotas_min_amount",
    );
    expect(() => buildCheckoutUrl("prod", { ...base, amount: 1500 })).not.toThrow();
  });

  it("parseCheckoutResponse sólo acepta url_init https", () => {
    expect(parseCheckoutResponse({ url_init: "https://www.gocuotas.com/checkout/abc" })).toEqual({
      urlInit: "https://www.gocuotas.com/checkout/abc",
    });
    expect(parseCheckoutResponse({ url_init: "javascript:alert(1)" })).toBeNull();
    expect(parseCheckoutResponse({})).toBeNull();
    expect(parseCheckoutResponse(null)).toBeNull();
  });
});

describe("gocuotas · estados", () => {
  it("mapea los estados documentados", () => {
    expect(mapGoCuotasStatus("approved")).toBe("approved");
    expect(mapGoCuotasStatus("APPROVED")).toBe("approved");
    expect(mapGoCuotasStatus("denied")).toBe("rejected");
    expect(mapGoCuotasStatus("undefined")).toBe("pending");
    expect(mapGoCuotasStatus("processing")).toBe("pending");
    expect(mapGoCuotasStatus("")).toBe("pending");
    expect(mapGoCuotasStatus("cancelled")).toBe("cancelled");
  });
});

describe("gocuotas · webhook", () => {
  it("extrae la pista (order_id + referencia) sin confiar en el resto", () => {
    expect(
      extractWebhookHint({
        order_reference_id: INTENT,
        status: "approved",
        order_id: 3674033,
        amount_in_cents: 250050,
      }),
    ).toEqual({ orderId: "3674033", reference: INTENT });
  });
  it("descarta order_id que no es numérico", () => {
    expect(extractWebhookHint({ order_id: "../1" })).toEqual({ orderId: null, reference: null });
    expect(extractWebhookHint("x")).toEqual({ orderId: null, reference: null });
    expect(extractWebhookHint({ order_id: null, order_reference_id: null, status: "denied" })).toEqual(
      { orderId: null, reference: null },
    );
  });
});

describe("gocuotas · decideIntentUpdate (orden re-consultada)", () => {
  const order = (o: Record<string, unknown>) => ({
    id: 3674033,
    amount_in_cents: 250050,
    status: "approved",
    order_reference_id: INTENT,
    ...o,
  });

  it("aprueba con estado approved, referencia propia y monto exacto", () => {
    expect(decideIntentUpdate(order({}), 2500.5, INTENT)).toEqual({
      status: "approved",
      state: "approved",
      orderId: "3674033",
    });
  });
  it("monto distinto → rechazado por amount_mismatch", () => {
    const d = decideIntentUpdate(order({ amount_in_cents: 250000 }), 2500.5, INTENT);
    expect(d.status).toBe("rejected");
    expect(d.reason).toBe("amount_mismatch");
  });
  it("sin monto legible no acredita", () => {
    const d = decideIntentUpdate(order({ amount_in_cents: "250050.5" }), 2500.5, INTENT);
    expect(d.status).toBe("pending");
    expect(d.reason).toBe("amount_unverified");
  });
  it("una orden de otra referencia nunca acredita", () => {
    const d = decideIntentUpdate(order({ order_reference_id: OTHER }), 2500.5, INTENT);
    expect(d.status).toBe("pending");
    expect(d.reason).toBe("reference_mismatch");
    const n = decideIntentUpdate(order({ order_reference_id: null }), 2500.5, INTENT);
    expect(n.status).toBe("pending");
    expect(n.reason).toBe("reference_mismatch");
  });
  it("denied → rejected; undefined → pending", () => {
    expect(decideIntentUpdate(order({ status: "denied" }), 2500.5, INTENT).status).toBe("rejected");
    expect(decideIntentUpdate(order({ status: "undefined" }), 2500.5, INTENT).status).toBe(
      "pending",
    );
  });
  it("sin orden → pending", () => {
    expect(decideIntentUpdate(null, 2500.5, INTENT).status).toBe("pending");
  });
});

describe("gocuotas · listado de órdenes", () => {
  it("normaliza array, objeto suelto y envoltorios", () => {
    expect(normalizeOrders([{ id: 1 }, { id: 2 }])).toHaveLength(2);
    expect(normalizeOrders({ id: 1 })).toHaveLength(1);
    expect(normalizeOrders({ orders: [{ id: 1 }] })).toHaveLength(1);
    expect(normalizeOrders({ data: [{ id: 1 }] })).toHaveLength(1);
    expect(normalizeOrders(null)).toEqual([]);
    expect(normalizeOrders("x")).toEqual([]);
  });
  it("formatArDateTime usa hora de Argentina (UTC-3) con el formato de la API", () => {
    expect(formatArDateTime(new Date("2026-10-11T03:05:00Z"))).toBe("2026-10-11 00:05");
    expect(formatArDateTime(new Date("2026-10-11T02:59:00Z"))).toBe("2026-10-10 23:59");
  });
});

describe("gocuotas · resolveOrder", () => {
  const createdAt = "2026-10-11T15:00:00Z";

  it("con pista usa GET /orders/{id} con Bearer API key", async () => {
    const f = vi.fn(async () =>
      res(200, { id: 77, status: "approved", amount_in_cents: 150000, order_reference_id: INTENT }),
    );
    const r = await resolveOrder({
      env: "prod",
      apiKey: "KEY",
      intentId: INTENT,
      createdAt,
      hintedOrderId: "77",
      fetchImpl: f,
    });
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.gocuotas.com/api_redirect/v1/orders/77");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("si la pista es de otra referencia, busca por order_reference_id en el listado", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: 77, status: "approved", order_reference_id: OTHER }))
      .mockResolvedValueOnce(
        res(200, [
          { id: 80, status: "approved", amount_in_cents: 150000, order_reference_id: OTHER },
          { id: 81, status: "approved", amount_in_cents: 150000, order_reference_id: INTENT },
        ]),
      );
    const r = await resolveOrder({
      env: "sandbox",
      apiKey: "KEY",
      intentId: INTENT,
      createdAt,
      hintedOrderId: "77",
      fetchImpl: f,
    });
    expect(r).toMatchObject({ ok: true, order: { id: 81 } });
    const listUrl = new URL(f.mock.calls[1]?.[0] as string);
    expect(listUrl.origin + listUrl.pathname).toBe(
      "https://sandbox.gocuotas.com/api_redirect/v1/orders",
    );
    expect(listUrl.searchParams.get("order_reference_id")).toBe(INTENT);
    expect(listUrl.searchParams.get("delivered_start")).toBe("2026-10-10 12:00");
    expect(listUrl.searchParams.get("delivered_end")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("sin orden de esa referencia → ok sin orden (pendiente)", async () => {
    const f = vi.fn(async () => res(200, []));
    const r = await resolveOrder({
      env: "prod",
      apiKey: "KEY",
      intentId: INTENT,
      createdAt,
      hintedOrderId: null,
      fetchImpl: f,
    });
    expect(r).toEqual({ ok: true, order: null });
  });

  it("prioriza la orden aprobada si hay varias de la misma referencia", async () => {
    const f = vi.fn(async () =>
      res(200, [
        { id: 1, status: "denied", order_reference_id: INTENT },
        { id: 2, status: "approved", amount_in_cents: 1, order_reference_id: INTENT },
      ]),
    );
    const r = await resolveOrder({
      env: "prod",
      apiKey: "KEY",
      intentId: INTENT,
      createdAt,
      hintedOrderId: null,
      fetchImpl: f,
    });
    expect(r).toMatchObject({ ok: true, order: { id: 2 } });
  });

  it("errores HTTP y de red no acreditan", async () => {
    const f401 = vi.fn(async () => res(401, "unauthorized"));
    expect(
      await resolveOrder({
        env: "prod",
        apiKey: "BAD",
        intentId: INTENT,
        createdAt,
        hintedOrderId: null,
        fetchImpl: f401,
      }),
    ).toMatchObject({ ok: false, httpStatus: 401 });
    const boom = vi.fn(async () => {
      throw new Error("net");
    });
    expect(
      await resolveOrder({
        env: "prod",
        apiKey: "K",
        intentId: INTENT,
        createdAt,
        hintedOrderId: null,
        fetchImpl: boom,
      }),
    ).toMatchObject({ ok: false, httpStatus: 502 });
  });
});
