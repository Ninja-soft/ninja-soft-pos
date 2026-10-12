// Repreciado del carrito cuando cambia el contexto de precio (F18 · H100,
// ADR-058). PURO. Al elegir otra lista o condición de pago, cambiar el cliente
// o la cantidad (escalas), cada línea de producto vuelve a su precio de lista
// (+ modificadores). No se tocan las líneas con precio manual, los regalos, las
// cubiertas por un pack ni los ítems sin producto.

import { round2 } from "./rounding";

export interface RepriceLine {
  lineId: string;
  productId: string | null;
  variantId?: string | null;
  name: string;
  unitPrice: number;
  quantity: number;
  priceOverride?: boolean;
  giftPromoId?: string | null;
  packCreditId?: string | null;
  packId?: string | null;
  modifiers?: { options: { price_delta: number }[] }[] | null;
}

export interface CartRepriceChange {
  lineId: string;
  name: string;
  from: number;
  to: number;
}

export function modifiersDelta(mods: RepriceLine["modifiers"]): number {
  let t = 0;
  for (const g of mods ?? []) for (const o of g.options ?? []) t += Number(o.price_delta) || 0;
  return t;
}

/**
 * `listPrice(line)` devuelve el precio de lista de la línea (sin modificadores)
 * o null si no se puede calcular (producto que no está en memoria).
 */
export function cartRepriceChanges(
  lines: RepriceLine[],
  listPrice: (l: RepriceLine) => number | null,
): CartRepriceChange[] {
  const out: CartRepriceChange[] = [];
  for (const l of lines) {
    if (!l.productId || l.priceOverride || l.giftPromoId || l.packCreditId || l.packId) continue;
    const p = listPrice(l);
    if (p == null) continue;
    const to = round2(p + modifiersDelta(l.modifiers));
    if (Math.abs(to - l.unitPrice) <= 0.005) continue;
    out.push({ lineId: l.lineId, name: l.name, from: l.unitPrice, to });
  }
  return out;
}
