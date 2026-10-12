// Cookies de sesión de @supabase/ssr a partir de un par de tokens.
//
// @supabase/ssr guarda la sesión en `sb-<ref>-auth-token` como
// "base64-" + base64url(JSON). Si el valor supera 3180 chars se parte en
// `sb-<ref>-auth-token.0`, `.1`, … (ver .claude/skills/verify/SKILL.md).

export const CHUNK_SIZE = 3180;

export type JwtClaims = {
  sub: string;
  exp: number;
  email?: string;
  aud?: string | string[];
  role?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
};

export function decodeJwt(token: string): JwtClaims {
  const part = token.split(".")[1];
  if (!part) throw new Error("E2E_ACCESS_TOKEN no es un JWT válido");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as JwtClaims;
}

export type SessionCookie = { name: string; value: string };

export function buildSessionCookies(
  ref: string,
  accessToken: string,
  refreshToken: string,
): SessionCookie[] {
  const claims = decodeJwt(accessToken);
  const now = Math.floor(Date.now() / 1000);
  // El user se arma desde los claims del JWT: no hace falta pegarle a Auth.
  const user = {
    id: claims.sub,
    aud: Array.isArray(claims.aud) ? claims.aud[0] : (claims.aud ?? "authenticated"),
    role: claims.role ?? "authenticated",
    email: claims.email,
    app_metadata: claims.app_metadata ?? {},
    user_metadata: claims.user_metadata ?? {},
  };
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: Math.max(claims.exp - now, 0),
    expires_at: claims.exp,
    user,
  };
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const name = `sb-${ref}-auth-token`;
  if (value.length <= CHUNK_SIZE) return [{ name, value }];
  const chunks: SessionCookie[] = [];
  for (let i = 0, n = 0; i < value.length; i += CHUNK_SIZE, n++) {
    chunks.push({ name: `${name}.${n}`, value: value.slice(i, i + CHUNK_SIZE) });
  }
  return chunks;
}
