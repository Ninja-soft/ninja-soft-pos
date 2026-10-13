import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils/cn";

// Primitivos del centro de Configuración. Una sección = encabezado único
// (título + bajada + acciones) y debajo cards con filas de ajuste:
// etiqueta y ayuda a la izquierda, control a la derecha (apilado en mobile).

/** Encabezado + cuerpo de una sección de Configuración. */
export function SettingsSection({
  title,
  description,
  icon: Icon,
  actions,
  className,
  titleClassName,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  className?: string;
  /** Clases extra del título (p. ej. ocultarlo en mobile si ya lo muestra el selector). */
  titleClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2
            className={cn(
              "flex items-center gap-2.5 font-display text-xl font-bold tracking-tight sm:text-2xl",
              titleClassName,
            )}
          >
            {Icon && (
              <Icon size={20} className="shrink-0 text-ninja-flameSoft" aria-hidden />
            )}
            <span className="min-w-0 break-words">{title}</span>
          </h2>
          {description && (
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </header>
      <div className="mt-6 space-y-5">{children}</div>
    </section>
  );
}
SettingsSection.displayName = "SettingsSection";

/**
 * Card de ajustes. Con `title` muestra una cabecera con divisor. Por defecto
 * el cuerpo no tiene padding: pensado para `SettingRow` (que trae el suyo y
 * se separa con divisores). `padded` agrega el padding estándar para
 * contenido libre (listas, editores, tablas).
 */
export function SettingsCard({
  title,
  description,
  icon: Icon,
  actions,
  padded = false,
  className,
  bodyClassName,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      {title && (
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-[15px] font-semibold">
              {Icon && (
                <Icon size={16} className="shrink-0 text-ninja-flameSoft" aria-hidden />
              )}
              {title}
            </h3>
            {description && (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      <div
        className={cn(
          // Mismo padding que la cabecera y que SettingRow / SettingsNotice.
          padded ? "px-5 py-4" : "divide-y divide-border",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </Card>
  );
}
SettingsCard.displayName = "SettingsCard";

/**
 * Aviso (Callout) dentro de una `SettingsCard` sin `padded`: va como una fila
 * más, con el mismo padding que `SettingRow` (px-5 py-4), así queda alineado
 * con las etiquetas y separado parejo arriba y abajo. En cards `padded` el
 * Callout va directo (el cuerpo ya trae p-5).
 */
export function SettingsNotice({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}
SettingsNotice.displayName = "SettingsNotice";

/**
 * Fila de ajuste: etiqueta + ayuda a la izquierda, control a la derecha.
 * `stacked` pone el control debajo también en desktop (controles anchos como
 * grillas de opciones).
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  stacked = false,
  className,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  htmlFor?: string;
  stacked?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div
      className={cn(
        "grid gap-3 px-5 py-4",
        !stacked &&
          "md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-start md:gap-8",
        className,
      )}
    >
      <div className="min-w-0">
        <Label
          {...(htmlFor ? { htmlFor } : {})}
          className="block text-sm font-medium text-foreground"
        >
          {label}
        </Label>
        {description && (
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
SettingRow.displayName = "SettingRow";
