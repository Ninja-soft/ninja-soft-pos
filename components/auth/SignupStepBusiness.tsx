"use client";

import {
  Store,
  Shirt,
  ShoppingBag,
  UtensilsCrossed,
  IceCream2,
  Coffee,
  Croissant,
  Scissors,
  Sparkles,
  Briefcase,
  Building2,
  Boxes,
  type LucideIcon,
} from "lucide-react";
import {
  VERTICALS,
  VERTICAL_LABELS,
  VERTICAL_DESCRIPTIONS,
  type Vertical,
} from "@/lib/verticals/config";
import { cn } from "@/lib/utils/cn";

const VERTICAL_ICONS: Record<Vertical, LucideIcon> = {
  kiosco: Store,
  textil: Shirt,
  retail: ShoppingBag,
  restaurante: UtensilsCrossed,
  heladeria: IceCream2,
  cafeteria: Coffee,
  panaderia: Croissant,
  peluqueria: Scissors,
  estetica: Sparkles,
  servicios: Briefcase,
  pyme: Building2,
  otro: Boxes,
};

export function SignupStepBusiness({
  value,
  onChange,
}: {
  value: Vertical | null;
  onChange: (v: Vertical) => void;
}) {
  return (
    <div>
      <h3 className="font-sans text-xl font-bold tracking-[-0.01em] text-foreground">
        ¿Qué tipo de negocio tenés?
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Adaptamos el POS a tu actividad. Podés cambiarlo después.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {VERTICALS.map((v) => {
          const Icon = VERTICAL_ICONS[v];
          const active = value === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onChange(v)}
              aria-pressed={active}
              className={cn(
                "flex items-start gap-3 rounded-lg border bg-muted p-3 pr-7 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                active
                  ? "choice-on choice-check"
                  : "border-border hover:bg-secondary",
              )}
            >
              <span
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-md transition",
                  active
                    ? "bg-background text-ninja-flameSoft"
                    : "bg-background text-muted-foreground",
                )}
              >
                <Icon size={16} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-snug text-foreground">
                  {VERTICAL_LABELS[v]}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  {VERTICAL_DESCRIPTIONS[v]}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
