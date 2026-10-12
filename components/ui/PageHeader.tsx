import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Display, Eyebrow } from "@/components/ui/Typography";

// Contenedor estándar de una pantalla del panel. Gutter de 16px en mobile,
// 24px desde sm, y aire inferior que respeta el safe area de iOS.
const SIZES = {
  md: "max-w-4xl",
  lg: "max-w-5xl",
  xl: "max-w-6xl",
  "2xl": "max-w-7xl",
} as const;

export function PageContainer({
  size = "xl",
  className,
  children,
}: {
  size?: keyof typeof SIZES;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-8",
        SIZES[size],
        className,
      )}
    >
      {children}
    </div>
  );
}
PageContainer.displayName = "PageContainer";

// Encabezado de pantalla: eyebrow + título (con ícono y ayuda opcionales),
// bajada y acciones. En mobile las acciones bajan debajo del título y
// pueden scrollear en horizontal sin romper el ancho.
export function PageHeader({
  eyebrow,
  title,
  icon: Icon,
  help,
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  icon?: LucideIcon;
  help?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 md:flex-row md:items-end md:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <Display
          className={cn(
            "flex items-center gap-2.5 text-[28px] md:text-4xl",
            eyebrow && "mt-3",
          )}
        >
          {Icon && (
            <Icon
              size={26}
              strokeWidth={2}
              className="shrink-0 text-ninja-flameSoft"
              aria-hidden
            />
          )}
          <span className="min-w-0 truncate">{title}</span>
          {help}
        </Display>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
PageHeader.displayName = "PageHeader";

// Encabezado de bloque dentro de una pantalla (estilo lista agrupada iOS).
export function SectionHeader({
  title,
  description,
  icon: Icon,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-4 gap-y-2",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold tracking-tight">
          {Icon && (
            <Icon size={18} className="shrink-0 text-ninja-flameSoft" aria-hidden />
          )}
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
SectionHeader.displayName = "SectionHeader";
