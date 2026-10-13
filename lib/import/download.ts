// Descargas del asistente de importación (TX-4): plantilla y reporte de
// errores por fila, generados con exportXlsx (TX-2).
import { exportXlsx } from "@/lib/utils/xlsx";
import { errorReportSheets, templateSheets } from "./engine";
import type { ImportContext, ImportDefinition, ImportOutcome } from "./types";

export function downloadImportTemplate<R>(def: ImportDefinition<R>, ctx: ImportContext = {}): Promise<void> {
  return exportXlsx(`plantilla-${def.fileSlug}`, templateSheets(def, ctx));
}

export function downloadImportErrors<R>(
  def: ImportDefinition<R>,
  outcomes: ImportOutcome<R>[],
  ctx: ImportContext = {},
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  return exportXlsx(`errores-${def.fileSlug}-${day}`, errorReportSheets(def, outcomes, ctx));
}
