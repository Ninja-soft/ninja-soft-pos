"use client";

import { Check, ShieldCheck, ShieldOff } from "lucide-react";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { formatDateAr, monthsLabel, warrantyExpiry } from "@/lib/warranty/pricing";
import type { WarrantyOption } from "@/lib/warranty/pos";

// Selector de garantía extendida (ADR-139): tarjetas comparables con el
// precio calculado para la línea, los meses que suma y hasta cuándo cubre.
// La primera tarjeta es "Sin garantía". Mismo lenguaje que la hoja de cobro:
// relleno neutro al elegir (choice-on), montos en el color de primer plano.
export function WarrantyOptionCards({
  options,
  value,
  onChange,
  quantity = 1,
  factoryMonths = 0,
  today = new Date(),
  className,
}: {
  options: WarrantyOption[];
  /** planId elegido ("" = sin garantía). */
  value: string;
  onChange: (planId: string) => void;
  quantity?: number;
  factoryMonths?: number;
  /** Fecha de referencia para el vencimiento (tests). */
  today?: Date;
  className?: string;
}) {
  const none = !options.some((o) => o.planId === value);
  return (
    <div role="radiogroup" aria-label="Garantía extendida" className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3", className)}>
      <button
        type="button"
        role="radio"
        aria-checked={none}
        onClick={() => onChange("")}
        className={choiceClass(none, "flex min-h-[84px] flex-col justify-between gap-1 rounded-lg p-3")}
      >
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <ShieldOff size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          Sin garantía
        </span>
        <span className="text-xs text-muted-foreground">
          {factoryMonths > 0 ? `Sólo la de fábrica (${monthsLabel(factoryMonths)})` : "Sin cobertura extra"}
        </span>
      </button>
      {options.map((o) => {
        const on = o.planId === value;
        const until = formatDateAr(warrantyExpiry(today, factoryMonths, o.months));
        return (
          <button
            key={o.planId}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(on ? "" : o.planId)}
            className={choiceClass(on, "flex min-h-[84px] flex-col gap-1 rounded-lg p-3")}
          >
            <span className="flex min-w-0 items-center gap-1.5 pr-5 text-[13px] font-semibold text-foreground">
              {on ? (
                <Check size={14} className="shrink-0" aria-hidden />
              ) : (
                <ShieldCheck size={14} className="shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="truncate">{o.label}</span>
            </span>
            <span className="font-price text-base font-semibold tabular-nums text-foreground">
              +{formatCurrency(o.total)}
            </span>
            <span className="text-xs leading-snug text-muted-foreground">
              +{monthsLabel(o.months)}
              {quantity > 1 ? ` · ${formatCurrency(o.unitPrice)} c/u` : ""}
            </span>
            <span className="text-xs leading-snug text-muted-foreground">Cubre hasta el {until}</span>
            {o.description && <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{o.description}</span>}
          </button>
        );
      })}
    </div>
  );
}
