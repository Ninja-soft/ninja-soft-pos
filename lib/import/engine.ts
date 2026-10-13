// Motor único de importación XLSX (TX-4, ADR-078). Puro (sin React ni
// Supabase) para poder testearlo:
//   1) parseImportFile: lee el XLSX con el spec de la definición (encabezados
//      tolerantes, tipos, Zod por fila, duplicados, filas vacías).
//   2) buildPayloads / chunk: filas válidas → lotes para la RPC (con `_row`).
//   3) mergeServerResults + buildOutcomes: une la validación local con lo que
//      decidió el servidor (crear, actualizar, omitir, error) por fila.
//   4) templateSheets / errorReportSheets: hojas para exportXlsx (plantilla
//      con "Instrucciones" y listas desplegables; reporte de errores por fila).
import {
  parseXlsx,
  type ParseXlsxResult,
  type ParsedRow,
} from "@/lib/utils/xlsxImport";
import type { XlsxColumn, XlsxSheet } from "@/lib/utils/xlsx";
import { importErrorMessage, importNoteMessage } from "./messages";
import type {
  ImportContext,
  ImportCounts,
  ImportDefinition,
  ImportField,
  ImportOutcome,
  ServerImportResult,
} from "./types";

/** Filas por llamada a la RPC (el servidor acepta hasta 1000). */
export const IMPORT_CHUNK_SIZE = 250;

/** Lee el archivo con el spec de la definición. */
export function parseImportFile<R>(
  def: ImportDefinition<R>,
  buffer: ArrayBuffer,
  ctx: ImportContext = {},
): Promise<ParseXlsxResult<R>> {
  return parseXlsx<R>(buffer, def.fields(ctx), {
    dedupeKey: def.dedupeKey,
    schema: def.schema?.(ctx),
    sheetName: def.sheetName,
  });
}

/** Filas válidas → objetos para la RPC, con su número de fila. */
export function buildPayloads<R>(def: ImportDefinition<R>, rows: ParsedRow<R>[]): Record<string, unknown>[] {
  return rows
    .filter((r) => r.errors.length === 0)
    .map((r) => ({
      ...(def.toPayload ? def.toPayload(r.data) : (r.data as Record<string, unknown>)),
      _row: r.rowNumber,
    }));
}

