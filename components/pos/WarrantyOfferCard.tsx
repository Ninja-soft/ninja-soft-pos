"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import type { WarrantyTarget } from "@/lib/warranty/pos";
import { WarrantyOptionCards } from "./WarrantyOptionCards";

// Oferta CONTEXTUAL automática de garantía extendida (H28, ADR-139).
//
// Cuando el carrito tiene un producto alcanzado por algún tipo de garantía
// (todos, su categoría o el producto puntual), el POS la ofrece sin que el
// cajero la busque, con el precio calculado para ESA línea. Elegir una opción
// sólo la PRE-SELECCIONA para la hoja de cobro, que es la única que cobra; el
// servidor vuelve a calcular el precio al enlazarla.
//
// Se ofrece sobre la primera línea elegible (con serie primero, después la de
// mayor importe); en la hoja de cobro se puede cambiar el producto cubierto.
export function WarrantyOfferCard({
  targets,
  selectedWarrantyId,
  onSelect,
}: {
  targets: WarrantyTarget[];
  selectedWarrantyId: string;
  onSelect: (warrantyId: string) => void;
}) {
  const target = targets[0] ?? null;

  // Descartable por el cajero (no frena la venta). Vuelve cuando cambia el
  // producto elegible.
  const [dismissed, setDismissed] = useState(false);
  const key = target?.lineId ?? null;
  useEffect(() => {
    setDismissed(false);
  }, [key]);

  if (!target || dismissed) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Ofrecé garantía extendida</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              Para <span className="font-medium text-foreground">{target.label}</span>
              {target.factoryMonths > 0
                ? `, que trae ${target.factoryMonths} ${target.factoryMonths === 1 ? "mes" : "meses"} de fábrica`
                : ""}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Descartar oferta de garantía"
          title="Descartar"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>

      <WarrantyOptionCards
        className="mt-2.5"
        options={target.options}
        value={selectedWarrantyId}
        onChange={onSelect}
        quantity={target.quantity}
        factoryMonths={target.factoryMonths}
      />

      {selectedWarrantyId && target.options.some((o) => o.planId === selectedWarrantyId) && (
        <p className="mt-2 text-xs text-muted-foreground">Garantía agregada. Se cobra como línea al confirmar la venta.</p>
      )}
    </div>
  );
}
