import { describe, it, expect } from "vitest";
import { remainingCharges, type AccountMovement } from "@/modules/customers/api";

const DAY = 86_400_000;

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY).toISOString();
}

describe("remainingCharges (FIFO)", () => {
  it("un pago cancela los cargos más viejos primero", () => {
    const movs: AccountMovement[] = [
      { delta: 100, created_at: iso(10), due_date: null },
      { delta: 50, created_at: iso(5), due_date: null },
      { delta: -120, created_at: iso(1), due_date: null },
    ];
    const rem = remainingCharges(movs);
    // 120 cancela los 100 del cargo viejo + 20 del nuevo → queda 30 del nuevo.
    expect(rem).toHaveLength(1);
    expect(rem[0]!.amount).toBeCloseTo(30, 6);
  });

  it("cargo totalmente pagado → sin remanente", () => {
    const movs: AccountMovement[] = [
      { delta: 200, created_at: iso(3), due_date: null },
      { delta: -200, created_at: iso(1), due_date: null },
    ];
    expect(remainingCharges(movs)).toHaveLength(0);
  });

  it("ordena por fecha aunque los movimientos lleguen desordenados", () => {
    const movs: AccountMovement[] = [
      { delta: -40, created_at: iso(1), due_date: null },
      { delta: 40, created_at: iso(10), due_date: null },
      { delta: 60, created_at: iso(5), due_date: null },
    ];
    const rem = remainingCharges(movs);
    // El pago cancela el cargo de 40 (más viejo); queda el de 60.
    expect(rem).toHaveLength(1);
    expect(rem[0]!.amount).toBeCloseTo(60, 6);
  });

  it("sin due_date asume vencimiento = fecha + 30 días", () => {
    const created = iso(40); // hace 40 días → venció hace 10
    const rem = remainingCharges([
      { delta: 100, created_at: created, due_date: null },
    ]);
    expect(rem).toHaveLength(1);
    const expectedDue = new Date(created).getTime() + 30 * DAY;
    expect(rem[0]!.due).toBeCloseTo(expectedDue, -2);
    // y está vencido respecto de hoy
    expect(rem[0]!.due).toBeLessThan(Date.now());
  });

  it("usa el due_date explícito cuando viene cargado", () => {
    const rem = remainingCharges([
      { delta: 100, created_at: iso(2), due_date: "2030-01-15" },
    ]);
    expect(rem).toHaveLength(1);
    expect(rem[0]!.due).toBe(new Date("2030-01-15T00:00:00").getTime());
  });

  it("cómputo de vencido: solo cuenta cargos cuyo due < hoy", () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const movs: AccountMovement[] = [
      { delta: 100, created_at: iso(40), due_date: null }, // vencido (fecha+30 < hoy)
      { delta: 80, created_at: iso(2), due_date: null }, // al día
    ];
    const rem = remainingCharges(movs);
    const overdue = rem
      .filter((c) => c.due < today.getTime())
      .reduce((a, c) => a + c.amount, 0);
    expect(overdue).toBeCloseTo(100, 6);
  });
});
