import { describe, expect, it } from "vitest";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { comparePlans } from "@/lib/saas/planComparison";
import {
  allowedApiUrl,
  buildNubceoSale,
  classifySnapshot,
  createNubceoApi,
  defaultMapping,
  exhausted,
  fechaAr,
  inWindow,
  ledgerQuery,
  mappingWarnings,
  netOf,
  nextAttemptAt,
  nextRunAt,
  normalizeMapping,
  nubceoCardBrand,
  parseLedgerPage,
  payloadHash,
  pickCompany,
  providerBrand,
  readDeleteResponse,
  readInsertResponse,
  returnVentaIdFor,
  sanitizePrefix,
  ventaIdFor,
  type SaleEnvelope,
  type SaleSnapshot,
} from "@/supabase/functions/_shared/nubceo";

// -----------------------------------------------------------------------------
// Armado: mismos casos que railway/nubceo-sync/lib/armar.test.js de ANDESMAR
// (la integración que ya manda ventas reales a NubCeo). Si cambia el armado,
// estos números tienen que seguir dando igual.
// -----------------------------------------------------------------------------

const PAY = {
  include: true,
  platform: "",
  merchant: "",
  paymentType: "",
  brand: "",
  cardNumber: "",
  voucher: "",
  terminal: "",
  authorization: "",
  installments: null,
  externalRef: "",
  buyerId: "",
  batch: "",
  date: "",
};

const ENV: SaleEnvelope = {
  ventaId: "napse-abc",
  type: "invoice",
  branchRef: "12",
  date: "2026-09-21T20:50:30+00:00",
  currency: "ARS",
  total: 121000,
  net: 100000,
  categories: ["bridge", "70003", "TF B"],
  internalReference: "TF B-0711-10",
  buyerId: "25133224",
  payments: [
    {
      ...PAY,
      n: 1,
      amount: 60500,
      platform: "prisma_ar",
      merchant: "111",
      paymentType: "credit",
      brand: "VISA",
      date: "2026-09-21T17:50:59",
    },
    {
      ...PAY,
      n: 2,
      amount: 60500,
      paymentType: "cash",
      date: "2026-09-21T17:51:10",
    },
    { ...PAY, n: 3, amount: 5000, include: false },
  ],
};

