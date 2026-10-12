// Builders de opciones ECharts para reportes. Funciones puras (sin importar
// echarts en runtime): reciben datos + contexto del tema y devuelven el option.
// Reglas de dataviz aplicadas: un solo eje Y, paleta categórica en orden fijo
// (lo que excede 6 se pliega en "Otros"), marcas finas, grilla recesiva,
// tooltips con formato es-AR y textos en tinta del tema (nunca color de serie).
import type { EChartsCoreOption } from "echarts/core";
import type { ChartContext } from "./EChart";
import {
  formatAxisValue,
  formatChartValue,
  formatDelta,
  deltaPct,
  truncateLabel,
  type ChartTheme,
  type ValueFormat,
} from "./chartTheme";

export interface CategoryDatum {
  label: string;
  value: number;
  /** Línea extra del tooltip (p. ej. "12 ventas"). */
  note?: string;
}

/** Escapa texto de usuario antes de inyectarlo en el HTML del tooltip. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tooltipBase(t: ChartTheme) {
  return {
    backgroundColor: t.tooltipBg,
    borderColor: t.border,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: t.tooltipFg, fontSize: 12, fontFamily: t.fontFamily },
    extraCssText: `border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,${t.isDark ? 0.45 : 0.14});`,
    confine: true,
    transitionDuration: 0.15,
  };
}

function dot(color: string, dashed = false) {
  return dashed
    ? `<span style="display:inline-block;width:12px;height:0;border-top:2px dashed ${color};margin-right:6px;vertical-align:middle"></span>`
    : `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></span>`;
}

function row(marker: string, name: string, value: string, t: ChartTheme) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;line-height:20px"><span style="color:${t.muted}">${marker}${esc(name)}</span><span style="font-variant-numeric:tabular-nums;font-weight:600">${value}</span></div>`;
}

function title(s: string) {
  return `<div style="font-weight:600;margin-bottom:4px">${esc(s)}</div>`;
}

function valueAxis(t: ChartTheme, format: ValueFormat, compact: boolean) {
  return {
    type: "value",
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: t.muted,
      fontSize: 11,
      formatter: (v: number) => formatAxisValue(v, format),
      hideOverlap: true,
    },
    splitNumber: compact ? 3 : 4,
    splitLine: { lineStyle: { color: t.border, type: "dashed" } },
  };
}

function categoryAxis(t: ChartTheme, data: string[], boundaryGap: boolean) {
  return {
    type: "category",
    data,
    boundaryGap,
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
  };
}

function legend(t: ChartTheme, compact: boolean, extra: Record<string, unknown> = {}) {
  return {
    show: true,
    type: "plain",
    icon: "roundRect",
    itemWidth: 12,
    itemHeight: 8,
    itemGap: 14,
    textStyle: { color: t.muted, fontSize: 12 },
    ...(compact ? { bottom: 0, left: "center" } : { top: 0, right: 0 }),
    ...extra,
  };
}

function zoom(t: ChartTheme, points: number, compact: boolean) {
  // Rango largo: zoom con rueda/gesto + barra. Arranca mostrando los últimos ~31 puntos.
  if (points <= 31) return undefined;
  const start = Math.max(0, 100 - (31 / points) * 100);
  return [
    { type: "inside", start, end: 100, zoomOnMouseWheel: "shift", moveOnMouseWheel: false },
    {
      type: "slider",
      start,
      end: 100,
      height: 18,
      bottom: compact ? 30 : 6,
      borderColor: "transparent",
      backgroundColor: t.isDark ? "rgba(255,255,255,0.04)" : "rgba(30,22,60,0.04)",
      fillerColor: t.isDark ? "rgba(240,86,30,0.18)" : "rgba(232,67,27,0.14)",
      dataBackground: {
        lineStyle: { color: t.comparison, width: 1 },
        areaStyle: { color: "transparent" },
      },
      selectedDataBackground: {
        lineStyle: { color: (t.palette[0] ?? t.primary), width: 1 },
        areaStyle: { color: "transparent" },
      },
      handleStyle: { color: t.surface, borderColor: t.muted },
      moveHandleSize: 0,
      textStyle: { color: t.muted, fontSize: 10 },
      brushSelect: false,
    },
  ];
}

// ── Serie temporal (línea / área / barras) con comparación opcional ─────────

export type SeriesKind = "line" | "area" | "bar";

export interface TimeSeriesInput {
  labels: string[]; // etiquetas cortas del eje (dd/mm)
  tooltipLabels?: string[]; // etiquetas largas (lun 06/10)
  values: number[];
  name: string;
  format: ValueFormat;
  kind: SeriesKind;
  previous?: { values: number[]; labels: string[]; name: string } | null;
  /** Línea de promedio del período. */
  showAverage?: boolean;
}

