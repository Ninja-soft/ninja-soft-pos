import { describe, it, expect } from "vitest";
import { formatSaleNumber, saleMatchesQuery } from "@/lib/utils/saleNumber";

describe("formatSaleNumber", () => {
  it("sin formato devuelve el número crudo", () => {
    expect(formatSaleNumber(42, null)).toBe("42");
    expect(formatSaleNumber(42)).toBe("42");
  });
  it("aplica prefijo y padding", () => {
    expect(formatSaleNumber(42, { prefix: "NINJA-", pad: 6 })).toBe("NINJA-000042");
  });
  it("padding 0 no rellena", () => {
    expect(formatSaleNumber(7, { prefix: "A", pad: 0 })).toBe("A7");
  });
});

describe("saleMatchesQuery", () => {
  const fmt = { prefix: "NINJA-", pad: 6 };
  it("query vacía matchea todo", () => {
    expect(saleMatchesQuery(42, fmt, "")).toBe(true);
  });
  it("matchea por número formateado (con o sin prefijo)", () => {
    expect(saleMatchesQuery(42, fmt, "ninja-000042")).toBe(true);
    expect(saleMatchesQuery(42, fmt, "000042")).toBe(true);
  });
  it("matchea por correlativo crudo ignorando ceros a la izquierda", () => {
    expect(saleMatchesQuery(42, fmt, "42")).toBe(true);
    expect(saleMatchesQuery(42, fmt, "0042")).toBe(true);
  });
  it("no matchea otro número", () => {
    expect(saleMatchesQuery(42, fmt, "99")).toBe(false);
  });
});
