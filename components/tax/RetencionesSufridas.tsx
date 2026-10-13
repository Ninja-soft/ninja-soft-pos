"use client";

// Retenciones y percepciones SUFRIDAS (F18 · H106 como sujeto, ADR-095):
// lo que le retienen o perciben al negocio sus clientes, los procesadores de
// pago (Mercado Pago charges_details, liquidaciones por archivo, SIRTAC), los
// bancos (SIRCREB, débitos y créditos) y los proveedores (percepciones de
// facturas). Saldo a favor por impuesto y jurisdicción para la DDJJ, con el
// resumen y el XLSX. Dueño o encargado, feature percepciones_retenciones.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download, FileUp, Lock, Pencil, Plus, Receipt, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { SettingsCard } from "@/components/settings/Settings";
import { Spinner } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx, xlsxDay } from "@/lib/utils/xlsx";
import { jurisdictionName } from "@/lib/tax/catalog";
import {
  groupSuffered,
  SUFFERED_KIND_LABEL,
  SUFFERED_ORIGIN_LABEL,
  SUFFERED_REGIME_LABEL,
  SUFFERED_TAX_LABEL,
  type SufferedRow,
  type SufferedTax,
} from "@/lib/tax/suffered";
import { taxErrorMessage } from "@/modules/tax/api";
import { taxSubjectApi } from "@/modules/tax/subjectApi";
import { useSufferedList, useSufferedMutations } from "@/modules/tax/subjectHooks";
import { useTaxSettings } from "@/modules/tax/hooks";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { SufferedFormModal } from "./SufferedFormModal";
import { SufferedImportModal } from "./SufferedImportModal";

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthEnd(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(last).padStart(2, "0")}`;
}

const fmtDate = (iso: string) => {
  const p = iso.slice(0, 10).split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
};

const LINK_LABEL: Record<string, string> = {
  payment: "Cobro de venta",
  cc_movement: "Recibo de cuenta corriente",
  settlement_line: "Liquidación",
  treasury_movement: "Débito del banco",
};

const KPI_TAXES: SufferedTax[] = ["iibb", "iva", "ganancias", "debitos_creditos"];

export function RetencionesSufridas() {
  const feature = useFeature("percepciones_retenciones");
  const contabilidad = useFeature("contabilidad");
  const { data: me } = useMyTenant();
  const { data: settings } = useTaxSettings(feature === true);
  const { toast } = useToast();
  const m = useSufferedMutations();
  const [month, setMonth] = useState("");
  const [filter, setFilter] = useState<"all" | "review">("all");
  const [form, setForm] = useState<{ open: boolean; row: SufferedRow | null }>({ open: false, row: null });
  const [importOpen, setImportOpen] = useState(false);
  const [voiding, setVoiding] = useState<SufferedRow | null>(null);
  const [upgrade, setUpgrade] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => setMonth(thisMonth()), []);

  const locked = feature === false;
  const forbidden = me !== undefined && !me?.canManage;
  const period = month ? `${month}-01` : "";
  const { data: rows = [], isLoading, error } = useSufferedList(period, feature === true && !forbidden);
  const grouped = useMemo(() => groupSuffered(rows), [rows]);
  const review = rows.filter((r) => r.status === "active" && r.needs_review);
  const shown = filter === "review" ? review : rows;
  const home = settings?.iibb_jurisdiction ?? null;

  async function sync() {
    if (!month) return;
    try {
      const r = await m.sync.mutateAsync({ from: period, to: monthEnd(month) });
      toast({
        title: r.inserted ? `Se trajeron ${r.inserted} impuestos de ${r.lines} liquidaciones` : "No había impuestos nuevos en las liquidaciones del mes",
        variant: "success",
      });
    } catch (e) {
      toast({ title: taxErrorMessage(e), variant: "error" });
    }
  }

  async function doVoid(reason: string) {
    if (!voiding) return;
    try {
      await m.void.mutateAsync({ id: voiding.id, reason });
      setVoiding(null);
    } catch (e) {
      toast({ title: taxErrorMessage(e), variant: "error" });
    }
  }

  async function downloadXlsx() {
    if (!month) return;
    setExporting(true);
    try {
      const data = await taxSubjectApi.sufferedExport(period);
      const g = groupSuffered(data.rows);
      const name = String(data.agent?.["name"] ?? data.agent?.["cuit"] ?? "");
      await exportXlsx(`retenciones-sufridas-${month}`, [
        {
          name: "Para la DDJJ",
          title: "Retenciones y percepciones sufridas",
          subtitle: `${name} · ${month}`,
          columns: [
            { header: "Concepto", key: "label", width: 50 },
            { header: "Cantidad", key: "count", type: "number", width: 10 },
            { header: "Importe", key: "amount", type: "money", width: 16 },
          ],
          rows: g.groups.map((x) => ({ label: x.label, count: x.count, amount: x.amount })),
          totals: { amount: g.total },
        },
        {
          name: "Detalle",
          columns: [
            { header: "Fecha", key: "fecha", type: "date", width: 12 },
            { header: "Impuesto", key: "impuesto", width: 18 },
            { header: "Tipo", key: "tipo", width: 14 },
            { header: "Régimen", key: "regimen", width: 18 },
            { header: "Jurisdicción", key: "jur", width: 22 },
            { header: "Origen", key: "origen", width: 24 },
            { header: "CUIT agente", key: "cuit", width: 14 },
            { header: "Agente", key: "agente", width: 28 },
            { header: "Certificado", key: "cert", width: 18 },
            { header: "Base", key: "base", type: "money", width: 14 },
            { header: "Alícuota", key: "rate", type: "number", width: 10 },
            { header: "Importe", key: "amount", type: "money", width: 14 },
            { header: "Estado", key: "estado", width: 12 },
          ],
          rows: data.rows.map((r) => ({
            fecha: xlsxDay(r.operation_date),
            impuesto: SUFFERED_TAX_LABEL[r.tax],
            tipo: SUFFERED_KIND_LABEL[r.kind],
            regimen: SUFFERED_REGIME_LABEL[r.regime],
            jur: r.jurisdiction ? jurisdictionName(r.jurisdiction) : "",
            origen: SUFFERED_ORIGIN_LABEL[r.origin],
            cuit: r.agent_cuit ?? "",
            agente: r.agent_name ?? "",
            cert: r.certificate ?? "",
            base: r.base_amount,
            rate: r.rate,
            amount: r.amount,
            estado: r.status === "voided" ? "Anulada" : r.needs_review ? "Para revisar" : "Vigente",
          })),
        },
      ]);
    } catch (e) {
      toast({ title: taxErrorMessage(e), variant: "error" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Impuestos"
        title="Retenciones sufridas"
        icon={Receipt}
        description="Lo que te retienen o perciben clientes, bancos, procesadores de pago y proveedores: tu saldo a favor para la declaración jurada."
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
            Las retenciones sufridas y la liquidación de Ingresos Brutos vienen con Percepciones y retenciones.
          </Callout>
        ) : forbidden ? (
          <Callout tone="warning" icon={Lock} title="Sólo dueño o encargado">
            Pedile a quien administra el negocio que revise las retenciones.
          </Callout>
        ) : (
          <>
            <SettingsCard title="Mes de la declaración jurada" padded>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <input
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm sm:w-48"
                  aria-label="Mes"
                />
                <Button onClick={() => setForm({ open: true, row: null })} className="w-full sm:w-auto">
                  <Plus size={16} /> Registrar
                </Button>
                <Button variant="secondary" onClick={() => setImportOpen(true)} className="w-full sm:w-auto">
                  <FileUp size={16} /> Importar archivo
                </Button>
                <Button variant="secondary" onClick={() => void sync()} disabled={!month || m.sync.isPending} className="w-full sm:w-auto">
                  {m.sync.isPending ? <Spinner size={15} /> : <RefreshCw size={16} />} Traer de las liquidaciones
                </Button>
                <Button variant="secondary" onClick={() => void downloadXlsx()} disabled={!month || exporting} className="w-full sm:w-auto">
                  {exporting ? <Spinner size={15} /> : <Download size={16} />} XLSX
                </Button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Las de Mercado Pago y de las liquidaciones importadas entran solas al sincronizar; las percepciones de
                facturas de proveedor se suman desde Compras. Para Ingresos Brutos, la liquidación del mes está en{" "}
                <Link href="/impuestos/iibb" className="font-medium text-foreground underline underline-offset-2">
                  Ingresos Brutos
                </Link>
                .
              </p>
            </SettingsCard>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {KPI_TAXES.map((t) => (
                <div key={t} className="rounded-md bg-muted/50 px-3 py-2.5">
                  <div className="text-xs text-muted-foreground">{SUFFERED_TAX_LABEL[t]}</div>
                  <div className="text-base font-semibold tabular-nums">{formatCurrency(grouped.byTax[t] ?? 0)}</div>
                </div>
              ))}
            </div>

            {review.length > 0 && (
              <Callout
                tone="warning"
                icon={AlertTriangle}
                title={`${review.length} para revisar`}
                actions={
                  <Button size="sm" variant="secondary" onClick={() => setFilter(filter === "review" ? "all" : "review")}>
                    {filter === "review" ? "Ver todas" : "Ver sólo esas"}
                  </Button>
                }
              >
                No se identificó el impuesto o la jurisdicción. Editalas: hasta entonces no entran en la liquidación de
                Ingresos Brutos.
              </Callout>
            )}

            <SettingsCard title="Para la declaración jurada">
              {grouped.groups.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Sin retenciones ni percepciones en el mes.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {grouped.groups.map((g) => (
                    <li key={g.key} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                      <span className="min-w-0">
                        {g.label}
                        <span className="ml-1 text-xs text-muted-foreground">({g.count})</span>
                      </span>
                      <span className="font-semibold tabular-nums">{formatCurrency(g.amount)}</span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{formatCurrency(grouped.total)}</span>
                  </li>
                </ul>
              )}
            </SettingsCard>

            <SettingsCard title="Detalle del mes">
              {error ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No se pudieron cargar. {taxErrorMessage(error)}
                </p>
              ) : isLoading ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Cargando...</p>
              ) : shown.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nada para mostrar.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {shown.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {SUFFERED_KIND_LABEL[r.kind]} {SUFFERED_TAX_LABEL[r.tax]}
                          {r.jurisdiction ? ` · ${jurisdictionName(r.jurisdiction)}` : ""}
                          {r.regime === "sircreb" || r.regime === "sirtac" ? ` · ${r.regime.toUpperCase()}` : ""}
                          {r.status === "voided" && <Badge tone="danger">Anulada</Badge>}
                          {r.status === "active" && r.needs_review && <Badge tone="warning">Para revisar</Badge>}
                          {r.liquidated && <Badge>Liquidada</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {fmtDate(r.operation_date)} · {SUFFERED_ORIGIN_LABEL[r.origin]}
                          {r.provider_key ? ` (${r.provider_key})` : ""}
                          {r.customer_name ? ` · ${r.customer_name}` : ""}
                          {r.agent_name ? ` · ${r.agent_name}` : ""}
                          {r.certificate ? ` · ${r.certificate}` : ""}
                        </div>
                        {r.source === "entry" && contabilidad === true && r.status === "active" && (
                          <div className="text-xs text-muted-foreground">
                            {r.linked ? `Vinculada a: ${LINK_LABEL[r.linked]}` : "Sin documento vinculado: no genera asiento"}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold tabular-nums">{formatCurrency(r.amount)}</span>
                        {r.source === "entry" && r.status === "active" && !r.liquidated && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label="Editar"
                              onClick={() => setForm({ open: true, row: r })}
                            >
                              <Pencil size={15} />
                            </Button>
                            <Button size="sm" variant="ghost" aria-label="Anular" onClick={() => setVoiding(r)}>
                              <XCircle size={15} />
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsCard>

            <SettingsCard title="¿Cómo se usan?" padded>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  <b className="text-foreground">Ingresos Brutos</b>: las retenciones, percepciones, SIRCREB y SIRTAC del
                  mes se descuentan en la liquidación de la jurisdicción. Lo que sobra queda como saldo a favor.
                </p>
                <p>
                  <b className="text-foreground">IVA y Ganancias</b>: se computan en la declaración jurada del impuesto
                  (en IVA, como pagos a cuenta del período). Bajá el XLSX para tu contador o compará con Mis Retenciones
                  de ARCA.
                </p>
                <p>
                  <b className="text-foreground">Débitos y créditos</b>: una parte es pago a cuenta de Ganancias; el
                  porcentaje lo define tu contador.
                </p>
              </div>
            </SettingsCard>
          </>
        )}
      </div>

      <SufferedFormModal
        open={form.open}
        row={form.row}
        onOpenChange={(v) => setForm((f) => ({ ...f, open: v }))}
        defaultJurisdiction={home}
      />
      <SufferedImportModal open={importOpen} onOpenChange={setImportOpen} defaultJurisdiction={home} />
      <ConfirmDialog
        open={Boolean(voiding)}
        onOpenChange={(v) => {
          if (!v) setVoiding(null);
        }}
        title="Anular la retención"
        description="Deja de contar como saldo a favor. Si tenía asiento, se hace el contra-asiento."
        confirmLabel="Anular"
        danger
        loading={m.void.isPending}
        withReason
        onConfirm={(r) => void doVoid(r)}
      />
      <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="percepciones_retenciones" featureLabel="Retenciones sufridas" />
    </PageContainer>
  );
}
