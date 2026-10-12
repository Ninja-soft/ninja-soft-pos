"use client";

// Importar la liquidación de un adquirente (ADR-061): XLSX o CSV de Payway,
// Getnet, Fiserv / Posnet, Nave u otro. El dueño elige qué columna es cada
// dato (con sugerencia por encabezado), ve una vista previa y la importa.
// Reimportar el mismo archivo no duplica (clave por fila en el servidor).

import { useMemo, useState } from "react";
import { FileUp } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { readXlsxGrid } from "@/lib/utils/xlsxImport";
import {
  IMPORT_FIELDS,
  guessMapping,
  parseCsv,
  providerLabel,
  rowsToLines,
  toImportPayload,
  type ColumnMapping,
  type ImportField,
} from "@/lib/reports/processorReconciliation";
import { settlementErrorMessage, useImportSettlement } from "@/modules/reports/processorReconciliation";

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus:border-ninja-flameSoft";

export function ImportSettlementModal({
  open,
  onOpenChange,
  provider,
  fromISO,
  toISO,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  provider: string;
  fromISO: string;
  toISO: string;
}) {
  const { toast } = useToast();
  const mutation = useImportSettlement();
  const [fileName, setFileName] = useState<string | null>(null);
  const [grid, setGrid] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<ColumnMapping>({});
  const [error, setError] = useState<string | null>(null);

  const header = grid[headerRow] ?? [];
  const body = useMemo(() => grid.slice(headerRow + 1), [grid, headerRow]);
  const results = useMemo(
    () => (map.operation_at != null && map.gross != null ? rowsToLines(provider, body, map, headerRow + 2) : []),
    [provider, body, map, headerRow],
  );
  const ok = results.filter((r) => r.line);
  const bad = results.filter((r) => r.error);
  const total = ok.reduce((a, r) => a + (r.line?.gross ?? 0), 0);

  function reset() {
    setFileName(null);
    setGrid([]);
    setMap({});
    setError(null);
    setHeaderRow(0);
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    setError(null);
    let g: string[][] = [];
    if (/\.csv$|\.txt$/i.test(f.name)) {
      g = parseCsv(await f.text());
    } else {
      const res = await readXlsxGrid(await f.arrayBuffer());
      if (res.fatalError) {
        setError(res.fatalError);
        return;
      }
      g = res.grid;
    }
    if (g.length < 2) {
      setError("El archivo no tiene filas para importar.");
      return;
    }
    // Encabezado: la primera fila con 3 o más celdas con texto en las 10 primeras.
    const hr = Math.max(0, g.slice(0, 10).findIndex((r) => r.filter((c) => /[a-z]/i.test(c)).length >= 3));
    setFileName(f.name);
    setGrid(g);
    setHeaderRow(hr);
    setMap(guessMapping(g[hr] ?? []));
  }

  async function submit() {
    try {
      const res = await mutation.mutateAsync({
        provider,
        fileName: fileName ?? "liquidacion",
        lines: toImportPayload(ok.map((r) => r.line!)),
        fromISO,
        toISO,
      });
      toast({
        title: `Liquidación importada: ${res.inserted} nuevas, ${res.updated} actualizadas`,
        description: res.match
          ? `${res.match.reconciled} ${res.match.reconciled === 1 ? "cobro conciliado" : "cobros conciliados"} automáticamente.`
          : undefined,
        variant: "success",
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo importar", description: settlementErrorMessage(e), variant: "error" });
    }
  }

  const setField = (f: ImportField, v: string) =>
    setMap((m) => {
      const next = { ...m };
      if (v === "") delete next[f];
      else next[f] = Number(v);
      return next;
    });

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={`Importar liquidación de ${providerLabel(provider)}`}
      description="Subí el Excel o CSV que descargás del portal del adquirente. Elegí qué columna es cada dato y revisá la vista previa."
      className="sm:max-w-2xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={ok.length === 0 || mutation.isPending}>
            {mutation.isPending ? "Importando..." : `Importar ${ok.length} ${ok.length === 1 ? "fila" : "filas"}`}
          </Button>
        </div>
      }
    >
      {!fileName ? (
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center hover:bg-muted/40">
          <FileUp size={22} className="text-ninja-flameSoft" aria-hidden />
          <span className="text-sm font-medium">Elegí el archivo de la liquidación</span>
          <span className="text-xs text-muted-foreground">.xlsx o .csv, hasta 5.000 filas</span>
          <input
            type="file"
            accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            className="sr-only"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </label>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate font-medium">{fileName}</span>
            <button type="button" className="text-xs text-muted-foreground underline" onClick={reset}>
              Elegir otro archivo
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {IMPORT_FIELDS.map((f) => (
              <label key={f.key} className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {f.label}
                  {f.required ? " *" : ""}
                </span>
                <select
                  className={SELECT}
                  value={map[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                >
                  <option value="">{f.required ? "Elegí una columna" : "No está en el archivo"}</option>
                  {header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Columna ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {results.length > 0 && (
            <div className="rounded-lg border border-border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm">
                <span>
                  {ok.length} {ok.length === 1 ? "fila lista" : "filas listas"} ·{" "}
                  <span className="tabular-nums">{formatCurrency(total)}</span>
                </span>
                {bad.length > 0 && <span className="text-xs text-warning">{bad.length} con error (se omiten)</span>}
              </div>
              <div className="slim-scrollbar max-h-56 overflow-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead className="sticky top-0 bg-popover text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Fila</th>
                      <th className="px-3 py-2 font-medium">Fecha</th>
                      <th className="px-3 py-2 font-medium">Lote / cupón</th>
                      <th className="px-3 py-2 text-right font-medium">Bruto</th>
                      <th className="px-3 py-2 text-right font-medium">Neto</th>
                      <th className="px-3 py-2 font-medium">Pago</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {results.slice(0, 50).map((r) => (
                      <tr key={r.row} className={r.error ? "text-warning" : undefined}>
                        <td className="px-3 py-1.5 tabular-nums">{r.row}</td>
                        {r.line ? (
                          <>
                            <td className="whitespace-nowrap px-3 py-1.5">{new Date(r.line.operation_at).toLocaleDateString("es-AR")}</td>
                            <td className="px-3 py-1.5 font-mono">{[r.line.lote, r.line.cupon].filter(Boolean).join(" / ") || "Sin dato"}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.line.gross)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.line.net)}</td>
                            <td className="whitespace-nowrap px-3 py-1.5">
                              {r.line.release_date ? new Date(r.line.release_date).toLocaleDateString("es-AR") : "Sin fecha"}
                            </td>
                          </>
                        ) : (
                          <td colSpan={5} className="px-3 py-1.5">
                            {r.error}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {map.operation_at == null || map.gross == null ? (
            <Callout tone="warning">Elegí al menos la columna de la fecha y la del importe.</Callout>
          ) : null}
        </div>
      )}
      {error && (
        <Callout tone="danger" className="mt-3">
          {error}
        </Callout>
      )}
    </Modal>
  );
}
