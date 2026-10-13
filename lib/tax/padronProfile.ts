// Importador de padrones con perfiles del negocio (F18, ADR-105). PURO.
//
// Un PERFIL describe cómo leer el archivo que publica un organismo (o que arma
// el contador): CSV con separador o texto de ancho fijo, en qué columna o
// posición está cada dato, formato de fecha, separador decimal y escala de la
// alícuota. El negocio lo guarda (tax_padron_profiles) y lo reusa cada mes.
// ARBA, AGIP y el genérico de NinjaSoft son perfiles de plantilla
// (BUILTIN_PROFILES): dan exactamente lo mismo que parsePadronLine.
//
// Columnas: { index } (1 = primera) en CSV, { start, length } (posición 1 =
// primer carácter) en ancho fijo. Una sola columna `rate` con una columna
// `regime` que dice si la fila es de percepción o de retención (ARBA: P o R),
// o dos columnas `perception_rate` / `retention_rate` (AGIP). Sin columnas de
// fecha, la vigencia es el período que se elige al importar.

import { isValidCuit, normalizeDigits } from "./catalog";
import { parsePadronDate, type PadronRow } from "./padron";

export type ColumnRef = { index: number } | { start: number; length: number };

export type PadronField =
  | "cuit"
  | "perception_rate"
  | "retention_rate"
  | "rate"
  | "regime"
  | "valid_from"
  | "valid_to"
  | "group_code"
  | "name";

export type DateFormat = "auto" | "ddmmyyyy" | "dd/mm/yyyy" | "yyyy-mm-dd" | "yyyymmdd";

export interface PadronProfileConfig {
  file_type: "delimited" | "fixed";
  /** CSV: ";", ",", "|", "\t" o "auto" (";" si la línea lo tiene; si no, ","). */
  separator?: string;
  has_header?: boolean;
  /** Líneas a saltear al principio (además del encabezado). */
  skip_lines?: number;
  decimal_sep?: "," | ".";
  date_format?: DateFormat;
  /** La alícuota del archivo se divide por esto (100 si viene "150" por 1,50 %). */
  rate_divisor?: number;
  columns: Partial<Record<PadronField, ColumnRef | null>>;
  /** Valor de la columna `regime` para percepción y para retención (ARBA: P y R). */
  regime_values?: { perception?: string; retention?: string };
}

export interface PadronProfile {
  id?: string;
  name: string;
  jurisdiction: string;
  kind: "perception" | "retention" | "both";
  config: PadronProfileConfig;
  builtin?: "arba" | "agip" | "generic";
}

export const BUILTIN_PROFILES: PadronProfile[] = [
  {
    builtin: "arba",
    name: "ARBA · Padrón de regímenes generales",
    jurisdiction: "902",
    kind: "both",
    config: {
      file_type: "delimited",
      separator: ";",
      date_format: "ddmmyyyy",
      columns: {
        regime: { index: 1 },
        valid_from: { index: 3 },
        valid_to: { index: 4 },
        cuit: { index: 5 },
        rate: { index: 9 },
        group_code: { index: 10 },
      },
      regime_values: { perception: "P", retention: "R" },
    },
  },
  {
    builtin: "agip",
    name: "AGIP · Padrón de regímenes generales",
    jurisdiction: "901",
    kind: "both",
    config: {
      file_type: "delimited",
      separator: ";",
      date_format: "ddmmyyyy",
      columns: {
        valid_from: { index: 2 },
        valid_to: { index: 3 },
        cuit: { index: 4 },
        perception_rate: { index: 8 },
        retention_rate: { index: 9 },
        group_code: { index: 10 },
        name: { index: 12 },
      },
    },
  },
  {
    builtin: "generic",
    name: "Genérico (CUIT; percepción; retención; desde; hasta)",
    jurisdiction: "",
    kind: "both",
    config: {
      file_type: "delimited",
      separator: "auto",
      date_format: "auto",
      columns: {
        cuit: { index: 1 },
        perception_rate: { index: 2 },
        retention_rate: { index: 3 },
        valid_from: { index: 4 },
        valid_to: { index: 5 },
      },
    },
  },
];

