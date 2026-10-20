// F24 · H158: productos no bonificables (products.no_discount). PURO.
//
// El descuento general de la venta se aplica sólo sobre lo bonificable: el
// servidor rechaza (discount_not_discountable) un descuento mayor a la suma de
// los renglones que sí aceptan descuento.

export function discountableSubtotal(
  lines: { productId: string | null; amount: number }[],
  blockedIds: readonly string[],
): { amount: number; hasBlocked: boolean } {
  const blocked = new Set(blockedIds);
  let amount = 0;
  let hasBlocked = false;
  for (const l of lines) {
    if (l.productId && blocked.has(l.productId)) hasBlocked = true;
    else amount += l.amount;
  }
  return { amount: Math.round(amount * 100) / 100, hasBlocked };
}

/** Tope del descuento general: el % del rol sobre lo bonificable. */
export function maxGeneralDiscount(discountable: number, maxPct: number): number {
  return Math.max(0, (discountable * maxPct) / 100);
}
