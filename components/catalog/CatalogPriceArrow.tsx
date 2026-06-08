"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  comparePriceToReference,
  type PriceReference,
} from "@/modules/catalog/priceReference";

// CatalogPriceArrow — flecha discreta junto al precio que indica si MI precio
// está por encima (roja ↑) o por debajo (verde ↓) del precio de referencia del
// catálogo (principales competidores). Neutro (–) si es prácticamente igual.
// Al pasar el mouse muestra el detalle: % y aclaración de que es orientativo.
//
// Información meramente informativa para evaluar tendencias del mercado, no
// vinculante. No se renderiza nada si no hay referencia para el EAN.

export function CatalogPriceArrow({
  myPrice,
  reference,
  className,
}: {
  myPrice: number;
  reference: PriceReference | undefined | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const cmp = comparePriceToReference(myPrice, reference);
  if (!cmp) return null;

  const pct = cmp.diffPct;
  const pctText = pct.toLocaleString("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });

  const Icon =
    cmp.direction === "below"
      ? ArrowDownRight
      : cmp.direction === "above"
        ? ArrowUpRight
        : Minus;

  // Verde = más barato que el mercado (ventaja). Rojo = más caro. Neutro = igual.
  const color =
    cmp.direction === "below"
      ? "text-emerald-400"
      : cmp.direction === "above"
        ? "text-red-400"
        : "text-muted-foreground";

  // Frase principal del tooltip según la dirección.
  const headline =
    cmp.direction === "equal"
      ? "Tu precio está alineado con el catálogo de referencia."
      : `Tu precio está ${pctText}% por ${
          cmp.direction === "below" ? "debajo" : "encima"
        } del catálogo de referencia.`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Comparación con el catálogo de referencia"
          onClick={(e) => e.preventDefault()}
          onMouseEnter={() => setOpen(true)}
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded p-0.5 align-middle transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            color,
            className,
          )}
        >
          <Icon size={15} aria-hidden strokeWidth={2.5} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="center"
          sideOffset={6}
          avoidCollisions
          collisionPadding={12}
          onMouseLeave={() => setOpen(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-[60] w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-ninjaSoft backdrop-blur-xl data-[state=open]:animate-fade-in"
        >
          <div className="space-y-1.5 text-xs leading-relaxed">
            <p className="font-medium text-foreground">{headline}</p>
            <p className="text-muted-foreground">
              Referencia de mercado:{" "}
              <span className="font-medium text-foreground">
                {formatCurrency(cmp.referencePrice)}
              </span>
              {reference && reference.storeCount > 1
                ? ` · ${reference.storeCount} tiendas`
                : ""}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Información orientativa de mercado, no vinculante.
            </p>
          </div>
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
