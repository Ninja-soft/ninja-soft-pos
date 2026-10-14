// Referencia de precios de mercado (lado cliente del tenant).
//
// Si el tenant compró/recibió al menos un catálogo, mostramos en Productos, en
// la ficha del producto y en Listas de precios cómo está SU precio contra lo
// que cobran las tiendas y vendedores de esos catálogos (ADR-109: todas las
// ofertas por tienda y vendedor). Es información orientativa de mercado, NO
// vinculante. El dueño la apaga en Configuración (pos_settings.
// show_catalog_price_hints); apagada, el front no llama a estas RPC.
//
// Las tablas catalog_* y las RPC catalog_price_reference / catalog_price_compare
// NO están en types/database.ts (no se regenera por decisión del proyecto):
// accedemos vía un cliente "destipado" (cast a any) SÓLO para estas funciones.
import { createClient } from "@/lib/supabase/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
function db(): AnyDb {
  return createClient() as AnyDb;
}

// Referencia de mercado de un EAN (batch para listas).
export interface PriceReference {
  ean: string;
  /** Mediana de los precios de las tiendas (si no hay, de todos los vendedores). */
  referencePrice: number;
  /** Publicaciones de tienda con precio. */
  storeCount: number;
  minPrice: number | null;
  maxPrice: number | null;
  /** Ofertas con precio (tiendas + otros vendedores). */
  offerCount: number;
  /** Vendedores distintos (cada tienda cuenta como un vendedor). */
  sellerCount: number;
  minStoreKey: string | null;
  minStoreName: string | null;
  minSeller: string | null;
}

// Una oferta del comparador (catalog_price_compare).
export interface MarketOffer {
  storeKey: string;
  storeName: string;
  storeLogo: string | null;
  seller: string;
  principal: boolean;
  price: number | null;
  listPrice: number | null;
  available: boolean;
  url: string | null;
  lastSeenAt: string | null;
}

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

export function parsePriceReference(row: Record<string, unknown>): PriceReference {
  return {
    ean: String(row.ean),
    referencePrice: Number(row.reference_price ?? 0),
    storeCount: Number(row.store_count ?? 0),
    minPrice: numOrNull(row.min_price),
    maxPrice: numOrNull(row.max_price),
    offerCount: Number(row.offer_count ?? row.store_count ?? 0),
    sellerCount: Number(row.seller_count ?? row.store_count ?? 0),
    minStoreKey: (row.min_store_key as string) ?? null,
    minStoreName: (row.min_store_name as string) ?? null,
    minSeller: (row.min_seller as string) ?? null,
  };
}

export function parseMarketOffer(row: Record<string, unknown>): MarketOffer {
  return {
    storeKey: String(row.store_key ?? ""),
    storeName: String(row.store_name ?? row.store_key ?? ""),
    storeLogo: (row.store_logo as string) ?? null,
    seller: String(row.vendedor ?? row.store_name ?? ""),
    principal: row.principal !== false,
    price: numOrNull(row.precio),
    listPrice: numOrNull(row.precio_lista),
    available: Boolean(row.disponible),
    url: (row.url as string) ?? null,
    lastSeenAt: (row.last_seen_at as string) ?? (row.updated_at as string) ?? null,
  };
}

export const catalogPriceApi = {
  // ¿El tenant compró/recibió al menos un catálogo? La RLS de
  // tenant_catalog_purchases ya limita las filas a las del tenant.
  hasPurchasedCatalog: async (): Promise<boolean> => {
    const { count, error } = await db()
      .from("tenant_catalog_purchases")
      .select("id", { count: "exact", head: true });
    if (error) throw error;
    return (count ?? 0) > 0;
  },

  // Referencia por EAN para un lote de EANs (sin N+1): mapa ean -> referencia.
  referenceForEans: async (eans: string[]): Promise<Map<string, PriceReference>> => {
    const clean = Array.from(new Set(eans.map((e) => (e ?? "").trim()).filter(Boolean)));
    const map = new Map<string, PriceReference>();
    if (clean.length === 0) return map;
    const { data, error } = await db().rpc("catalog_price_reference", { p_eans: clean });
    if (error) throw error;
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const ref = parsePriceReference(row);
      map.set(ref.ean, ref);
    }
    return map;
  },

  // Todas las ofertas visibles de un EAN (tienda, vendedor, precio), por precio.
  compare: async (ean: string): Promise<MarketOffer[]> => {
    const clean = (ean ?? "").trim();
    if (!clean) return [];
    const { data, error } = await db().rpc("catalog_price_compare", { p_ean: clean });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(parseMarketOffer);
  },
};

