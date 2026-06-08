"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { SECTION_INFO } from "@/lib/pos/sectionInfo";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

// InfoHint — ícono "i" discreto que abre un Popover con ayuda contextual.
//
// Pensado para el encabezado de cada sección del POS, pero genérico:
//   - <InfoHint section="ventas" />            → usa el copy de SECTION_INFO.
//   - <InfoHint title="…">contenido</InfoHint> → contenido libre.
//
// Accesible (aria-label en el trigger) y mobile-friendly: el Popover de Radix
// abre/cierra al click/tap; además lo abrimos al hover en desktop para que sea
// inmediato con mouse. Estética ninja (tokens del tema oscuro, acento flame).

type InfoHintProps = {
  /** Key de SECTION_INFO (pos, ventas, productos, …). Define el contenido por defecto. */
  section?: string;
  /** Título del popover. Si se omite, se toma de la sección. */
  title?: string;
  /** Contenido libre; si se pasa, reemplaza al copy de la sección. */
  children?: React.ReactNode;
  /** Lado preferido del popover. */
  side?: "top" | "right" | "bottom" | "left";
  /** Alineación del popover respecto al trigger. */
  align?: "start" | "center" | "end";
  /** aria-label del botón (default: "Más información"). */
  label?: string;
  /** Tamaño del ícono en px. */
  size?: number;
  className?: string;
};

export function InfoHint({
  section,
  title,
  children,
  side = "bottom",
  align = "start",
  label = "Más información",
  size = 16,
  className,
}: InfoHintProps) {
  const [open, setOpen] = useState(false);
  const info = section ? SECTION_INFO[section] : undefined;
  const heading = title ?? info?.title;
  // Plan mínimo (solo si la sección referencia una feature de plan real).
  const minPlan = info?.feature ? FEATURE_INFO[info.feature]?.minPlan : undefined;

  // Si no hay contenido libre ni copy de sección, no renderizamos nada.
  if (!children && !info) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(e) => e.preventDefault()}
          onMouseEnter={() => setOpen(true)}
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full p-0.5 text-muted-foreground transition hover:text-ninja-flameSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Info size={size} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={6}
          avoidCollisions
          collisionPadding={12}
          onMouseLeave={() => setOpen(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
          // Animación SOLO de opacidad (fade-in): el popover aparece directo en
          // la posición que calcula Radix, sin salto. `animate-modal-in` no sirve
          // acá porque su keyframe fuerza `translate(-50%,-50%)` (pensado para un
          // modal centrado) y pisa el transform con el que Radix posiciona el
          // contenido: se veía en un lugar y al terminar la animación saltaba.
          className="z-[60] w-72 rounded-lg border border-border bg-popover p-3.5 text-popover-foreground shadow-ninjaSoft backdrop-blur-xl data-[state=open]:animate-fade-in"
        >
          {children ? (
            <div className="text-xs leading-relaxed text-foreground">{children}</div>
          ) : (
            info && (
              <div className="space-y-2 text-xs leading-relaxed">
                {heading && (
                  <p className="font-display text-sm font-bold text-foreground">
                    {heading}
                  </p>
                )}
                <p className="text-foreground">{info.what}</p>
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">Te permite: </span>
                  {info.enables}
                </p>
                {info.tip && (
                  <p className="text-muted-foreground">
                    <span className="font-semibold text-ninja-flameSoft">Tip: </span>
                    {info.tip}
                  </p>
                )}
                {minPlan && (
                  <p className="text-[11px] uppercase tracking-wide text-ninja-flameSoft">
                    Desde plan: {minPlan}
                  </p>
                )}
              </div>
            )
          )}
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
