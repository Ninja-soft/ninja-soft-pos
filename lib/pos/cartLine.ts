// Reglas chicas de una línea del carrito que comparten el carrito y la pestaña
// "Ítems" de la hoja de cobro. PURO.
import type { CartLine } from "@/modules/pos/store";

/**
 * Largo máximo del comentario de un renglón. Viaja como `line_note` a
 * create_sale (ADR-116, que acepta hasta 1000) y sale en el comprobante
 * debajo del renglón: 200 entra cómodo en el ticket de 80 mm.
 */
export const LINE_NOTE_MAX = 200;

/** Comentario limpio para guardar (vacío = sin comentario). */
export function normalizeLineNote(text: string, max = LINE_NOTE_MAX): string | null {
  const t = text.trim().slice(0, max);
  return t ? t : null;
}

/** La línea se cobra (no es regalo de promo ni la cubre una sesión de pack). */
export function lineIsCharged(l: CartLine): boolean {
  return !l.giftPromoId && !l.packCreditId;
}

/**
 * Producto a $0 que todavía no tiene precio (precio libre o sin cargar): el
 * cajero lo define antes de cobrar. Los regalos y las sesiones de pack están
 * en $0 a propósito.
 */
export function linePriceToDefine(l: CartLine): boolean {
  return lineIsCharged(l) && Boolean(l.productId) && l.unitPrice <= 0;
}
