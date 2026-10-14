// Piezas comunes de la pestaña Catálogos del panel interno: encabezado de
// sección, KPI, chips de estado y formatos. Sin gradientes, sombras ni bordes
// laterales de color; sólo tokens del tema.
import type { LucideIcon } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import type { SyncRun } from "@/modules/internal/catalogSync";
import { cn } from "@/lib/utils/cn";

export const fmtNum = (n: number) => n.toLocaleString("es-AR");

const TZ = "America/Argentina/Buenos_Aires";

export const fmtDateTime = (d: string | Date | null) =>
  d
    ? new Date(d).toLocaleString("es-AR", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: TZ,
      })
    : "";

export const fmtDay = (d: string | Date | null) =>
  d ? new Date(d).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }) : "";

/** "hace 5 min", "hace 3 h", "hace 2 días". */
export function fmtAgo(d: string | Date | null, now: Date = new Date()): string {
  if (!d) return "";
  const s = Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 1000));
  if (s < 60) return "recién";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

/** Duración corta: "40 s", "12 min", "3 h 05 min". */
export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function SectionHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Icon size={18} className="text-muted-foreground" aria-hidden /> {title}
        </h2>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  loading,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-card p-4", className)} aria-busy={loading || undefined}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon && <Icon size={14} aria-hidden />}
        <span className="truncate">{label}</span>
      </div>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-7 w-24" />
          <Skeleton className="mt-2 h-3 w-32" />
        </>
      ) : (
        <>
          <div className="mt-1 truncate text-2xl font-semibold tabular-nums text-foreground">{value}</div>
          {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>}
        </>
      )}
    </div>
  );
}

export function runStatus(run: SyncRun): { label: string; tone: BadgeTone } {
  if (run.status === "running") return run.pausedAt ? { label: "Pausada", tone: "warning" } : { label: "En curso", tone: "info" };
  if (run.status === "ok") return { label: "OK", tone: "success" };
  if (run.status === "partial") return { label: "Con errores", tone: "warning" };
  if (run.status === "cancelled") return { label: "Cancelada", tone: "neutral" };
  return { label: "Falló", tone: "danger" };
}

export function RunStatusChip({ run }: { run: SyncRun }) {
  const s = runStatus(run);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function runKindLabel(run: SyncRun) {
  if (run.mode === "mixed") return "Mixta";
  if (run.mode === "full" || (!run.mode && run.forceFull)) return "Completa";
  return "Sólo cambios";
}

/** Barra de progreso; pct null = indeterminada (pulso suave). */
export function ProgressBar({
  pct,
  tone = "brand",
  className,
  label,
}: {
  pct: number | null;
  tone?: "brand" | "success" | "danger" | "muted";
  className?: string;
  label?: string;
}) {
  const fill =
    tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : tone === "muted" ? "bg-muted-foreground/40" : "bg-ninja-flame";
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
    >
      {pct === null ? (
        <div className={cn("h-full w-2/5 rounded-full motion-safe:animate-pulse", fill)} />
      ) : (
        <div className={cn("h-full rounded-full transition-all", fill)} style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}
