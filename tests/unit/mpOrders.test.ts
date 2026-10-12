import { describe, expect, it } from "vitest";
import {
  amountsMatch,
  buildPointOrderBody,
  buildQrOrderBody,
  cardTypeOf,
  isOrdersIntent,
  legacyPointStatus,
  mpExternalIds,
  mapTerminals,
  parseOrderNotification,
  pickMpCredential,
  resolveOrder,
  toAmountString,
  parseStoreSetup,
  MP_AR_STATES,
  buildStoreBody,
  buildPosBody,
} from "@/supabase/functions/_shared/mpOrders";

const INTENT = "3f2a3c1e-6b2d-4c55-9a51-0e1f2a3b4c5d";

describe("toAmountString", () => {
  it("siempre dos decimales, punto decimal", () => {
    expect(toAmountString(1234.5)).toBe("1234.50");
    expect(toAmountString(10)).toBe("10.00");
    expect(toAmountString(0.1 + 0.2)).toBe("0.30");
  });
});

describe("amountsMatch", () => {
  it("compara en centavos exactos", () => {
    expect(amountsMatch("1234.50", 1234.5)).toBe(true);
    expect(amountsMatch(1234.5, "1234.50")).toBe(true);
    expect(amountsMatch("1234.49", 1234.5)).toBe(false);
    expect(amountsMatch("1235.50", 1234.5)).toBe(false);
  });
  it("rechaza montos no numéricos", () => {
    expect(amountsMatch(undefined, 10)).toBe(false);
    expect(amountsMatch("abc", 10)).toBe(false);
    expect(amountsMatch(10, Number.NaN)).toBe(false);
  });
});

describe("buildQrOrderBody", () => {
  it("arma una order QR dinámica atada a la caja", () => {
    const body = buildQrOrderBody({
      intentId: INTENT,
      amount: 1500,
      externalPosId: "NSPOSABC123C1",
      title: "Venta NinjaPos",
    });
    expect(body).toEqual({
      type: "qr",
      total_amount: "1500.00",
      external_reference: INTENT,
      description: "Venta NinjaPos",
      expiration_time: "PT15M",
      config: { qr: { external_pos_id: "NSPOSABC123C1", mode: "dynamic" } },
      transactions: { payments: [{ amount: "1500.00" }] },
    });
  });
  it("recorta la descripción a 150 caracteres", () => {
    const body = buildQrOrderBody({
      intentId: INTENT,
      amount: 1,
      externalPosId: "X",
      title: "a".repeat(400),
    });
    expect(body.description.length).toBe(150);
  });
});

describe("buildPointOrderBody", () => {
  it("cobro simple: terminal + monto, sin payment_method", () => {
    const body = buildPointOrderBody({
      intentId: INTENT,
      amount: 999.99,
      terminalId: "NEWLAND_N950__N950NCB801293324",
    });
    expect(body).toEqual({
      type: "point",
      external_reference: INTENT,
      description: "Venta NinjaPos",
      expiration_time: "PT15M",
      transactions: { payments: [{ amount: "999.99" }] },
      config: { point: { terminal_id: "NEWLAND_N950__N950NCB801293324" } },
    });
  });
  it("cuotas > 1 fuerzan crédito + installments_cost", () => {
    const body = buildPointOrderBody({
      intentId: INTENT,
      amount: 100,
      terminalId: "T1",
      installments: 6,
    });
    expect(body.config.payment_method).toEqual({
      default_type: "credit_card",
      default_installments: 6,
      installments_cost: "buyer",
    });
  });
  it("débito preseleccionado sin cuotas", () => {
    const body = buildPointOrderBody({
      intentId: INTENT,
      amount: 100,
      terminalId: "T1",
      defaultType: "debit_card",
      installments: 3,
    });
    // Débito ignora las cuotas (no existen cuotas en débito).
    expect(body.config.payment_method).toEqual({ default_type: "debit_card" });
  });
});

const processedOrder = (over: Record<string, unknown> = {}) => ({
  id: "ORD01ABC",
  external_reference: INTENT,
  status: "processed",
  status_detail: "accredited",
  total_amount: "1500.00",
  transactions: {
    payments: [
      {
        id: "PAY01XYZ",
        amount: "1500.00",
        status: "processed",
        status_detail: "accredited",
        payment_method: { type: "debit_card", installments: 1 },
      },
    ],
  },
  ...over,
});