export const FIELD_LABEL: Record<PadronField, string> = {
  cuit: "CUIT",
  perception_rate: "Alícuota de percepción",
  retention_rate: "Alícuota de retención",
  rate: "Alícuota (una sola columna)",
  regime: "Régimen de la fila (P / R)",
  valid_from: "Vigencia desde",
  valid_to: "Vigencia hasta",
  group_code: "Grupo",
  name: "Razón social",
};

export const PROFILE_REASON_LABEL: Record<string, string> = {
  cuit: "CUIT inválido",
  fecha: "fecha de vigencia inválida o faltante",
  alicuota: "alícuota inválida",
  regimen: "régimen de la fila desconocido",
  corta: "la línea es más corta que las posiciones del perfil",
};

/** Problemas del perfil (antes de leer el archivo). Vacío = sirve. */
export function validateProfile(c: PadronProfileConfig): string[] {
  const out: string[] = [];
  const cols = c.columns ?? {};
  if (c.file_type !== "delimited" && c.file_type !== "fixed") out.push("Elegí el tipo de archivo.");
  if (!cols.cuit) out.push("Falta la columna del CUIT.");
  if (!cols.rate && !cols.perception_rate && !cols.retention_rate) out.push("Falta la columna de la alícuota.");
  if (cols.rate && !cols.regime && !(cols.perception_rate || cols.retention_rate)) {
    // Una sola alícuota sin régimen: vale para el tipo del perfil (se resuelve al importar).
  }
  for (const [k, ref] of Object.entries(cols)) {
    if (!ref) continue;
    if (c.file_type === "fixed") {
      if (!("start" in ref) || !(ref.start >= 1) || !(ref.length >= 1)) out.push(`${FIELD_LABEL[k as PadronField] ?? k}: falta la posición y el largo.`);
    } else if (!("index" in ref) || !(ref.index >= 1)) {
      out.push(`${FIELD_LABEL[k as PadronField] ?? k}: falta el número de columna.`);
    }
  }
  if (c.rate_divisor != null && !(c.rate_divisor > 0)) out.push("La escala de la alícuota tiene que ser mayor que cero.");
  if (c.file_type === "delimited" && c.separator != null && c.separator.length === 0) out.push("Elegí el separador.");
  return out;
}

function cell(line: string, cells: string[] | null, ref: ColumnRef | null | undefined): string | undefined {
  if (!ref) return undefined;
  if ("start" in ref) {
    if (line.length < ref.start) return undefined;
    return line.slice(ref.start - 1, ref.start - 1 + ref.length).trim();
  }
  return cells?.[ref.index - 1]?.trim();
}

function parseRateWith(v: string | undefined, dec: "," | "." | undefined, divisor: number): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let t = s;
  if (dec === ",") t = s.replace(/\./g, "").replace(",", ".");
  else if (dec === ".") t = s.replace(/,/g, "");
  else if (s.includes(",")) t = s.replace(/\./g, "").replace(",", ".");
  const n = Number(t) / (divisor || 1);
  if (!Number.isFinite(n) || n < 0 || n > 100) return NaN;
  return Math.round(n * 10000) / 10000;
}

/** Fecha según el formato del perfil → aaaa-mm-dd (o null). */
export function parseProfileDate(v: string | undefined, fmt: DateFormat = "auto"): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (fmt === "yyyymmdd") {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    return m ? parsePadronDate(`${m[1]}-${m[2]}-${m[3]}`) : null;
  }
  if (fmt === "ddmmyyyy" && !/^\d{8}$/.test(s)) return null;
  if (fmt === "dd/mm/yyyy" && !/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(s)) return null;
  if (fmt === "yyyy-mm-dd" && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return parsePadronDate(s);
}

export type ProfileLineResult = { ok: true; row: PadronRow } | { ok: false; reason: string } | null;

export interface ProfileParseOptions {
  /** Vigencia por defecto (archivos sin columnas de fecha): el período elegido al importar. */
  period?: { from: string; to: string } | null;
  /** Tipo del import (filtra filas de ARBA y decide a qué va una alícuota única). */
  kind?: "perception" | "retention" | "both";
}

