"use client";

import { Star } from "lucide-react";
import type { Product } from "@/modules/products/api";
import { cn } from "@/lib/utils/cn";
import type { ResolvedQuickKey } from "../screen/types";
import { QUICK_KEY_FILL, money } from "./posStyles";

// Teclas rápidas del POS (pos_layout.quickKeys) o, si el negocio no armó
// ninguna, sus productos favoritos (H36). Tap = agrega 1 (o abre serial /
// variante / peso). Las cantidades rápidas (×2 ×6 ×12, ½ y 1 kg) suman de un
// toque sin teclear.
const QUICK_UNITS = [2, 6, 12] as const;
const QUICK_WEIGHTS = [
  { label: "½ kg", kg: 0.5 },
  { label: "1 kg", kg: 1 },
];

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
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <Star size={12} className="fill-current" /> {title}
      </h2>
      <div
        className="grid gap-2.5"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))` }}
      >
        {keys.map(({ product: p, label, color }) => {
          const byWeight = p.unit === "kg";
          const simpleUnit = !byWeight && !p.is_serialized && !p.has_variants;
          const fill = color ? QUICK_KEY_FILL[color] : null;
          return (
            <div
              key={p.id}
              className={cn(
                "flex flex-col overflow-hidden rounded-2xl",
                fill ?? "bg-[color-mix(in_srgb,var(--pos-from)_14%,var(--card))] text-foreground",
              )}
            >
              <button
                type="button"
                onClick={() => onTap(p)}
                className="flex min-h-[84px] flex-1 flex-col justify-between gap-1 p-3 text-left transition active:scale-[0.97]"
              >
                <span className="line-clamp-2 text-sm font-bold leading-tight">{label || p.name}</span>
                <span className="font-price text-base font-black tabular-nums">
                  {money(p.price)}
                  {byWeight && <span className="text-xs font-semibold opacity-70"> /kg</span>}
                </span>
              </button>
              {(simpleUnit || byWeight) && (
                <div className="flex gap-1 bg-black/10 p-1">
                  {simpleUnit &&
                    QUICK_UNITS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => onQuickUnits(p, q)}
                        aria-label={`Agregar ${q} de ${p.name}`}
                        className="flex-1 rounded-lg py-1 text-xs font-bold transition hover:bg-white/15 active:scale-95"
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
                        className="flex-1 rounded-lg py-1 text-xs font-bold transition hover:bg-white/15 active:scale-95"
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
