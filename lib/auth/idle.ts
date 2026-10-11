// Cierre de sesión por inactividad (8 h). La marca de última actividad vive en
// una cookie (no httpOnly) para que la lea el MIDDLEWARE: así una sesión
// vencida se corta antes de renderizar el panel, no después.

// Única fuente de verdad del umbral.
export const INACTIVITY_MS = 8 * 60 * 60 * 1000;

export const IDLE_COOKIE = "ninja_last_activity";

export function parseIdle(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Sin marca → no vence (primer ingreso: el guard la siembra).
export function isIdleExpired(value: string | null | undefined, now: number): boolean {
  const last = parseIdle(value);
  return last != null && now - last >= INACTIVITY_MS;
}