export function timeSeriesOption(input: TimeSeriesInput) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const { labels, values, format, kind, previous } = input;
    const color = (t.palette[0] ?? t.primary);
    const n = labels.length;
    const dz = zoom(t, n, compact);
    const hasLegend = !!previous;
    const avg = n ? values.reduce((a, v) => a + v, 0) / n : 0;

    const current: Record<string, unknown> = {
      name: input.name,
      type: kind === "bar" ? "bar" : "line",
      data: values,
      z: 3,
      itemStyle: { color, borderRadius: kind === "bar" ? [4, 4, 0, 0] : 0 },
      emphasis: { focus: "none" },
    };
    if (kind === "bar") {
      Object.assign(current, { barMaxWidth: 28, barCategoryGap: "28%" });
    } else {
      Object.assign(current, {
        smooth: 0.25,
        smoothMonotone: "x",
        showSymbol: n <= 14,
        symbol: "circle",
        symbolSize: 7,
        lineStyle: { width: 2, color },
        itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
        areaStyle:
          kind === "area"
            ? {
                color: {
                  type: "linear",
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: `${color}${t.isDark ? "59" : "40"}` },
                    { offset: 1, color: `${color}00` },
                  ],
                },
              }
            : undefined,
      });
    }
    if (input.showAverage && n > 2) {
      current.markLine = {
        silent: true,
        symbol: "none",
        lineStyle: { color: t.muted, type: [4, 4], width: 1, opacity: 0.7 },
        label: {
          position: "insideEndTop",
          color: t.muted,
          fontSize: 10,
          formatter: () => `Prom. ${formatAxisValue(avg, format)}`,
        },
        data: [{ yAxis: avg }],
      };
    }

    const series: Record<string, unknown>[] = [current];
    if (previous) {
      series.unshift({
        name: previous.name,
        type: "line",
        data: previous.values,
        z: 2,
        smooth: 0.25,
        smoothMonotone: "x",
        showSymbol: false,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 1.5, type: [5, 4], color: t.comparison },
        itemStyle: { color: t.comparison },
      });
    }

    return {
      grid: {
        left: 4,
        right: 12,
        top: hasLegend && !compact ? 36 : 16,
        bottom: (dz ? (compact ? 58 : 34) : 4) + (hasLegend && compact ? 28 : 0),
        containLabel: true,
      },
      legend: hasLegend ? legend(t, compact, { data: [previous!.name, input.name] }) : { show: false },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: {
          type: kind === "bar" ? "shadow" : "line",
          lineStyle: { color: t.muted, width: 1, type: "dashed" },
          shadowStyle: { color: t.isDark ? "rgba(255,255,255,0.04)" : "rgba(30,22,60,0.05)" },
        },
        formatter: (params: { dataIndex: number }[]) => {
          const i = params[0]?.dataIndex ?? 0;
          const head = input.tooltipLabels?.[i] ?? labels[i] ?? "";
          let html = title(head) + row(dot(color), input.name, formatChartValue(values[i] ?? 0, format), t);
          if (previous) {
            const pv = previous.values[i];
            const pl = previous.labels[i];
            if (pv != null) {
              html += row(
                dot(t.comparison, true),
                pl ? `${previous.name} (${pl})` : previous.name,
                formatChartValue(pv, format),
                t,
              );
              const d = deltaPct(values[i] ?? 0, pv);
              if (d != null) {
                const c = d >= 0 ? t.positive : t.negative;
                html += `<div style="margin-top:4px;color:${c};font-weight:600;font-variant-numeric:tabular-nums">${d >= 0 ? "▲" : "▼"} ${formatDelta(d)}</div>`;
              }
            }
          }
          return html;
        },
      },
      xAxis: categoryAxis(t, labels, kind === "bar"),
      yAxis: valueAxis(t, format, compact),
      dataZoom: dz,
      series,
    };
  };
}