export function chunk<T>(items: T[], size = IMPORT_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Une las respuestas de varios lotes. */
export function mergeServerResults(parts: ServerImportResult[]): ServerImportResult {
  return parts.reduce<ServerImportResult>(
    (acc, p) => ({
      applied: acc.applied || p.applied,
      created: acc.created + (p.created ?? 0),
      updated: acc.updated + (p.updated ?? 0),
      skipped: acc.skipped + (p.skipped ?? 0),
      errors: acc.errors + (p.errors ?? 0),
      rows: acc.rows.concat(p.rows ?? []),
    }),
    { applied: false, created: 0, updated: 0, skipped: 0, errors: 0, rows: [] },
  );
}

/**
 * Destino de cada fila del archivo: las que fallan la validación local quedan
 * como error (no viajan al servidor); el resto toma la acción que devolvió el
 * servidor. Sin respuesta del servidor (todavía no se revisó) quedan "create".
 */
export function buildOutcomes<R>(
  rows: ParsedRow<R>[],
  server: ServerImportResult | null,
): ImportOutcome<R>[] {
  const byRow = new Map((server?.rows ?? []).map((r) => [r.row, r]));
  return rows.map((r) => {
    if (r.errors.length > 0) {
      return { rowNumber: r.rowNumber, data: r.data, action: "error", messages: r.errors };
    }
    const s = byRow.get(r.rowNumber);
    if (!s) {
      return {
        rowNumber: r.rowNumber,
        data: r.data,
        action: server ? "error" : "create",
        messages: server ? ["El servidor no devolvió resultado para esta fila."] : [],
      };
    }
    if (s.action === "error") {
      return { rowNumber: r.rowNumber, data: r.data, action: "error", messages: [importErrorMessage(s.message)] };
    }
    const note = importNoteMessage(s.message);
    return { rowNumber: r.rowNumber, data: r.data, action: s.action, messages: note ? [note] : [] };
  });
}

export function countOutcomes<R>(outcomes: ImportOutcome<R>[]): ImportCounts {
  const c: ImportCounts = { create: 0, update: 0, skip: 0, error: 0 };
  for (const o of outcomes) c[o.action]++;
  return c;
}

/** Encabezado de la plantilla: con asterisco si la columna es obligatoria. */
export function templateHeader(f: ImportField): string {
  return f.required ? `${f.header} *` : f.header;
}

function fieldColumns(fields: ImportField[], markRequired: boolean): XlsxColumn[] {
  return fields.map((f) => ({
    header: markRequired ? templateHeader(f) : f.header,
    key: f.key,
    type: f.cellType,
    width: f.width ?? Math.max(14, f.header.length + 6),
    options: f.options && f.options.length > 0 ? f.options : undefined,
  }));
}

/** Columnas de export (mismos encabezados que la plantilla, sin asterisco). */
export function exportColumns<R>(def: ImportDefinition<R>, ctx: ImportContext = {}): XlsxColumn[] {
  return fieldColumns(def.fields(ctx), false);
}

/** Hojas de la plantilla: datos (con ejemplo y listas) + "Instrucciones". */
export function templateSheets<R>(def: ImportDefinition<R>, ctx: ImportContext = {}): XlsxSheet[] {
  const fields = def.fields(ctx);
  return [
    {
      name: def.sheetName,
      columns: fieldColumns(fields, true),
      rows: def.example(ctx),
    },
    {
      name: "Instrucciones",
      title: `Cómo completar la planilla de ${def.plural}`,
      subtitle: `${def.intro} ${def.matchRule}`,
      columns: [
        { header: "Columna", key: "col", width: 24 },
        { header: "Obligatoria", key: "req", width: 12 },
        { header: "Qué poner", key: "help", width: 72 },
        { header: "Valores posibles", key: "opts", width: 40 },
      ],
      rows: [
        ...fields.map((f) => ({
          col: f.header,
          req: f.required ? "Sí" : "No",
          help: f.help,
          opts: f.options?.join(", ") ?? "",
        })),
        { col: "", req: "", help: "", opts: "" },
        {
          col: "Importante",
          req: "",
          help: "Completá la hoja de datos desde la fila 2 (la fila 1 son los encabezados). Borrá la fila de ejemplo antes de importar. Las columnas marcadas con * son obligatorias. Una celda vacía en una fila que actualiza no cambia ese dato.",
          opts: "",
        },
        {
          col: "Antes de guardar",
          req: "",
          help: "Al importar vas a ver qué filas se crean, cuáles se actualizan, cuáles se omiten y por qué. No se guarda nada hasta que confirmes.",
          opts: "",
        },
      ],
    },
  ];
}

/** Hojas del reporte de errores: las filas con error y su motivo + los datos. */
export function errorReportSheets<R>(
  def: ImportDefinition<R>,
  outcomes: ImportOutcome<R>[],
  ctx: ImportContext = {},
): XlsxSheet[] {
  const fields = def.fields(ctx);
  const bad = outcomes.filter((o) => o.action === "error");
  return [
    {
      name: "Errores",
      title: `Filas con error · ${def.title}`,
      subtitle: "Corregí estas filas en tu archivo y volvé a importarlo. Las demás filas no hace falta repetirlas.",
      columns: [
        { header: "Fila", key: "__row", type: "number", width: 8 },
        { header: "Motivo", key: "__why", width: 60 },
        ...fieldColumns(fields, false).map((c) => ({ ...c, options: undefined })),
      ],
      rows: bad.map((o) => ({
        ...(o.data as Record<string, unknown>),
        __row: o.rowNumber,
        __why: o.messages.join(" "),
      })),
    },
  ];
}
