import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  NO_BRAND,
  NO_MERCHANT,
  brandKeyFrom,
  brandOptions,
  filterCardRows,
  groupCardRows,
  groupCheckState,
  idsToToggle,
  merchantOptions,
  normalizeCardPayment,
  normalizeCardPayments,
  summarizeCardRows,
  xlsxBatchRows,
  xlsxDetailRows,
  type RawCardPayment,
} from "@/lib/reports/cardReconciliation";

// Timestamps armados en hora local para que el día no dependa del TZ del runner.
function at(y: number, m: number, d: number, h = 10, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

let seq = 0;
function pay(over: Partial<RawCardPayment> & { voucher?: Record<string, unknown> } = {}): RawCardPayment {
  const { voucher, ...rest } = over;
  seq += 1;
  return {
    id: `p${seq}`,
    method: "debit",
    amount: 100,
    reference: null,
    created_at: at(2026, 10, 10),
    reconciled_at: null,
    card_voucher: voucher ?? { lote: "1", cupon: String(seq), autorizacion: "A1", marca: "Visa", comercio: "111" },
    sales: { number: seq },
    ...rest,
  };
}

describe("normalizeCardPayment", () => {
  it("lee el cupón y traduce la marca a la clave del logo", () => {
    const r = normalizeCardPayment(
      pay({
        method: "credit",
        amount: "1500.5",
        voucher: { lote: " 12 ", cupon: "345", autorizacion: "XY9", marca: "Mastercard", ultimos4: "4242", comercio: "998877", cuotas: 3 },
        sales: { number: 77 },
      }),
    )!;
    expect(r).toMatchObject({
      kind: "credit",
      brandKey: "master",
      brandLabel: "Mastercard",
      lote: "12",
      cupon: "345",
      autorizacion: "XY9",
      ultimos4: "4242",
      comercio: "998877",
      installments: 3,
      amount: 1500.5,
      ticket: 77,
      day: "2026-10-10",
    });
  });

  it("tolera card_voucher vacío o nulo (cobros integrados sin cupón)", () => {
    const r = normalizeCardPayment(pay({ card_voucher: null, reference: "intent-1" }))!;
    expect(r).toMatchObject({ lote: "", cupon: "", comercio: "", brandKey: null, brandLabel: "", reference: "intent-1", installments: null });
  });

  it("descarta medios que no son tarjeta", () => {
    expect(normalizeCardPayment(pay({ method: "cash" }))).toBeNull();
    expect(normalizeCardPayments([pay({ method: "qr" }), pay()])).toHaveLength(1);
  });

  it("brandKeyFrom reconoce claves, etiquetas y alias", () => {
    expect(brandKeyFrom("visa")).toBe("visa");
    expect(brandKeyFrom("American Express")).toBe("amex");
    expect(brandKeyFrom("Amex")).toBe("amex");
    expect(brandKeyFrom("Otra")).toBeNull();
    expect(brandKeyFrom(undefined)).toBeNull();
  });
});

describe("filtros", () => {
  const rows = normalizeCardPayments([
    pay({ method: "debit", voucher: { marca: "Visa", comercio: "111", lote: "1" } }),
    pay({ method: "credit", voucher: { marca: "Mastercard", comercio: "222", lote: "4" }, reconciled_at: at(2026, 10, 11) }),
    pay({ method: "credit", voucher: { lote: "5" } }),
  ]);

  it("sin filtros devuelve todo", () => {
    expect(filterCardRows(rows, DEFAULT_FILTERS)).toHaveLength(3);
  });

  it("por tipo, marca, comercio y estado", () => {
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, kind: "credit" })).toHaveLength(2);
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, brand: "master" }).map((r) => r.comercio)).toEqual(["222"]);
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, brand: NO_BRAND })).toHaveLength(1);
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, comercio: "111" })).toHaveLength(1);
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, comercio: NO_MERCHANT })).toHaveLength(1);
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, status: "pending" })).toHaveLength(2);
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, status: "reconciled" })).toHaveLength(1);
  });

  it("opciones de marca y comercio, con 'sin' al final", () => {
    expect(brandOptions(rows)).toEqual([
      { value: "master", label: "Mastercard" },
      { value: "visa", label: "Visa" },
      { value: NO_BRAND, label: "Sin marca" },
    ]);
    expect(merchantOptions(rows).map((o) => o.value)).toEqual(["111", "222", NO_MERCHANT]);
  });
});

