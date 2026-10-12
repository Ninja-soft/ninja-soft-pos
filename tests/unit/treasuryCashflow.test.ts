import { describe, expect, it } from "vitest";
import { buildCashFlow, firstShortfall, periods, weekStart } from "@/lib/treasury/cashflow";

describe("flujo de fondos proyectado", () => {
  it("períodos por semana arrancan el lunes", () => {
    expect(weekStart("2026-10-14")).toBe("2026-10-12");
    expect(periods("2026-10-14", "2026-10-30", "week")).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(periods("2026-11-20", "2027-01-05", "month")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
  });

  it("saldo acumulado con cobros, cheques y pagos; lo vencido cae en el primer período", () => {
    const rows = buildCashFlow({
      startBalance: 1000,
      from: "2026-10-12",
      to: "2026-10-25",
      granularity: "week",
      receivables: [
        { date: "2026-10-01", amount: 200 },
        { date: "2026-10-20", amount: 300 },
      ],
      chequesIn: [{ date: "2026-10-13", amount: 100 }],
      payables: [
        { date: "2026-09-30", amount: 900 },
        { date: "2026-10-21", amount: 1000 },
        { date: "2026-12-01", amount: 5000 },
      ],
      chequesOut: [{ date: "2026-10-22", amount: 50 }],
    });
    expect(rows.map((r) => [r.key, r.net, r.balance])).toEqual([
      ["2026-10-12", -600, 400],
      ["2026-10-19", -750, -350],
    ]);
    expect(firstShortfall(rows)?.key).toBe("2026-10-19");
  });

  it("sin faltante devuelve null", () => {
    const rows = buildCashFlow({
      startBalance: 10,
      from: "2026-10-12",
      to: "2026-10-13",
      granularity: "day",
      receivables: [],
      chequesIn: [],
      payables: [],
      chequesOut: [],
    });
    expect(rows).toHaveLength(2);
    expect(firstShortfall(rows)).toBeNull();
  });
});
