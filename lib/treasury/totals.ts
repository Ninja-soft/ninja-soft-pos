// lib/treasury/totals.ts
//
// Totales de Tesorería (F22 · ADR-150, F23 · ADR-158). Lógica PURA.
// Sólo suman las cuentas activas en pesos: un saldo en dólares no se mezcla con
// los pesos (antes "En caja general" sumaba todas las monedas y "En bancos" se
// sacaba por diferencia, así que una caja en USD daba un banco negativo). Lo que
// está en otra moneda se informa aparte, por moneda.
//
// Tipos de cuenta (ADR-158): caja general (cash), banco (bank), caja del POS
// (pos_cash), billetera (wallet) y a acreditar (receivable). Lo "a acreditar"
// todavía no es plata disponible: va aparte y no suma al total.

import { round } from "@/lib/purchases/costs";

export interface BalanceLike {
  kind: string;
  currency: string;
  is_active: boolean;
  balance: number;
}

export interface TreasuryTotals {
  /** Disponible en pesos (cuentas activas, sin lo a acreditar). */
  total: number;
  /** En pesos, cuentas de banco. */
  banks: number;
  /** En pesos, caja general y fondos. */
  cash: number;
  /** En pesos, billeteras (Mercado Pago, Ualá Bis...). */
  wallets: number;
  /** En pesos, cajas del POS (turno abierto o último contado). */
  posCash: number;
  /** En pesos, cobrado que el procesador todavía no acreditó (estimado). */
  receivable: number;
  /** Cuentas activas en otra moneda, sumadas por moneda. */
  otherCurrencies: Record<string, number>;
}

export const LOCAL_CURRENCY = "ARS";

export function treasuryTotals(balances: BalanceLike[]): TreasuryTotals {
  const out: TreasuryTotals = { total: 0, banks: 0, cash: 0, wallets: 0, posCash: 0, receivable: 0, otherCurrencies: {} };
  for (const b of balances) {
    if (!b.is_active) continue;
    const amount = Number(b.balance) || 0;
    const currency = (b.currency || LOCAL_CURRENCY).toUpperCase();
    if (b.kind === "receivable") {
      if (currency === LOCAL_CURRENCY) out.receivable = round(out.receivable + amount, 2);
      continue;
    }
    if (currency !== LOCAL_CURRENCY) {
      out.otherCurrencies[currency] = round((out.otherCurrencies[currency] ?? 0) + amount, 2);
      continue;
    }
    out.total = round(out.total + amount, 2);
    if (b.kind === "cash") out.cash = round(out.cash + amount, 2);
    else if (b.kind === "wallet") out.wallets = round(out.wallets + amount, 2);
    else if (b.kind === "pos_cash") out.posCash = round(out.posCash + amount, 2);
    else out.banks = round(out.banks + amount, 2);
  }
  return out;
}
