// Opción ECharts del movimiento de MRR por mes (F20-2 · ADR-127, spec §15.4):
// barras apiladas (nuevo, expansión y reactivación hacia arriba; contracción
// y churn hacia abajo) y la línea del MRR al cierre en su propio eje. Pura:
// recibe los meses ya calculados (lib/billing/kpis.ts) y el tema.
// Sin degradados ni sombras: barras planas, tooltip con borde fino.
import type { EChartsCoreOption } from "echarts/core";
import type { ChartContext } from "@/components/charts/EChart";
import { esc } from "@/components/charts/builders";
import { formatAxisValue, formatChartValue } from "@/components/charts/chartTheme";
import { monthLabel, type MonthMovement } from "@/lib/billing/kpis";

export const MOVEMENT_SERIES = [
  { key: "new_cents", label: "Nuevo", sign: 1, color: (p: string[]) => p[2] },
  { key: "expansion_cents", label: "Expansión", sign: 1, color: (p: string[]) => p[5] },
  { key: "reactivation_cents", label: "Reactivación", sign: 1, color: (p: string[]) => p[1] },
  { key: "contraction_cents", label: "Contracción", sign: -1, color: (p: string[]) => p[3] },
  { key: "churn_cents", label: "Churn", sign: -1, color: (p: string[]) => p[4] },
] as const;

const pesos = (cents: number) => cents / 100;

export function mrrMovementOption(months: MonthMovement[]) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const labels = months.map((m) => monthLabel(m.month) + (m.live ? "*" : ""));
    const series: Record<string, unknown>[] = MOVEMENT_SERIES.map((s) => ({
      name: s.label,
      type: "bar",
      stack: "mov",
      barMaxWidth: 26,
      itemStyle: { color: s.color(t.palette) ?? t.primary },
      emphasis: { focus: "series" },
      data: months.map((m) => (m.movement ? (s.sign * pesos(m.movement[s.key])) || 0 : null)),
    }));
    series.push({
      name: "MRR al cierre",
      type: "line",
      yAxisIndex: 1,
      symbol: "circle",
      symbolSize: 6,
      showSymbol: months.length <= 14,
      connectNulls: false,
      lineStyle: { width: 2, color: t.foreground },
      itemStyle: { color: t.foreground, borderColor: t.surface, borderWidth: 2 },
      data: months.map((m) => (m.end_mrr_cents === null ? null : pesos(m.end_mrr_cents))),
      z: 4,
    });

    const axisLabel = { color: t.muted, fontSize: 11, hideOverlap: true };
    return {
      grid: { left: 8, right: 8, top: compact ? 16 : 40, bottom: compact ? 64 : 8, containLabel: true },
      legend: {
        show: true,
        icon: "roundRect",
        itemWidth: 12,
        itemHeight: 8,
        itemGap: 12,
        textStyle: { color: t.muted, fontSize: 12 },
        ...(compact ? { bottom: 0, left: "center" } : { top: 0, right: 0 }),
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: t.isDark ? "rgba(255,255,255,0.04)" : "rgba(30,22,60,0.05)" } },
        backgroundColor: t.tooltipBg,
        borderColor: t.border,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: t.tooltipFg, fontSize: 12, fontFamily: t.fontFamily },
        extraCssText: "border-radius:8px;box-shadow:none;",
        confine: true,
        formatter: (raw: unknown) => {
          const items = (Array.isArray(raw) ? raw : [raw]) as { dataIndex: number }[];
          const m = months[items[0]?.dataIndex ?? 0];
          if (!m) return "";
          const head = `<div style="font-weight:600;margin-bottom:4px">${esc(monthLabel(m.month))}${m.live ? " (en curso)" : ""}</div>`;
          if (!m.movement) return `${head}<div style="color:${t.muted}">Sin foto de MRR para este mes</div>`;
          const mv = m.movement;
          const line = (name: string, cents: number, color?: string) =>
            `<div style="display:flex;justify-content:space-between;gap:16px;line-height:20px"><span style="color:${t.muted}">${
              color ? `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></span>` : ""
            }${esc(name)}</span><span style="font-variant-numeric:tabular-nums;font-weight:600">${formatChartValue(pesos(cents), "currency")}</span></div>`;
          return (
            head +
            line("MRR al inicio", mv.start_cents) +
            MOVEMENT_SERIES.map((s) => line(s.label, s.sign * mv[s.key], s.color(t.palette))).join("") +
            line("Neto", mv.net_cents) +
            line("MRR al cierre", mv.end_cents)
          );
        },
      },
      xAxis: {
        type: "category",
        data: labels,
        axisLine: { lineStyle: { color: t.border } },
        axisTick: { show: false },
        axisLabel,
      },
      yAxis: [
        {
          type: "value",
          name: compact ? undefined : "Movimiento",
          nameTextStyle: { color: t.muted, fontSize: 11 },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { ...axisLabel, formatter: (v: number) => formatAxisValue(v, "currency") },
          splitNumber: compact ? 3 : 4,
          splitLine: { lineStyle: { color: t.border, type: "dashed" } },
        },
        {
          type: "value",
          name: compact ? undefined : "MRR",
          nameTextStyle: { color: t.muted, fontSize: 11 },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { ...axisLabel, formatter: (v: number) => formatAxisValue(v, "currency") },
          splitLine: { show: false },
        },
      ],
      series,
    };
  };
}
