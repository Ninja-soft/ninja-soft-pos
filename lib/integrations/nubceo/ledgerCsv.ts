// Importación de asientos contables exportados desde NubCeo (ADR-062).
//
// La API de NubCeo tiene lectura de asientos (GET /accounting/ledger-header) y
// es la vía principal; este lector es la alternativa para quien prefiere bajar
// la exportación (o todavía no tiene la API habilitada). NubCeo no publica el
// formato de su exportación, así que se aceptan los nombres de columna
// habituales en castellano y en inglés (los mismos campos que devuelve la
// API) y se agrupan los renglones por asiento.
//
// Un renglón = una línea del asiento. Columnas (sin importar mayúsculas,
// tildes ni el orden):
//   id del asiento (opcional) · número · fecha · categoría · estado · moneda
//   código de cuenta · nombre de cuenta · subcuenta · centro de costo
//   debe y haber, o un importe con signo (positivo = Debe).
// Separador ; , o tabulación. Decimales con coma o con punto. Fechas
// dd/mm/aaaa o aaaa-mm-dd.
//
// Puro: sin React ni Supabase. Tests en tests/unit/nubceoLedgerCsv.test.ts.

export interface LedgerEntryInput {
  nubceo_id: string;
  account_code: string;
  account_name: string;
  subaccount_code: string;
  subaccount_name: string;
  cost_center: string;
  amount: number;
}

export interface LedgerHeaderInput {
  nubceo_id: string;
  number: string;
  company_id: string;
  batch_id: string;
  category: string;
  status: "confirmed" | "not_confirmed";
  date: string;
  currency: string;
  deleted: boolean;
  entries: LedgerEntryInput[];
}

export interface LedgerCsvResult {
  headers: LedgerHeaderInput[];
  rows: number;
  errors: string[];
  /** Asientos cuyo Debe y Haber no cierran (se importan igual, con aviso). */
  unbalanced: string[];
}

type Field =
  | "id"
  | "number"
  | "date"
  | "category"
  | "status"
  | "currency"
  | "account_code"
  | "account_name"
  | "subaccount_code"
  | "subaccount_name"
  | "cost_center"
  | "debit"
  | "credit"
  | "amount"
  | "entry_id";

