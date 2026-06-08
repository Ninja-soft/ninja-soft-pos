"use client";

import { useEffect, useState } from "react";
import { BarChart3, Table2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import {
  ReportChart,
  type ChartType,
  type ReportChartDatum,
} from "./ReportChart";

type View = "chart" | "table";

// Memoria local (por sección) del tipo de gráfico y vista elegidos.
// No requiere backend: persiste en localStorage para sobrevivir recargas.
function usePersistedState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored) setValue(stored as T);
    } catch {
      /* sin storage */
    }
  }, [key]);
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      /* sin storage */
    }
  };
  return [value, set];
}

interface ReportSectionProps {
  /** Identificador estable para persistir preferencias de esta sección. */
  id: string;
  title: string;
  /** Datos para el gráfico. */
  chartData: ReportChartDatum[];
  /** Tipos de gráfico permitidos (el primero es el predeterminado). */
  chartTypes: ChartType[];
  valueFormat?: "currency" | "number";
  valueName?: string;
  /** Tabla existente (se conserva tal cual). */
  table: React.ReactNode;
  className?: string;
}

export function ReportSection({
  id,
  title,
  chartData,
  chartTypes,
  valueFormat = "currency",
  valueName = "Total",
  table,
  className,
}: ReportSectionProps) {
  const [view, setView] = usePersistedState<View>(`rep-view-${id}`, "chart");
  const [chartType, setChartType] = usePersistedState<ChartType>(
    `rep-chart-${id}`,
    chartTypes[0] ?? "bar",
  );

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="font-display font-bold">{title}</span>
        <div className="inline-flex gap-1 rounded-lg border border-border bg-muted/50 p-0.5">
          <button
            type="button"
            onClick={() => setView("chart")}
            aria-pressed={view === "chart"}
            aria-label="Ver gráfico"
            className={cn(
              "rounded-md px-2 py-1 transition",
              view === "chart"
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <BarChart3 size={15} />
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            aria-pressed={view === "table"}
            aria-label="Ver tabla"
            className={cn(
              "rounded-md px-2 py-1 transition",
              view === "table"
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Table2 size={15} />
          </button>
        </div>
      </div>

      {view === "chart" ? (
        <div className="p-4">
          <ReportChart
            data={chartData}
            types={chartTypes}
            type={chartType}
            onTypeChange={setChartType}
            valueFormat={valueFormat}
            valueName={valueName}
          />
        </div>
      ) : (
        table
      )}
    </div>
  );
}
