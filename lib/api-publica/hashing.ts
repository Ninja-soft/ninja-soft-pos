import { createHash } from "node:crypto";

// Formatos y hash de las credenciales de la API pública (ADR-094). El
// secreto y el token se generan en la base (gen_random_bytes) y se guardan
// sólo como sha256 hex (_api_sha256). Acá: el mismo hash para tests y los
// formatos que la ruta valida antes de ir a la base.

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

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Últimos 4 caracteres (lo único que se vuelve a mostrar del secreto). */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}

/** Bearer del header Authorization, o null si falta o no tiene formato de token. */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m || !m[1]) return null;
  return ACCESS_TOKEN_RE.test(m[1]) ? m[1] : null;
}

/** Credenciales de un header Basic (client_id:client_secret), o null. */
export function parseBasic(header: string | null): { clientId: string; clientSecret: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!m || !m[1]) return null;
  const raw = Buffer.from(m[1], "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  try {
    return { clientId: decodeURIComponent(raw.slice(0, i)), clientSecret: decodeURIComponent(raw.slice(i + 1)) };
  } catch {
    return null;
  }
}
