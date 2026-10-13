// =============================================================================
// Aviso de contexto cruzado y título de pestaña (F17 · H90 · ADR-080).
//
// Si el panel mira "Norte" pero el turno abierto del usuario es en "Centro"
// (o el equipo vende en otra sucursal), el acceso "Vender" lo dice antes de
// entrar al POS. Y la pestaña del navegador lleva la sucursal del chip para
// que con varias pestañas no haya duda. Puro y testeable.
// =============================================================================

export interface CrossContextInput {
  /** Sucursal del chip del panel (null = todas o una sola). */
  filterStoreId: string | null;
  /** Sucursal donde vende este equipo. */
  posStoreId: string | null;
  /** Sucursal del turno abierto por el usuario (null = sin turno propio). */
  myShiftStoreId: string | null;
  branchName: (id: string | null | undefined) => string | null;
}

export interface CrossContextNotice {
  /** Sucursal donde se va a vender. */
  storeId: string;
  /** Texto corto para debajo del botón. */
  message: string;
  /** Texto para el title / aria-label. */
  hint: string;
}

export function crossContextNotice(input: CrossContextInput): CrossContextNotice | null {
  const { filterStoreId, posStoreId, myShiftStoreId, branchName } = input;
  if (!filterStoreId) return null;
  const viewing = branchName(filterStoreId) ?? "esta sucursal";

  // El turno propio manda: el POS vende en la caja abierta por el usuario.
  if (myShiftStoreId && myShiftStoreId !== filterStoreId) {
    const where = branchName(myShiftStoreId) ?? "otra sucursal";
    return {
      storeId: myShiftStoreId,
      message: `Tu caja abierta está en ${where}`,
      hint: `Estás viendo ${viewing}, pero tu caja abierta está en ${where}: Vender te lleva a ${where}.`,
    };
  }
  if (!myShiftStoreId && posStoreId && posStoreId !== filterStoreId) {
    const where = branchName(posStoreId) ?? "otra sucursal";
    return {
      storeId: posStoreId,
      message: `Este equipo vende en ${where}`,
      hint: `Estás viendo ${viewing}, pero este equipo vende en ${where}.`,
    };
  }
  return null;
}

export const TITLE_SEPARATOR = " · ";

/**
 * Título de pestaña con la sucursal adelante: "Norte · Ventas | NinjaSoft".
 * `prevLabel` es la sucursal que se puso antes (para no apilar prefijos al
 * cambiar de sucursal o cuando Next reescribe el título al navegar).
 */
export function branchTabTitle(current: string, label: string | null, prevLabel: string | null): string {
  let base = current;
  for (const p of [prevLabel, label]) {
    if (p && base.startsWith(p + TITLE_SEPARATOR)) {
      base = base.slice(p.length + TITLE_SEPARATOR.length);
      break;
    }
  }
  return label ? `${label}${TITLE_SEPARATOR}${base}` : base;
}
