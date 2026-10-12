import { z } from "zod";
import { posLayoutSchema, type PosLayout } from "./layout";

// Foto del arranque del POS (diseño efectivo, ubicación, caja y medios fijados)
// guardada en localStorage por usuario + negocio + caja. Sirve para que el
// primer cuadro ya pinte el diseño correcto mientras llegan las consultas; al
// llegar el valor del servidor se reconcilia en silencio (sólo cambia si es
// distinto). Es una preferencia de pantalla: si falla el storage, no pasa nada.

export const POS_BOOT_STORAGE_KEY = "ninja-pos-boot.v1";
const MAX_ENTRIES = 8;

const pinnedSchema = z.object({
  id: z.string(),
  group: z.string(),
  label: z.string(),
  logo: z.string().nullable(),
});
export type PinnedSnap = z.infer<typeof pinnedSchema>;

const snapSchema = z.object({
  layout: posLayoutSchema,
  /** Modo gastronómico (Salón cae a Mostrador sin él). */
  dining: z.boolean(),
  /** El usuario usa un diseño propio (override). */
  usingOwn: z.boolean(),
  /** Chip "Sucursal · Caja" (null = no se muestra). */
  location: z
    .object({ full: z.string(), short: z.string(), color: z.string().nullable(), pickable: z.boolean() })
    .nullable(),
  /** Última vez: la caja estaba abierta y era usable. */
  shiftOpen: z.boolean().nullable(),
  /** Medios fijados en el carrito. */
  pinned: z.array(pinnedSchema).max(3),
  /** Botón de venta libre visible (flag del negocio + rol). */
  freeSale: z.boolean(),
  /** Rubro con "frecuentes" en la grilla. */
  quickSale: z.boolean(),
});
export type PosBootSnap = z.infer<typeof snapSchema>;

const fileSchema = z.object({
  last: z.string().nullable(),
  entries: z.record(z.object({ at: z.number(), snap: z.unknown() })),
});
type BootFile = z.infer<typeof fileSchema>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** localStorage si existe y se puede usar (modo privado / bloqueado → null). */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Clave por usuario + negocio + caja. null si falta alguno de los dos primeros. */
export function posBootKey(tenantId: string | null, userId: string | null, registerId: string | null): string | null {
  if (!tenantId || !userId) return null;
  return `${tenantId}.${userId}.${registerId ?? "-"}`;
}

/** Prefijo de usuario + negocio (para descartar fotos de otra sesión). */
export function posBootScope(tenantId: string | null, userId: string | null): string | null {
  return tenantId && userId ? `${tenantId}.${userId}.` : null;
}

function readFile(storage: StorageLike | null): BootFile {
  const empty: BootFile = { last: null, entries: {} };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(POS_BOOT_STORAGE_KEY);
    if (!raw) return empty;
    const r = fileSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : empty;
  } catch {
    return empty;
  }
}

function parseSnap(raw: unknown): PosBootSnap | null {
  const r = snapSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Lee la foto de `key`; sin key (todavía no se sabe usuario/caja) devuelve la
 * última usada en este dispositivo. `scope` (tenant.user.) descarta la última
 * si es de otra sesión.
 */
export function readPosBoot(storage: StorageLike | null, key: string | null, scope?: string | null): PosBootSnap | null {
  const file = readFile(storage);
  if (key) {
    const exact = file.entries[key];
    if (exact) return parseSnap(exact.snap);
  }
  const last = file.last;
  if (!last || !file.entries[last]) return null;
  if (scope && !last.startsWith(scope)) return null;
  // Con caja conocida y sin foto propia, la última del mismo usuario sirve
  // (mismo diseño salvo override por caja, que se reconcilia al llegar).
  return parseSnap(file.entries[last]!.snap);
}

/** Guarda la foto si cambió. Devuelve true si escribió. */
export function writePosBoot(storage: StorageLike | null, key: string, snap: PosBootSnap, now = Date.now()): boolean {
  if (!storage) return false;
  const valid = parseSnap(snap);
  if (!valid) return false;
  const file = readFile(storage);
  const prev = file.entries[key];
  if (prev && file.last === key && sameValue(prev.snap, valid)) return false;
  file.entries[key] = { at: now, snap: valid };
  file.last = key;
  // Poda: se quedan las más recientes.
  const keys = Object.keys(file.entries).sort((a, b) => file.entries[b]!.at - file.entries[a]!.at);
  for (const k of keys.slice(MAX_ENTRIES)) delete file.entries[k];
  try {
    storage.setItem(POS_BOOT_STORAGE_KEY, JSON.stringify(file));
    return true;
  } catch {
    return false;
  }
}

/** Igualdad estructural (orden de claves indistinto). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameValue(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => sameValue(ao[k], bo[k]));
}

/**
 * Reconciliación silenciosa: si el valor nuevo es igual al anterior devuelve
 * la MISMA referencia (no re-renderiza nada aguas abajo).
 */
export function reconcile<T>(prev: T | null | undefined, next: T): T {
  return prev != null && sameValue(prev, next) ? prev : next;
}

/** Preset efectivo con la regla de Salón (sin modo gastronómico cae a Mostrador). */
export function effectivePreset(layout: PosLayout, dining: boolean | undefined): PosLayout {
  return layout.preset === "salon" && dining === false ? { ...layout, preset: "mostrador" } : layout;
}
