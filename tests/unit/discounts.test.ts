import { describe, it, expect } from "vitest";
import {
  effectiveMonthlyPrice,
  isDiscountActive,
} from "@/modules/internal/api";

type D = {
  kind: "percent" | "fixed";
  value: number;
  valid_from: string;
  valid_until: string | null;
};

const ALWAYS = { valid_from: "2000-01-01", valid_until: null };
const TODAY = new Date("2026-06-07T12:00:00Z");

describe("isDiscountActive", () => {
  it("vigente cuando from <= hoy <= until", () => {
    expect(
      isDiscountActive(
        { valid_from: "2026-06-01", valid_until: "2026-06-30" },
        TODAY,
      ),
    ).toBe(true);
  });
  it("programado (from futuro)", () => {
    expect(
      isDiscountActive(
        { valid_from: "2026-07-01", valid_until: null },
        TODAY,
      ),
    ).toBe(false);
  });
  it("vencido (until pasado)", () => {
    expect(
      isDiscountActive(
        { valid_from: "2026-01-01", valid_until: "2026-05-01" },
        TODAY,
      ),
    ).toBe(false);
  });
  it("sin fin (until null) sigue vigente", () => {
    expect(isDiscountActive({ valid_from: "2026-01-01", valid_until: null }, TODAY)).toBe(
      true,
    );
  });
});

describe("effectiveMonthlyPrice", () => {
  it("sin descuentos devuelve el precio base", () => {
    expect(effectiveMonthlyPrice(10000, [], TODAY)).toBe(10000);
  });

  it("percent se aplica sobre el precio", () => {
    const d: D[] = [{ kind: "percent", value: 10, ...ALWAYS }];
    expect(effectiveMonthlyPrice(10000, d, TODAY)).toBe(9000);
  });

  it("fixed se resta del precio", () => {
    const d: D[] = [{ kind: "fixed", value: 2500, ...ALWAYS }];
    expect(effectiveMonthlyPrice(10000, d, TODAY)).toBe(7500);
  });

  it("percent primero, luego fixed", () => {
    // 10000 -10% = 9000, luego -1000 = 8000
    const d: D[] = [
      { kind: "fixed", value: 1000, ...ALWAYS },
      { kind: "percent", value: 10, ...ALWAYS },
    ];
    expect(effectiveMonthlyPrice(10000, d, TODAY)).toBe(8000);
  });

  it("se trunca en 0 (no negativo)", () => {
    const d: D[] = [{ kind: "fixed", value: 99999, ...ALWAYS }];
    expect(effectiveMonthlyPrice(10000, d, TODAY)).toBe(0);
  });

  it("ignora descuentos no vigentes", () => {
    const d: D[] = [
      { kind: "percent", value: 50, valid_from: "2026-07-01", valid_until: null },
    ];
    expect(effectiveMonthlyPrice(10000, d, TODAY)).toBe(10000);
  });
});
