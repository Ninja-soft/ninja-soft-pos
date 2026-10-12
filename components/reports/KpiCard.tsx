"use client";

import { useId, type ReactNode } from "react";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "@/components/ui/Spinner";
import { formatDelta } from "@/components/charts/chartTheme";

/** Mini línea SVG (sin echarts: liviana y sin carga diferida). */
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const id = useId().replace(/:/g, "");
  if (values.length < 2) return null;
  const w = 120;
  const h = 32;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * w,
    h - 2 - ((v - min) / span) * (h - 4),
  ]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x!.toFixed(1)} ${y!.toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn("h-8 w-full", className)}
    >
      <defs>
        <linearGradient id={`spk-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spk-${id})`} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

interface KpiCardProps {
  label: string;
  value: ReactNode;
  /** Variación % vs. período anterior (null = sin base para comparar). */
  delta?: number | null;
  deltaLoading?: boolean;
  /** Texto de comparación (p. ej. "vs. 7 días anteriores"). */
  deltaHint?: string;
  /** Si bajar es bueno (p. ej. gastos), invierte el color del delta. */
  inverse?: boolean;
  spark?: number[];
  hint?: ReactNode;
  valueClassName?: string;
}

export function KpiCard({
  label,
  value,
  delta,
  deltaLoading,
  deltaHint,
  inverse = false,
  spark,
  hint,
  valueClassName,
}: KpiCardProps) {
  const good = delta != null && (inverse ? delta < 0 : delta > 0);
  const bad = delta != null && (inverse ? delta > 0 : delta < 0);
  const Icon = delta == null || delta === 0 ? Minus : delta > 0 ? TrendingUp : TrendingDown;
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-4">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1.5 truncate font-display text-xl font-black tabular-nums leading-tight sm:text-[26px]",
          valueClassName,
        )}
      >
        {value}
      </p>
      <div className="mt-2 flex min-h-[22px] flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {deltaLoading ? (
          <Spinner size={12} />
        ) : delta !== undefined ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold tabular-nums",
              good && "bg-success/10 text-success",
              bad && "bg-danger/10 text-danger",
              !good && !bad && "bg-muted text-muted-foreground",
            )}
          >
            <Icon size={12} aria-hidden="true" />
            {delta == null ? "Sin base" : formatDelta(delta)}
          </span>
        ) : null}
        {(deltaHint || hint) && (
          <span className="line-clamp-2 text-muted-foreground">{hint ?? deltaHint}</span>
        )}
      </div>
      {spark && spark.length > 1 && spark.some((v) => v !== 0) && (
        <Sparkline values={spark} className="mt-3 text-ninja-flameSoft" />
      )}
    </div>
  );
}
