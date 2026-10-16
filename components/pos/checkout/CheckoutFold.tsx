"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useCheckoutTabs, type CheckoutSideTab } from "./CheckoutTabs";

// Bloque plegable de la hoja de cobro (ADR-146), como "Propina, garantía y
// vendedor": cerrado muestra su estado en una sola línea; abierto, el
// contenido. Lo que tiene que seguir montado aunque esté cerrado (la letra
// del comprobante) va en `keep`.
//
// Con `tab` y dentro de la hoja con pestañas (ADR-157), el renglón queda en
// Pago como resumen que abre su pestaña, y el contenido (y `keep`) viven en el
// contenedor de esa pestaña.
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
  tab,
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
  /** Pestaña de la hoja de cobro donde vive el contenido. */
  tab?: CheckoutSideTab;
}) {
  const tabs = useCheckoutTabs();
  const asTab = Boolean(tab && tabs);
  const warning = tone === "warning";
  const register = tabs?.register;
  useEffect(() => {
    if (!tab || !register) return;
    return register(tab, warning);
  }, [tab, register, warning]);

  const id = `fold-${title.toLowerCase().replace(/\W+/g, "-")}`;
  const header = (
    <button
      type="button"
      onClick={asTab ? () => tabs!.setTab(tab!) : onToggle}
      aria-expanded={asTab ? undefined : open}
      aria-controls={asTab ? `checkout-panel-${tab}` : id}
      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 text-sm font-semibold">{title}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-right text-[13px]",
          warning ? "font-medium text-warning" : "text-muted-foreground",
        )}
      >
        {summary}
      </span>
      {aside && <span className="shrink-0 whitespace-nowrap text-[13px] font-medium">{aside}</span>}
      {asTab ? (
        <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <ChevronDown size={16} className={cn("shrink-0 text-muted-foreground transition", open && "rotate-180")} aria-hidden />
      )}
    </button>
  );

  if (asTab) {
    const panel = tabs!.panels[tab!];
    const active = tabs!.tab === tab;
    return (
      <section className={cn("rounded-lg border border-border bg-card", className)} aria-label={title}>
        {header}
        {/* El contenedor llega en el primer commit de la hoja: `keep` se monta
            una sola vez, ya en su pestaña (no se remonta al cambiar). */}
        {panel &&
          createPortal(
            <div className="space-y-3">
              {active && children}
              {keep}
            </div>,
            panel,
          )}
      </section>
    );
  }

  return (
    <section className={cn("rounded-lg border border-border bg-card", className)} aria-label={title}>
      {header}
      <div id={id} className={cn("space-y-3 border-t border-border px-3.5 pb-3.5 pt-3", !open && "hidden")}>
        {open && children}
        {keep}
      </div>
    </section>
  );
}
CheckoutFold.displayName = "CheckoutFold";
