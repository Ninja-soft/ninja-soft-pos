"use client";

import { useRef, useState } from "react";
import { FileUp, Lock, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { JURISDICTIONS, jurisdictionName } from "@/lib/tax/catalog";
import { PADRON_REASON_LABEL, PadronReader, type PadronFormat } from "@/lib/tax/padron";
import { taxApi, taxErrorMessage, type PadronImport as PadronImportRow, type TaxSettings } from "@/modules/tax/api";
import { usePadronImports } from "@/modules/tax/hooks";

// Padrones de IIBB (ADR-068): el archivo se lee en el navegador por partes
// (los padrones completos pesan cientos de MB) y se sube en tandas de hasta
// 5000 filas. Por defecto sólo los CUIT de tus clientes y proveedores.

const FORMAT_LABEL: Record<PadronFormat, string> = {
  arba: "ARBA · Padrón de regímenes generales",
  agip: "AGIP · Padrón de regímenes generales",
  generic: "Genérico (CUIT; percepción; retención; desde; hasta)",
};
const KIND_LABEL = { perception: "Percepción", retention: "Retención", both: "Percepción y retención" } as const;
const STATUS: Record<PadronImportRow["status"], { label: string; tone: "success" | "info" | "danger" | "neutral" }> = {
  ready: { label: "Vigente", tone: "success" },
  loading: { label: "Cargando", tone: "info" },
  error: { label: "Con error", tone: "danger" },
  replaced: { label: "Reemplazado", tone: "neutral" },
};
const BATCH = 4000;

function fmtDate(d: string | null) {
  if (!d) return "";
  const [y, m, dd] = d.slice(0, 10).split("-");
  return `${dd}/${m}/${y}`;
}

export function PadronImport({ settings }: { settings: TaxSettings }) {
  const enabled = settings.features.percepciones;
  const list = usePadronImports(enabled);
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [jur, setJur] = useState("902");
  const [format, setFormat] = useState<PadronFormat>("arba");
  const [kind, setKind] = useState<PadronImportRow["kind"]>("perception");
  const [onlyKnown, setOnlyKnown] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [del, setDel] = useState<PadronImportRow | null>(null);
  const ro = !settings.can_write;

  const formats: PadronFormat[] = jur === "902" ? ["arba", "generic"] : jur === "901" ? ["agip", "generic"] : ["generic"];
  const fmt = formats.includes(format) ? format : formats[0]!;

  const run = async (file: File) => {
    setBusy("Leyendo el archivo…");
    let importId: string | null = null;
    try {
      const only = onlyKnown ? await taxApi.knownCuits() : null;
      const reader = new PadronReader(fmt, { only });
      importId = await taxApi.padronStart({
        jurisdiction: jur,
        format: fmt,
        kind: fmt === "agip" ? "both" : kind,
        file_name: file.name,
        only_known: onlyKnown,
      });
      const stream = file.stream().pipeThrough(new TextDecoderStream("latin1"));
      const it = stream.getReader();
      let loaded = 0;
      for (;;) {
        const { value, done } = await it.read();
        if (done) break;
        reader.push(value);
        const rows = reader.take();
        for (let i = 0; i < rows.length; i += BATCH) {
          loaded += await taxApi.padronRows(importId, rows.slice(i, i + BATCH));
          setBusy(`Subiendo… ${loaded.toLocaleString("es-AR")} CUIT`);
        }
      }
      const res = reader.finish();
      if (res.rows.length) loaded += await taxApi.padronRows(importId, res.rows);
      const out = await taxApi.padronFinish(importId, {
        rows_skipped: res.skipped,
        rows_error: res.errors.length,
        period_from: res.period.from,
        period_to: res.period.to,
      });
      const firstErr = res.errors[0];
      toast({
        title: `Padrón cargado: ${out.rows_loaded.toLocaleString("es-AR")} CUIT`,
        description: firstErr
          ? `${res.errors.length} líneas con error (la ${firstErr.line}: ${PADRON_REASON_LABEL[firstErr.reason] ?? firstErr.reason}).`
          : onlyKnown
            ? `${res.skipped.toLocaleString("es-AR")} CUIT del archivo no son clientes ni proveedores.`
            : undefined,
        variant: "success",
      });
    } catch (e) {
      if (importId) await taxApi.padronDelete(importId).catch(() => undefined);
      toast({ title: "No se pudo cargar el padrón", description: taxErrorMessage(e), variant: "error" });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
      void qc.invalidateQueries({ queryKey: ["tax"] });
    }
  };

  return (
    <SettingsCard
      title="Padrones"
      description="Alícuotas de percepción y retención por CUIT y vigencia. Cargá el del mes cuando lo publica el organismo."
      icon={FileUp}
      padded
    >
      {!enabled ? (
        <Callout tone="neutral" icon={Lock} title="Desde el plan Business">
          Importá los padrones de ARBA, AGIP u otras jurisdicciones y el sistema usa la alícuota de cada cliente.
        </Callout>
      ) : (
        <div className="space-y-5">
          {!ro && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label="Jurisdicción"
                  value={jur}
                  onChange={setJur}
                  options={JURISDICTIONS.map((j) => ({ value: j.code, label: `${j.name} (${j.agency})` }))}
                />
                <Select
                  label="Formato"
                  value={fmt}
                  onChange={setFormat}
                  options={formats.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
                />
              </div>
              {fmt !== "agip" && (
                <Select
                  label="Contenido"
                  value={kind}
                  onChange={setKind}
                  hint={fmt === "arba" ? "ARBA publica un archivo de percepción y otro de retención." : undefined}
                  options={(["perception", "retention", "both"] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                />
              )}
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Sólo CUIT de mis clientes y proveedores
                  <span className="block text-[13px] text-muted-foreground">
                    Sube mucho menos. Un cliente nuevo aparece recién en el próximo import.
                  </span>
                </span>
                <Switch checked={onlyKnown} onCheckedChange={setOnlyKnown} label="Sólo CUIT conocidos" />
              </label>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void run(f);
                }}
              />
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>
                <FileUp size={15} /> {busy ?? "Elegir archivo del padrón"}
              </Button>
            </div>
          )}

          {(list.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no cargaste ningún padrón.</p>
          ) : (
            <ul className="divide-y divide-border">
              {(list.data ?? []).map((p) => {
                const expired = p.status === "ready" && p.period_to != null && p.period_to < new Date().toISOString().slice(0, 10);
                return (
                  <li key={p.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {jurisdictionName(p.jurisdiction)} · {KIND_LABEL[p.kind]}
                        <Badge tone={expired ? "warning" : STATUS[p.status].tone}>
                          {expired ? "Vencido" : STATUS[p.status].label}
                        </Badge>
                      </p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">
                        {p.period_from ? `${fmtDate(p.period_from)} al ${fmtDate(p.period_to)} · ` : ""}
                        {p.rows_loaded.toLocaleString("es-AR")} CUIT
                        {p.file_name ? ` · ${p.file_name}` : ""}
                      </p>
                    </div>
                    {!ro && (
                      <Button variant="ghost" size="sm" aria-label="Borrar" onClick={() => setDel(p)}>
                        <Trash2 size={15} />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(del)}
        onOpenChange={(o) => !o && setDel(null)}
        title="Borrar padrón"
        description="Las ventas nuevas dejan de usar estas alícuotas. Lo ya percibido queda igual."
        confirmLabel="Borrar"
        danger
        onConfirm={async () => {
          if (!del) return;
          try {
            await taxApi.padronDelete(del.id);
            void qc.invalidateQueries({ queryKey: ["tax"] });
          } catch (e) {
            toast({ title: "No se pudo borrar", description: taxErrorMessage(e), variant: "error" });
          }
          setDel(null);
        }}
      />
    </SettingsCard>
  );
}
