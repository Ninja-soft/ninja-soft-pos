// Redirecciones de auth: sólo rutas internas (evita open redirect).
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}

// Destino de vuelta del OAuth (Google): el callback canjea el código del lado
// servidor y recién ahí redirige a `next`.
export function callbackUrl(origin: string, next: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

// Destino al entrar según el rol: staff sin negocio propio → panel interno;
// usuario sin negocio → el registro, que retoma el alta guardada (rubro, plan,
// IA y código) sin volver a pedir nada; el resto → panel.
export function homePath({ isInternal, hasTenant }: { isInternal: boolean; hasTenant: boolean }): string {
  if (hasTenant) return "/dashboard";
  return isInternal ? "/internal/tenants" : "/signup";
}
