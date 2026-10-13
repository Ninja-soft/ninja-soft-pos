"use client";

// Retenciones practicadas como agente (F18 · H106, ADR-079): registro del mes
// con los certificados y la descarga de los archivos para SICORE (Ganancias,
// IVA y SUSS) y ARBA (IIBB Buenos Aires). El servidor audita cada descarga
// (tax_withholdings_export) y el archivo se arma con lib/tax/sicore.ts.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download, Lock, Receipt, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Spinner";
import { SettingsCard } from "@/components/settings/Settings";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { formatCurrency } from "@/lib/utils/format";
import { jurisdictionName } from "@/lib/tax/catalog";
import { RET_TAX_LABEL, type RetTax } from "@/lib/tax/retentions";
import { buildExport, validateExport, type ExportIssue } from "@/lib/tax/sicore";
import { formatPaymentNumber } from "@/lib/purchases/orders";
import { taxApi, taxErrorMessage } from "@/modules/tax/api";
import { useTaxSettings, useWithholdings } from "@/modules/tax/hooks";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { CertificateButtons } from "./RetentionCertificates";

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(m: string): { from: string; to: string } {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, "0")}` };
}

const fmtDate = (iso: string) => {
  const p = iso.slice(0, 10).split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
};

function downloadText(name: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const TAXES: (RetTax | "all")[] = ["all", "ganancias", "iva", "iibb", "suss"];

export function RetencionesPracticadas() {
  const feature = useFeature("percepciones_retenciones");
  const { data: me } = useMyTenant();
  const [month, setMonth] = useState("");
  const [tax, setTax] = useState<RetTax | "all">("all");
  const [busy, setBusy] = useState<"sicore" | "arba" | null>(null);
  const [issues, setIssues] = useState<ExportIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState(false);
  // Valores de los archivos del negocio (ADR-105): Configuración > Impuestos > Exportaciones.
  const settings = useTaxSettings(feature === true);

  useEffect(() => setMonth(thisMonth()), []);

  const locked = feature === false;
  const forbidden = me !== undefined && !me?.canManage;
  const range = month ? monthRange(month) : null;
  const { data: rows = [], isLoading, error: listError } = useWithholdings(
    range?.from ?? "",
    range?.to ?? "",
    Boolean(range) && feature === true && !forbidden,
  );
  const shown = useMemo(() => rows.filter((r) => tax === "all" || r.tax === tax), [rows, tax]);
  const totals = useMemo(() => {
    const t: Partial<Record<RetTax, number>> = {};
    for (const r of rows) if (r.status === "issued") t[r.tax] = (t[r.tax] ?? 0) + r.amount;
    return t;
  }, [rows]);

  async function exportFile(format: "sicore" | "arba") {
    if (!range) return;
    setBusy(format);
    setIssues(null);
    setError(null);
    try {
      const data = await taxApi.withholdingsExport(range.from, format);
      const found = validateExport(format, data.agent, data.rows);
      setIssues(found);
      if (found.some((i) => i.level === "error")) return;
      const p = settings.data?.params;
      const f = buildExport(format, data.agent, range.from, data.rows, {
        sicoreCbteCode: p?.sicore_cbte_code ?? null,
        arbaBranch: p?.arba_branch ?? null,
        arbaActivity: p?.arba_activity ?? null,
      });
      if (f.records > 0) downloadText(f.name, f.content);
    } catch (e) {
      setError(taxErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Impuestos"
        title="Retenciones practicadas"
        icon={Receipt}
        description="Lo que retuviste a tus proveedores como agente, con sus certificados y los archivos para presentar."
      />

      <div className="mt-6 space-y-6">
        {locked ? (
          <Callout
            tone="warning"
            icon={Lock}
            title="No incluido en tu plan"
            actions={
              <Button size="sm" onClick={() => setUpgrade(true)}>
                Ver planes
              </Button>
            }
          >
            Las retenciones como agente vienen con Percepciones y retenciones.
          </Callout>
        ) : forbidden ? (
          <Callout tone="warning" icon={Lock} title="Sólo dueño o encargado">
            Pedile a quien administra el negocio que revise las retenciones.
          </Callout>
        ) : (
          <>
            <SettingsCard title="Mes" padded>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <input
                  type="month"
                  value={month}
                  onChange={(e) => {
                    setMonth(e.target.value);
                    setIssues(null);
                  }}
                  className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm sm:w-48"
                  aria-label="Mes"
                />
                <Button
                  variant="secondary"
                  onClick={() => void exportFile("sicore")}
                  disabled={!month || busy !== null}
                  className="w-full sm:w-auto"
                >
                  {busy === "sicore" ? <Spinner size={15} /> : <Download size={16} />} SICORE (Ganancias, IVA, SUSS)
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void exportFile("arba")}
                  disabled={!month || busy !== null}
                  className="w-full sm:w-auto"
                >
                  {busy === "arba" ? <Spinner size={15} /> : <Download size={16} />} ARBA (IIBB)
                </Button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Antes de descargar revisamos que estén los CUIT y los códigos de régimen. Las retenciones de órdenes
                de pago anuladas no entran.
              </p>
            </SettingsCard>

            {error && (
              <Callout tone="danger" icon={XCircle} title="No se pudo generar">
                {error}
              </Callout>
            )}
            {issues && issues.length > 0 && (
              <SettingsCard title="Antes de presentar" padded>
                <ul className="space-y-2.5 text-sm">
                  {issues.map((i, k) => (
                    <li key={`${i.code}-${k}`} className="flex gap-2.5">
                      {i.level === "error" ? (
                        <XCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
                      ) : (
                        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                      )}
                      <span>{i.message}</span>
                    </li>
                  ))}
                </ul>
              </SettingsCard>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(["ganancias", "iva", "iibb", "suss"] as RetTax[]).map((t) => (
                <div key={t} className="rounded-md bg-muted/50 px-3 py-2.5">
                  <div className="text-xs text-muted-foreground">{RET_TAX_LABEL[t]}</div>
                  <div className="text-base font-semibold tabular-nums">{formatCurrency(totals[t] ?? 0)}</div>
                </div>
              ))}
            </div>

            <SettingsCard
              title="Certificados del mes"
              actions={
                <select
                  aria-label="Impuesto"
                  value={tax}
                  onChange={(e) => setTax(e.target.value as RetTax | "all")}
                  className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                >
                  {TAXES.map((t) => (
                    <option key={t} value={t} className="bg-popover text-popover-foreground">
                      {t === "all" ? "Todos" : RET_TAX_LABEL[t]}
                    </option>
                  ))}
                </select>
              }
            >
              {listError ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No se pudieron cargar las retenciones. {taxErrorMessage(listError)}
                </p>
              ) : isLoading ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Cargando...</p>
              ) : shown.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No hay retenciones en el mes. Se generan al registrar una{" "}
                  <Link href="/compras/facturas" className="font-medium text-foreground underline underline-offset-2">
                    orden de pago
                  </Link>
                  .
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {shown.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {r.certificate}
                          {r.status === "voided" && <Badge tone="danger">Anulada</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {fmtDate(r.date)} · {r.supplier_name ?? r.subject_snapshot?.name} ·{" "}
                          {formatPaymentNumber(r.payment_number)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {RET_TAX_LABEL[r.tax]}
                          {r.tax === "iibb" && r.jurisdiction ? ` ${jurisdictionName(r.jurisdiction)}` : ""}
                          {r.concept_name ? ` · ${r.concept_name}` : ""} · base {formatCurrency(r.payment_base)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold tabular-nums">{formatCurrency(r.amount)}</span>
                        <CertificateButtons row={r} compact />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsCard>

            <SettingsCard title="¿Cómo se presentan?" padded>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  <b className="text-foreground">SICORE</b> (ARCA): Ganancias, IVA y SUSS. Descargá el archivo del mes e
                  importalo en el aplicativo SICORE desde Importación de retenciones y percepciones. Después generás la
                  declaración jurada y el pago (VEP).
                </p>
                <p>
                  <b className="text-foreground">ARBA</b>: Ingresos Brutos de Buenos Aires. Importá el archivo en la
                  aplicación de agentes de recaudación de ARBA (retenciones) con tu CIT.
                </p>
                <p>
                  <b className="text-foreground">AGIP (CABA)</b> y otras provincias: todavía no generamos el archivo.
                  Cargalas en e-ARCIBA o en el sistema de la provincia con los datos de esta lista.
                </p>
                <p>
                  Los diseños de los archivos son orientativos: probá la importación con tu contador antes de
                  presentar. Los valores de la RG 830 se pueden ajustar en{" "}
                  <Link href="/configuracion" className="font-medium text-foreground underline underline-offset-2">
                    Configuración &gt; Impuestos
                  </Link>
                  .
                </p>
              </div>
            </SettingsCard>
          </>
        )}
      </div>
      <UpgradeModal
        open={upgrade}
        onOpenChange={setUpgrade}
        featureKey="percepciones_retenciones"
        featureLabel="Retenciones como agente"
      />
    </PageContainer>
  );
}