describe("armado de la venta (casos de ANDESMAR)", () => {
  it("fechas en hora de Argentina con -03:00", () => {
    expect(fechaAr("2026-09-21T20:50:30+00:00")).toBe(
      "2026-09-21T17:50:30.000-03:00",
    );
    expect(fechaAr("2026-09-21T17:50:59")).toBe(
      "2026-09-21T17:50:59.000-03:00",
    );
    expect(fechaAr("2026-09-21 17:50:59")).toBe(
      "2026-09-21T17:50:59.000-03:00",
    );
    expect(fechaAr("")).toBe("");
  });

  it("la venta completa", () => {
    const v = buildNubceoSale(ENV, { taxCode: "30-68543701-1", index: 0 });
    expect([
      v.saleIndexNumber,
      v.taxCode,
      v.customerBranchReference,
      v.date,
      v.currencyCode,
      v.type,
      v.id,
    ]).toEqual([
      0,
      "30685437011",
      "12",
      "2026-09-21T17:50:30.000-03:00",
      "ARS",
      "invoice",
      "napse-abc",
    ]);
    expect([v.grossAmount, v.netAmount, v.taxAmount]).toEqual([
      121000, 100000, 21000,
    ]);
    expect([
      v.categoryOne,
      v.categoryTwo,
      v.categoryThree,
      v.internalReference,
    ]).toEqual(["bridge", "70003", "TF B", "TF B-0711-10"]);
    expect(v.relatedPayments).toHaveLength(2);
    expect(v.relatedPayments[0]).toEqual({
      id: "napse-abc-1",
      presentedDate: "2026-09-21T17:50:59.000-03:00",
      date: "2026-09-21T17:50:59.000-03:00",
      grossAmount: 60500,
      currencyCode: "ARS",
      platformExternalCode: "prisma_ar",
      platformBranchReference: "111",
      paymentType: "credit",
      cardBrand: "VISA",
      buyerIdentification: "25133224",
    });
    const p2 = v.relatedPayments[1]!;
    expect("platformExternalCode" in p2 || "cardBrand" in p2).toBe(false);
    expect(p2.paymentType).toBe("cash");
  });

  it("pago de Mercado Pago: operación, cupón, autorización, cuotas, lote y terminal", () => {
    const e: SaleEnvelope = {
      ...ENV,
      ventaId: "bridge0000027825",
      payments: [
        {
          ...ENV.payments[0]!,
          platform: "mercadopago_ar",
          merchant: "",
          brand: "MASTERCARD",
          externalRef: "179321806741",
          voucher: "179321806741",
          authorization: "XTZYBZ",
          installments: 3,
          batch: "12",
          terminal: "72025185",
        },
      ],
    };
    const p = buildNubceoSale(e, { index: 0 }).relatedPayments[0]!;
    expect([
      p.id,
      p.externalReference,
      p.voucher,
      p.authorizationCode,
      p.installments,
      p.batch,
      p.terminal,
    ]).toEqual([
      "bridge0000027825-1",
      "179321806741",
      "179321806741",
      "XTZYBZ",
      3,
      "12",
      "72025185",
    ]);
  });

  it("pago parcial: el total es lo incluido y cierra neto + impuestos", () => {
    const e = {
      ...ENV,
      payments: [ENV.payments[0]!, { ...ENV.payments[1]!, include: false }],
    };
    const v = buildNubceoSale(e, { index: 3 });
    expect([v.grossAmount, v.netAmount, v.taxAmount]).toEqual([
      60500, 50000, 10500,
    ]);
    expect("taxCode" in v).toBe(false);
    expect(v.saleIndexNumber).toBe(3);
  });

  it("nota de crédito: todo negativo", () => {
    const v = buildNubceoSale({ ...ENV, type: "creditNote" }, { index: 0 });
    expect(v.type).toBe("creditNote");
    expect([v.grossAmount, v.netAmount, v.taxAmount]).toEqual([
      -121000, -100000, -21000,
    ]);
    expect(v.relatedPayments.every((p) => p.grossAmount < 0)).toBe(true);
  });

  it("sin total: neto = total e impuestos 0; y el redondeo cierra en centavos", () => {
    const v = buildNubceoSale({ ...ENV, total: 0 }, { index: 0 });
    expect([v.netAmount, v.taxAmount]).toEqual([121000, 0]);
    const w = buildNubceoSale(
      {
        ...ENV,
        total: 300,
        net: 100,
        payments: [{ ...ENV.payments[1]!, amount: 100 }],
      },
      { index: 0 },
    );
    expect([w.grossAmount, w.netAmount, w.taxAmount]).toEqual([
      100, 33.33, 66.67,
    ]);
    expect(Math.round(w.netAmount * 100) + Math.round(w.taxAmount * 100)).toBe(
      Math.round(w.grossAmount * 100),
    );
  });

  it("los datos apagados no viajan y la fecha del pago puede ser la de la venta", () => {
    const v = buildNubceoSale(ENV, {
      index: 0,
      paymentDate: "sale",
      fields: { platformBranchReference: false, buyerIdentification: false },
    });
    const p = v.relatedPayments[0]!;
    expect(p.platformBranchReference).toBeUndefined();
    expect(p.buyerIdentification).toBeUndefined();
    expect(p.date).toBe("2026-09-21T17:50:30.000-03:00");
  });
});

// -----------------------------------------------------------------------------
// De la venta de NinjaPOS al sobre
// -----------------------------------------------------------------------------

const STORE = "11111111-1111-1111-1111-111111111111";
const OTHER_STORE = "22222222-2222-2222-2222-222222222222";

function snap(
  over: Partial<SaleSnapshot> = {},
  sale: Partial<SaleSnapshot["sale"]> = {},
): SaleSnapshot {
  return {
    sync_id: "s1",
    kind: "sale",
    venta_id: "NP-1520",
    status: "sending",
    sale: {
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      number: 1520,
      created_at: "2026-10-20T15:10:00+00:00",
      status: "completed",
      total: 12100,
      tax_total: 2100,
      store_id: STORE,
      store_name: "Centro",
      register_name: "Caja 1",
      cashier_name: "Ana",
      customer_name: "Juan Pérez",
      customer_doc: "20.123.456",
      ...sale,
    },
    payments: [
      {
        id: "p1",
        method: "credit",
        amount: 10000,
        reference: null,
        card_voucher: {
          marca: "Visa",
          lote: "12",
          cupon: "345",
          autorizacion: "ab12cd",
          ultimos4: "4242",
          comercio: "99887766",
          cuotas: 3,
          adquirente: "payway",
        },
        created_at: "2026-10-20T15:10:00+00:00",
        provider_key: null,
        provider_payment_id: null,
      },
      {
        id: "p2",
        method: "cash",
        amount: 2100,
        reference: null,
        card_voucher: {},
        created_at: "2026-10-20T15:10:00+00:00",
        provider_key: null,
        provider_payment_id: null,
      },
    ],
    ret: null,
    ...over,
  };
}

