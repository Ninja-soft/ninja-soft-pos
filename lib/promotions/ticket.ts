// Promociones en el ticket (F9, ADR-074). PURO.
//
// Cada promo aplicada sale en su propia línea ("2x1 Bebidas  -$1.000") y el
// resto del descuento de la venta (manual, cupón, redondeo) como "Descuento".
// Los regalos salen como "Regalo: <promo>" sin monto: el ítem ya figura a $0.

export interface TicketPromo {
  label: string;
  kind: "discount" | "gift";
  amount: number;
}

export interface TicketPromoLines {
  promos: TicketPromo[];
  /** Descuento que no viene de promociones (manual, cupón, redondeo). */
  otherDiscount: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function ticketPromoLines(discountTotal: number, promos: TicketPromo[] | null | undefined): TicketPromoLines {
  const list = (promos ?? []).filter((p) => p.kind === "gift" || p.amount > 0);
  const promoSum = list.filter((p) => p.kind === "discount").reduce((a, p) => a + p.amount, 0);
  const other = r2(Math.max(0, (Number(discountTotal) || 0) - promoSum));
  return { promos: list, otherDiscount: other >= 0.01 ? other : 0 };
}

/** Texto de la línea del ticket ("Regalo: ..." para los regalos). */
export function ticketPromoLabel(p: TicketPromo): string {
  return p.kind === "gift" ? `Regalo: ${p.label}` : p.label;
}
