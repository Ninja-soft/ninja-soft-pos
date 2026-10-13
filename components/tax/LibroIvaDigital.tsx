"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, FileArchive, Lock, SearchCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Spinner";
import { SettingsCard } from "@/components/settings/Settings";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { formatCurrency } from "@/lib/utils/format";
import { FILE_NAMES, PORTAL_IVA_STEPS, type LibroIssue, type LibroSummary } from "@/lib/tax/libroIva";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";

// Libro IVA Digital (F18 · H108, ADR-076): revisar el mes, ver los problemas
// en lenguaje simple y descargar el zip con los archivos de importación del
// Portal IVA. Todo se arma en el servidor (app/api/libro-iva).

type Check = { summary: LibroSummary; issues: LibroIssue[]; emitter: { cuit: string | null; name?: string | null } };

function previousMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? "No se pudo armar el Libro IVA Digital.";
  } catch {
    return res.status === 401 || res.redirected ? "Iniciá sesión de nuevo." : "No se pudo armar el Libro IVA Digital.";
  }
}

const money = (cents: number) => formatCurrency(cents / 100);

export function LibroIvaDigital() {
  const feature = useFeature("facturacion_afip");
  const { data: me } = useMyTenant();
  const [month, setMonth] = useState("");
  const [max, setMax] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "zip" | null>(null);
  const [upgrade, setUpgrade] = useState(false);

  // El mes por defecto sale del reloj del navegador (después de montar: sin
  // diferencias de hidratación).
  useEffect(() => {
    setMonth(previousMonth());
    setMax(thisMonth());
  }, []);

  const locked = feature === false;
  const forbidden = me !== undefined && !me?.canManage;
  const errors = check?.issues.filter((i) => i.level === "error") ?? [];
  const warnings = check?.issues.filter((i) => i.level === "warning") ?? [];

  const review = async (m = month) => {
    if (!m) return;
    setBusy("check");
    setError(null);
    setCheck(null);
    try {
      const res = await fetch(`/api/libro-iva?period=${m}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      setCheck((await res.json()) as Check);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const downloadZip = async () => {
    setBusy("zip");
    setError(null);
    try {
      const res = await fetch(`/api/libro-iva?period=${month}&download=1`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const blob = await res.blob();
      const name =
        res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `libro-iva-digital-${month}.zip`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Impuestos"
        title="Libro IVA Digital"
        icon={FileArchive}
        description="Los archivos de ventas y compras del mes listos para importar en el Portal IVA de ARCA, sin retipear."
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
            El Libro IVA Digital viene con la facturación electrónica.
          </Callout>
        ) : forbidden ? (
          <Callout tone="warning" icon={Lock} title="Sólo dueño o encargado">
            Pedile a quien administra el negocio que genere el libro.
          </Callout>
        ) : (
          <>
            <SettingsCard title="Elegí el mes" padded>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  type="month"
                  value={month}
                  max={max || undefined}
                  onChange={(e) => {
                    setMonth(e.target.value);
                    setCheck(null);
                  }}
                  className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm sm:w-48"
                  aria-label="Mes del libro"
                />
                <Button onClick={() => review()} disabled={!month || busy !== null} className="w-full sm:w-auto">
                  {busy === "check" ? <Spinner size={15} /> : <SearchCheck size={16} />} Revisar el mes
                </Button>
                <Button
                  variant="secondary"
                  onClick={downloadZip}
                  disabled={!check || errors.length > 0 || busy !== null}
                  className="w-full sm:w-auto"
                >
                  {busy === "zip" ? <Spinner size={15} /> : <Download size={16} />} Descargar ZIP
                </Button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Primero revisamos el mes. Si hay algo que corregir te lo decimos acá abajo y la descarga se habilita
                cuando esté todo bien.
              </p>
            </SettingsCard>

            {error && (
              <Callout tone="danger" icon={XCircle} title="No se pudo generar">
                {error}
              </Callout>
            )}

            {check && (
              <>
                {errors.length === 0 ? (
                  <Callout tone="success" icon={CheckCircle2} title="Listo para descargar">
                    No encontramos problemas que frenen el libro{warnings.length > 0 ? ". Mirá los avisos de abajo." : "."}
                  </Callout>
                ) : (
                  <Callout tone="danger" icon={XCircle} title={`Hay ${errors.length} ${errors.length === 1 ? "cosa" : "cosas"} para corregir`}>
                    Corregilas en NinjaSoft y volvé a revisar el mes.
                  </Callout>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <Side
                    title="Ventas"
                    count={check.summary.ventas.count}
                    rows={[
                      ["Neto gravado", money(check.summary.ventas.neto)],
                      ["IVA débito fiscal", money(check.summary.ventas.iva)],
                      ["Total", money(check.summary.ventas.total)],
                    ]}
                  />
                  <Side
                    title="Compras"
                    count={check.summary.compras.count}
                    rows={[
                      ["Neto gravado", money(check.summary.compras.neto)],
                      ["IVA crédito fiscal", money(check.summary.compras.credito)],
                      ["Total", money(check.summary.compras.total)],
                    ]}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Las notas de crédito restan en este resumen. En los archivos van en positivo: ARCA las resta por el
                  tipo de comprobante.
                </p>

                {errors.length > 0 && <IssueList title="Para corregir" items={errors} tone="danger" />}
                {warnings.length > 0 && <IssueList title="Avisos" items={warnings} tone="warning" />}
              </>
            )}

            <SettingsCard title="¿Qué es?" padded>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  El Libro IVA Digital es el registro mensual de tus ventas y compras que ARCA pide a los Responsables
                  Inscriptos, dentro del Portal IVA. Con ese libro se arma la declaración jurada de IVA del mes.
                </p>
                <p>
                  NinjaSoft arma los archivos con las facturas aprobadas por ARCA (con CAE o CAEA) y con los
                  comprobantes de proveedores que cargaste en Compras. Las facturas de prueba (homologación) no entran.
                </p>
                <p>El ZIP trae:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    <code className="text-xs">{FILE_NAMES.ventasCbte}</code> y{" "}
                    <code className="text-xs">{FILE_NAMES.ventasAlicuotas}</code>: tus ventas.
                  </li>
                  <li>
                    <code className="text-xs">{FILE_NAMES.comprasCbte}</code> y{" "}
                    <code className="text-xs">{FILE_NAMES.comprasAlicuotas}</code>: tus compras.
                  </li>
                  <li>
                    <code className="text-xs">{FILE_NAMES.leeme}</code>: el resumen y estos pasos.
                  </li>
                </ul>
              </div>
            </SettingsCard>

            <SettingsCard title="Cómo importarlo en el Portal IVA" padded>
              <ol className="space-y-2.5 text-sm">
                {PORTAL_IVA_STEPS.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                      {i + 1}
                    </span>
                    <span className="pt-0.5 text-muted-foreground">{s}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-4 text-xs text-muted-foreground">
                ¿Te falta cargar alguna compra? Hacelo en{" "}
                <Link href="/compras/facturas" className="font-medium text-foreground underline underline-offset-2">
                  Compras &gt; Facturas y pagos
                </Link>{" "}
                y generá el archivo de nuevo.
              </p>
            </SettingsCard>
          </>
        )}
      </div>
      <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="facturacion_afip" featureLabel="Libro IVA Digital" />
    </PageContainer>
  );
}

function Side({ title, count, rows }: { title: string; count: number; rows: Array<[string, string]> }) {
  return (
    <SettingsCard title={`${title} · ${count} ${count === 1 ? "comprobante" : "comprobantes"}`} padded>
      <dl className="space-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </SettingsCard>
  );
}

function IssueList({ title, items, tone }: { title: string; items: LibroIssue[]; tone: "danger" | "warning" }) {
  return (
    <SettingsCard title={title} padded>
      <ul className="space-y-2.5 text-sm">
        {items.map((i, k) => (
          <li key={`${i.code}-${k}`} className="flex gap-2.5">
            {tone === "danger" ? (
              <XCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            ) : (
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            )}
            <span>{i.message}</span>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
