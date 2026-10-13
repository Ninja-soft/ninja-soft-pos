"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { NoData } from "@/components/ui/NoData";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { buildOutcomes, countOutcomes, parseImportFile } from "@/lib/import/engine";
import { runServerImport } from "@/lib/import/server";
import { downloadImportErrors, downloadImportTemplate } from "@/lib/import/download";
import type {
  ImportAction,
  ImportContext,
  ImportCounts,
  ImportDefinition,
  ImportOutcome,
  ServerImportResult,
} from "@/lib/import/types";
import type { ParsedRow } from "@/lib/utils/xlsxImport";

// Asistente único de importación XLSX (TX-4, ADR-078). Tres pasos:
//   1. Subir: explica qué hace, ofrece la plantilla y lee el archivo.
//   2. Revisar: validación local por fila + revisión en el servidor (dry-run,
//      no guarda nada) con conteos de qué se crea, actualiza u omite y los
//      errores por fila, descargables en XLSX.
//   3. Confirmar: recién acá se escribe (y queda auditado).

type Step = 1 | 2 | 3;
type Filter = "all" | ImportAction;

const ACTION_LABEL: Record<ImportAction, string> = {
  create: "Se crea",
  update: "Se actualiza",
  skip: "Se omite",
  error: "Con error",
};

const ACTION_DOT: Record<ImportAction, string> = {
  create: "bg-success",
  update: "bg-info",
  skip: "bg-muted-foreground/60",
  error: "bg-danger",
};

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Subir" },
  { n: 2, label: "Revisar" },
  { n: 3, label: "Confirmar" },
];

function Stepper({ step }: { step: Step }) {
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="Pasos de la importación">
      {STEPS.map((s) => (
        <li
          key={s.n}
          aria-current={s.n === step ? "step" : undefined}
          className={cn(
            "border-t-2 pt-2 text-xs font-semibold",
            s.n === step
              ? "border-ninja-flame text-foreground"
              : s.n < step
                ? "border-success text-muted-foreground"
                : "border-border text-muted-foreground",
          )}
        >
          <span className="tabular-nums">{s.n}.</span> {s.label}
        </li>
      ))}
    </ol>
  );
}

function CountTile({ action, value }: { action: ImportAction; value: number }) {
  return (
    <div className="rounded-md bg-muted px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", ACTION_DOT[action])} />
        {ACTION_LABEL[action]}
      </p>
      <p className="mt-0.5 text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function Counts({ counts }: { counts: ImportCounts }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <CountTile action="create" value={counts.create} />
      <CountTile action="update" value={counts.update} />
      <CountTile action="skip" value={counts.skip} />
      <CountTile action="error" value={counts.error} />
    </div>
  );
}

