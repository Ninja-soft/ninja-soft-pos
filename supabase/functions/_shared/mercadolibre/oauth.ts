// =============================================================================
// _shared/mercadolibre/oauth.ts (H87 · ADR-104). PURO (crypto web estándar).
//
// OAuth 2.0 Authorization Code con PKCE (S256) por negocio y renovación de
// tokens SERIALIZADA por cuenta.
//
// Reglas de ML (doc "Autenticación y Autorización", 15/07/2026):
//   • access_token: 6 h (se confía en `expires_in`).
//   • refresh_token: UN SOLO USO, sólo vale el último emitido, dura 6 meses.
//     Dos renovaciones simultáneas con el mismo refresh = una queda con
//     `invalid_grant` y la cuenta desconectada. Por eso getAccessToken toma un
//     lock en la base (ml_token_lock: UPDATE ... WHERE lock vencido RETURNING)
//     antes de renovar; el que no lo consigue espera el token nuevo.
//   • `invalid_grant` al renovar: la cuenta pasa a "reconectar" (ml_token_fail).
//   • Parámetros SIEMPRE en el body form-urlencoded, nunca en la query.
// =============================================================================
import { ML_AUTH } from "./config.ts";
import { MlApiError, classifyMlError, type FetchLike } from "./client.ts";
import type { MlErrorBody, MlTokenResponse } from "./types.ts";

const B64URL = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** code_verifier: 64 bytes aleatorios en base64url (86 caracteres, RFC 7636). */
export function newCodeVerifier(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return B64URL(rand(64));
}

/** code_challenge S256 = base64url(sha256(verifier)). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return B64URL(new Uint8Array(digest));
}

/** state anti-CSRF de un solo uso (hex de 32 bytes). */
export function newOAuthState(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return Array.from(rand(32), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function authorizationUrl(a: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const u = new URL(ML_AUTH);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", a.clientId);
  u.searchParams.set("redirect_uri", a.redirectUri);
  u.searchParams.set("state", a.state);
  u.searchParams.set("code_challenge", a.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

async function tokenCall(fetcher: FetchLike, form: Record<string, string>, base: string): Promise<MlTokenResponse> {
  let res: Response;
  try {
    res = await fetcher(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (e) {
    throw new MlApiError("network", `Sin respuesta de Mercado Libre: ${e instanceof Error ? e.message : String(e)}`, 0, true);
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 300) };
  }
  if (!res.ok) throw classifyMlError(res.status, body as MlErrorBody, res.headers.get("retry-after"));
  const tok = body as MlTokenResponse;
  if (!tok?.access_token || !tok.user_id) throw new MlApiError("bad_request", "Mercado Libre no devolvió el token.", res.status, false, null, [], body);
  return tok;
}

export function exchangeCode(
  fetcher: FetchLike,
  a: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string },
  base = "https://api.mercadolibre.com",
): Promise<MlTokenResponse> {
  return tokenCall(
    fetcher,
    {
      grant_type: "authorization_code",
      client_id: a.clientId,
      client_secret: a.clientSecret,
      code: a.code,
      redirect_uri: a.redirectUri,
      code_verifier: a.codeVerifier,
    },
    base,
  );
}

export function refreshTokenCall(
  fetcher: FetchLike,
  a: { clientId: string; clientSecret: string; refreshToken: string },
  base = "https://api.mercadolibre.com",
): Promise<MlTokenResponse> {
  return tokenCall(
    fetcher,
    { grant_type: "refresh_token", client_id: a.clientId, client_secret: a.clientSecret, refresh_token: a.refreshToken },
    base,
  );
}

// -----------------------------------------------------------------------------
// Renovación con lock por cuenta.
// -----------------------------------------------------------------------------
export interface TokenRow {
  access_token: string;
  refresh_token: string | null;
  /** ISO. */
  expires_at: string;
}

export interface TokenDeps {
  read(accountId: string): Promise<TokenRow | null>;
  /** Toma el lock (UPDATE ... WHERE lock libre RETURNING). null = lo tiene otro. */
  tryLock(accountId: string, lockId: string, seconds: number): Promise<TokenRow | null>;
  release(accountId: string, lockId: string): Promise<void>;
  save(accountId: string, lockId: string, tok: MlTokenResponse): Promise<void>;
  fail(accountId: string, lockId: string, code: string, message: string): Promise<void>;
  refresh(refreshToken: string): Promise<MlTokenResponse>;
  sleep(ms: number): Promise<void>;
  now(): number;
  newLockId(): string;
}

export interface TokenOpts {
  /** El token que la API acaba de rechazar (401): renovar aunque no venza. */
  rejected?: string | null;
  /** Renovar si faltan menos de esto para vencer. */
  skewMs?: number;
  lockSeconds?: number;
  waitMs?: number;
  waitAttempts?: number;
}

const fresh = (row: TokenRow, now: number, skew: number) => Date.parse(row.expires_at) - now > skew;

/** Token vigente de una cuenta, renovándolo (una sola vez entre todos) si hace falta. */
export async function getAccessToken(deps: TokenDeps, accountId: string, opts: TokenOpts = {}): Promise<string> {
  const skew = opts.skewMs ?? 10 * 60_000;
  const rejected = opts.rejected ?? null;
  const usable = (row: TokenRow | null) =>
    Boolean(row && row.access_token && row.access_token !== rejected && fresh(row, deps.now(), skew));

  const row = await deps.read(accountId);
  if (!row) throw new MlApiError("invalid_grant", "La cuenta de Mercado Libre no tiene tokens: hay que reconectarla.", 401, false);
  if (usable(row)) return row.access_token;

  const lockId = deps.newLockId();
  const locked = await deps.tryLock(accountId, lockId, opts.lockSeconds ?? 30);
  if (locked) {
    // Otro renovó entre la lectura y el lock: se usa ese.
    if (usable(locked)) {
      await deps.release(accountId, lockId);
      return locked.access_token;
    }
    if (!locked.refresh_token) {
      await deps.fail(accountId, lockId, "invalid_grant", "Sin refresh token");
      throw new MlApiError("invalid_grant", "La cuenta de Mercado Libre no tiene refresh token: hay que reconectarla.", 401, false);
    }
    let tok: MlTokenResponse;
    try {
      tok = await deps.refresh(locked.refresh_token);
    } catch (e) {
      if (e instanceof MlApiError && e.code === "invalid_grant") {
        await deps.fail(accountId, lockId, "invalid_grant", e.message);
      } else {
        await deps.release(accountId, lockId);
      }
      throw e;
    }
    await deps.save(accountId, lockId, tok);
    return tok.access_token;
  }

  // Lo tiene otro: esperar el token nuevo.
  const attempts = opts.waitAttempts ?? 20;
  for (let i = 0; i < attempts; i++) {
    await deps.sleep(opts.waitMs ?? 250);
    const r = await deps.read(accountId);
    if (r && usable(r)) return r.access_token;
  }
  throw new MlApiError("server_error", "La renovación del token de Mercado Libre sigue en curso; se reintenta.", 503, true, 2_000);
}

/** expires_at ISO desde expires_in (segundos) con margen de 60 s. */
export function expiresAtFrom(expiresIn: number, nowMs = Date.now()): string {
  const secs = Number.isFinite(expiresIn) && expiresIn > 120 ? expiresIn - 60 : 3600;
  return new Date(nowMs + secs * 1000).toISOString();
}
