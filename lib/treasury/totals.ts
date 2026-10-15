// lib/treasury/totals.ts
//
// Totales de la pestaña Cuentas de Tesorería (F22 · ADR-150). Lógica PURA.
// Sólo suman las cuentas activas en pesos: un saldo en dólares no se mezcla con
// los pesos (antes "En caja general" sumaba todas las monedas y "En bancos" se
// sacaba por diferencia, así que una caja en USD daba un banco negativo). Lo que
// está en otra moneda se informa aparte, por moneda.

import { round } from "@/lib/purchases/costs";

export interface BalanceLike {
  kind: string;
  currency: string;
  is_active: boolean;
  balance: number;
}

export interface TreasuryTotals {
  /** Disponible en pesos (cuentas activas). */
  total: number;
  /** En pesos, cuentas de banco. */
  banks: number;
  /** En pesos, caja general y fondos. */
  cash: number;
  /** Cuentas activas en otra moneda, sumadas por moneda. */
  otherCurrencies: Record<string, number>;
}

export const LOCAL_CURRENCY = "ARS";

export function treasuryTotals(balances: BalanceLike[]): TreasuryTotals {
  const out: TreasuryTotals = { total: 0, banks: 0, cash: 0, otherCurrencies: {} };
  for (const b of balances) {
    if (!b.is_active) continue;
    const amount = Number(b.balance) || 0;
    const currency = (b.currency || LOCAL_CURRENCY).toUpperCase();
    if (currency !== LOCAL_CURRENCY) {
      out.otherCurrencies[currency] = round((out.otherCurrencies[currency] ?? 0) + amount, 2);
      continue;
    }
    out.total = round(out.total + amount, 2);
    if (b.kind === "cash") out.cash = round(out.cash + amount, 2);
    else out.banks = round(out.banks + amount, 2);
  }
  return out;
}
