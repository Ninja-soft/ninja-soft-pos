import type ExcelJS from "exceljs";
import type { ZodType } from "zod";

// Helper único de import XLSX (TX-4, ADR-078). Parser genérico dirigido por una
// especificación de columnas: lee el workbook con exceljs, ubica la fila de
// encabezados, mapea encabezados a campos (tolerante a mayúsculas, acentos,
// guiones bajos y al asterisco de "obligatoria"), valida tipo y obligatoriedad
// por celda, corre un schema Zod por fila y devuelve filas tipadas con sus
// errores por fila y su número real de fila en el archivo. Reusa el modelo de
// columnas de `exportXlsx` (header/key) para que plantilla, export e import
// hablen el mismo idioma. Lo usan productos, clientes, stock, listas de
// precios, sucursales, garantías y motivos (lib/import).

/** Tipo de dato esperado en una columna del archivo importado. */
export type ImportFieldType = "text" | "number" | "boolean" | "date";

/** Resultado de un transform: el valor normalizado o un error. */
export type TransformResult = { value: unknown } | { error: string };

/**
 * Especificación de una columna del archivo a importar.
 *
 * El `transform` recibe el valor ya convertido al tipo declarado (`number`,
 * `boolean`, `string`, o `string` yyyy-mm-dd para `date`), o `null` si la
 * celda venía vacía. Para no obligar a cada spec a tipar el parámetro como
 * `unknown`, la firma usa un parámetro contravariante (`never`).
 */
export interface ImportColumn {
  /** Encabezado tal cual aparece (o debería aparecer) en el XLSX. */
  header: string;
  /** Clave del campo en la fila tipada de salida. */
  key: string;
  /** Tipo esperado. Default: "text". */
  type?: ImportFieldType;
  /** Si la celda es obligatoria (vacía => error en la fila). */
  required?: boolean;
  /**
   * Alias de encabezado aceptados. Se comparan normalizados (sin acentos ni
   * mayúsculas), así que "Código de barras" y "codigo_de_barras" son iguales.
   */
  aliases?: string[];
  /**
   * Normaliza/valida el valor ya convertido. Devolvé `{ value }` con el valor
   * final o `{ error }` con el motivo. Si se omite, se usa el valor convertido.
   * `raw` es el texto crudo de la celda (útil para enums por etiqueta).
   */
  transform?: (value: never, raw: string) => TransformResult;
}

/** Una fila parseada: los valores tipados + sus errores (vacío = válida). */
export interface ParsedRow<R> {
  /** Número de fila en el archivo (1-based, el que ve el usuario en Excel). */
  rowNumber: number;
  /** Valores ya tipados/normalizados según el spec. */
  data: R;
  /** Errores de esta fila. Si está vacío, la fila es válida. */
  errors: string[];
}

/** Resultado del parseo: filas + un error global si el archivo no es legible. */
export interface ParseXlsxResult<R> {
  rows: ParsedRow<R>[];
  /** Error que impide procesar el archivo entero (no es por fila). */
  fatalError: string | null;
  /** Encabezados del archivo que no corresponden a ninguna columna (se ignoran). */
  ignoredHeaders?: string[];
}

/** Opciones del parser. */
export interface ParseXlsxOptions {
  /**
   * Clave (o claves, para una clave compuesta) del spec para detectar
   * duplicados dentro del mismo archivo. Las filas repetidas (mismo valor,
   * sin distinguir mayúsculas) se marcan con error. Las celdas vacías no
   * cuentan como duplicado.
   */
  dedupeKey?: string | string[];
  /** Validación Zod de la fila ya tipada (se corre si la fila no tiene errores de celda). */
  schema?: ZodType<unknown>;
  /** Hoja a leer (por nombre, sin distinguir mayúsculas). Default: la primera de datos. */
  sheetName?: string;
}

/** Hojas que nunca son de datos (las agrega la plantilla). */
const NON_DATA_SHEETS = new Set(["instrucciones", "ayuda", "help", "listas"]);

/**
 * Normaliza un encabezado para compararlo: minúsculas, sin acentos, sin
 * asterisco de obligatoria ni texto entre paréntesis, y con guiones bajos,
 * guiones y puntos convertidos a espacios.
 */
