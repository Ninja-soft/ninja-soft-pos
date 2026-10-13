"use client";

// Importa retenciones y percepciones sufridas desde un archivo (F18 · H106,
// ADR-095): "Mis Retenciones" de ARCA, la consulta de SIRCREB o SIRTAC de
// COMARB o una planilla propia con encabezado. Se lee en el navegador
// (lib/tax/suffered.ts), se muestra qué se entendió y el servidor valida,
// descarta duplicados y audita (tax_suffered_import).

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { formatCurrency } from "@/lib/utils/format";
import { jurisdictionName } from "@/lib/tax/catalog";
import { parseSufferedFile, SUFFERED_TAX_LABEL, type SufferedParseResult, type SufferedRule } from "@/lib/tax/suffered";
import { taxErrorMessage } from "@/modules/tax/api";
import { useSufferedMutations } from "@/modules/tax/subjectHooks";
import { useCustomValues } from "@/modules/tax/customHooks";

type Source = "mis_retenciones" | "sircreb" | "sirtac" | "planilla";

export function SufferedImportModal({
  open,
  onOpenChange,
  defaultJurisdiction,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultJurisdiction: string | null;
}) {
  const m = useSufferedMutations();
  // Reglas propias del negocio (ADR-105, Configuración > Impuestos > Retenciones).
  const custom = useCustomValues(open);
  const [source, setSource] = useState<Source>("mis_retenciones");
  const [parsed, setParsed] = useState<SufferedParseResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setParsed(null);
    setFileName("");
    setResult(null);
    setError(null);
  }

  async function onFile(f: File | undefined) {
    reset();
    if (!f) return;
    setFileName(f.name);
    const buf = await f.arrayBuffer();
    // Los archivos de ARCA y COMARB suelen venir en Latin-1.
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);
    const hint = source === "sircreb" || source === "sirtac" ? source : null;
    const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const rules: SufferedRule[] = (custom.data ?? [])
      .filter((v) => v.catalog === "suffered_rule" && v.is_active && v.valid_from <= today && (!v.valid_to || v.valid_to >= today))
      .map((v) => ({ pattern: v.item_key, ...(v.data as Omit<SufferedRule, "pattern">) }));
    setParsed(parseSufferedFile(text, defaultJurisdiction, hint, rules));
  }

  async function confirm() {
    if (!parsed || parsed.rows.length === 0) return;
    setError(null);
    try {
      let inserted = 0;
      let dups = 0;
      const errs: string[] = [];
      for (let i = 0; i < parsed.rows.length; i += 2000) {
        const r = await m.import.mutateAsync({ rows: parsed.rows.slice(i, i + 2000), source });
        inserted += r.inserted;
        dups += r.duplicates;
        for (const e of r.errors) errs.push(`Fila ${e.row + i}: ${e.message}`);
      }
      setResult(
        `Se cargaron ${inserted}. ${dups ? `${dups} ya estaban. ` : ""}${errs.length ? `${errs.length} con error: ${errs.slice(0, 5).join("; ")}` : ""}`,
      );
      setParsed(null);
    } catch (e) {
      setError(taxErrorMessage(e));
    }
  }

  const total = parsed?.rows.reduce((s, r) => s + r.amount, 0) ?? 0;
  const review = parsed?.rows.filter((r) => r.needs_review).length ?? 0;

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      title="Importar retenciones sufridas"
      description="CSV o TXT con encabezado. Se reconocen las columnas por el nombre: fecha, importe, impuesto, régimen, jurisdicción, CUIT del agente, certificado, base y alícuota."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={m.import.isPending}>
            Cerrar
          </Button>
          <Button onClick={() => void confirm()} disabled={!parsed || parsed.rows.length === 0 || m.import.isPending}>
            {m.import.isPending ? <Spinner size={15} /> : null} Importar {parsed?.rows.length ? parsed.rows.length : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select<Source>
          label="Archivo"
          value={source}
          onChange={(v) => {
            setSource(v);
            reset();
          }}
          options={[
            { value: "mis_retenciones", label: "Mis Retenciones (ARCA)" },
            { value: "sircreb", label: "Consulta de SIRCREB (bancos)" },
            { value: "sirtac", label: "Consulta de SIRTAC (tarjetas)" },
            { value: "planilla", label: "Planilla propia" },
          ]}
        />
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Elegí el archivo</span>
          <input
            type="file"
            accept=".csv,.txt,.tsv,text/csv,text/plain"
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="block w-full text-sm file:mr-3 file:h-10 file:rounded-md file:border-0 file:bg-muted file:px-3 file:text-sm file:font-medium"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Planilla propia: una fila por retención con las columnas Fecha, Impuesto, Jurisdicción, Tipo, Base, Alícuota,
          Importe, CUIT del agente y Certificado. Los diseños de ARCA y COMARB son orientativos: revisá el resumen antes
          de importar.
        </p>

        {parsed && (
          <div className="space-y-2 rounded-md bg-muted/50 p-3 text-sm">
            <div className="font-medium">{fileName}</div>
            <div>
              {parsed.rows.length} filas por {formatCurrency(total)}
              {parsed.skipped ? ` · ${parsed.skipped} en cero o negativas salteadas` : ""}
              {review ? ` · ${review} para revisar (sin jurisdicción o impuesto)` : ""}
            </div>
            {parsed.rows.slice(0, 5).map((r, i) => (
              <div key={i} className="text-xs text-muted-foreground">
                {r.operation_date} · {SUFFERED_TAX_LABEL[r.tax]}
                {r.jurisdiction ? ` ${jurisdictionName(r.jurisdiction)}` : ""} · {formatCurrency(r.amount)}
                {r.certificate ? ` · cert. ${r.certificate}` : ""}
              </div>
            ))}
            {parsed.errors.length > 0 && (
              <ul className="space-y-1 text-xs text-danger">
                {parsed.errors.slice(0, 10).map((e) => (
                  <li key={e.line}>
                    Línea {e.line}: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {result && <p className="text-sm">{result}</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
