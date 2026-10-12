// Matemática PURA del cobro del POS (CheckoutSheet). Sin React ni Supabase: la
// usan la hoja de cobro y los tests. Espeja el cálculo que hacía PaymentModal y
// el que reaplica create_sale en el server:
//
//   total de productos = redondeo(base - promo extra + garantía + recargos) + envío
//   total a cobrar     = total de productos + propina
//
// `base` es el total del carrito SIN redondear (subtotal - descuentos - promo
// del carrito - cupón). El server redondea igual y suma el envío después.

export const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
export const toCents = (n: number | string) => Math.round((Number(n) || 0) * 100);
export const fromCents = (c: number) => Math.round(c) / 100;

/** Redondeo al múltiplo configurado (pos_settings.rounding_multiple). */
export function applyRounding(x: number, multiple: number): number {
  return multiple > 0 ? Math.round(x / multiple) * multiple : x;
}

// Billetes argentinos en circulación (para los montos rápidos de efectivo).
export const AR_BILLS = [10, 20, 50, 100, 200, 500, 1000, 2000, 10000, 20000] as const;

/**
 * Montos rápidos de efectivo por encima de `due`: el próximo múltiplo de cada
 * billete grande (lo que el cliente suele entregar) más los montos fijos que el
 * dueño haya configurado. Excluye el exacto (tiene su propio botón).
 */
export function quickCashAmounts(
  due: number,
  opts: { custom?: number[]; max?: number } = {},
): number[] {
  const max = opts.max ?? 4;
  if (!(due > 0)) return [];
  const dueC = toCents(due);
  const out = new Set<number>();
  for (const c of opts.custom ?? []) {
    if (Number.isFinite(c) && toCents(c) > dueC) out.add(round2(c));
  }
  for (const bill of [100, 500, 1000, 2000, 10000, 20000]) {
    const v = Math.ceil(due / bill) * bill;
    if (toCents(v) > dueC) out.add(v);
  }
  return [...out].sort((a, b) => a - b).slice(0, max);
}

/** Parte "1 de N" del saldo, en centavos exactos (la última absorbe el resto). */
export function splitShare(remaining: number, parts: number): number {
  const n = Math.max(1, Math.floor(parts));
  return fromCents(Math.round(toCents(remaining) / n));
}

/** Recargo de una línea por un % (plan de cuotas o recargo del medio). */
export function lineSurcharge(amount: number, pct: number): number {
  if (!(pct > 0) || !(amount > 0)) return 0;
  return round2((amount * pct) / 100);
}

/** Propina a partir de un % sobre el total de productos (pesos enteros). */
export function tipFromPercent(productsTotal: number, pct: number): number {
  if (!(pct > 0) || !(productsTotal > 0)) return 0;
  return Math.round((productsTotal * pct) / 100);
}

// Medios válidos de sales.tip_method (ver create_sale). El resto cae a efectivo.
const TIP_METHODS = new Set(["cash", "debit", "credit", "transfer", "qr"]);
export function tipMethodFor(method: string | undefined): string {
  return method && TIP_METHODS.has(method) ? method : "cash";
}

/** Una línea de pago ya registrada en la hoja de cobro. */
export interface CheckoutLine {
  method: string;
  /** Lo que se cobra en esta línea (incluye su propio recargo). */
  amount: number;
  /** Recargo propio de la línea (plan de cuotas o recargo del medio). */
  surcharge: number;
  /** Sólo efectivo: lo que entregó el cliente (para el vuelto). */
  received?: number;
}

export interface CheckoutInput {
  base: number;
  rounding: number;
  deliveryFee?: number;
  /** Descuento EXTRA por medio de pago respecto de la promo del carrito. */
  promoExtra?: number;
  /** Prima de garantía extendida. */
  warranty?: number;
  tip?: number;
  lines: CheckoutLine[];
}

export interface CheckoutTotals {
  surcharges: number;
  productsTotal: number;
  grandTotal: number;
  paid: number;
  /** grandTotal - paid. Negativo = sobra (el server acepta pagar de más). */
  remaining: number;
  /** Vuelto en efectivo (recibido por encima de lo cobrado en efectivo). */
  change: number;
  settled: boolean;
}

export function checkoutTotals(i: CheckoutInput): CheckoutTotals {
  const surcharges = round2(i.lines.reduce((a, l) => a + (l.surcharge || 0), 0));
  const fee = Math.max(0, i.deliveryFee ?? 0);
  const productsTotal = round2(
    applyRounding(
      i.base - (i.promoExtra ?? 0) + (i.warranty ?? 0) + surcharges,
      i.rounding,
    ) + fee,
  );
  const tip = Math.max(0, i.tip ?? 0);
  const grandTotal = round2(productsTotal + tip);
  const paid = round2(i.lines.reduce((a, l) => a + (l.amount || 0), 0));
  const remaining = round2(grandTotal - paid);
  const change = round2(
    i.lines.reduce(
      (a, l) =>
        l.method === "cash" && (l.received ?? 0) > l.amount
          ? a + ((l.received ?? 0) - l.amount)
          : a,
      0,
    ),
  );
  return {
    surcharges,
    productsTotal,
    grandTotal,
    paid,
    remaining,
    change,
    settled: grandTotal > 0 && remaining <= 0.009,
  };
}

/**
 * Monto final de una línea MANUAL (efectivo, tarjeta manual, transferencia…).
 * `portion` es la parte del saldo que cubre la línea; el recargo se suma
 * encima. Si la línea cierra la cuenta, se ajusta para dejar el saldo en 0
 * exacto aunque el redondeo del total se mueva al sumar el recargo.
 */
export function settleLine(
  input: CheckoutInput,
  portion: number,
  surchargePct: number,
): { amount: number; surcharge: number; closes: boolean } {
  const before = checkoutTotals(input);
  const p = round2(Math.max(0, portion));
  const surcharge = lineSurcharge(p, surchargePct);
  const closes = p >= before.remaining - 0.005;
  if (!closes) return { amount: round2(p + surcharge), surcharge, closes };
  const after = checkoutTotals({
    ...input,
    lines: [...input.lines, { method: "_", amount: 0, surcharge }],
  });
  return { amount: Math.max(0, after.remaining), surcharge, closes };
}
