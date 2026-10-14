import { describe, expect, it } from "vitest";
import {
  absoluteDateTime,
  averageTicket,
  cuotasLabel,
  filterByChannel,
  fiscalBadge,
  groupPayments,
  methodBreakdown,
  presentChannels,
  relativeTime,
  returnState,
  saleChannel,
  saleStatusBadge,
  saleTimeline,
  summaryPeriod,
  taxBreakdown,
  thumbsMosaic,
  totalsBreakdown,
  unitsCount,
  variantLabel,
} from "@/lib/sales/salesList";

// 13/10/2026 15:00 en Argentina (UTC-3) = 18:00 UTC.
const NOW = Date.parse("2026-10-13T18:00:00Z");

describe("fechas", () => {
  it("absoluteDateTime en hora de Argentina", () => {
    expect(absoluteDateTime("2026-10-13T17:05:00Z")).toBe("13/10/2026 14:05");
    expect(absoluteDateTime("no-es-fecha")).toBe("");
  });

  it("relativeTime: recién, minutos, horas, ayer, días y fecha", () => {
    expect(relativeTime("2026-10-13T17:59:30Z", NOW)).toBe("recién");
    expect(relativeTime("2026-10-13T17:45:00Z", NOW)).toBe("hace 15 min");
    expect(relativeTime("2026-10-13T16:00:00Z", NOW)).toBe("hace 2 h");
    // 12/10 21:30 AR = 13/10 00:30 UTC: es "ayer" en Argentina aunque en UTC sea el mismo día.
    expect(relativeTime("2026-10-13T00:30:00Z", NOW)).toBe("ayer 21:30");
    expect(relativeTime("2026-10-10T15:00:00Z", NOW)).toBe("hace 3 días");
    expect(relativeTime("2026-09-01T15:00:00Z", NOW)).toBe("01/09/2026");
  });
});

describe("canal", () => {
  it("prioriza Mercado Libre, después delivery, mesa, envío y offline", () => {
    expect(saleChannel({})).toBe("mostrador");
    expect(saleChannel({ shipmentSource: "mercadolibre", delivery: { order_type: "delivery" } })).toBe("mercadolibre");
    expect(saleChannel({ delivery: { order_type: "takeaway" } })).toBe("takeaway");
    expect(saleChannel({ delivery: { order_type: "delivery" }, table: true })).toBe("delivery");
    expect(saleChannel({ table: true })).toBe("mesa");
    expect(saleChannel({ shipmentSource: "pos_sale" })).toBe("envio");
    expect(saleChannel({ offline: true })).toBe("offline");
  });

  it("filterByChannel y presentChannels", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const ch: Record<string, "mostrador" | "delivery"> = { a: "mostrador", b: "delivery", c: "mostrador" };
    expect(filterByChannel(rows, (id) => ch[id] ?? null, "delivery").map((r) => r.id)).toEqual(["b"]);
    expect(filterByChannel(rows, (id) => ch[id] ?? null, "")).toHaveLength(3);
    expect(presentChannels(["delivery", null, "mostrador", "delivery"])).toEqual(["mostrador", "delivery"]);
  });
});

