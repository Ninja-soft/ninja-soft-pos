// Import masivo de productos en XLSX (TX-4, ADR-078). Definición para el motor
// único (lib/import): columnas con alias (acepta también los encabezados en
// inglés de la plantilla anterior), validación por fila y RPC import_products
// (dry-run + aplicación en el servidor: SKU o código de barras existente →
// actualiza; si no, crea. La categoría y la marca se resuelven por nombre).
import { z } from "zod";
import { parseImportFile, exportColumns } from "@/lib/import/engine";
import type { ImportDefinition, ImportField } from "@/lib/import/types";
import type { ParseXlsxResult } from "@/lib/utils/xlsxImport";
import type { XlsxColumn } from "@/lib/utils/xlsx";
import { formatCurrency } from "@/lib/utils/format";

/**
 * Fila de producto ya tipada. Los opcionales vacíos quedan en null: al crear,
 * el servidor aplica los valores por defecto (IVA 21, unidad "un", stock 0,
 * controla stock); al actualizar, una celda vacía no cambia ese dato.
 */
export interface ParsedProduct {
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  cost: number | null;
  stock: number | null;
  stock_min: number | null;
  unit: string | null;
  tax_rate: number | null;
  track_stock: boolean | null;
  category: string | null;
  brand: string | null;
}

const nonNegative = (label: string) => (v: number | null) =>
  v == null || v >= 0 ? { value: v } : { error: `${label} no puede ser negativo.` };

export const PRODUCT_FIELDS: ImportField[] = [
  { header: "Nombre", key: "name", type: "text", required: true, aliases: ["name", "producto", "descripcion"], help: "Nombre del producto como se ve en el POS y el ticket.", width: 32 },
  { header: "Código de barras", key: "barcode", type: "text", aliases: ["barcode", "ean", "codigo de barras"], help: "EAN o código del envase. Si ya existe en tu catálogo, se actualiza ese producto.", width: 18 },
  { header: "SKU", key: "sku", type: "text", aliases: ["sku", "codigo", "codigo interno"], help: "Código interno. Si ya existe, se actualiza ese producto (tiene prioridad sobre el código de barras).", width: 14 },
  {
    header: "Precio",
    key: "price",
    type: "number",
    required: true,
    aliases: ["price", "precio de venta"],
    cellType: "money",
    help: "Precio de venta final. Número, con coma o punto decimal.",
    transform: (v: number | null) => {
      if (v == null) return { error: "Falta el precio." };
      return v >= 0 ? { value: v } : { error: "El precio debe ser mayor o igual a 0." };
    },
  },
  { header: "Costo", key: "cost", type: "number", aliases: ["cost"], cellType: "money", help: "Costo de compra (opcional).", transform: nonNegative("El costo") },
  { header: "Categoría", key: "category", type: "text", aliases: ["category", "rubro"], help: "Si no existe, se crea.", width: 18 },
  { header: "Marca", key: "brand", type: "text", aliases: ["brand"], help: "Si no existe, se crea. Se guarda en mayúsculas.", width: 16 },
  { header: "IVA %", key: "tax_rate", type: "number", aliases: ["tax_rate", "iva", "alicuota"], help: "Alícuota de IVA en %. Vacío al crear = 21.", options: ["0", "10.5", "21", "27"] },
  { header: "Unidad", key: "unit", type: "text", aliases: ["unit"], help: "un, kg, lt, m... Vacío al crear = un.", options: ["un", "kg", "gr", "lt", "ml", "m"] },
  { header: "Stock", key: "stock", type: "number", aliases: ["stock", "stock inicial"], cellType: "number", help: "Stock inicial (sólo al crear, entra en la sucursal principal). Para cambiar el stock de productos que ya existen usá la importación de stock.", transform: nonNegative("El stock") },
  { header: "Stock mínimo", key: "stock_min", type: "number", aliases: ["stock_min", "stock minimo", "minimo"], cellType: "number", help: "Aviso de stock bajo. Vacío al crear = 0.", transform: nonNegative("El stock mínimo") },
  { header: "Controla stock", key: "track_stock", type: "boolean", aliases: ["track_stock", "lleva stock"], help: "Sí o No. Vacío al crear = Sí.", options: ["Sí", "No"] },
];

const productSchema = z
  .object({
    name: z.string().max(200, "El nombre es demasiado largo (máx. 200)."),
    tax_rate: z.number().min(0, "El IVA debe estar entre 0 y 100.").max(100, "El IVA debe estar entre 0 y 100.").nullable(),
    sku: z.string().max(64, "El SKU es demasiado largo (máx. 64).").nullable(),
    barcode: z.string().max(64, "El código de barras es demasiado largo (máx. 64).").nullable(),
  })
  .passthrough();

export const productImportDefinition: ImportDefinition<ParsedProduct> = {
  entity: "products",
  rpc: "import_products",
  title: "Productos",
  singular: "producto",
  plural: "productos",
  sheetName: "Productos",
  fileSlug: "productos",
  intro: "Cargá o actualizá tu catálogo: nombre, códigos, precio, costo, categoría, marca, IVA y stock inicial.",
  matchRule: "Si el SKU (o el código de barras) ya existe, se actualiza ese producto; si no, se crea uno nuevo.",
  feature: "productos",
  fields: () => PRODUCT_FIELDS,
  example: () => [
    { name: "Coca Cola 500ml", barcode: "7790895000990", sku: "COCA500", price: 800, cost: 500, category: "Bebidas", brand: "COCA COLA", tax_rate: "21", unit: "un", stock: 24, stock_min: 6, track_stock: "Sí" },
  ],
  schema: () => productSchema,
  dedupeKey: "barcode",
  preview: [
    { header: "Nombre", cell: (r) => r.name },
    { header: "Código", cell: (r) => r.barcode ?? r.sku ?? "" },
    { header: "Precio", align: "right", cell: (r) => formatCurrency(r.price) },
    { header: "Categoría", cell: (r) => r.category ?? "" },
    { header: "Marca", cell: (r) => r.brand ?? "" },
    { header: "Stock", align: "right", cell: (r) => (r.stock == null ? "" : String(r.stock)) },
  ],
  invalidate: [["products"], ["categories"], ["brands"]],
};

/** Columnas de la plantilla/export de productos (XLSX). */
export const PRODUCT_IMPORT_COLUMNS: XlsxColumn[] = exportColumns(productImportDefinition);

/** Fila de ejemplo para la plantilla. */
export const PRODUCT_TEMPLATE_ROW: Record<string, unknown> = productImportDefinition.example({})[0]!;

/**
 * Lee un XLSX de productos y devuelve filas tipadas + errores por fila.
 * Detecta códigos de barras duplicados dentro del mismo archivo.
 */
export function parseProductsXlsx(buffer: ArrayBuffer): Promise<ParseXlsxResult<ParsedProduct>> {
  return parseImportFile(productImportDefinition, buffer);
}
