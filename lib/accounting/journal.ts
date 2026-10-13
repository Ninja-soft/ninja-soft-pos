// lib/accounting/journal.ts
//
// Contabilidad (ADR-066): lógica pura de libros. Balanceo de asientos, árbol
// del balance de sumas y saldos, estado de resultados, mayor con saldo
// corrido y asientos resumidos por día y sucursal para el export al estudio.

import { round2 } from "./vat";

export type AccountKind = "activo" | "pasivo" | "patrimonio" | "ingreso" | "egreso";

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  activo: "Activo",
  pasivo: "Pasivo",
  patrimonio: "Patrimonio neto",
  ingreso: "Resultado positivo",
  egreso: "Resultado negativo",
};

/** Saldo natural deudor (activo y egresos) o acreedor (pasivo, PN e ingresos). */
export function isDebitNature(kind: AccountKind): boolean {
  return kind === "activo" || kind === "egreso";
}

export interface JournalLine {
  entry_id: string;
  number: number;
  official_number: number | null;
  entry_date: string;
  kind: string;
  source_type: string | null;
  source_id: string | null;
  source_event: string | null;
  entry_description: string;
  store_id: string | null;
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  account_external_code: string | null;
  account_kind: AccountKind;
  cost_center_id: string | null;
  cost_center_code: string | null;
  cost_center_name: string | null;
  debit: number;
  credit: number;
  description: string | null;
}

export interface JournalEntry {
  entry_id: string;
  number: number;
  official_number: number | null;
  entry_date: string;
  kind: string;
  source_type: string | null;
  source_id: string | null;
  source_event: string | null;
  description: string;
  store_id: string | null;
  lines: JournalLine[];
  debit: number;
  credit: number;
}

export function entryTotals(lines: Array<{ debit: number; credit: number }>) {
  const debit = round2(lines.reduce((t, l) => t + (Number(l.debit) || 0), 0));
  const credit = round2(lines.reduce((t, l) => t + (Number(l.credit) || 0), 0));
  return { debit, credit, balanced: debit === credit && debit > 0 && lines.length >= 2 };
}

