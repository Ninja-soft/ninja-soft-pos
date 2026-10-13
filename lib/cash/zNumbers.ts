// =============================================================================
// Numeración de cierres Z por negocio, sucursal y caja (F17 · H97 · ADR-080).
//
// El servidor asigna tres correlativos (trigger czc_numbering): el del negocio
// (z_number), el de la sucursal (store_z_number) y el de la caja
// (register_z_number). Acá sólo se decide cómo se muestran. Puro y testeable.
// =============================================================================

export interface ZNumbered {
  z_number: number;
  store_id?: string | null;
  cash_register_id?: string | null;
  store_z_number?: number | null;
  register_z_number?: number | null;
}

export interface ZSeriesNames {
  /** Nombre corto de la sucursal (null si no se conoce o hay una sola). */
  branch?: string | null;
  /** Nombre de la caja (null si no se conoce). */
  register?: string | null;
}

/** "Z 12" con el número del negocio. */
export function zMain(z: Pick<ZNumbered, "z_number">): string {
  return `Z ${z.z_number}`;
}

/**
 * Series propias: "Norte Z 5 · Caja 1 Z 3". Sin datos (Z anteriores a la
 * migración que no se pudieron numerar), null. La sucursal sólo se muestra si
 * se pasó su nombre (con una sola sucursal coincide con el del negocio).
 */
export function zSeriesLabel(z: ZNumbered, names: ZSeriesNames = {}): string | null {
  const parts: string[] = [];
  if (names.branch && z.store_z_number) parts.push(`${names.branch} Z ${z.store_z_number}`);
  if (names.register && z.register_z_number) parts.push(`${names.register} Z ${z.register_z_number}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Nombre de archivo del export: cierre-z-12 o cierre-z-norte-5-caja-1-3. */
export function zFileName(z: ZNumbered, names: ZSeriesNames = {}): string {
  const slug = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const parts = [`cierre-z-${z.z_number}`];
  if (names.branch && z.store_z_number) parts.push(`${slug(names.branch)}-${z.store_z_number}`);
  if (names.register && z.register_z_number) parts.push(`${slug(names.register)}-${z.register_z_number}`);
  return parts.join("-");
}

/**
 * ¿Mostrar el filtro por caja? Sólo si hay una sucursal elegida con más de
 * una caja (con "Todas las sucursales" la lista de cajas mezclaría locales).
 */
export function showRegisterFilter(
  storeId: string | null,
  registers: { store_id: string; deleted_at: string | null }[],
): boolean {
  if (!storeId) return false;
  return registers.filter((r) => r.store_id === storeId).length > 1;
}