describe("resolveOrder", () => {
  it("processed + monto exacto → approved", () => {
    const r = resolveOrder(processedOrder(), { intentId: INTENT, expectedAmount: 1500 });
    expect(r).toEqual({
      status: "approved",
      paymentId: "PAY01XYZ",
      cardType: "debit",
      reason: null,
    });
  });
  it("acepta status_detail 'processed' (doc QR)", () => {
    const r = resolveOrder(processedOrder({ status_detail: "processed" }), {
      intentId: INTENT,
      expectedAmount: 1500,
    });
    expect(r.status).toBe("approved");
  });
  it("monto distinto → rejected (nunca acredita)", () => {
    const r = resolveOrder(processedOrder(), { intentId: INTENT, expectedAmount: 1600 });
    expect(r.status).toBe("rejected");
    expect(r.reason).toBe("amount_mismatch");
  });
  it("external_reference ajeno → no toca nada (pending + reason)", () => {
    const r = resolveOrder(processedOrder({ external_reference: "otro" }), {
      intentId: INTENT,
      expectedAmount: 1500,
    });
    expect(r.status).toBe("pending");
    expect(r.reason).toBe("reference_mismatch");
  });
  it("pago no procesado aunque la order diga processed → pending", () => {
    const o = processedOrder();
    (o.transactions.payments[0] as { status: string }).status = "created";
    const r = resolveOrder(o, { intentId: INTENT, expectedAmount: 1500 });
    expect(r.status).toBe("pending");
  });
  it("reembolso parcial no se acredita", () => {
    const r = resolveOrder(processedOrder({ status_detail: "partially_refunded" }), {
      intentId: INTENT,
      expectedAmount: 1500,
    });
    expect(r.status).toBe("rejected");
  });
  it.each([
    ["created", "pending"],
    ["at_terminal", "pending"],
    ["action_required", "pending"],
    ["processing", "pending"],
    ["canceled", "cancelled"],
    ["expired", "expired"],
    ["failed", "rejected"],
    ["refunded", "rejected"],
    ["algo_nuevo", "pending"],
  ])("order %s → %s", (st, expected) => {
    const r = resolveOrder(processedOrder({ status: st, status_detail: st }), {
      intentId: INTENT,
      expectedAmount: 1500,
    });
    expect(r.status).toBe(expected);
  });
  it("crédito y prepaga se mapean al tipo de tarjeta del POS", () => {
    expect(cardTypeOf("credit_card")).toBe("credit");
    expect(cardTypeOf("debit_card")).toBe("debit");
    expect(cardTypeOf("prepaid_card")).toBe("debit");
    expect(cardTypeOf(undefined)).toBe("credit");
  });
});

describe("legacyPointStatus (Payment Intents API)", () => {
  it.each([
    ["FINISHED", "finished"],
    ["OPEN", "pending"],
    ["ON_TERMINAL", "pending"],
    ["PROCESSING", "pending"],
    ["CANCELED", "cancelled"],
    ["ABANDONED", "cancelled"],
    ["ERROR", "cancelled"],
    ["EXPIRED", "cancelled"],
  ])("%s → %s", (st, expected) => {
    expect(legacyPointStatus(st)).toBe(expected);
  });
});

describe("isOrdersIntent", () => {
  it("intents nuevos tienen mp_order_id; los legacy no", () => {
    expect(isOrdersIntent({ mp_order_id: "ORD01" })).toBe(true);
    expect(isOrdersIntent({ mp_order_id: null })).toBe(false);
    expect(isOrdersIntent({})).toBe(false);
  });
});

describe("parseOrderNotification", () => {
  it("lee type y data.id del body", () => {
    const r = parseOrderNotification(
      new URL("https://x.test/fn"),
      { type: "order", action: "order.processed", data: { id: "ORD01" } },
    );
    expect(r).toEqual({ type: "order", orderId: "ORD01", action: "order.processed" });
  });
  it("cae al query string (type=order&data.id=...)", () => {
    const r = parseOrderNotification(
      new URL("https://x.test/fn?type=order&data.id=ORD02"),
      null,
    );
    expect(r).toEqual({ type: "order", orderId: "ORD02", action: null });
  });
  it("ids no válidos se descartan", () => {
    const r = parseOrderNotification(new URL("https://x.test/fn"), {
      type: "order",
      data: { id: "../../etc" },
    });
    expect(r.orderId).toBeNull();
  });
});

