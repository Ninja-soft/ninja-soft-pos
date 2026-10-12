// Lista y condición de pago elegidas en el POS (F18 · H100, ADR-058).
//
// Mientras el POS está abierto, cada request del navegador manda los headers
// `x-ninja-price-list` y `x-ninja-payment-term`: _resolve_unit_price los lee
// (create_sale, el ensayo del cobro en espera y los ítems de mesa o delivery
// cargados desde el POS) y resuelve el mismo precio que muestra la pantalla.
// La lista sólo vale si el dueño la marcó "elegible en el POS"; la condición,
// si está activa y el negocio tiene listas PRO. 'none' = contado explícito.

import { create } from "zustand";

export const PRICE_LIST_HEADER = "x-ninja-price-list";
export const PAYMENT_TERM_HEADER = "x-ninja-payment-term";

interface PricingContextState {
  listId: string | null;
  /** null = la de la ficha del cliente; 'none' = contado; uuid = condición. */
  termId: string | null;
  setList: (id: string | null) => void;
  setTerm: (id: string | null) => void;
  reset: () => void;
}

export const usePricingContext = create<PricingContextState>((set) => ({
  listId: null,
  termId: null,
  setList: (listId) => set({ listId }),
  setTerm: (termId) => set({ termId }),
  reset: () => set({ listId: null, termId: null }),
}));

export function currentPricingHeaders(): Record<string, string> | null {
  const { listId, termId } = usePricingContext.getState();
  if (!listId && !termId) return null;
  const h: Record<string, string> = {};
  if (listId) h[PRICE_LIST_HEADER] = listId;
  if (termId) h[PAYMENT_TERM_HEADER] = termId;
  return h;
}
