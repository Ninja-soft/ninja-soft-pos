"use client";

// Buscador de productos para Compras: nombre, SKU, EAN o PLU, lector de códigos
// y elección de variante (ProductSearchCombobox). Los kits no se compran (se
// compran sus componentes).

import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";
import type { Product, ProductVariant } from "@/modules/products/api";

const purchasable = (p: Product) => !p.is_kit;

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
      rejectMessage={(p) => `${p.name} es un kit: comprá sus componentes`}
      emptyHint="Los kits no se compran: se compran sus componentes."
    />
  );
}
