"use client";

import { useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { History } from "lucide-react";
import { EChart, type ChartContext } from "@/components/charts/EChart";
import { formatAxisValue, formatChartValue } from "@/components/charts/chartTheme";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { formatCurrency } from "@/lib/utils/format";
import {
  basePriceSeries,
  PRICE_SOURCE_LABEL,
  usePriceHistory,
  type PriceHistoryRow,
} from "@/modules/products/priceHistory";

// Pestaña "Historial de precios" de la ficha del producto (F18 · H100, ADR-056):
// gráfico escalonado del precio base y la lista de cambios (producto, variantes
// y listas) con quién, cuándo y de dónde vino.

const dateFmt = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function chartOption(rows: PriceHistoryRow[]) {
  const series = basePriceSeries(rows);
  // Escalón hasta hoy: el último precio sigue vigente.
  const data = series.map((p) => [p.at, p.price]);
  if (series.length > 0) data.push([new Date().toISOString(), series[series.length - 1]!.price]);
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => ({
    grid: { left: 4, right: 12, top: 12, bottom: compact ? 24 : 4, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: t.tooltipBg,
      borderWidth: 0,
      textStyle: { color: t.tooltipFg, fontSize: 12 },
      valueFormatter: (v: unknown) => formatChartValue(Number(v) || 0, "currency"),
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      scale: true,
      splitLine: { lineStyle: { color: t.border } },
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => formatAxisValue(v, "currency") },
    },
    series: [
      {
        name: "Precio",
        type: "line",
        step: "end",
        showSymbol: data.length <= 40,
        symbolSize: 6,
        data,
        lineStyle: { width: 2, color: t.palette[0] },
        itemStyle: { color: t.palette[0] },
      },
    ],
  });
}

function scopeLabel(r: PriceHistoryRow, lists: Map<string, string>, variants: Map<string, string>): string {
  if (r.list_id) return `Lista ${lists.get(r.list_id) ?? ""}`.trim();
  if (r.variant_id) return `Variante ${variants.get(r.variant_id) ?? ""}`.trim();
  return "Precio base";
}

export function PriceHistoryPanel({
  productId,
  active,
  lists,
  variants,
}: {
  productId: string;
  /** Sólo consulta cuando la pestaña está visible. */
  active: boolean;
  lists: Map<string, string>;
  variants: Map<string, string>;
}) {
  const { data: rows, isLoading, error } = usePriceHistory(productId, active);
  const option = useMemo(() => chartOption(rows ?? []), [rows]);
  const points = useMemo(() => basePriceSeries(rows ?? []), [rows]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return <p className="py-6 text-center text-sm text-danger">No se pudo cargar el historial de precios.</p>;
  }
  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        compact
        icon={History}
        title="Sin cambios de precio todavía"
        description="Cada cambio de precio del producto, sus variantes y las listas queda acá con quién y cuándo."
      />
    );
  }

  return (
    <div className="space-y-4">
      <EChart
        option={option}
        height={220}
        ariaLabel="Evolución del precio base del producto"
        empty={points.length === 0}
        emptyTitle="Sin cambios del precio base"
        emptyHint="Los cambios de variantes y listas están en la lista de abajo."
        summary={{
          columns: ["Fecha", "Precio"],
          rows: points.map((p) => [dateFmt.format(new Date(p.at)), formatCurrency(p.price)]),
        }}
      />
      <ul className="divide-y divide-border rounded-lg bg-muted">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="block font-medium text-foreground">{scopeLabel(r, lists, variants)}</span>
              <span className="block text-xs text-muted-foreground">
                {dateFmt.format(new Date(r.at))} · {PRICE_SOURCE_LABEL[r.source] ?? r.source}
                {r.changed_by_name ? ` · ${r.changed_by_name}` : ""}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">
              {r.old_price == null ? (
                <span className="text-muted-foreground">Alta</span>
              ) : (
                <span className="text-muted-foreground line-through">{formatCurrency(r.old_price)}</span>
              )}{" "}
              <span className="font-semibold text-foreground">
                {r.new_price == null ? "Quitado" : formatCurrency(r.new_price)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