// Resumen del mercado para un EAN: desde / hasta / mediana y cuántos venden.
export interface MarketSummary {
  min: number;
  max: number;
  median: number;
  offers: number;
  sellers: number;
  stores: number;
  cheapest: MarketOffer;
}

export function marketSummary(offers: MarketOffer[]): MarketSummary | null {
  const priced = offers.filter((o) => o.price != null && o.price > 0);
  if (priced.length === 0) return null;
  const prices = priced.map((o) => o.price as number).sort((a, b) => a - b);
  const at = (i: number) => prices[i] as number;
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
  const cheapest = [...priced].sort((a, b) => (a.price as number) - (b.price as number))[0] as MarketOffer;
  return {
    min: at(0),
    max: at(prices.length - 1),
    median: Math.round(median * 100) / 100,
    offers: priced.length,
    sellers: new Set(priced.map((o) => `${o.storeKey}|${o.seller}`)).size,
    stores: new Set(priced.map((o) => o.storeKey)).size,
    cheapest,
  };
}

// Mi precio contra el rango del mercado.
export type MarketPosition = "below" | "in_range" | "above";

export function marketPosition(myPrice: number, summary: Pick<MarketSummary, "min" | "max"> | null): MarketPosition | null {
  if (!summary || !Number.isFinite(myPrice) || myPrice <= 0) return null;
  if (myPrice < summary.min) return "below";
  if (myPrice > summary.max) return "above";
  return "in_range";
}

// Frase corta para tooltips: "desde $X en Tienda/Vendedor, N vendedores".
export function marketFromLabel(ref: PriceReference, format: (n: number) => string): string | null {
  if (ref.minPrice == null || ref.minPrice <= 0) return null;
  const where = ref.minStoreName
    ? ref.minSeller && ref.minSeller !== ref.minStoreName
      ? `${ref.minStoreName}/${ref.minSeller}`
      : ref.minStoreName
    : null;
  const n = ref.sellerCount;
  return `desde ${format(ref.minPrice)}${where ? ` en ${where}` : ""}${n > 1 ? `, ${n} vendedores` : ""}`;
}

// Dirección de la comparación de MI precio vs la referencia de mercado.
//  - "below": mi precio es menor que la referencia (más barato) → flecha verde ↓
//  - "above": mi precio es mayor que la referencia (más caro)   → flecha roja  ↑
//  - "equal": prácticamente igual (sin ventaja ni desventaja)   → neutro
export type PriceComparisonDirection = "below" | "above" | "equal";

export interface PriceComparison {
  direction: PriceComparisonDirection;
  // % de diferencia (siempre >= 0) respecto de la referencia.
  diffPct: number;
  referencePrice: number;
}

// Umbral para considerar "igual": diferencias menores a 0.5% no marcan flecha.
const EQUAL_THRESHOLD_PCT = 0.5;

// Compara MI precio contra la referencia. Devuelve null si no hay referencia
// válida (sin catálogo, EAN sin match, o referencia <= 0).
export function comparePriceToReference(
  myPrice: number,
  ref: PriceReference | undefined | null,
): PriceComparison | null {
  if (!ref || !Number.isFinite(ref.referencePrice) || ref.referencePrice <= 0) {
    return null;
  }
  const diffPct = ((myPrice - ref.referencePrice) / ref.referencePrice) * 100;
  const abs = Math.abs(diffPct);
  let direction: PriceComparisonDirection;
  if (abs < EQUAL_THRESHOLD_PCT) direction = "equal";
  else if (diffPct < 0) direction = "below";
  else direction = "above";
  return { direction, diffPct: abs, referencePrice: ref.referencePrice };
}
