// Cursores opacos de la API pública (ADR-094): keyset (fecha, id) en
// base64url. El cliente los devuelve tal cual en `?cursor=`; no elige el
// negocio (eso sale del token), sólo dónde sigue la página.

export type KeysetCursor = { t: string; id: string };
export type IdCursor = { id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO 8601 con zona (como lo serializa Postgres en jsonb, con microsegundos).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function toB64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function fromB64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(s)) return null;
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function encodeKeyset(t: string, id: string): string {
  return toB64Url(JSON.stringify({ t, id }));
}

export function decodeKeyset(cursor: string): KeysetCursor | null {
  const raw = fromB64Url(cursor);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { t, id } = v as Record<string, unknown>;
    if (typeof t !== "string" || typeof id !== "string" || !ISO.test(t) || !UUID.test(id)) return null;
    return { t, id };
  } catch {
    return null;
  }
}

export function encodeIdCursor(id: string): string {
  return toB64Url(JSON.stringify({ id }));
}

export function decodeIdCursor(cursor: string): IdCursor | null {
  const raw = fromB64Url(cursor);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { id } = v as Record<string, unknown>;
    if (typeof id !== "string" || !UUID.test(id)) return null;
    return { id };
  } catch {
    return null;
  }
}

/**
 * `next` que devuelve la base ({updated_at|created_at, id} o {id}) a cursor
 * opaco, o null si no hay más páginas.
 */
export function nextCursor(next: unknown, timeKey?: "updated_at" | "created_at"): string | null {
  if (!next || typeof next !== "object") return null;
  const n = next as Record<string, unknown>;
  if (typeof n.id !== "string") return null;
  if (!timeKey) return encodeIdCursor(n.id);
  const t = n[timeKey];
  return typeof t === "string" ? encodeKeyset(t, n.id) : null;
}