// ── Ranking horizontal (top productos / clientes / cajeros) ─────────────────

export function rankingBarOption(input: {
  items: CategoryDatum[];
  name: string;
  format: ValueFormat;
}) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const items = input.items;
    const max = compact ? 14 : 20;
    const color = (t.palette[0] ?? t.primary);
    return {
      grid: { left: 4, right: compact ? 56 : 72, top: 4, bottom: 4, containLabel: true },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p: { dataIndex: number }) => {
          const d = items[p.dataIndex];
          if (!d) return "";
          return (
            title(d.label) +
            row(dot(color), input.name, formatChartValue(d.value, input.format), t) +
            (d.note ? `<div style="color:${t.muted};margin-top:2px">${esc(d.note)}</div>` : "")
          );
        },
      },
      xAxis: { ...valueAxis(t, input.format, compact), axisLabel: { show: false }, splitLine: { show: false } },
      yAxis: {
        type: "category",
        inverse: true,
        data: items.map((d) => truncateLabel(d.label, max)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.foreground, fontSize: 12, margin: 10 },
      },
      series: [
        {
          name: input.name,
          type: "bar",
          data: items.map((d) => d.value),
          barMaxWidth: 18,
          barCategoryGap: "38%",
          showBackground: true,
          backgroundStyle: {
            color: t.isDark ? "rgba(255,255,255,0.035)" : "rgba(30,22,60,0.04)",
            borderRadius: 4,
          },
          itemStyle: { color, borderRadius: [0, 4, 4, 0] },
          label: {
            show: true,
            position: "right",
            color: t.foreground,
            fontSize: 11,
            fontWeight: 600,
            formatter: (p: { value: number }) => formatAxisValue(p.value, input.format),
          },
        },
      ],
    };
  };
}

// ── Barras verticales simples (comparar pocas categorías) ───────────────────

export function columnBarOption(input: { items: CategoryDatum[]; name: string; format: ValueFormat }) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const items = input.items;
    const color = (t.palette[0] ?? t.primary);
    return {
      grid: { left: 4, right: 8, top: 20, bottom: 4, containLabel: true },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p: { dataIndex: number }) => {
          const d = items[p.dataIndex];
          if (!d) return "";
          return (
            title(d.label) +
            row(dot(color), input.name, formatChartValue(d.value, input.format), t) +
            (d.note ? `<div style="color:${t.muted};margin-top:2px">${esc(d.note)}</div>` : "")
          );
        },
      },
      xAxis: {
        ...categoryAxis(
          t,
          items.map((d) => truncateLabel(d.label, compact ? 8 : 14)),
          true,
        ),
        axisLabel: { color: t.muted, fontSize: 11, interval: 0, hideOverlap: true },
      },
      yAxis: valueAxis(t, input.format, compact),
      series: [
        {
          name: input.name,
          type: "bar",
          data: items.map((d) => d.value),
          barMaxWidth: 40,
          itemStyle: { color, borderRadius: [4, 4, 0, 0] },
          label: {
            show: items.length <= 8,
            position: "top",
            color: t.muted,
            fontSize: 10,
            formatter: (p: { value: number }) => formatAxisValue(p.value, input.format),
          },
        },
      ],
    };
  };
}

// ── Dona (mix de medios de pago, categorías) ────────────────────────────────

/** Top N-1 + "Otros" para no pasar de la paleta (nunca se ciclan colores). */
export function foldOthers(items: CategoryDatum[], max = 6): CategoryDatum[] {
  const sorted = [...items].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= max) return sorted;
  const head = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1);
  return [
    ...head,
    {
      label: "Otros",
      value: rest.reduce((a, d) => a + d.value, 0),
      note: `${rest.length} más`,
    },
  ];
}

