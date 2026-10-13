// lib/accounting/exporters.ts
//
// Export de asientos a estudios contables (ADR-066). Formatos de texto
// (CSV / TXT) con un layout por sistema y uno genérico configurable. Los
// layouts de Tango, Holistor, Xubio y Colppy son una propuesta documentada en
// docs/31-contabilidad.md: cada estudio puede tener la importación
// configurada distinto, por eso hay vista previa y el CSV a medida cubre lo
// que no coincida. Se usa el código externo de la cuenta (código en el
// sistema del estudio) y, si falta, el código del plan de NinjaPos.

import { round2 } from "./vat";
import type { JournalEntry } from "./journal";

export type ExportFormat = "tango" | "holistor" | "xubio" | "colppy" | "generic";
export type Encoding = "utf8bom" | "latin1";
export type DateFormat = "dd/mm/yyyy" | "yyyy-mm-dd" | "yyyymmdd" | "dd-mm-yyyy";

export type GenericColumn =
  | "numero"
  | "fecha"
  | "leyenda"
  | "cuenta"
  | "cuenta_nombre"
  | "debe"
  | "haber"
  | "importe"
  | "dh"
  | "centro_costo"
  | "leyenda_renglon";

export const GENERIC_COLUMN_LABEL: Record<GenericColumn, string> = {
  numero: "N° de asiento",
  fecha: "Fecha",
  leyenda: "Leyenda del asiento",
  cuenta: "Código de cuenta",
  cuenta_nombre: "Nombre de la cuenta",
  debe: "Debe",
  haber: "Haber",
  importe: "Importe con signo (+ debe, - haber)",
  dh: "D o H",
  centro_costo: "Centro de costo",
  leyenda_renglon: "Leyenda del renglón",
};

export interface LayoutConfig {
  separator: ";" | "," | "\t" | "|";
  decimal: "," | ".";
  dateFormat: DateFormat;
  header: boolean;
  quoteAll: boolean;
  encoding: Encoding;
  columns: GenericColumn[];
  /** Usa el código externo de la cuenta cuando está cargado. */
  useExternalCode: boolean;
  extension: "csv" | "txt";
}

export interface FormatDef {
  key: ExportFormat;
  label: string;
  description: string;
  layout: LayoutConfig;
  /** Encabezados de columna (en orden) del layout. */
  headers: string[];
}

const COMMON_HEADERS: Record<GenericColumn, string> = {
  numero: "Numero",
  fecha: "Fecha",
  leyenda: "Leyenda",
  cuenta: "Cuenta",
  cuenta_nombre: "Nombre cuenta",
  debe: "Debe",
  haber: "Haber",
  importe: "Importe",
  dh: "DH",
  centro_costo: "Centro de costo",
  leyenda_renglon: "Leyenda renglon",
};

function def(
  key: ExportFormat,
  label: string,
  description: string,
  layout: LayoutConfig,
  headers?: Partial<Record<GenericColumn, string>>,
): FormatDef {
  return {
    key,
    label,
    description,
    layout,
    headers: layout.columns.map((c) => headers?.[c] ?? COMMON_HEADERS[c]),
  };
}

export const EXPORT_FORMATS: FormatDef[] = [
  def(
    "tango",
    "Tango Gestión (Contabilidad)",
    "Importación de asientos de Tango: un renglón por imputación, separado por punto y coma, con el código de cuenta de Tango.",
    {
      separator: ";",
      decimal: ",",
      dateFormat: "dd/mm/yyyy",
      header: true,
      quoteAll: false,
      encoding: "latin1",
      columns: ["numero", "fecha", "leyenda", "cuenta", "debe", "haber", "centro_costo", "leyenda_renglon"],
      useExternalCode: true,
      extension: "txt",
    },
    { numero: "Nro. asiento", leyenda: "Leyenda", leyenda_renglon: "Leyenda renglon", centro_costo: "Centro de costo" },
  ),
  def(
    "holistor",
    "Holistor Contabilidad",
    "Importación de asientos de Holistor: fecha, número, cuenta, leyenda, debe y haber, separado por punto y coma.",
    {
      separator: ";",
      decimal: ",",
      dateFormat: "dd/mm/yyyy",
      header: false,
      quoteAll: false,
      encoding: "latin1",
      columns: ["fecha", "numero", "cuenta", "leyenda", "debe", "haber", "centro_costo"],
      useExternalCode: true,
      extension: "txt",
    },
  ),
  def(
    "xubio",
    "Xubio",
    "Planilla de importación de asientos de Xubio en CSV: número, fecha, descripción, cuenta, debe, haber y centro de costo.",
    {
      separator: ",",
      decimal: ".",
      dateFormat: "dd/mm/yyyy",
      header: true,
      quoteAll: true,
      encoding: "utf8bom",
      columns: ["numero", "fecha", "leyenda", "cuenta", "debe", "haber", "centro_costo"],
      useExternalCode: true,
      extension: "csv",
    },
    { numero: "Numero de asiento", leyenda: "Descripcion", cuenta: "Cuenta contable", centro_costo: "Centro de costo" },
  ),
  def(
    "colppy",
    "Colppy",
    "CSV de asientos manuales de Colppy: fecha, descripción, cuenta, debe, haber y centro de costo.",
    {
      separator: ",",
      decimal: ".",
      dateFormat: "dd/mm/yyyy",
      header: true,
      quoteAll: true,
      encoding: "utf8bom",
      columns: ["fecha", "leyenda", "cuenta", "debe", "haber", "centro_costo", "leyenda_renglon"],
      useExternalCode: true,
      extension: "csv",
    },
    { leyenda: "Descripcion", centro_costo: "Centro de costo 1", leyenda_renglon: "Comentario" },
  ),
  def(
    "generic",
    "CSV a medida",
    "Elegí columnas, separador, decimales, fecha y codificación para el sistema de tu estudio.",
    {
      separator: ";",
      decimal: ",",
      dateFormat: "dd/mm/yyyy",
      header: true,
      quoteAll: false,
      encoding: "utf8bom",
      columns: ["numero", "fecha", "leyenda", "cuenta", "cuenta_nombre", "debe", "haber", "centro_costo", "leyenda_renglon"],
      useExternalCode: true,
      extension: "csv",
    },
  ),
];

