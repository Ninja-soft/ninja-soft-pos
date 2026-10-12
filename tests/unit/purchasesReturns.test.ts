import { describe, expect, it } from "vitest";
import {
  averageAfterOutflow,
  formatReturnNumber,
  lastCostAfterVoid,
  receiptVoidBlockers,
  returnTotals,
  returnableQty,
  validateReturn,
} from "@/lib/purchases/returns";
import { weightedAverageCost } from "@/lib/purchases/costs";

describe("promedio al sacar unidades (devolución y anulación)", () => {
  it("devolver al costo de compra deshace esa compra en el promedio", () => {
    // 10 a 100 + 5 a 120 → 106,6667. Anular las 5 a 120 vuelve a 100.
    const avg = weightedAverageCost(10, 100, 5, 120)!;
    expect(avg).toBe(106.6667);
    expect(averageAfterOutflow(15, avg, 5, 120)).toBeCloseTo(100, 3);
  });

  it("caso del servidor: 8 u a 106,6667, devuelve 3 a 100 → 110,6667", () => {
    expect(averageAfterOutflow(8, 106.6667, 3, 100)).toBe(110.6667);
  });

  it("devolver al promedio no lo cambia", () => {
    expect(averageAfterOutflow(20, 150, 5, 150)).toBe(150);
  });

  it("si no queda stock, el promedio no cambia; nunca es negativo", () => {
    expect(averageAfterOutflow(5, 100, 5, 80)).toBe(100);
    expect(averageAfterOutflow(3, 100, 5, 80)).toBe(100);
    expect(averageAfterOutflow(10, 10, 9, 500)).toBe(0);
  });

  it("stock negativo cuenta como cero; sin promedio o cantidad 0 no cambia", () => {
    expect(averageAfterOutflow(-4, 100, 2, 50)).toBe(100);
    expect(averageAfterOutflow(10, null, 2, 50)).toBeNull();
    expect(averageAfterOutflow(10, 100, 0, 50)).toBe(100);
  });
});

describe("último costo al anular una recepción", () => {
  const lines = [
    { receipt_id: "r1", received_date: "2026-10-01", created_at: "2026-10-01T10:00:00Z", valued_unit_cost: 100 },
    { receipt_id: "r2", received_date: "2026-10-05", created_at: "2026-10-05T10:00:00Z", valued_unit_cost: 130 },
  ];

  it("si era la última, vuelve a la recepción vigente anterior", () => {
    expect(lastCostAfterVoid("r2", lines, 130, 90)).toBe(100);
  });

  it("si no era la última, no cambia", () => {
    expect(lastCostAfterVoid("r1", lines, 130, 90)).toBe(130);
  });

  it("si no hay otra recepción, vuelve al valor previo de la historia", () => {
    expect(lastCostAfterVoid("r2", [lines[1]!], 130, 90)).toBe(90);
    expect(lastCostAfterVoid("r2", [lines[1]!], 130, null)).toBe(130);
  });
});

describe("reglas de anulación y devolución", () => {
  it("bloqueos de la anulación", () => {
    const base = { status: "posted" as const, invoice_id: null, has_returns: false, lots_consumed: false, short_lines: [] };
    expect(receiptVoidBlockers(base)).toEqual([]);
    expect(receiptVoidBlockers({ ...base, invoice_id: "f" })).toEqual(["invoiced"]);
    expect(receiptVoidBlockers({ ...base, has_returns: true, lots_consumed: true, short_lines: ["Yerba"] })).toEqual([
      "returns",
      "lots_consumed",
      "stock_consumed",
    ]);
    expect(receiptVoidBlockers({ ...base, status: "voided", invoice_id: "f" })).toEqual(["voided"]);
  });

  it("lo que se puede devolver de una línea", () => {
    expect(returnableQty({ qty: 10, qty_returned: 3 })).toBe(7);
    expect(returnableQty({ qty: 2, qty_returned: 5 })).toBe(0);
    expect(returnableQty({ qty: 4 })).toBe(4);
  });

  it("valida cantidades contra lo recibido y el stock de la sucursal", () => {
    expect(validateReturn([{ qty: 0, unit_cost: 10 }])).toContain("Cargá al menos una cantidad para devolver.");
    expect(validateReturn([{ qty: 5, unit_cost: 10, max: 4 }])).toContain(
      "No podés devolver más de lo recibido en esa recepción.",
    );
    expect(validateReturn([{ qty: 5, unit_cost: 10, store_qty: 2 }])).toContain(
      "No hay stock suficiente en la sucursal para devolver esa cantidad.",
    );
    expect(validateReturn([{ qty: 2, unit_cost: 10, max: 4, store_qty: 9 }])).toEqual([]);
  });

  it("totales y numeración", () => {
    expect(returnTotals([{ qty: 2, unit_cost: 10.5 }, { qty: 0, unit_cost: 99 }])).toEqual({ units: 2, value: 21 });
    expect(formatReturnNumber(12)).toBe("DEV-000012");
  });
});