export function doughnutOption(input: {
  items: CategoryDatum[];
  name: string;
  format: ValueFormat;
  centerLabel?: string;
}) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const items = foldOthers(input.items);
    const total = items.reduce((a, d) => a + d.value, 0);
    const pct = (v: number) => (total ? Math.round((v / total) * 1000) / 10 : 0);
    const center = compact ? ["50%", "38%"] : ["30%", "50%"];
    const byName = new Map(items.map((d) => [d.label, d]));
    return {
      title: {
        text: formatAxisValue(total, input.format),
        subtext: input.centerLabel ?? "Total",
        left: center[0],
        top: center[1],
        textAlign: "center",
        textVerticalAlign: "middle",
        itemGap: 2,
        textStyle: { color: t.foreground, fontSize: compact ? 16 : 18, fontWeight: 700 },
        subtextStyle: { color: t.muted, fontSize: 11 },
      },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p: { name: string; color: string; value: number }) => {
          const d = byName.get(p.name);
          return (
            title(p.name) +
            row(dot(p.color), input.name, formatChartValue(p.value, input.format), t) +
            row("", "Participación", `${pct(p.value).toLocaleString("es-AR")}%`, t) +
            (d?.note ? `<div style="color:${t.muted};margin-top:2px">${esc(d.note)}</div>` : "")
          );
        },
      },
      legend: compact
        ? legend(t, true, { left: 8, right: 8, itemGap: 12 })
        : {
            ...legend(t, false),
            top: "middle",
            right: 8,
            left: "58%",
            orient: "vertical",
            itemGap: 12,
            formatter: (name: string) => {
              const d = byName.get(name);
              return `{n|${truncateLabel(name, 18)}}  {p|${d ? pct(d.value).toLocaleString("es-AR") : 0}%}`;
            },
            textStyle: {
              color: t.muted,
              rich: {
                n: { color: t.foreground, fontSize: 12, width: 120 },
                p: { color: t.muted, fontSize: 12, fontWeight: 600 },
              },
            },
          },
      series: [
        {
          name: input.name,
          type: "pie",
          radius: compact ? ["46%", "66%"] : ["58%", "82%"],
          center,
          avoidLabelOverlap: true,
          padAngle: 0,
          minAngle: 3,
          itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          labelLine: { show: false },
          emphasis: { scale: true, scaleSize: 4, label: { show: false } },
          data: items.map((d, i) => ({
            name: d.label,
            value: d.value,
            itemStyle: { color: t.palette[i % t.palette.length] },
          })),
        },
      ],
    };
  };
}

// ── Treemap (peso relativo de categorías / productos) ───────────────────────

export function treemapOption(input: { items: CategoryDatum[]; name: string; format: ValueFormat }) {
  return ({ theme: t }: ChartContext): EChartsCoreOption => {
    const items = [...input.items].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
    const total = items.reduce((a, d) => a + d.value, 0);
    // Un solo tono (secuencial por valor): el área ya codifica la magnitud.
    const shades = t.isDark
      ? ["#F0561E", "#C9461A", "#9C3816", "#742A12"]
      : ["#E8431B", "#C2370F", "#9C2C0C", "#78220A"];
    const max = items[0]?.value ?? 1;
    const shadeFor = (v: number) => {
      const r = v / max;
      return r > 0.66 ? shades[0] : r > 0.33 ? shades[1] : r > 0.12 ? shades[2] : shades[3];
    };
    return {
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p: { name: string; value: number; dataIndex: number; color: string }) => {
          const d = items.find((x) => x.label === p.name);
          const share = total ? ((p.value / total) * 100).toFixed(1).replace(".", ",") : "0";
          return (
            title(p.name) +
            row(dot(p.color), input.name, formatChartValue(p.value, input.format), t) +
            row("", "Participación", `${share}%`, t) +
            (d?.note ? `<div style="color:${t.muted};margin-top:2px">${esc(d.note)}</div>` : "")
          );
        },
      },
      series: [
        {
          name: input.name,
          type: "treemap",
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          squareRatio: 0.9,
          itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2, borderRadius: 6 },
          label: {
            show: true,
            color: "#ffffff",
            fontSize: 12,
            fontWeight: 600,
            overflow: "truncate",
            lineHeight: 16,
            formatter: (p: { name: string; value: number }) =>
              `${p.name}\n{v|${formatAxisValue(p.value, input.format)}}`,
            rich: { v: { color: "rgba(255,255,255,0.82)", fontSize: 11, fontWeight: 500 } },
          },
          emphasis: { itemStyle: { borderColor: t.surface }, label: { show: true } },
          data: items.map((d) => ({
            name: d.label,
            value: d.value,
            itemStyle: { color: shadeFor(d.value) },
          })),
        },
      ],
    };
  };
}

// ── Heatmap día × hora ──────────────────────────────────────────────────────

