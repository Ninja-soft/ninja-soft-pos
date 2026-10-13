// Versión del service worker del POS (H65, ADR-087). Cambia en cada deploy:
// el navegador detecta un sw.js distinto, instala la versión nueva y el POS
// ofrece recargar. Sólo [A-Za-z0-9_-]: va dentro de un string de JS.
export function swVersion(env: Record<string, string | undefined>, fallback: string): string {
  const raw = env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || fallback;
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return clean || "dev";
}

/** Inserta la versión en el código del service worker. */
export function renderServiceWorker(source: string, version: string): string {
  return source.split("__SW_VERSION__").join(version);
}
