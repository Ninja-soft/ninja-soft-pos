import { describe, it, expect } from "vitest";
import {
  addDays,
  addMonthsClamped,
  dueDateFor,
  installmentSchedule,
} from "@/lib/account/terms";

// Casos espejo de payment_account_charge / account_due_date() en SQL
// (supabase/migrations/20261011200100_cuenta_corriente_v2_rpc.sql).

describe("helpers de fecha (ISO yyyy-mm-dd, sin zona horaria)", () => {
  it("addDays cruza meses y años", () => {
    expect(addDays("2026-01-30", 3)).toBe("2026-02-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("addMonthsClamped recorta al último día del mes", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-11-15", 2)).toBe("2027-01-15");
  });
});

describe("dueDateFor", () => {
  it("modo días: fecha + días", () => {
    expect(dueDateFor("2026-10-11", { mode: "days", days: 30, cutoff_day: 25, due_day: 10 })).toBe(
      "2026-11-10",
    );
    expect(dueDateFor("2026-10-11", { mode: "days", days: 0, cutoff_day: 25, due_day: 10 })).toBe(
      "2026-10-11",
    );
  });

  it("corte mensual: hasta el corte vence el día X del mes siguiente", () => {
    const t = { mode: "monthly_cutoff" as const, days: 30, cutoff_day: 25, due_day: 10 };
    expect(dueDateFor("2026-10-01", t)).toBe("2026-11-10");
    expect(dueDateFor("2026-10-25", t)).toBe("2026-11-10");
  });

  it("corte mensual: después del corte vence al otro mes", () => {
    const t = { mode: "monthly_cutoff" as const, days: 30, cutoff_day: 25, due_day: 10 };
    expect(dueDateFor("2026-10-26", t)).toBe("2026-12-10");
    expect(dueDateFor("2026-12-31", t)).toBe("2027-02-10");
  });

  it("corte mensual: el día de vencimiento se recorta al fin de mes", () => {
    const t = { mode: "monthly_cutoff" as const, days: 30, cutoff_day: 31, due_day: 31 };
    expect(dueDateFor("2026-01-15", t)).toBe("2026-02-28");
  });
});

describe("installmentSchedule", () => {
  it("una cuota = un cargo con el vencimiento base", () => {
    expect(installmentSchedule(1000, 1, "2026-11-10", { mode: "days", interval_days: 30 })).toEqual([
      { installment_no: 1, amount: 1000, due_date: "2026-11-10" },
    ]);
  });

  it("reparte en centavos y el resto va a la última cuota", () => {
    const s = installmentSchedule(100, 3, "2026-11-10", { mode: "days", interval_days: 30 });
    expect(s.map((x) => x.amount)).toEqual([33.33, 33.33, 33.34]);
    expect(s.map((x) => x.due_date)).toEqual(["2026-11-10", "2026-12-10", "2027-01-09"]);
    expect(s.reduce((a, x) => a + x.amount, 0)).toBeCloseTo(100, 6);
  });

  it("con corte mensual las cuotas vencen mes a mes el mismo día", () => {
    const s = installmentSchedule(300, 3, "2026-11-10", { mode: "monthly_cutoff", interval_days: 30 });
    expect(s.map((x) => x.due_date)).toEqual(["2026-11-10", "2026-12-10", "2027-01-10"]);
  });

  it("rechaza cantidades inválidas", () => {
    expect(() => installmentSchedule(100, 0, "2026-11-10", { mode: "days", interval_days: 30 })).toThrow();
  });
});
