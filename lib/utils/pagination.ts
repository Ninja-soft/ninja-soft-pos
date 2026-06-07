// Página de resultados de un listado paginado server-side: las filas de la
// página + el total exacto de filas que matchean (count: 'exact' en Supabase).
export interface Paged<T> {
  rows: T[];
  total: number;
}
