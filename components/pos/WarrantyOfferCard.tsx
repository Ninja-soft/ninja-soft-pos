"use client";

import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";
import { lineSubtotal, type CartLine } from "@/modules/pos/store";
import type { WarrantyPlan } from "@/modules/products/api";

// Prima de un plan, IGUAL que PaymentModal (única fuente de verdad del cobro):
// % del total de la venta (base) si price_pct > 0; si no, la prima fija.
// Mantener en sincronía con components/pos/PosModals.tsx (PaymentModal).
function planPrima(plan: WarrantyPlan, base: number): number {
  return Number(plan.price_pct) > 0
    ? Math.round(((base * Number(plan.price_pct)) / 100) * 100) / 100
    : Number(plan.price);
}

// Oferta CONTEXTUAL automática de garantía extendida (H28).
//
// Cuando el carrito tiene un producto con garantía de fábrica declarada
// (`warrantyMonths > 0`), el POS ofrece automáticamente los planes de garantía
// extendida del tenant para ese producto, sin que el cajero los busque. Al
// elegir un plan se PRE-SELECCIONA la garantía para el cobro: la prima entra
// como línea de la venta a través del mecanismo existente (PaymentModal +
// extras kind:'warranty'). Este componente NO cobra nada por sí mismo: solo
// pre-selecciona el plan; PaymentModal sigue siendo la única fuente del cobro.
//
// Aplicabilidad (honesta con el modelo actual): los planes son por tenant (no
// hay scoping por categoría/producto), así que un producto con garantía de
// fábrica habilita los planes del tenant. La detección es por producto; si hay
// varios elegibles se ofrece sobre el más relevante (mayor importe de línea).
export function WarrantyOfferCard({
  lines,
  plans,
  base,
  selectedWarrantyId,
  onSelect,
}: {
  lines: CartLine[];
  plans: WarrantyPlan[];
  base: number;
  selectedWarrantyId: string;
  onSelect: (warrantyId: string) => void;
}) {
  // Producto elegible más relevante: el de mayor importe de línea con garantía
  // de fábrica declarada. La garantía extendida pesa más sobre el ticket caro.
  const eligible = useMemo(() => {
    const withWarranty = lines.filter((l) => (l.warrantyMonths ?? 0) > 0);
    if (withWarranty.length === 0) return null;
    return withWarranty.reduce((best, l) =>
      lineSubtotal(l) > lineSubtotal(best) ? l : best,
    );
  }, [lines]);

  const activePlans = useMemo(
    () => (plans ?? []).filter((p) => p.is_active),
    [plans],
  );

  // Descartable por el cajero (no frena la venta). Se vuelve a mostrar cuando
  // cambia el producto elegible (otra venta / otro producto en el carrito).
  const [dismissed, setDismissed] = useState(false);
  const eligibleKey = eligible?.lineId ?? null;
  useEffect(() => {
    setDismissed(false);
  }, [eligibleKey]);

  // No hay producto elegible, no hay planes, o el cajero la descartó → nada.
  if (!eligible || activePlans.length === 0 || dismissed) return null;

  return (
    <div className="rounded-lg border border-ninja-flameSoft/40 bg-ninja-flame/[0.06] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              Ofrecé garantía extendida
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">{eligible.name}</span>{" "}
              tiene {eligible.warrantyMonths} {eligible.warrantyMonths === 1 ? "mes" : "meses"} de
              garantía de fábrica. Sumá una garantía extendida en un click.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Descartar oferta de garantía"
          title="Descartar"
          className="shrink-0 text-muted-foreground transition hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>

      <div className="mt-2.5 space-y-1.5">
        {activePlans.map((p) => {
          const selected = selectedWarrantyId === p.id;
          const prima = planPrima(p, base);
          return (
            <button
              key={p.id}
              type="button"
              // Toggle: re-clic deselecciona. La selección viaja a PaymentModal.
              onClick={() => onSelect(selected ? "" : p.id)}
              className={
                selected
                  ? "flex w-full items-center justify-between gap-2 rounded-lg border border-ninja-flame bg-ninja-flame/10 px-3 py-2 text-left"
                  : "flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left transition hover:border-ninja-flameSoft/50"
              }
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  {selected && <Check size={14} className="shrink-0 text-ninja-flameSoft" />}
                  {p.label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  +{p.months} {p.months === 1 ? "mes" : "meses"}
                  {Number(p.price_pct) > 0 ? ` · ${Number(p.price_pct)}% del total` : ""}
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold text-foreground">
                +{formatCurrency(prima)}
              </span>
            </button>
          );
        })}
      </div>

      {selectedWarrantyId && (
        <p className="mt-2 text-xs text-ninja-flameSoft">
          Garantía agregada. Se cobra como línea al confirmar la venta.
        </p>
      )}
    </div>
  );
}