/** Agrupa renglones (ordenados por fecha, número y renglón) en asientos. */
export function groupEntries(lines: JournalLine[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  const byId = new Map<string, JournalEntry>();
  for (const l of lines) {
    let e = byId.get(l.entry_id);
    if (!e) {
      e = {
        entry_id: l.entry_id,
        number: l.number,
        official_number: l.official_number,
        entry_date: l.entry_date,
        kind: l.kind,
        source_type: l.source_type,
        source_id: l.source_id,
        source_event: l.source_event,
        description: l.entry_description,
        store_id: l.store_id,
        lines: [],
        debit: 0,
        credit: 0,
      };
      byId.set(l.entry_id, e);
      out.push(e);
    }
    e.lines.push(l);
    e.debit = round2(e.debit + (Number(l.debit) || 0));
    e.credit = round2(e.credit + (Number(l.credit) || 0));
  }
  for (const e of out) e.lines.sort((a, b) => a.line_no - b.line_no);
  return out;
}

// ── Sumas y saldos ─────────────────────────────────────────────────────────

export interface TrialRow {
  account_id: string;
  code: string;
  name: string;
  kind: AccountKind;
  parent_id: string | null;
  imputable: boolean;
  external_code: string | null;
  opening: number;
  debit: number;
  credit: number;
}

export interface TrialNode extends TrialRow {
  depth: number;
  /** Saldo final con signo (debe - haber). */
  closing: number;
}

/**
 * Suma cada cuenta en sus madres y devuelve el árbol plano ordenado por
 * código. `hideEmpty` saca las cuentas sin saldo anterior, sin movimientos y
 * sin saldo final.
 */
export function rollupTrialBalance(rows: TrialRow[], opts: { hideEmpty?: boolean } = {}): TrialNode[] {
  const byId = new Map<string, TrialNode>();
  for (const r of rows) {
    byId.set(r.account_id, {
      ...r,
      opening: round2(Number(r.opening) || 0),
      debit: round2(Number(r.debit) || 0),
      credit: round2(Number(r.credit) || 0),
      depth: 0,
      closing: 0,
    });
  }
  const depthOf = (n: TrialNode): number => {
    let d = 0;
    let p = n.parent_id ? byId.get(n.parent_id) : undefined;
    const seen = new Set<string>();
    while (p && !seen.has(p.account_id)) {
      seen.add(p.account_id);
      d++;
      p = p.parent_id ? byId.get(p.parent_id) : undefined;
    }
    return d;
  };
  // Sólo las imputables traen movimientos propios: se propagan hacia arriba.
  const own = new Map([...byId.values()].map((n) => [n.account_id, { o: n.opening, d: n.debit, c: n.credit }]));
  for (const n of byId.values()) {
    if (!n.imputable) {
      n.opening = 0;
      n.debit = 0;
      n.credit = 0;
    }
  }
  for (const n of byId.values()) {
    const o = own.get(n.account_id)!;
    if (!n.imputable) continue;
    let p = n.parent_id ? byId.get(n.parent_id) : undefined;
    const seen = new Set<string>();
    while (p && !seen.has(p.account_id)) {
      seen.add(p.account_id);
      p.opening = round2(p.opening + o.o);
      p.debit = round2(p.debit + o.d);
      p.credit = round2(p.credit + o.c);
      p = p.parent_id ? byId.get(p.parent_id) : undefined;
    }
  }
  const out = [...byId.values()].map((n) => ({
    ...n,
    depth: depthOf(n),
    closing: round2(n.opening + n.debit - n.credit),
  }));
  out.sort((a, b) => compareCodes(a.code, b.code));
  return opts.hideEmpty ? out.filter((n) => n.opening !== 0 || n.debit !== 0 || n.credit !== 0) : out;
}

/** Orden natural de códigos de cuenta ("1.10" después de "1.9"). */
export function compareCodes(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Totales del balance: la suma del debe es igual a la del haber. */
export function trialTotals(rows: TrialRow[]) {
  const imp = rows.filter((r) => r.imputable);
  const debit = round2(imp.reduce((t, r) => t + (Number(r.debit) || 0), 0));
  const credit = round2(imp.reduce((t, r) => t + (Number(r.credit) || 0), 0));
  const debtor = round2(
    imp.reduce((t, r) => {
      const c = (Number(r.opening) || 0) + (Number(r.debit) || 0) - (Number(r.credit) || 0);
      return c > 0 ? t + c : t;
    }, 0),
  );
  const creditor = round2(
    imp.reduce((t, r) => {
      const c = (Number(r.opening) || 0) + (Number(r.debit) || 0) - (Number(r.credit) || 0);
      return c < 0 ? t - c : t;
    }, 0),
  );
  return { debit, credit, debtor, creditor, balanced: debit === credit && debtor === creditor };
}

// ── Estado de resultados ───────────────────────────────────────────────────

export interface IncomeLine {
  account_id: string;
  code: string;
  name: string;
  amount: number;
}

export interface IncomeStatement {
  ingresos: IncomeLine[];
  egresos: IncomeLine[];
  totalIngresos: number;
  totalEgresos: number;
  resultado: number;
}

/** Estado de resultados del período (sólo movimientos del rango). */
export function incomeStatement(rows: TrialRow[]): IncomeStatement {
  const ingresos: IncomeLine[] = [];
  const egresos: IncomeLine[] = [];
  for (const r of [...rows].sort((a, b) => compareCodes(a.code, b.code))) {
    if (!r.imputable) continue;
    const d = Number(r.debit) || 0;
    const c = Number(r.credit) || 0;
    if (r.kind === "ingreso") {
      const amount = round2(c - d);
      if (amount !== 0) ingresos.push({ account_id: r.account_id, code: r.code, name: r.name, amount });
    } else if (r.kind === "egreso") {
      const amount = round2(d - c);
      if (amount !== 0) egresos.push({ account_id: r.account_id, code: r.code, name: r.name, amount });
    }
  }
  const totalIngresos = round2(ingresos.reduce((t, l) => t + l.amount, 0));
  const totalEgresos = round2(egresos.reduce((t, l) => t + l.amount, 0));
  return { ingresos, egresos, totalIngresos, totalEgresos, resultado: round2(totalIngresos - totalEgresos) };
}

// ── Mayor ──────────────────────────────────────────────────────────────────

export interface LedgerRow {
  entry_id: string;
  number: number;
  official_number: number | null;
  entry_date: string;
  description: string;
  detail: string | null;
  debit: number;
  credit: number;
  balance: number;
}

export function ledgerRows(lines: JournalLine[], opening: number): LedgerRow[] {
  let bal = round2(opening || 0);
  return [...lines]
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.number - b.number || a.line_no - b.line_no))
    .map((l) => {
      bal = round2(bal + (Number(l.debit) || 0) - (Number(l.credit) || 0));
      return {
        entry_id: l.entry_id,
        number: l.number,
        official_number: l.official_number,
        entry_date: l.entry_date,
        description: l.entry_description,
        detail: l.description,
        debit: Number(l.debit) || 0,
        credit: Number(l.credit) || 0,
        balance: bal,
      };
    });
}

