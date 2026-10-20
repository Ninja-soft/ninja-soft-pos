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
  // ADR-151: precio a definir al cobrar (el POS lo pide al agregarlo).
  price_mode?: string | null;
  open_price_min?: number | null;
  open_price_max?: number | null;
  is_service?: boolean;
  // H158/H163: no acepta descuento (el bulto se vende a N × precio).
  no_discount?: boolean;
}

export function toPick(p: Product): PickInput {
  const x = p as Product & { is_service?: boolean | null };
  return {
    price_mode: p.price_mode ?? null,
    open_price_min: p.open_price_min ?? null,
    open_price_max: p.open_price_max ?? null,
    is_service: Boolean(x.is_service),
    no_discount: Boolean(p.no_discount),
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
