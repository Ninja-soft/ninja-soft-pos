// Lectura de padrones de IIBB (F18 · H104, ADR-068). PURO.
//
// Formatos (texto plano, una línea por CUIT, separador ";", decimales con
// coma). Diseños de registro según la publicación de cada organismo,
// orientativos: si el organismo cambia el diseño, se ajusta acá y en los
// fixtures de tests/unit/taxPadron.test.ts.
//
// ARBA · "Padrón de regímenes generales" (PadronRGSPerMMAAAA.txt para
// percepción, PadronRGSRetMMAAAA.txt para retención; se descarga con clave
// CIT del agente):
//   Régimen (P/R); Fecha de publicación (ddmmaaaa); Vigencia desde; Vigencia
//   hasta; CUIT; Tipo de contribuyente (D directo / C convenio); Marca alta
//   sujeto (S/N/B); Marca cambio de alícuota (S/N); Alícuota (0,00); Nro. de
//   grupo.
//   Ej.: P;25022024;01032024;31032024;20123456786;D;S;N;1,50;03;
//
// AGIP · "Padrón de regímenes generales" (ARDJU008MMAAAA.txt, publicación
// mensual):
//   Fecha de publicación; Vigencia desde; Vigencia hasta; CUIT; Tipo de
//   contribuyente; Marca alta sujeto; Marca cambio de alícuota; Alícuota de
//   percepción; Alícuota de retención; Grupo de percepción; Grupo de
//   retención; Razón social.
//   Ej.: 25022024;01032024;31032024;20123456786;C;S;N;1,00;0,50;03;02;EMPRESA SA
//
// Genérico (cualquier jurisdicción, armado a mano o exportado del organismo):
//   CUIT; alícuota de percepción; alícuota de retención; vigencia desde;
//   vigencia hasta. Separador ";" o ","; fechas dd/mm/aaaa, ddmmaaaa o
//   aaaa-mm-dd; decimales con coma o punto; encabezado opcional.

import { isValidCuit, normalizeDigits } from "./catalog";

export type PadronFormat = "arba" | "agip" | "generic";

export interface PadronRow {
  cuit: string;
  valid_from: string;
  valid_to: string;
  perception_rate: number | null;
  retention_rate: number | null;
  group_code: string | null;
  name: string | null;
}

export type PadronLineResult = { ok: true; row: PadronRow } | { ok: false; reason: string } | null;

function parseRate(v: string | undefined): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  if (!Number.isFinite(n) || n < 0 || n > 100) return NaN;
  return Math.round(n * 10000) / 10000;
}

