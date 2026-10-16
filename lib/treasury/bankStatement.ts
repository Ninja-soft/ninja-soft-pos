// lib/treasury/bankStatement.ts
//
// Extracto bancario (F23 · H152, ADR-162). Lógica PURA: presets de los bancos
// más usados (qué encabezado trae cada dato), detección de la fila de
// encabezado, mapeo de columnas sugerido y conversión de las filas del CSV o
// XLSX a renglones para bank_statement_import (fecha, detalle, referencia,
// importe con signo y saldo). El matching contra Tesorería lo hace el servidor.

import { normHeader, parseAmount, parseArDate } from "@/lib/reports/processorReconciliation";

export type StatementField = "date" | "description" | "reference" | "amount" | "debit" | "credit" | "balance";

export const STATEMENT_FIELDS: Array<{ key: StatementField; label: string; hint?: string }> = [
  { key: "date", label: "Fecha" },
  { key: "description", label: "Detalle o concepto" },
  { key: "reference", label: "Referencia o comprobante" },
  { key: "amount", label: "Importe (con signo)", hint: "Si el banco trae una sola columna de importe, con negativos para lo que sale." },
  { key: "debit", label: "Débitos (lo que sale)", hint: "Si el banco separa débitos y créditos." },
  { key: "credit", label: "Créditos (lo que entra)" },
  { key: "balance", label: "Saldo" },
];

export type StatementMapping = Partial<Record<StatementField, number>>;

export interface BankPreset {
  key: string;
  label: string;
  /** Encabezados típicos de cada dato (normalizados con normHeader). */
  synonyms: Partial<Record<StatementField, string[]>>;
  /** Cómo se descarga, en una línea. */
  hint: string;
}

const COMMON: Partial<Record<StatementField, string[]>> = {
  date: ["fecha", "fecha movimiento", "fecha operacion", "fecha de operacion", "fecha valor", "date"],
  description: ["descripcion", "concepto", "detalle", "movimiento", "leyenda", "description"],
  reference: ["referencia", "comprobante", "nro comprobante", "numero de comprobante", "nro de comprobante", "documento", "reference"],
  amount: ["importe", "monto", "importe en pesos", "amount"],
  debit: ["debito", "debitos", "debe", "egresos", "salidas"],
  credit: ["credito", "creditos", "haber", "ingresos", "entradas"],
  balance: ["saldo", "saldo en pesos", "balance"],
};

export const BANK_PRESETS: BankPreset[] = [
  {
    key: "galicia",
    label: "Banco Galicia",
    hint: "Online Banking > Cuentas > Movimientos > Descargar (Excel o CSV).",
    synonyms: { debit: ["debitos"], credit: ["creditos"], reference: ["numero de comprobante", "comprobante"] },
  },
  {
    key: "santander",
    label: "Santander",
    hint: "Online Banking > Cuentas > Últimos movimientos > Exportar.",
    synonyms: { amount: ["importe", "importe pesos"], reference: ["referencia", "comprobante"] },
  },
  {
    key: "bbva",
    label: "BBVA",
    hint: "BBVA Net > Cuentas > Movimientos > Descargar en Excel.",
    synonyms: { debit: ["debito"], credit: ["credito"], description: ["concepto"] },
  },
  {
    key: "macro",
    label: "Banco Macro",
    hint: "Macro Online > Cuentas > Consultar movimientos > Exportar.",
    synonyms: { debit: ["debito", "debitos"], credit: ["credito", "creditos"], reference: ["nro comprobante"] },
  },
  {
    key: "nacion",
    label: "Banco Nación",
    hint: "HomeBanking > Cuentas > Movimientos > Exportar a Excel.",
    synonyms: { amount: ["importe"], reference: ["comprobante"], description: ["concepto"] },
  },
  {
    key: "provincia",
    label: "Banco Provincia",
    hint: "BIP > Cuentas > Movimientos > Descargar.",
    synonyms: { amount: ["importe"], description: ["descripcion"] },
  },
  {
    key: "credicoop",
    label: "Credicoop",
    hint: "Banca Internet > Cuentas > Movimientos > Exportar.",
    synonyms: { debit: ["debito"], credit: ["credito"], reference: ["comprobante"] },
  },
  {
    key: "brubank",
    label: "Brubank",
    hint: "App > Cuenta > Resumen > Descargar movimientos.",
    synonyms: { amount: ["monto", "importe"], description: ["descripcion"] },
  },
  {
    key: "mercadopago",
    label: "Mercado Pago (dinero disponible)",
    hint: "Mercado Pago > Tu dinero > Reportes > Dinero disponible (CSV).",
    synonyms: {
      date: ["date", "fecha de liberacion", "release date"],
      description: ["description", "descripcion", "record type"],
      reference: ["source id", "external reference", "id de operacion"],
      credit: ["net credit amount", "neto acreditado"],
      debit: ["net debit amount", "neto debitado"],
      balance: ["balance amount", "saldo"],
    },
  },
  {
    key: "otro",
    label: "Otro banco",
    hint: "Descargá los movimientos en Excel o CSV y elegí qué columna es cada dato.",
    synonyms: {},
  },
];

export const bankPreset = (key: string | null | undefined): BankPreset =>
  BANK_PRESETS.find((p) => p.key === key) ?? BANK_PRESETS[BANK_PRESETS.length - 1]!;

