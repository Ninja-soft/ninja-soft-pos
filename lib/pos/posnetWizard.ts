// Pasos del cobro "Tarjeta en posnet" (ADR-042 y ADR-054):
//   1) Adquirente de la terminal (Getnet, Payway, MP Point, Fiserv, Nave, Otra)
//   2) Entidad de la tarjeta (Visa, Mastercard...)
//   3) Tipo (débito / crédito) y cuotas
//   4) Datos del cupón
// Cada elección pasa sola al paso siguiente y se saltean los pasos sin nada
// que elegir (entidad que sólo emite un tipo y sin cuotas). Puro y testeable.

import type { CardBrand, CardKind } from "@/lib/pos/cardBrands";

export type PosnetStep = 1 | 2 | 3 | 4;

export const POSNET_STEP_TITLE: Record<PosnetStep, string> = {
  1: "Terminal del cobro",
  2: "Entidad de la tarjeta",
  3: "Tipo y cuotas",
  4: "Datos del cupón",
};

/** Planes que valen una elección: más de un pago o con recargo. */
export function choosablePlans<P extends { installments: number | null; surcharge_pct: number | string | null }>(
  plans: P[],
): P[] {
  return plans.filter((p) => (p.installments ?? 1) > 1 || (Number(p.surcharge_pct) || 0) > 0);
}

/** Paso inicial: con adquirente preseleccionado se arranca en la entidad. */
export function initialStep(acquirer: string | null): PosnetStep {
  return acquirer ? 2 : 1;
}

/**
 * Al elegir la entidad: tipo que queda y paso siguiente. Con un solo tipo y
 * sin cuotas para elegir, directo al cupón.
 */
export function afterBrand(
  brand: Pick<CardBrand, "kinds">,
  currentKind: CardKind,
  choosableByKind: Record<CardKind, number>,
): { kind: CardKind; step: PosnetStep } {
  const only = brand.kinds.length === 1 ? brand.kinds[0]! : null;
  const kind = only ?? (brand.kinds.includes(currentKind) ? currentKind : (brand.kinds[0] ?? "debit"));
  if (only && choosableByKind[only] === 0) return { kind, step: 4 };
  return { kind, step: 3 };
}

/** Al tocar Débito / Crédito: sin cuotas para elegir, al cupón. */
export function afterKind(kind: CardKind, choosableByKind: Record<CardKind, number>): PosnetStep {
  return choosableByKind[kind] === 0 ? 4 : 3;
}

/** Atrás: vuelve al último paso que tuvo algo para elegir. */
export function backStep(
  step: PosnetStep,
  brand: Pick<CardBrand, "kinds"> | null,
  kind: CardKind,
  choosableByKind: Record<CardKind, number>,
): PosnetStep {
  if (step <= 1) return 1;
  if (step === 4) {
    const skipped3 = brand !== null && brand.kinds.length === 1 && choosableByKind[kind] === 0;
    return skipped3 ? 2 : 3;
  }
  return (step - 1) as PosnetStep;
}

/** Botón principal en un paso intermedio: a dónde va (null = no puede). */
export function ctaNext(
  step: PosnetStep,
  s: { acquirer: string | null; brand: Pick<CardBrand, "kinds"> | null; kind: CardKind; choosableByKind: Record<CardKind, number> },
): PosnetStep | null {
  if (step === 1) return s.acquirer ? 2 : null;
  if (step === 2) return s.brand ? afterBrand(s.brand, s.kind, s.choosableByKind).step : null;
  if (step === 3) return 4;
  return null;
}