const MAP = (() => {
  const m = defaultMapping();
  m.branchCodes[STORE] = "SUC-01";
  return m;
})();

describe("clasificación de ventas de NinjaPOS", () => {
  it("arma el sobre con cupón, plataforma por adquirente y marca", () => {
    const c = classifySnapshot(snap(), { mapping: MAP, storeIds: null });
    expect(c.action).toBe("send");
    if (c.action !== "send") return;
    const v = buildNubceoSale(c.envelope, {
      index: 0,
      taxCode: "20-12345678-6",
    });
    expect(v.customerBranchReference).toBe("SUC-01");
    expect(v.id).toBe("NP-1520");
    expect([v.grossAmount, v.netAmount, v.taxAmount]).toEqual([
      12100, 10000, 2100,
    ]);
    expect([v.categoryOne, v.categoryTwo, v.categoryThree]).toEqual([
      "Centro",
      "Caja 1",
      "POS",
    ]);
    expect(v.internalReference).toBe("Venta 1520");
    const card = v.relatedPayments[0]!;
    expect(card).toMatchObject({
      id: "NP-1520-1",
      platformExternalCode: "prisma_ar",
      platformBranchReference: "99887766",
      paymentType: "credit",
      cardBrand: "VISA",
      cardNumber: "************4242",
      voucher: "345",
      batch: "12",
      authorizationCode: "AB12CD",
      installments: 3,
      buyerIdentification: "20123456",
    });
    expect(v.relatedPayments[1]).toMatchObject({
      id: "NP-1520-2",
      paymentType: "cash",
    });
  });

  it("QR de Mercado Pago: plataforma y operación salen del intent", () => {
    const s = snap({
      payments: [
        {
          id: "q",
          method: "qr",
          amount: 12100,
          reference: "0f0f0f0f-0000-0000-0000-000000000000",
          card_voucher: {},
          created_at: "2026-10-20T15:10:00+00:00",
          provider_key: "mercadopago",
          provider_payment_id: "179321806741",
        },
      ],
    });
    const c = classifySnapshot(s, { mapping: MAP, storeIds: null });
    if (c.action !== "send") throw new Error(c.action);
    const p = buildNubceoSale(c.envelope, { index: 0 }).relatedPayments[0]!;
    expect([
      p.platformExternalCode,
      p.paymentType,
      p.externalReference,
    ]).toEqual(["mercadopago_ar", "qr", "179321806741"]);
  });

  it("Point integrado: el proveedor manda sobre el adquirente", () => {
    expect(providerBrand("mercadopago_point")).toBe("mercadopago");
    expect(providerBrand("fiserv_point")).toBe("fiserv");
    const s = snap();
    s.payments[0] = { ...s.payments[0]!, provider_key: "getnet_point" };
    const c = classifySnapshot(s, { mapping: MAP, storeIds: null });
    if (c.action !== "send") throw new Error(c.action);
    expect(c.envelope.payments[0]!.platform).toBe("getnet_ar");
  });

  it("medio apagado: no viaja; sin medios incluidos se excluye", () => {
    const m = normalizeMapping({
      ...MAP,
      methods: { cash: { include: false, paymentType: "cash", platform: "" } },
    });
    const c = classifySnapshot(snap(), { mapping: m, storeIds: null });
    if (c.action !== "send") throw new Error(c.action);
    expect(c.envelope.payments.filter((p) => p.include)).toHaveLength(1);
    const onlyCash = snap({ payments: [snap().payments[1]!] });
    expect(classifySnapshot(onlyCash, { mapping: m, storeIds: null })).toEqual({
      action: "exclude",
      reason: "Sin medios de pago incluidos",
    });
  });

  it("cuenta corriente y vales nacen apagados", () => {
    const s = snap({
      payments: [{ ...snap().payments[1]!, method: "account", amount: 12100 }],
    });
    expect(classifySnapshot(s, { mapping: MAP, storeIds: null }).action).toBe(
      "exclude",
    );
  });

  it("sucursal no incluida, sin código cabecera, anulada y en cero", () => {
    expect(
      classifySnapshot(snap(), { mapping: MAP, storeIds: [OTHER_STORE] }),
    ).toEqual({
      action: "exclude",
      reason: "Sucursal no incluida",
    });
    const sinCodigo = classifySnapshot(
      snap({}, { store_id: OTHER_STORE, store_name: "Norte" }),
      { mapping: MAP, storeIds: null },
    );
    expect(sinCodigo).toEqual({
      action: "config_error",
      reason: "Falta el código de sucursal cabecera de Norte",
    });
    expect(
      classifySnapshot(snap({}, { status: "voided" }), {
        mapping: MAP,
        storeIds: null,
      }).action,
    ).toBe("exclude");
    expect(
      classifySnapshot(snap({}, { total: 0 }), { mapping: MAP, storeIds: null })
        .action,
    ).toBe("exclude");
  });

  it("devolución en efectivo como nota de crédito negativa", () => {
    const s = snap({
      kind: "return",
      venta_id: returnVentaIdFor("NP-1520", 7),
      ret: {
        id: "r1",
        number: 7,
        created_at: "2026-10-21T13:00:00+00:00",
        total: 2420,
        refund_method: "cash",
      },
    });
    const c = classifySnapshot(s, { mapping: MAP, storeIds: null });
    if (c.action !== "send") throw new Error(c.action);
    const v = buildNubceoSale(c.envelope, { index: 0 });
    expect(v.id).toBe("NP-1520-NC7");
    expect(v.type).toBe("creditNote");
    expect([v.grossAmount, v.netAmount, v.taxAmount]).toEqual([
      -2420, -2000, -420,
    ]);
    expect(v.relatedPayments[0]).toMatchObject({
      id: "NP-1520-NC7-1",
      grossAmount: -2420,
      paymentType: "cash",
    });
    const credit = snap({
      kind: "return",
      ret: {
        id: "r1",
        number: 7,
        created_at: "x",
        total: 10,
        refund_method: "store_credit",
      },
    });
    expect(
      classifySnapshot(credit, { mapping: MAP, storeIds: null }).action,
    ).toBe("exclude");
  });
});

