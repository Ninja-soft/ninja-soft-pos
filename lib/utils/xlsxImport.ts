import ExcelJS from "exceljs";

// Helper único de import XLSX (TX-3). Parser genérico dirigido por una
// especificación de columnas: lee el workbook con exceljs, mapea encabezados a
// campos, valida tipo/obligatoriedad por celda y devuelve filas tipadas con sus
// errores por fila. Reutilizable por productos, clientes y futuros datos
// maestros. Reusa el mismo modelo de columnas que `exportXlsx` (header/key) para
// que plantilla, export e import hablen el mismo idioma.

/** Tipo de dato esperado en una columna del archivo importado. */
export type ImportFieldType = "text" | "number" | "boolean";

/** Resultado de un transform: el valor normalizado o un error. */
export type TransformResult = { value: unknown } | { error: string };

/**
 * Especificación de una columna del archivo a importar.
 *
 * El `transform` recibe el valor ya convertido al tipo declarado (`number`,
 * `boolean` o `string`) — o `null` si la celda venía vacía. Para no obligar a
 * cada spec a tipar el parámetro como `unknown`, la firma usa un parámetro
 * contravariante (`never`): cualquier función `(v: number | null) => ...`,
 * `(v: string | null) => ...`, etc. es asignable.
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
   * Alias de encabezado aceptados (en minúscula). Permite que la plantilla diga
   * "precio" pero el archivo del usuario traiga "price", etc.
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
  /** Número de fila en el archivo (1-based, incluye el encabezado). */
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
}

/** Opciones del parser. */
export interface ParseXlsxOptions {
  /**
   * Clave (del spec) para detectar duplicados dentro del mismo archivo. Las
   * filas repetidas (mismo valor, case-insensitive) se marcan con error. Las
   * celdas vacías no cuentan como duplicado.
   */
  dedupeKey?: string;
}

// Extrae el texto plano de una celda de exceljs, contemplando rich text,
// hipervínculos y fórmulas (donde el valor real está en `.result`).
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
    if ("result" in o && o.result != null) return String(o.result);
  }
  return String(value);
}

// Convierte un texto crudo a número admitiendo coma decimal y separadores de
// miles simples ("1.234,56" → 1234.56; "1234.56" → 1234.56). Devuelve null si
// no es un número válido.
function toNumber(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  let s = t.replace(/\s/g, "");
  // Si tiene coma como separador decimal (formato es-AR), sacamos los puntos de
  // miles y pasamos la coma a punto.
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Convierte un texto a booleano admitiendo si/no, true/false, 1/0, x.
function toBoolean(raw: string): boolean | null {
  const t = raw.trim().toLowerCase();
  if (t === "") return null;
  if (["si", "sí", "true", "verdadero", "1", "x", "yes", "y"].includes(t)) {
    return true;
  }
  if (["no", "false", "falso", "0", "n"].includes(t)) return false;
  return null;
}

// Mapea el grid (matriz de strings, fila 0 = encabezado) a filas tipadas según
// el spec. Centraliza toda la validación por celda.
function gridToRows<R>(
  grid: string[][],
  columns: ImportColumn[],
  options: ParseXlsxOptions,
): ParseXlsxResult<R> {
  if (grid.length === 0) {
    return { rows: [], fatalError: "El archivo está vacío." };
  }
  const header = grid[0]!.map((h) => h.trim().toLowerCase());

  // Resuelve el índice de columna para un spec (por header o alias).
  const colIndex = new Map<string, number>();
  const missingRequired: string[] = [];
  for (const col of columns) {
    const candidates = [col.header.toLowerCase(), ...(col.aliases ?? [])];
    let idx = -1;
    for (const cand of candidates) {
      const found = header.indexOf(cand);
      if (found !== -1) {
        idx = found;
        break;
      }
    }
    colIndex.set(col.key, idx);
    if (idx === -1 && col.required) missingRequired.push(col.header);
  }

  if (missingRequired.length > 0) {
    return {
      rows: [],
      fatalError: `Faltan columnas obligatorias: ${missingRequired
        .map((h) => `"${h}"`)
        .join(", ")}.`,
    };
  }

  const dedupeKey = options.dedupeKey;
  const seen = new Map<string, number>(); // valor normalizado → primera fila
  const rows: ParsedRow<R>[] = [];

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!;
    // Saltar filas totalmente vacías (sin ruido de "fila X vacía").
    if (cells.every((c) => c.trim() === "")) continue;

    const data: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const col of columns) {
      const idx = colIndex.get(col.key)!;
      const raw = idx >= 0 ? (cells[idx] ?? "").trim() : "";

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

    // Duplicados dentro del archivo.
    if (dedupeKey) {
      const v = data[dedupeKey];
      const norm = v == null ? "" : String(v).trim().toLowerCase();
      if (norm !== "") {
        const first = seen.get(norm);
        if (first !== undefined) {
          errors.push(`Duplicado en el archivo (igual a la fila ${first}).`);
        } else {
          seen.set(norm, r + 1);
        }
      }
    }

    rows.push({ rowNumber: r + 1, data: data as R, errors });
  }

  if (rows.length === 0) {
    return { rows: [], fatalError: "El archivo no tiene filas de datos." };
  }
  return { rows, fatalError: null };
}

// Lee una worksheet (cargada entera) a un grid de strings.
function worksheetToGrid(ws: ExcelJS.Worksheet): string[][] {
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // includeEmpty:true para preservar el alineado de columnas con huecos.
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(cellText(cell.value).trim());
    });
    grid.push(cells);
  });
  return grid;
}

/**
 * Parser principal de import. Lee un XLSX (ArrayBuffer) y devuelve filas
 * tipadas + errores por fila según el `columns` spec. No lanza ante un archivo
 * mal formado: devuelve `fatalError` con un mensaje claro.
 *
 * @param buffer  contenido del .xlsx
 * @param columns especificación de columnas (headers, tipos, required, transform)
 * @param options dedupeKey
 */
export async function parseXlsx<R>(
  buffer: ArrayBuffer,
  columns: ImportColumn[],
  options: ParseXlsxOptions = {},
): Promise<ParseXlsxResult<R>> {
  let grid: string[][];
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) {
      return { rows: [], fatalError: "El archivo no tiene hojas." };
    }
    grid = worksheetToGrid(ws);
  } catch {
    return {
      rows: [],
      fatalError:
        "No se pudo leer el archivo. Asegurate de que sea un .xlsx válido.",
    };
  }
  return gridToRows<R>(grid, columns, options);
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
