"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Bloque plegable de la hoja de cobro (ADR-146), como "Propina, garantía y
// vendedor": cerrado muestra su estado en una sola línea; abierto, el
// contenido. Lo que tiene que seguir montado aunque esté cerrado (la letra
// del comprobante) va en `keep`.
export function CheckoutFold({
  icon: Icon,
  title,
  summary,
  aside,
  tone,
  open,
  onToggle,
  children,
  keep,
  className,
}: {
  icon: LucideIcon;
  title: string;
  summary: string;
  /** Dato corto que nunca se corta (p. ej. "Factura A"), a la derecha del resumen. */
  aside?: string | null;
  tone?: "warning";
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  keep?: React.ReactNode;
  className?: string;
}) {
  const id = `fold-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section className={cn("rounded-lg border border-border bg-card", className)} aria-label={title}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 text-sm font-semibold">{title}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-right text-[13px]",
            tone === "warning" ? "font-medium text-warning" : "text-muted-foreground",
          )}
        >
          {summary}
        </span>
        {aside && <span className="shrink-0 whitespace-nowrap text-[13px] font-medium">{aside}</span>}
        <ChevronDown size={16} className={cn("shrink-0 text-muted-foreground transition", open && "rotate-180")} aria-hidden />
      </button>
      <div id={id} className={cn("space-y-3 border-t border-border px-3.5 pb-3.5 pt-3", !open && "hidden")}>
        {open && children}
        {keep}
      </div>
    </section>
  );
}
CheckoutFold.displayName = "CheckoutFold";
