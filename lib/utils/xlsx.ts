// Export XLSX con diseño (reemplazo de CSV). Ver roadmap TX-2.
// Encabezado con color de marca, filas alternadas, fila de totales, formato de
// moneda/fecha, autofilter y header congelado. Helper único reutilizable.
// El armado del workbook vive en ./xlsxWorkbook y se carga bajo demanda:
// exceljs pesa ~250 kB gzip y sólo hace falta al exportar.

export type XlsxCellType = "text" | "money" | "number" | "date" | "datetime" | "percent";

/** Relleno sutil por valor de la celda (p. ej. la columna Estado). Hex sin #. */
export interface XlsxStatusStyle {
  fill: string;
  font?: string;
}

export interface XlsxColumn {
  header: string;
  key: string;
  type?: XlsxCellType;
  width?: number;
  /** Lista desplegable (validación de datos) en las filas de esta columna. */
  options?: readonly string[];
  /** Formato numérico propio (pisa el del tipo). */
  numFmt?: string;
  align?: "left" | "center" | "right";
  /** Relleno condicional por valor exacto de la celda. */
  status?: Record<string, XlsxStatusStyle>;
}

/**
 * Estilo de una fila de datos: se indica con la clave `XLSX_ROW_STYLE` en la
 * fila (`{ ..., __style: "subtotal" }`). "subtotal" y "group" van en negrita
 * con un fondo neutro; "muted" en gris.
 */
export type XlsxRowStyle = "subtotal" | "group" | "muted";
export const XLSX_ROW_STYLE = "__style";

/** Tabla dentro de una hoja con varias (hoja Resumen). */
export interface XlsxSection {
  title?: string;
  columns: XlsxColumn[];
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, number>;
  totalsLabel?: string;
}

export interface XlsxSheet {
  name: string;
  title?: string;
  /** Segunda línea del encabezado (negocio, período, sucursal). */
  subtitle?: string;
  columns: XlsxColumn[];
  rows: Array<Record<string, unknown>>;
  /** Totales por key de columna (se pinta una fila "Total" al pie). */
  totals?: Record<string, number>;
  /** Texto de la fila de totales (default "Total"). */
  totalsLabel?: string;
  /**
   * Varias tablas apiladas en la misma hoja (cada una con su encabezado). Si
   * viene, reemplaza a columns / rows / totals y la hoja no lleva autofiltro.
   */
  sections?: XlsxSection[];
}

export interface XlsxOptions {
  /** Color de acento del encabezado (hex sin #). Default: marca NinjaPos. */
  accent?: string;
}

/**
 * Fecha para una celda date / datetime: Excel no tiene zona horaria, así que
 * se arma en UTC con los componentes locales (lo que ve el usuario).
 */
export function xlsxDate(iso: string | Date | null | undefined): Date | null {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
}

/** Día yyyy-MM-dd a fecha de celda (sin hora). */
export function xlsxDay(day: string | null | undefined): Date | null {
  const m = day?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

/** Parte de un nombre de archivo: minúsculas, sin tildes ni espacios. */
export function xlsxFileSlug(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
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
