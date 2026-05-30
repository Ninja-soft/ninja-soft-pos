import { describe, it, expect } from "vitest";
import { formatQty, formatCurrency } from "@/lib/utils/format";

describe("formatQty", () => {
  it("enteros sin decimales", () => {
    expect(formatQty(5)).toBe("5");
    expect(formatQty(0)).toBe("0");
  });
  it("fracciones sin ceros sobrantes", () => {
    expect(formatQty(2.5)).toBe("2.5");
  });
  it("null → 0", () => {
    expect(formatQty(null)).toBe("0");
  });
});

describe("formatCurrency", () => {
  it("devuelve string con símbolo de moneda", () => {
    const out = formatCurrency(1000);
    expect(typeof out).toBe("string");
    expect(out).toContain("$");
  });
});
