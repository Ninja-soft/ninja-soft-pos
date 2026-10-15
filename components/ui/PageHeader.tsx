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

// Fila de acciones de un encabezado. En mobile va en una sola fila con scroll
// horizontal (sin scrollbar visible, botones sin encoger y 4px de aire para que
// el anillo de foco no se corte); desde sm vuelve al wrap de siempre. Usala en
// cualquier encabezado propio que no pase por PageHeader / SectionHeader.
export const headerActionsRow =
  "-m-1 flex min-w-0 max-w-[calc(100%+0.5rem)] flex-nowrap items-center gap-2 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 sm:m-0 sm:max-w-full sm:flex-wrap sm:overflow-visible sm:p-0";

// Encabezado de pantalla: eyebrow + título (con ícono y ayuda opcionales),
// bajada y acciones. El título se ve siempre completo (nunca se trunca, si no
// entra pasa a otra línea) y las acciones van siempre en su propia fila debajo,
// alineadas a la izquierda: en mobile en una fila con scroll lateral, desde sm
// con wrap.
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
        "flex flex-col gap-4",
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
          <span className="min-w-0 break-words">{title}</span>
          {help}
        </Display>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className={headerActionsRow}>{actions}</div>
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
      {actions && <div className={headerActionsRow}>{actions}</div>}
    </div>
  );
}
SectionHeader.displayName = "SectionHeader";
