// Referencia de precios de catálogo (lado cliente del tenant).
//
// Si el tenant compró/recibió al menos un catálogo, podemos mostrar en Productos
// y en Listas de precios si SU precio está por encima o por debajo del precio de
// referencia de los principales competidores (las tiendas del catálogo). Es
// información orientativa de mercado, NO vinculante.
//
// Las tablas catalog_* y la RPC catalog_price_reference NO están en
// types/database.ts (no se regenera por decisión del proyecto): accedemos vía un
// cliente "destipado" (cast a any) SÓLO para estas tablas/funciones nuevas.
import { createClient } from "@/lib/supabase/client";

// Cliente "destipado" para tablas/RPC de catálogos ausentes en database.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): AnyDb {
  return createClient() as AnyDb;
}

// Precio de referencia representativo (mediana entre tiendas) de un EAN.
export interface PriceReference {
  ean: string;
  referencePrice: number;
  storeCount: number;
}

export const catalogPriceApi = {
  // ¿El tenant compró/recibió al menos un catálogo? La RLS de
  // tenant_catalog_purchases ya limita las filas a las del tenant; basta con
  // contar si existe alguna. head:true + count exacto = sin traer filas.
  hasPurchasedCatalog: async (): Promise<boolean> => {
    const { count, error } = await db()
      .from("tenant_catalog_purchases")
      .select("id", { count: "exact", head: true });
    if (error) throw error;
    return (count ?? 0) > 0;
  },

  // Referencia de precio por EAN para un lote de EANs (sin N+1). Devuelve un
  // mapa ean -> referencia, sólo para los EANs que tienen referencia.
  referenceForEans: async (
    eans: string[],
  ): Promise<Map<string, PriceReference>> => {
    const clean = Array.from(
      new Set(eans.map((e) => (e ?? "").trim()).filter(Boolean)),
    );
    const map = new Map<string, PriceReference>();
    if (clean.length === 0) return map;

    const { data, error } = await db().rpc("catalog_price_reference", {
      p_eans: clean,
    });
    if (error) throw error;

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const ean = String(row.ean);
      map.set(ean, {
        ean,
        referencePrice: Number(row.reference_price ?? 0),
        storeCount: Number(row.store_count ?? 0),
      });
    }
    return map;
  },
};

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

// Umbral para considerar "igual": diferencias menores a 0.5% no marcan flecha
// (evita ruido por redondeos / centavos).
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
