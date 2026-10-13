"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, Wand2, X } from "lucide-react";
import { PageContainer } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { incomeStatement } from "@/lib/accounting/journal";
import { accErrorMessage, sourceHref, sourceLabel } from "@/lib/accounting/sources";
import { AccountingFrame, RangeFields, currentMonthRange, fmtDate, monthName } from "@/components/accounting/shared";
import { Kpi } from "@/components/purchases/shared";
import {
  useAccIssues,
  useAccPeriods,
  useAccSettings,
  useAccountingMutations,
  useTrialBalance,
} from "@/modules/accounting/hooks";

// Contabilidad (F18 · H109, ADR-066): resumen del mes, generación de asientos
// y eventos que no se pudieron contabilizar.
export default function ContabilidadPage() {
  return (
    <PageContainer>
      <AccountingFrame
        title="Contabilidad"
        description="Asientos automáticos de todo lo que pasa en el negocio, listos para el estudio contable."
      >
        <Overview />
      </AccountingFrame>
    </PageContainer>
  );
}

function Overview() {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const month = currentMonthRange();
  const { data: settings } = useAccSettings();
  const { data: periods = [] } = useAccPeriods();
  const { data: issues = [], isLoading: issuesLoading } = useAccIssues();
  const { data: trial = [] } = useTrialBalance(month);
  const [range, setRange] = useState(month);
  const [regen, setRegen] = useState(false);

  const cur = periods.find((p) => p.period === month.from);
  const lastClosed = periods.find((p) => p.status === "closed");
  const result = incomeStatement(trial);

  async function generate() {
    try {
      const r = await m.generate.mutateAsync({ from: range.from, to: range.to, regenerate: regen });
      toast({
        title: r.failed ? "Asientos generados con avisos" : "Asientos al día",
        description: `${r.created} nuevos${regen ? `, ${r.deleted} rehechos` : ""}${r.failed ? `, ${r.failed} con problemas (abajo)` : ""}.`,
        variant: r.failed ? "info" : "success",
      });
      setRegen(false);
    } catch (e) {
      toast({ title: "No se pudo generar", description: accErrorMessage(e), variant: "error" });
    }
  }

  async function retry(id: string) {
    try {
      const ok = await m.retryIssue.mutateAsync(id);
      toast({ title: ok ? "Contabilizado" : "Sigue sin poder contabilizarse", variant: ok ? "success" : "info" });
    } catch (e) {
      toast({ title: "No se pudo reintentar", description: accErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="mt-5 space-y-6">
      {settings && !settings.enabled && (
        <Callout tone="warning" icon={AlertTriangle} title="La generación automática está pausada">
          Activala en Cierres, configuración, para que las ventas, cobros y compras nuevas se contabilicen solas.
        </Callout>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={`Asientos de ${monthName(month.from).toLowerCase()}`} value={cur?.entries ?? 0} />
        <Kpi label="Ventas netas del mes" value={formatCurrency(result.totalIngresos)} />
        <Kpi
          label="Resultado del mes"
          value={formatCurrency(result.resultado)}
          tone={result.resultado < 0 ? "danger" : result.resultado > 0 ? "success" : undefined}
        />
        <Kpi
          label="Para revisar"
          value={issues.length}
          tone={issues.length ? "warning" : undefined}
        />
      </div>

      <section className="rounded-xl bg-card p-5 ring-1 ring-border">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Generar asientos</h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              Lo nuevo se contabiliza solo al guardarse. Usá esto para traer lo que haya quedado afuera (por ejemplo,
              antes de activar la contabilidad) o para rehacer un período abierto después de cambiar los mapeos.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            Desde {settings ? fmtDate(settings.start_date) : ""}
            {lastClosed ? ` · último cierre: ${monthName(lastClosed.period)}` : ""}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <RangeFields from={range.from} to={range.to} onChange={setRange} />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={regen} onCheckedChange={(v) => setRegen(Boolean(v))} aria-label="Rehacer" />
            Rehacer los automáticos del rango
          </label>
          <Button onClick={() => void generate()} loading={m.generate.isPending}>
            <Wand2 size={16} /> {regen ? "Rehacer" : "Generar"}
          </Button>
        </div>
        {regen && (
          <p className="mt-2 text-xs text-warning">
            Los asientos automáticos del rango en meses abiertos se dan de baja y se vuelven a armar con los mapeos de hoy.
            Los manuales y los meses cerrados no se tocan.
          </p>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Pendientes de contabilizar</h2>
          {issues.length === 0 && !issuesLoading && (
            <span className="flex items-center gap-1.5 text-sm text-success">
              <CheckCircle2 size={15} /> Todo contabilizado
            </span>
          )}
        </div>
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Origen</th>
                <th className="px-4 py-3">Motivo</th>
                <th className="hidden px-4 py-3 md:table-cell">Último intento</th>
                <th className="px-2 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {issuesLoading && <TableStateRow colSpan={4} loading />}
              {!issuesLoading && issues.length === 0 && (
                <TableStateRow colSpan={4}>
                  <EmptyState
                    compact
                    icon={CheckCircle2}
                    title="Sin pendientes"
                    description="Si a un evento le falta una regla de mapeo o cae en un mes cerrado, aparece acá para reintentarlo."
                  />
                </TableStateRow>
              )}
              {issues.map((i) => {
                const href = sourceHref(i.source_type, i.source_id);
                return (
                  <tr key={i.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{sourceLabel(i.source_type)}</div>
                      {href && (
                        <Link href={href as never} className="inline-flex items-center gap-1 text-xs text-ninja-flameSoft hover:underline">
                          Ver documento <ExternalLink size={11} />
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{accErrorMessage(i.message)}</td>
                    <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                      {fmtDate(i.updated_at)} · {i.attempts} {i.attempts === 1 ? "intento" : "intentos"}
                    </td>
                    <td className="px-2 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="secondary" onClick={() => void retry(i.id)} loading={m.retryIssue.isPending && m.retryIssue.variables === i.id}>
                          <RefreshCw size={14} /> Reintentar
                        </Button>
                        <Button size="sm" variant="ghost" aria-label="Descartar" onClick={() => m.dismissIssue.mutate(i.id)}>
                          <X size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        <p className="mt-2 text-xs text-muted-foreground">
          Los pendientes por mapeo faltante se resuelven en Mapeos y después con Reintentar. Nada de esto frena una venta
          ni un cobro: la operación se guarda siempre.
        </p>
      </section>
    </div>
  );
}
