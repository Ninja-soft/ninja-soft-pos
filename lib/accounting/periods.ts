// lib/accounting/periods.ts
//
// Cierre mensual (ADR-066). Espejo de las reglas de acc_period_close y
// acc_period_reopen para habilitar los botones; el servidor es la barrera.

export interface PeriodState {
  period: string; // YYYY-MM-01
  status: "open" | "closed";
  entries: number;
}

export function periodOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Meses desde `from` hasta `to` (inclusive), del más nuevo al más viejo. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(to.slice(0, 4));
  let m = Number(to.slice(5, 7));
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7));
  while (y > fy || (y === fy && m >= fm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
    if (out.length > 240) break;
  }
  return out;
}

export type CloseBlock = "not_ended" | "already_closed" | "previous_open" | null;

export function closeBlock(periods: PeriodState[], target: string, today: string): CloseBlock {
  const p = periodOf(target);
  if (p >= periodOf(today)) return "not_ended";
  const cur = periods.find((x) => x.period === p);
  if (cur?.status === "closed") return "already_closed";
  const prevOpen = periods.some((x) => x.period < p && x.status !== "closed" && x.entries > 0);
  return prevOpen ? "previous_open" : null;
}

export type ReopenBlock = "not_closed" | "later_closed" | null;

export function reopenBlock(periods: PeriodState[], target: string): ReopenBlock {
  const p = periodOf(target);
  const cur = periods.find((x) => x.period === p);
  if (cur?.status !== "closed") return "not_closed";
  return periods.some((x) => x.period > p && x.status === "closed") ? "later_closed" : null;
}

/** Primer día del ejercicio que contiene `iso` (mes de inicio 1 a 12). */
export function fiscalYearStart(iso: string, startMonth: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}