const ALIASES: Record<Field, string[]> = {
  id: ["id", "id asiento", "asiento id", "ledger header id", "ledgerheaderid", "id del asiento"],
  number: ["numero", "nro", "n°", "nº", "numero de asiento", "asiento", "number", "nro asiento"],
  date: ["fecha", "fecha contable", "fecha del asiento", "date"],
  category: ["categoria", "tipo", "tipo de asiento", "ledgercategory", "category", "origen"],
  status: ["estado", "status"],
  currency: ["moneda", "currency", "currencycode"],
  account_code: ["codigo de cuenta", "cod cuenta", "codigo cuenta", "cuenta codigo", "account code", "code", "codigo", "cuenta"],
  account_name: ["nombre de cuenta", "nombre cuenta", "cuenta contable", "descripcion de cuenta", "account name", "account", "nombre"],
  subaccount_code: ["subcuenta", "codigo de subcuenta", "subaccountcode", "subaccount code"],
  subaccount_name: ["nombre de subcuenta", "subaccountname", "subaccount name"],
  cost_center: ["centro de costo", "centro de costos", "cc", "costcentercode", "cost center"],
  debit: ["debe", "debito", "debit"],
  credit: ["haber", "credito", "credit"],
  amount: ["importe", "monto", "amount", "saldo"],
  entry_id: ["id renglon", "id linea", "entry id", "ledger entry id"],
};

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_.:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Separa una línea CSV respetando comillas. */
export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        q = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      q = true;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function detectSep(headerLine: string): string {
  const counts = [";", ",", "\t"].map((s) => [s, splitCsvLine(headerLine, s).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![0];
}

/** "1.234,56" · "1234.56" · "-1,5" · "(100,00)" → número; "" → 0; inválido → NaN. */
export function parseAmount(raw: string): number {
  let s = raw.trim().replace(/\$|ARS|\s/g, "");
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  // "2.000" o "1.234.567" sin coma: el punto es de miles (formato argentino).
  else if (lastComma < 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  else s = s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return Number.NaN;
  const n = Math.round(Number(s) * 100) / 100;
  return neg ? -n : n;
}

/** dd/mm/aaaa, d-m-aa, aaaa-mm-dd (con o sin hora) → aaaa-mm-dd; "" si no se entiende. */
export function parseDate(raw: string): string {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s);
  if (m) {
    const y = Number(m[3]);
    return valid(y < 100 ? 2000 + y : y, Number(m[2]), Number(m[1]));
  }
  return "";
}

function valid(y: number, mo: number, d: number): string {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function statusOf(raw: string): "confirmed" | "not_confirmed" {
  const s = norm(raw);
  return s === "confirmed" || s === "confirmado" || s === "confirmada" ? "confirmed" : "not_confirmed";
}

/** Columna de cada campo: alias exacto primero; si no, el alias contenido en el encabezado. */
export function mapColumns(headers: string[]): Partial<Record<Field, number>> {
  const h = headers.map(norm);
  const out: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  const fields = Object.keys(ALIASES) as Field[];
  for (const pass of ["exact", "contains"] as const) {
    for (const f of fields) {
      if (out[f] !== undefined) continue;
      for (const alias of ALIASES[f]) {
        const idx = h.findIndex((col, i) => !used.has(i) && (pass === "exact" ? col === alias : alias.length > 3 && col.includes(alias)));
        if (idx >= 0) {
          out[f] = idx;
          used.add(idx);
          break;
        }
      }
    }
  }
  return out;
}

export function parseLedgerCsv(text: string): LedgerCsvResult {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const result: LedgerCsvResult = { headers: [], rows: 0, errors: [], unbalanced: [] };
  if (lines.length < 2) {
    result.errors.push("El archivo no tiene renglones.");
    return result;
  }
  const sep = detectSep(lines[0] as string);
  const cols = mapColumns(splitCsvLine(lines[0] as string, sep));
  if (cols.date === undefined) result.errors.push("Falta la columna de fecha.");
  if (cols.number === undefined && cols.id === undefined) result.errors.push("Falta la columna de número o id del asiento.");
  if (cols.debit === undefined && cols.credit === undefined && cols.amount === undefined) {
    result.errors.push("Falta la columna de importe (o Debe y Haber).");
  }
  if (cols.account_code === undefined && cols.account_name === undefined) result.errors.push("Falta la columna de cuenta.");
  if (result.errors.length > 0) return result;

  const get = (cells: string[], f: Field) => (cols[f] === undefined ? "" : (cells[cols[f] as number] ?? "").trim());
  const byKey = new Map<string, LedgerHeaderInput>();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] as string, sep);
    const line = i + 1;
    const date = parseDate(get(cells, "date"));
    if (!date) {
      result.errors.push(`Renglón ${line}: fecha inválida.`);
      continue;
    }
    const id = get(cells, "id");
    const number = get(cells, "number");
    if (!id && !number) {
      result.errors.push(`Renglón ${line}: falta el número del asiento.`);
      continue;
    }
    let amount: number;
    if (cols.debit !== undefined || cols.credit !== undefined) {
      const d = parseAmount(get(cells, "debit"));
      const c = parseAmount(get(cells, "credit"));
      amount = Math.round(((Number.isNaN(d) ? Number.NaN : d) - (Number.isNaN(c) ? Number.NaN : c)) * 100) / 100;
    } else {
      amount = parseAmount(get(cells, "amount"));
    }
    if (Number.isNaN(amount)) {
      result.errors.push(`Renglón ${line}: importe inválido.`);
      continue;
    }
    const key = id || `csv:${number}:${date}`;
    let h = byKey.get(key);
    if (!h) {
      h = {
        nubceo_id: key.slice(0, 200),
        number: number.slice(0, 60),
        company_id: "",
        batch_id: "",
        category: get(cells, "category").slice(0, 60),
        status: statusOf(get(cells, "status")),
        date,
        currency: (get(cells, "currency") || "ARS").slice(0, 3).toUpperCase(),
        deleted: false,
        entries: [],
      };
      byKey.set(key, h);
    }
    h.entries.push({
      nubceo_id: get(cells, "entry_id"),
      account_code: get(cells, "account_code").slice(0, 100),
      account_name: get(cells, "account_name").slice(0, 200),
      subaccount_code: get(cells, "subaccount_code").slice(0, 100),
      subaccount_name: get(cells, "subaccount_name").slice(0, 200),
      cost_center: get(cells, "cost_center").slice(0, 100),
      amount,
    });
    result.rows++;
  }
  result.headers = [...byKey.values()];
  for (const h of result.headers) {
    const sumC = h.entries.reduce((a, e) => a + Math.round(e.amount * 100), 0);
    if (sumC !== 0) result.unbalanced.push(h.number || h.nubceo_id);
  }
  return result;
}

/** Totales de Debe y Haber de un asiento (importes con signo). */
export function ledgerTotals(entries: { amount: number }[]): { debit: number; credit: number } {
  let d = 0;
  let c = 0;
  for (const e of entries) {
    const v = Math.round(Number(e.amount) * 100);
    if (v > 0) d += v;
    else c -= v;
  }
  return { debit: d / 100, credit: c / 100 };
}
