import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils/cn";

// Tarjeta del panel interno › Complementos: ícono en baldosa, título con su
// estado, subtítulo, descripción, bloque de datos con fondo y acciones abajo.
// La usan el catálogo de complementos y los servicios de la plataforma
// (certificado de ARCA) para que se vean iguales.
export function CatalogCard({
  icon: Icon,
  title,
  badge,
  subtitle,
  description,
  stats,
  actions,
  className,
}: {
  icon: LucideIcon;
  title: string;
  badge?: React.ReactNode;
  /** Línea chica bajo el título (clave, CUIT…). */
  subtitle?: React.ReactNode;
  description?: React.ReactNode;
  /** `CatalogStat`s; van en un bloque con fondo de 2 columnas. */
  stats?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-w-0 flex-col p-4 sm:p-5", className)}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ninja-flame/10 text-ninja-flameSoft"
        >
          <Icon size={20} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-base font-bold tracking-tight text-foreground">{title}</h3>
            {badge}
          </div>
          {subtitle && <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>

      {description && <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">{description}</p>}

      {stats && <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3">{stats}</dl>}

      {actions && <div className="mt-4 flex flex-1 flex-wrap items-end gap-2">{actions}</div>}
    </Card>
  );
}
CatalogCard.displayName = "CatalogCard";

export function CatalogStat({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-base font-semibold tabular-nums text-foreground">{value}</dd>
      {sub && <dd className="truncate text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}
CatalogStat.displayName = "CatalogStat";

export function CatalogCardSkeleton() {
  return (
    <Card className="p-4 sm:p-5" aria-busy="true">
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="mt-4 h-10 w-full" />
      <Skeleton className="mt-4 h-16 w-full rounded-lg" />
      <Skeleton className="mt-4 h-9 w-28" />
    </Card>
  );
}
