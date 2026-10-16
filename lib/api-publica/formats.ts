// Formatos de las credenciales de la API pública (ADR-094, prueba ADR-159) sin
// dependencias de Node: los usa también el navegador (Probar del portal y
// /developers). El hash y el parseo de headers viven en hashing.ts (servidor).

// Credenciales de prueba (sandbox, ADR-159): mismo formato con `test_`
// después del prefijo. El ambiente real lo decide la base (api_clients.environment).
export const CLIENT_ID_RE = /^nsc_(test_)?[0-9a-f]{24}$/;
export const CLIENT_SECRET_RE = /^nss_(test_)?[0-9a-f]{64}$/;
export const ACCESS_TOKEN_RE = /^nsat_(test_)?[0-9a-f]{64}$/;

export const SANDBOX_CLIENT_PREFIX = "nsc_test_";
export const SANDBOX_SECRET_PREFIX = "nss_test_";
export const SANDBOX_TOKEN_PREFIX = "nsat_test_";

/** Token de una credencial de prueba (sólo para marcar la respuesta; la base decide). */
export function isSandboxToken(token: string): boolean {
  return token.startsWith(SANDBOX_TOKEN_PREFIX) && ACCESS_TOKEN_RE.test(token);
}

/** client_id de una credencial de prueba. */
export function isSandboxClientId(clientId: string): boolean {
  return clientId.startsWith(SANDBOX_CLIENT_PREFIX) && CLIENT_ID_RE.test(clientId);
}
