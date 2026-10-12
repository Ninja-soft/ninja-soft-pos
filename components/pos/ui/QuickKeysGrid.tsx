"use client";

import { Star } from "lucide-react";
import type { Product } from "@/modules/products/api";
import { cn } from "@/lib/utils/cn";
import type { ResolvedQuickKey } from "../screen/types";
import { POS_EYEBROW, POS_TILE, QUICK_KEY_DOT, money } from "./posStyles";

// Teclas rápidas del POS (pos_layout.quickKeys) o, si el negocio no armó
// ninguna, sus productos favoritos (H36). Tap = agrega 1 (o abre serial /
// variante / peso). Las cantidades rápidas (×2 ×6 ×12, ½ y 1 kg) suman de un
// toque sin teclear. El color elegido por el dueño es una barrita de acento
// sobre el tile neutro, no un relleno.
const QUICK_UNITS = [2, 6, 12] as const;
const QUICK_WEIGHTS = [
  { label: "½ kg", kg: 0.5 },
  { label: "1 kg", kg: 1 },
];

const quick =
  "flex h-8 flex-1 items-center justify-center rounded-md text-xs font-semibold tabular-nums text-muted-foreground transition-colors hover:bg-fg-10 hover:text-foreground [@media(pointer:coarse)]:h-10";

export function QuickKeysGrid({
  keys,
  title = "Teclas rápidas",
  minWidth = 150,
  onTap,
  onQuickUnits,
  onQuickWeight,
}: {
  keys: ResolvedQuickKey[];
  title?: string;
  minWidth?: number;
  onTap: (p: Product) => void;
  onQuickUnits: (p: Product, qty: number) => void;
  onQuickWeight: (p: Product, kg: number) => void;
}) {
  if (keys.length === 0) return null;
  return (
    <section aria-label={title}>
      <h2 className={cn("mb-2 flex items-center gap-1.5", POS_EYEBROW)}>
        <Star size={12} aria-hidden /> {title}
      </h2>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${minWidth}px, calc(50% - 4px)), 1fr))` }}
      >
        {keys.map(({ product: p, label, color }) => {
          const byWeight = p.unit === "kg";
          const simpleUnit = !byWeight && !p.is_serialized && !p.has_variants;
          const dot = color ? QUICK_KEY_DOT[color] : undefined;
          return (
            <div
              key={p.id}
              className={cn(POS_TILE, "relative flex flex-col overflow-hidden hover:bg-card active:scale-100")}
            >
              {dot && (
                <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: dot }} />
              )}
              <button
                type="button"
                onClick={() => onTap(p)}
                className="flex min-h-[76px] flex-1 flex-col justify-between gap-2 px-3 pb-2 pt-2.5 text-left transition-colors hover:bg-fg-4"
              >
                <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-foreground">
                  {label || p.name}
                </span>
                <span className="font-price text-[15px] font-semibold leading-none tabular-nums">
                  {money(p.price)}
                  {byWeight && <span className="ml-0.5 text-xs font-medium text-muted-foreground">/kg</span>}
                </span>
              </button>
              {(simpleUnit || byWeight) && (
                <div className="flex gap-0.5 border-t border-border p-1">
                  {simpleUnit &&
                    QUICK_UNITS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => onQuickUnits(p, q)}
                        aria-label={`Agregar ${q} de ${p.name}`}
                        className={quick}
                      >
                        ×{q}
                      </button>
                    ))}
                  {byWeight &&
                    QUICK_WEIGHTS.map((w) => (
                      <button
                        key={w.label}
                        type="button"
                        onClick={() => onQuickWeight(p, w.kg)}
                        aria-label={`Agregar ${w.label} de ${p.name}`}
                        className={quick}
                      >
                        {w.label}
                      </button>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