describe("cobros", () => {
  const intent = "11111111-2222-3333-4444-555555555555";
  it("agrupa por medio, proveedor y red; suma montos y toma las cuotas mayores", () => {
    const chips = groupPayments(
      [
        { method: "cash", amount: 1000, reference: null, card_voucher: null },
        { method: "credit", amount: 3000, reference: null, card_voucher: { marca: "Visa", cuotas: 3, ultimos4: "1234", adquirente: "getnet" } },
        { method: "credit", amount: 2000, reference: null, card_voucher: { marca: "VISA", cuotas: 6, ultimos4: "9999", adquirente: "getnet" } },
        { method: "qr", amount: 500, reference: intent, card_voucher: null },
      ],
      (ref) => (ref === intent ? "mercadopago" : null),
    );
    expect(chips.map((c) => [c.method, c.providerKey, c.amount])).toEqual([
      ["credit", "getnet", 5000],
      ["cash", null, 1000],
      ["qr", "mercadopago", 500],
    ]);
    expect(chips[0]).toMatchObject({ brandKey: "visa", cuotas: 6, count: 2, last4: null, providerLabel: "Getnet" });
    expect(chips[2]?.providerLabel).toBe("Mercado Pago");
  });

  it("cuotasLabel", () => {
    expect(cuotasLabel(null)).toBeNull();
    expect(cuotasLabel(1)).toBe("1 pago");
    expect(cuotasLabel(12)).toBe("12 cuotas");
  });

  it("methodBreakdown ordena, descarta ceros y calcula porcentajes", () => {
    const b = methodBreakdown([
      { method: "cash", total: 250 },
      { method: "debit", total: 750 },
      { method: "qr", total: 0 },
    ]);
    expect(b.map((x) => [x.method, x.label, x.pct])).toEqual([
      ["debit", "Débito", 75],
      ["cash", "Efectivo", 25],
    ]);
    expect(averageTicket(1000, 3)).toBe(333.33);
    expect(averageTicket(1000, 0)).toBe(0);
  });
});

describe("ítems y estados", () => {
  it("unidades, miniaturas y estado de devolución", () => {
    expect(unitsCount([{ quantity: 2 }, { quantity: 0.35 }, { quantity: 1 }])).toBe(4);
    expect(returnState([{ quantity: 2, returned_qty: 0 }])).toBe("none");
    expect(returnState([{ quantity: 2, returned_qty: 1 }, { quantity: 1 }])).toBe("partial");
    expect(returnState([{ quantity: 2, returned_qty: 2 }, { quantity: 1, returned_qty: 1 }])).toBe("full");
    expect(variantLabel({ option1: "Rojo", option2: " M " })).toBe("Rojo / M");
    expect(variantLabel({ option1: "", option2: null })).toBeNull();
  });

  it("badge de estado y fiscal", () => {
    expect(saleStatusBadge("voided", "full").label).toBe("Anulada");
    expect(saleStatusBadge("completed", "full").label).toBe("Devuelta");
    expect(saleStatusBadge("completed", "partial").label).toBe("Devuelta en parte");
    expect(saleStatusBadge("completed", "none").tone).toBe("success");
    expect(fiscalBadge([])).toBeNull();
    expect(fiscalBadge([{ origin: "sale", status: "aprobado", cae: "12345678901234" }])).toMatchObject({ label: "CAE", title: "CAE 12345678901234" });
    expect(fiscalBadge([{ origin: "sale", status: "pendiente" }])?.label).toBe("Factura pendiente");
    expect(fiscalBadge([{ origin: "sale", status: "rechazado" }])?.tone).toBe("danger");
    expect(fiscalBadge([{ origin: "return", status: "aprobado" }])).toBeNull();
  });
});

describe("totales e impuestos", () => {
  it("totalsBreakdown: descuentos en negativo y recargos que cierran el total", () => {
    const rows = totalsBreakdown(
      { subtotal: 10000, discount_total: 500, promo_discount: 1000, coupon_discount: 200, coupon_code: "HOLA", perception_total: 0, total: 8800 },
      [{ label: "2x1 remeras", amount: 1000 }],
    );
    expect(rows).toEqual([
      { key: "subtotal", label: "Subtotal", amount: 10000 },
      { key: "discount", label: "Descuento", amount: -500 },
      { key: "promo-0", label: "2x1 remeras", amount: -1000 },
      { key: "coupon", label: "Cupón HOLA", amount: -200 },
      { key: "extras", label: "Recargos y envío", amount: 500 },
    ]);
    expect(totalsBreakdown({ subtotal: 100, promo_discount: 10, promo_name: "Promo", total: 90 }).map((r) => r.key)).toEqual([
      "subtotal",
      "promo",
    ]);
  });

  it("taxBreakdown: IVA por alícuota, internos y percepciones", () => {
    const rows = taxBreakdown({ net_taxed: 1000, iva_total: 0 }, [
      { kind: "iva", tax: "iva", jurisdiction: null, rate: 21, amount: 150 },
      { kind: "iva", tax: "iva", jurisdiction: null, rate: 10.5, amount: 30 },
      { kind: "iva", tax: "iva", jurisdiction: null, rate: 21, amount: 60 },
      { kind: "perception", tax: "iva", jurisdiction: null, rate: 3, amount: 30 },
    ]);
    expect(rows.map((r) => [r.label, r.amount])).toEqual([
      ["Neto gravado", 1000],
      ["IVA 21 %", 210],
      ["IVA 10,5 %", 30],
      ["Perc. IVA 3 %", 30],
    ]);
    expect(taxBreakdown({ iva_total: 21, internal_tax_total: 5 }, []).map((r) => r.label)).toEqual(["IVA", "Impuestos internos"]);
  });
});