describe("vuelto e IVA", () => {
  it("el vuelto sale del efectivo: el total es lo que entró", () => {
    const s = snap({}, { total: 12100 });
    s.payments[1] = { ...s.payments[1]!, amount: 5000 }; // pagó 5000 en efectivo por 2100
    const c = classifySnapshot(s, { mapping: MAP, storeIds: null });
    if (c.action !== "send") throw new Error(c.action);
    const v = buildNubceoSale(c.envelope, { index: 0 });
    expect(v.grossAmount).toBe(12100);
    expect(v.relatedPayments.map((p) => p.grossAmount)).toEqual([10000, 2100]);
  });

  it("sin impuesto en la venta, la alícuota del mapeo separa neto e IVA", () => {
    expect(netOf(12100, 0, 21)).toBe(10000);
    expect(netOf(12100, 2100, 10.5)).toBe(10000);
    expect(netOf(12100, 0, 0)).toBe(12100);
    const m = normalizeMapping({ ...MAP, taxRate: 21 });
    const c = classifySnapshot(snap({}, { tax_total: 0 }), { mapping: m, storeIds: null });
    if (c.action !== "send") throw new Error(c.action);
    const v = buildNubceoSale(c.envelope, { index: 0 });
    expect([v.grossAmount, v.netAmount, v.taxAmount]).toEqual([12100, 10000, 2100]);
    expect(normalizeMapping({ taxRate: 15 }).taxRate).toBe(0);
  });
});