export const WEEKDAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const WEEKDAYS_SHORT = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

export function heatmapOption(input: {
  /** [weekday 0=lunes][hour 0..23] */
  totals: number[][];
  counts: number[][];
  format: ValueFormat;
}) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    // Recorta a las horas con actividad (más densidad, menos celdas vacías).
    let first = 23;
    let last = 0;
    input.totals.forEach((day) =>
      day.forEach((v, h) => {
        if (v > 0) {
          first = Math.min(first, h);
          last = Math.max(last, h);
        }
      }),
    );
    if (first > last) {
      first = 8;
      last = 21;
    }
    const hours: number[] = [];
    for (let h = first; h <= last; h++) hours.push(h);
    const data: [number, number, number][] = [];
    let max = 0;
    input.totals.forEach((day, d) =>
      hours.forEach((h, x) => {
        const v = day[h] ?? 0;
        max = Math.max(max, v);
        data.push([x, d, v]);
      }),
    );
    return {
      grid: { left: 4, right: 8, top: 4, bottom: compact ? 52 : 44, containLabel: true },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p: { value: [number, number, number] }) => {
          const [x, d, v] = p.value;
          const h = hours[x] ?? 0;
          const c = input.counts[d]?.[h] ?? 0;
          return (
            title(`${WEEKDAYS[d]} · ${h} a ${h + 1} h`) +
            row("", "Vendido", formatChartValue(v, input.format), t) +
            row("", "Ventas", c.toLocaleString("es-AR"), t)
          );
        },
      },
      xAxis: {
        type: "category",
        data: hours.map((h) => `${h}h`),
        splitArea: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 10, interval: compact ? 2 : hours.length > 16 ? 1 : 0 },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: WEEKDAYS_SHORT,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 11 },
      },
      visualMap: {
        min: 0,
        max: Math.max(1, max),
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemWidth: 10,
        itemHeight: compact ? 140 : 200,
        text: ["Más", "Menos"],
        textGap: 8,
        textStyle: { color: t.muted, fontSize: 11 },
        inRange: { color: t.sequential },
        formatter: (v: number) => formatAxisValue(v, input.format),
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
          emphasis: { itemStyle: { borderColor: t.foreground, borderWidth: 1 } },
          progressive: 0,
        },
      ],
    };
  };
}

// ── Barras apiladas (comisión + propinas, flujo de caja) ────────────────────

export function stackedBarOption(input: {
  categories: string[];
  series: { name: string; values: number[] }[];
  format: ValueFormat;
  horizontal?: boolean;
}) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const horizontal = input.horizontal ?? false;
    const labels = input.categories.map((c) => truncateLabel(c, compact ? 12 : 20));
    const cat = horizontal
      ? {
          type: "category",
          inverse: true,
          data: labels,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.foreground, fontSize: 12 },
        }
      : categoryAxis(t, labels, true);
    const val = valueAxis(t, input.format, compact);
    const last = input.series.length - 1;
    return {
      grid: { left: 4, right: 28, top: compact ? 8 : 36, bottom: compact ? 32 : 4, containLabel: true },
      legend: legend(t, compact),
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: {
          type: "shadow",
          shadowStyle: { color: t.isDark ? "rgba(255,255,255,0.04)" : "rgba(30,22,60,0.05)" },
        },
        formatter: (params: { dataIndex: number; seriesName: string; color: string; value: number }[]) => {
          const i = params[0]?.dataIndex ?? 0;
          let sum = 0;
          let html = title(input.categories[i] ?? "");
          params.forEach((p) => {
            sum += p.value;
            html += row(dot(p.color), p.seriesName, formatChartValue(p.value, input.format), t);
          });
          if (params.length > 1) html += row("", "Total", formatChartValue(sum, input.format), t);
          return html;
        },
      },
      xAxis: horizontal ? val : cat,
      yAxis: horizontal ? cat : val,
      series: input.series.map((s, i) => ({
        name: s.name,
        type: "bar",
        stack: "total",
        data: s.values,
        barMaxWidth: horizontal ? 18 : 32,
        itemStyle: {
          color: t.palette[i % t.palette.length],
          borderColor: t.surface,
          borderWidth: input.series.length > 1 ? 1 : 0,
          borderRadius:
            i === last ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0,
        },
      })),
    };
  };
}

