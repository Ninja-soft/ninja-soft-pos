// Origen de un cambio de precio para el historial (F18 · H100, ADR-056).
//
// Los triggers de product_price_history leen el header `x-ninja-price-source`
// (import, bulk) para distinguir un import o una actualización masiva de un
// cambio manual. Mientras corre `withPriceSource(source, fn)`, el fetch del
// cliente Supabase agrega el header (mismo mecanismo que el token de supervisor).

export const PRICE_SOURCE_HEADER = "x-ninja-price-source";

export type PriceSource = "manual" | "import" | "bulk" | "list";

let current: PriceSource | null = null;

export function currentPriceSource(): PriceSource | null {
  return current;
}

export async function withPriceSource<T>(source: PriceSource, fn: () => Promise<T>): Promise<T> {
  const prev = current;
  current = source;
  try {
    return await fn();
  } finally {
    current = prev;
  }
}