// ── Asientos resumidos ─────────────────────────────────────────────────────

export type SummaryMode = "detailed" | "daily" | "monthly";

/**
 * Resume los asientos por fecha (o mes) y sucursal: un asiento por grupo con
 * el debe y el haber de cada cuenta y centro de costo por separado (no se
 * netean: las sumas del libro siguen iguales). Numera desde 1.
 */
export function summarizeEntries(
  entries: JournalEntry[],
  mode: SummaryMode,
  storeName: (id: string | null) => string = () => "",
): JournalEntry[] {
  if (mode === "detailed") return entries;
  type Acc = { line: JournalLine; debit: number; credit: number };
  const groups = new Map<string, { date: string; store: string | null; acc: Map<string, Acc> }>();
  for (const e of entries) {
    const date = mode === "monthly" ? lastDayOfMonth(e.entry_date) : e.entry_date;
    const key = `${date}|${e.store_id ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { date, store: e.store_id, acc: new Map() };
      groups.set(key, g);
    }
    for (const l of e.lines) {
      const side = (Number(l.debit) || 0) > 0 ? "D" : "C";
      const k = `${l.account_id}|${l.cost_center_id ?? ""}|${side}`;
      const a = g.acc.get(k) ?? { line: l, debit: 0, credit: 0 };
      a.debit = round2(a.debit + (Number(l.debit) || 0));
      a.credit = round2(a.credit + (Number(l.credit) || 0));
      g.acc.set(k, a);
    }
  }
  const sorted = [...groups.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.store ?? "").localeCompare(b.store ?? ""),
  );
  return sorted.map((g, i) => {
    const sname = storeName(g.store);
    const label = mode === "monthly" ? `Resumen de ${monthLabel(g.date)}` : `Resumen del ${fmtDay(g.date)}`;
    const lines = [...g.acc.values()]
      .sort((a, b) => (a.debit > 0 ? 0 : 1) - (b.debit > 0 ? 0 : 1) || compareCodes(a.line.account_code, b.line.account_code))
      .map((a, j) => ({
        ...a.line,
        entry_id: `sum-${i + 1}`,
        number: i + 1,
        official_number: null,
        entry_date: g.date,
        entry_description: sname ? `${label} · ${sname}` : label,
        line_no: j + 1,
        debit: a.debit,
        credit: a.credit,
        description: null,
      }));
    const t = entryTotals(lines);
    return {
      entry_id: `sum-${i + 1}`,
      number: i + 1,
      official_number: null,
      entry_date: g.date,
      kind: "summary",
      source_type: null,
      source_id: null,
      source_event: null,
      description: lines[0]?.entry_description ?? label,
      store_id: g.store,
      lines,
      debit: t.debit,
      credit: t.credit,
    };
  });
}

function lastDayOfMonth(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function monthLabel(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""} ${iso.slice(0, 4)}`;
}

export function fmtDay(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
