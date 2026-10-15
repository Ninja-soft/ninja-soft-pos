// Garantías extendidas en el POS (ADR-139). PURO: a partir del carrito y del
// catálogo de tipos arma, por cada línea que se puede cubrir, las opciones
// con su precio. El precio que se manda es el mismo que recalcula el
// servidor al enlazar la garantía (trigger de sale_items).

import {
  offersForProduct,
  type CategoryNodeLike,
  type WarrantyScopeLike,
  type WarrantyTypeLike,
} from "./pricing";

export interface WarrantyCartLine {
  lineId: string;
  productId: string | null;
  categoryId?: string | null;
  name: string;
  unitPrice: number;
  quantity: number;
  discount?: number;
  variantLabel?: string;
  serial?: string | null;
  warrantyMonths?: number;
  packCreditId?: string | null;
  giftPromoId?: string | null;
}

export interface WarrantyOption {
  planId: string;
  label: string;
  months: number;
  /** Prima por unidad. */
  unitPrice: number;
  /** Prima de la línea (unidad x cantidad): lo que se cobra. */
  total: number;
  description: string | null;
  terms: string | null;
  pricePct: number;
}

export interface WarrantyTarget {
  lineId: string;
  label: string;
  quantity: number;
  /** Garantía de fábrica del producto (meses). */
  factoryMonths: number;
  options: WarrantyOption[];
}

/**
 * Líneas que tienen al menos una garantía disponible, con sus opciones en el
 * orden del negocio. Primero las que tienen n° de serie y después las de mayor
 * importe (la garantía pesa más sobre lo caro).
 */
export function buildWarrantyTargets(
  lines: WarrantyCartLine[],
  plans: WarrantyTypeLike[],
  scopes: WarrantyScopeLike[],
  categories: CategoryNodeLike[],
): WarrantyTarget[] {
  if (plans.length === 0) return [];
  const out: (WarrantyTarget & { amount: number; hasSerial: boolean })[] = [];
  for (const l of lines) {
    if (!l.productId || l.packCreditId || l.giftPromoId || !(l.unitPrice > 0) || !(l.quantity > 0)) continue;
    const offers = offersForProduct(
      plans,
      scopes,
      categories,
      { id: l.productId, categoryId: l.categoryId ?? null },
      l.unitPrice,
      l.quantity,
    );
    if (offers.length === 0) continue;
    out.push({
      lineId: l.lineId,
      label: `${l.name}${l.variantLabel ? ` (${l.variantLabel})` : ""}${l.serial ? ` · ${l.serial}` : ""}`,
      quantity: l.quantity,
      factoryMonths: Math.max(0, l.warrantyMonths ?? 0),
      options: offers.map((o) => ({
        planId: o.plan.id,
        label: o.plan.label,
        months: o.plan.months,
        unitPrice: o.unitPrice,
        total: o.total,
        description: o.plan.description ?? null,
        terms: o.plan.terms ?? null,
        pricePct: Number(o.plan.price_pct) || 0,
      })),
      amount: l.unitPrice * l.quantity - (l.discount ?? 0),
      hasSerial: Boolean(l.serial),
    });
  }
  out.sort((a, b) => Number(b.hasSerial) - Number(a.hasSerial) || b.amount - a.amount);
  return out.map(({ amount: _a, hasSerial: _s, ...t }) => t);
}

/** Opción elegida de un target (o null si el tipo ya no se ofrece para esa línea). */
export function pickOption(targets: WarrantyTarget[], lineId: string, planId: string): { target: WarrantyTarget; option: WarrantyOption } | null {
  const target = targets.find((t) => t.lineId === lineId) ?? targets[0];
  if (!target || !planId) return null;
  const option = target.options.find((o) => o.planId === planId);
  return option ? { target, option } : null;
}
