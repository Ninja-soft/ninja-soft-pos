import { describe, expect, it } from "vitest";
import {
  describeLimit,
  diffOverrides,
  effectiveLimit,
  parseOverride,
  usagePercent,
  usageTone,
  type LimitRowInput,
} from "@/lib/internal/planLimits";

const rows: LimitRowInput[] = [
  { key: "max_users", plan_value: 5, override: null, usage: 4 },
  { key: "max_products", plan_value: null, override: 50, usage: 10 },
  { key: "max_stores", plan_value: 1, override: null, usage: 1 },
];

describe("límites del plan", () => {
  it("efectivo = override ?? plan; null = sin límite", () => {
    expect(effectiveLimit(rows[0]!)).toBe(5);
    expect(effectiveLimit(rows[1]!)).toBe(50);
    expect(effectiveLimit({ plan_value: null, override: null })).toBeNull();
  });

  it("semáforo de uso", () => {
    expect(usageTone(4, 5)).toBe("near");
    expect(usageTone(1, 1)).toBe("over");
    expect(usageTone(2, 10)).toBe("ok");
    expect(usageTone(999, null)).toBe("unlimited");
    expect(usageTone(0, 0)).toBe("near");
    expect(usagePercent(4, 5)).toBe(80);
    expect(usagePercent(9, 5)).toBe(100);
    expect(usagePercent(3, null)).toBe(0);
  });

  it("parseOverride: vacío quita, enteros desde 0, el resto inválido", () => {
    expect(parseOverride("")).toBeNull();
    expect(parseOverride(" 12 ")).toBe(12);
    expect(parseOverride("0")).toBe(0);
    expect(parseOverride("-1")).toBeUndefined();
    expect(parseOverride("1.5")).toBeUndefined();
  });

  it("diffOverrides arma el payload sólo con lo que cambió", () => {
    const d = diffOverrides(rows, { max_users: "10", max_products: "", max_stores: "1x" });
    expect(d.payload).toEqual({ max_users: 10, max_products: null });
    expect(d.changes).toEqual([
      { key: "max_users", from: null, to: 10 },
      { key: "max_products", from: 50, to: null },
    ]);
    expect(d.invalid).toEqual(["max_stores"]);
    expect(diffOverrides(rows, { max_products: "50" }).changes).toHaveLength(0);
  });

  it("describeLimit para la confirmación", () => {
    expect(describeLimit(null, null)).toBe("Lo del plan (sin límite)");
    expect(describeLimit(null, 5)).toBe("Lo del plan (5)");
    expect(describeLimit(1500, 5)).toBe("1.500");
  });
});
