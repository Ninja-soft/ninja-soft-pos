// F24 · H160 (ADR-179): efectivo en dólares en el POS. Matemática pura,
// espejo del trigger payments_aa_h160_extras: el pago se guarda en pesos (lo
// que cubre de la venta) y los dólares con la cotización van en
// payments.metadata.usd; lo que sobra se da de vuelto en pesos.

import { round2 } from "./checkoutMath";

export interface UsdQuote {
  rate: number;
  /** "negocio" (fx_rates del negocio) u "oficial" (cotización de la plataforma). */
  source: string;
  date: string | null;
}

const cents = (n: number) => Math.round((Number(n) || 0) * 100);

/** Pesos que valen los dólares recibidos. */
export function usdToArs(usd: number, rate: number): number {
  if (!(usd > 0) || !(rate > 0)) return 0;
  return round2(usd * rate);
}

export interface UsdSettle {
  /** Pesos que valen los dólares. */
  ars: number;
  /** Lo que se registra en el pago (en pesos): lo que cubre del saldo. */
  amount: number;
  /** Vuelto en pesos. */
  change: number;
  /** ¿Alcanza para lo que se quiere cubrir con este medio? */
  covers: boolean;
}

/**
 * Cobro en dólares contra `due` pesos: si los dólares alcanzan, cubre `due`
 * y el resto es vuelto; si no, cubre lo que valen (pago parcial).
 */
export function settleUsd(usd: number, rate: number, due: number): UsdSettle {
  const ars = usdToArs(usd, rate);
  const dueC = Math.max(0, cents(due));
  const arsC = cents(ars);
  const amountC = Math.min(arsC, dueC);
  return {
    ars,
    amount: amountC / 100,
    change: Math.max(0, arsC - dueC) / 100,
    covers: arsC >= dueC,
  };
}

/** Dólares que hacen falta para cubrir `due` pesos (redondeado al dólar). */
export function usdNeeded(due: number, rate: number): number {
  if (!(due > 0) || !(rate > 0)) return 0;
  return Math.ceil(due / rate);
}

export function formatUsd(n: number): string {
  return `US$ ${(Number(n) || 0).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
