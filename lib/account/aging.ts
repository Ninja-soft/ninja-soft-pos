// Antigüedad de deuda por VENCIMIENTO (Cuenta corriente v2).
//
// ESPEJO del SQL: account_aging() en
// supabase/migrations/20261011180000_cuenta_corriente_v2.sql.
// Tramos: no vencido (vence hoy o después) / 1-30 / 31-60 / 61-90 / 90+ días.
import { diffDays } from "./terms";

export type AgingBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

export const AGING_BUCKETS: { key: AgingBucket; label: string }[] = [
  { key: "current", label: "No vencido" },
  { key: "d1_30", label: "1 a 30 días" },
  { key: "d31_60", label: "31 a 60 días" },
  { key: "d61_90", label: "61 a 90 días" },
  { key: "d90_plus", label: "Más de 90 días" },
];

export function daysOverdue(dueDate: string, asOf: string): number {
  return diffDays(dueDate, asOf);
}

export function agingBucket(dueDate: string | null, asOf: string): AgingBucket {
  if (!dueDate) return "current";
  const d = daysOverdue(dueDate, asOf);
  if (d <= 0) return "current";
  if (d <= 30) return "d1_30";
  if (d <= 60) return "d31_60";
  if (d <= 90) return "d61_90";
  return "d90_plus";
}

export type AgingTotals = Record<AgingBucket, number> & { total: number; overdue: number };

export function agingTotals(
  items: { due_date: string | null; open: number }[],
  asOf: string,
): AgingTotals {
  const c: Record<AgingBucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let total = 0;
  for (const it of items) {
    const cts = Math.round(it.open * 100);
    c[agingBucket(it.due_date, asOf)] += cts;
    total += cts;
  }
  return {
    current: c.current / 100,
    d1_30: c.d1_30 / 100,
    d31_60: c.d31_60 / 100,
    d61_90: c.d61_90 / 100,
    d90_plus: c.d90_plus / 100,
    total: total / 100,
    overdue: (total - c.current) / 100,
  };
}
