import { describe, it, expect } from "vitest";
import { summarize, type CashMovement } from "@/modules/cash/api";

function mv(p: Partial<CashMovement>): CashMovement {
  return {
    id: Math.random().toString(),
    tenant_id: "t",
    cash_shift_id: "s",
    type: "sale",
    amount: 0,
    payment_method: null,
    reason: null,
    reference_id: null,
    created_at: "2026-01-01",
    created_by: null,
    ...p,
  };
}

describe("summarize (arqueo)", () => {
  it("calcula efectivo esperado y ventas netas", () => {
    const movements = [
      mv({ type: "sale", amount: 1000, payment_method: "cash" }),
      mv({ type: "sale", amount: 500, payment_method: "debit" }),
      mv({ type: "income", amount: 200 }),
      mv({ type: "expense", amount: 300 }),
      mv({ type: "sale_void", amount: 1000, payment_method: "cash" }),
    ];
    const s = summarize(5000, movements);
    // ventas netas = 1000 + 500 - 1000 = 500
    expect(s.salesTotal).toBe(500);
    // efectivo esperado = 5000 + 200 - 300 + (1000 cash) - (1000 void cash) = 4900
    expect(s.cashExpected).toBe(4900);
    expect(s.byMethod.cash).toBe(0);
    expect(s.byMethod.debit).toBe(500);
  });
});
