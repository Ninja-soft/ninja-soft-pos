// Resolución de precio por lista (H10). Función pura, compartida entre POS,
// catálogo público y la UI de listas de precios.
//
// Precedencia (de mayor a menor):
//   1. item de lista por variante  (variant_id == variantId)
//   2. item de lista por producto  (variant_id == null)
//   3. adjustment_pct de la lista sobre el precio base
//   4. precio base
//
// `basePrice` ya viene resuelto por el caller: variant.price_override ?? product.price.

export interface PriceListLike {
  adjustment_pct: number | null;
}

export interface PriceItemLike {
  product_id: string;
  variant_id: string | null;
  price: number;
}

// Redondeo a 2 decimales evitando errores binarios (0.1 + 0.2…).
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function resolvePrice(
  basePrice: number,
  productId: string,
  variantId: string | null,
  list: PriceListLike | null,
  items: PriceItemLike[],
): number {
  if (!list) return basePrice;

  // 1. Item puntual por variante.
  if (variantId) {
    const byVariant = items.find(
      (i) => i.product_id === productId && i.variant_id === variantId,
    );
    if (byVariant) return byVariant.price;
  }

  // 2. Item puntual por producto (variante null).
  const byProduct = items.find(
    (i) => i.product_id === productId && i.variant_id === null,
  );
  if (byProduct) return byProduct.price;

  // 3. Ajuste % global de la lista.
  if (list.adjustment_pct != null) {
    return round2(basePrice * (1 + list.adjustment_pct / 100));
  }

  // 4. Precio base.
  return basePrice;
}
