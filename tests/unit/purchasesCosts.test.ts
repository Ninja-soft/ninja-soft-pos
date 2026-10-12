import { describe, expect, it } from "vitest";
import {
  basisCost,
  costingAdjustedAverage,
  marginCost,
  marginOnPricePct,
  markupPct,
  priceForMarkup,
  productCosts,
  replacementFromSupplier,
  weightedAverageCost,
} from "@/lib/purchases/costs";

describe("costo promedio ponderado móvil", () => {
  it("promedia la compra con el stock existente", () => {
    // 10 u a $100 + 30 u a $140 = (1000 + 4200) / 40 = 130
    expect(weightedAverageCost(10, 100, 30, 140)).toBe(130);
  });

  it("sin promedio previo o sin stock, el promedio es el costo de la compra", () => {
    expect(weightedAverageCost(0, 100, 5, 80)).toBe(80);
    expect(weightedAverageCost(10, null, 5, 80)).toBe(80);
  });

  it("el stock negativo cuenta como cero", () => {
    expect(weightedAverageCost(-4, 100, 10, 120)).toBe(120);
  });

  it("cantidad cero no cambia el promedio", () => {
    expect(weightedAverageCost(10, 100, 0, 999)).toBe(100);
    expect(weightedAverageCost(10, null, 0, 999)).toBeNull();
  });

  it("redondea a 4 decimales y encadena compras sucesivas", () => {
    const a = weightedAverageCost(3, 10, 1, 11)!; // 10.25
    expect(a).toBe(10.25);
    const b = weightedAverageCost(4, a, 2, 13)!; // (41 + 26) / 6 = 11.1667
    expect(b).toBe(11.1667);
  });
});

describe("ajuste del promedio por costeo de importación", () => {
  it("reparte la diferencia sobre el stock actual", () => {
    // promedio 100, 50 u en stock, el costeo suma $500 → +10 por unidad
    expect(costingAdjustedAverage(100, 50, 500)).toBe(110);
  });

  it("sin stock no cambia y nunca queda negativo", () => {
    expect(costingAdjustedAverage(100, 0, 500)).toBe(100);
    expect(costingAdjustedAverage(10, 1, -50)).toBe(0);
    expect(costingAdjustedAverage(null, 10, 50)).toBeNull();
  });
});

describe("base de costo y margen", () => {
  const c = { cost: 90, last_cost: 100, avg_cost: 95, replacement_cost: 120 };

  it("toma el costo de la base elegida con el mismo fallback que el SQL", () => {
    expect(basisCost("last", c)).toBe(100);
    expect(basisCost("average", c)).toBe(95);
    expect(basisCost("replacement", c)).toBe(120);
    expect(basisCost("replacement", { ...c, replacement_cost: null })).toBe(100);
    expect(basisCost("average", { ...c, avg_cost: null })).toBe(100);
    expect(basisCost("last", { last_cost: null, avg_cost: 95, replacement_cost: null })).toBe(95);
  });

  it("si la base no tiene dato, el margen usa el costo cargado", () => {
    expect(marginCost("last", { cost: 90, last_cost: null, avg_cost: null, replacement_cost: null })).toBe(90);
  });

  it("markup sobre costo y margen sobre precio", () => {
    expect(markupPct(150, 100)).toBe(50);
    expect(marginOnPricePct(150, 100)).toBe(33.3);
    expect(markupPct(150, 0)).toBeNull();
    expect(marginOnPricePct(0, 100)).toBeNull();
    expect(priceForMarkup(100, 60)).toBe(160);
  });

  it("lee los costos de una fila sin tipos", () => {
    expect(productCosts({ cost: "10.5", last_cost: null, avg_cost: "", replacement_cost: 12 })).toEqual({
      cost: 10.5,
      last_cost: null,
      avg_cost: null,
      replacement_cost: 12,
    });
  });

  it("reposición desde la lista del proveedor en USD por caja de 12", () => {
    expect(replacementFromSupplier(24, "USD", 1000, 12)).toBe(2000);
    expect(replacementFromSupplier(500, "ARS", 1000)).toBe(500);
  });
});
