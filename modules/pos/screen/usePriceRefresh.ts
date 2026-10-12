"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import { parsePriceMismatch, priceChangedMessage, repriceChanges } from "@/lib/pos/priceMismatch";
import { useCartStore, type CartLine } from "@/modules/pos/store";
import { formatCurrency } from "@/lib/utils/format";

// Precio autoritativo (F18 · H100, ADR-056). Si el servidor rechaza la venta
// por price_mismatch, el POS trae de nuevo productos y listas, reprecia las
// líneas con el precio que mandó el servidor y avisa "El precio de X cambió a
// $Y". El cobro no se reintenta solo: el total cambió y el cajero lo confirma.

export function usePriceRefresh() {
  const qc = useQueryClient();
  const { toast } = useToast();

  /** true si el error era de precio (ya avisado); false si no lo era. */
  return function handlePriceMismatch(err: unknown, lines: CartLine[]): boolean {
    const mismatches = parsePriceMismatch(err);
    if (!mismatches) return false;
    const changes = repriceChanges(lines, mismatches);
    if (changes.length > 0) useCartStore.getState().applyServerPrices(changes);
    void qc.invalidateQueries({ queryKey: ["products"] });
    void qc.invalidateQueries({ queryKey: ["price-lists"] });
    toast({
      title: priceChangedMessage(changes, formatCurrency),
      description: "Revisá el total y volvé a cobrar.",
      variant: "info",
    });
    return true;
  };
}
