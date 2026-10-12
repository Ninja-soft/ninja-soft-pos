"use client";

import { useEffect, useRef, useState } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";

// Colores del tema actual (las CSS vars son hex/rgba: ECharts las toma tal cual).
export function themeColors() {
  if (typeof window === "undefined") {
    return { fg: "#888", muted: "#888", border: "rgba(128,128,128,.2)", card: "transparent" };
  }
  const s = getComputedStyle(document.documentElement);
  const v = (k: string, f: string) => s.getPropertyValue(k).trim() || f;
  return {
    fg: v("--foreground", "#888"),
    muted: v("--muted-foreground", "#888"),
    border: v("--border", "rgba(128,128,128,.2)"),
    card: v("--card", "transparent"),
  };
}

// Carga perezosa de ECharts (sólo el core + lo que usamos): no entra al bundle
// inicial de ninguna pantalla.
async function loadEcharts() {
  const [core, charts, components, renderers] = await Promise.all([
    import("echarts/core"),
    import("echarts/charts"),
    import("echarts/components"),
    import("echarts/renderers"),
  ]);
  core.use([
    charts.BarChart,
    charts.PieChart,
    components.GridComponent,
    components.TooltipComponent,
    components.LegendComponent,
    renderers.CanvasRenderer,
  ]);
  return core;
}

export function EChart({
  option,
  height = 260,
  className,
  onClickName,
}: {
  option: EChartsCoreOption;
  height?: number;
  className?: string;
  // Click en una categoría/serie (filtros desde el gráfico).
  onClickName?: (name: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ setOption: (o: EChartsCoreOption, n?: boolean) => void; dispose: () => void; resize: () => void } | null>(null);
  const clickRef = useRef(onClickName);
  clickRef.current = onClickName;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    loadEcharts().then((echarts) => {
      if (disposed || !ref.current) return;
      const chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
      chart.on("click", (p: { name?: string }) => {
        if (p?.name) clickRef.current?.(p.name);
      });
      chartRef.current = chart;
      ro = new ResizeObserver(() => chart.resize());
      ro.observe(ref.current);
      setReady(true);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (ready) chartRef.current?.setOption(option, true);
  }, [ready, option]);

  return (
    <div className={cn("relative w-full", className)} style={{ height }}>
      <div ref={ref} className="absolute inset-0" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size={22} />
        </div>
      )}
    </div>
  );
}
