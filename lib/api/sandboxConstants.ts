// Constantes del sandbox público (ADR-163) sin dependencias de Node: las usan
// el portal (navegador), el HTML descargable y la ruta /api/sandbox/v1.

/** Base del sandbox público (mismo árbol de rutas que /api/v1). */
export const SANDBOX_BASE_PATH = "/api/sandbox/v1";

/** Documentación en HTML autocontenido (?download=1 adjunto, ?print=1 para PDF). */
export const DOCS_HTML_PATH = "/api/docs/html";

/** Portal público de desarrolladores. */
export const DEVELOPERS_PATH = "/developers";

// Credenciales de ejemplo: formato de prueba válido, todo ceros. Son públicas
// a propósito (se muestran en /developers) y nunca existen en la base: los id
// y secretos reales salen de gen_random_bytes. La ruta pública las resuelve
// con el dataset ficticio sin llegar a Supabase.
export const DEMO_CLIENT_ID = `nsc_test_${"0".repeat(24)}`;
export const DEMO_CLIENT_SECRET = `nss_test_${"0".repeat(64)}`;

export function isDemoClient(clientId: string | null | undefined, secret?: string | null): boolean {
  return clientId === DEMO_CLIENT_ID && (secret === undefined || secret === DEMO_CLIENT_SECRET);
}
