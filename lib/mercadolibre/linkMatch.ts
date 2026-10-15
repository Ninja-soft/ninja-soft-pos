// =============================================================================
// Vincular una publicación con un producto (ADR-141, parte A). PURO.
// Textos de la sugerencia y la variante que conviene preelegir.
// =============================================================================

export type LinkMatch = "gtin" | "sku" | "title" | "search";

export const LINK_MATCH_LABELS: Record<LinkMatch, string> = {
  gtin: "Mismo código de barras",
  sku: "Mismo SKU",
  title: "Nombre parecido",
  search: "Coincide con la búsqueda",
};

export function linkMatchTone(m: LinkMatch | null | undefined): "success" | "info" | "neutral" {
  if (m === "gtin" || m === "sku") return "success";
  if (m === "title") return "info";
  return "neutral";
}

/** Sugerencia fuerte: se puede vincular sin dudar (mismo código). */
export function isStrongMatch(m: LinkMatch | null | undefined): boolean {
  return m === "gtin" || m === "sku";
}

export interface VariationRef {
  id: string;
  sku: string | null;
  gtin: string | null;
}

export interface VariantRef {
  id: string;
  sku: string | null;
  barcode: string | null;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/**
 * Variante del producto que corresponde a la variación elegida de ML (por
 * código de barras y después por SKU). null si no hay una clara.
 */
export function matchVariant(variation: VariationRef | null, variants: VariantRef[]): string | null {
  if (!variation) return null;
  const g = digits(variation.gtin);
  if (g) {
    const hit = variants.find((v) => digits(v.barcode) === g);
    if (hit) return hit.id;
  }
  const s = norm(variation.sku);
  if (s) {
    const hit = variants.find((v) => norm(v.sku) === s);
    if (hit) return hit.id;
  }
  return null;
}

/** Texto corto de los códigos de un producto: "SKU · EAN". */
export function codesLine(p: { sku: string | null; barcode: string | null }): string {
  return [p.sku ? `SKU ${p.sku}` : null, p.barcode ? `EAN ${p.barcode}` : null].filter(Boolean).join(" · ");
}
