// lib/treasury/cashflow.ts
//
// Flujo de fondos proyectado (F18 · H111, ADR-059). Lógica PURA: parte del
// saldo de las cuentas de tesorería y suma por período lo que entra (deuda de
// clientes en cuenta corriente y cheques de terceros en cartera, por fecha de
// cobro) y lo que sale (comprobantes de proveedor abiertos por vencimiento y
// cheques propios entregados, por fecha de débito). Lo vencido se proyecta en
// el primer período. F23 · H152 (ADR-162, T6): también lo que los
// procesadores tienen que acreditar, por la fecha de la liquidación o la
// estimada.

import { round } from "@/lib/purchases/costs";

export type CashFlowGranularity = "day" | "week" | "month";

export interface DatedAmount {
  date: string;
  amount: number;
}

export interface CashFlowInput {
  startBalance: number;
  from: string;
  to: string;
  granularity: CashFlowGranularity;
  receivables: DatedAmount[];
  chequesIn: DatedAmount[];
  payables: DatedAmount[];
  chequesOut: DatedAmount[];
  /** A acreditar de los procesadores (H152). Opcional para no romper llamadas viejas. */
  settlements?: DatedAmount[];
}

export interface CashFlowRow {
  key: string;
  label: string;
  start: string;
  receivables: number;
  settlements: number;
  chequesIn: number;
  payables: number;
  chequesOut: number;
  net: number;
  balance: number;
}

function addDays(iso: string, n: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

/** Lunes de la semana de una fecha. */
export function weekStart(iso: string): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

export function periodKey(iso: string, g: CashFlowGranularity): string {
  if (g === "day") return iso.slice(0, 10);
  if (g === "week") return weekStart(iso);
  return `${iso.slice(0, 7)}-01`;
}

function periodLabel(key: string, g: CashFlowGranularity): string {
  const [y, m, d] = key.split("-");
  if (g === "month") return `${m}/${y}`;
  if (g === "week") return `Semana del ${d}/${m}`;
  return `${d}/${m}`;
}

/** Períodos entre `from` y `to` inclusive. */
export function periods(from: string, to: string, g: CashFlowGranularity): string[] {
  const out: string[] = [];
  let k = periodKey(from, g);
  const last = periodKey(to, g);
  let guard = 0;
  while (k <= last && guard < 400) {
    out.push(k);
    if (g === "day") k = addDays(k, 1);
    else if (g === "week") k = addDays(k, 7);
    else {
      const y = +k.slice(0, 4);
      const m = +k.slice(5, 7);
      k = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    }
    guard++;
  }
  return out;
}

export function buildCashFlow(input: CashFlowInput): CashFlowRow[] {
  const keys = periods(input.from, input.to, input.granularity);
  if (keys.length === 0) return [];
  const first = keys[0]!;
  const rows = new Map<string, CashFlowRow>(
    keys.map((k) => [
      k,
      {
        key: k,
        label: periodLabel(k, input.granularity),
        start: k,
        receivables: 0,
        settlements: 0,
        chequesIn: 0,
        payables: 0,
        chequesOut: 0,
        net: 0,
        balance: 0,
      },
    ]),
  );
  const put = (list: DatedAmount[], field: "receivables" | "settlements" | "chequesIn" | "payables" | "chequesOut") => {
    for (const x of list) {
      if (!x.date || !(Number(x.amount) > 0)) continue;
      if (x.date > input.to) continue;
      const k = x.date < input.from ? first : periodKey(x.date, input.granularity);
      const row = rows.get(k);
      if (row) row[field] = round(row[field] + Number(x.amount), 2);
    }
  };
  put(input.receivables, "receivables");
  put(input.settlements ?? [], "settlements");
  put(input.chequesIn, "chequesIn");
  put(input.payables, "payables");
  put(input.chequesOut, "chequesOut");

  let bal = round(input.startBalance, 2);
  const out: CashFlowRow[] = [];
  for (const k of keys) {
    const r = rows.get(k)!;
    r.net = round(r.receivables + r.settlements + r.chequesIn - r.payables - r.chequesOut, 2);
    bal = round(bal + r.net, 2);
    r.balance = bal;
    out.push(r);
  }
  return out;
}

// ── A acreditar por fecha (H152) ────────────────────────────────────────────

export interface PendingLike {
  amount: number;
  expected_date: string | null;
  expected_known?: boolean;
}

/** Día de hoy en Argentina (UTC-3). */
export function arToday(now: Date = new Date()): string {
  return new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Cobros pendientes agrupados por fecha de acreditación (ascendente). Lo que
 * tenía que entrar antes de hoy se junta en hoy (está atrasado). `estimated`
 * es true si alguna fecha del grupo es estimada.
 */
export function groupPendingByDate<T extends PendingLike>(
  rows: T[],
  today: string = arToday(),
): Array<{ date: string; amount: number; count: number; estimated: boolean }> {
  const map = new Map<string, { date: string; amount: number; count: number; estimated: boolean }>();
  for (const r of rows) {
    if (!r.expected_date || !(Number(r.amount) > 0)) continue;
    const d = r.expected_date < today ? today : r.expected_date.slice(0, 10);
    const g = map.get(d) ?? { date: d, amount: 0, count: 0, estimated: false };
    g.amount = round(g.amount + Number(r.amount), 2);
    g.count += 1;
    g.estimated = g.estimated || !r.expected_known;
    map.set(d, g);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Lo que entra desde hoy hasta dentro de `days` días (incluye lo atrasado). */
export function pendingWithin<T extends PendingLike>(rows: T[], days: number, today: string = arToday()): number {
  const limit = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + days))
    .toISOString()
    .slice(0, 10);
  return rows.reduce(
    (t, r) => (r.expected_date && r.expected_date <= limit && Number(r.amount) > 0 ? round(t + Number(r.amount), 2) : t),
    0,
  );
}

/** Para el flujo de fondos: cada cobro pendiente como entrada en su fecha. */
export function pendingToDated<T extends PendingLike>(rows: T[]): DatedAmount[] {
  return rows.filter((r) => r.expected_date).map((r) => ({ date: r.expected_date!.slice(0, 10), amount: Number(r.amount) }));
}

/** Primer período en que el saldo proyectado queda negativo (null si nunca). */
export function firstShortfall(rows: CashFlowRow[]): CashFlowRow | null {
  return rows.find((r) => r.balance < 0) ?? null;
}
