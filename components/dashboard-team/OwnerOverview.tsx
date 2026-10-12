import Link from "next/link";
import type { Route } from "next";
import { ChevronRight, Lock, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { NoData } from "@/components/ui/NoData";
import { cn } from "@/lib/utils/cn";

// Piezas del resumen del Panel del dueño (server-safe, sin estado).

// Etiqueta chica en mayúsculas para encabezar cada tile del resumen.
function TileLabel({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      <Icon size={14} className="shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

export function SummaryTile({
  icon,
  label,
  className,
  children,
}: {
  icon: LucideIcon;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("flex flex-col p-5", className)}>
      <TileLabel icon={icon}>{label}</TileLabel>
      <div className="mt-3 flex flex-1 flex-col">{children}</div>
    </Card>
  );
}
SummaryTile.displayName = "SummaryTile";

// Línea de uso de un límite del plan: "3 de 5" con barra. limit null = ilimitado.
export function UsageMeter({
  label,
  used,
  limit,
}: {
  label: string;
  used: number | null;
  limit: number | null;
}) {
  const unlimited = limit == null;
  const pct = !unlimited && limit > 0 && used != null ? Math.min(100, (used / limit) * 100) : 0;
  const tone =
    unlimited || used == null
      ? "bg-foreground/50"
      : pct >= 100
        ? "bg-danger"
        : pct >= 80
          ? "bg-warning"
          : "bg-foreground/60";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-semibold text-foreground">
          {used == null ? <NoData /> : used.toLocaleString("es-AR")}
          <span className="font-normal text-muted-foreground">
            {unlimited ? " · sin límite" : ` de ${limit.toLocaleString("es-AR")}`}
          </span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn("h-full rounded-full", tone)}
          style={{ width: unlimited ? "100%" : `${pct}%`, opacity: unlimited ? 0.25 : 1 }}
        />
      </div>
    </div>
  );
}
UsageMeter.displayName = "UsageMeter";

export type QuickAction = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  locked?: boolean;
};

// Grilla de accesos rápidos: tiles neutros con ícono, título y bajada.
export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {actions.map((a) => {
        const Icon = a.icon;
        return (
          <li key={a.href + a.title}>
            <Link
              href={a.href as Route}
              className="group flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-3.5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-ninja-flameSoft">
                  <Icon size={18} aria-hidden />
                </span>
                {a.locked ? (
                  <Badge tone="neutral" className="px-2 text-[11px]">
                    <Lock size={11} aria-hidden /> Plan superior
                  </Badge>
                ) : (
                  <ChevronRight
                    size={16}
                    className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                )}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold leading-snug text-foreground">{a.title}</span>
                <span className="mt-1 hidden text-sm text-muted-foreground sm:block">
                  {a.description}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
QuickActions.displayName = "QuickActions";

export const STATUS_TONE: Record<string, BadgeTone> = {
  trial: "info",
  active: "success",
  past_due: "warning",
  suspended: "danger",
  cancelled: "danger",
};
