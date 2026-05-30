import ExcelJS from "exceljs";

// Export XLSX con diseño (reemplazo de CSV). Ver roadmap TX-2.
// Encabezado con color de marca, filas alternadas, fila de totales, formato de
// moneda/fecha, autofilter y header congelado. Helper único reutilizable.

export type XlsxCellType = "text" | "money" | "number" | "date";

export interface XlsxColumn {
  header: string;
  key: string;
  type?: XlsxCellType;
  width?: number;
}

export interface XlsxSheet {
  name: string;
  title?: string;
  columns: XlsxColumn[];
  rows: Array<Record<string, unknown>>;
  /** Totales por key de columna (se pinta una fila "Total" al pie). */
  totals?: Record<string, number>;
}

export interface XlsxOptions {
  /** Color de acento del encabezado (hex sin #). Default: marca NinjaPos. */
  accent?: string;
}

const DEFAULT_ACCENT = "EC3F17"; // ninja flame
const ZEBRA = "FFF3F3F5";
const WHITE = "FFFFFFFF";

function numFmtFor(type?: XlsxCellType): string | undefined {
  if (type === "money") return '"$"#,##0.00';
  if (type === "number") return "#,##0";
  if (type === "date") return "dd/mm/yyyy";
  return undefined;
}

/** Construye el workbook (separado del download para poder testearlo). */
export function buildWorkbook(
  sheets: XlsxSheet[],
  opts: XlsxOptions = {},
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NinjaPos";
  const accentArgb = "FF" + (opts.accent ?? DEFAULT_ACCENT).replace("#", "");

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    const ncols = sheet.columns.length;
    let headerRow = 1;

    if (sheet.title) {
      ws.mergeCells(1, 1, 1, ncols);
      const c = ws.getCell(1, 1);
      c.value = sheet.title;
      c.font = { bold: true, size: 14, color: { argb: WHITE } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: accentArgb } };
      c.alignment = { vertical: "middle", horizontal: "left" };
      ws.getRow(1).height = 24;
      headerRow = 2;
    }

    const hr = ws.getRow(headerRow);
    sheet.columns.forEach((col, i) => {
      const cell = hr.getCell(i + 1);
      cell.value = col.header;
      cell.font = { bold: true, color: { argb: WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: accentArgb } };
      cell.alignment = { vertical: "middle" };
    });
    hr.height = 18;

    sheet.rows.forEach((row, ri) => {
      const r = ws.getRow(headerRow + 1 + ri);
      sheet.columns.forEach((col, ci) => {
        const cell = r.getCell(ci + 1);
        cell.value = (row[col.key] ?? null) as ExcelJS.CellValue;
        const fmt = numFmtFor(col.type);
        if (fmt) cell.numFmt = fmt;
      });
      if (ri % 2 === 1) {
        r.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
        });
      }
    });

    if (sheet.totals) {
      const tr = ws.getRow(headerRow + 1 + sheet.rows.length);
      sheet.columns.forEach((col, ci) => {
        const cell = tr.getCell(ci + 1);
        if (ci === 0) {
          cell.value = "Total";
        } else if (sheet.totals![col.key] != null) {
          cell.value = sheet.totals![col.key];
          const fmt = numFmtFor(col.type);
          if (fmt) cell.numFmt = fmt;
        }
        cell.font = { bold: true };
        cell.border = { top: { style: "thin", color: { argb: "FFD0D0D5" } } };
      });
    }

    sheet.columns.forEach((col, i) => {
      ws.getColumn(i + 1).width = col.width ?? Math.max(12, col.header.length + 4);
    });

    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: headerRow, column: ncols },
    };
    ws.views = [{ state: "frozen", ySplit: headerRow }];
  }

  return wb;
}

/** Construye y descarga el XLSX en el navegador. */
export async function exportXlsx(
  fileName: string,
  sheets: XlsxSheet[],
  opts: XlsxOptions = {},
): Promise<void> {
  const wb = buildWorkbook(sheets, opts);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.endsWith(".xlsx") ? fileName : `${fileName}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