export function normalizeHeader(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\*/g, " ")
    .replace(/[_\-.:/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extrae el texto plano de una celda de exceljs, contemplando rich text,
// hipervínculos, fórmulas (donde el valor real está en `.result`) y fechas.
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const o = value as unknown as Record<string, unknown>;
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>)
        .map((p) => p.text ?? "")
        .join("");
    }
    if ("text" in o && o.text != null && typeof o.text === "string") {
      return o.text;
    }
    if ("result" in o && o.result != null) {
      return o.result instanceof Date ? o.result.toISOString() : String(o.result);
    }
  }
  return String(value);
}

// Convierte un texto crudo a número admitiendo coma decimal y separadores de
// miles simples ("1.234,56" → 1234.56; "1234.56" → 1234.56; "$ 1.500,00" →
// 1500). Sin coma, el punto es decimal: las celdas numéricas de Excel llegan
// como "1.125" y no se pueden confundir con miles.
export function toNumber(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  let s = t.replace(/\s/g, "").replace(/^\$/, "").replace(/%$/, "");
  if (s.includes(",")) {
    // Formato es-AR: puntos de miles y coma decimal.
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Convierte un texto a booleano admitiendo si/no, true/false, 1/0, x.
export function toBoolean(raw: string): boolean | null {
  const t = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (t === "") return null;
  if (["si", "true", "verdadero", "1", "x", "yes", "y", "activo", "activa"].includes(t)) {
    return true;
  }
  if (["no", "false", "falso", "0", "n", "inactivo", "inactiva"].includes(t)) return false;
  return null;
}

// Fecha: dd/mm/aaaa, aaaa-mm-dd o ISO (celda de fecha de Excel) → aaaa-mm-dd.
export function toIsoDay(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  let y: number, m: number, d: number;
  if (dmy) {
    d = Number(dmy[1]);
    m = Number(dmy[2]);
    y = Number(dmy[3]);
  } else if (ymd) {
    y = Number(ymd[1]);
    m = Number(ymd[2]);
    d = Number(ymd[3]);
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Grilla leída del archivo: celdas como texto + número real de cada fila. */
export interface ImportGrid {
  cells: string[][];
  rowNumbers: number[];
}

// Candidatos normalizados de una columna (encabezado + alias).
function candidatesOf(col: ImportColumn): string[] {
  return [col.header, ...(col.aliases ?? [])].map(normalizeHeader);
}

// Busca la fila de encabezados en las primeras filas: la que más columnas del
// spec reconoce (la plantilla puede traer un título arriba). Default: la 1ª.
function findHeaderRow(cells: string[][], columns: ImportColumn[]): number {
  const all = new Set(columns.flatMap(candidatesOf));
  let best = 0;
  let bestHits = 0;
  for (let i = 0; i < Math.min(cells.length, 10); i++) {
    const hits = new Set(cells[i]!.map(normalizeHeader).filter((h) => all.has(h))).size;
    if (hits > bestHits) {
      best = i;
      bestHits = hits;
    }
  }
  return best;
}

function dedupeValue(data: Record<string, unknown>, keys: string[]): string {
  const parts = keys.map((k) => {
    const v = data[k];
    return v == null ? "" : String(v).trim().toLowerCase();
  });
  return parts.every((p) => p === "") ? "" : parts.join("\u0001");
}

/**
 * Mapea la grilla (fila de encabezados incluida) a filas tipadas según el
 * spec. Centraliza toda la validación por celda. Exportada para tests y para
 * imports que ya tienen la grilla.
 */
export function parseImportGrid<R>(
  grid: string[][] | ImportGrid,
  columns: ImportColumn[],
  options: ParseXlsxOptions = {},
): ParseXlsxResult<R> {
  const cells = Array.isArray(grid) ? grid : grid.cells;
  const rowNumbers = Array.isArray(grid) ? cells.map((_, i) => i + 1) : grid.rowNumbers;
  if (cells.length === 0) {
    return { rows: [], fatalError: "El archivo está vacío." };
  }
  const headerIdx = findHeaderRow(cells, columns);
  const header = cells[headerIdx]!.map(normalizeHeader);

  // Resuelve el índice de columna para un spec (por header o alias).
  const colIndex = new Map<string, number>();
  const used = new Set<number>();
  const missingRequired: string[] = [];
  for (const col of columns) {
    let idx = -1;
    for (const cand of candidatesOf(col)) {
      const found = header.findIndex((h, i) => h === cand && !used.has(i));
      if (found !== -1) {
        idx = found;
        break;
      }
    }
    colIndex.set(col.key, idx);
    if (idx !== -1) used.add(idx);
    if (idx === -1 && col.required) missingRequired.push(col.header);
  }

  if (missingRequired.length > 0) {
    return {
      rows: [],
      fatalError: `Faltan columnas obligatorias: ${missingRequired
        .map((h) => `"${h}"`)
        .join(", ")}. Revisá que la primera fila tenga los encabezados de la plantilla.`,
    };
  }

  const ignoredHeaders = cells[headerIdx]!
    .map((h, i) => (h.trim() !== "" && !used.has(i) ? h.trim() : null))
    .filter((h): h is string => h !== null);

  const dedupeKeys = options.dedupeKey
    ? Array.isArray(options.dedupeKey)
      ? options.dedupeKey
      : [options.dedupeKey]
    : [];
  const headerByKey = new Map(columns.map((c) => [c.key, c.header]));
  const seen = new Map<string, number>(); // valor normalizado → primera fila
  const rows: ParsedRow<R>[] = [];

  for (let r = headerIdx + 1; r < cells.length; r++) {
    const rowCells = cells[r]!;
    // Saltar filas totalmente vacías (sin ruido de "fila X vacía").
    if (rowCells.every((c) => c.trim() === "")) continue;
    const rowNumber = rowNumbers[r] ?? r + 1;

    const data: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const col of columns) {
      const idx = colIndex.get(col.key)!;
      const raw = idx >= 0 ? (rowCells[idx] ?? "").trim() : "";

      if (raw === "") {
        data[col.key] = null;
        // Corremos el transform aunque esté vacía: puede aplicar un default
        // (value) o un error propio más específico que el genérico.
        if (col.transform) {
          const out = col.transform(null as never, raw);
          if ("value" in out) {
            data[col.key] = out.value;
          } else if (col.required) {
            errors.push(out.error);
          }
        } else if (col.required) {
          errors.push(`Falta "${col.header}".`);
        }
        continue;
      }

      // Conversión por tipo.
      let converted: unknown = raw;
      if (col.type === "number") {
        const n = toNumber(raw);
        if (n === null) {
          errors.push(`"${col.header}" no es un número válido ("${raw}").`);
          data[col.key] = null;
          continue;
        }
        converted = n;
      } else if (col.type === "boolean") {
        const b = toBoolean(raw);
        if (b === null) {
          errors.push(`"${col.header}" no es sí/no ("${raw}").`);
          data[col.key] = null;
          continue;
        }
        converted = b;
      } else if (col.type === "date") {
        const d = toIsoDay(raw);
        if (d === null) {
          errors.push(`"${col.header}" no es una fecha válida ("${raw}"). Usá dd/mm/aaaa.`);
          data[col.key] = null;
          continue;
        }
        converted = d;
      }

      // Normalización/validación custom.
      if (col.transform) {
        const out = col.transform(converted as never, raw);
        if ("error" in out) {
          errors.push(out.error);
          data[col.key] = converted;
          continue;
        }
        converted = out.value;
      }
      data[col.key] = converted;
    }

    // Validación Zod de la fila completa (reglas entre columnas, rangos).
    if (options.schema && errors.length === 0) {
      const res = options.schema.safeParse(data);
      if (!res.success) {
        for (const issue of res.error.issues) {
          const key = String(issue.path[0] ?? "");
          const label = headerByKey.get(key);
          errors.push(label ? `"${label}": ${issue.message}` : issue.message);
        }
      } else if (res.data && typeof res.data === "object") {
        Object.assign(data, res.data);
      }
    }

    // Duplicados dentro del archivo.
    if (dedupeKeys.length > 0) {
      const norm = dedupeValue(data, dedupeKeys);
      if (norm !== "") {
        const first = seen.get(norm);
        if (first !== undefined) {
          errors.push(`Duplicado en el archivo (igual a la fila ${first}).`);
        } else {
          seen.set(norm, rowNumber);
        }
      }
    }

    rows.push({ rowNumber, data: data as R, errors });
  }

  if (rows.length === 0) {
    return { rows: [], fatalError: "El archivo no tiene filas de datos.", ignoredHeaders };
  }
  return { rows, fatalError: null, ignoredHeaders };
}

// Lee una worksheet (cargada entera) a una grilla de strings con el número
// real de cada fila (las filas vacías intermedias no se cuentan dos veces).
function worksheetToGrid(ws: ExcelJS.Worksheet): ImportGrid {
  const cells: string[][] = [];
  const rowNumbers: number[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const out: string[] = [];
    const count = row.cellCount;
    for (let c = 1; c <= count; c++) {
      out.push(cellText(row.getCell(c).value).trim());
    }
    cells.push(out);
    rowNumbers.push(rowNumber);
  });
  return { cells, rowNumbers };
}

function pickSheet(wb: ExcelJS.Workbook, sheetName?: string): ExcelJS.Worksheet | undefined {
  if (sheetName) {
    const want = normalizeHeader(sheetName);
    const named = wb.worksheets.find((w) => normalizeHeader(w.name) === want);
    if (named) return named;
  }
  return wb.worksheets.find((w) => !NON_DATA_SHEETS.has(normalizeHeader(w.name))) ?? wb.worksheets[0];
}

async function loadGrid(
  buffer: ArrayBuffer,
  sheetName?: string,
  firstSheet = false,
): Promise<{ grid: ImportGrid | null; fatalError: string | null }> {
  try {
    // exceljs se carga bajo demanda: sólo hace falta al importar un archivo.
    const { default: Excel } = await import("exceljs");
    const wb = new Excel.Workbook();
    await wb.xlsx.load(buffer);
    const ws = firstSheet ? wb.worksheets[0] : pickSheet(wb, sheetName);
    if (!ws) return { grid: null, fatalError: "El archivo no tiene hojas." };
    return { grid: worksheetToGrid(ws), fatalError: null };
  } catch {
    return {
      grid: null,
      fatalError: "No se pudo leer el archivo. Asegurate de que sea un .xlsx válido.",
    };
  }
}

/**
 * Parser principal de import. Lee un XLSX (ArrayBuffer) y devuelve filas
 * tipadas + errores por fila según el `columns` spec. No lanza ante un archivo
 * mal formado: devuelve `fatalError` con un mensaje claro.
 */
export async function parseXlsx<R>(
  buffer: ArrayBuffer,
  columns: ImportColumn[],
  options: ParseXlsxOptions = {},
): Promise<ParseXlsxResult<R>> {
  const { grid, fatalError } = await loadGrid(buffer, options.sheetName);
  if (!grid) return { rows: [], fatalError };
  return parseImportGrid<R>(grid, columns, options);
}

/**
 * Lee la primera hoja de datos como matriz de textos (fila 0 = encabezado),
 * sin spec de columnas: para imports donde el usuario mapea las columnas
 * (lista de precios del proveedor, ADR-059).
 */
export async function readXlsxGrid(buffer: ArrayBuffer): Promise<{ grid: string[][]; fatalError: string | null }> {
  const { grid, fatalError } = await loadGrid(buffer, undefined, true);
  if (!grid) return { grid: [], fatalError };
  if (grid.cells.length === 0) return { grid: [], fatalError: "El archivo está vacío." };
  return { grid: grid.cells, fatalError: null };
}

/** Devuelve solo las filas válidas (sin errores) ya tipadas. */
export function validRows<R>(result: ParseXlsxResult<R>): R[] {
  return result.rows.filter((r) => r.errors.length === 0).map((r) => r.data);
}

/** Cuenta válidas vs. con error. */
export function countRows<R>(result: ParseXlsxResult<R>): {
  valid: number;
  invalid: number;
} {
  let valid = 0;
  let invalid = 0;
  for (const r of result.rows) {
    if (r.errors.length === 0) valid++;
    else invalid++;
  }
  return { valid, invalid };
}
