"use client";

// Importar "Mis Comprobantes Recibidos" de ARCA (F24 · H167, ADR-178): el
// archivo (XLSX o CSV, tal como lo baja el portal) se lee en el navegador; el
// servidor revisa cada comprobante sin grabar (vista previa) y después carga
// los confirmados. Duplicados, proveedores a crear, CUIT ajena y errores por
// fila; la letra que no corresponde se informa sin cortar el resto.

import { useMemo, useState } from "react";
import { FileUp, SearchCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { readXlsxGrid } from "@/lib/utils/xlsxImport";
import {
  ARCA_STATUS_LABEL,
  arcaErrorMessage,
  arcaStatus,
  parseArcaGrid,
  parseCsv,
  prepareArcaRows,
  type ArcaParseResult,
  type ArcaStatus,
} from "@/lib/purchases/arcaImport";
import { INVOICE_KIND_LABEL, formatInvoiceNumber } from "@/lib/purchases/invoices";
import { formatCuit, normalizeCuit } from "@/lib/purchases/suppliers";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import { useTaxSettings } from "@/modules/tax/hooks";
import { useSuppliers } from "@/modules/purchases/hooks";
import { usePurchasesProMutations, type ArcaImportResult } from "@/modules/purchases/pro";
import { padronApi } from "@/modules/padron/api";
import { usePadronStatus } from "@/modules/padron/hooks";
import { fmtDate } from "./shared";

const TONE: Record<ArcaStatus, BadgeTone> = {
  nuevo: "success",
  proveedor_a_crear: "info",
  duplicado: "neutral",
  receptor_distinto: "warning",
  error: "danger",
};

const PADRON_LIMIT = 30;

async function readGrid(file: File): Promise<{ grid: string[][]; fatalError: string | null }> {
  if (/\.csv$/i.test(file.name) || file.type === "text/csv") {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder("utf-8").decode(buf);
    // Algunos CSV de ARCA vienen en Latin-1.
    if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);
    const grid = parseCsv(text);
    return { grid, fatalError: grid.length === 0 ? "El archivo está vacío." : null };
  }
  return readXlsxGrid(await file.arrayBuffer());
}