describe("agrupado día → comercio → lote", () => {
  const rows = normalizeCardPayments([
    pay({ created_at: at(2026, 10, 9, 18), amount: 50, voucher: { comercio: "111", lote: "10" } }),
    pay({ created_at: at(2026, 10, 10, 12), amount: 200, voucher: { comercio: "111", lote: "2" } }),
    pay({ created_at: at(2026, 10, 10, 9), amount: 100.1, voucher: { comercio: "111", lote: "2" } }),
    pay({ created_at: at(2026, 10, 10, 11), amount: 300, voucher: { comercio: "111", lote: "10" } }),
    pay({ created_at: at(2026, 10, 10, 15), amount: 40, voucher: { lote: "" } }),
    pay({ created_at: at(2026, 10, 10, 16), amount: 60, voucher: { comercio: "099", lote: "1" }, reconciled_at: at(2026, 10, 11) }),
  ]);
  const groups = groupCardRows(rows);

  it("días del más nuevo al más viejo con subtotales", () => {
    expect(groups.map((g) => [g.day, g.count, g.amount])).toEqual([
      ["2026-10-10", 5, 700.1],
      ["2026-10-09", 1, 50],
    ]);
  });

  it("comercios y lotes en orden natural, sin número al final", () => {
    const day = groups[0]!;
    expect(day.merchants.map((m) => [m.comercio, m.count, m.amount])).toEqual([
      ["099", 1, 60],
      ["111", 3, 600.1],
      ["", 1, 40],
    ]);
    const m111 = day.merchants[1]!;
    expect(m111.batches.map((b) => [b.lote, b.count, b.amount])).toEqual([
      ["2", 2, 300.1],
      ["10", 1, 300],
    ]);
    // Dentro del lote, por hora.
    expect(m111.batches[0]!.rows.map((r) => r.amount)).toEqual([100.1, 200]);
  });

  it("resumen total, conciliado y pendiente", () => {
    expect(summarizeCardRows(rows)).toEqual({
      total: { count: 6, amount: 750.1 },
      reconciled: { count: 1, amount: 60 },
      pending: { count: 5, amount: 690.1 },
    });
  });

  it("estado del checkbox de grupo e ids a mandar", () => {
    const all = rows;
    expect(groupCheckState(all)).toBe("some");
    expect(groupCheckState(all.filter((r) => r.reconciledAt))).toBe("all");
    expect(groupCheckState(all.filter((r) => !r.reconciledAt))).toBe("none");
    expect(idsToToggle(all, true)).toHaveLength(5);
    expect(idsToToggle(all, false)).toHaveLength(1);
  });

  it("XLSX: detalle con subtotales por lote, comercio y día, y hoja por lote", () => {
    const detail = xlsxDetailRows(groups);
    // 6 cobros + 5 subtotales de lote + 4 de comercio + 2 de día.
    expect(detail).toHaveLength(17);
    expect(detail.find((r) => r.fecha === "Subtotal lote 2")).toMatchObject({ cantidad: 2, monto: 300.1 });
    expect(detail.find((r) => r.fecha === "Subtotal comercio 111")).toMatchObject({ cantidad: 3, monto: 600.1 });
    expect(detail.find((r) => r.fecha === "Subtotal sin lote")).toMatchObject({ cantidad: 1, monto: 40 });
    expect(detail.find((r) => r.fecha === "Total 10/10/2026")).toMatchObject({ cantidad: 5, monto: 700.1 });

    const batches = xlsxBatchRows(groups);
    expect(batches).toHaveLength(5);
    expect(batches[0]).toEqual({
      fecha: "10/10/2026",
      comercio: "099",
      lote: "1",
      cantidad: 1,
      monto: 60,
      conciliado: 60,
      pendiente: 0,
    });
  });
});
