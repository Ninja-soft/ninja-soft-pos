// F21 · ADR-121: el ejemplo del simulador (y de la spec §20) da los números
// documentados, y cualquier combinación cierra exacto al centavo.
import { describe, expect, it } from "vitest";
import { buildSimulation } from "@/components/internal/staff-payouts/SimulatorTab";
import { checkInvariant, computeSettlement } from "@/supabase/functions/_shared/staff/settlement";

const EXAMPLE = {
  persons: [
    { name: "Juan", pct: "40", expPct: "" },
    { name: "Ana", pct: "30", expPct: "" },
  ],
  clients: [
    { name: "Kiosco Centro", amount: "600000", bonusPerson: "", bonusPct: "" },
    { name: "Cliente Z", amount: "400000", bonusPerson: "1", bonusPct: "10" },
  ],
  fees: "40000",
  refunds: "0",
  fx: "1450",
  reserve: "0",
  houseAbsorbs: true,
  expenses: [
    { name: "Servidor", amount: "25", currency: "USD" as const, annual: false, allocation: "single" as const, person: "1", exempt: "" },
    { name: "Dominio anual", amount: "120000", currency: "ARS" as const, annual: true, allocation: "proportional" as const, person: "0", exempt: "0" },
  ],
};

describe("simulador: ejemplo de la spec §20", () => {
  const r = computeSettlement(buildSimulation(EXAMPLE));
  const juan = r.lines.find((l) => l.name === "Juan")!;
  const ana = r.lines.find((l) => l.name === "Ana")!;

  it("base: $1.000.000 cobrado − $40.000 de comisiones = $960.000", () => {
    expect(r.base.gross_cents).toBe(100_000_000);
    expect(r.base.fees_cents).toBe(4_000_000);
    expect(r.base.net_cents).toBe(96_000_000);
  });

  it("gastos: servidor USD 25 × 1.450 a Ana y la cuota del dominio sin Juan", () => {
    expect(r.expenses_cents).toBe(3_625_000 + 1_000_000);
    expect(r.to_share_cents).toBe(91_375_000);
  });

  it("Juan 40 % en todo; Ana 30 % + 10 % en Cliente Z, absorbe el servidor y medio dominio", () => {
    expect(juan.income_cents).toBe(23_040_000 + 15_360_000);
    expect(juan.expense_cents).toBe(0);
    expect(juan.net_cents).toBe(38_400_000);
    expect(ana.income_cents).toBe(17_280_000 + 15_360_000);
    expect(ana.expense_cents).toBe(3_625_000 + 500_000);
    expect(ana.net_cents).toBe(28_515_000);
    expect(r.house.net_cents).toBe(24_460_000);
    expect(checkInvariant(r)).toBe(true);
  });

  it("con reintegros, reserva y la casa sin absorber gastos sigue cerrando exacto", () => {
    const r2 = computeSettlement(buildSimulation({ ...EXAMPLE, refunds: "33333,33", reserve: "3,5", houseAbsorbs: false }));
    expect(checkInvariant(r2)).toBe(true);
    expect(r2.house.expense_cents).toBe(0);
  });
});
