"use client";

// Buscador de productos para Compras: nombre, SKU, EAN o PLU, lector de códigos
// y elección de variante (ProductSearchCombobox). Los kits no se compran (se
// compran sus componentes).

import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";
import type { Product, ProductVariant } from "@/modules/products/api";
import { isPurchasable } from "@/lib/products/catalogCodes";

// H163: lo de sólo venta tampoco se compra.
const purchasable = (p: Product) => !p.is_kit && isPurchasable(p);

export function ProductPicker({
  onPick,
  enabled = true,
  placeholder = "Buscá por nombre, SKU o código",
  autoFocus = true,
}: {
  onPick: (p: Product, v: ProductVariant | null) => void;
  enabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <ProductSearchCombobox
      onPick={onPick}
      enabled={enabled}
      placeholder={placeholder}
      autoFocus={autoFocus}
      filter={purchasable}
      rejectMessage={(p) => (p.is_kit ? `${p.name} es un kit: comprá sus componentes` : `${p.name} es sólo de venta: no se compra`)}
      emptyHint="Los kits no se compran: se compran sus componentes."
    />
  );
}