/**
 * Lee una línea con el perfil. null = vacía o encabezado (se saltea sin
 * error). Las razones de error son las de PROFILE_REASON_LABEL.
 */
export function parseProfileLine(
  line: string,
  profile: Pick<PadronProfile, "config" | "kind">,
  opts: ProfileParseOptions = {},
): ProfileLineResult {
  const c = profile.config;
  const raw = line.replace(/\r$/, "");
  if (!raw.trim()) return null;
  const sep =
    c.separator === "\\t" ? "\t" : c.separator === "auto" ? (raw.includes(";") ? ";" : ",") : (c.separator ?? ";");
  const cells = c.file_type === "delimited" ? raw.split(sep) : null;
  const cols = c.columns ?? {};
  const kind = opts.kind ?? profile.kind;

  const cuitRaw = cell(raw, cells, cols.cuit);
  if (cuitRaw === undefined) return c.file_type === "fixed" ? { ok: false, reason: "corta" } : { ok: false, reason: "cuit" };
  const cuit = normalizeDigits(cuitRaw);
  if (cuit.length !== 11) return /cuit/i.test(raw) || /[a-z]{3,}/i.test(cuitRaw) ? null : { ok: false, reason: "cuit" };
  if (!isValidCuit(cuit)) return { ok: false, reason: "cuit" };

  const divisor = c.rate_divisor && c.rate_divisor > 0 ? c.rate_divisor : 1;
  let per: number | null = null;
  let ret: number | null = null;
  if (cols.perception_rate || cols.retention_rate) {
    per = parseRateWith(cell(raw, cells, cols.perception_rate), c.decimal_sep, divisor);
    ret = parseRateWith(cell(raw, cells, cols.retention_rate), c.decimal_sep, divisor);
  } else {
    const rate = parseRateWith(cell(raw, cells, cols.rate), c.decimal_sep, divisor);
    if (rate == null || Number.isNaN(rate)) return { ok: false, reason: "alicuota" };
    if (cols.regime) {
      const reg = String(cell(raw, cells, cols.regime) ?? "").trim().toUpperCase();
      const pv = (c.regime_values?.perception ?? "P").toUpperCase();
      const rv = (c.regime_values?.retention ?? "R").toUpperCase();
      if (reg === pv) per = rate;
      else if (reg === rv) ret = rate;
      else return { ok: false, reason: "regimen" };
    } else if (kind === "retention") ret = rate;
    else if (kind === "perception") per = rate;
    else {
      per = rate;
      ret = rate;
    }
  }
  if (Number.isNaN(per) || Number.isNaN(ret) || (per == null && ret == null)) return { ok: false, reason: "alicuota" };
  if (kind === "perception" && per == null) return { ok: false, reason: "regimen" };
  if (kind === "retention" && ret == null) return { ok: false, reason: "regimen" };

  const fmt = c.date_format ?? "auto";
  let from = cols.valid_from ? parseProfileDate(cell(raw, cells, cols.valid_from), fmt) : (opts.period?.from ?? null);
  let to = cols.valid_to ? parseProfileDate(cell(raw, cells, cols.valid_to), fmt) : (opts.period?.to ?? null);
  if (!from && !cols.valid_from && opts.period) from = opts.period.from;
  if (!to && !cols.valid_to && opts.period) to = opts.period.to;
  if (!from || !to || from > to) return { ok: false, reason: "fecha" };

  const group = cell(raw, cells, cols.group_code);
  const name = cols.name ? (cells && "index" in cols.name ? cells.slice(cols.name.index - 1).join(sep) : cell(raw, cells, cols.name)) : null;
  return {
    ok: true,
    row: {
      cuit,
      valid_from: from,
      valid_to: to,
      perception_rate: kind === "retention" ? null : per,
      retention_rate: kind === "perception" ? null : ret,
      group_code: group ? group.slice(0, 10) : null,
      name: name ? name.trim().slice(0, 120) || null : null,
    },
  };
}

