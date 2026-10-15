// Nombre de marca: SIEMPRE en mayúsculas, sin espacios de más.
// Espejo de brand_name_normalize() en Postgres (migración 20261206100000):
// el trigger de brands normaliza todo lo que se guarde por cualquier camino;
// esto es para que la UI muestre y compare lo mismo que va a quedar.

/** "  coca   cola " -> "COCA COLA"; "Ayudín" -> "AYUDÍN". */
export function normalizeBrandName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().toLocaleUpperCase("es-AR");
}

/** Busca una marca existente por nombre sin distinguir mayúsculas. */
export function findBrandByName<T extends { name: string }>(
  brands: readonly T[] | null | undefined,
  name: string,
): T | undefined {
  const k = normalizeBrandName(name);
  if (!k) return undefined;
  return (brands ?? []).find((b) => normalizeBrandName(b.name) === k);
}
