// Entidades de tarjeta para "Tarjeta en posnet" (terminal no integrada: se
// cobra en el posnet propio y el cajero carga los datos del cupón). Las claves
// coinciden con payment_plans.brand (visa, master, maestro, cabal…).
//
// Logos: los oficiales transparentes de public/images/cards/ vía
// lib/payments/logos.ts (cardLogo), con variante para fondo oscuro. En la UI
// se muestran con CardBrandLogo (components/ui/ThemedLogo), sin placa.

import { cardLogo, type LogoOpts } from "@/lib/payments/logos";

export type CardKind = "debit" | "credit";

export interface CardBrand {
  key: string;
  label: string;
  /** Nombre corto para placas chicas (selector de entidad). */
  short?: string;
  /** Tipos que emite la entidad (Maestro sólo débito; Amex, Naranja, Diners sólo crédito). */
  kinds: CardKind[];
}

export const CARD_BRANDS: CardBrand[] = [
  { key: "visa", label: "Visa", kinds: ["debit", "credit"] },
  { key: "master", label: "Mastercard", short: "Master", kinds: ["debit", "credit"] },
  { key: "amex", label: "American Express", short: "Amex", kinds: ["credit"] },
  { key: "cabal", label: "Cabal", kinds: ["debit", "credit"] },
  { key: "naranja", label: "Naranja", kinds: ["credit"] },
  { key: "maestro", label: "Maestro", kinds: ["debit"] },
  { key: "diners", label: "Diners", kinds: ["credit"] },
];

/** Entidad genérica (siempre al final): tarjetas sin plan propio. */
export const OTHER_CARD_BRAND: CardBrand = { key: "other", label: "Otra", kinds: ["debit", "credit"] };

/**
 * Clave del logo (lib/payments/logos.ts → cardLogo) de la entidad y tipo: Visa
 * tiene logo propio de débito; el resto usa el mismo para ambos. null = sin logo.
 */
export function cardLogoKey(key: string | null | undefined, kind?: CardKind): string | null {
  if (!key || !CARD_BRANDS.some((b) => b.key === key)) return null;
  return key === "visa" && kind === "debit" ? "visa_debito" : key;
}

/** Logo oficial transparente de la entidad; `{ on: "dark" }` pide la variante para fondo oscuro. */
export function cardBrandLogo(key: string, kind?: CardKind, opts?: LogoOpts): string | null {
  return cardLogo(cardLogoKey(key, kind), opts);
}

export function cardBrandByKey(key: string | null | undefined): CardBrand | null {
  if (!key) return null;
  if (key === OTHER_CARD_BRAND.key) return OTHER_CARD_BRAND;
  return CARD_BRANDS.find((b) => b.key === key) ?? null;
}

/**
 * Entidades a ofrecer: siempre el catálogo completo y "Otra" al final. Una
 * entidad sin planes propios cobra con los planes generales (sin entidad).
 */
export function availableCardBrands(_plans?: { brand?: string | null }[]): CardBrand[] {
  return [...CARD_BRANDS, OTHER_CARD_BRAND];
}

/** Planes de cuotas de la entidad y tipo elegidos (los sin entidad aplican a todas). */
export function plansForCard<P extends { base: string | null; brand?: string | null; installments: number | null }>(
  plans: P[],
  brand: string | null,
  kind: CardKind,
): P[] {
  const base = kind === "debit" ? "debito" : "credito";
  return plans
    .filter((p) => p.base === base && (p.brand == null || p.brand === brand))
    .sort((a, z) => (a.installments ?? 1) - (z.installments ?? 1));
}
