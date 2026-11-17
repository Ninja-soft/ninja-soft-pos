// =============================================================================
// MFA del staff interno (SEC-23 · ADR-186).
//
// Decisión de redirección del middleware como función pura (testeable) y
// lectura cacheada del flag global `internal_mfa_required`
// (system_settings, RPC internal_mfa_required()).
//
// Con el flag APAGADO el middleware no cambia nada: la pantalla de enrolamiento
// funciona igual, para que el staff enrole antes de prenderlo.
// =============================================================================

export const MFA_CHALLENGE_PATH = "/login/mfa";
export const MFA_ENROLL_PATH = "/internal/seguridad/mfa";
export const INTERNAL_HOME_PATH = "/internal/tenants";

/** Rutas donde el middleware evalúa el MFA del staff. */
export function isInternalMfaGuardedPath(pathname: string): boolean {
  return (
    pathname === "/internal" ||
    pathname.startsWith("/internal/") ||
    pathname === MFA_CHALLENGE_PATH
  );
}

export type InternalMfaInput = {
  /** app_metadata.is_internal === true */
  isInternal: boolean;
  /** Flag global internal_mfa_required. */
  flagOn: boolean;
  /** Claim `aal` de la sesión ("aal1" | "aal2" | null). */
  currentLevel: string | null;
  /** El usuario tiene al menos un factor TOTP verificado. */
  hasVerifiedFactor: boolean;
  pathname: string;
};

/**
 * Destino al que hay que mandar al staff, o null si puede seguir.
 * - Flag apagado, no staff o ruta no protegida → null (comportamiento de siempre).
 * - Sesión aal2 → sigue; si está en /login/mfa, vuelve al panel.
 * - aal1 con factor → /login/mfa (challenge) con `next`.
 * - aal1 sin factor → /internal/seguridad/mfa (enrolar).
 */
export function internalMfaRedirect(input: InternalMfaInput): string | null {
  const { isInternal, flagOn, currentLevel, hasVerifiedFactor, pathname } = input;
  if (!isInternal || !flagOn || !isInternalMfaGuardedPath(pathname)) return null;
  if (currentLevel === "aal2") {
    return pathname === MFA_CHALLENGE_PATH ? INTERNAL_HOME_PATH : null;
  }
  if (hasVerifiedFactor) {
    if (pathname === MFA_CHALLENGE_PATH) return null;
    return `${MFA_CHALLENGE_PATH}?next=${encodeURIComponent(pathname)}`;
  }
  return pathname === MFA_ENROLL_PATH ? null : MFA_ENROLL_PATH;
}

type FactorLike = { factor_type?: string; status?: string };

export function hasVerifiedTotp(factors: FactorLike[] | null | undefined): boolean {
  return (factors ?? []).some((f) => f.factor_type === "totp" && f.status === "verified");
}

/**
 * Lee el flag con cache en memoria (por isolate del middleware). Sólo se
 * consulta para usuarios staff en rutas protegidas, y como mucho una vez cada
 * `ttlMs`. Si la lectura falla devuelve false SIN cachear: el middleware es
 * sólo UX; la barrera real es is_internal() en la base, que no falla abierto.
 */
export function createFlagReader(ttlMs = 30_000) {
  let cache: { value: boolean; at: number } | null = null;
  return async function read(
    fetcher: () => Promise<boolean | null>,
    now: number = Date.now(),
  ): Promise<boolean> {
    if (cache && now - cache.at < ttlMs) return cache.value;
    let value: boolean | null = null;
    try {
      value = await fetcher();
    } catch {
      value = null;
    }
    if (value === null) return false;
    cache = { value, at: now };
    return value;
  };
}

export const readInternalMfaFlag = createFlagReader();

/** Deja sólo los 6 dígitos del código TOTP (pegado con espacios, guiones…). */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}

export function isTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Mensajes para los códigos de error de la RPC internal_mfa_reset. */
export function mfaResetErrorMessage(message: string | null | undefined): string {
  const m = message ?? "";
  if (m.includes("forbidden")) return "Sólo un super admin puede resetear la verificación en dos pasos.";
  if (m.includes("cannot_reset_self")) return "No podés resetear tu propia verificación: pedíselo a otro super admin.";
  if (m.includes("reason_required")) return "Escribí un motivo (al menos 5 caracteres).";
  if (m.includes("reason_too_long")) return "El motivo es demasiado largo (máximo 500 caracteres).";
  if (m.includes("user_not_found")) return "No encontramos esa cuenta.";
  if (m.includes("not_internal_staff")) return "Esa cuenta no es del staff.";
  return "No se pudo resetear la verificación en dos pasos.";
}
