"use client";

// =============================================================================
// Métricas de cobranza (F20-2 · H128 · ADR-126, spec docs/40 §15): MRR desde
// las fotos diarias (platform_mrr_snapshots), movimiento de MRR por mes, NRR y
// GRR, cobrado bruto y neto, deuda vencida con aging, DSO y efectividad.
// Los datos salen de internal_billing_kpis (Cobranzas, admin o super_admin) y
// el cálculo de lib/billing/kpis.ts.
// =============================================================================

import { useMemo, useState } from "react";
import {
  Activity,
  Banknote,
  CalendarClock,
  ChartColumnStacked,
  CircleAlert,
  Gauge,
  Repeat,
  ShieldAlert,
  Target,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { AgingBar } from "@/components/billing/StatementParts";
import { KpiTile } from "@/components/internal/dashboard/KpiTile";
import { Callout } from "@/components/ui/Callout";
import { NoData } from "@/components/ui/NoData";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { TableWrap } from "@/components/ui/Table";
import {
  BILLING_KPI_DEFINITIONS as DEF,
  agingBuckets,
  collected,
  collectionEffectiveness,
  dso,
  monthLabel,
  monthlyMovements,
  mrrStock,
  retention,
  windowMovement,
  type BillingKpisData,
} from "@/lib/billing/kpis";
import { billingErrorMessage, formatCents, formatDay } from "@/lib/billing/ledger";
import { formatCompactArs, formatPct, trend } from "@/lib/internal/saasKpis";
import { useBillingKpis } from "@/modules/billing/ledger";
import { MOVEMENT_SERIES, mrrMovementOption } from "./mrrMovementChart";

type Months = "6" | "12" | "24";

const compact = (cents: number) => formatCompactArs(cents / 100);

function Money({ cents, signed = false }: { cents: number | null | undefined; signed?: boolean }) {
  if (cents === null || cents === undefined) return <NoData />;
  return <span title={formatCents(cents)}>{cents === 0 ? "$ 0" : signed ? formatCents(cents, { signed: true }) : formatCents(cents)}</span>;
}

/** canView undefined = todavía se está leyendo el acceso. */
export function BillingKpisView({ canView }: { canView: boolean | undefined }) {
  const [months, setMonths] = useState<Months>("12");
  const { data, isLoading, error } = useBillingKpis(Number(months), canView === true);

  if (canView === undefined) {
    return <Skeleton className="mt-6 h-40 rounded-xl" />;
  }
  if (!canView) {
    return (
      <Callout tone="neutral" icon={ShieldAlert} title="Sin acceso a las métricas" className="mt-6">
        Las métricas de MRR y cobranza las ven las personas con el permiso Cobranzas, admin o super admin.
      </Callout>
    );
  }

  return (
    <>
      <div className="slim-scrollbar -mx-4 mt-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Segmented<Months>
          size="sm"
          aria-label="Meses del gráfico"
          value={months}
          onChange={setMonths}
          className="flex-nowrap"
          options={[
            { value: "6", label: "6 meses" },
            { value: "12", label: "12 meses" },
            { value: "24", label: "24 meses" },
          ]}
        />
      </div>

      {error && (
        <Callout tone="warning" icon={CircleAlert} title="No se pudieron cargar las métricas" className="mt-6">
          {/internal_billing_kpis/.test(String((error as Error).message ?? "")) &&
          /does not exist|Could not find/i.test(String((error as Error).message ?? ""))
            ? "Falta aplicar la migración 20261122100000_cobranza_mrr_snapshots."
            : billingErrorMessage(error)}
        </Callout>
      )}

      {isLoading && (
        <div className="mt-6 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3" aria-busy>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-[120px] rounded-lg" />
          ))}
        </div>
      )}

      {data && <KpisBody data={data} />}
    </>
  );
}
BillingKpisView.displayName = "BillingKpisView";

