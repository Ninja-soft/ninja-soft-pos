// =============================================================================
// _shared/mercadolibre/listing.ts (H141 · ADR-132). PURO.
//
// Publicar el mismo producto en varios tipos de publicación con el precio de
// cada tipo calculado en el servidor (ml_listing_prices_for), el producto de
// catálogo de ML por GTIN para precompletar y la comisión por tipo.
// =============================================================================
import type { PublishInput } from "./items.ts";

/** Fila de ml_listing_prices_for / listing_prices de la vista previa. */
export interface ListingPriceRow {
  listing_type_id: string;
  price: number | null;
  /** Precio por variante (id de la variante del POS). */
  variants: Record<string, number | null>;
  rule: { enabled: boolean; default_on: boolean } | null;
  override: { mode: string } | null;
}

/** Tipos que se publican: los pedidos, válidos, sin repetir, como mucho 4. */
export function pickListingTypes(requested: unknown, fallback: string): string[] {
  const list = Array.isArray(requested) ? requested.map(String) : [];
  const ok = [...new Set(list.filter((t) => /^[a-z_]{2,30}$/.test(t)))].slice(0, 4);
  return ok.length > 0 ? ok : [fallback];
}

/**
 * PublishInput de un tipo con los precios del servidor. null = ese tipo no se
 * publica (override "no publicar" o sin precio).
 */
export function inputForListing(input: PublishInput, listingTypeId: string, prices: ListingPriceRow[]): PublishInput | null {
  const row = prices.find((p) => p.listing_type_id === listingTypeId);
  if (!row) return null;
  if (!(typeof row.price === "number" && row.price > 0) && !(input.variants ?? []).length) return null;
  const variants = (input.variants ?? []).map((v) => {
    const vp = row.variants?.[v.key];
    return { ...v, price: typeof vp === "number" && vp > 0 ? vp : 0 };
  });
  if (variants.some((v) => !(v.price > 0))) return null;
  // Clásico: todas las variaciones al mismo precio (el mayor, como el push).
  if (input.model === "classic" && variants.length > 1) {
    const max = Math.max(...variants.map((v) => v.price));
    for (const v of variants) v.price = max;
  }
  return {
    ...input,
    listingTypeId,
    price: typeof row.price === "number" && row.price > 0 ? row.price : (variants[0]?.price ?? 0),
    variants: input.variants ? variants : undefined,
  };
}

/** GET /products/search?product_identifier= (sólo lo que se usa). */
export interface MlProductSearch {
  query_type?: string;
  results?: Array<{
    id: string;
    name?: string;
    domain_id?: string;
    status?: string;
    attributes?: Array<{ id: string; name?: string; value_id?: string | null; value_name?: string | null }>;
  }>;
}

export interface CatalogMatch {
  catalog_product_id: string;
  name: string;
  domain_id: string | null;
  attributes: Array<{ id: string; name: string | null; value_id: string | null; value_name: string | null }>;
}

/** Primer producto de catálogo que coincide por GTIN (sólo si ML lo buscó como GTIN). */
export function catalogMatch(res: MlProductSearch | null | undefined, gtin: string): CatalogMatch | null {
  if (!res || (res.query_type && res.query_type !== "GTIN")) return null;
  const hit = (res.results ?? []).find((r) =>
    (r.attributes ?? []).some((a) => a.id === "GTIN" && (a.value_name ?? "").split(",").map((s) => s.trim()).includes(gtin)),
  ) ?? (res.results ?? [])[0];
  if (!hit) return null;
  return {
    catalog_product_id: hit.id,
    name: hit.name ?? "",
    domain_id: hit.domain_id ?? null,
    attributes: (hit.attributes ?? [])
      .filter((a) => a.id && a.id !== "GTIN" && a.id !== "MANUAL_TITLE" && a.id !== "PACKAGE_DATA_SOURCE")
      .map((a) => ({ id: a.id, name: a.name ?? null, value_id: a.value_id ?? null, value_name: a.value_name ?? null })),
  };
}

/** GET /sites/MLA/listing_prices (sólo lo que se usa). */
export interface MlListingPrice {
  listing_type_id: string;
  listing_type_name?: string;
  sale_fee_amount?: number;
  sale_fee_details?: { percentage_fee?: number; fixed_fee?: number };
}

export function feesByType(rows: MlListingPrice[] | null | undefined, types = ["gold_special", "gold_pro"]) {
  return (rows ?? [])
    .filter((r) => types.includes(r.listing_type_id))
    .map((r) => ({
      listing_type_id: r.listing_type_id,
      name: r.listing_type_name ?? r.listing_type_id,
      sale_fee_amount: Number(r.sale_fee_amount ?? 0),
      percentage_fee: Number(r.sale_fee_details?.percentage_fee ?? 0),
      fixed_fee: Number(r.sale_fee_details?.fixed_fee ?? 0),
    }));
}
