import type { Product } from "@/modules/products/api";

// Lo mínimo que la grilla le pasa al POS al tocar un producto. pickProduct
// decide si va directo al carrito o abre serial / variante / peso / opciones.
export interface PickInput {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  unit: string;
  is_serialized?: boolean;
  has_variants?: boolean;
  warranty_months?: number;
  categoryId?: string | null;
}

export function toPick(p: Product): PickInput {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    price: p.price,
    unit: p.unit,
    is_serialized: p.is_serialized,
    has_variants: p.has_variants,
    warranty_months: p.warranty_months ?? undefined,
    categoryId: p.category_id,
  };
}

/** Tecla rápida ya resuelta contra el catálogo. */
export interface ResolvedQuickKey {
  product: Product;
  label?: string;
  color?: string;
}
