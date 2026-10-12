import { describe, it, expect } from "vitest";
import { agingBucket, agingTotals, daysOverdue } from "@/lib/account/aging";

// Casos espejo de account_aging() en SQL: tramos por VENCIMIENTO (no por fecha
// de cargo).
describe("daysOverdue", () => {
  it("cuenta días desde el vencimiento", () => {
    expect(daysOverdue("2026-10-10", "2026-10-10")).toBe(0);
    expect(daysOverdue("2026-10-10", "2026-10-11")).toBe(1);
    expect(daysOverdue("2026-10-10", "2026-10-01")).toBe(-9);
  });
});

describe("agingBucket", () => {
  it("ubica cada deuda por días vencidos", () => {
    const asOf = "2026-12-31";
    expect(agingBucket("2026-12-31", asOf)).toBe("current");
    expect(agingBucket("2027-01-15", asOf)).toBe("current");
    expect(agingBucket("2026-12-30", asOf)).toBe("d1_30");
    expect(agingBucket("2026-12-01", asOf)).toBe("d1_30");
    expect(agingBucket("2026-11-30", asOf)).toBe("d31_60");
    expect(agingBucket("2026-10-02", asOf)).toBe("d61_90");
    expect(agingBucket("2026-10-01", asOf)).toBe("d90_plus");
  });

  it("sin vencimiento cuenta como no vencido", () => {
    expect(agingBucket(null, "2026-12-31")).toBe("current");
  });
});

describe("agingTotals", () => {
  it("suma por tramo y separa lo vencido", () => {
    const t = agingTotals(
      [
        { due_date: "2027-01-10", open: 100 },
        { due_date: "2026-12-20", open: 50 },
        { due_date: "2026-09-01", open: 25.5 },
      ],
      "2026-12-31",
    );
    expect(t).toEqual({
      current: 100,
      d1_30: 50,
      d31_60: 0,
      d61_90: 0,
      d90_plus: 25.5,
      total: 175.5,
      overdue: 75.5,
    });
  });
});
