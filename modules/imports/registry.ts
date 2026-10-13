// Catálogo de importaciones XLSX (TX-4, ADR-078): todas las entidades que el
// dueño o el encargado pueden importar desde /importaciones.
import type { ImportDefinition, ImportEntityKey } from "@/lib/import/types";
import { productImportDefinition } from "@/modules/products/import";
import { customerImportDefinition } from "@/modules/customers/import";
import {
  priceListImportDefinition,
  returnReasonImportDefinition,
  stockImportDefinition,
  storeImportDefinition,
  warrantyImportDefinition,
} from "./entities";

// El motor trabaja con filas genéricas; cada definición tipa las suyas.
type AnyDefinition = ImportDefinition<never>;

export const IMPORT_DEFINITIONS: AnyDefinition[] = [
  productImportDefinition,
  customerImportDefinition,
  stockImportDefinition,
  priceListImportDefinition,
  storeImportDefinition,
  warrantyImportDefinition,
  returnReasonImportDefinition,
] as unknown as AnyDefinition[];

export function importDefinition(entity: ImportEntityKey): ImportDefinition<Record<string, unknown>> {
  const def = IMPORT_DEFINITIONS.find((d) => d.entity === entity);
  if (!def) throw new Error(`Importación desconocida: ${entity}`);
  return def as unknown as ImportDefinition<Record<string, unknown>>;
}
