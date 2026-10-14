"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { groupEntries, summarizeEntries, type JournalLine, type SummaryMode } from "@/lib/accounting/journal";
import {
  EXPORT_FORMATS,
  FORMAT_BY_KEY,
  GENERIC_COLUMN_LABEL,
  buildExport,
  downloadExport,
  type ExportFormat,
  type GenericColumn,
  type LayoutConfig,
} from "@/lib/accounting/exporters";
import { useAccSettings, useAccountingMutations } from "@/modules/accounting/hooks";
import { selectCls } from "./shared";

const ALL_COLUMNS = Object.keys(GENERIC_COLUMN_LABEL) as GenericColumn[];

/** Export de asientos para el sistema del estudio. */
export function ExportModal({
  open,
  onOpenChange,
  lines,
  baseName,
  storeName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lines: JournalLine[];
  baseName: string;
  storeName: (id: string | null) => string;
}) {
  const { toast } = useToast();
  const { data: settings } = useAccSettings(open);
  const m = useAccountingMutations();
  const saved = (settings?.export_config ?? {}) as { format?: ExportFormat; summary?: SummaryMode; custom?: Partial<LayoutConfig> };
  const [format, setFormat] = useState<ExportFormat>(saved.format ?? "tango");
  const [summary, setSummary] = useState<SummaryMode>(saved.summary ?? "detailed");
  const [official, setOfficial] = useState(true);
  const [custom, setCustom] = useState<LayoutConfig>({ ...FORMAT_BY_KEY.get("generic")!.layout, ...(saved.custom ?? {}) });

  const result = useMemo(() => {
    const entries = summarizeEntries(groupEntries(lines), summary, storeName);
    return buildExport(entries, format, { custom, baseName, useOfficialNumber: official && summary === "detailed" });
  }, [lines, summary, storeName, format, custom, baseName, official]);
  const preview = result.text.split("\r\n").slice(0, 8).join("\n");
  const def = FORMAT_BY_KEY.get(format)!;

  async function download() {
    downloadExport(result);
    try {
      await m.saveSettings.mutateAsync({ export_config: { format, summary, custom } });
    } catch {
      // Guardar la preferencia no es crítico.
    }
    toast({ title: "Archivo descargado", description: `${result.rows} renglones.`, variant: "success" });
  }

  function toggleColumn(c: GenericColumn) {
    setCustom((p) => ({ ...p, columns: p.columns.includes(c) ? p.columns.filter((x) => x !== c) : [...p.columns, c] }));
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Exportar para el estudio"
      description="Asientos del rango en el formato del sistema contable de tu estudio."
      className="sm:max-w-3xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">{result.rows} renglones · {result.fileName}</span>
          <Button onClick={() => void download()} disabled={result.rows === 0}>
            <Download size={16} /> Descargar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="font-medium">Sistema</span>
            <select className={cn(selectCls, "mt-1 h-10")} value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
              {EXPORT_FORMATS.map((f) => (
                <option key={f.key} value={f.key} className="bg-popover text-popover-foreground">
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <div className="text-sm">
            <span className="font-medium">Asientos</span>
            <Segmented<SummaryMode>
              aria-label="Detalle"
              className="mt-1"
              size="sm"
              value={summary}
              onChange={setSummary}
              options={[
                { value: "detailed", label: "Uno por operación" },
                { value: "daily", label: "Por día y sucursal" },
                { value: "monthly", label: "Por mes y sucursal" },
              ]}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{def.description}</p>
        {summary === "detailed" && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={official} onCheckedChange={(v) => setOfficial(Boolean(v))} aria-label="Número del Diario" />
            Usar el número del Diario de los meses cerrados
          </label>
        )}

        {format === "generic" && (
          <div className="space-y-3 rounded-lg bg-muted/30 p-3">
            <div className="grid gap-2 sm:grid-cols-4">
              <select aria-label="Separador" className={cn(selectCls, "h-10")} value={custom.separator} onChange={(e) => setCustom((p) => ({ ...p, separator: e.target.value as LayoutConfig["separator"] }))}>
                <option value=";" className="bg-popover text-popover-foreground">Separador ;</option>
                <option value="," className="bg-popover text-popover-foreground">Separador ,</option>
                <option value={"\t"} className="bg-popover text-popover-foreground">Tabulación</option>
                <option value="|" className="bg-popover text-popover-foreground">Separador |</option>
              </select>
              <select aria-label="Decimales" className={cn(selectCls, "h-10")} value={custom.decimal} onChange={(e) => setCustom((p) => ({ ...p, decimal: e.target.value as LayoutConfig["decimal"] }))}>
                <option value="," className="bg-popover text-popover-foreground">Decimales con coma</option>
                <option value="." className="bg-popover text-popover-foreground">Decimales con punto</option>
              </select>
              <select aria-label="Fecha" className={cn(selectCls, "h-10")} value={custom.dateFormat} onChange={(e) => setCustom((p) => ({ ...p, dateFormat: e.target.value as LayoutConfig["dateFormat"] }))}>
                <option value="dd/mm/yyyy" className="bg-popover text-popover-foreground">dd/mm/aaaa</option>
                <option value="dd-mm-yyyy" className="bg-popover text-popover-foreground">dd-mm-aaaa</option>
                <option value="yyyy-mm-dd" className="bg-popover text-popover-foreground">aaaa-mm-dd</option>
                <option value="yyyymmdd" className="bg-popover text-popover-foreground">aaaammdd</option>
              </select>
              <select aria-label="Codificación" className={cn(selectCls, "h-10")} value={custom.encoding} onChange={(e) => setCustom((p) => ({ ...p, encoding: e.target.value as LayoutConfig["encoding"] }))}>
                <option value="utf8bom" className="bg-popover text-popover-foreground">UTF-8 (Excel)</option>
                <option value="latin1" className="bg-popover text-popover-foreground">Windows (Latin-1)</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox checked={custom.header} onCheckedChange={(v) => setCustom((p) => ({ ...p, header: Boolean(v) }))} aria-label="Encabezado" />
                Encabezado
              </label>
              <label className="flex items-center gap-2">
                <Checkbox checked={custom.useExternalCode} onCheckedChange={(v) => setCustom((p) => ({ ...p, useExternalCode: Boolean(v) }))} aria-label="Código externo" />
                Código de cuenta del estudio
              </label>
              <label className="flex items-center gap-2">
                <Checkbox checked={custom.quoteAll} onCheckedChange={(v) => setCustom((p) => ({ ...p, quoteAll: Boolean(v) }))} aria-label="Comillas" />
                Todo entre comillas
              </label>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Columnas (en el orden en que las marcás)</p>
              <div className="flex flex-wrap gap-1.5">
                {ALL_COLUMNS.map((c) => {
                  const idx = custom.columns.indexOf(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleColumn(c)}
                      className={cn(
                        "rounded-md px-3 py-1 text-xs font-medium transition",
                        idx >= 0 ? "bg-ninja-flame/[0.12] text-ninja-flameSoft" : "bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {idx >= 0 ? `${idx + 1}. ` : ""}
                      {GENERIC_COLUMN_LABEL[c]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Vista previa</p>
          <pre className="max-h-48 overflow-auto rounded-lg bg-muted/50 p-3 text-xs leading-relaxed">{preview || "Sin asientos en el rango."}</pre>
        </div>
      </div>
    </Modal>
  );
}