export interface ProfileParseError {
  line: number;
  reason: string;
  text: string;
}

export interface ProfileParseResult {
  rows: PadronRow[];
  errors: ProfileParseError[];
  skipped: number;
  lines: number;
  period: { from: string | null; to: string | null };
}

/**
 * Lector incremental con perfil (mismo uso que PadronReader): `push` pedazos,
 * `take` las filas leídas, `finish` al terminar. `only` filtra a los CUIT de
 * clientes y proveedores. Guarda las primeras `maxErrors` filas con error con
 * su número de línea y el texto, para mostrarlas antes de aplicar.
 */
export class ProfileReader {
  private rest = "";
  private lineNo = 0;
  private out: PadronRow[] = [];
  private errors: ProfileParseError[] = [];
  private errorCount = 0;
  private skipped = 0;
  private from: string | null = null;
  private to: string | null = null;
  private toSkip: number;
  constructor(
    private profile: Pick<PadronProfile, "config" | "kind">,
    private opts: ProfileParseOptions & { only?: Set<string> | null; maxErrors?: number } = {},
  ) {
    this.toSkip = Math.max(0, profile.config.skip_lines ?? 0) + (profile.config.has_header ? 1 : 0);
  }

  push(chunk: string): void {
    const text = this.rest + chunk;
    const parts = text.split("\n");
    this.rest = parts.pop() ?? "";
    for (const p of parts) this.handle(p);
  }

  take(): PadronRow[] {
    const r = this.out;
    this.out = [];
    return r;
  }

  finish(): ProfileParseResult {
    if (this.rest) this.handle(this.rest);
    this.rest = "";
    return {
      rows: this.take(),
      errors: this.errors,
      skipped: this.skipped,
      lines: this.lineNo,
      period: { from: this.from, to: this.to },
    };
  }

  get errorTotal() {
    return this.errorCount;
  }

  private handle(line: string) {
    this.lineNo += 1;
    if (this.toSkip > 0 && line.trim()) {
      this.toSkip -= 1;
      return;
    }
    const res = parseProfileLine(line, this.profile, this.opts);
    if (res == null) return;
    if (!res.ok) {
      this.errorCount += 1;
      if (this.errors.length < (this.opts.maxErrors ?? 200)) {
        this.errors.push({ line: this.lineNo, reason: res.reason, text: line.replace(/\r$/, "").slice(0, 160) });
      }
      return;
    }
    const row = res.row;
    if (!this.from || row.valid_from < this.from) this.from = row.valid_from;
    if (!this.to || row.valid_to > this.to) this.to = row.valid_to;
    if (this.opts.only && !this.opts.only.has(row.cuit)) {
      this.skipped += 1;
      return;
    }
    this.out.push(row);
  }
}

/** Vista previa: lee el texto con el perfil y devuelve las primeras filas y errores. */
export function previewProfile(
  text: string,
  profile: Pick<PadronProfile, "config" | "kind">,
  opts: ProfileParseOptions & { limit?: number } = {},
): ProfileParseResult & { sample: PadronRow[] } {
  const r = new ProfileReader(profile, { ...opts, maxErrors: 50 });
  r.push(text);
  const res = r.finish();
  return { ...res, sample: res.rows.slice(0, opts.limit ?? 20) };
}

/** Separadores y formatos para la pantalla. */
export const SEPARATORS = [
  { value: "auto", label: "Detectar (; o ,)" },
  { value: ";", label: "Punto y coma (;)" },
  { value: ",", label: "Coma (,)" },
  { value: "|", label: "Barra (|)" },
  { value: "\\t", label: "Tabulador" },
];

export const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: "auto", label: "Detectar (ddmmaaaa, dd/mm/aaaa o aaaa-mm-dd)" },
  { value: "ddmmyyyy", label: "ddmmaaaa (01102026)" },
  { value: "dd/mm/yyyy", label: "dd/mm/aaaa (01/10/2026)" },
  { value: "yyyy-mm-dd", label: "aaaa-mm-dd (2026-10-01)" },
  { value: "yyyymmdd", label: "aaaammdd (20261001)" },
];
