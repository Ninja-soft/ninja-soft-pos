"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ChartNoAxesColumn } from "lucide-react";
import type { ECharts, EChartsCoreOption } from "echarts/core";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import { readChartTheme, type ChartTheme } from "./chartTheme";

/** Contexto que recibe el builder de opciones en cada render del gráfico. */
export interface ChartContext {
  theme: ChartTheme;
  /** Contenedor angosto (mobile): leyendas abajo, menos etiquetas. */
  compact: boolean;
  width: number;
  reducedMotion: boolean;
}

export type OptionBuilder = (ctx: ChartContext) => EChartsCoreOption;

export interface ChartSummary {
  columns: string[];
  rows: (string | number)[][];
}

export interface EChartHandle {
  /** Descarga el gráfico como PNG (2x) con el fondo del tema. */
  exportPng: (filename: string) => void;
}

interface EChartProps {
  option: OptionBuilder;
  /** Alto en desktop. */
  height?: number;
  /** Alto en contenedor angosto (default: height). */
  compactHeight?: number;
  /** Descripción para lectores de pantalla (role="img"). */
  ariaLabel: string;
  /** Tabla visualmente oculta con los datos graficados (a11y). */
  summary?: ChartSummary;
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  className?: string;
}

const COMPACT_BELOW = 480;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Gráfico ECharts reutilizable y perezoso:
 * - echarts/core se descarga recién cuando el gráfico entra al viewport;
 * - colores leídos de las CSS vars del tema (se re-dibuja al cambiar de tema);
 * - redimensiona con ResizeObserver y respeta prefers-reduced-motion;
 * - expone exportPng() vía ref.
 */
export const EChart = forwardRef<EChartHandle, EChartProps>(function EChart(
  {
    option,
    height = 280,
    compactHeight,
    ariaLabel,
    summary,
    empty = false,
    emptyTitle = "Sin datos en este período",
    emptyHint = "Probá con otro rango de fechas.",
    className,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const [inView, setInView] = useState(false);
  const [ready, setReady] = useState(false);
  const [compact, setCompact] = useState(false);
  const [themeTick, setThemeTick] = useState(0);

  const buildCtx = useCallback((): ChartContext => {
    const el = hostRef.current;
    const width = el?.clientWidth ?? 0;
    return {
      theme: readChartTheme(el),
      compact: width > 0 && width < COMPACT_BELOW,
      width,
      reducedMotion: prefersReducedMotion(),
    };
  }, []);

  const render = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ctx = buildCtx();
    const base: EChartsCoreOption = {
      backgroundColor: "transparent",
      animation: !ctx.reducedMotion,
      animationDuration: 450,
      animationDurationUpdate: 250,
      color: ctx.theme.palette,
      textStyle: { fontFamily: ctx.theme.fontFamily, color: ctx.theme.muted },
    };
    chart.setOption({ ...base, ...optionRef.current(ctx) }, { notMerge: true });
  }, [buildCtx]);

  // 1) Carga diferida: recién al acercarse al viewport.
  useEffect(() => {
    if (empty || inView) return;
    const el = hostRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [empty, inView]);

  // 2) Init de ECharts + observers (resize / tema).
  useEffect(() => {
    if (!inView || empty) return;
    let alive = true;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    (async () => {
      const { echarts } = await import("./echarts-core");
      const el = hostRef.current;
      if (!alive || !el) return;
      const chart = echarts.init(el, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      setCompact(el.clientWidth > 0 && el.clientWidth < COMPACT_BELOW);
      render();
      setReady(true);
      ro = new ResizeObserver(() => {
        const w = el.clientWidth;
        setCompact(w > 0 && w < COMPACT_BELOW);
        chart.resize();
      });
      ro.observe(el);
      mo = new MutationObserver(() => setThemeTick((t) => t + 1));
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class"],
      });
    })();
    return () => {
      alive = false;
      ro?.disconnect();
      mo?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
      setReady(false);
    };
  }, [inView, empty, render]);

  // 3) Re-dibujo ante cambio de datos, tema o breakpoint.
  useEffect(() => {
    if (ready) render();
  }, [option, compact, themeTick, ready, render]);

  useImperativeHandle(
    ref,
    () => ({
      exportPng: (filename: string) => {
        const chart = chartRef.current;
        if (!chart) return;
        const { theme } = buildCtx();
        const url = chart.getDataURL({
          type: "png",
          pixelRatio: 2,
          backgroundColor: theme.isDark ? "#140d2c" : theme.surface,
        });
        const a = document.createElement("a");
        a.href = url;
        a.download = `${filename}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    }),
    [buildCtx],
  );

  const h = compact && compactHeight ? compactHeight : height;

  if (empty) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg bg-muted/40 px-6 text-center",
          className,
        )}
        style={{ height: Math.min(height, compactHeight ?? height, 220) }}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ChartNoAxesColumn size={18} aria-hidden="true" />
        </span>
        <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <div role="img" aria-label={ariaLabel}>
        <div ref={hostRef} aria-hidden="true" className="w-full" style={{ height: h }} />
      </div>
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size={22} />
        </div>
      )}
      {summary && summary.rows.length > 0 && (
        <table className="sr-only">
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              {summary.columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});

EChart.displayName = "EChart";
