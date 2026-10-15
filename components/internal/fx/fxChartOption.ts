// Opción ECharts de la evolución del dólar oficial (venta) (ADR-135). Línea
// plana sobre eje de tiempo: sin degradados, sin área ni sombras; colores del
// tema activo (ChartContext). Pura: recibe los puntos ya filtrados al rango.
import type { EChartsCoreOption } from "echarts/core";
import type { ChartContext } from "@/components/charts/EChart";
import { esc } from "@/components/charts/builders";
import { FX_SOURCE_LABEL, type DailyFxRate } from "@/supabase/functions/_shared/fx/rates";

const pesos2 = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pesos0 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });

export const formatFx = (v: number) => pesos2.format(v);

/** 'YYYY-MM-DD' a 'DD/MM/AAAA' sin zonas horarias. */
export function fxDayLabel(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function fxChartOption(points: DailyFxRate[]) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const color = t.palette[0] ?? t.primary;
    return {
      grid: { left: 4, right: 12, top: 12, bottom: compact ? 20 : 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.border, width: 1 } },
        backgroundColor: t.tooltipBg,
        borderColor: t.border,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: t.tooltipFg, fontSize: 12, fontFamily: t.fontFamily },
        extraCssText: "border-radius:8px;box-shadow:none;",
        confine: true,
        formatter: (raw: unknown) => {
          const item = (Array.isArray(raw) ? raw[0] : raw) as { dataIndex?: number } | undefined;
          const p = points[item?.dataIndex ?? -1];
          if (!p) return "";
          return (
            `<div style="font-weight:600;margin-bottom:2px">${esc(fxDayLabel(p.date))}</div>` +
            `<div style="font-variant-numeric:tabular-nums;font-weight:600">${esc(formatFx(p.rate))}</div>` +
            `<div style="color:${t.muted}">Oficial venta · ${esc(FX_SOURCE_LABEL[p.source])}</div>`
          );
        },
      },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: t.border } },
        axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitNumber: compact ? 3 : 4,
        splitLine: { lineStyle: { color: t.border } },
        axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => `$ ${pesos0.format(v)}` },
      },
      series: [
        {
          name: "Oficial venta",
          type: "line",
          showSymbol: false,
          symbol: "circle",
          symbolSize: 6,
          smooth: false,
          data: points.map((p) => [p.date, p.rate]),
          lineStyle: { width: 2, color },
          itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
          emphasis: { focus: "none", lineStyle: { width: 2 } },
        },
      ],
    };
  };
}
