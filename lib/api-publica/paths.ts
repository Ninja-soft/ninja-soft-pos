// Rutas de la API pública que el middleware deja pasar sin sesión (ADR-094):
// la autenticación es el token Bearer, no la cookie del panel.
export function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/") || pathname === "/api/openapi.json";
}