function KpisBody({ data }: { data: BillingKpisData }) {
  const calc = useMemo(() => {
    const bounds = data.boundaries ?? [];
    const live = bounds.find((b) => b.live) ?? null;
    const prevClose = [...bounds].filter((b) => !b.live && b.available).sort((a, b) => b.day.localeCompare(a.day))[0] ?? null;
    const now = live ? mrrStock(live.rows) : null;
    const prev = prevClose ? mrrStock(prevClose.rows) : null;
    const series = monthlyMovements(bounds, data.first_paying_day ?? {});
    const win = windowMovement(bounds, data.first_paying_day ?? {});
    const ret = win ? retention(win) : null;
    const firstAvailable = bounds.filter((b) => b.available).sort((a, b) => a.day.localeCompare(b.day))[0] ?? null;
    const aging = agingBuckets(data.open_debits ?? [], data.as_of);
    const collections = data.collections ?? [];
    const effectiveness = data.effectiveness ?? [];
    const thisMonth = collected(collections[collections.length - 1]);
    const lastMonth = collections.length > 1 ? collected(collections[collections.length - 2]) : null;
    const effNow = collectionEffectiveness(effectiveness[effectiveness.length - 1]);
    const effPrev = effectiveness.length > 1 ? collectionEffectiveness(effectiveness[effectiveness.length - 2]) : null;
    return {
      now,
      prev,
      series,
      win,
      ret,
      firstAvailable,
      aging,
      collections,
      effectiveness,
      thisMonth,
      lastMonth,
      effNow,
      effPrev,
      dsoDays: dso(aging.total_cents, data.billed_90d_cents),
    };
  }, [data]);

  const hasSnapshots = Boolean(data.snapshots_since);
  const chartMonths = calc.series;
  const chartOption = useMemo(() => mrrMovementOption(chartMonths), [chartMonths]);
  const anyMovement = chartMonths.some((m) => m.movement);
  const mrr = calc.now?.mrr_cents ?? 0;
  const accounts = calc.now?.accounts ?? 0;
  const winLabel = calc.firstAvailable ? `desde el ${formatDay(calc.firstAvailable.day)}` : "en la ventana";

  return (
    <>
      <p className="mt-4 text-xs text-muted-foreground">
        Al {formatDay(data.as_of)}. Importes con IVA incluido.{" "}
        {data.excluded_count > 0
          ? `Excluye ${data.excluded_count} ${data.excluded_count === 1 ? "negocio que no se cobra" : "negocios que no se cobran"} (prueba, del staff, lifetime o exentos). `
          : ""}
        {hasSnapshots ? `Fotos diarias de MRR desde el ${formatDay(data.snapshots_since)}.` : ""}
      </p>

      {!hasSnapshots && (
        <Callout tone="info" icon={CalendarClock} title="Todavía no hay fotos diarias de MRR" className="mt-3">
          El MRR de hoy se calcula en vivo. El movimiento por mes aparece cuando el cron guarda la primera foto (todos los días a las 00:10).
        </Callout>
      )}

      {/* ── MRR ── */}
      <section className="mt-6" aria-labelledby="kpi-mrr">
        <SectionHeader title={<span id="kpi-mrr">Ingreso recurrente</span>} icon={Repeat} />
        <div className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label="MRR"
            icon={Repeat}
            value={compact(mrr)}
            exact={formatCents(mrr)}
            definition={DEF.mrr}
            sub={`${accounts} ${accounts === 1 ? "cuenta paga" : "cuentas pagas"}`}
            trendPct={calc.prev ? trend(mrr, calc.prev.mrr_cents) : null}
            trendLabel="vs. el cierre del mes anterior"
          />
          <KpiTile
            label="ARR (MRR × 12)"
            icon={Banknote}
            value={compact(mrr * 12)}
            exact={formatCents(mrr * 12)}
            definition={DEF.arr}
            sub="Run-rate anual"
          />
          <KpiTile
            label="ARPA"
            icon={Users}
            value={accounts > 0 ? compact(mrr / accounts) : null}
            noData={accounts === 0}
            exact={accounts > 0 ? formatCents(Math.round(mrr / accounts)) : undefined}
            definition={DEF.accounts}
            sub="Ingreso promedio por cuenta paga"
          />
          <KpiTile
            label="MRR en mora"
            icon={ShieldAlert}
            value={compact(calc.now?.past_due_cents ?? 0)}
            exact={formatCents(calc.now?.past_due_cents ?? 0)}
            definition={DEF.mrrAtRisk}
            sub={mrr > 0 ? `${formatPct(Math.round(((calc.now?.past_due_cents ?? 0) / mrr) * 1000) / 10)} del MRR` : "Sin MRR"}
            tone={(calc.now?.past_due_cents ?? 0) > 0 ? "warning" : "default"}
            goodWhen="down"
          />
          <KpiTile
            label="NRR"
            icon={TrendingUp}
            value={calc.ret?.nrr != null ? formatPct(calc.ret.nrr) : null}
            noData={calc.ret?.nrr == null}
            definition={DEF.nrr}
            sub={calc.ret?.nrr != null ? `Cohorte paga ${winLabel}` : "Hace falta MRR al inicio de la ventana"}
          />
          <KpiTile
            label="GRR"
            icon={Activity}
            value={calc.ret?.grr != null ? formatPct(calc.ret.grr) : null}
            noData={calc.ret?.grr == null}
            definition={`${DEF.grr} ${DEF.logoChurn}`}
            sub={
              calc.ret && calc.ret.base > 0
                ? `Churn de clientes: ${calc.ret.churned} de ${calc.ret.base}${calc.ret.logoChurn === null ? " (muestra chica)" : ` (${formatPct(calc.ret.logoChurn)})`}`
                : "Sin cuentas pagas al inicio"
            }
            tone={calc.ret?.grr != null && calc.ret.grr < 90 ? "warning" : "default"}
          />
        </div>
      </section>

      {/* ── Movimiento de MRR ── */}
      <section className="mt-8" aria-labelledby="kpi-mov">
        <SectionHeader
          title={<span id="kpi-mov">Movimiento de MRR por mes</span>}
          icon={ChartColumnStacked}
          description="Qué sumó y qué restó cada mes, y el MRR al cierre. El mes en curso va con asterisco y cierra con la foto de hoy."
        />
        <div className="mt-3 rounded-lg border border-border bg-card p-3 sm:p-4">
          <EChart
            option={chartOption}
            height={320}
            compactHeight={300}
            ariaLabel="Movimiento de MRR por mes: nuevo, expansión, reactivación, contracción y churn, con el MRR al cierre"
            empty={!anyMovement}
            emptyTitle="Sin movimiento de MRR para mostrar"
            emptyHint="Hacen falta al menos dos fotos de cierre de mes."
            summary={{
              columns: ["Mes", ...MOVEMENT_SERIES.map((s) => s.label), "MRR al cierre"],
              rows: chartMonths.map((m) => [
                monthLabel(m.month),
                ...MOVEMENT_SERIES.map((s) => (m.movement ? formatCents(s.sign * m.movement[s.key]) : "Sin datos")),
                m.end_mrr_cents === null ? "Sin datos" : formatCents(m.end_mrr_cents),
              ]),
            }}
          />
        </div>
        <TableWrap className="mt-3">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5">Mes</th>
                <th className="px-4 py-2.5 text-right">Inicio</th>
                {MOVEMENT_SERIES.map((s) => (
                  <th key={s.key} className="px-4 py-2.5 text-right">
                    {s.label}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-right">Cierre</th>
              </tr>
            </thead>
            <tbody>
              {[...chartMonths].reverse().map((m) => (
                <tr key={m.month} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium">
                    {monthLabel(m.month)}
                    {m.live ? <span className="ml-1 text-xs font-normal text-muted-foreground">(en curso)</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                    <Money cents={m.movement?.start_cents} />
                  </td>
                  {MOVEMENT_SERIES.map((s) => (
                    <td key={s.key} className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {m.movement ? <Money cents={s.sign * m.movement[s.key]} signed /> : <NoData />}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">
                    <Money cents={m.end_mrr_cents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      {/* ── Cobranza ── */}
      <section className="mt-8" aria-labelledby="kpi-cob">
        <SectionHeader title={<span id="kpi-cob">Cobranza</span>} icon={Wallet} />
        <div className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label="Cobrado este mes"
            icon={Wallet}
            value={compact(calc.thisMonth.collected_cents)}
            exact={formatCents(calc.thisMonth.collected_cents)}
            definition={DEF.collected}
            sub="Bruto, sin reintegros ni contracargos"
            trendPct={calc.lastMonth ? trend(calc.thisMonth.collected_cents, calc.lastMonth.collected_cents) : null}
            trendLabel="vs. el mes anterior completo"
          />
          <KpiTile
            label="Cobrado neto"
            icon={Banknote}
            value={compact(calc.thisMonth.net_cents)}
            exact={formatCents(calc.thisMonth.net_cents)}
            definition={DEF.collected}
            sub={`Comisiones ${formatCents(calc.thisMonth.fee_cents)} · reversas ${formatCents(calc.thisMonth.reversal_cents)}`}
          />
          <KpiTile
            label="Deuda vencida"
            icon={CircleAlert}
            value={compact(calc.aging.overdue_cents)}
            exact={formatCents(calc.aging.overdue_cents)}
            definition={DEF.overdue}
            sub={`${calc.aging.tenants_overdue} ${calc.aging.tenants_overdue === 1 ? "negocio" : "negocios"} · a vencer ${formatCents(calc.aging.not_due_cents)}`}
            tone={calc.aging.overdue_cents > 0 ? "danger" : "default"}
            goodWhen="down"
          />
          <KpiTile
            label="DSO"
            icon={Gauge}
            value={calc.dsoDays === null ? null : `${calc.dsoDays.toLocaleString("es-AR")} días`}
            noData={calc.dsoDays === null}
            definition={DEF.dso}
            sub={`Cargado en 90 días: ${formatCents(data.billed_90d_cents)}`}
          />
          <KpiTile
            label="Efectividad del mes"
            icon={Target}
            value={calc.effNow.pct === null ? null : formatPct(calc.effNow.pct)}
            noData={calc.effNow.pct === null}
            definition={DEF.effectiveness}
            sub={
              calc.effNow.base_cents > 0
                ? `${formatCents(calc.effNow.collected_cents)} de ${formatCents(calc.effNow.base_cents)}`
                : "No venció nada todavía este mes"
            }
            trendPct={calc.effNow.pct !== null && calc.effPrev?.pct != null ? trend(calc.effNow.pct, calc.effPrev.pct) : null}
            trendLabel="vs. el mes anterior"
          />
        </div>
        <AgingBar className="mt-3" aging={calc.aging} />

        <TableWrap className="mt-3">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5">Mes</th>
                <th className="px-4 py-2.5 text-right">Pagos</th>
                <th className="px-4 py-2.5 text-right">Bruto</th>
                <th className="px-4 py-2.5 text-right">Comisiones</th>
                <th className="px-4 py-2.5 text-right">Reversas</th>
                <th className="px-4 py-2.5 text-right">Neto</th>
                <th className="px-4 py-2.5 text-right">Efectividad</th>
              </tr>
            </thead>
            <tbody>
              {[...calc.collections].reverse().map((row) => {
                const c = collected(row);
                const e = collectionEffectiveness(calc.effectiveness.find((x) => x.month === row.month));
                return (
                  <tr key={row.month} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium">{monthLabel(row.month)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{row.payments > 0 ? row.payments : <NoData />}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                      {c.gross_cents > 0 ? <Money cents={c.gross_cents} /> : <NoData />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {c.fee_cents > 0 ? <Money cents={-c.fee_cents} /> : <NoData />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {c.reversal_cents > 0 ? <Money cents={-c.reversal_cents} /> : <NoData />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">
                      {c.gross_cents > 0 ? <Money cents={c.net_cents} /> : <NoData />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                      {e.pct === null ? <NoData /> : formatPct(e.pct)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </section>
    </>
  );
}