/** Mapeo sugerido por encabezado: primero los del preset, después los comunes; el más largo gana. */
export function guessStatementMapping(header: string[], presetKey?: string | null): StatementMapping {
  const cols = header.map((h) => normHeader(String(h ?? "")));
  const preset = bankPreset(presetKey);
  const cands: Array<{ field: StatementField; col: number; score: number }> = [];
  for (const f of STATEMENT_FIELDS) {
    const own = preset.synonyms[f.key] ?? [];
    const all = [...own.map((s) => ({ s, bonus: 50 })), ...(COMMON[f.key] ?? []).map((s) => ({ s, bonus: 0 }))];
    for (const { s, bonus } of all) {
      cols.forEach((c, i) => {
        if (!c) return;
        if (c === s) cands.push({ field: f.key, col: i, score: 200 + bonus + s.length });
        else if (c.includes(s)) cands.push({ field: f.key, col: i, score: bonus + s.length });
      });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const out: StatementMapping = {};
  const taken = new Set<number>();
  for (const c of cands) {
    if (out[c.field] != null || taken.has(c.col)) continue;
    out[c.field] = c.col;
    taken.add(c.col);
  }
  // Con débito y crédito separados no hace falta la columna de importe (y al revés).
  if (out.debit != null && out.credit != null && out.amount != null) delete out.amount;
  return out;
}

/** Fila del encabezado: la primera (de las 15 primeras) donde se reconocen la fecha y algún importe. */
export function findStatementHeader(grid: string[][], presetKey?: string | null): number {
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const m = guessStatementMapping(grid[i] ?? [], presetKey);
    if (m.date != null && (m.amount != null || m.debit != null || m.credit != null)) return i;
  }
  return 0;
}

export function mappingReady(m: StatementMapping): boolean {
  return m.date != null && (m.amount != null || m.debit != null || m.credit != null);
}

export interface StatementLine {
  date: string;
  description: string | null;
  reference: string | null;
  amount: number;
  balance: number | null;
}

export interface StatementRowResult {
  row: number;
  line: StatementLine | null;
  /** Motivo por el que se omite (fila de saldo, sin importe, fecha inválida). */
  skip: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const cell = (r: string[], i: number | undefined) => (i == null ? "" : String(r[i] ?? "").trim());

/** Fecha del extracto a aaaa-mm-dd (día de Argentina). Acepta dd/mm/aaaa, aaaa-mm-dd e ISO. */
export function statementDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return s;
  const at = parseArDate(s);
  if (!at) return null;
  // parseArDate devuelve el instante en UTC; el día es el de Argentina (UTC-3).
  return new Date(Date.parse(at) - 3 * 3600_000).toISOString().slice(0, 10);
}

/** Filas del extracto (sin encabezado) a renglones con importe con signo. */
export function statementRowsToLines(body: string[][], map: StatementMapping, firstRow = 2): StatementRowResult[] {
  return body.map((r, i) => {
    const row = firstRow + i;
    const desc = cell(r, map.description);
    if (/^saldo (anterior|inicial|final|al)/i.test(desc) || /^total/i.test(desc)) {
      return { row, line: null, skip: "Fila de saldo o total" };
    }
    const date = statementDate(cell(r, map.date));
    if (!date) return { row, line: null, skip: "Sin fecha válida" };
    let amount: number | null = null;
    if (map.amount != null) amount = parseAmount(cell(r, map.amount));
    if (amount == null || amount === 0) {
      const debit = map.debit != null ? parseAmount(cell(r, map.debit)) : null;
      const credit = map.credit != null ? parseAmount(cell(r, map.credit)) : null;
      const total = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
      amount = debit == null && credit == null ? null : total;
    }
    if (amount == null || round2(amount) === 0) return { row, line: null, skip: "Sin importe" };
    const balance = map.balance != null ? parseAmount(cell(r, map.balance)) : null;
    const ref = cell(r, map.reference);
    return {
      row,
      skip: null,
      line: {
        date,
        description: desc ? desc.slice(0, 300) : null,
        reference: ref ? ref.slice(0, 80) : null,
        amount: round2(amount),
        balance: balance == null ? null : round2(balance),
      },
    };
  });
}

/** Totales de lo que se va a subir (para la vista previa). */
export function statementTotals(lines: StatementLine[]): { in: number; out: number; count: number; from: string | null; to: string | null } {
  let inn = 0;
  let out = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const l of lines) {
    if (l.amount > 0) inn = round2(inn + l.amount);
    else out = round2(out - l.amount);
    if (!from || l.date < from) from = l.date;
    if (!to || l.date > to) to = l.date;
  }
  return { in: inn, out, count: lines.length, from, to };
}

export type StatementMatchStatus = "pending" | "matched" | "ignored";

export const STATEMENT_STATUS_LABEL: Record<StatementMatchStatus, { label: string; tone: "warning" | "success" | "neutral" }> = {
  pending: { label: "Para revisar", tone: "warning" },
  matched: { label: "Conciliado", tone: "success" },
  ignored: { label: "Ignorado", tone: "neutral" },
};

export const STATEMENT_METHOD_LABEL: Record<string, string> = {
  auto_exact: "Mismo día e importe",
  auto_near: "Mismo importe, días cercanos",
  manual: "Vinculado a mano",
  created: "Movimiento creado desde el extracto",
};
