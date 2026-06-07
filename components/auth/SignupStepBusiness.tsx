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
      <h3 className="font-sans text-xl font-bold tracking-[-0.01em] text-ninja-softWhite">
        ¿Qué tipo de negocio tenés?
      </h3>
      <p className="mt-1 text-sm text-ninja-lavender">
        Adaptamos el POS a tu actividad. Podés cambiarlo después.
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
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
                "flex items-start gap-3 rounded-xl border bg-white/[0.03] p-3.5 text-left transition",
                active
                  ? "border-ninja-flame ring-2 ring-ninja-flame/40"
                  : "border-white/10 hover:border-ninja-flameSoft/50 hover:bg-white/[0.06]",
              )}
            >
              <span
                className={cn(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-lg transition",
                  active
                    ? "bg-ninja-flame/20 text-ninja-flameSoft"
                    : "bg-white/5 text-ninja-lavender",
                )}
              >
                <Icon size={18} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ninja-softWhite">
                  {VERTICAL_LABELS[v]}
                </p>
                <p className="mt-0.5 text-xs text-ninja-lavender">
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