export function ArcaImportModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const pro = usePurchasesProMutations();
  const businessCuit = useTaxSettings(open).data?.cuit ?? null;
  const { data: suppliers = [] } = useSuppliers({}, open);
  const padron = usePadronStatus(open);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ArcaParseResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ivaByCuit, setIvaByCuit] = useState<Map<string, string>>(new Map());
  const [server, setServer] = useState<ArcaImportResult | null>(null);
  const [includeForeign, setIncludeForeign] = useState(false);
  const [report, setReport] = useState<ArcaImportResult | null>(null);
  const [padronBusy, setPadronBusy] = useState(false);

  function reset() {
    setFileName("");
    setParsed(null);
    setFatal(null);
    setIvaByCuit(new Map());
    setServer(null);
    setIncludeForeign(false);
    setReport(null);
  }

  const prepared = useMemo(
    () => (parsed ? prepareArcaRows(parsed, businessCuit, ivaByCuit) : []),
    [parsed, businessCuit, ivaByCuit],
  );
  const byRow = useMemo(() => new Map((server?.rows ?? []).map((r) => [r.row, r])), [server]);
  const rows = prepared.map((p) => ({ p, status: arcaStatus(p, byRow.get(p.row.rowNumber)) }));
  const counts = rows.reduce<Record<ArcaStatus, number>>(
    (acc, r) => ({ ...acc, [r.status]: acc[r.status] + 1 }),
    { nuevo: 0, proveedor_a_crear: 0, duplicado: 0, receptor_distinto: 0, error: 0 },
  );
  const toImport = rows.filter(
    (r) =>
      r.p.payload &&
      (r.status === "nuevo" || r.status === "proveedor_a_crear" || (includeForeign && r.status === "receptor_distinto")),
  );
  const foreignFile = Boolean(
    businessCuit && parsed?.receptorCuit && normalizeCuit(businessCuit) !== parsed.receptorCuit,
  );
  const knownCuits = useMemo(() => new Set(suppliers.map((x) => normalizeCuit(x.cuit)).filter(Boolean)), [suppliers]);
  const unknownCuits = [
    ...new Set(
      prepared
        .map((p) => p.row.issuer_cuit)
        .filter((c): c is string => Boolean(c) && !knownCuits.has(c!) && !ivaByCuit.has(c!)),
    ),
  ];

  async function preview(p: ArcaParseResult, iva: Map<string, string>) {
    const payloads = prepareArcaRows(p, businessCuit, iva)
      .map((x) => x.payload)
      .filter((x): x is Record<string, unknown> => Boolean(x));
    if (payloads.length === 0) {
      setServer({ applied: false, created: 0, skipped: 0, errors: 0, suppliers_created: 0, rows: [] });
      return;
    }
    try {
      setServer(await pro.arcaImport.mutateAsync({ rows: payloads, apply: false, fileName }));
    } catch (e) {
      toast({ title: "No se pudo revisar el archivo", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  async function onFile(f: File | null) {
    reset();
    if (!f) return;
    setFileName(f.name);
    const g = await readGrid(f);
    if (g.fatalError) {
      setFatal(g.fatalError);
      return;
    }
    const p = parseArcaGrid(g.grid);
    if (p.fatalError) {
      setFatal(p.fatalError);
      return;
    }
    setParsed(p);
    await preview(p, new Map());
  }

  // Condición de IVA de los proveedores nuevos desde el padrón de ARCA.
  async function completeFromPadron() {
    if (!parsed) return;
    setPadronBusy(true);
    const next = new Map(ivaByCuit);
    for (const cuit of unknownCuits.slice(0, PADRON_LIMIT)) {
      try {
        const r = await padronApi.lookup(cuit);
        if (r.ok && r.status === "ok") next.set(cuit, r.persona.iva_condition);
      } catch {
        // Sin padrón para esa CUIT: queda la condición que sale de la letra.
      }
    }
    setIvaByCuit(next);
    setPadronBusy(false);
    await preview(parsed, next);
  }

  async function apply() {
    const payloads = toImport.map((r) => r.p.payload!).filter(Boolean);
    if (payloads.length === 0) return;
    try {
      const res = await pro.arcaImport.mutateAsync({ rows: payloads, apply: true, fileName });
      setReport(res);
      toast({
        title: `Se cargaron ${res.created} comprobantes`,
        description: res.errors > 0 ? `${res.errors} con error: revisá el detalle.` : undefined,
        variant: res.errors > 0 ? "warning" : "success",
      });
    } catch (e) {
      toast({ title: "No se pudo importar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  const reportErrors = (report?.rows ?? []).filter((r) => r.action === "error");

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Importar comprobantes recibidos de ARCA"
      description='Bajá de ARCA "Mis Comprobantes" > Recibidos el archivo del mes (Excel o CSV) y subilo tal cual.'
      className="sm:max-w-5xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">
            {report ? `Cargados ${report.created} · ya estaban ${report.skipped} · con error ${report.errors}` : `${toImport.length} para importar`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {report ? "Cerrar" : "Cancelar"}
            </Button>
            {!report && (
              <Button
                onClick={() => void apply()}
                loading={pro.arcaImport.isPending}
                disabled={!server || toImport.length === 0}
              >
                Importar {toImport.length}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {!report && (
          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-border px-4 py-4 text-sm hover:bg-muted/40">
            <FileUp size={18} className="text-muted-foreground" />
            <span className="flex-1">{fileName || "Elegí el archivo de Mis Comprobantes Recibidos (.xlsx o .csv)"}</span>
            <input
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />
          </label>
        )}
        {fatal && <Callout tone="danger">{fatal}</Callout>}
        {foreignFile && (
          <Callout tone="warning" title="El archivo es de otra CUIT">
            Lo bajaron con la CUIT {formatCuit(parsed?.receptorCuit)} y tu negocio tiene la {formatCuit(businessCuit)}.
            Revisá que sea el archivo correcto antes de importar.
          </Callout>
        )}

        {report && (
          <div className="space-y-2">
            <Callout tone={report.errors > 0 ? "warning" : "success"} title="Importación terminada">
              Se cargaron {report.created} comprobantes ({report.suppliers_created} proveedores nuevos). Ya estaban
              cargados {report.skipped}. Con error {report.errors}.
            </Callout>
            {reportErrors.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {reportErrors.map((r) => (
                  <li key={r.row}>
                    Fila {r.row}: {arcaErrorMessage(r.message)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!report && parsed && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {(Object.keys(counts) as ArcaStatus[])
                .filter((k) => counts[k] > 0)
                .map((k) => (
                  <Badge key={k} tone={TONE[k]}>
                    {ARCA_STATUS_LABEL[k]}: {counts[k]}
                  </Badge>
                ))}
              <span className="text-xs text-muted-foreground">
                {parsed.layout === "por_alicuota" ? "Con IVA por alícuota" : "Diseño clásico (IVA total)"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {unknownCuits.length > 0 && padron.data?.available && (
                <Button size="sm" variant="secondary" loading={padronBusy} onClick={() => void completeFromPadron()}>
                  <SearchCheck size={14} /> Completar proveedores nuevos con ARCA
                  {unknownCuits.length > PADRON_LIMIT ? ` (primeros ${PADRON_LIMIT})` : ""}
                </Button>
              )}
              {counts.receptor_distinto > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={includeForeign} onCheckedChange={setIncludeForeign} />
                  Importar también los de CUIT ajena
                </label>
              )}
            </div>
            {!server && pro.arcaImport.isPending && (
              <p className="text-sm text-muted-foreground">Revisando los comprobantes...</p>
            )}
            <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Fila</th>
                    <th className="px-3 py-2 text-left">Fecha</th>
                    <th className="px-3 py-2 text-left">Comprobante</th>
                    <th className="px-3 py-2 text-left">Proveedor</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-left">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map(({ p, status }) => {
                    const srv = byRow.get(p.row.rowNumber);
                    const msgs = [
                      ...p.errors,
                      ...(srv?.action === "error" ? [arcaErrorMessage(srv.message)] : []),
                      ...p.warnings,
                    ];
                    return (
                      <tr key={p.row.rowNumber} className="align-top">
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">{p.row.rowNumber}</td>
                        <td className="px-3 py-2">{p.row.issue_date ? fmtDate(p.row.issue_date) : "-"}</td>
                        <td className="px-3 py-2">
                          {p.row.kind && p.row.letter && p.row.point_of_sale && p.row.number ? (
                            <>
                              <div className="font-mono">
                                {formatInvoiceNumber(p.row.letter, p.row.point_of_sale, p.row.number)}
                              </div>
                              <div className="text-xs text-muted-foreground">{INVOICE_KIND_LABEL[p.row.kind]}</div>
                            </>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div>{p.row.issuer_name ?? "-"}</div>
                          <div className="text-xs text-muted-foreground">{formatCuit(p.row.issuer_cuit)}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(p.row.total)}
                          {p.row.currency !== "ARS" && <span className="text-xs text-muted-foreground"> {p.row.currency}</span>}
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={TONE[status]}>{ARCA_STATUS_LABEL[status]}</Badge>
                          {msgs.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {msgs.map((x) => (
                                <li key={x}>{x}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
