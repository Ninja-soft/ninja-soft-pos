import { describe, expect, it } from "vitest";
import { assignLots, lotConsumptionOrder, lotHealth, releaseSaleLots } from "@/lib/purchases/lots";

const lots = [
  { id: "A", expires_on: "2027-01-31", created_at: "2026-10-01T10:00:00Z", qty_available: 10 },
  { id: "B", expires_on: "2026-12-31", created_at: "2026-10-02T10:00:00Z", qty_available: 5 },
  { id: "C", expires_on: null, created_at: "2026-09-01T10:00:00Z", qty_available: 4 },
  { id: "D", expires_on: "2026-12-31", created_at: "2026-09-15T10:00:00Z", qty_available: 0 },
];

describe("consumo por lote (FEFO y FIFO)", () => {
  it("ordena por vencimiento, después por ingreso; sin vencimiento al final", () => {
    expect(lotConsumptionOrder(lots).map((l) => l.id)).toEqual(["D", "B", "A", "C"]);
  });

  it("una venta de 7 toma 5 del lote que vence antes y 2 del siguiente", () => {
    expect(assignLots(lots, 7)).toEqual([
      { lot_id: "B", qty: 5 },
      { lot_id: "A", qty: 2 },
    ]);
  });

  it("lo que no alcanza queda sin lote", () => {
    expect(assignLots(lots, 21)).toEqual([
      { lot_id: "B", qty: 5 },
      { lot_id: "A", qty: 10 },
      { lot_id: "C", qty: 4 },
      { lot_id: null, qty: 2 },
    ]);
  });

  it("sin vencimientos es FIFO puro por ingreso", () => {
    const fifo = [
      { id: "n", expires_on: null, created_at: "2026-10-05T00:00:00Z", qty_available: 3 },
      { id: "v", expires_on: null, created_at: "2026-10-01T00:00:00Z", qty_available: 3 },
    ];
    expect(assignLots(fifo, 4)).toEqual([
      { lot_id: "v", qty: 3 },
      { lot_id: "n", qty: 1 },
    ]);
  });
});

describe("anulación y devolución del cliente", () => {
  const book = [
    { lot_id: "B", qty: 5, created_at: "2026-10-10T10:00:00.001Z" },
    { lot_id: "A", qty: 2, created_at: "2026-10-10T10:00:00.002Z" },
    { lot_id: null, qty: 1, created_at: "2026-10-10T10:00:00.003Z" },
  ];

  it("devuelve primero lo sin lote y después del último lote consumido", () => {
    expect(releaseSaleLots(book, 4)).toEqual([
      { lot_id: null, qty: 1 },
      { lot_id: "A", qty: 2 },
      { lot_id: "B", qty: 1 },
    ]);
  });

  it("una anulación total devuelve todo lo neto (descuenta devoluciones previas)", () => {
    const withReturn = [...book, { lot_id: null, qty: -1, created_at: "2026-10-11T00:00:00Z" }];
    expect(releaseSaleLots(withReturn, 99)).toEqual([
      { lot_id: "A", qty: 2 },
      { lot_id: "B", qty: 5 },
    ]);
  });
});

describe("estado del lote", () => {
  it("vencido, por vencer, ok y agotado", () => {
    expect(lotHealth({ expires_on: "2026-10-01", qty_available: 1 }, "2026-10-12")).toBe("expired");
    expect(lotHealth({ expires_on: "2026-10-30", qty_available: 1 }, "2026-10-12")).toBe("expiring");
    expect(lotHealth({ expires_on: "2027-10-30", qty_available: 1 }, "2026-10-12")).toBe("ok");
    expect(lotHealth({ expires_on: null, qty_available: 1 }, "2026-10-12")).toBe("ok");
    expect(lotHealth({ expires_on: "2026-10-01", qty_available: 0 }, "2026-10-12")).toBe("empty");
  });
});
