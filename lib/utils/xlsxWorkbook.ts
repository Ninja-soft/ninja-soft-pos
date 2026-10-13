import ExcelJS from "exceljs";
import {
  XLSX_ROW_STYLE,
  type XlsxCellType,
  type XlsxColumn,
  type XlsxOptions,
  type XlsxRowStyle,
  type XlsxSection,
  type XlsxSheet,
} from "./xlsx";

// Armado del workbook XLSX con diseño. Separado de ./xlsx para que exceljs se
// cargue sólo al exportar (import dinámico desde exportXlsx).

const DEFAULT_ACCENT = "EC3F17"; // ninja flame
const ZEBRA = "FFF3F3F5";
const WHITE = "FFFFFFFF";
const MUTED_TEXT = "FF6B6B76";
const GROUP_FILL = "FFE9E9EE";
const RULE = "FFD0D0D5";
// Filas con lista desplegable: las cargadas y unas cuantas vacías para sumar.
const LIST_ROWS = 300;

export function numFmtFor(type?: XlsxCellType): string | undefined {
  if (type === "money") return '"$"#,##0.00';
  if (type === "number") return "#,##0";
  if (type === "date") return "dd/mm/yyyy";
  if (type === "datetime") return "dd/mm/yyyy hh:mm";
  if (type === "percent") return "0.0%";
  return undefined;
}

const argb = (hex: string) => (hex.length === 8 ? hex : "FF" + hex.replace("#", "")).toUpperCase();
const solid = (color: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb: color } });

function colFmt(col: XlsxColumn): string | undefined {
  return col.numFmt ?? numFmtFor(col.type);
}

function defaultAlign(col: XlsxColumn): "left" | "center" | "right" | undefined {
  if (col.align) return col.align;
  return col.type === "money" || col.type === "number" || col.type === "percent" ? "right" : undefined;
}

/** Fila de encabezado de una tabla (texto blanco sobre el acento). */
function writeHeader(ws: ExcelJS.Worksheet, rowNum: number, columns: XlsxColumn[], accent: string) {
  const hr = ws.getRow(rowNum);
  columns.forEach((col, i) => {
    const cell = hr.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = solid(accent);
    cell.alignment = { vertical: "middle", horizontal: defaultAlign(col) ?? "left", wrapText: false };
  });
  hr.height = 20;
}

/** Filas de datos, con cebra, estilos de fila y relleno por estado. */
function writeRows(ws: ExcelJS.Worksheet, firstRow: number, columns: XlsxColumn[], rows: Array<Record<string, unknown>>) {
  rows.forEach((row, ri) => {
    const r = ws.getRow(firstRow + ri);
    const style = row[XLSX_ROW_STYLE] as XlsxRowStyle | undefined;
    columns.forEach((col, ci) => {
      const cell = r.getCell(ci + 1);
      cell.value = (row[col.key] ?? null) as ExcelJS.CellValue;
      const fmt = colFmt(col);
      if (fmt) cell.numFmt = fmt;
      const align = defaultAlign(col);
      if (align) cell.alignment = { horizontal: align };
      if (style === "subtotal" || style === "group") {
        cell.font = { bold: true };
        cell.fill = solid(GROUP_FILL);
      } else if (style === "muted") {
        cell.font = { color: { argb: MUTED_TEXT } };
      } else if (ri % 2 === 1) {
        cell.fill = solid(ZEBRA);
      }
      const st = col.status && typeof cell.value === "string" ? col.status[cell.value] : undefined;
      if (st) {
        cell.fill = solid(argb(st.fill));
        cell.font = { ...(cell.font ?? {}), color: { argb: argb(st.font ?? "1F1F24") } };
      }
    });
  });
}

/** Fila de totales con regla arriba. */
function writeTotals(
  ws: ExcelJS.Worksheet,
  rowNum: number,
  columns: XlsxColumn[],
  totals: Record<string, number>,
  label = "Total",
) {
  const tr = ws.getRow(rowNum);
  columns.forEach((col, ci) => {
    const cell = tr.getCell(ci + 1);
    if (ci === 0) {
      cell.value = label;
    } else if (totals[col.key] != null) {
      cell.value = totals[col.key];
      const fmt = colFmt(col);
      if (fmt) cell.numFmt = fmt;
      const align = defaultAlign(col);
      if (align) cell.alignment = { horizontal: align };
    }
    cell.font = { bold: true };
    cell.border = { top: { style: "thin", color: { argb: RULE } } };
  });
}

