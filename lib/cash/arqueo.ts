// F24 · H159 (ADR-172): arqueo por billete y por medio. PURO.
//
// Espejo de cash_shift_save_count (migración 20270110100000): denominaciones
// válidas, total de billetes y monedas, y los medios que se cuentan (no la
// cuenta corriente ni el saldo a favor).

import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";

/** Billetes y monedas en circulación (pesos), de mayor a menor. */
export const DENOMINATIONS = [20000, 10000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;
export type Denomination = (typeof DENOMINATIONS)[number];

/** Medios que no se cuentan en el arqueo. */
const NOT_COUNTED = new Set(["cash", "account", "store_credit"]);

export interface CloseCount {
  bills: Record<string, number>;
  coins: number;
  methods: Record<string, number>;
}

export function toQty(raw: string): number {
  const n = Math.floor(Number(String(raw).replace(/\D/g, "")));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : 0;
}

export function toAmount(raw: string): number | null {
  const s = String(raw).trim().replace(/\./g, "").replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/** Total en efectivo del conteo por billete (billetes + monedas sueltas). */
export function billsTotal(bills: Record<string, number>, coins: number): number {
  let t = 0;
  for (const d of DENOMINATIONS) t += d * (bills[String(d)] ?? 0);
  return Math.round((t + (coins > 0 ? coins : 0)) * 100) / 100;
}

// H160: los dólares se esperan y se cuentan en dólares (no en pesos).
const methodLabel = (m: string) => (m === "cash_usd" ? "Dólares (en US$)" : (PAYMENT_METHOD_LABELS[m] ?? m));

/** Medios del turno que se cuentan, con su esperado (los de esperado 0 no salen). */
export function countableMethods(byMethod: Record<string, number>): { method: string; label: string; expected: number }[] {
  return Object.entries(byMethod)
    .filter(([m, v]) => !NOT_COUNTED.has(m) && Math.abs(v) > 0.004)
    .map(([m, v]) => ({ method: m, label: methodLabel(m), expected: Math.round(v * 100) / 100 }))
    .sort((a, b) => b.expected - a.expected);
}

/** Payload para cash_shift_save_count (sin ceros ni medios vacíos). */
export function buildCount(
  bills: Record<string, number>,
  coins: number,
  methods: Record<string, number | null>,
): CloseCount {
  const b: Record<string, number> = {};
  for (const d of DENOMINATIONS) {
    const q = bills[String(d)] ?? 0;
    if (q > 0) b[String(d)] = q;
  }
  const m: Record<string, number> = {};
  for (const [k, v] of Object.entries(methods)) {
    if (v !== null && v >= 0 && !NOT_COUNTED.has(k)) m[k] = v;
  }
  return { bills: b, coins: coins > 0 ? Math.round(coins * 100) / 100 : 0, methods: m };
}

/** ¿Hay algo para guardar? (si no, el cierre sigue como siempre). */
export function countHasData(c: CloseCount): boolean {
  return Object.keys(c.bills).length > 0 || c.coins > 0 || Object.keys(c.methods).length > 0;
}

export interface CountDetailRow {
  method: string;
  label: string;
  expected: number;
  counted: number | null;
  diff: number | null;
}

/** Filas del arqueo guardado en el Z (count_detail), efectivo primero. */
export function countDetailRows(detail: unknown): CountDetailRow[] {
  const methods = (detail as { methods?: Record<string, { expected?: number; counted?: number | null; diff?: number | null }> } | null)
    ?.methods;
  if (!methods) return [];
  return Object.entries(methods)
    .map(([m, v]) => ({
      method: m,
      label: m === "cash" ? "Efectivo" : methodLabel(m),
      expected: Number(v.expected ?? 0),
      counted: v.counted == null ? null : Number(v.counted),
      diff: v.diff == null ? null : Number(v.diff),
    }))
    .sort((a, b) => (a.method === "cash" ? -1 : b.method === "cash" ? 1 : b.expected - a.expected));
}

/** Billetes del Z ordenados de mayor a menor. */
export function countDetailBills(detail: unknown): { denom: number; qty: number; subtotal: number }[] {
  const bills = (detail as { bills?: Record<string, number> } | null)?.bills ?? {};
  return DENOMINATIONS.filter((d) => (bills[String(d)] ?? 0) > 0).map((d) => ({
    denom: d,
    qty: Number(bills[String(d)]),
    subtotal: d * Number(bills[String(d)]),
  }));
}

/** Apertura: ¿pedir confirmación? (se abre en $0 y el cierre anterior dejó plata). */
export function openingNeedsConfirm(opening: number, suggested: number | null | undefined): boolean {
  return opening <= 0 && (suggested ?? 0) > 0;
}
