"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChartColumn,
  ChartColumnStacked,
  ChartLine,
  Check,
  Download,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { type SegmentedOption } from "@/components/ui/Segmented";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { GatedButton } from "@/components/saas/GatedAction";
import { ReportSection } from "@/components/reports/ReportSection";
import { multiSeriesOption } from "@/components/charts/builders";
import { formatChartValue } from "@/components/charts/chartTheme";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import {
  COMPARE_METRICS,
  bestWorst,
  compareSheets,
  dailySeries,
  deltaVsAverage,
  formatPct,
  methodMatrix,
  methodsUnion,
  metricAverage,
  shareOfTotal,
  storeLabel,
  type CompareMetric,
  type CompareStore,
} from "@/lib/reports/branchCompare";
import { fillDays } from "@/modules/reports/derive";
import { isPlanOrAccessError, useBranchCompare } from "@/modules/reports/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { useFeature } from "@/modules/saas/gating";

// =============================================================================
// Reportes · Comparar sucursales (F17 · H97 · ADR-057). Lado a lado: KPIs con
// la mejor y la peor marcadas, ventas, ticket promedio, medios de pago,
// evolución diaria y margen por sucursal, y XLSX con una hoja por sucursal más
// el consolidado. Gateado por multi_sucursal (también en el servidor).
// =============================================================================

type MethodsChart = "pct" | "amount";
type TrendChart = "line" | "bar";

const METHOD_CHARTS: SegmentedOption<MethodsChart>[] = [
  {
    value: "pct",
    label: "% por sucursal",
    icon: <ChartColumnStacked size={14} strokeWidth={1.75} />,
  },
  {
    value: "amount",
    label: "Montos",
    icon: <ChartColumn size={14} strokeWidth={1.75} />,
  },
];
const TREND_CHARTS: SegmentedOption<TrendChart>[] = [
  {
    value: "line",
    label: "Líneas",
    icon: <ChartLine size={14} strokeWidth={1.75} />,
  },
  {
    value: "bar",
    label: "Barras",
    icon: <ChartColumn size={14} strokeWidth={1.75} />,
  },
];

function fmtMetric(m: CompareMetric, v: number | null): string {
  if (v == null) return "s/d";
  if (m.format === "percent") return formatPct(v);
  if (m.format === "currency") return formatChartValue(v, "currency");
  return v.toLocaleString("es-AR", { maximumFractionDigits: 1 });
}