export function cashFlowOption(input: {
  labels: string[];
  tooltipLabels?: string[];
  inflow: number[];
  outflow: number[]; // positivos; se dibujan hacia abajo
}) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const n = input.labels.length;
    const net = input.inflow.map((v, i) => v - (input.outflow[i] ?? 0));
    const dz = zoom(t, n, compact);
    return {
      grid: {
        left: 4,
        right: 12,
        top: compact ? 8 : 36,
        bottom: (dz ? (compact ? 58 : 34) : 4) + (compact ? 28 : 0),
        containLabel: true,
      },
      legend: legend(t, compact, { data: ["Ingresos", "Egresos", "Neto"] }),
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: {
          type: "shadow",
          shadowStyle: { color: t.isDark ? "rgba(255,255,255,0.04)" : "rgba(30,22,60,0.05)" },
        },
        formatter: (params: { dataIndex: number }[]) => {
          const i = params[0]?.dataIndex ?? 0;
          return (
            title(input.tooltipLabels?.[i] ?? input.labels[i] ?? "") +
            row(dot(t.positive), "Ingresos", formatChartValue(input.inflow[i] ?? 0, "currency"), t) +
            row(dot(t.negative), "Egresos", formatChartValue(input.outflow[i] ?? 0, "currency"), t) +
            row(dot(t.foreground), "Neto", formatChartValue(net[i] ?? 0, "currency"), t)
          );
        },
      },
      xAxis: categoryAxis(t, input.labels, true),
      yAxis: valueAxis(t, "currency", compact),
      dataZoom: dz,
      series: [
        {
          name: "Ingresos",
          type: "bar",
          stack: "flow",
          data: input.inflow,
          barMaxWidth: 22,
          itemStyle: { color: t.positive, borderRadius: [4, 4, 0, 0] },
        },
        {
          name: "Egresos",
          type: "bar",
          stack: "flow",
          data: input.outflow.map((v) => -v),
          barMaxWidth: 22,
          itemStyle: { color: t.negative, borderRadius: [0, 0, 4, 4] },
        },
        {
          name: "Neto",
          type: "line",
          data: net,
          smooth: 0.2,
          smoothMonotone: "x",
          showSymbol: n <= 14,
          symbol: "circle",
          symbolSize: 6,
          z: 5,
          lineStyle: { width: 2, color: t.foreground },
          itemStyle: { color: t.foreground, borderColor: t.surface, borderWidth: 2 },
        },
      ],
    };
  };
}

// ── Bullet (stock actual vs. mínimo) ────────────────────────────────────────

export function bulletOption(input: {
  items: { label: string; value: number; target: number; unit?: string }[];
}) {
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => {
    const items = input.items;
    return {
      grid: { left: 4, right: 16, top: compact ? 8 : 32, bottom: compact ? 30 : 4, containLabel: true },
      legend: legend(t, compact, { data: ["Stock", "Mínimo"] }),
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "none" },
        formatter: (params: { dataIndex: number }[]) => {
          const d = items[params[0]?.dataIndex ?? 0];
          if (!d) return "";
          const u = d.unit ? ` ${esc(d.unit)}` : "";
          return (
            title(d.label) +
            row(dot((t.palette[0] ?? t.primary)), "Stock", `${formatChartValue(d.value, "number")}${u}`, t) +
            row(dot(t.comparison), "Mínimo", `${formatChartValue(d.target, "number")}${u}`, t)
          );
        },
      },
      xAxis: valueAxis(t, "number", compact),
      yAxis: {
        type: "category",
        inverse: true,
        data: items.map((d) => truncateLabel(d.label, compact ? 14 : 24)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.foreground, fontSize: 12 },
      },
      series: [
        {
          name: "Mínimo",
          type: "bar",
          data: items.map((d) => d.target),
          barWidth: 14,
          itemStyle: { color: t.comparison, opacity: 0.4, borderRadius: [0, 4, 4, 0] },
          z: 1,
        },
        {
          name: "Stock",
          type: "bar",
          data: items.map((d) => d.value),
          barWidth: 14,
          barGap: "-100%",
          itemStyle: { color: (t.palette[0] ?? t.primary), borderRadius: [0, 4, 4, 0] },
          z: 2,
        },
      ],
    };
  };
}