describe("marcas, ids y mapeo", () => {
  it("marca del cupón → marca de NubCeo, con variante de débito", () => {
    expect(nubceoCardBrand("Visa", "credit")).toBe("VISA");
    expect(nubceoCardBrand("Visa", "debit")).toBe("VISA DEBIT");
    expect(nubceoCardBrand("Mastercard", "debit")).toBe("MASTERCARD DEBIT");
    expect(nubceoCardBrand("American Express", "credit")).toBe("AMEX");
    expect(nubceoCardBrand("Amex", "debit")).toBe("AMEX");
    expect(nubceoCardBrand("Naranja X", "credit")).toBe("NARANJA");
    expect(nubceoCardBrand("Visa Signature", "credit")).toBe("VISA");
    expect(nubceoCardBrand("Tarjeta rara", "credit")).toBe("");
    expect(
      nubceoCardBrand("Tarjeta rara", "credit", { "tarjeta rara": "OTHER" }),
    ).toBe("OTHER");
  });

  it("id de la venta: prefijo saneado + número o uuid", () => {
    const sale = { id: "abc-123", number: 42 };
    expect(
      ventaIdFor({ saleIdSource: "number", saleIdPrefix: "NP-" }, sale),
    ).toBe("NP-42");
    expect(ventaIdFor({ saleIdSource: "uuid", saleIdPrefix: "" }, sale)).toBe(
      "abc-123",
    );
    expect(sanitizePrefix("Mi negocio #1/")).toBe("Minegocio1");
  });

  it("normaliza lo guardado y descarta valores fuera de catálogo", () => {
    const m = normalizeMapping({
      saleIdPrefix: "  X/Y ",
      methods: {
        qr: {
          include: false,
          paymentType: "bitcoin",
          platform: "inventada_ar",
        },
      },
      platforms: { nave: "naranja_ar", payway: "no_existe" },
      categories: [{ source: "fixed", value: "Mayorista" }, { source: "nada" }],
      cardBrands: { "Visa Galicia": "visa" },
    });
    expect(m.saleIdPrefix).toBe("XY");
    expect(m.methods.qr).toEqual({
      include: false,
      paymentType: "qr",
      platform: "",
    });
    expect(m.platforms.nave).toBe("naranja_ar");
    expect(m.platforms.payway).toBe("prisma_ar");
    expect(m.categories[0]).toEqual({ source: "fixed", value: "Mayorista" });
    expect(m.categories[1]).toEqual({ source: "register", value: "" });
    expect(m.cardBrands["visa galicia"]).toBe("VISA");
    expect(normalizeMapping(null)).toEqual(defaultMapping());
  });

  it("avisa lo que falta para poder mandar", () => {
    const w = mappingWarnings(defaultMapping(), [STORE]);
    expect(w[0]).toMatch(/1 sucursal/);
    expect(mappingWarnings(MAP, [STORE])).toEqual([]);
  });

  it("la huella no depende del orden de las claves", () => {
    expect(payloadHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      payloadHash({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
});

// -----------------------------------------------------------------------------
// Respuestas de NubCeo (casos de respuesta.test.js de ANDESMAR y de la spec)
// -----------------------------------------------------------------------------

describe("respuestas de NubCeo", () => {
  it("200: insertadas, ya existentes y sin confirmar", () => {
    const r = readInsertResponse(
      {
        status: 200,
        body: {
          data: {
            insertedSales: [{ insertedSaleId: "A" }],
            summary: { existingSalesIds: ["B for company id 1194"] },
          },
        },
      },
      ["A", "B", "C"],
    );
    expect(r.kind).toBe("ok");
    expect(r.results.A).toEqual({ result: "ok" });
    expect(r.results.B).toEqual({ result: "already" });
    expect(r.results.C?.result).toBe("unconfirmed");
  });

  it("400 con índice: sólo esas se rechazan; fuera de rango se parte la tanda", () => {
    const r = readInsertResponse(
      {
        status: 400,
        body: {
          errors: [
            { SaleIndexNumber: 1, message: "grossAmount inválido" },
            { saleIndexNumber: 1, message: "otra" },
          ],
        },
      },
      ["A", "B", "C"],
    );
    expect(r.kind).toBe("rejected");
    expect(r.results.B).toEqual({
      result: "rejected",
      message: "grossAmount inválido · otra",
    });
    expect(r.results.A).toBeUndefined();
    const fuera = readInsertResponse(
      { status: 400, body: { errors: [{ SaleIndexNumber: 9, message: "x" }] } },
      ["A", "B"],
    );
    expect(fuera.kind).toBe("split");
    const una = readInsertResponse(
      {
        status: 400,
        body: { message: "Customer branch references IDs not found" },
      },
      ["A"],
    );
    expect(una.kind).toBe("rejected");
    expect(una.results.A).toEqual({
      result: "rejected",
      message: "Customer branch references IDs not found",
    });
  });

  it("401/403 son credenciales; 5xx y red se reintentan", () => {
    expect(readInsertResponse({ status: 403, body: null }, ["A"]).kind).toBe(
      "credentials",
    );
    expect(
      readInsertResponse({ status: 502, body: { message: "gateway" } }, ["A"])
        .message,
    ).toBe("NubCeo respondió 502: gateway");
    expect(
      readInsertResponse({ status: 0, body: null, error: "timeout" }, ["A"])
        .kind,
    ).toBe("retry");
  });

  it("borrado: borradas, inexistentes, conciliadas y sin nombrar", () => {
    const out = readDeleteResponse(
      {
        status: 200,
        body: {
          data: {
            deletedSales: { ids: ["A"] },
            noExistentSales: { ids: ["B for company id 1"] },
            reconciledSales: { ids: ["C"] },
          },
        },
      },
      ["A", "B", "C", "D"],
    );
    expect(out.A).toEqual({ result: "deleted" });
    expect(out.B).toEqual({ result: "deleted", message: "NubCeo no la tenía" });
    expect(out.C?.result).toBe("reconciled");
    expect(out.D?.result).toBe("retry");
    expect(readDeleteResponse({ status: 500, body: null }, ["A"]).A).toEqual({
      result: "retry",
      message: "NubCeo respondió 500",
    });
  });

  it("compañía por CUIT o la única", () => {
    const body = {
      data: [
        { id: 1446, name: "Empresa 2", taxCode: "30-68543701-1" },
        { id: 7, name: "Otra", taxCode: "1" },
      ],
    };
    expect(pickCompany(body, "30685437011")).toEqual({
      id: "1446",
      name: "Empresa 2",
    });
    expect(pickCompany(body, "")).toBeNull();
    expect(pickCompany({ data: [{ id: 9, name: "Única" }] }, "")).toEqual({
      id: "9",
      name: "Única",
    });
  });
});

// -----------------------------------------------------------------------------
// Reintentos, ritmo y ventana
// -----------------------------------------------------------------------------

describe("reintentos con espera creciente", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  it("1, 5, 15, 30, 60 y 180 minutos; después repite el último", () => {
    const mins = [1, 2, 3, 4, 5, 6, 9].map(
      (a) => (Date.parse(nextAttemptAt(a, now)) - now) / 60_000,
    );
    expect(mins).toEqual([1, 5, 15, 30, 60, 180, 180]);
    expect((Date.parse(nextAttemptAt(0, now)) - now) / 60_000).toBe(1);
  });
  it("se agota al llegar al máximo", () => {
    expect(exhausted(7, 8)).toBe(false);
    expect(exhausted(8, 8)).toBe(true);
  });
});

describe("ventana horaria (hora de Argentina)", () => {
  // 2026-10-20 es martes (2). 12:00 UTC = 09:00 en Argentina.
  const at = (iso: string) => Date.parse(iso);
  const all = [0, 1, 2, 3, 4, 5, 6];
  it("todo el día cuando inicio = fin", () => {
    expect(
      inWindow(
        { start: "00:00", end: "00:00", days: all },
        at("2026-10-20T12:00:00Z"),
      ),
    ).toBe(true);
    expect(
      inWindow(
        { start: "00:00", end: "00:00", days: [0] },
        at("2026-10-20T12:00:00Z"),
      ),
    ).toBe(false);
  });
  it("franja de comercio, con el fin excluido", () => {
    const w = { start: "08:00", end: "21:00", days: [1, 2, 3, 4, 5, 6] };
    expect(inWindow(w, at("2026-10-20T11:00:00Z"))).toBe(true); // 08:00
    expect(inWindow(w, at("2026-10-20T10:59:00Z"))).toBe(false); // 07:59
    expect(inWindow(w, at("2026-10-21T00:00:00Z"))).toBe(false); // 21:00
    expect(inWindow(w, at("2026-10-18T15:00:00Z"))).toBe(false); // domingo
  });
  it("franja nocturna que cruza la medianoche cuenta el día del inicio", () => {
    const w = { start: "22:00", end: "06:00", days: [2] }; // martes a la noche
    expect(inWindow(w, at("2026-10-21T01:30:00Z"))).toBe(true); // martes 22:30
    expect(inWindow(w, at("2026-10-21T05:00:00Z"))).toBe(true); // miércoles 02:00
    expect(inWindow(w, at("2026-10-21T10:00:00Z"))).toBe(false); // miércoles 07:00
    expect(inWindow(w, at("2026-10-20T05:00:00Z"))).toBe(false); // martes 02:00 (es de la noche del lunes)
  });
  it("próxima vuelta: al minuto y con mínimo de 5", () => {
    expect(nextRunAt(at("2026-10-20T12:00:42Z"), 60)).toBe(
      "2026-10-20T13:00:00.000Z",
    );
    expect(nextRunAt(at("2026-10-20T12:00:00Z"), 1)).toBe(
      "2026-10-20T12:05:00.000Z",
    );
  });
});

describe("URL de la API", () => {
  it("sólo https de nubceo.com", () => {
    expect(allowedApiUrl("")).toEqual({
      ok: true,
      url: "https://connectapi.nubceo.com",
    });
    expect(allowedApiUrl("https://sandbox.nubceo.com/")).toEqual({
      ok: true,
      url: "https://sandbox.nubceo.com",
    });
    expect(allowedApiUrl("http://connectapi.nubceo.com").ok).toBe(false);
    expect(allowedApiUrl("https://nubceo.com.evil.io").ok).toBe(false);
    expect(allowedApiUrl("https://user:pass@connectapi.nubceo.com").ok).toBe(
      false,
    );
    expect(allowedApiUrl("https://connectapi.nubceo.com:8443").ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Asientos contables (ejemplo de la especificación, sección 11)
// -----------------------------------------------------------------------------

describe("asientos contables", () => {
  const BODY = {
    status: 200,
    meta: { count: 1, total: 1 },
    data: [
      {
        id: "7cba370e-6bd0-11f0-9756-061f288a1ee7",
        number: "1",
        tenantId: "1616",
        companyId: "1194",
        accountingBatchId: "23e874ba-6bd0-11f0-9755-061f288a1ee7",
        ledgerCategory: "settlement",
        status: "not_confirmed",
        date: "2025-05-20T03:00:00.000-03:00",
        currencyCode: "ARS",
        deletedAt: null,
        LedgerEntries: [
          {
            id: "c2083b94-6bd5-11f0-949a-061f288a1ee7",
            ledgerHeaderId: "7cba370e-6bd0-11f0-9756-061f288a1ee7",
            amount: 202698.93,
            accountingAccountId: "bae6de38-6bd5-11f0-9499-061f288a1ee7",
            costCenterCode: "CCC",
            AccountingAccount: {
              id: "bae6de38-6bd5-11f0-9499-061f288a1ee7",
              name: "Sales",
              code: "Sale-100",
              subaccountCode: "",
              subaccountName: null,
            },
          },
        ],
      },
      { id: "", date: "2025-05-20" },
    ],
  };

  it("normaliza cabecera y renglones", () => {
    const r = parseLedgerPage(BODY);
    expect(r.total).toBe(1);
    expect(r.headers).toHaveLength(1);
    const h = r.headers[0]!;
    expect([
      h.nubceo_id,
      h.number,
      h.company_id,
      h.category,
      h.status,
      h.date,
      h.currency,
      h.deleted,
    ]).toEqual([
      "7cba370e-6bd0-11f0-9756-061f288a1ee7",
      "1",
      "1194",
      "settlement",
      "not_confirmed",
      "2025-05-20",
      "ARS",
      false,
    ]);
    expect(h.entries[0]).toEqual({
      nubceo_id: "c2083b94-6bd5-11f0-949a-061f288a1ee7",
      account_id: "bae6de38-6bd5-11f0-9499-061f288a1ee7",
      account_code: "Sale-100",
      account_name: "Sales",
      subaccount_code: "",
      subaccount_name: "",
      cost_center: "CCC",
      amount: 202698.93,
    });
  });

  it("query con página, orden y filtro por actualización", () => {
    expect(
      ledgerQuery({
        page: 2,
        pageSize: 1000,
        updatedSince: "2026-10-01T00:00:00Z",
      }),
    ).toBe(
      "page=2&pageSize=500&sort[updatedAt][dir]=asc&filter[updatedAt][gte]=2026-10-01T00%3A00%3A00Z",
    );
  });
});

// -----------------------------------------------------------------------------
// Cliente HTTP con fetch falso (nunca se llama a NubCeo de verdad)
// -----------------------------------------------------------------------------

describe("cliente de la API", () => {
  function fake(responses: { status: number; body: unknown }[]) {
    const calls: {
      url: string;
      method: string;
      auth: string | null;
      body: unknown;
    }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const impl = (async (url: string, init: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      const h = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: String(init.method),
        auth: h.Authorization ?? null,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      const next = responses.shift() ?? { status: 500, body: null };
      inFlight--;
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as unknown as typeof fetch;
    return { impl, calls, max: () => maxInFlight };
  }

  it("login, Bearer y rutas de la especificación", async () => {
    const f = fake([
      { status: 200, body: { token: "T1" } },
      { status: 200, body: { data: { insertedSales: [] } } },
      { status: 200, body: { data: [] } },
    ]);
    const api = createNubceoApi({
      baseUrl: "https://connectapi.nubceo.com/",
      apiKey: "k",
      apiSecret: "s",
      tenant: "1616",
      fetchImpl: f.impl,
    });
    await api.insertSales([]);
    await api.ledgerHeaders("page=1");
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://connectapi.nubceo.com/authenticate",
      "POST https://connectapi.nubceo.com/v1/tenants/1616/reconciler/sales",
      "GET https://connectapi.nubceo.com/v1/tenants/1616/accounting/ledger-header?page=1",
    ]);
    expect(f.calls[0]!.body).toEqual({ API_KEY: "k", API_SECRET: "s" });
    expect(f.calls[1]!.auth).toBe("Bearer T1");
  });

  it("un 401 renueva el token una vez; credenciales malas vuelven como 401", async () => {
    const f = fake([
      { status: 200, body: { token: "T1" } },
      { status: 401, body: {} },
      { status: 200, body: { token: "T2" } },
      { status: 200, body: { data: {} } },
    ]);
    const api = createNubceoApi({
      baseUrl: "",
      apiKey: "k",
      apiSecret: "s",
      tenant: "1",
      fetchImpl: f.impl,
    });
    const r = await api.deleteSales("1194", ["A"]);
    expect(r.status).toBe(200);
    expect(f.calls[3]!.auth).toBe("Bearer T2");
    expect(f.calls[3]!.url).toBe(
      "https://connectapi.nubceo.com/v1/tenants/1/1194/reconciler/sales/delete",
    );
    const g = fake([{ status: 403, body: { message: "no" } }]);
    const bad = createNubceoApi({
      baseUrl: "",
      apiKey: "k",
      apiSecret: "x",
      tenant: "1",
      fetchImpl: g.impl,
    });
    expect((await bad.companies()).status).toBe(401);
  });

  it("los pedidos nunca van en paralelo", async () => {
    const f = fake([
      { status: 200, body: { token: "T" } },
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const api = createNubceoApi({
      baseUrl: "",
      apiKey: "k",
      apiSecret: "s",
      tenant: "1",
      fetchImpl: f.impl,
    });
    await Promise.all([
      api.companies(),
      api.ledgerStatus("confirmed", ["x"]),
      api.companies(),
    ]);
    expect(f.max()).toBe(1);
    expect(f.calls[2]!.body).toEqual({ status: "confirmed", ids: ["x"] });
    expect(f.calls[2]!.method).toBe("PATCH");
  });
});

// -----------------------------------------------------------------------------
// Feature de plan (CLAUDE.md §6)
// -----------------------------------------------------------------------------

describe("feature integracion_nubceo", () => {
  it("tiene copy, es desde Business y pide las credenciales", () => {
    const f = FEATURE_INFO.integracion_nubceo;
    expect(f?.minPlan).toBe("Business");
    expect(f?.needs).toMatch(/API key/);
    expect(f?.desc).not.toContain("—");
  });

  it("la comparación de planes la deriva de la matriz (migración 20261025100000)", () => {
    const feature = { key: "integracion_nubceo", label: "Integración NubCeo", grupo: "integraciones", is_basic: false, sort: 215 };
    const plans = ["start", "pro", "business", "enterprise"].map((key, i) => ({
      key,
      name: key,
      sort: i,
      modules: { integracion_nubceo: key === "business" || key === "enterprise" },
    }));
    const c = comparePlans(plans, [feature]);
    expect(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.includedKeys.includes("integracion_nubceo")]))).toEqual({
      start: false,
      pro: false,
      business: true,
      enterprise: true,
    });
  });
});