/** ddmmaaaa | dd/mm/aaaa | aaaa-mm-dd → aaaa-mm-dd (o null). */
export function parsePadronDate(v: string | undefined): string | null {
  const s = String(v ?? "").trim();
  let d: string, m: string, y: string;
  let mt = /^(\d{2})(\d{2})(\d{4})$/.exec(s);
  if (mt) [, d, m, y] = mt as unknown as [string, string, string, string];
  else if ((mt = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s))) [, d, m, y] = mt as unknown as [string, string, string, string];
  else if ((mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [, y, m, d] = mt as unknown as [string, string, string, string];
  else return null;
  const dd = d!.padStart(2, "0");
  const mm = m!.padStart(2, "0");
  const iso = `${y}-${mm}-${dd}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/**
 * Lee una línea. null = línea vacía o encabezado (se saltea sin error).
 * `kind` filtra ARBA por régimen (P percepción / R retención).
 */
export function parsePadronLine(line: string, format: PadronFormat): PadronLineResult {
  const raw = line.replace(/\r$/, "").trim();
  if (!raw) return null;
  const sep = format === "generic" && !raw.includes(";") ? "," : ";";
  const f = raw.split(sep).map((x) => x.trim());

  if (format === "arba") {
    const reg = (f[0] ?? "").toUpperCase();
    if (reg !== "P" && reg !== "R") return /cuit/i.test(raw) ? null : { ok: false, reason: "regimen" };
    const cuit = normalizeDigits(f[4]);
    if (!isValidCuit(cuit)) return { ok: false, reason: "cuit" };
    const from = parsePadronDate(f[2]);
    const to = parsePadronDate(f[3]);
    if (!from || !to || from > to) return { ok: false, reason: "fecha" };
    const rate = parseRate(f[8]);
    if (rate == null || Number.isNaN(rate)) return { ok: false, reason: "alicuota" };
    return {
      ok: true,
      row: {
        cuit,
        valid_from: from,
        valid_to: to,
        perception_rate: reg === "P" ? rate : null,
        retention_rate: reg === "R" ? rate : null,
        group_code: f[9] || null,
        name: null,
      },
    };
  }

  if (format === "agip") {
    if (!/^\d/.test(raw)) return null;
    const cuit = normalizeDigits(f[3]);
    if (!isValidCuit(cuit)) return { ok: false, reason: "cuit" };
    const from = parsePadronDate(f[1]);
    const to = parsePadronDate(f[2]);
    if (!from || !to || from > to) return { ok: false, reason: "fecha" };
    const per = parseRate(f[7]);
    const ret = parseRate(f[8]);
    if (Number.isNaN(per) || Number.isNaN(ret) || (per == null && ret == null)) return { ok: false, reason: "alicuota" };
    return {
      ok: true,
      row: {
        cuit,
        valid_from: from,
        valid_to: to,
        perception_rate: per,
        retention_rate: ret,
        group_code: f[9] || null,
        name: f[11] ? f.slice(11).join(sep).slice(0, 120) : null,
      },
    };
  }

  // Genérico.
  const cuit = normalizeDigits(f[0]);
  if (cuit.length !== 11) return /cuit/i.test(raw) ? null : { ok: false, reason: "cuit" };
  if (!isValidCuit(cuit)) return { ok: false, reason: "cuit" };
  const per = parseRate(f[1]);
  const ret = parseRate(f[2]);
  if (Number.isNaN(per) || Number.isNaN(ret) || (per == null && ret == null)) return { ok: false, reason: "alicuota" };
  const from = parsePadronDate(f[3]);
  const to = parsePadronDate(f[4]);
  if (!from || !to || from > to) return { ok: false, reason: "fecha" };
  return {
    ok: true,
    row: { cuit, valid_from: from, valid_to: to, perception_rate: per, retention_rate: ret, group_code: null, name: null },
  };
}

export interface PadronParseResult {
  rows: PadronRow[];
  errors: { line: number; reason: string }[];
  skipped: number;
  /** Vigencia más chica y más grande leída. */
  period: { from: string | null; to: string | null };
}

/** Lee un texto completo (archivos chicos y tests). Los grandes van por `PadronReader`. */
export function parsePadronText(
  text: string,
  format: PadronFormat,
  opts: { only?: Set<string> | null; maxErrors?: number } = {},
): PadronParseResult {
  const r = new PadronReader(format, opts);
  r.push(text);
  return r.finish();
}

/**
 * Lector incremental: se le pasan pedazos del archivo (como vienen del
 * stream) y entrega las filas leídas sin cargar todo en memoria. `only`
 * filtra a los CUIT conocidos (clientes y proveedores) para no subir el
 * padrón entero.
 */
export class PadronReader {
  private rest = "";
  private lineNo = 0;
  private out: PadronRow[] = [];
  private errors: { line: number; reason: string }[] = [];
  private skipped = 0;
  private from: string | null = null;
  private to: string | null = null;
  constructor(
    private format: PadronFormat,
    private opts: { only?: Set<string> | null; maxErrors?: number } = {},
  ) {}

  push(chunk: string): void {
    const text = this.rest + chunk;
    const parts = text.split("\n");
    this.rest = parts.pop() ?? "";
    for (const p of parts) this.handle(p);
  }

  /** Filas leídas desde la última llamada (y las saca del buffer). */
  take(): PadronRow[] {
    const r = this.out;
    this.out = [];
    return r;
  }

  finish(): PadronParseResult {
    if (this.rest) this.handle(this.rest);
    this.rest = "";
    return {
      rows: this.take(),
      errors: this.errors,
      skipped: this.skipped,
      period: { from: this.from, to: this.to },
    };
  }

  get errorList() {
    return this.errors;
  }

  get skippedCount() {
    return this.skipped;
  }

  get periodRead() {
    return { from: this.from, to: this.to };
  }

  private handle(line: string) {
    this.lineNo += 1;
    const res = parsePadronLine(line, this.format);
    if (res == null) return;
    if (!res.ok) {
      if (this.errors.length < (this.opts.maxErrors ?? 50)) this.errors.push({ line: this.lineNo, reason: res.reason });
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

export const PADRON_REASON_LABEL: Record<string, string> = {
  regimen: "régimen distinto de P o R",
  cuit: "CUIT inválido",
  fecha: "fecha de vigencia inválida",
  alicuota: "alícuota inválida",
};
