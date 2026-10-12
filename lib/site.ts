// Dominio canónico de la app. Producción vive en https://pos.soft.ninja; el
// alias de Vercel (ninja-soft-pos.vercel.app) se redirige ahí con 308
// (middleware) y todo link que la app arma hacia afuera (back_url de
// suscripciones, redirect del OAuth, recupero de contraseña, checkout de
// Payway) usa appOrigin(). localhost y los previews de Vercel conservan su
// propio origen para poder probar.

export const CANONICAL_APP_URL = "https://pos.soft.ninja";
export const LEGACY_PROD_HOST = "ninja-soft-pos.vercel.app";
const CANONICAL_HOST = "pos.soft.ninja";

// NEXT_PUBLIC_APP_URL si es un dominio https propio; si no, el canónico.
export function canonicalAppUrl(envUrl?: string): string {
  try {
    const u = new URL(String(envUrl ?? ""));
    if (u.protocol === "https:" && !u.hostname.endsWith(".vercel.app")) return u.origin;
  } catch {
    /* default */
  }
  return CANONICAL_APP_URL;
}

// Lógica pura de appOrigin(). `vercelEnv` = NEXT_PUBLIC_VERCEL_ENV
// ("production" | "preview" | "development").
export function resolveAppOrigin(
  currentOrigin: string | null | undefined,
  envUrl?: string,
  vercelEnv?: string,
): string {
  let current: URL;
  try {
    current = new URL(String(currentOrigin ?? ""));
  } catch {
    return canonicalAppUrl(envUrl);
  }
  const host = current.hostname;
  const isProd =
    vercelEnv === "production" || host === LEGACY_PROD_HOST || host === CANONICAL_HOST;
  return isProd ? canonicalAppUrl(envUrl) : current.origin;
}

// Origen público de la app. En el navegador toma window.location.origin; en
// el server pasale el origen del request.
export function appOrigin(currentOrigin?: string): string {
  const current =
    currentOrigin ?? (typeof window !== "undefined" ? window.location.origin : undefined);
  return resolveAppOrigin(
    current,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_VERCEL_ENV,
  );
}

// Redirección 308 del alias de producción al dominio canónico, con el mismo
// path y query (308 preserva método y cuerpo). null si no corresponde
// (canónico, previews, localhost).
export function legacyHostRedirect(host: string | null, pathAndQuery: string): string | null {
  const h = String(host ?? "").toLowerCase().split(":")[0];
  if (h !== LEGACY_PROD_HOST) return null;
  return `${CANONICAL_APP_URL}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
}