describe("línea de tiempo y período", () => {
  it("ordena hitos y marca anulación, devoluciones y reintegros", () => {
    const steps = saleTimeline({
      sale: { created_at: "2026-10-13T10:00:00Z", status: "voided", voided_at: "2026-10-13T12:00:00Z", void_reason: "Error" },
      intents: [{ provider_key: "mercadopago", status: "approved", updated_at: "2026-10-13T10:00:05Z" }],
      returns: [{ number: 7, created_at: "2026-10-13T11:00:00Z", total: 100 }],
      mpRefunds: [{ status: "approved", amount: 100, created_at: "2026-10-13T11:00:01Z", completed_at: "2026-10-13T11:00:10Z" }],
      fiscal: [{ origin: "sale", status: "aprobado", approved_at: "2026-10-13T10:01:00Z", created_at: "2026-10-13T10:00:00Z" }],
      formatMoney: (n) => `$${n}`,
    });
    expect(steps.map((s) => s.label)).toEqual([
      "Venta registrada",
      "Cobro aprobado por Mercado Pago",
      "Factura aprobada por ARCA",
      "Devolución N° 7",
      "Reintegro por Mercado Pago",
      "Venta anulada",
    ]);
    expect(steps.at(-1)).toMatchObject({ tone: "danger", detail: "Error" });
    expect(steps[3]?.detail).toBe("$100");
  });

  it("summaryPeriod: rango elegido o últimos 30 días", () => {
    const d = summaryPeriod(undefined, new Date(2026, 9, 13, 15));
    expect(d.isDefault).toBe(true);
    expect((Date.parse(d.toISO) - Date.parse(d.fromISO)) / 86400000).toBe(30);
    const r = summaryPeriod({ from: new Date(2026, 9, 1), to: new Date(2026, 9, 5) });
    expect(r.isDefault).toBe(false);
    expect(new Date(r.toISO).getDate()).toBe(6);
  });
});

describe("thumbsMosaic", () => {
  const it_ = (id: string, image_url: string | null = null) => ({ id, image_url });

  it("hasta 4 productos muestra todos, sin +N", () => {
    expect(thumbsMosaic([it_("a")])).toEqual({ shown: [it_("a")], extra: 0 });
    expect(thumbsMosaic([it_("a"), it_("b"), it_("c"), it_("d")]).extra).toBe(0);
    expect(thumbsMosaic([]).shown).toEqual([]);
  });

  it("con más de 4 muestra 3 y la cuarta celda es +N", () => {
    const r = thumbsMosaic(["a", "b", "c", "d", "e", "f"].map((x) => it_(x)));
    expect(r.shown.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(r.extra).toBe(3);
  });

  it("los productos con foto van primero (orden estable)", () => {
    const r = thumbsMosaic([it_("a"), it_("b", "https://x/b.webp"), it_("c", "  "), it_("d", "https://x/d.webp")]);
    expect(r.shown.map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
});