export const FORMAT_BY_KEY = new Map(EXPORT_FORMATS.map((f) => [f.key, f]));

export function formatDate(iso: string, f: DateFormat): string {
  const y = iso.slice(0, 4);
  const m = iso.slice(5, 7);
  const d = iso.slice(8, 10);
  switch (f) {
    case "yyyy-mm-dd":
      return `${y}-${m}-${d}`;
    case "yyyymmdd":
      return `${y}${m}${d}`;
    case "dd-mm-yyyy":
      return `${d}-${m}-${y}`;
    default:
      return `${d}/${m}/${y}`;
  }
}

/** Importe con 2 decimales, sin separador de miles. */
export function formatAmount(n: number, decimal: "," | "."): string {
  const s = round2(n).toFixed(2);
  return decimal === "," ? s.replace(".", ",") : s;
}

function cell(value: string, cfg: LayoutConfig): string {
  const v = value.replace(/[\r\n]+/g, " ");
  const needs = cfg.quoteAll || v.includes(cfg.separator) || v.includes('"');
  return needs ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface ExportResult {
  fileName: string;
  mime: string;
  text: string;
  bytes: Uint8Array;
  rows: number;
}

/** Arma el archivo con los asientos (ya filtrados y, si corresponde, resumidos). */
export function buildExport(
  entries: JournalEntry[],
  format: ExportFormat,
  opts: { custom?: Partial<LayoutConfig>; baseName?: string; useOfficialNumber?: boolean } = {},
): ExportResult {
  const fmt = FORMAT_BY_KEY.get(format) ?? FORMAT_BY_KEY.get("generic")!;
  const cfg: LayoutConfig = { ...fmt.layout, ...(format === "generic" ? opts.custom : {}) };
  const headers =
    format === "generic" ? cfg.columns.map((c) => COMMON_HEADERS[c]) : fmt.headers;
  const out: string[] = [];
  if (cfg.header) out.push(headers.map((h) => cell(h, cfg)).join(cfg.separator));
  let rows = 0;
  for (const e of entries) {
    const num = String((opts.useOfficialNumber && e.official_number) || e.number);
    for (const l of e.lines) {
      const code = (cfg.useExternalCode && l.account_external_code) || l.account_code;
      const debit = Number(l.debit) || 0;
      const credit = Number(l.credit) || 0;
      const values: Record<GenericColumn, string> = {
        numero: num,
        fecha: formatDate(e.entry_date, cfg.dateFormat),
        leyenda: e.description,
        cuenta: code,
        cuenta_nombre: l.account_name,
        debe: formatAmount(debit, cfg.decimal),
        haber: formatAmount(credit, cfg.decimal),
        importe: formatAmount(debit - credit, cfg.decimal),
        dh: debit > 0 ? "D" : "H",
        centro_costo: l.cost_center_code ?? "",
        leyenda_renglon: l.description ?? "",
      };
      out.push(cfg.columns.map((c) => cell(values[c], cfg)).join(cfg.separator));
      rows++;
    }
  }
  const text = out.join("\r\n") + (out.length ? "\r\n" : "");
  const bytes = encodeText(text, cfg.encoding);
  const ext = cfg.extension;
  return {
    fileName: `${opts.baseName ?? "asientos"}-${fmt.key}.${ext}`,
    mime: ext === "csv" ? "text/csv" : "text/plain",
    text,
    bytes,
    rows,
  };
}

/** UTF-8 con BOM (Excel lo abre bien) o Latin-1 / Windows-1252 para sistemas de escritorio. */
export function encodeText(text: string, enc: Encoding): Uint8Array {
  if (enc === "utf8bom") {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c <= 0xff ? c : 0x3f; // "?" para lo que no entra en Latin-1
  }
  return out;
}

/** Descarga en el navegador. */
export function downloadExport(r: ExportResult): void {
  const blob = new Blob([r.bytes as BlobPart], { type: `${r.mime};charset=${r.bytes[0] === 0xef ? "utf-8" : "windows-1252"}` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = r.fileName;
  a.click();
  URL.revokeObjectURL(url);
}
