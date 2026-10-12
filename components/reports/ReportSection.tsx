"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChartColumn, ImageDown, Table2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { EChart, type EChartHandle, type OptionBuilder, type ChartSummary } from "@/components/charts/EChart";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";

type View = "chart" | "table";

const VIEW_OPTIONS: SegmentedOption<View>[] = [
  { value: "chart", label: "Gráfico", icon: <ChartColumn size={14} strokeWidth={1.75} /> },
  { value: "table", label: "Tabla", icon: <Table2 size={14} strokeWidth={1.75} /> },
];

// Preferencia local por sección (vista y tipo de gráfico). localStorage puede
// no existir (modo privado / bloqueado): todo va en try/catch.
function usePersistedChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  const allowedKey = allowed.join("|");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key) as T | null;
      if (stored && allowedKey.split("|").includes(stored)) setValue(stored);
    } catch {
      /* sin storage */
    }
  }, [key, allowedKey]);
  const set = (v: T) => {
    setValue(v);
    try {
      window.localStorage.setItem(key, v);
    } catch {
      /* sin storage */
    }
  };
  return [value, set];
}

export interface ReportChartSpec {
  option: OptionBuilder;
  ariaLabel: string;
  summary?: ChartSummary;
  empty?: boolean;
  height?: number;
  compactHeight?: number;
}

interface ReportSectionProps<T extends string> {
  /** Identificador estable (persistencia + nombre del PNG). */
  id: string;
  title: string;
  /** Línea secundaria bajo el título (dato clave de la sección). */
  subtitle?: ReactNode;
  /** Tipos de gráfico alternables (el primero es el predeterminado). */
  chartTypes?: SegmentedOption<T>[];
  /** Arma el gráfico para el tipo activo. */
  chart: (type: T) => ReportChartSpec;
  /** Controles extra de la vista gráfico (p. ej. métrica). */
  controls?: ReactNode;
  table: ReactNode;
  /** Datos todavía cargando (consultas diferidas). */
  loading?: boolean;
  /** Se llama una vez cuando la sección se acerca al viewport. */
  onVisible?: () => void;
  className?: string;
}

export function ReportSection<T extends string = string>({
  id,
  title,
  subtitle,
  chartTypes,
  chart,
  controls,
  table,
  loading = false,
  onVisible,
  className,
}: ReportSectionProps<T>) {
  const rootRef = useRef<HTMLElement>(null);
  const chartRef = useRef<EChartHandle>(null);
  const [view, setView] = usePersistedChoice<View>(`rep-view-${id}`, ["chart", "table"], "chart");
  const typeValues = useMemo(() => (chartTypes ?? []).map((o) => o.value), [chartTypes]);
  const [chartType, setChartType] = usePersistedChoice<T>(
    `rep-chart-${id}`,
    typeValues,
    (typeValues[0] ?? "bar") as T,
  );

  // Aviso de visibilidad para disparar consultas diferidas (no en el primer paint).
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const hasOnVisible = !!onVisible;
  useEffect(() => {
    if (!hasOnVisible) return;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      onVisibleRef.current?.();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onVisibleRef.current?.();
          io.disconnect();
        }
      },
      { rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasOnVisible]);

  const spec = chart(chartType);
  const canExport = view === "chart" && !loading && !spec.empty;
  const showToolbar = view === "chart" && ((chartTypes?.length ?? 0) > 1 || !!controls);
  const viewToggle = (
    <SegmentedControl
      ariaLabel={`Vista de ${title}`}
      value={view}
      onChange={setView}
      options={VIEW_OPTIONS}
      size="sm"
    />
  );

  return (
    <section
      ref={rootRef}
      aria-labelledby={`rep-${id}-title`}
      className={cn("min-w-0 overflow-hidden rounded-lg border border-border bg-card", className)}
    >
      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <h2 id={`rep-${id}-title`} className="font-display text-[15px] font-bold leading-6">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canExport && (
            <button
              type="button"
              onClick={() => chartRef.current?.exportPng(`ninjasoft-${id}`)}
              title="Descargar PNG"
              aria-label={`Descargar ${title} como PNG`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ImageDown size={16} strokeWidth={1.75} />
            </button>
          )}
          {/* Desktop: el switch Gráfico/Tabla vive en el header. */}
          <div className="hidden sm:block">{viewToggle}</div>
        </div>
      </header>

      {/* Mobile: el switch baja a la barra de herramientas (el título respira). */}
      <div
        className={cn(
          "flex-wrap items-center gap-2 px-4 pb-2",
          showToolbar ? "flex" : "flex sm:hidden",
        )}
      >
        {view === "chart" && chartTypes && chartTypes.length > 1 && (
          <SegmentedControl
            ariaLabel={`Tipo de gráfico de ${title}`}
            value={chartType}
            onChange={setChartType}
            options={chartTypes}
            size="sm"
            iconOnlyOnMobile
          />
        )}
        {view === "chart" && controls && (
          <div className="order-last w-full sm:order-none sm:w-auto">{controls}</div>
        )}
        <div className="ml-auto sm:hidden">{viewToggle}</div>
      </div>

      {view === "chart" ? (
        <div className="px-3 pb-4 pt-1 sm:px-4">
          {loading ? (
            <div
              className="flex items-center justify-center"
              style={{ height: spec.height ?? 280 }}
            >
              <Spinner size={22} />
            </div>
          ) : (
            <EChart
              ref={chartRef}
              option={spec.option}
              height={spec.height}
              compactHeight={spec.compactHeight}
              ariaLabel={spec.ariaLabel}
              summary={spec.summary}
              empty={spec.empty}
            />
          )}
        </div>
      ) : (
        <div className="border-t border-border">{table}</div>
      )}
    </section>
  );
}
