// Sesión del POS al abrirlo sin conexión (H65, ADR-087).
//
// Al recargar sin red, el POS arranca desde el shell anónimo /pos-offline y
// tiene que saber QUIÉN vende sin poder preguntarle a Supabase. Se cruzan tres
// cosas que ya están en el dispositivo:
//   1. La sesión que Supabase ya persiste (cookie sb-<ref>-auth-token). Sólo se
//      LEE para sacar el id del usuario; no se copia ni se guarda otro token.
//   2. El puntero "pos.last" (IndexedDB): negocio y usuario del último POS
//      abierto con conexión. No guarda secretos.
//   3. La foto local (catálogo, política y turno) de ese negocio y usuario.
// Si algo no cierra (sin sesión, otro usuario, inactividad, foto vieja o sin
// caja abierta) el POS queda en "sólo lectura": se ven precios y ventas por
// enviar, pero no se cobra sin un usuario identificado.

import { isIdleExpired } from "@/lib/auth/idle";
import type { OfflinePolicy } from "./policy";

export const LAST_POS_KEY = "pos.last";
export const LAST_POS_VERSION = 1;

/** Puntero al último POS abierto con conexión en este dispositivo. */
export interface LastPosSession {
  v: number;
  tenantId: string;
  userId: string;
  /** ISO: última vez que el POS confirmó la sesión con conexión. */
  at: string;
}

export function buildLastPos(tenantId: string, userId: string, now: Date = new Date()): LastPosSession {
  return { v: LAST_POS_VERSION, tenantId, userId, at: now.toISOString() };
}

export function isLastPos(v: unknown): v is LastPosSession {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === LAST_POS_VERSION &&
    typeof o.tenantId === "string" &&
    o.tenantId.length > 0 &&
    typeof o.userId === "string" &&
    o.userId.length > 0 &&
    typeof o.at === "string"
  );
}

/** Lo único que se usa de la sesión persistida (nunca los tokens). */
export interface PersistedSessionInfo {
  userId: string;
  email: string | null;
  /** Epoch en segundos del access token (puede estar vencido: se renueva al volver la red). */
  expiresAt: number | null;
  /** Hay refresh token: la sesión sigue abierta aunque el access token haya vencido. */
  hasRefresh: boolean;
}

/** Clave de almacenamiento de supabase-js: sb-<ref>-auth-token. */
export function authStorageKey(supabaseUrl: string): string | null {
  try {
    const ref = new URL(supabaseUrl).hostname.split(".")[0];
    return ref ? `sb-${ref}-auth-token` : null;
  } catch {
    return null;
  }
}

/**
 * JSON de la sesión (ya decodificado de la cookie) → datos mínimos. Se
 * descartan access_token y refresh_token en el acto: sólo se conserva si
 * existe el refresh.
 */
export function parsePersistedSession(json: string | null | undefined): PersistedSessionInfo | null {
  if (!json) return null;
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const s = o as Record<string, unknown>;
  const user = s.user && typeof s.user === "object" ? (s.user as Record<string, unknown>) : null;
  const userId = typeof user?.id === "string" ? user.id : null;
  if (!userId) return null;
  return {
    userId,
    email: typeof user?.email === "string" ? user.email : null,
    expiresAt: typeof s.expires_at === "number" ? s.expires_at : null,
    hasRefresh: typeof s.refresh_token === "string" && s.refresh_token.length > 0,
  };
}

export type OfflineReadonlyReason =
  | "no_device_data"
  | "no_session"
  | "other_user"
  | "idle_expired"
  | "no_snapshot"
  | "disabled"
  | "stale"
  | "no_shift";

export type OfflineMode =
  | { mode: "sell" }
  | { mode: "readonly"; reason: OfflineReadonlyReason; title: string; text: string };

export interface OfflineModeInput {
  last: LastPosSession | null;
  session: PersistedSessionInfo | null;
  /** Valor crudo de la cookie de inactividad (ninja_last_activity). */
  idle: string | null;
  snapshot: {
    tenantId: string;
    userId: string;
    at: string;
    policy: OfflinePolicy;
    shift: { id: string; storeId: string | null } | null;
  } | null;
  now: number;
}

const READONLY: Record<OfflineReadonlyReason, { title: string; text: string }> = {
  no_device_data: {
    title: "Este dispositivo todavía no está listo para vender sin conexión",
    text: "Abrí el POS una vez con internet y con la caja abierta. Después se puede recargar sin conexión.",
  },
  no_session: {
    title: "No hay una sesión iniciada",
    text: "Sin conexión no se puede iniciar sesión. Cuando vuelva internet, ingresá y abrí el POS.",
  },
  other_user: {
    title: "La sesión es de otro usuario",
    text: "Los datos guardados en este dispositivo son de otra persona. Para vender, ingresá con tu usuario con conexión.",
  },
  idle_expired: {
    title: "La sesión venció por inactividad",
    text: "Pasaron más de 8 horas sin uso. Cuando vuelva internet, ingresá de nuevo.",
  },
  no_snapshot: {
    title: "No hay catálogo guardado",
    text: "El POS guarda el catálogo cada 10 minutos con conexión. Sin esa foto no se puede vender offline.",
  },
  disabled: {
    title: "La venta sin conexión está apagada",
    text: "El dueño la puede prender en Configuración, Operación.",
  },
  stale: {
    title: "Los datos guardados son muy viejos",
    text: "La última conexión supera el plazo que fijó el dueño para vender sin conexión.",
  },
  no_shift: {
    title: "No hay una caja abierta",
    text: "Sin conexión sólo se vende con la caja ya abierta. Abrila cuando vuelva internet.",
  },
};

export function readonlyMode(reason: OfflineReadonlyReason): OfflineMode {
  return { mode: "readonly", reason, ...READONLY[reason] };
}

/**
 * ¿Se puede vender al abrir el POS sin conexión? Se vende sólo con un usuario
 * identificado: sesión de Supabase presente (con refresh token), del mismo
 * usuario que dejó la foto, sin vencer por inactividad, con foto vigente
 * según la política y caja abierta en esa foto. El servidor igual revalida
 * todo al sincronizar.
 */
export function resolveOfflineMode(i: OfflineModeInput): OfflineMode {
  if (!i.last) return readonlyMode("no_device_data");
  if (!i.session || !i.session.hasRefresh) return readonlyMode("no_session");
  if (i.session.userId !== i.last.userId) return readonlyMode("other_user");
  if (isIdleExpired(i.idle, i.now)) return readonlyMode("idle_expired");
  const s = i.snapshot;
  if (!s || s.tenantId !== i.last.tenantId || s.userId !== i.last.userId) return readonlyMode("no_snapshot");
  if (!s.policy.enabled) return readonlyMode("disabled");
  const at = Date.parse(s.at);
  if (!Number.isFinite(at) || i.now - at > s.policy.maxHours * 3_600_000) return readonlyMode("stale");
  if (!s.shift) return readonlyMode("no_shift");
  return { mode: "sell" };
}
