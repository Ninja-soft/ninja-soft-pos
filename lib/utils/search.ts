// Saneo de términos de búsqueda antes de armar filtros PostgREST/Supabase.
//
// El parser de `.or("col.ilike.%x%,...")` usa la coma como separador y los
// paréntesis para agrupar; un término con `,` `(` `)` rompe la query y tira
// error. Estos chars se eliminan. También se quitan los comodines `%`/`_` que el
// usuario podría tipear (los agregamos nosotros al envolver el patrón) y la `\`
// para no dejar escapes colgando. El resultado es seguro para `.ilike()` y para
// interpolar dentro de `.or()`.
export function sanitizeIlike(input: string | null | undefined): string {
  return (input ?? "")
    .trim()
    .replace(/[,()\\%_*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
