"use client";

import { combineChunks, parseCookieHeader, stringFromBase64URL } from "@supabase/ssr";
import { IDLE_COOKIE } from "@/lib/auth/idle";
import { idbAvailable, idbKv } from "@/lib/pos/offline/idb";
import {
  LAST_POS_KEY,
  authStorageKey,
  buildLastPos,
  isLastPos,
  parsePersistedSession,
  type LastPosSession,
  type PersistedSessionInfo,
} from "@/lib/pos/offline/session";

// Lectura local de la sesión para el POS sin conexión (H65, ADR-087). No hace
// ninguna llamada de red ni escribe tokens: lee la cookie que Supabase ya
// persiste y descarta los tokens apenas saca el id del usuario.

const BASE64_PREFIX = "base64-";

function cookieJar(): Map<string, string> {
  const m = new Map<string, string>();
  if (typeof document === "undefined") return m;
  for (const c of parseCookieHeader(document.cookie)) if (c.value != null) m.set(c.name, c.value);
  return m;
}

/** Decodifica el valor de @supabase/ssr ("base64-<base64url>" o JSON plano). */
export function decodeSessionCookie(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith(BASE64_PREFIX)) return raw;
  try {
    return stringFromBase64URL(raw.slice(BASE64_PREFIX.length));
  } catch {
    return null;
  }
}

export async function readPersistedSession(): Promise<PersistedSessionInfo | null> {
  const key = authStorageKey(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!key) return null;
  const jar = cookieJar();
  try {
    const raw = await combineChunks(key, (name) => jar.get(name) ?? null);
    return parsePersistedSession(decodeSessionCookie(raw));
  } catch {
    return null;
  }
}

export function readIdleCookie(): string | null {
  return cookieJar().get(IDLE_COOKIE) ?? null;
}

/** Registra actividad real en el POS sin conexión (misma cookie que InactivityGuard). */
export function touchIdleCookie(now = Date.now()) {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${IDLE_COOKIE}=${now}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
}

export async function readLastPos(): Promise<LastPosSession | null> {
  if (!idbAvailable()) return null;
  try {
    const v = await idbKv.get<unknown>(LAST_POS_KEY);
    return isLastPos(v) ? v : null;
  } catch {
    return null;
  }
}

export async function writeLastPos(tenantId: string, userId: string): Promise<void> {
  if (!idbAvailable()) return;
  try {
    await idbKv.set(LAST_POS_KEY, buildLastPos(tenantId, userId));
  } catch {
    // Sin IndexedDB: el POS no se podrá abrir sin conexión, pero sigue andando.
  }
}
