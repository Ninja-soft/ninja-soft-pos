"use client";

// F24 · H163 (ADR-177): el artículo se vende suelto o por bulto (caja, pack).
// Al tocarlo en la grilla del POS, si tiene unidades de venta activas, se
// elige con qué se vende. Mobile-first: botones grandes, uno por opción.

import { Boxes, Package } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { formatCurrency } from "@/lib/utils/format";
import { saleUnitLabel, type SaleUnit } from "@/lib/products/catalogCodes";

export interface SaleUnitChoice {
  name: string;
  /** Precio de la unidad suelta (lista de la caja). */
  unitPrice: number;
  /** Cada bulto con su precio ya calculado. */
  units: (SaleUnit & { id: string; packPrice: number })[];
}

export function SaleUnitPicker({
  choice,
  onClose,
  onUnit,
  onSaleUnit,
}: {
  choice: SaleUnitChoice | null;
  onClose: () => void;
  onUnit: () => void;
  onSaleUnit: (id: string) => void;
}) {
  return (
    <Modal
      open={choice !== null}
      onOpenChange={(o) => !o && onClose()}
      title={choice ? `¿Cómo vendés ${choice.name}?` : "Elegí la unidad"}
      className="sm:max-w-md"
    >
      {choice && (
        <div className="grid gap-2">
          <button
            type="button"
            onClick={onUnit}
            className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3 text-left transition hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Package size={18} className="shrink-0 text-muted-foreground" />
            <span className="flex-1 text-sm font-semibold">Unidad</span>
            <span className="font-mono text-sm tabular-nums">{formatCurrency(choice.unitPrice)}</span>
          </button>
          {choice.units.map((u) => {
            const full = u.units * choice.unitPrice;
            const saves = full - u.packPrice > 0.009;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onSaleUnit(u.id)}
                className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3 text-left transition hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Boxes size={18} className="shrink-0 text-muted-foreground" />
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{saleUnitLabel(u)}</span>
                  {saves && (
                    <span className="block text-xs text-muted-foreground">
                      Sueltas {formatCurrency(full)}
                    </span>
                  )}
                </span>
                <span className="font-mono text-sm tabular-nums">{formatCurrency(u.packPrice)}</span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
