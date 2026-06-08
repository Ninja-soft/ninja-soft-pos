// Import masivo de productos en XLSX (TX-3). Usa el helper genérico
// `parseXlsx` (lib/utils/xlsxImport) y declara el spec de columnas con sus
// validaciones/normalizaciones. Las filas válidas e inválidas (con errores por
// fila) las consume el modal de preview. La inserción la hace
// `productsImportApi.bulkImport` (resuelve categoría y marca por nombre).
import {
  parseXlsx,
  type ImportColumn,
  type ParseXlsxResult,
} from "@/lib/utils/xlsxImport";
import type { XlsxColumn } from "@/lib/utils/xlsx";

/** Fila de producto ya tipada lista para insertar. */
export interface ParsedProduct {
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  cost: number | null;
  stock: number;
  stock_min: number;
  unit: string;
  tax_rate: number;
  track_stock: boolean;
  category: string | null;
  brand: string | null;
}

/**
 * Columnas de la plantilla/export de productos (XLSX). Compatibles con
 * `exportXlsx` (header/key/type). Se reusan para descargar la plantilla y para
 * exportar la base entera.
 */
export const PRODUCT_IMPORT_COLUMNS: XlsxColumn[] = [
  { header: "name", key: "name" },
  { header: "barcode", key: "barcode" },
  { header: "sku", key: "sku" },
  { header: "price", key: "price", type: "money" },
  { header: "cost", key: "cost", type: "money" },
  { header: "category", key: "category" },
  { header: "brand", key: "brand" },
  { header: "tax_rate", key: "tax_rate", type: "number" },
  { header: "unit", key: "unit" },
  { header: "stock", key: "stock", type: "number" },
  { header: "stock_min", key: "stock_min", type: "number" },
  { header: "track_stock", key: "track_stock" },
];

/** Fila de ejemplo para la plantilla. */
export const PRODUCT_TEMPLATE_ROW: Record<string, unknown> = {
  name: "Coca Cola 500ml",
  barcode: "7790895000990",
  sku: "COCA500",
  price: 800,
  cost: 500,
  category: "Bebidas",
  brand: "Coca Cola",
  tax_rate: 21,
  unit: "un",
  stock: 24,
  stock_min: 6,
  track_stock: "si",
};

// Spec de parseo: tipos + obligatoriedad + normalización por celda. El SKU se
// deja vacío a propósito si no viene (lo genera la DB / queda null). La
// categoría y la marca se resuelven por nombre en el bulkImport.
const SPEC: ImportColumn[] = [
  { header: "name", key: "name", type: "text", required: true },
  { header: "barcode", key: "barcode", type: "text", aliases: ["ean", "codigo de barras", "código de barras"] },
  { header: "sku", key: "sku", type: "text", aliases: ["codigo", "código"] },
  {
    header: "price",
    key: "price",
    type: "number",
    required: true,
    aliases: ["precio"],
    transform: (v: number | null) => {
      if (v == null) return { error: "Falta el precio." };
      return v >= 0
        ? { value: v }
        : { error: "El precio debe ser mayor o igual a 0." };
    },
  },
  {
    header: "cost",
    key: "cost",
    type: "number",
    aliases: ["costo"],
    transform: (v: number | null) =>
      v == null || v >= 0
        ? { value: v }
        : { error: "El costo no puede ser negativo." },
  },
  { header: "category", key: "category", type: "text", aliases: ["categoria", "categoría", "rubro"] },
  { header: "brand", key: "brand", type: "text", aliases: ["marca"] },
  {
    header: "tax_rate",
    key: "tax_rate",
    type: "number",
    aliases: ["iva", "iva %", "alicuota", "alícuota"],
    // IVA en %, default 21. Permite 0..100.
    transform: (v: number | null) => {
      if (v == null) return { value: 21 };
      if (v < 0 || v > 100) return { error: "El IVA debe estar entre 0 y 100." };
      return { value: v };
    },
  },
  {
    header: "unit",
    key: "unit",
    type: "text",
    aliases: ["unidad"],
    transform: (v: string | null) => ({ value: (v ?? "un") || "un" }),
  },
  {
    header: "stock",
    key: "stock",
    type: "number",
    transform: (v: number | null) => ({ value: v ?? 0 }),
  },
  {
    header: "stock_min",
    key: "stock_min",
    type: "number",
    aliases: ["stock minimo", "stock mínimo", "minimo", "mínimo"],
    transform: (v: number | null) => ({ value: v ?? 0 }),
  },
  {
    header: "track_stock",
    key: "track_stock",
    type: "boolean",
    aliases: ["controla stock", "lleva stock"],
    // Default: controla stock (true) si no se especifica.
    transform: (v: boolean | null) => ({ value: v ?? true }),
  },
];

/**
 * Lee un XLSX de productos y devuelve filas tipadas + errores por fila.
 * Detecta barcodes duplicados dentro del mismo archivo.
 */
export async function parseProductsXlsx(
  buffer: ArrayBuffer,
): Promise<ParseXlsxResult<ParsedProduct>> {
  return parseXlsx<ParsedProduct>(buffer, SPEC, { dedupeKey: "barcode" });
}