describe("pickMpCredential", () => {
  it("producción por defecto", () => {
    expect(pickMpCredential({ access_token: "APP_USR-prod" }, false)).toEqual({
      token: "APP_USR-prod",
      env: "prod",
    });
  });
  it("sandbox usa el token de prueba si existe", () => {
    expect(
      pickMpCredential({ access_token: "P", test_access_token: "T" }, true),
    ).toEqual({ token: "T", env: "test" });
  });
  it("sandbox sin token de prueba → cae a producción (filas legacy con sandbox=true)", () => {
    expect(pickMpCredential({ access_token: "P" }, true)).toEqual({ token: "P", env: "prod" });
  });
  it("env forzado (intent ya creado en un ambiente)", () => {
    expect(pickMpCredential({ access_token: "P", test_access_token: "T" }, false, "test")).toEqual({
      token: "T",
      env: "test",
    });
    expect(pickMpCredential({ access_token: "P" }, false, "test")).toBeNull();
  });
  it("sin credenciales → null", () => {
    expect(pickMpCredential({}, false)).toBeNull();
    expect(pickMpCredential(null, false)).toBeNull();
  });
});

describe("mpExternalIds", () => {
  it("alfanuméricos, estables por tenant y dentro de los límites de MP", () => {
    const ids = mpExternalIds("3f2a3c1e-6b2d-4c55-9a51-0e1f2a3b4c5d");
    expect(ids.storeExternalId).toMatch(/^[A-Za-z0-9]{1,60}$/);
    expect(ids.posExternalId).toMatch(/^[A-Za-z0-9]{1,40}$/);
    expect(ids).toEqual(mpExternalIds("3f2a3c1e-6b2d-4c55-9a51-0e1f2a3b4c5d"));
    expect(ids.posExternalId).not.toBe(mpExternalIds("00000000-0000-0000-0000-000000000000").posExternalId);
  });
});

describe("mapTerminals", () => {
  it("normaliza el listado de /terminals/v1/list", () => {
    expect(
      mapTerminals({
        data: {
          terminals: [
            { id: "NEWLAND_N950__N950NCB801293324", operating_mode: "PDV", pos_id: 1, store_id: "2" },
            { id: "PAX_A910__SMARTPOS1", operating_mode: "STANDALONE" },
            { operating_mode: "PDV" },
          ],
        },
      }),
    ).toEqual([
      { id: "NEWLAND_N950__N950NCB801293324", operating_mode: "PDV" },
      { id: "PAX_A910__SMARTPOS1", operating_mode: "STANDALONE" },
    ]);
    expect(mapTerminals(null)).toEqual([]);
  });
});

describe("parseStoreSetup (sucursal + caja QR)", () => {
  const ok = {
    name: "Kiosco Centro",
    street_name: "Av. Corrientes",
    street_number: "1234",
    city_name: "Palermo",
    state_name: "Capital Federal",
    coordinates: "-34.6037, -58.3816",
    reference: "Local 2",
  };
  it("valida y normaliza", () => {
    expect(parseStoreSetup(ok)).toEqual({
      ok: true,
      value: {
        name: "Kiosco Centro",
        location: {
          street_name: "Av. Corrientes",
          street_number: "1234",
          city_name: "Palermo",
          state_name: "Capital Federal",
          latitude: -34.6037,
          longitude: -58.3816,
          reference: "Local 2",
        },
      },
    });
  });
  it("acepta coordenadas copiadas de Google Maps sin espacio", () => {
    const r = parseStoreSetup({ ...ok, coordinates: "-31.4201,-64.1888" });
    expect(r.ok && r.value.location.latitude).toBe(-31.4201);
  });
  it.each([
    ["name", ""],
    ["street_name", " "],
    ["street_number", ""],
    ["city_name", ""],
    ["state_name", "Narnia"],
    ["coordinates", "abc"],
    ["coordinates", "-134.6, -58.3"],
  ])("rechaza %s inválido", (field, value) => {
    const r = parseStoreSetup({ ...ok, [field]: value });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.field).toBe(field);
  });
  it("las provincias son las que espera MP", () => {
    expect(MP_AR_STATES).toContain("Capital Federal");
    expect(MP_AR_STATES).toContain("Buenos Aires");
    expect(MP_AR_STATES).toHaveLength(24);
  });
});

describe("buildStoreBody / buildPosBody", () => {
  it("sucursal y caja con external_id del tenant", () => {
    const ids = mpExternalIds(INTENT);
    const store = buildStoreBody(
      {
        name: "Kiosco",
        location: {
          street_name: "Calle",
          street_number: "1",
          city_name: "Rosario",
          state_name: "Santa Fe",
          latitude: -32.9,
          longitude: -60.6,
          reference: "",
        },
      },
      ids.storeExternalId,
    );
    expect(store.external_id).toBe(ids.storeExternalId);
    expect(store.name).toBe("Kiosco");
    expect(store.location.reference).toBe("");
    const pos = buildPosBody("123", ids);
    expect(pos).toEqual({
      name: "Caja NinjaPos",
      store_id: "123",
      external_store_id: ids.storeExternalId,
      external_id: ids.posExternalId,
    });
  });
});
