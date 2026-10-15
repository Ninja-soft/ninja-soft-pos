// Tipos del motor único de importación XLSX (TX-4, ADR-078).
//
// Cada entidad importable se describe con una `ImportDefinition`: columnas
// (encabezado, alias, tipo, obligatoriedad, ayuda y lista desplegable para la
// plantilla), validación por fila con Zod, clave de duplicados, columnas del
// preview y la RPC del servidor que hace el dry-run y la aplicación.
import type { ZodType } from "zod";
import type { ImportColumn } from "@/lib/utils/xlsxImport";
import type { XlsxCellType } from "@/lib/utils/xlsx";

export type ImportEntityKey =
  | "products"
  | "customers"
  | "stock"
  | "price_lists"
  | "stores"
  | "warranty_plans"
  | "return_reasons"
  | "warehouses"
  | "warehouse_stock"
  | "stock_adjustments";

/** Columna importable: spec de parseo + datos para la plantilla. */
export interface ImportField extends ImportColumn {
  /** Qué poner (hoja "Instrucciones" de la plantilla). */
  help: string;
  /** Lista desplegable en la plantilla (validación de datos). */
  options?: readonly string[];
  /** Formato de la celda en la plantilla y el export. */
  cellType?: XlsxCellType;
  /** Ancho de la columna en la plantilla. */
  width?: number;
}

/** Datos del negocio que algunas definiciones usan (listas, sucursales...). */
export interface ImportContext {
  /** El negocio exige documento en clientes (require_customer_doc). */
  requireCustomerDoc?: boolean;
  /** Nombres de las listas de precios (para la lista desplegable). */
  priceLists?: string[];
  /** Nombres de las sucursales (para la lista desplegable). */
  stores?: string[];
  /** Nombres de los depósitos (para la lista desplegable). */
  warehouses?: string[];
}

/** Columna del preview: cómo mostrar un dato de la fila. */
export interface ImportPreviewColumn<R> {
  header: string;
  cell: (data: R) => string;
  align?: "left" | "right";
}

export interface ImportDefinition<R = Record<string, unknown>> {
  entity: ImportEntityKey;
  /** RPC del servidor: import_<entidad>(p_rows, p_apply, p_file_name). */
  rpc: string;
  /** Título corto ("Productos"). */
  title: string;
  /** "producto" / "productos" para los textos. */
  singular: string;
  plural: string;
  /** Nombre de la hoja de datos en la plantilla y el export. */
  sheetName: string;
  /** Parte del nombre de archivo ("productos"). */
  fileSlug: string;
  /** Explicación simple de qué hace esta importación. */
  intro: string;
  /** Cómo decide si una fila crea o actualiza. */
  matchRule: string;
  /** Feature de plan propia de la entidad (además de importacion_excel). */
  feature?: string;
  /** Columnas (dependen del contexto: listas, sucursales, documento). */
  fields: (ctx: ImportContext) => ImportField[];
  /** Filas de ejemplo para la plantilla (claves = key de cada campo). */
  example: (ctx: ImportContext) => Record<string, unknown>[];
  /** Validación Zod de la fila ya tipada (reglas entre columnas, rangos). */
  schema?: (ctx: ImportContext) => ZodType<unknown>;
  /** Clave (o claves) para marcar duplicados dentro del archivo. */
  dedupeKey?: string | string[];
  /** Columnas del preview (subset legible). */
  preview: ImportPreviewColumn<R>[];
  /** Fila tipada → objeto que recibe la RPC (default: la fila tal cual). */
  toPayload?: (row: R) => Record<string, unknown>;
  /** Query keys de TanStack Query a invalidar después de aplicar. */
  invalidate: string[][];
  /**
   * Cómo se llama cada resultado en esta entidad (p. ej. en ajustes de stock
   * "create" es "Va a aprobación"). Lo que falte usa el texto genérico.
   */
  actionLabels?: Partial<Record<ImportAction, string>>;
  /**
   * Texto de la confirmación (paso 3) con los conteos: `done` = ya aplicado
   * (con los conteos que devolvió el servidor).
   */
  confirmText?: (counts: ImportCounts, done: boolean) => string;
}

/** Qué pasa con una fila. */
export type ImportAction = "create" | "update" | "skip" | "error";

/** Resultado del servidor para una fila. */
export interface ServerRowOutcome {
  row: number;
  action: ImportAction;
  message: string | null;
}

/** Respuesta de import_<entidad>. */
export interface ServerImportResult {
  applied: boolean;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: ServerRowOutcome[];
}

/** Fila del archivo con su destino final (validación local + servidor). */
export interface ImportOutcome<R> {
  rowNumber: number;
  data: R;
  action: ImportAction;
  /** Errores o avisos en lenguaje simple. */
  messages: string[];
}

export interface ImportCounts {
  create: number;
  update: number;
  skip: number;
  error: number;
}
