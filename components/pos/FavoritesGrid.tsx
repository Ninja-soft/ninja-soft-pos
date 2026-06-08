"use client";

import { Star } from "lucide-react";
import type { Product } from "@/modules/products/api";
import { formatCurrency } from "@/lib/utils/format";

// Cantidades rápidas para productos por unidad (H36): el cajero suma de un toque
// sin teclear. Para productos por peso se ofrecen ½ kg / 1 kg.
const QUICK_UNITS = [2, 6, 12] as const;
const QUICK_WEIGHTS: { label: string; kg: number }[] = [
  { label: "½ kg", kg: 0.5 },
  { label: "1 kg", kg: 1 },
];

interface Props {
  products: Product[];
  // Tap del botón: agrega 1 (o abre el picker de serial/variante/peso según el
  // tipo). Reusa pickProduct de la página, que ya resuelve precio y ruta.
  onTap: (p: Product) => void;
  // Cantidad rápida para un producto por unidad simple (sin variantes/serial).
  onQuickUnits: (p: Product, qty: number) => void;
  // Peso rápido (½ kg / 1 kg) para un producto por peso.
  onQuickWeight: (p: Product, kg: number) => void;
}

// Grilla táctil de favoritos: botones grandes, alto contraste, mobile/tablet-first.
// Pensada para catálogo chico (heladerías, cafeterías, servicios, mostrador):
// tocar 2-3 botones y cobrar, sin búsqueda.
export function FavoritesGrid({ products, onTap, onQuickUnits, onQuickWeight }: Props) {
  if (products.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Star size={13} className="fill-ninja-flameSoft text-ninja-flameSoft" /> Favoritos
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {products.map((p) => {
          const byWeight = p.unit === "kg";
          // Sólo productos simples por unidad muestran cantidades rápidas: los
          // serializados o con variantes necesitan elegir serial/variante antes.
          const simpleUnit = !byWeight && !p.is_serialized && !p.has_variants;
          return (
            <div
              key={p.id}
              className="flex flex-col overflow-hidden rounded-xl border-2 border-ninja-flameSoft/40 bg-ninja-flame/5"
            >
              <button
                type="button"
                onClick={() => onTap(p)}
                title={`Agregar ${p.name}`}
                className="flex min-h-[88px] flex-1 flex-col justify-between gap-1 p-4 text-left transition active:scale-[0.98] hover:bg-ninja-flame/10"
              >
                <div className="flex items-start justify-between gap-1.5">
                  <span className="line-clamp-2 text-base font-semibold leading-tight text-foreground">
                    {p.name}
                  </span>
                  {p.has_variants && (
                    <span className="shrink-0 rounded-full bg-ninja-flame/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ninja-flameSoft">
                      Variantes
                    </span>
                  )}
                </div>
                <span className="text-lg font-bold tabular-nums text-foreground">
                  {formatCurrency(p.price)}
                  {byWeight && (
                    <span className="text-xs font-normal text-muted-foreground"> /kg</span>
                  )}
                </span>
              </button>

              {/* Cantidades rápidas: por unidad (+2/x6/x12) o por peso (½/1 kg). */}
              {(simpleUnit || byWeight) && (
                <div className="flex flex-wrap gap-1 border-t border-ninja-flameSoft/20 bg-background/40 p-1.5">
                  {simpleUnit &&
                    QUICK_UNITS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => onQuickUnits(p, q)}
                        title={`Agregar ${q} unidades`}
                        className="min-w-[2.5rem] flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-sm font-semibold text-foreground transition active:scale-95 hover:border-ninja-flameSoft/50 hover:bg-muted"
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
                        title={`Agregar ${w.label}`}
                        className="min-w-[2.5rem] flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-sm font-semibold text-foreground transition active:scale-95 hover:border-ninja-flameSoft/50 hover:bg-muted"
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
    </div>
  );
}
