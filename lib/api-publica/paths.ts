// Rutas de la API pública que el middleware deja pasar sin sesión (ADR-094):
// la autenticación es el token Bearer, no la cookie del panel. ADR-163 suma
// el sandbox público (/api/sandbox/v1, dataset ficticio o credenciales de
// prueba) y la documentación en HTML (/api/docs/html).
export function isPublicApiPath(pathname: string): boolean {
  return (
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/") ||
    pathname === "/api/openapi.json" ||
    pathname === "/api/sandbox/v1" ||
    pathname.startsWith("/api/sandbox/v1/") ||
    pathname === "/api/docs/html"
  );
}

/** Portal público de desarrolladores (sin login, ADR-163). */
export function isDevelopersPath(pathname: string): boolean {
  return pathname === "/developers" || pathname.startsWith("/developers/");
}
