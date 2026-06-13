import { describe, it, expect } from "vitest";
import {
  lineCost,
  recipeCost,
  marginAmount,
  marginPct,
} from "@/modules/products/recipes";

// F13 · H50 — el escandallo calcula el costo del plato (suma de qty*unit_cost) y
// el margen contra el precio de venta. Helpers puros: estos tests fijan el
// contrato (incluyendo el caso de vender por debajo del costo y precio 0).

describe("lineCost", () => {
  it("multiplica cantidad por costo unitario", () => {
    expect(lineCost(0.2, 4500)).toBe(900);
    expect(lineCost(3, 100)).toBe(300);
  });
  it("nunca es negativo y trata valores inválidos como 0", () => {
    expect(lineCost(-1, 100)).toBe(0);
    expect(lineCost(NaN, 100)).toBe(0);
    expect(lineCost(2, NaN)).toBe(0);
  });
});

describe("recipeCost", () => {
  it("suma el costo de todas las líneas", () => {
    expect(
      recipeCost([
        { qty: 0.2, unit_cost: 4500 }, // 900
        { qty: 1, unit_cost: 350 }, // 350
        { qty: 2, unit_cost: 50 }, // 100
      ]),
    ).toBe(1350);
  });
  it("una receta vacía cuesta 0", () => {
    expect(recipeCost([])).toBe(0);
  });
});

describe("marginAmount", () => {
  it("es precio menos costo", () => {
    expect(marginAmount(5000, 1350)).toBe(3650);
  });
  it("es negativo si se vende por debajo del costo", () => {
    expect(marginAmount(1000, 1350)).toBe(-350);
  });
});

describe("marginPct", () => {
  it("es (precio - costo) / precio * 100", () => {
    expect(marginPct(5000, 1350)).toBeCloseTo(73, 0);
    expect(marginPct(2000, 500)).toBe(75);
  });
  it("devuelve null si el precio es 0 o negativo", () => {
    expect(marginPct(0, 100)).toBeNull();
    expect(marginPct(-5, 100)).toBeNull();
  });
  it("puede ser negativo si el costo supera el precio", () => {
    expect(marginPct(1000, 1500)).toBe(-50);
  });
});
