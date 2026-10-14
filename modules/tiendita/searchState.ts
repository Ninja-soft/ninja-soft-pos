// Spinner del buscador de un catálogo: sólo cuando de verdad se está buscando
// lo que el usuario escribió. Con el campo vacío no gira aunque se estén
// cargando los "Destacados" (esa carga ya tiene su propio estado en la grilla).
//   - escribiendo (el texto todavía no pasó el debounce) → busy
//   - texto ya enviado y el fetch en curso → busy
export function catalogSearchBusy(query: string, debounced: string, isFetching: boolean): boolean {
  const q = query.trim();
  if (q === "") return false;
  return q !== debounced.trim() || isFetching;
}
