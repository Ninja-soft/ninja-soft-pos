import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, ChevronRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { InfoHint } from "@/components/ui/InfoHint";
import { formatPct } from "@/lib/internal/saasKpis";

// Tarjeta de KPI del dashboard interno (spec docs/40 §15.1): título, valor
// compacto (el exacto en el title), ⓘ con la definición, tendencia contra el
// período anterior y link al listado que la explica. Nada se sale de la
// tarjeta: min-w-0, truncate y tabular-nums.
export function KpiTile({
  label,
  value,
  exact,
  icon: Icon,
  definition,
  sub,
  trendPct,
  goodWhen = "up",
  trendLabel = "vs. período anterior",
  href,
  tone = "default",
}: {
  label: string;
  /** null = sin datos suficientes ("n/d"). */
  value: string | null;
  exact?: string;
  icon: LucideIcon;
  definition: string;
  sub?: React.ReactNode;
  trendPct?: number | null;
  goodWhen?: "up" | "down";
  trendLabel?: string;
  href?: string;
  tone?: "default" | "warning" | "danger";
}) {
  const hasTrend = trendPct !== undefined && trendPct !== null;
  const dir = !hasTrend || trendPct === 0 ? "flat" : trendPct! > 0 ? "up" : "down";
  const good = dir === "flat" ? null : dir === goodWhen;
  const TrendIcon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;

  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <Icon size={15} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate text-xs font-medium" title={label}>{label}</span>
        <InfoHint title={label} label={`Qué mide ${label}`} size={14} className="ml-auto">
          <p className="font-display text-sm font-bold">{label}</p>
          <p className="mt-1.5 text-muted-foreground">{definition}</p>
          {exact && (
            <p className="mt-2 font-mono text-[11px] text-foreground">Valor exacto: {exact}</p>
          )}
        </InfoHint>
      </div>

      {value === null ? (
        <p className="mt-2 text-lg font-semibold text-muted-foreground">n/d</p>
      ) : (
        <p
          title={exact ?? value}
          className={cn(
            "mt-2 min-w-0 truncate font-display text-xl font-black tabular-nums leading-tight sm:text-2xl",
            tone === "warning" && "text-warning",
            tone === "danger" && "text-danger",
          )}
        >
          {value}
        </p>
      )}

      {sub && <div className="mt-1 line-clamp-2 min-w-0 text-xs text-muted-foreground">{sub}</div>}

      <div className="mt-auto flex min-w-0 items-center justify-between gap-2 pt-3">
        {hasTrend ? (
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1 truncate text-xs font-semibold tabular-nums",
              good === true && "text-success",
              good === false && "text-danger",
              good === null && "text-muted-foreground",
            )}
            title={trendLabel}
          >
            <TrendIcon size={13} className="shrink-0" aria-hidden />
            {dir === "flat" ? "Sin cambios" : `${trendPct! > 0 ? "+" : ""}${formatPct(trendPct!)}`}
            <span className="truncate font-normal text-muted-foreground"> {trendLabel}</span>
          </span>
        ) : (
          <span />
        )}
        {href && (
          <Link
            href={href}
            className="inline-flex shrink-0 items-center rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Ver detalle de ${label}`}
          >
            <ChevronRight size={15} aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}
KpiTile.displayName = "KpiTile";
