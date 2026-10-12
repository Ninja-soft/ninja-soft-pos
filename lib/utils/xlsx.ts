// Export XLSX con diseño (reemplazo de CSV). Ver roadmap TX-2.
// Encabezado con color de marca, filas alternadas, fila de totales, formato de
// moneda/fecha, autofilter y header congelado. Helper único reutilizable.
// El armado del workbook vive en ./xlsxWorkbook y se carga bajo demanda:
// exceljs pesa ~250 kB gzip y sólo hace falta al exportar.

export type XlsxCellType = "text" | "money" | "number" | "date";

export interface XlsxColumn {
  header: string;
  key: string;
  type?: XlsxCellType;
  width?: number;
  /** Lista desplegable (validación de datos) en las filas de esta columna. */
  options?: readonly string[];
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

/** Construye y descarga el XLSX en el navegador. */
export async function exportXlsx(
  fileName: string,
  sheets: XlsxSheet[],
  opts: XlsxOptions = {},
): Promise<void> {
  const { buildWorkbook } = await import("./xlsxWorkbook");
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