export function BranchCompare({
  fromISO,
  toISO,
  rangeFrom,
  rangeTo,
  periodLabel,
}: {
  fromISO: string;
  toISO: string;
  rangeFrom: Date;
  rangeTo: Date;
  periodLabel: string;
}) {
  const branch = useBranchContext();
  const allowed = branch.allowed;
  const hasFeature = useFeature("multi_sucursal");
  const locked = hasFeature === false;
  const [upgrade, setUpgrade] = useState(false);

  // Selección (por defecto todas las permitidas). Se guarda por dispositivo.
  const [picked, setPicked] = useState<string[] | null>(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("rep-compare-stores");
      if (raw) setPicked(JSON.parse(raw) as string[]);
    } catch {
      /* sin storage */
    }
  }, []);
  const allowedIds = useMemo(() => allowed.map((b) => b.id), [allowed]);
  const selected = useMemo(() => {
    const valid = (picked ?? []).filter((id) => allowedIds.includes(id));
    return valid.length >= 2 ? valid : allowedIds;
  }, [picked, allowedIds]);
  function toggleStore(id: string) {
    const cur = new Set(selected);
    if (cur.has(id)) {
      if (cur.size <= 2) return; // comparar es de 2 en adelante
      cur.delete(id);
    } else cur.add(id);
    const next = allowedIds.filter((x) => cur.has(x));
    setPicked(next);
    try {
      window.localStorage.setItem("rep-compare-stores", JSON.stringify(next));
    } catch {
      /* sin storage */
    }
  }

  const query = useBranchCompare(
    fromISO,
    toISO,
    selected,
    !locked && branch.ready && selected.length >= 2,
  );
  const report = query.data;
  const serverLocked = query.error
    ? /feature_not_in_plan/i.test(String((query.error as Error).message))
    : false;
  const stores = useMemo(() => report?.stores ?? [], [report]);

  const days = useMemo(
    () => fillDays(rangeFrom, rangeTo, []),
    [rangeFrom, rangeTo],
  );
  const share = useMemo(() => shareOfTotal(stores), [stores]);
  const methods = useMemo(() => methodsUnion(stores), [stores]);
  const names = stores.map(storeLabel);

  async function exportCompare() {
    if (!report) return;
    const sheets = compareSheets(report, {
      periodLabel,
      methodLabel: (m) => METHOD_LABELS[m] ?? m,
    });
    await exportXlsx(
      `comparativo-sucursales-${fromISO.slice(0, 10)}_${toISO.slice(0, 10)}`,
      sheets,
    );
  }

  if (locked || serverLocked) {
    return (
      <>
        <Callout
          icon={Lock}
          title="Comparar sucursales es parte de Multi-sucursal"
          actions={
            <Button size="sm" onClick={() => setUpgrade(true)}>
              Ver planes
            </Button>
          }
        >
          Con Multi-sucursal ves tus locales lado a lado: ventas, ticket
          promedio, medios de pago, margen, devoluciones y diferencias de caja,
          y bajás un Excel con una hoja por sucursal.
        </Callout>
        <UpgradeModal
          open={upgrade}
          onOpenChange={setUpgrade}
          featureKey="multi_sucursal"
          featureLabel="Comparar sucursales"
        />
      </>
    );
  }

  return (
    <div className="space-y-4">
      {/* Selector de sucursales */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Sucursales</span>
        {allowed.map((b) => {
          const on = selected.includes(b.id);
          return (
            <button
              key={b.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggleStore(b.id)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
                on
                  ? "border-border bg-muted font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {on ? <Check size={12} aria-hidden /> : <BranchDot branch={b} />}
              {b.short_name?.trim() || b.name}
            </button>
          );
        })}
        <span className="flex-1" />
        <GatedButton
          feature="export_xlsx"
          featureLabel="Exportar a Excel"
          variant="secondary"
          size="sm"
          onClick={exportCompare}
          disabled={!report}
        >
          <Download size={14} /> XLSX por sucursal
        </GatedButton>
      </div>

      {query.isLoading && <SpinnerBlock />}
      {query.error && !serverLocked && (
        <Callout tone="danger" title="No se pudo armar el comparativo">
          {isPlanOrAccessError(query.error)
            ? "No tenés acceso a alguna de las sucursales elegidas."
            : "Probá de nuevo en un rato."}
        </Callout>
      )}

      {report && (
        <>
          {/* Tarjetas por sucursal (mobile: apiladas) */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stores.map((s) => (
              <div
                key={s.store_id}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-center gap-2">
                  <BranchDot branch={s} />
                  <p className="min-w-0 flex-1 truncate font-semibold">
                    {s.name}
                  </p>
                  {s.archived && (
                    <span className="text-[11px] text-muted-foreground">
                      archivada
                    </span>
                  )}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatPct(share[s.store_id] ?? 0)}
                  </span>
                </div>
                <p className="price-hl mt-2 font-price text-2xl font-bold tabular-nums">
                  {formatCurrency(s.total)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {s.count.toLocaleString("es-AR")} tickets · promedio{" "}
                  {formatCurrency(s.avg_ticket)}
                </p>
                <div className="mt-3 h-1.5 w-full bg-muted">
                  <div
                    className="h-full bg-foreground/60"
                    style={{
                      width: `${Math.min(100, share[s.store_id] ?? 0)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Tabla lado a lado */}
          <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
            <header className="px-4 pb-2 pt-4">
              <h2 className="font-display text-[15px] font-bold leading-6">
                Indicadores lado a lado
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                En negrita, la mejor sucursal de cada fila; el porcentaje
                compara contra el promedio de las sucursales elegidas.
              </p>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-y border-border text-left text-xs text-muted-foreground">
                    <th className="sticky left-0 bg-card px-4 py-2 font-medium">
                      Indicador
                    </th>
                    {stores.map((s) => (
                      <th
                        key={s.store_id}
                        className="px-3 py-2 text-right font-medium"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <BranchDot branch={s} />
                          {storeLabel(s)}
                        </span>
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_METRICS.map((m) => {
                    const avg = metricAverage(stores, m);
                    const bw = bestWorst(stores, m);
                    const totalVal = totalFor(m, report.totals, stores);
                    return (
                      <tr
                        key={m.key}
                        className="border-b border-border last:border-0"
                      >
                        <th
                          scope="row"
                          className="sticky left-0 bg-card px-4 py-2 text-left font-normal text-muted-foreground"
                        >
                          {m.label}
                        </th>
                        {stores.map((s) => {
                          const v = m.value(s);
                          const d =
                            stores.length > 2 ? deltaVsAverage(v, avg) : null;
                          const note = m.note?.(s);
                          const isBest = bw?.best === s.store_id;
                          const isWorst = bw?.worst === s.store_id;
                          return (
                            <td
                              key={s.store_id}
                              className="px-3 py-2 text-right align-top"
                            >
                              <span
                                className={cn(
                                  "tabular-nums",
                                  isBest && "font-bold text-foreground",
                                  isWorst && "text-muted-foreground",
                                )}
                                title={
                                  isBest
                                    ? "Mejor"
                                    : isWorst
                                      ? "Más baja"
                                      : undefined
                                }
                              >
                                {fmtMetric(m, v)}
                              </span>
                              {d != null && Math.abs(d) >= 0.5 && (
                                <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
                                  {d > 0 ? "+" : ""}
                                  {d.toLocaleString("es-AR", {
                                    maximumFractionDigits: 0,
                                  })}{" "}
                                  %
                                </span>
                              )}
                              {note && (
                                <span className="block text-[11px] text-muted-foreground">
                                  {note}
                                </span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {fmtMetric(m, totalVal)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
              Margen estimado con el costo actual de cada producto (los
              productos sin costo cargado no suman al margen). Devoluciones por
              la sucursal de la venta original. Diferencias de caja de los
              cierres Z del período.
            </p>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <ReportSection
              id="cmp-sales"
              title="Ventas y ticket promedio"
              subtitle="Total vendido de cada sucursal en el período"
              chart={() => ({
                option: multiSeriesOption({
                  categories: names,
                  series: [
                    { name: "Ventas", values: stores.map((s) => s.total) },
                  ],
                  itemColors: stores.map((s) => s.color),
                  format: "currency",
                  kind: "bar",
                }),
                ariaLabel: "Ventas por sucursal",
                empty: stores.every((s) => s.total === 0),
                summary: {
                  columns: ["Sucursal", "Ventas", "Ticket promedio"],
                  rows: stores.map((s) => [
                    storeLabel(s),
                    s.total,
                    s.avg_ticket,
                  ]),
                },
              })}
              table={
                <SimpleTable
                  head={["Sucursal", "Ventas", "Tickets", "Ticket prom."]}
                  rows={stores.map((s) => [
                    storeLabel(s),
                    formatCurrency(s.total),
                    s.count.toLocaleString("es-AR"),
                    formatCurrency(s.avg_ticket),
                  ])}
                />
              }
            />
            <ReportSection
              id="cmp-ticket"
              title="Ticket promedio"
              subtitle="Cuánto deja cada venta en cada sucursal"
              chart={() => ({
                option: multiSeriesOption({
                  categories: names,
                  series: [
                    {
                      name: "Ticket promedio",
                      values: stores.map((s) => s.avg_ticket),
                    },
                  ],
                  itemColors: stores.map((s) => s.color),
                  format: "currency",
                  kind: "bar",
                }),
                ariaLabel: "Ticket promedio por sucursal",
                empty: stores.every((s) => s.avg_ticket === 0),
              })}
              table={
                <SimpleTable
                  head={["Sucursal", "Ticket prom.", "Unidades"]}
                  rows={stores.map((s) => [
                    storeLabel(s),
                    formatCurrency(s.avg_ticket),
                    s.items_qty.toLocaleString("es-AR"),
                  ])}
                />
              }
            />
            <ReportSection<MethodsChart>
              id="cmp-methods"
              title="Medios de pago por sucursal"
              subtitle="Mezcla de cobro de cada local"
              chartTypes={METHOD_CHARTS}
              chart={(type) => {
                const matrix = methodMatrix(stores, methods, type === "pct");
                return {
                  option: multiSeriesOption({
                    categories: names,
                    series: matrix.map((m) => ({
                      name: METHOD_LABELS[m.method] ?? m.method,
                      values: m.values,
                    })),
                    format: "currency",
                    kind: "bar",
                    stacked: true,
                    percent: type === "pct",
                  }),
                  ariaLabel: "Medios de pago por sucursal",
                  empty: methods.length === 0,
                };
              }}
              table={
                <SimpleTable
                  head={["Medio", ...names]}
                  rows={methodMatrix(stores, methods).map((m) => [
                    METHOD_LABELS[m.method] ?? m.method,
                    ...m.values.map((v) => formatCurrency(v)),
                  ])}
                />
              }
            />
            <ReportSection
              id="cmp-margin"
              title="Margen bruto estimado"
              subtitle="Importe vendido menos costo actual de los productos con costo"
              chart={() => ({
                option: multiSeriesOption({
                  categories: names,
                  series: [
                    { name: "Margen", values: stores.map((s) => s.margin) },
                  ],
                  itemColors: stores.map((s) => s.color),
                  format: "currency",
                  kind: "bar",
                }),
                ariaLabel: "Margen por sucursal",
                empty: stores.every((s) => s.margin === 0),
              })}
              table={
                <SimpleTable
                  head={[
                    "Sucursal",
                    "Margen",
                    "Margen %",
                    "Cobertura de costo",
                  ]}
                  rows={stores.map((s) => [
                    storeLabel(s),
                    formatCurrency(s.margin),
                    formatPct(s.margin_pct),
                    formatPct(s.cost_coverage_pct),
                  ])}
                />
              }
            />
          </div>

          <ReportSection<TrendChart>
            id="cmp-trend"
            title="Evolución diaria por sucursal"
            subtitle={periodLabel}
            chartTypes={TREND_CHARTS}
            chart={(type) => {
              const series = dailySeries(
                stores,
                days.map((d) => d.key),
              );
              return {
                option: multiSeriesOption({
                  categories: days.map((d) => d.label),
                  tooltipCategories: days.map((d) => d.long),
                  series: series.map((x, i) => ({
                    name: names[i] ?? "",
                    values: x.values,
                    color: stores[i]?.color,
                  })),
                  format: "currency",
                  kind: type,
                  stacked: type === "bar",
                }),
                ariaLabel: "Ventas diarias por sucursal",
                empty: stores.every((s) => s.by_day.length === 0),
                height: 300,
              };
            }}
            table={
              <SimpleTable
                head={["Día", ...names]}
                rows={days.map((d, i) => [
                  d.label,
                  ...dailySeries(
                    stores,
                    days.map((x) => x.key),
                  ).map((x) => formatCurrency(x.values[i] ?? 0)),
                ])}
              />
            }
          />
        </>
      )}
    </div>
  );
}

function totalFor(
  m: CompareMetric,
  totals: {
    total: number;
    count: number;
    avg_ticket: number;
    items_qty: number;
    margin: number;
    margin_pct: number | null;
  },
  stores: CompareStore[],
): number | null {
  switch (m.key) {
    case "total":
    case "count":
    case "avg_ticket":
    case "items_qty":
    case "margin":
      return totals[m.key];
    case "margin_pct":
      return totals.margin_pct;
    default: {
      // El resto se suma entre las sucursales elegidas.
      const vals = stores.map(m.value).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
    }
  }
}

function SimpleTable({
  head,
  rows,
}: {
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {head.map((h, i) => (
              <th
                key={i}
                className={cn("px-4 py-2 font-medium", i > 0 && "text-right")}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {r.map((c, j) => (
                <td
                  key={j}
                  className={cn(
                    "px-4 py-2",
                    j > 0 && "text-right tabular-nums",
                  )}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
