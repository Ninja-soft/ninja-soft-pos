import { describe, it, expect } from "vitest";
import { isPlanActive } from "@/modules/pos/api";

// Vigencia de planes de financiación (H27). Espeja isDiscountActive: un plan se
// ofrece al cobrar sólo si valid_from <= hoy <= (valid_until ?? ∞), con fechas de
// calendario locales del negocio. Mismos casos que tests/unit/discounts.test.ts.
const TODAY = new Date("2026-06-08T12:00:00Z");

describe("isPlanActive", () => {
  it("sin límites (null/null) está siempre vigente", () => {
    expect(isPlanActive({ valid_from: null, valid_until: null }, TODAY)).toBe(true);
  });
  it("vigente cuando from <= hoy <= until", () => {
    expect(
      isPlanActive({ valid_from: "2026-06-01", valid_until: "2026-06-30" }, TODAY),
    ).toBe(true);
  });
  it("programado a futuro (from futuro) no se ofrece", () => {
    expect(
      isPlanActive({ valid_from: "2026-07-01", valid_until: null }, TODAY),
    ).toBe(false);
  });
  it("vencido (until pasado) no se ofrece", () => {
    expect(
      isPlanActive({ valid_from: "2026-01-01", valid_until: "2026-05-01" }, TODAY),
    ).toBe(false);
  });
  it("límite inferior inclusivo (from == hoy)", () => {
    expect(isPlanActive({ valid_from: "2026-06-08", valid_until: null }, TODAY)).toBe(true);
  });
  it("límite superior inclusivo (until == hoy)", () => {
    expect(isPlanActive({ valid_from: null, valid_until: "2026-06-08" }, TODAY)).toBe(true);
  });
  it("sólo from, sin until, ya empezado → vigente", () => {
    expect(isPlanActive({ valid_from: "2026-01-01", valid_until: null }, TODAY)).toBe(true);
  });
});