function OutcomeTable<R>({
  outcomes,
  definition,
}: {
  outcomes: ImportOutcome<R>[];
  definition: ImportDefinition<R>;
}) {
  if (outcomes.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No hay filas en este filtro.</p>;
  }
  return (
    <div className="max-h-[44dvh] overflow-auto rounded-md border border-border">
      <table className="w-full min-w-[620px] text-left text-xs">
        <thead className="sticky top-0 z-10 bg-popover text-[11px] uppercase tracking-[0.12em] text-muted-foreground [&>tr]:bg-muted">
          <tr>
            <th className="px-2 py-2 font-semibold">Fila</th>
            <th className="px-2 py-2 font-semibold">Resultado</th>
            {definition.preview.map((c) => (
              <th key={c.header} className={cn("px-2 py-2 font-semibold", c.align === "right" && "text-right")}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {outcomes.map((o) => (
            <tr key={o.rowNumber} className="align-top">
              <td className="px-2 py-1.5 font-mono tabular-nums text-muted-foreground">{o.rowNumber}</td>
              <td className="px-2 py-1.5">
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium">
                  <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", ACTION_DOT[o.action])} />
                  {ACTION_LABEL[o.action]}
                </span>
                {o.messages.length > 0 && (
                  <ul className="mt-1 max-w-[240px] space-y-0.5">
                    {o.messages.map((m, i) => (
                      <li key={i} className={cn("text-[11px]", o.action === "error" ? "text-danger" : "text-muted-foreground")}>
                        {m}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              {definition.preview.map((c) => {
                let text = "";
                try {
                  text = c.cell(o.data);
                } catch {
                  text = "";
                }
                return (
                  <td key={c.header} className={cn("px-2 py-1.5 text-foreground", c.align === "right" && "text-right tabular-nums")}>
                    {text || <NoData />}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ImportWizardProps<R> {
  definition: ImportDefinition<R>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Datos del negocio para las columnas (listas, sucursales, documento). */
  context?: ImportContext;
  /** Después de aplicar con éxito. */
  onApplied?: (result: ServerImportResult) => void;
}

export function ImportWizard<R>({ definition, open, onOpenChange, context = {}, onApplied }: ImportWizardProps<R>) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState<null | "reading" | "checking" | "applying">(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedRow<R>[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [dryRun, setDryRun] = useState<ServerImportResult | null>(null);
  const [applied, setApplied] = useState<ServerImportResult | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const outcomes = useMemo(() => buildOutcomes(rows, applied ?? dryRun), [rows, applied, dryRun]);
  const counts = useMemo(() => countOutcomes(outcomes), [outcomes]);
  const visible = useMemo(
    () => (filter === "all" ? outcomes : outcomes.filter((o) => o.action === filter)),
    [outcomes, filter],
  );
  const toWrite = counts.create + counts.update;

  function reset() {
    setStep(1);
    setFileName("");
    setBusy(null);
    setProgress(null);
    setFatal(null);
    setRows([]);
    setIgnored([]);
    setDryRun(null);
    setApplied(null);
    setFilter("all");
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite volver a elegir el mismo archivo
    if (!file) return;
    reset();
    setFileName(file.name);
    setBusy("reading");
    try {
      const parsed = await parseImportFile(definition, await file.arrayBuffer(), context);
      if (parsed.fatalError) {
        setFatal(parsed.fatalError);
        return;
      }
      setRows(parsed.rows);
      setIgnored(parsed.ignoredHeaders ?? []);
      setBusy("checking");
      // Dry-run en el servidor: no guarda nada.
      const hasValid = parsed.rows.some((r) => r.errors.length === 0);
      const result = hasValid
        ? await runServerImport(definition, parsed.rows, {
            apply: false,
            fileName: file.name,
            onProgress: (done, total) => setProgress({ done, total }),
          })
        : { applied: false, created: 0, updated: 0, skipped: 0, errors: 0, rows: [] };
      setDryRun(result);
      setStep(2);
    } catch (err) {
      setFatal(err instanceof Error ? err.message : "No se pudo revisar el archivo.");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function apply() {
    setBusy("applying");
    try {
      const result = await runServerImport(definition, rows, {
        apply: true,
        fileName,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setApplied(result);
      for (const key of definition.invalidate) qc.invalidateQueries({ queryKey: key });
      toast({
        title: `Importación lista: ${result.created} creados, ${result.updated} actualizados`,
        description: result.errors > 0 ? `${result.errors} filas no se pudieron guardar.` : undefined,
        variant: result.errors > 0 ? "info" : "success",
      });
      onApplied?.(result);
    } catch (err) {
      toast({
        title: "No se pudo importar",
        description: err instanceof Error ? err.message : undefined,
        variant: "error",
      });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  const progressText =
    progress && progress.total > 1 ? ` (${progress.done} de ${progress.total} partes)` : "";

  const errorsButton =
    counts.error > 0 ? (
      <Button variant="secondary" size="sm" onClick={() => downloadImportErrors(definition, outcomes, context)}>
        <Download size={15} /> Descargar errores (XLSX)
      </Button>
    ) : null;

  let footer: React.ReactNode;
  if (step === 1) {
    footer = (
      <Button variant="secondary" onClick={close}>
        Cancelar
      </Button>
    );
  } else if (step === 2) {
    footer = (
      <>
        <Button variant="secondary" onClick={() => setStep(1)}>
          Elegir otro archivo
        </Button>
        <Button onClick={() => setStep(3)} disabled={toWrite === 0}>
          Continuar
        </Button>
      </>
    );
  } else if (applied) {
    footer = <Button onClick={close}>Listo</Button>;
  } else {
    footer = (
      <>
        <Button variant="secondary" onClick={() => setStep(2)} disabled={busy === "applying"}>
          Volver a revisar
        </Button>
        <Button onClick={apply} loading={busy === "applying"} disabled={toWrite === 0}>
          Importar {toWrite} {toWrite === 1 ? "fila" : "filas"}
        </Button>
      </>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={`Importar ${definition.plural} desde Excel`}
      className={step === 1 ? "sm:max-w-xl" : "sm:max-w-4xl"}
      footer={footer}
    >
      <div className="space-y-4">
        <Stepper step={step} />

        {step === 1 && (
          <>
            <div className="space-y-2 text-sm">
              <p>{definition.intro}</p>
              <p className="text-muted-foreground">{definition.matchRule}</p>
              <p className="text-muted-foreground">
                Primero vas a ver qué pasa con cada fila. No se guarda nada hasta que confirmes.
              </p>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                downloadImportTemplate(definition, context).catch(() =>
                  toast({ title: "No se pudo generar la plantilla", variant: "error" }),
                )
              }
            >
              <FileSpreadsheet size={15} /> Descargar plantilla XLSX
            </Button>

            <label
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-input bg-background px-4 py-8 text-center text-sm text-muted-foreground transition hover:bg-muted",
                busy && "pointer-events-none opacity-70",
              )}
            >
              <Upload size={18} />
              <span className="font-medium text-foreground">
                {busy === "reading"
                  ? "Leyendo el archivo…"
                  : busy === "checking"
                    ? `Revisando en el sistema${progressText}…`
                    : fileName || "Elegí tu archivo .xlsx"}
              </span>
              <span className="text-xs">Usá la plantilla o un archivo exportado desde NinjaPos.</span>
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={onFile}
                disabled={busy !== null}
              />
            </label>

            {fatal && (
              <Callout tone="danger" icon={AlertTriangle} title="No se puede importar este archivo">
                {fatal}
              </Callout>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <p className="text-sm text-muted-foreground">
              Revisamos <span className="font-medium text-foreground">{fileName}</span> contra los datos de tu negocio.
              Todavía no se guardó nada.
            </p>
            <Counts counts={counts} />
            {ignored.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Columnas que no se usan y se ignoran: {ignored.join(", ")}.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented
                size="sm"
                value={filter}
                onChange={setFilter}
                aria-label="Filtrar filas"
                options={[
                  { value: "all", label: `Todas (${outcomes.length})` },
                  { value: "create", label: `Crear (${counts.create})` },
                  { value: "update", label: `Actualizar (${counts.update})` },
                  { value: "skip", label: `Omitir (${counts.skip})` },
                  { value: "error", label: `Errores (${counts.error})` },
                ]}
              />
              {errorsButton}
            </div>
            <OutcomeTable outcomes={visible} definition={definition} />
            {counts.error > 0 && (
              <p className="text-xs text-muted-foreground">
                Las filas con error no se importan. Podés seguir con las demás, o corregir el archivo y volver a subirlo.
              </p>
            )}
            {toWrite === 0 && (
              <Callout tone="warning" icon={AlertTriangle}>
                No hay filas para crear ni actualizar.
              </Callout>
            )}
          </>
        )}

        {step === 3 && !applied && (
          <>
            <Counts counts={counts} />
            <Callout tone="brand" icon={CheckCircle2} title="¿Confirmás la importación?">
              Se van a crear {counts.create} y actualizar {counts.update} {definition.plural}.
              {counts.skip + counts.error > 0 && ` ${counts.skip + counts.error} filas se omiten.`} Queda registrado
              en la auditoría con tu usuario y el nombre del archivo.
            </Callout>
            {busy === "applying" && (
              <p className="text-sm text-muted-foreground">Guardando{progressText}…</p>
            )}
          </>
        )}

        {step === 3 && applied && (
          <>
            <Callout
              tone={applied.errors > 0 ? "warning" : "success"}
              icon={applied.errors > 0 ? AlertTriangle : CheckCircle2}
              title="Importación terminada"
            >
              Se crearon {applied.created} y se actualizaron {applied.updated} {definition.plural}.
              {applied.errors > 0 && " Algunas filas no se pudieron guardar: descargá el detalle para corregirlas."}
            </Callout>
            <Counts counts={counts} />
            {errorsButton}
          </>
        )}
      </div>
    </Modal>
  );
}
