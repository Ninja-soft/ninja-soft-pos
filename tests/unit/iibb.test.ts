import { describe, expect, it } from "vitest";
import { applyCoefficient, computeIibb, iibbSheetRows, IIBB_WARNING_TEXT, type IibbPreview } from "@/lib/tax/iibb";
import { IIBB_CASES } from "../fixtures/iibbMatrix";

describe("computeIibb · matriz compartida con _iibb_math (SQL)", () => {
  for (const c of IIBB_CASES) {
    it(c.name, () => {
      const r = computeIibb(c.input);
      expect(r.activities.map((a) => a.tax)).toEqual(c.expect.taxes);
      expect(r.activities.map((a) => a.base)).toEqual(c.expect.bases);
      expect(r.activities.map((a) => a.minimum_applied)).toEqual(c.expect.minimum);
      expect(r.base_total).toBe(c.expect.base_total);
      expect(r.determined).toBe(c.expect.determined);
      expect(r.deductions_total).toBe(c.expect.deductions_total);
      expect(r.available).toBe(c.expect.available);
      expect(r.used).toBe(c.expect.used);
      expect(r.to_pay).toBe(c.expect.to_pay);
      expect(r.credit_next).toBe(c.expect.credit_next);
    });
  }
});

describe("computeIibb · invariantes", () => {
  it("saldo a pagar y saldo a favor nunca son los dos positivos", () => {
    for (const c of IIBB_CASES) {
      const r = computeIibb(c.input);
      expect(r.to_pay > 0 && r.credit_next > 0).toBe(false);
      expect(r.to_pay).toBeCloseTo(r.determined - r.used, 2);
      expect(r.credit_next).toBeCloseTo(r.available - r.used, 2);
    }
  });

  it("deducciones negativas se ignoran", () => {
    const r = computeIibb({
      activities: [{ key: "a", base_raw: 1000, rate: 3, min_tax: 0 }],
      coefficient: null,
      deductions: { retencion: -50, percepcion: 0, sircreb: 0, sirtac: 0 },
      previous_credit: -10,
    });
    expect(r.deductions_total).toBe(0);
    expect(r.previous_credit).toBe(0);
    expect(r.to_pay).toBe(30);
  });

  it("sin actividades no hay impuesto y el saldo pasa entero", () => {
    const r = computeIibb({
      activities: [],
      coefficient: null,
      deductions: { retencion: 10, percepcion: 0, sircreb: 0, sirtac: 0 },
      previous_credit: 5,
    });
    expect(r.determined).toBe(0);
    expect(r.credit_next).toBe(15);
  });
});

describe("applyCoefficient", () => {
  it("redondea mitad hacia arriba y respeta el signo", () => {
    expect(applyCoefficient(1000, 0.5)).toBe(500);
    expect(applyCoefficient(0.01, 0.5)).toBe(0.01); // 0,005 → 0,01
    expect(applyCoefficient(-0.01, 0.5)).toBe(-0.01);
    expect(applyCoefficient(1234567.89, 0.354321)).toBe(437433.33);
    expect(applyCoefficient(100, 0)).toBe(0);
  });
});

describe("iibbSheetRows y avisos", () => {
  it("arma las filas de la planilla", () => {
    const p: IibbPreview = {
      jurisdiction: "902",
      period: "2026-09-01",
      regime: "local",
      coefficient: null,
      activities: [
        { id: "x", code: "477000", name: "Comercio", rate: 3.5, min_tax: 0, sales: 1000, voids: 0, returns: 0, base_raw: 1000, base: 1000, tax: 35, minimum_applied: false },
      ],
      base_total: 1000,
      determined: 35,
      deductions: { retencion: 10, percepcion: 5, sircreb: 0, sirtac: 0, compras: 5 },
      deductions_total: 15,
      previous_credit: 0,
      previous_liquidation_id: null,
      previous_period: null,
      opening_credit: null,
      available: 15,
      used: 15,
      to_pay: 20,
      credit_next: 0,
      entries: 1,
      purchase_perceptions: 1,
      sales_count: 1,
      sales_without_breakdown: 0,
      warnings: [],
    };
    const rows = iibbSheetRows(p);
    expect(rows[0]).toMatchObject({ concepto: "477000 · Comercio", importe: 35 });
    expect(rows.find((r) => r.concepto === "Saldo a pagar")?.importe).toBe(20);
    expect(rows.find((r) => r.concepto === "Retenciones sufridas")?.importe).toBe(-10);
  });

  it("todos los avisos del servidor tienen texto", () => {
    for (const k of [
      "monotributo",
      "no_activity_match",
      "negative_base",
      "legacy_sales",
      "gap",
      "opening_ignored",
      "cm_without_coefficient",
      "review_pending",
      "current_month",
    ]) {
      expect(IIBB_WARNING_TEXT[k]).toBeTruthy();
      expect(IIBB_WARNING_TEXT[k]).not.toContain("—");
    }
  });
});
