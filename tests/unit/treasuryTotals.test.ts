import { describe, expect, it } from "vitest";
import { treasuryTotals } from "@/lib/treasury/totals";

const b = (kind: string, currency: string, balance: number, is_active = true) => ({ kind, currency, balance, is_active });

describe("treasuryTotals", () => {
  it("no mezcla monedas: una caja en dólares no resta al banco en pesos", () => {
    const t = treasuryTotals([b("bank", "ARS", 1000), b("cash", "ARS", 300), b("cash", "USD", 500)]);
    expect(t).toEqual({
      total: 1300,
      banks: 1000,
      cash: 300,
      wallets: 0,
      posCash: 0,
      receivable: 0,
      otherCurrencies: { USD: 500 },
    });
  });

  it("deja afuera las cuentas inactivas, igual que el flujo de fondos", () => {
    const t = treasuryTotals([b("bank", "ARS", 1000), b("bank", "ARS", 9999, false)]);
    expect(t.total).toBe(1000);
    expect(t.banks).toBe(1000);
  });

  it("redondea a centavos y acepta saldos negativos", () => {
    const t = treasuryTotals([b("bank", "ARS", 0.1), b("bank", "ARS", 0.2), b("cash", "ARS", -50)]);
    expect(t.total).toBe(-49.7);
    expect(t.banks).toBe(0.3);
    expect(t.cash).toBe(-50);
  });

  it("billeteras y cajas del POS suman al disponible; lo a acreditar va aparte", () => {
    const t = treasuryTotals([
      b("wallet", "ARS", 200),
      b("pos_cash", "ARS", 150),
      b("receivable", "ARS", 999),
      b("bank", "ARS", 100),
    ]);
    expect(t.total).toBe(450);
    expect(t.wallets).toBe(200);
    expect(t.posCash).toBe(150);
    expect(t.receivable).toBe(999);
    expect(t.banks).toBe(100);
  });
});