/** Listas desplegables (validación de datos). */
function writeOptions(ws: ExcelJS.Worksheet, headerRow: number, columns: XlsxColumn[], rowCount: number) {
  columns.forEach((col, ci) => {
    if (!col.options?.length) return;
    const formula = `"${col.options.join(",")}"`;
    const last = headerRow + Math.max(LIST_ROWS, rowCount + 50);
    for (let r = headerRow + 1; r <= last; r++) {
      ws.getCell(r, ci + 1).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [formula],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: col.header,
        error: `Elegí un valor de la lista: ${col.options.join(", ")}.`,
      };
    }
  });
}

/** Título (y bajada) combinados a lo ancho de la tabla. Devuelve la próxima fila libre. */
function writeTitle(ws: ExcelJS.Worksheet, sheet: XlsxSheet, ncols: number, accent: string): number {
  let row = 1;
  if (sheet.title) {
    ws.mergeCells(row, 1, row, Math.max(1, ncols));
    const c = ws.getCell(row, 1);
    c.value = sheet.title;
    c.font = { bold: true, size: 14, color: { argb: WHITE } };
    c.fill = solid(accent);
    c.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(row).height = 26;
    row++;
  }
  if (sheet.subtitle) {
    ws.mergeCells(row, 1, row, Math.max(1, ncols));
    const c = ws.getCell(row, 1);
    c.value = sheet.subtitle;
    c.font = { size: 10, color: { argb: MUTED_TEXT } };
    c.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(row).height = 18;
    row++;
  }
  return row;
}

/** Ancho de cada columna: el pedido o uno razonable por el encabezado. */
function setWidths(ws: ExcelJS.Worksheet, columns: XlsxColumn[]) {
  columns.forEach((col, i) => {
    const current = ws.getColumn(i + 1).width ?? 0;
    const want = col.width ?? Math.max(12, col.header.length + 4);
    ws.getColumn(i + 1).width = Math.max(current, want);
  });
}

function writeSections(ws: ExcelJS.Worksheet, start: number, sections: XlsxSection[], accent: string) {
  let row = start;
  sections.forEach((s, si) => {
    if (si > 0 || start > 1) row++; // aire entre tablas
    if (s.title) {
      const c = ws.getCell(row, 1);
      c.value = s.title;
      c.font = { bold: true, size: 12 };
      ws.getRow(row).height = 20;
      row++;
    }
    writeHeader(ws, row, s.columns, accent);
    writeRows(ws, row + 1, s.columns, s.rows);
    row += 1 + s.rows.length;
    if (s.totals) {
      writeTotals(ws, row, s.columns, s.totals, s.totalsLabel);
      row++;
    }
    setWidths(ws, s.columns);
  });
}

/** Construye el workbook (separado del download para poder testearlo). */
export function buildWorkbook(
  sheets: XlsxSheet[],
  opts: XlsxOptions = {},
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NinjaPos";
  const accentArgb = argb(opts.accent ?? DEFAULT_ACCENT);

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31));

    if (sheet.sections?.length) {
      const ncols = Math.max(...sheet.sections.map((s) => s.columns.length));
      const next = writeTitle(ws, sheet, ncols, accentArgb);
      writeSections(ws, next, sheet.sections, accentArgb);
      if (next > 1) ws.views = [{ state: "frozen", ySplit: next - 1 }];
      continue;
    }

    const ncols = sheet.columns.length;
    const headerRow = writeTitle(ws, sheet, ncols, accentArgb);

    writeHeader(ws, headerRow, sheet.columns, accentArgb);
    writeRows(ws, headerRow + 1, sheet.columns, sheet.rows);
    if (sheet.totals) {
      writeTotals(ws, headerRow + 1 + sheet.rows.length, sheet.columns, sheet.totals, sheet.totalsLabel);
    }
    writeOptions(ws, headerRow, sheet.columns, sheet.rows.length);
    setWidths(ws, sheet.columns);

    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: headerRow, column: ncols },
    };
    ws.views = [{ state: "frozen", ySplit: headerRow }];
  }

  return wb;
}
