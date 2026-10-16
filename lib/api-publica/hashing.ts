import { createHash } from "node:crypto";

// Formatos y hash de las credenciales de la API pública (ADR-094). El
// secreto y el token se generan en la base (gen_random_bytes) y se guardan
// sólo como sha256 hex (_api_sha256). Acá: el mismo hash para tests y los
// formatos que la ruta valida antes de ir a la base.

export {
  CLIENT_ID_RE,
  CLIENT_SECRET_RE,
  ACCESS_TOKEN_RE,
  SANDBOX_CLIENT_PREFIX,
  SANDBOX_SECRET_PREFIX,
  SANDBOX_TOKEN_PREFIX,
  isSandboxToken,
  isSandboxClientId,
} from "./formats";
import { ACCESS_TOKEN_RE } from "./formats";

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
