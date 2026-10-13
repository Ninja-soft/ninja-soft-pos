// lib/products/productSearch.ts
//
// Lógica PURA del buscador reutilizable de productos (ProductSearchCombobox):
// filtrado de resultados, etiqueta de stock, navegación por teclado y decisión
// ante un escaneo. Sin React ni Supabase, para testearla aislada.

import { formatQty } from "@/lib/utils/format";

/** Mínimo de caracteres para buscar (igual que los buscadores previos). */
export const MIN_SEARCH = 2;
/** Máximo de resultados que muestra la lista. */
export const MAX_RESULTS = 8;

interface SearchableProduct {
  id: string;
  track_stock?: boolean | null;
}

/** Resultados visibles: vacío si la búsqueda es corta; si no, filtrados y recortados. */
export function visibleResults<P extends SearchableProduct>(
  found: P[],
  search: string,
  filter?: (p: P) => boolean,
  max = MAX_RESULTS,
): P[] {
  if (search.trim().length < MIN_SEARCH) return [];
  return (filter ? found.filter(filter) : found).slice(0, max);
}

/** "sin control" si el producto no trackea stock; si no, la cantidad. */
export function stockLabel(trackStock: boolean | null | undefined, qty: number | null | undefined): string {
  if (trackStock === false) return "sin control";
  return formatQty(Number(qty ?? 0));
}

/** Próximo índice activo con flechas (circular). -1 = ninguno. */
export function moveIndex(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return (current + delta + length) % length;
}

export type ScanDecision<M> =
  | { kind: "pick"; match: M }
  | { kind: "list" }
  | { kind: "rejected"; match: M }
  | { kind: "not_found" };

/**
 * Qué hacer con un escaneo según sus coincidencias exactas:
 * una sola permitida → se agrega directo; varias → se muestra la lista; todas
 * descartadas por el filtro → aviso; ninguna → no encontrado.
 */
export function decideScan<M extends { product: P }, P>(
  matches: M[],
  filter?: (p: P) => boolean,
): ScanDecision<M> {
  if (matches.length === 0) return { kind: "not_found" };
  const allowed = filter ? matches.filter((m) => filter(m.product)) : matches;
  if (allowed.length === 0) return { kind: "rejected", match: matches[0]! };
  if (allowed.length === 1) return { kind: "pick", match: allowed[0]! };
  return { kind: "list" };
}
