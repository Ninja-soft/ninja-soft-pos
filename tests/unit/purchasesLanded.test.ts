import { describe, expect, it } from "vitest";
import {
  allocate,
  computeLandedCost,
  emptyLandedSheet,
  isValidDispatchNumber,
  normalizeDispatchNumber,
  type LandedSheet,
} from "@/lib/purchases/landed";

describe("allocate (prorrateo en centavos exactos)", () => {
  it("la suma de las partes es exactamente el total", () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts).toEqual([33.34, 33.33, 33.33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
  });

  it("reparte proporcional a los pesos", () => {
    expect(allocate(300, [1, 2])).toEqual([100, 200]);
  });

  it("sin pesos reparte en partes iguales", () => {
    expect(allocate(10, [0, 0])).toEqual([5, 5]);
  });

  it("lista vacía", () => {
    expect(allocate(10, [])).toEqual([]);
  });
});

describe("costeo de importación", () => {
  // Carpeta del criterio H102: 3 productos, flete por peso, seguro por valor.
  const lines = [
    { id: "a", qty: 100, fob_unit: 10, weight_kg: 50 }, // FOB 1000
    { id: "b", qty: 50, fob_unit: 40, weight_kg: 150 }, // FOB 2000
    { id: "c", qty: 10, fob_unit: 100, weight_kg: 0, duty_pct: 0 }, // FOB 1000, exento de derechos
  ];
  const sheet: LandedSheet = {
    ...emptyLandedSheet("USD", 1000),
    freight: { amount: 400, prorate: "weight" },
    insurance: { amount: 40, prorate: "value" },
    duty_pct: 20,
    statistics_pct: 3,
    expenses: [
      { description: "Despachante", amount_ars: 300_000, prorate: "value" },
      { description: "Flete interno", amount_ars: 40_000, prorate: "qty" },
    ],
  };

  const r = computeLandedCost(sheet, lines);

  it("FOB + flete por peso + seguro por valor = CIF", () => {
    expect(r.lines.map((l) => l.fob)).toEqual([1000, 2000, 1000]);
    expect(r.lines.map((l) => l.freight)).toEqual([100, 300, 0]);
    expect(r.lines.map((l) => l.insurance)).toEqual([10, 20, 10]);
    expect(r.lines.map((l) => l.cif)).toEqual([1110, 2320, 1010]);
    expect(r.totals.cif).toBe(4440);
    expect(r.totals.cif_ars).toBe(4_440_000);
  });

  it("derechos por línea (la c exenta) y tasa de estadística sobre CIF", () => {
    expect(r.lines.map((l) => l.duty)).toEqual([222_000, 464_000, 0]);
    expect(r.totals.statistics).toBe(133_200);
    expect(r.lines.map((l) => l.statistics)).toEqual([33_300, 69_600, 30_300]);
  });

  it("gastos en pesos con su propia base y costo unitario puesto en depósito", () => {
    // Despachante por valor (1:2:1), flete interno por cantidad (100:50:10)
    expect(r.lines.map((l) => l.expenses)).toEqual([75_000 + 25_000, 150_000 + 12_500, 75_000 + 2_500]);
    const a = r.lines[0]!;
    expect(a.landed_total).toBe(1_110_000 + 222_000 + 33_300 + 100_000);
    expect(a.landed_unit).toBe(14_653);
    expect(r.totals.landed).toBe(
      r.lines.reduce((t, l) => t + l.landed_total, 0),
    );
  });

  it("el crédito fiscal se calcula aparte y no entra al costo", () => {
    const base = 4_440_000 + 686_000 + 133_200;
    expect(r.totals.vat_base).toBe(base);
    expect(r.totals.credit_taxes[0]).toEqual({ description: "IVA importación", pct: 21, amount: 1_104_432 });
    expect(r.totals.landed).toBe(4_440_000 + 686_000 + 133_200 + 340_000);
  });

  it("tope de la tasa de estadística", () => {
    const capped = computeLandedCost({ ...sheet, statistics_cap_ars: 100_000 }, lines);
    expect(capped.totals.statistics).toBe(100_000);
  });

  it("avisa si falta el peso y reparte en partes iguales", () => {
    const noWeight = computeLandedCost(sheet, lines.map((l) => ({ ...l, weight_kg: 0 })));
    expect(noWeight.warnings.join(" ")).toMatch(/Flete/);
    expect(noWeight.lines.map((l) => l.freight)).toEqual([133.34, 133.33, 133.33]);
  });

  it("ignora líneas sin cantidad y avisa sin tipo de cambio", () => {
    const x = computeLandedCost({ ...sheet, fx_rate: 0 }, [{ id: "z", qty: 0, fob_unit: 1 }]);
    expect(x.lines).toEqual([]);
    expect(x.warnings.length).toBeGreaterThan(0);
  });
});

describe("n° de despacho", () => {
  it("normaliza y valida la forma AAaaaTTTTnnnnnnX", () => {
    expect(normalizeDispatchNumber("24 001 ic04 123456 k")).toBe("24001IC04123456K");
    expect(isValidDispatchNumber("24001IC04123456K")).toBe(true);
    expect(isValidDispatchNumber("24001IC04123456")).toBe(false);
    expect(isValidDispatchNumber("")).toBe(false);
  });
});
