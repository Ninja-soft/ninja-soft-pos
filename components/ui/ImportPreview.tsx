"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { ParsedRow } from "@/lib/utils/xlsxImport";

// Tabla de preview reutilizable para el import XLSX (TX-3). Muestra todas las
// filas parseadas con sus valores, resalta las inválidas y lista los errores
// por fila. Encabeza con un contador de válidas / con error. Agnóstica del
// dominio: recibe las columnas a mostrar y cómo extraer cada celda.

export interface PreviewColumn<R> {
  header: string;
  /** Texto a mostrar para esta celda de la fila. */
  cell: (data: R) => string;
  /** Alineación (default izquierda). */
  align?: "left" | "right";
}

export function ImportPreview<R>({
  rows,
  columns,
  validCount,
  invalidCount,
  entityPlural,
}: {
  rows: ParsedRow<R>[];
  columns: PreviewColumn<R>[];
  validCount: number;
  invalidCount: number;
  /** "productos" / "clientes" — para los textos del contador. */
  entityPlural: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-400/10 px-2.5 py-1 font-medium text-emerald-300">
          <CheckCircle2 size={15} />
          {validCount} {entityPlural} {validCount === 1 ? "válido" : "válidos"}
        </span>
        {invalidCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-red-400/10 px-2.5 py-1 font-medium text-red-300">
            <AlertTriangle size={15} />
            {invalidCount} con {invalidCount === 1 ? "error" : "errores"}
          </span>
        )}
      </div>

      <div className="max-h-[42dvh] overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            <tr>
              <th className="px-2 py-2 font-semibold">#</th>
              {columns.map((c) => (
                <th
                  key={c.header}
                  className={cn(
                    "px-2 py-2 font-semibold",
                    c.align === "right" && "text-right",
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const bad = row.errors.length > 0;
              return (
                <tr
                  key={row.rowNumber}
                  className={cn(
                    "align-top",
                    bad ? "bg-red-400/5" : "hover:bg-muted/40",
                  )}
                >
                  <td className="px-2 py-1.5 font-mono text-muted-foreground">
                    {row.rowNumber}
                  </td>
                  {columns.map((c, i) => (
                    <td
                      key={c.header}
                      className={cn(
                        "px-2 py-1.5",
                        c.align === "right" && "text-right",
                        bad ? "text-red-200" : "text-foreground",
                      )}
                    >
                      {c.cell(row.data) || (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {/* Errores debajo de la primera celda de datos. */}
                      {bad && i === 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {row.errors.map((e, ei) => (
                            <li
                              key={ei}
                              className="flex items-start gap-1 text-[11px] font-normal text-red-300"
                            >
                              <AlertTriangle
                                size={11}
                                className="mt-0.5 shrink-0"
                              />
                              <span>{e}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {invalidCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Las filas con error se omiten al importar. Corregí el archivo y volvé a
          subirlo si querés incluirlas.
        </p>
      )}
    </div>
  );
}
